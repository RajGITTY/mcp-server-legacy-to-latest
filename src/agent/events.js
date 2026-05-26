// Event types emitted by the agent during a run. Consumers (CLI, web UI, tests)
// subscribe via the onEvent callback to render the ReAct loop live.
export const AgentEvent = {
  Start: "start",                 // { prompt }
  Step: "step",                   // { step, maxSteps }
  AssistantText: "assistant_text",// { text }    full assistant turn text
  ToolCall: "tool_call",          // { id, name, args }
  ToolResult: "tool_result",      // { id, name, ok, content }
  Final: "final",                 // { text }
  Error: "error",                 // { message }
};
