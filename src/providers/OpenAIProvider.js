import OpenAI from "openai";

/**
 * OpenAI provider using chat.completions with function calling.
 * Matches the same { step({messages, tools}) -> {text, toolCalls, assistantMessage} }
 * contract as GeminiProvider so the Agent can swap providers without changes.
 */
export class OpenAIProvider {
  constructor({ apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || "gpt-4o-mini" } = {}) {
    if (!apiKey) throw new Error("OpenAIProvider: OPENAI_API_KEY is required");
    this.client = new OpenAI({ apiKey });
    this.modelName = model;
    this.name = `openai:${model}`;
  }

  async step({ messages, tools }) {
    const completion = await this.client.chat.completions.create({
      model: this.modelName,
      messages: messages.map(toOpenAIMessage),
      tools: tools.length ? tools.map(toOpenAITool) : undefined,
      tool_choice: tools.length ? "auto" : undefined,
    });

    const choice = completion.choices[0].message;
    const toolCalls = (choice.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      args: safeParse(tc.function.arguments),
    }));

    const u = completion.usage ?? {};
    return {
      text: choice.content ?? "",
      toolCalls,
      assistantMessage: {
        role: "assistant",
        content: choice.content ?? "",
        _openaiToolCalls: choice.tool_calls ?? [],
      },
      usage: { inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0 },
    };
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

function toOpenAITool({ name, description, parameters }) {
  return { type: "function", function: { name, description, parameters } };
}

function toOpenAIMessage(m) {
  if (m.role === "system" || m.role === "user") return { role: m.role, content: m.content };
  if (m.role === "assistant") {
    const out = { role: "assistant", content: m.content || null };
    if (m._openaiToolCalls?.length) out.tool_calls = m._openaiToolCalls;
    return out;
  }
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: String(m.content) };
  }
  return m;
}
