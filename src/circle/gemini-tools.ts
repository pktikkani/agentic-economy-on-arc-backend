/**
 * Raw-REST Gemini call with function calling (tool use).
 *
 * We implement the agent loop ourselves (call → functionCall? → execute →
 * feed functionResponse back → repeat) because the Vercel AI SDK's
 * generateText with tools was spending ~70s per task on Pro Preview while
 * the raw REST path lands in ~10s per model turn.
 *
 * Gemini REST function-calling reference:
 *   https://ai.google.dev/gemini-api/docs/function-calling
 *
 * Contract of `tools` argument:
 *   - name: stable identifier Gemini will use
 *   - description: shown to the model
 *   - parameters: JSON Schema (OpenAPI 3.0 subset)
 *   - execute: runs the tool locally; its return value is JSON-serialized
 *     and returned to Gemini as a functionResponse part.
 */
import { config } from "../config.js";

export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // OpenAPI 3.0 schema subset
  execute: (args: any) => Promise<any>;
};

/**
 * Gemini requires `functionResponse.response` to be a JSON object. If a tool
 * returns an array or primitive, wrap it so the server stops complaining.
 */
function wrapResult(result: unknown): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as Record<string, unknown>;
  }
  return { result };
}

export type RunOpts = {
  model?: string;
  thinkingLevel?: "low" | "medium" | "high";
  system?: string;
  prompt: string;
  tools: ToolDef[];
  /** max number of model ↔ tool roundtrips */
  maxSteps?: number;
  /** optional per-step logger */
  onStep?: (step: { kind: "call" | "tool"; detail: any; ms?: number }) => void;
};

type Part =
  | { text: string }
  | { functionCall: { name: string; args: any; id?: string } }
  | { functionResponse: { name: string; id?: string; response: Record<string, unknown> } };

// Gemini only accepts "user" and "model" roles; tool responses use role:"user"
// with a functionResponse part (per https://ai.google.dev/gemini-api/docs/function-calling).
type Content = { role: "user" | "model"; parts: Part[] };

const ENDPOINT = (model: string, apiKey: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

async function callGemini(
  model: string,
  apiKey: string,
  body: unknown
): Promise<any> {
  const res = await fetch(ENDPOINT(model, apiKey), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API ${res.status}: ${err.slice(0, 600)}`);
  }
  return res.json();
}

export async function runAgent(opts: RunOpts): Promise<{
  finalText: string;
  steps: { role: "model" | "tool"; detail: any; ms?: number }[];
  totalMs: number;
}> {
  const model = opts.model ?? config.gemini.model;
  const thinkingLevel = opts.thinkingLevel ?? config.gemini.thinkingLevel;
  const maxSteps = opts.maxSteps ?? 6;

  const contents: Content[] = [
    { role: "user", parts: [{ text: opts.prompt }] },
  ];

  const tools = [
    {
      functionDeclarations: opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    },
  ];

  const steps: { role: "model" | "tool"; detail: any; ms?: number }[] = [];
  const t0 = Date.now();
  let finalText = "";

  for (let i = 0; i < maxSteps; i++) {
    const body: any = {
      contents,
      tools,
      generationConfig: {
        thinkingConfig: { thinkingLevel },
      },
    };
    if (opts.system) {
      body.systemInstruction = { role: "system", parts: [{ text: opts.system }] };
    }

    const stepStart = Date.now();
    const resp = await callGemini(model, config.gemini.apiKey, body);
    const stepMs = Date.now() - stepStart;

    const cand = resp?.candidates?.[0];
    const parts: Part[] = cand?.content?.parts ?? [];

    steps.push({ role: "model", detail: { parts, finishReason: cand?.finishReason }, ms: stepMs });
    opts.onStep?.({ kind: "call", detail: { parts, finishReason: cand?.finishReason }, ms: stepMs });

    // If the model replied with text only (no functionCall), we're done.
    const functionCallPart = parts.find(
      (p): p is { functionCall: { name: string; args: any; id?: string } } =>
        (p as any).functionCall !== undefined
    );
    const textPart = parts.find((p): p is { text: string } => (p as any).text !== undefined);

    if (!functionCallPart) {
      finalText = textPart?.text ?? "";
      break;
    }

    // Push the model's turn into history (required by Gemini protocol)
    contents.push({ role: "model", parts });

    const callId = functionCallPart.functionCall.id;
    const callName = functionCallPart.functionCall.name;

    // Execute the requested tool
    const tool = opts.tools.find((t) => t.name === callName);
    if (!tool) {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: callName,
              ...(callId ? { id: callId } : {}),
              response: { error: `Unknown tool: ${callName}` },
            },
          },
        ],
      });
      continue;
    }

    const toolStart = Date.now();
    let toolResult: any;
    try {
      toolResult = await tool.execute(functionCallPart.functionCall.args ?? {});
    } catch (e: any) {
      toolResult = { error: e.message ?? String(e) };
    }
    const toolMs = Date.now() - toolStart;

    steps.push({ role: "tool", detail: { name: tool.name, args: functionCallPart.functionCall.args, result: toolResult }, ms: toolMs });
    opts.onStep?.({ kind: "tool", detail: { name: tool.name, args: functionCallPart.functionCall.args, result: toolResult }, ms: toolMs });

    // Feed the result back. Note: role is "user" (not "function"), and the
    // response must be a JSON *object* — we wrap arrays/primitives if needed.
    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: tool.name,
            ...(callId ? { id: callId } : {}),
            response: wrapResult(toolResult),
          },
        },
      ],
    });
  }

  return { finalText, steps, totalMs: Date.now() - t0 };
}
