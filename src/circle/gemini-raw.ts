/**
 * Raw-REST Gemini call for latency-critical paths.
 *
 * Why this exists: the Vercel @ai-sdk/google SDK (and even the official
 * @google/genai SDK) consistently takes 60–120s per Pro call on our workload,
 * while a direct REST POST with the exact same prompt + thinkingConfig lands
 * in ~4s. We proved this with scripts/probe-gemini.ts on 2026-04-21.
 *
 * The SDKs are adding *something* (tool scaffolding, extra generationConfig
 * fields, service tier hints) that flips the server into high-thinking mode
 * regardless of the thinkingLevel we request. Raw REST honors the option.
 *
 * Use this for simple prompt→text tasks (brokers). Tool-calling loops that
 * need schema-typed tools should stick with the SDK.
 */
import { config } from "../config.js";

const ENDPOINT = (model: string, apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

export async function generateTextRaw(prompt: string, opts?: {
  model?: string;
  thinkingLevel?: "low" | "medium" | "high";
}): Promise<{ text: string; ms: number; thoughtsTokenCount?: number }> {
  const model = opts?.model ?? config.gemini.model;
  const thinkingLevel = opts?.thinkingLevel ?? config.gemini.thinkingLevel;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel },
    },
  };

  const t0 = Date.now();
  const res = await fetch(ENDPOINT(model, config.gemini.apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini raw call failed ${res.status}: ${err.slice(0, 500)}`);
  }

  const j: any = await res.json();
  const text: string = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const thoughtsTokenCount: number | undefined = j?.usageMetadata?.thoughtsTokenCount;
  return { text, ms, thoughtsTokenCount };
}
