// Rough USD price table ($ per 1M tokens), matched by substring of the model
// name. Approximate and provider-published prices change — this is for a
// ballpark "what did that run cost" figure, not billing.
const PRICES = [
  { match: "gemini-2.5-flash", in: 0.3, out: 2.5 },
  { match: "gemini-1.5-flash", in: 0.075, out: 0.3 },
  { match: "gemini-1.5-pro", in: 1.25, out: 5.0 },
  { match: "gpt-4o-mini", in: 0.15, out: 0.6 },
  { match: "gpt-4o", in: 2.5, out: 10.0 },
];

/**
 * Estimate the USD cost of a run from token counts. `model` may be a bare model
 * name or the provider's `name` (e.g. "openai:gpt-4o-mini"); we match on substring.
 * Returns null when the model isn't in the table, so callers can omit cost.
 */
export function estimateCost(model, { inputTokens = 0, outputTokens = 0 } = {}) {
  const name = String(model || "").toLowerCase();
  const price = PRICES.find((p) => name.includes(p.match));
  if (!price) return null;
  return (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
}
