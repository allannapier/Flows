// Built-in LLM validation using the Anthropic SDK. Judges whether a step's
// agent output satisfies the step's expected result.

import Anthropic from "@anthropic-ai/sdk";
import type { ValidationVerdict } from "../types";

const MAX_OUTPUT_CHARS = 80_000;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    passed: { type: "boolean" },
    feedback: { type: "string" },
  },
  required: ["passed", "feedback"],
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
  "so the agent can fix it on the next attempt.";

function resolveModel(): string {
  return process.env.FLOWS_VALIDATOR_MODEL ?? "claude-opus-4-8";
}

function assertCredentialsConfigured(): void {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "Validation requires Anthropic API credentials. Set ANTHROPIC_API_KEY " +
        "(or ANTHROPIC_AUTH_TOKEN) in your environment, or disable validation " +
        "for this step.",
    );
  }
}

export async function validateOutput(args: {
  stepPrompt: string;
  expectedResult: string;
  output: string;
}): Promise<ValidationVerdict> {
  assertCredentialsConfigured();

  const { stepPrompt, expectedResult, output } = args;

  let truncatedOutput = output;
  let truncationNote = "";
  if (output.length > MAX_OUTPUT_CHARS) {
    truncatedOutput = output.slice(-MAX_OUTPUT_CHARS);
    truncationNote =
      `\n\n(Note: the agent output was longer than ${MAX_OUTPUT_CHARS} characters ` +
      `and has been truncated to the last ${MAX_OUTPUT_CHARS} characters.)`;
  }

  const userMessage =
    `Task prompt given to the agent:\n${stepPrompt}\n\n` +
    `Expected result:\n${expectedResult}\n\n` +
    `Agent output:\n${truncatedOutput}${truncationNote}`;

  const client = new Anthropic();

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: resolveModel(),
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

  const parsed = JSON.parse(textBlock.text) as ValidationVerdict;
  return parsed;
}
