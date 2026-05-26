import { GoogleGenerativeAI } from "@google/generative-ai";

/**
 * Gemini provider. Translates the neutral message/tool shape into Gemini's
 * function-calling format and back. Includes exponential-backoff retry for
 * 429/503 quota errors, which the free tier returns frequently.
 */
export class GeminiProvider {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || "gemini-2.5-flash" } = {}) {
    if (!apiKey) throw new Error("GeminiProvider: GEMINI_API_KEY is required");
    this.client = new GoogleGenerativeAI(apiKey);
    this.modelName = model;
    this.name = `gemini:${model}`;
  }

  async step({ messages, tools }) {
    const { systemInstruction, contents } = toGemini(messages);
    const model = this.client.getGenerativeModel(
      {
        model: this.modelName,
        systemInstruction,
        tools: tools.length ? [{ functionDeclarations: tools.map(toGeminiTool) }] : undefined,
      },
      { apiVersion: "v1beta" }
    );

    const result = await withRetry(() => model.generateContent({ contents }));
    const response = result.response;
    const calls = response.functionCalls?.() ?? [];
    const text = typeof response.text === "function" ? safeText(response) : "";

    const parts = [];
    if (text) parts.push({ text });
    for (const c of calls) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });

    return {
      text,
      toolCalls: calls.map((c, i) => ({
        id: `${c.name}-${Date.now()}-${i}`,
        name: c.name,
        args: c.args ?? {},
      })),
      assistantMessage: { role: "assistant", content: text, _geminiParts: parts },
    };
  }
}

function safeText(response) {
  try { return response.text(); } catch { return ""; }
}

function toGeminiTool({ name, description, parameters }) {
  return { name, description, parameters: stripUnsupportedSchemaKeys(parameters) };
}

// Gemini rejects some JSON Schema keywords (additionalProperties, $schema, etc.)
function stripUnsupportedSchemaKeys(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const banned = new Set(["additionalProperties", "$schema", "$id", "definitions"]);
  if (Array.isArray(schema)) return schema.map(stripUnsupportedSchemaKeys);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (banned.has(k)) continue;
    out[k] = stripUnsupportedSchemaKeys(v);
  }
  return out;
}

function toGemini(messages) {
  let systemInstruction;
  const contents = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemInstruction = m.content;
      continue;
    }
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: String(m.content ?? "") }] });
      continue;
    }
    if (m.role === "assistant") {
      const parts = m._geminiParts ?? (m.content ? [{ text: m.content }] : [{ text: "" }]);
      contents.push({ role: "model", parts });
      continue;
    }
    if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name: m.name, response: { content: m.content } } }],
      });
    }
  }
  return { systemInstruction, contents };
}

async function withRetry(fn, { maxRetries = 5, baseMs = 4000 } = {}) {
  let wait = baseMs;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = String(err?.message || err);
      const retriable = /(429|503|quota|rate)/i.test(msg);
      if (!retriable || attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, wait));
      wait *= 2;
    }
  }
}
