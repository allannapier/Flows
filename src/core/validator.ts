// Built-in LLM validation. Judges whether a step's agent output satisfies
// the step's expected result, dispatching to whichever provider is
// configured (see src/core/config.ts) — Anthropic, OpenAI, Google, or a
// custom OpenAI-compatible endpoint.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI, Type } from "@google/genai";
import type { ValidationVerdict } from "../types";
import { resolveValidator, type AppConfig } from "./config";

const MAX_OUTPUT_CHARS = 80_000;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    feedback: { type: "string" },
    needsUserInput: { type: "boolean" },
    // Nullable rather than omittable: OpenAI's strict json_schema mode
    // requires every property to appear in `required`, so "optional" is
    // expressed as "may be null" instead of "may be absent".
    questionsSummary: { type: ["string", "null"] },
  },
  required: ["passed", "feedback", "needsUserInput", "questionsSummary"],
  additionalProperties: false,
} as const;

/** Token usage reported by a single validator call, split by direction so
 * cost can be computed with the provider's (asymmetric) input/output rates. */
export interface ValidatorUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ValidationResult {
  verdict: ValidationVerdict;
  /** Present when the provider reported usage for this call — absent on
   * thrown/refusal-adjacent paths that never got a response. */
  usage?: ValidatorUsage;
  /** Estimated cost in USD of this single call, derived from `usage` and a
   * static price table. undefined when usage is unavailable or the model
   * isn't in the table. */
  costUsd?: number;
}

interface ModelPrice {
  inputPer1M: number;
  outputPer1M: number;
}

