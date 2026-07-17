// Flow execution engine: runs a Flow's steps in order, spawning the
// configured agent for each step inside a real PTY (via AgentSession),
// optionally validating output with the built-in LLM validator, and
// retrying failed steps up to maxRetries times.

import { ptyToText } from "ghostty-opentui";
import type { Flow, RunEvent, RunHandle, RunOptions } from "../types";
import { buildAgentCommand } from "./agents";
import { AgentSession } from "./session";
import { renderTemplate } from "./template";
import { validateOutput } from "./validator";

const RETRY_CONTEXT_TEMPLATE = (feedback: string) =>
  `\n\n--- RETRY CONTEXT ---\n` +
  `A previous attempt did not satisfy the expected result.\n` +
  `Validator feedback: ${feedback}\n` +
  `Please address the feedback and try again.`;

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

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

  function emitCancelledIfNeeded(): boolean {
    if (cancelled && !cancelledEmitted) {
      cancelledEmitted = true;
      onEvent({ type: "flow-failed", error: "Cancelled by user" });
    }
    return cancelled;
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

    for (let stepIndex = 0; stepIndex < flow.steps.length; stepIndex++) {
      if (cancelled) {
        emitCancelledIfNeeded();
        return;
      }

      const step = flow.steps[stepIndex];

      let basePrompt: string;
      try {
        basePrompt = renderTemplate(step.prompt, params, stepOutputs);
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

        let cmd: string[];
        let extraEnv: Record<string, string> | undefined;
        try {
          const built = buildAgentCommand(step, promptForAttempt);
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
          cwd: step.workingDir || process.cwd(),
          cols: attemptCols,
          rows: attemptRows,
          onData: (chunk) => onEvent({ type: "agent-output", stepIndex, chunk }),
        });
        currentSession = session;

        const exitCode = await session.exited;
        currentSession = null;

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
    },
    resize(cols: number, rows: number): void {
      liveCols = Math.max(2, cols);
      liveRows = Math.max(2, rows);
      if (currentSession) {
        currentSession.resize(liveCols, liveRows);
      }
    },
  };
}
