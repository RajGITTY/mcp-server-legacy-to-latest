import { AgentEvent } from "./events.js";
import { estimateCost } from "./cost.js";

const noop = () => {};
const approveAll = () => true;

/**
 * Provider-agnostic agent that runs a bounded ReAct loop.
 *
 *   user prompt -> provider.step() -> tool calls? -> execute -> repeat
 *                                  -> final text  -> done
 *
 * Providers translate the neutral { messages, tools } shape into their native
 * function-calling format and return { toolCalls, text }. The Agent owns the
 * loop, history, tool execution, and event stream — keeping providers thin.
 */
export class Agent {
  /**
   * @param {object}   opts
   * @param {function} [opts.approve]  async ({name, args, annotations}) => boolean.
   *   Called before every tool runs; return false to block it (human-in-the-loop).
   *   Defaults to approve-all. Use a tool's `annotations.destructiveHint` to decide.
   */
  constructor({ provider, tools = [], systemPrompt = "", maxSteps = 8, approve = approveAll }) {
    this.provider = provider;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.systemPrompt = systemPrompt;
    this.maxSteps = maxSteps;
    this.approve = approve;
    this.messages = [];
    this.usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 };
    if (systemPrompt) this.messages.push({ role: "system", content: systemPrompt });
  }

  toolDescriptors() {
    return Array.from(this.tools.values()).map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  async run(userPrompt, { onEvent = noop } = {}) {
    onEvent({ type: AgentEvent.Start, prompt: userPrompt });
    this.messages.push({ role: "user", content: userPrompt });

    for (let step = 1; step <= this.maxSteps; step++) {
      onEvent({ type: AgentEvent.Step, step, maxSteps: this.maxSteps });

      let result;
      try {
        result = await this.provider.step({
          messages: this.messages,
          tools: this.toolDescriptors(),
        });
      } catch (err) {
        onEvent({ type: AgentEvent.Error, message: err.message });
        throw err;
      }

      this.messages.push(result.assistantMessage);
      this.usage.steps++;
      this.usage.inputTokens += result.usage?.inputTokens ?? 0;
      this.usage.outputTokens += result.usage?.outputTokens ?? 0;
      if (result.text) onEvent({ type: AgentEvent.AssistantText, text: result.text });

      if (!result.toolCalls?.length) {
        this._emitUsage(onEvent);
        onEvent({ type: AgentEvent.Final, text: result.text || "" });
        return result.text || "";
      }

      for (const call of result.toolCalls) {
        onEvent({ type: AgentEvent.ToolCall, id: call.id, name: call.name, args: call.args });
        const tool = this.tools.get(call.name);
        let content, ok = true;
        if (!tool) {
          ok = false;
          content = `Error: unknown tool "${call.name}"`;
        } else if (!(await this.approve({ name: call.name, args: call.args, annotations: tool.annotations ?? {} }))) {
          ok = false;
          content = `Error: tool "${call.name}" was denied by the approval policy. Do not retry it; consider an alternative or ask the user.`;
          onEvent({ type: AgentEvent.ToolDenied, id: call.id, name: call.name, args: call.args });
        } else {
          try {
            content = await tool.handler(call.args);
            if (typeof content !== "string") content = JSON.stringify(content);
            this.usage.toolCalls++;
          } catch (err) {
            ok = false;
            content = `Error: ${err.message}`;
          }
        }
        onEvent({ type: AgentEvent.ToolResult, id: call.id, name: call.name, ok, content });
        this.messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content,
        });
      }
    }

    const msg = `Agent exceeded maxSteps (${this.maxSteps}) without producing a final answer.`;
    this._emitUsage(onEvent);
    onEvent({ type: AgentEvent.Error, message: msg });
    throw new Error(msg);
  }

  _emitUsage(onEvent) {
    const totalTokens = this.usage.inputTokens + this.usage.outputTokens;
    onEvent({
      type: AgentEvent.Usage,
      ...this.usage,
      totalTokens,
      costUsd: estimateCost(this.provider?.name, this.usage),
    });
  }

  reset() {
    this.messages = this.systemPrompt
      ? [{ role: "system", content: this.systemPrompt }]
      : [];
    this.usage = { inputTokens: 0, outputTokens: 0, toolCalls: 0, steps: 0 };
  }
}