// Static, approximate USD-per-million-tokens table used only to estimate
// step cost for display — not guaranteed to track providers' current
// pricing. Matched by case-insensitive prefix against the resolved
// validator model name, most-specific prefix first (e.g. "gpt-4o-mini"
// before "gpt-4o"); an unmatched model yields an undefined estimate rather
// than a misleading number.
const PRICE_TABLE: Array<{ prefix: string; price: ModelPrice }> = [
  { prefix: "claude-opus", price: { inputPer1M: 15, outputPer1M: 75 } },
  { prefix: "claude-sonnet", price: { inputPer1M: 3, outputPer1M: 15 } },
  { prefix: "claude-haiku", price: { inputPer1M: 0.8, outputPer1M: 4 } },
  { prefix: "gpt-4o-mini", price: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { prefix: "gpt-4o", price: { inputPer1M: 2.5, outputPer1M: 10 } },
  { prefix: "gpt-4.1-mini", price: { inputPer1M: 0.4, outputPer1M: 1.6 } },
  { prefix: "gpt-4.1", price: { inputPer1M: 2, outputPer1M: 8 } },
  { prefix: "o3-mini", price: { inputPer1M: 1.1, outputPer1M: 4.4 } },
  { prefix: "gemini-2.0-flash", price: { inputPer1M: 0.1, outputPer1M: 0.4 } },
  { prefix: "gemini-1.5-pro", price: { inputPer1M: 1.25, outputPer1M: 5 } },
  { prefix: "gemini-1.5-flash", price: { inputPer1M: 0.075, outputPer1M: 0.3 } },
];

function estimateCostUsd(model: string, usage: ValidatorUsage): number | undefined {
  const lower = model.toLowerCase();
  const price = PRICE_TABLE.find((e) => lower.startsWith(e.prefix))?.price;
  if (!price) return undefined;
  return (usage.inputTokens / 1_000_000) * price.inputPer1M + (usage.outputTokens / 1_000_000) * price.outputPer1M;
}

const SYSTEM_PROMPT =
  "You are a strict QA validator for an automated workflow. You will be given " +
  "the task prompt given to an autonomous coding agent, the expected result " +
  "for that task, and the output the agent actually produced. Judge only " +
  "whether the agent's output satisfies the expected result — do not judge " +
  "code style, alternate approaches, or anything outside the stated " +
  "expectation. Your feedback should be short, concrete, and actionable for " +
  "a retry: if the task failed, say specifically what is missing or wrong " +
  "so the agent can fix it on the next attempt.\n\n" +
  "Separately, decide whether the agent's output explicitly asks the user " +
  "one or more questions or requests a decision before it can proceed — set " +
  "needsUserInput to true in that case. This is independent of `passed`: a " +
  "step can pass (it did what was asked) and still need user input (e.g. a " +
  "planning step that finished its plan but is now asking which option to " +
  "take). The output may be a multi-turn transcript with turns separated by " +
  "`---` lines: judge needsUserInput ONLY by how the transcript ENDS. A " +
  "question asked in an earlier turn that a later turn has answered, " +
  "acknowledged, or superseded does not count — if the final turn asks " +
  "nothing and awaits no decision, needsUserInput is false. When " +
  "needsUserInput is true, set questionsSummary to a short one-sentence " +
  "summary of what's being asked; otherwise set it to null.";

function buildUserMessage(args: { stepPrompt: string; expectedResult: string; output: string }): string {
  const { stepPrompt, expectedResult, output } = args;

  let truncatedOutput = output;
  let truncationNote = "";
  if (output.length > MAX_OUTPUT_CHARS) {
    truncatedOutput = output.slice(-MAX_OUTPUT_CHARS);
    truncationNote =
      `\n\n(Note: the agent output was longer than ${MAX_OUTPUT_CHARS} characters ` +
      `and has been truncated to the last ${MAX_OUTPUT_CHARS} characters.)`;
  }

  return (
    `Task prompt given to the agent:\n${stepPrompt}\n\n` +
    `Expected result:\n${expectedResult}\n\n` +
    `Agent output:\n${truncatedOutput}${truncationNote}`
  );
}

/** Defensively coerces a parsed verdict blob into a well-formed
 * ValidationVerdict — providers can omit fields despite the schema (e.g. a
 * refusal-adjacent response), so this must never throw on missing data. */
function normalizeVerdict(parsed: unknown): ValidationVerdict {
  const v = (parsed ?? {}) as Partial<Record<keyof ValidationVerdict, unknown>>;
  const questionsSummary = typeof v.questionsSummary === "string" ? v.questionsSummary.trim() : "";
  return {
    passed: v.passed === true,
    feedback: typeof v.feedback === "string" ? v.feedback : "",
    needsUserInput: v.needsUserInput === true,
    questionsSummary: questionsSummary !== "" ? questionsSummary : undefined,
  };
}

interface InnerResult {
  verdict: ValidationVerdict;
  usage?: ValidatorUsage;
}

async function validateWithAnthropic(
  userMessage: string,
  model: string,
  apiKey: string,
  apiKeyEnvVar: string | undefined,
): Promise<InnerResult> {
  // ANTHROPIC_AUTH_TOKEN is a bearer token, not an API key — construct the
  // client accordingly so it lands on the right auth header.
  const client =
    apiKeyEnvVar === "ANTHROPIC_AUTH_TOKEN" ? new Anthropic({ authToken: apiKey }) : new Anthropic({ apiKey });

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: {
        format: { type: "json_schema", schema: VERDICT_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Validator call failed: ${message}`);
  }

  const usage: ValidatorUsage = {
    inputTokens: response.usage.input_tokens ?? 0,
    outputTokens: response.usage.output_tokens ?? 0,
  };

  if (response.stop_reason === "refusal") {
    const reason = response.stop_details?.category ?? "refusal";
    return {
      verdict: {
        passed: false,
        feedback: `Validator could not produce a verdict (${reason})`,
      },
      usage,
    };
  }

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    return {
      verdict: {
        passed: false,
        feedback: `Validator could not produce a verdict (no text response, stop_reason: ${response.stop_reason ?? "unknown"})`,
      },
      usage,
    };
  }

  return { verdict: normalizeVerdict(JSON.parse(textBlock.text)), usage };
}

async function validateWithOpenAI(
  userMessage: string,
  model: string,
  apiKey: string,
  baseUrl: string | undefined,
): Promise<InnerResult> {
  const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });

  let response: OpenAI.Chat.Completions.ChatCompletion;
  try {
    response = await client.chat.completions.create({
      model,
      response_format: {
        type: "json_schema",
        json_schema: { name: "verdict", strict: true, schema: VERDICT_SCHEMA },
      },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Validator call failed: ${message}`);
  }

  const usage: ValidatorUsage | undefined = response.usage
    ? { inputTokens: response.usage.prompt_tokens ?? 0, outputTokens: response.usage.completion_tokens ?? 0 }
    : undefined;

  const message = response.choices[0]?.message;
  if (!message) {
    return {
      verdict: {
        passed: false,
        feedback: "Validator could not produce a verdict (no response choices)",
      },
      usage,
    };
  }
  if (message.refusal) {
    return {
      verdict: {
        passed: false,
        feedback: `Validator could not produce a verdict (${message.refusal})`,
      },
      usage,
    };
  }
  if (!message.content) {
    return {
      verdict: {
        passed: false,
        feedback: "Validator could not produce a verdict (no text response)",
      },
      usage,
    };
  }

  return { verdict: normalizeVerdict(JSON.parse(message.content)), usage };
}

async function validateWithGoogle(
  userMessage: string,
  model: string,
  apiKey: string,
): Promise<InnerResult> {
  const client = new GoogleGenAI({ apiKey });

  let response: Awaited<ReturnType<typeof client.models.generateContent>>;
  try {
    response = await client.models.generateContent({
      model,
      contents: userMessage,
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            passed: { type: Type.BOOLEAN },
            feedback: { type: Type.STRING },
            needsUserInput: { type: Type.BOOLEAN },
            questionsSummary: { type: Type.STRING, nullable: true },
          },
          required: ["passed", "feedback"],
        },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Validator call failed: ${message}`);
  }

  const usage: ValidatorUsage | undefined = response.usageMetadata
    ? {
        inputTokens: response.usageMetadata.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
      }
    : undefined;

  const text = response.text;
  if (!text) {
    const finishReason = response.candidates?.[0]?.finishReason ?? "unknown";
    return {
      verdict: {
        passed: false,
        feedback: `Validator could not produce a verdict (no text response, finish reason: ${finishReason})`,
      },
      usage,
    };
  }

  return { verdict: normalizeVerdict(JSON.parse(text)), usage };
}

export async function validateOutput(args: {
  stepPrompt: string;
  expectedResult: string;
  output: string;
  /** Draft config to validate against instead of the persisted one (used by
   * the Settings screen's "Test" button, which must not silently persist). */
  configOverride?: AppConfig;
}): Promise<ValidationResult> {
  const { stepPrompt, expectedResult, output, configOverride } = args;
  const resolved = resolveValidator(configOverride);
  const userMessage = buildUserMessage({ stepPrompt, expectedResult, output });

  let inner: InnerResult;
  switch (resolved.provider) {
    case "anthropic":
      inner = await validateWithAnthropic(userMessage, resolved.model, resolved.apiKey, resolved.apiKeyEnvVar);
      break;
    case "openai":
      inner = await validateWithOpenAI(userMessage, resolved.model, resolved.apiKey, undefined);
      break;
    case "custom":
      inner = await validateWithOpenAI(userMessage, resolved.model, resolved.apiKey, resolved.baseUrl);
      break;
    case "google":
      inner = await validateWithGoogle(userMessage, resolved.model, resolved.apiKey);
      break;
  }

  const costUsd = inner.usage ? estimateCostUsd(resolved.model, inner.usage) : undefined;
  return { verdict: inner.verdict, usage: inner.usage, costUsd };
}
