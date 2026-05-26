import { GeminiProvider } from "./GeminiProvider.js";
import { OpenAIProvider } from "./OpenAIProvider.js";

export function createProvider(name = process.env.AGENT_PROVIDER || "gemini") {
  const key = name.toLowerCase();
  if (key === "gemini") return new GeminiProvider();
  if (key === "openai") return new OpenAIProvider();
  throw new Error(`Unknown AGENT_PROVIDER "${name}" (expected: gemini | openai)`);
}

export { GeminiProvider, OpenAIProvider };
