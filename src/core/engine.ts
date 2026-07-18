// Flow execution engine: runs a Flow's steps in order, spawning the
// configured agent for each step inside a real PTY (via AgentSession),
// optionally validating output with the built-in LLM validator, and
// retrying failed steps up to maxRetries times.

import { ptyToText } from "ghostty-opentui";
import type { Flow, RunEvent, RunHandle, RunOptions } from "../types";
import { AGENTS, agentSupportsContinuation, buildAgentCommand } from "./agents";
import { resolveWorkingDir } from "./paths";
import { AgentSession } from "./session";
import { renderTemplate } from "./template";
import { validateOutput } from "./validator";

const RETRY_CONTEXT_TEMPLATE = (feedback: string) =>
  `\n\n--- RETRY CONTEXT ---\n` +
  `A previous attempt did not satisfy the expected result.\n` +
  `Validator feedback: ${feedback}\n` +
  `Please address the feedback and try again.`;

const NEEDS_INPUT_CONTEXT_TEMPLATE = (question: string, answer: string) =>
  `\n\n--- FOLLOW-UP ---\n` +
  `On a previous attempt you asked instead of proceeding:\n"${question}"\n` +
  `The user's answer: ${answer}\n` +
  `Continue the task using this answer. Do not ask again.`;

const WORKING_DIR_NOTE = (dir: string) =>
  `Your working directory for this task is: ${dir}\n` +
  `Read, write, and build files relative to this directory unless told otherwise. ` +
  `Do not ask for confirmation of the working directory — proceed using it.\n\n`;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

// Heuristic: a step's output "looks like a question" (the agent stalled out
// asking the user something instead of doing the work) when its last
// non-empty line ends in "?" and the whole output is short — genuine
// completed work is virtually always longer than a one- or two-line
// question. This can't be perfect (agents in single-shot "-p" mode exit
// after answering, so there's no live process left to actually detect a
// stall on) but catches the common case cheaply, without an extra LLM call
// on every step.
const NEEDS_INPUT_MAX_LENGTH = 500;

function looksLikeClarifyingQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > NEEDS_INPUT_MAX_LENGTH) return false;
  const lines = trimmed.split("\n").map((l) => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] ?? "";
  return lastLine.endsWith("?");
}

// Matches CSI sequences (ESC [ ... final byte) used as a fallback cleaner
// when ptyToText itself throws on malformed input.
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
// Matches OSC sequences (ESC ] ... BEL or ST).
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

function stripAnsiFallback(s: string): string {
  return s.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "");
}

function cleanOutput(raw: string, cols: number, rows: number): string {
  try {
    return ptyToText(raw, { cols, rows });
  } catch {
    return stripAnsiFallback(raw);
  }
}

