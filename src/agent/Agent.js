import { AgentEvent } from "./events.js";

const noop = () => {};

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
  constructor({ provider, tools = [], systemPrompt = "", maxSteps = 8 }) {
    this.provider = provider;
    this.tools = new Map(tools.map((t) => [t.name, t]));
    this.systemPrompt = systemPrompt;
    this.maxSteps = maxSteps;
    this.messages = [];
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
      if (result.text) onEvent({ type: AgentEvent.AssistantText, text: result.text });

      if (!result.toolCalls?.length) {
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
        } else {
          try {
            content = await tool.handler(call.args);
            if (typeof content !== "string") content = JSON.stringify(content);
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
    onEvent({ type: AgentEvent.Error, message: msg });
    throw new Error(msg);
  }

  reset() {
    this.messages = this.systemPrompt
      ? [{ role: "system", content: this.systemPrompt }]
      : [];
  }
}
