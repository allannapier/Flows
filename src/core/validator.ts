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

async function validateWithAnthropic(
  userMessage: string,
  model: string,
  apiKey: string,
  apiKeyEnvVar: string | undefined,
): Promise<ValidationVerdict> {
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

  if (response.stop_reason === "refusal") {
    const reason = response.stop_details?.category ?? "refusal";
    return {
      passed: false,
      feedback: `Validator could not produce a verdict (${reason})`,
    };
  }

  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === "text",
  );
  if (!textBlock) {
    return {
      passed: false,
      feedback: `Validator could not produce a verdict (no text response, stop_reason: ${response.stop_reason ?? "unknown"})`,
    };
  }

  return normalizeVerdict(JSON.parse(textBlock.text));
}

async function validateWithOpenAI(
  userMessage: string,
  model: string,
  apiKey: string,
  baseUrl: string | undefined,
): Promise<ValidationVerdict> {
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

  const message = response.choices[0]?.message;
  if (!message) {
    return {
      passed: false,
      feedback: "Validator could not produce a verdict (no response choices)",
    };
  }
  if (message.refusal) {
    return {
      passed: false,
      feedback: `Validator could not produce a verdict (${message.refusal})`,
    };
  }
  if (!message.content) {
    return {
      passed: false,
      feedback: "Validator could not produce a verdict (no text response)",
    };
  }

  return normalizeVerdict(JSON.parse(message.content));
}

async function validateWithGoogle(
  userMessage: string,
  model: string,
  apiKey: string,
): Promise<ValidationVerdict> {
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

  const text = response.text;
  if (!text) {
    const finishReason = response.candidates?.[0]?.finishReason ?? "unknown";
    return {
      passed: false,
      feedback: `Validator could not produce a verdict (no text response, finish reason: ${finishReason})`,
    };
  }

  return normalizeVerdict(JSON.parse(text));
}

export async function validateOutput(args: {
  stepPrompt: string;
  expectedResult: string;
  output: string;
  /** Draft config to validate against instead of the persisted one (used by
   * the Settings screen's "Test" button, which must not silently persist). */
  configOverride?: AppConfig;
}): Promise<ValidationVerdict> {
  const { stepPrompt, expectedResult, output, configOverride } = args;
  const resolved = resolveValidator(configOverride);
  const userMessage = buildUserMessage({ stepPrompt, expectedResult, output });

  switch (resolved.provider) {
    case "anthropic":
      return validateWithAnthropic(userMessage, resolved.model, resolved.apiKey, resolved.apiKeyEnvVar);
    case "openai":
      return validateWithOpenAI(userMessage, resolved.model, resolved.apiKey, undefined);
    case "custom":
      return validateWithOpenAI(userMessage, resolved.model, resolved.apiKey, resolved.baseUrl);
    case "google":
      return validateWithGoogle(userMessage, resolved.model, resolved.apiKey);
  }
}
