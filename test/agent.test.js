import test from "node:test";
import assert from "node:assert/strict";

import { Agent } from "../src/agent/Agent.js";
import { AgentEvent } from "../src/agent/events.js";

// Scripted provider: returns one canned turn per step(), so we can drive the
// whole ReAct loop deterministically with no API key.
class StubProvider {
  constructor(turns) {
    this.name = "stub:test";
    this.turns = turns;
    this.i = 0;
  }
  async step() {
    const t = this.turns[this.i++] ?? { text: "done" };
    return {
      text: t.text ?? "",
      toolCalls: t.toolCalls ?? [],
      assistantMessage: { role: "assistant", content: t.text ?? "" },
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

function collect(events, type) {
  return events.filter((e) => e.type === type);
}

test("runs a tool call then finalizes, accumulating usage", async () => {
  const agent = new Agent({
    provider: new StubProvider([
      { toolCalls: [{ id: "1", name: "echo", args: { x: "hi" } }] },
      { text: "final answer" },
    ]),
    tools: [{ name: "echo", annotations: {}, handler: async (a) => `echoed ${a.x}` }],
  });

  const events = [];
  const final = await agent.run("go", { onEvent: (e) => events.push(e) });

  assert.equal(final, "final answer");
  const results = collect(events, AgentEvent.ToolResult);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].content, "echoed hi");

  const usage = collect(events, AgentEvent.Usage).at(-1);
  assert.equal(usage.steps, 2);
  assert.equal(usage.toolCalls, 1);
  assert.equal(usage.totalTokens, 30); // 2 steps × (10 in + 5 out)
});

test("approval policy can block a destructive tool", async () => {
  let executed = false;
  const agent = new Agent({
    provider: new StubProvider([
      { toolCalls: [{ id: "1", name: "danger", args: {} }] },
      { text: "ok, skipped it" },
    ]),
    tools: [
      {
        name: "danger",
        annotations: { destructiveHint: true },
        handler: async () => {
          executed = true;
          return "boom";
        },
      },
    ],
    approve: async ({ annotations }) => !annotations.destructiveHint, // deny destructive
  });

  const events = [];
  await agent.run("delete everything", { onEvent: (e) => events.push(e) });

  assert.equal(executed, false, "denied tool must not run");
  assert.equal(collect(events, AgentEvent.ToolDenied).length, 1);
  const result = collect(events, AgentEvent.ToolResult)[0];
  assert.equal(result.ok, false);
  assert.match(result.content, /denied by the approval policy/);
});
