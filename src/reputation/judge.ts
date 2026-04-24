/**
 * Gemini-powered "judge" that grades a broker's output on [0,1].
 * Used by the requester to produce a reputation signal after each paid call.
 */
// Ensure dotenv has loaded before the Google provider reads
// GOOGLE_GENERATIVE_AI_API_KEY at module construction time. Without this,
// tests that import this file directly see the key as missing.
import "../config.js";
import { generateObject } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";
import { config } from "../config.js";

// Judge uses Flash — it's faster, free-tier, and doesn't need Pro reasoning for
// a grading task that's mostly pattern matching.
const judgeModel = google("gemini-3-flash-preview");

const schema = z.object({
  quality: z.number().min(0).max(1).describe("0 = terrible, 1 = perfect"),
  reason: z.string().describe("One short sentence explaining the score."),
});

export async function judgeOutput(
  task: string,
  service: string,
  output: string
): Promise<{ quality: number; reason: string }> {
  const { object } = await generateObject({
    model: judgeModel,
    schema,
    system: `You are an objective judge evaluating an AI service's output quality.
Score from 0 (terrible/wrong/malformed) to 1 (perfect, precise, well-formed).
Consider: correctness, relevance to task, clarity, proper JSON structure if requested.`,
    prompt: `Service type: ${service}
Task: ${task}
Broker's output: ${output}

Rate it.`,
  });
  return object;
}
