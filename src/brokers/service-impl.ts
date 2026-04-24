/**
 * The actual "service" each broker performs. We use Gemini to generate real
 * outputs so the demo doesn't look like a stubbed mock. Quality is modulated
 * via the system prompt.
 *
 * NOTE: brokers use the raw Gemini REST path (not the Vercel SDK) because
 * the SDK path spends 60–120s per Pro call while raw REST lands in ~4s with
 * the same prompt and thinkingLevel. Diagnosed 2026-04-21 via
 * scripts/probe-gemini.ts.
 */
import { generateTextRaw } from "../circle/gemini-raw.js";
import { config } from "../config.js";
import type { BrokerSpec } from "./registry.js";

const qualityHint = (q: number) =>
  q > 0.85
    ? "Be precise, cite concrete evidence, avoid hedging."
    : q > 0.7
      ? "Be concise and reasonably confident."
      : "Give a quick, heuristic answer. It's OK to be approximate.";

export async function runBrokerService(
  broker: BrokerSpec,
  input: string
): Promise<{ output: string; confidence: number }> {
  const instructions: Record<BrokerSpec["service"], (x: string) => string> = {
    sentiment: (x) =>
      `You are a sentiment classifier. Classify the TEXT below and return ONLY a JSON object like {"label": "positive"|"neutral"|"negative", "score": 0..1}. ${qualityHint(broker.quality)}

TEXT:
"""
${x}
"""`,
    "price-lookup": (x) =>
      `You are a price lookup service. The user is asking about a ticker or asset (below). Return ONLY a JSON object like {"ticker": "...", "price_usd": number, "source": "mocked"}. Invent a plausible current-ish price. ${qualityHint(broker.quality)}

QUERY:
"""
${x}
"""`,
    summarize: (x) =>
      `You are a text summarizer. Summarize the TEXT below and return ONLY a JSON object like {"summary": "...", "key_points": ["..."]}. ${qualityHint(broker.quality)}

TEXT:
"""
${x}
"""`,
  };

  // NOTE: Gemini via @ai-sdk/google concatenates system into the user turn in
  // a way that can cause the model to mistake the system prompt for the entire
  // input. We sidestep this by inlining everything as a single user prompt and
  // NOT using `system`. See debug trail on 2026-04-21 where Gemini claimed
  // "no input provided" when system+prompt were split.
  const { text, ms, thoughtsTokenCount } = await generateTextRaw(
    instructions[broker.service](input)
  );
  if (process.env.DEMO_TIMINGS) {
    console.log(`[${broker.id}] gemini ${ms}ms thoughts=${thoughtsTokenCount ?? "?"}`);
  }

  return {
    output: text,
    confidence: broker.quality,
  };
}
