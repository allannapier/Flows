// Flow execution engine: runs a Flow's steps in order, spawning the
// configured agent for each step, optionally validating output with the
// built-in LLM validator, and retrying failed steps up to maxRetries times.

import type { Flow, RunEvent, RunHandle } from "../types";
import { buildAgentCommand } from "./agents";
import { renderTemplate } from "./template";
import { validateOutput } from "./validator";

const RETRY_CONTEXT_TEMPLATE = (feedback: string) =>
  `\n\n--- RETRY CONTEXT ---\n` +
  `A previous attempt did not satisfy the expected result.\n` +
  `Validator feedback: ${feedback}\n` +
  `Please address the feedback and try again.`;

export function runFlow(
  flow: Flow,
  paramValues: Record<string, string>,
  onEvent: (e: RunEvent) => void,
): RunHandle {
  let cancelled = false;
  let cancelledEmitted = false;
  // Bun.spawn's return type (Subprocess) isn't imported by name; infer it.
  let currentProc: ReturnType<typeof Bun.spawn> | null = null;

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

        const proc = Bun.spawn({
          cmd,
          env: { ...process.env, ...extraEnv },
          cwd: step.workingDir || process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
        currentProc = proc;

        let stdoutAccum = "";
        const pumpStdout = async (): Promise<void> => {
          const stream = proc.stdout as ReadableStream<Uint8Array> | number | undefined;
          if (!stream || typeof stream === "number") return;
          const decoder = new TextDecoder();
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              if (chunk.length === 0) continue;
              stdoutAccum += chunk;
              onEvent({ type: "agent-output", stepIndex, chunk });
            }
          } finally {
            reader.releaseLock();
          }
        };

        const pumpStderr = async (): Promise<void> => {
          const stream = proc.stderr as ReadableStream<Uint8Array> | number | undefined;
          if (!stream || typeof stream === "number") return;
          const decoder = new TextDecoder();
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value, { stream: true });
              if (chunk.length === 0) continue;
              onEvent({ type: "agent-output", stepIndex, chunk });
            }
          } finally {
            reader.releaseLock();
          }
        };

        await Promise.all([pumpStdout(), pumpStderr()]);
        const exitCode = await proc.exited;
        currentProc = null;

        onEvent({ type: "step-output-complete", stepIndex, exitCode });

        if (cancelled) {
          emitCancelledIfNeeded();
          return;
        }

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
              output: stdoutAccum,
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

        stepOutputs[step.name] = stdoutAccum;
        onEvent({ type: "step-complete", stepIndex, output: stdoutAccum });
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
      if (currentProc) {
        try {
          currentProc.kill();
        } catch {
          // Process may have already exited; nothing to do.
        }
      }
    },
  };
}