export function runFlow(
  flow: Flow,
  paramValues: Record<string, string>,
  onEvent: (e: RunEvent) => void,
  options?: RunOptions,
): RunHandle {
  let cancelled = false;
  let cancelledEmitted = false;
  let currentSession: AgentSession | null = null;
  let liveCols = options?.cols ?? DEFAULT_COLS;
  let liveRows = options?.rows ?? DEFAULT_ROWS;
  let pendingAnswer: ((answer: string) => void) | null = null;

  function emitCancelledIfNeeded(): boolean {
    if (cancelled && !cancelledEmitted) {
      cancelledEmitted = true;
      onEvent({ type: "flow-failed", error: "Cancelled by user" });
    }
    return cancelled;
  }

  /** Pauses the run loop until the UI supplies an answer via
   * RunHandle.answerInput (or cancel() unblocks it with ""). */
  function waitForAnswer(): Promise<string> {
    return new Promise<string>((resolve) => {
      pendingAnswer = resolve;
    });
  }

  async function execute(): Promise<void> {
    onEvent({ type: "flow-start", flowName: flow.name, totalSteps: flow.steps.length });

    // Resolve parameter values: required params must be present; optional
    // params fall back to their default (if any).
    const params: Record<string, string> = {};
    for (const p of flow.parameters) {
      if (Object.prototype.hasOwnProperty.call(paramValues, p.name)) {
        params[p.name] = paramValues[p.name];
      } else if (p.required) {
        onEvent({
          type: "flow-failed",
          error: `Missing required parameter: ${p.name}`,
        });
        return;
      } else if (p.default !== undefined) {
        params[p.name] = p.default;
      }
    }

    const stepOutputs: Record<string, string> = {};
    // Tracks which (agent, resolved cwd) pairs have already run at least one
    // attempt in this run, so the first step for a given pair always starts
    // fresh even when continueSession=true (avoids attaching to an unrelated
    // prior conversation, or the CLI erroring when there's nothing to
    // continue). Retries of a continuing step continue automatically because
    // the key is added after attempt 1.
    const sessionStarted = new Set<string>();

    for (let stepIndex = 0; stepIndex < flow.steps.length; stepIndex++) {
      if (cancelled) {
        emitCancelledIfNeeded();
        return;
      }

      const step = flow.steps[stepIndex];
      const resolvedCwd = resolveWorkingDir(step.workingDir);
      const sessionKey = `${step.agent}::${resolvedCwd}`;

      if (step.continueSession && !agentSupportsContinuation(step.agent)) {
        const agentLabel = AGENTS.find((a) => a.id === step.agent)?.label ?? step.agent;
        onEvent({
          type: "session-note",
          stepIndex,
          note: `${agentLabel} does not support session continuation — running fresh`,
        });
      }

      let basePrompt: string;
      try {
        const rendered = renderTemplate(step.prompt, params, stepOutputs);
        // Custom commands get the rendered prompt verbatim via $FLOW_PROMPT —
        // the user owns how it's parsed, so we don't decorate it. The
        // built-in agents get an explicit heads-up about their working
        // directory so they don't have to guess (or ask) where to build.
        basePrompt = step.agent === "custom" ? rendered : WORKING_DIR_NOTE(resolvedCwd) + rendered;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent({ type: "step-failed", stepIndex, error: message });
        onEvent({ type: "flow-failed", error: message });
        return;
      }

      const maxAttempts = 1 + Math.max(0, step.maxRetries);
      let retryFeedback: string | undefined;
      let stepSucceeded = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (cancelled) {
          emitCancelledIfNeeded();
          return;
        }

        onEvent({
          type: "step-start",
          stepIndex,
          stepName: step.name,
          agent: step.agent,
          attempt,
        });

        const promptForAttempt =
          retryFeedback !== undefined
            ? basePrompt + RETRY_CONTEXT_TEMPLATE(retryFeedback)
            : basePrompt;

        const effectiveContinue =
          step.continueSession === true &&
          agentSupportsContinuation(step.agent) &&
          sessionStarted.has(sessionKey);

        let cmd: string[];
        let extraEnv: Record<string, string> | undefined;
        try {
          const built = buildAgentCommand(step, promptForAttempt, effectiveContinue);
          cmd = built.cmd;
          extraEnv = built.env;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onEvent({ type: "step-failed", stepIndex, error: message });
          onEvent({ type: "flow-failed", error: message });
          return;
        }

        const attemptCols = liveCols;
        const attemptRows = liveRows;

        const session = new AgentSession({
          cmd,
          env: extraEnv,
          cwd: resolvedCwd,
          cols: attemptCols,
          rows: attemptRows,
          onData: (chunk) => onEvent({ type: "agent-output", stepIndex, chunk }),
        });
        currentSession = session;

        const exitCode = await session.exited;
        currentSession = null;

        // Mark this (agent, cwd) pair as having run at least one attempt,
        // regardless of exit code / validation outcome, so subsequent
        // attempts/steps that opt into continuation resume this conversation.
        sessionStarted.add(sessionKey);

        onEvent({ type: "step-output-complete", stepIndex, exitCode });

        if (cancelled) {
          emitCancelledIfNeeded();
          return;
        }

        const stepText = cleanOutput(session.raw, liveCols, liveRows);

        if (exitCode !== 0) {
          const feedback = `Agent exited with code ${exitCode}`;
          if (attempt < maxAttempts) {
            onEvent({ type: "step-retry", stepIndex, attempt: attempt + 1, feedback });
            retryFeedback = feedback;
            continue;
          }
          onEvent({ type: "step-failed", stepIndex, error: feedback });
          onEvent({ type: "flow-failed", error: feedback });
          return;
        }

        if (looksLikeClarifyingQuestion(stepText)) {
          if (attempt >= maxAttempts) {
            const message = `Agent asked a question instead of completing the step, and no retries remain: "${stepText.trim()}"`;
            onEvent({ type: "step-failed", stepIndex, error: message });
            onEvent({ type: "flow-failed", error: message });
            return;
          }
          onEvent({ type: "step-needs-input", stepIndex, question: stepText.trim() });
          const answer = await waitForAnswer();
          pendingAnswer = null;
          if (cancelled) {
            emitCancelledIfNeeded();
            return;
          }
          const feedback = `Answered: ${answer}`;
          onEvent({ type: "step-retry", stepIndex, attempt: attempt + 1, feedback });
          retryFeedback = undefined;
          basePrompt = basePrompt + NEEDS_INPUT_CONTEXT_TEMPLATE(stepText.trim(), answer);
          continue;
        }

        if (step.validate) {
          onEvent({ type: "validation-start", stepIndex });
          let verdict;
          try {
            verdict = await validateOutput({
              stepPrompt: basePrompt,
              expectedResult: step.expectedResult,
              output: stepText,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onEvent({ type: "step-failed", stepIndex, error: message });
            onEvent({ type: "flow-failed", error: message });
            return;
          }

          if (cancelled) {
            emitCancelledIfNeeded();
            return;
          }

          onEvent({ type: "validation-result", stepIndex, verdict });

          if (!verdict.passed) {
            if (attempt < maxAttempts) {
              onEvent({
                type: "step-retry",
                stepIndex,
                attempt: attempt + 1,
                feedback: verdict.feedback,
              });
              retryFeedback = verdict.feedback;
              continue;
            }
            onEvent({ type: "step-failed", stepIndex, error: verdict.feedback });
            onEvent({ type: "flow-failed", error: verdict.feedback });
            return;
          }
        }

        stepOutputs[step.name] = stepText;
        onEvent({ type: "step-complete", stepIndex, output: stepText });
        stepSucceeded = true;
        break;
      }

      if (!stepSucceeded) {
        // Should be unreachable: every exit path above either continues the
        // attempt loop, returns, or sets stepSucceeded.
        return;
      }
    }

    onEvent({ type: "flow-complete" });
  }

  const done = execute().catch((err) => {
    // Defensive: runFlow's `done` promise must never reject. Any unexpected
    // throw is reported as a flow failure instead.
    const message = err instanceof Error ? err.message : String(err);
    if (!cancelledEmitted) {
      onEvent({ type: "flow-failed", error: message });
    }
  });

  return {
    done,
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      if (currentSession) {
        currentSession.kill();
      }
      if (pendingAnswer) {
        const resolve = pendingAnswer;
        pendingAnswer = null;
        resolve("");
      }
    },
    resize(cols: number, rows: number): void {
      liveCols = Math.max(2, cols);
      liveRows = Math.max(2, rows);
      if (currentSession) {
        currentSession.resize(liveCols, liveRows);
      }
    },
    write(data: string): void {
      if (currentSession) {
        currentSession.write(data);
      }
    },
    answerInput(text: string): void {
      if (pendingAnswer) {
        const resolve = pendingAnswer;
        pendingAnswer = null;
        resolve(text);
      }
    },
  };
}
