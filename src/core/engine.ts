// Flow execution engine: runs a Flow's steps in order.
//
// Two execution paths:
//  - Interactive agents (claude, opencode, codex, gemini): run as a real
//    interactive TUI session (InteractiveAgentSession, see interactive.ts)
//    that stays alive across the step's turns (retries, follow-up answers)
//    and, when continueSession is set, across steps. Turn completion is
//    detected via a hook/notify payload file (claude/opencode/codex) or PTY
//    quiescence (gemini) rather than process exit, so the agent can ask the
//    user questions and get answers without the process ever exiting.
//  - custom commands: spawn a one-shot process per attempt inside a PTY
//    (AgentSession) and await exit, exactly as before — there's no CLI-level
//    interactivity contract Flows can drive for an arbitrary shell command.
//
// Both paths share: prompt templating, LLM validation, and retry/attempt
// bookkeeping.

import type { AgentId, Flow, RunEvent, RunHandle, RunOptions, ValidationVerdict } from "../types";
import { AGENTS, agentSupportsContinuation, buildAgentCommand } from "./agents";
import { AgentSession } from "./session";
import {
  agentSupportsInteractive,
  cleanOutput,
  cleanupRunScratch,
  createInteractiveSession,
  prepareAgentScratch,
  type AgentScratch,
  type InteractiveAgentSession,
  type TurnResult,
} from "./interactive";
import { renderTemplate } from "./template";
import { validateOutput } from "./validator";

const RETRY_CONTEXT_TEMPLATE = (feedback: string) =>
  `\n\n--- RETRY CONTEXT ---\n` +
  `A previous attempt did not satisfy the expected result.\n` +
  `Validator feedback: ${feedback}\n` +
  `Please address the feedback and try again.`;

const TURN_JOIN = "\n\n---\n\n";

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

/** Resolves once `signal` aborts; never resolves otherwise. Used to let the
 * awaiting-input gate loop wait on an explicit continueFlow() call without a
 * live session to poll (e.g. the session already crashed). */
function waitForAbort(signal: AbortSignal): Promise<TurnResult> {
  const finish = (resolve: (r: TurnResult) => void) => resolve({ aborted: true, output: "", sessionEnded: false });
  return new Promise((resolve) => {
    if (signal.aborted) {
      finish(resolve);
      return;
    }
    signal.addEventListener("abort", () => finish(resolve), { once: true });
  });
}

function gateMessage(verdict: ValidationVerdict | undefined, pauseForReview: boolean): string {
  if (verdict?.needsUserInput && verdict.questionsSummary) {
    return `Agent is asking: ${verdict.questionsSummary}`;
  }
  if (verdict?.needsUserInput) {
    return "Agent is asking a question — attach to respond.";
  }
  if (pauseForReview) {
    return "Paused for review — attach to respond, then continue.";
  }
  return "Waiting on you — attach to respond.";
}

export function runFlow(
  flow: Flow,
  paramValues: Record<string, string>,
  onEvent: (e: RunEvent) => void,
  options?: RunOptions,
): RunHandle {
  let cancelled = false;
  let cancelledEmitted = false;
  // The PTY currently backing RunHandle.write/resize — either an exec-path
  // attempt's AgentSession, or the currently-active interactive session's.
  let currentSession: AgentSession | null = null;
  // One live interactive session per agent at a time, keyed by agent id, so
  // a run mixing agents across steps (or coming back to an agent used
  // earlier) can resume the right one when continueSession is set.
  const liveSessions = new Map<AgentId, { session: InteractiveAgentSession; cwd: string }>();
  // The agent whose interactive session was most recently created/continued
  // — used so write()/resize() can still reach a surviving session even
  // when currentSession has gone null (e.g. the flow's last step was a
  // non-interactive exec-path step that ran after an earlier step's
  // interactive session, which is still alive in liveSessions).
  let lastLiveAgent: AgentId | null = null;
  let liveCols = options?.cols ?? DEFAULT_COLS;
  let liveRows = options?.rows ?? DEFAULT_ROWS;

  /** The PTY write()/resize() should target right now: whatever's actively
   * driving the current step if any, else the most recently touched live
   * interactive session (covers both "between steps" and "flow finished,
   * an earlier step's session is still alive for attach" cases). */
  function resolveActiveSession(): AgentSession | null {
    if (currentSession) return currentSession;
    if (lastLiveAgent) {
      const live = liveSessions.get(lastLiveAgent);
      if (live) return live.session.session;
    }
    return null;
  }

  // Which stepIndex agent-output chunks from the currently-active
  // interactive session should be attributed to — updated whenever an
  // interactive step starts, including when it's really just a new turn
  // sent into a still-live session left over from an earlier step
  // (continueSession).
  let activeOutputStepIndex = 0;

  // Set while an awaiting-input gate is open; continueFlow() aborts this to
  // signal "leave the gate now".
  let gateAbort: AbortController | null = null;
  // Set whenever the engine is waiting on a turn (gate or not); cancel()
  // aborts this so a poll loop doesn't have to wait for the (already killed)
  // process to exit.
  let waitAbort: AbortController | null = null;

  const scratchByAgent = new Map<AgentId, AgentScratch>();
  const scratchId = crypto.randomUUID();
  let scratchUsed = false;
  let scratchClosed = false;
  // Whether any interactive session is currently alive for this run — kept
  // in sync via syncSessionLiveSignal() and surfaced to the UI both as a
  // synchronous RunHandle.hasLiveSession() query and as "session-live-changed"
  // events (so runManager can mirror it onto ActiveRun without polling).
  let sessionIsLive = false;

  function ensureAgentScratch(agent: AgentId): AgentScratch {
    scratchUsed = true;
    let scratch = scratchByAgent.get(agent);
    if (!scratch) {
      scratch = prepareAgentScratch(scratchId, agent);
      scratchByAgent.set(agent, scratch);
    }
    return scratch;
  }

  function syncSessionLiveSignal(): void {
    const nowLive = liveSessions.size > 0;
    if (nowLive !== sessionIsLive) {
      sessionIsLive = nowLive;
      onEvent({ type: "session-live-changed", live: nowLive });
    }
  }

  function killLiveSession(agent: AgentId): void {
    const live = liveSessions.get(agent);
    if (live) {
      live.session.kill();
      liveSessions.delete(agent);
      if (currentSession === live.session.session) currentSession = null;
      syncSessionLiveSignal();
    }
  }

  function killAllLiveSessions(): void {
    for (const agent of [...liveSessions.keys()]) killLiveSession(agent);
  }

  /** Cleans up the run's scratch dir once every live session is gone —
   * idempotent, and a no-op while sessions remain (called again once they
   * finish). Session liveness is purely in-memory; this never touches the
   * persisted RunRecord. */
  function finalizeScratchIfAllSessionsGone(): void {
    if (scratchClosed || liveSessions.size > 0) return;
    scratchClosed = true;
    if (scratchUsed) cleanupRunScratch(scratchId);
  }

  /** Explicit "close the session(s)" action: kills every live interactive
   * session for this run and cleans up its scratch dir. Safe to call
   * multiple times (e.g. once from cancel()'s teardown, once from a UI
   * "close session" action) or when nothing is alive. Does not touch
   * `cancelled`/RunRecord status — those are independent of session
   * liveness. */
  function performCloseSession(): void {
    killAllLiveSessions();
    finalizeScratchIfAllSessionsGone();
  }

  /** Called once the flow finishes normally (success or failure, i.e. NOT
   * cancelled) with a live session still attached: rather than killing it
   * (the old behavior), leave it running for the user to keep chatting
   * with via attach, and just watch for it to end on its own (crash, or
   * the user typing /exit) so the scratch dir still gets cleaned up
   * eventually without an explicit close. The set of sessions live at this
   * moment is final — runSteps() has already returned, so nothing will add
   * more. */
  function watchForNaturalSessionEnd(): void {
    for (const [agent, live] of [...liveSessions.entries()]) {
      live.session.session.exited.then(() => {
        if (liveSessions.get(agent) !== live) return; // already replaced or explicitly closed
        liveSessions.delete(agent);
        if (currentSession === live.session.session) currentSession = null;
        syncSessionLiveSignal();
        finalizeScratchIfAllSessionsGone();
      });
    }
  }

  function emitCancelledIfNeeded(): boolean {
    if (cancelled && !cancelledEmitted) {
      cancelledEmitted = true;
      onEvent({ type: "flow-failed", error: "Cancelled by user" });
    }
    return cancelled;
  }

  async function execute(): Promise<void> {
    try {
      await runSteps();
    } finally {
      // Cancellation is a full teardown (kill everything, clean up scratch
      // immediately); a normal finish (success or failure) leaves any live
      // session running for the user, per the interactive-session-outlives-
      // the-flow requirement — only an explicit close (or the session
      // ending on its own) tears it down from here on.
      if (cancelled) {
        performCloseSession();
      } else {
        watchForNaturalSessionEnd();
      }
    }
  }

  async function runSteps(): Promise<void> {
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
    // fresh even when continueSession=true. Only used by the exec path —
    // interactive agents use liveSessions instead.
    const sessionStarted = new Set<string>();

    for (let stepIndex = 0; stepIndex < flow.steps.length; stepIndex++) {
      if (cancelled) {
        emitCancelledIfNeeded();
        return;
      }

      const step = flow.steps[stepIndex];
      const resolvedCwd = step.workingDir || process.cwd();
      const sessionKey = `${step.agent}::${resolvedCwd}`;
      const interactive = agentSupportsInteractive(step.agent);

      if (step.continueSession && !interactive && !agentSupportsContinuation(step.agent)) {
        const agentLabel = AGENTS.find((a) => a.id === step.agent)?.label ?? step.agent;
        onEvent({
          type: "session-note",
          stepIndex,
          note: `${agentLabel} does not support session continuation — running fresh`,
        });
      }

      let basePrompt: string;
      try {
        basePrompt = renderTemplate(step.prompt, params, stepOutputs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onEvent({ type: "step-failed", stepIndex, error: message });
        onEvent({ type: "flow-failed", error: message });
        return;
      }

      if (interactive) {
        const outcome = await runInteractiveStep({ step, stepIndex, basePrompt, resolvedCwd, stepOutputs });
        if (outcome !== "success") return;
        continue;
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

  /** Spawns a fresh interactive session for `step.agent`, replacing (and
   * killing) any previous live session for that same agent. */
  function startFreshInteractiveSession(
    step: Flow["steps"][number],
    stepIndex: number,
    prompt: string,
    resolvedCwd: string,
  ): InteractiveAgentSession {
    killLiveSession(step.agent);
    const scratch = ensureAgentScratch(step.agent);
    const session = createInteractiveSession(step.agent, {
      prompt,
      cwd: resolvedCwd,
      cols: liveCols,
      rows: liveRows,
      scratch,
      onData: (chunk) => onEvent({ type: "agent-output", stepIndex: activeOutputStepIndex, chunk }),
    });
    liveSessions.set(step.agent, { session, cwd: resolvedCwd });
    currentSession = session.session;
    lastLiveAgent = step.agent;
    syncSessionLiveSignal();
    return session;
  }

  /** Runs a single interactive-agent step end-to-end: fresh session or
   * continued live turn, validation/retry as typed turns (no respawning),
   * and the awaiting-input gate. Identical semantics across claude,
   * opencode, codex, and gemini — the only agent-specific behavior lives in
   * interactive.ts's per-agent adapters. Returns "success" once the step's
   * output should be recorded and the outer loop should move on, or
   * "failed"/"cancelled" once the corresponding terminal events have
   * already been emitted. */
  async function runInteractiveStep(args: {
    step: Flow["steps"][number];
    stepIndex: number;
    basePrompt: string;
    resolvedCwd: string;
    stepOutputs: Record<string, string>;
  }): Promise<"success" | "failed" | "cancelled"> {
    const { step, stepIndex, basePrompt, resolvedCwd, stepOutputs } = args;
    const turns: string[] = [];
    const maxAttempts = 1 + Math.max(0, step.maxRetries);
    let attempt = 1;

    activeOutputStepIndex = stepIndex;

    const existingLive = liveSessions.get(step.agent);
    const canContinueLive = step.continueSession === true && existingLive !== undefined && existingLive.cwd === resolvedCwd;

    onEvent({ type: "step-start", stepIndex, stepName: step.name, agent: step.agent, attempt });

    let live: InteractiveAgentSession;
    if (canContinueLive) {
      live = existingLive!.session;
      currentSession = live.session;
      lastLiveAgent = step.agent;
      await live.sendTurn(basePrompt);
    } else {
      live = startFreshInteractiveSession(step, stepIndex, basePrompt, resolvedCwd);
    }

    if (cancelled) {
      emitCancelledIfNeeded();
      return "cancelled";
    }

    function currentLive(): InteractiveAgentSession | undefined {
      return liveSessions.get(step.agent)?.session;
    }

    // --- Turn loop: initial turn + validation retries (typed, not respawned). ---
    while (true) {
      const abort = new AbortController();
      waitAbort = abort;
      const active = currentLive();
      const result = active ? await active.awaitTurn(abort.signal) : await waitForAbort(abort.signal);
      waitAbort = null;

      if (cancelled) {
        emitCancelledIfNeeded();
        return "cancelled";
      }
      if (result.aborted) {
        // Shouldn't happen outside cancellation in this loop; treat
        // defensively as "keep waiting" rather than losing the turn.
        continue;
      }
      if (result.sessionEnded) {
        onEvent({
          type: "session-note",
          stepIndex,
          note: `Interactive ${step.agent} session ended (exit or crash) mid-step.`,
        });
        liveSessions.delete(step.agent);
        currentSession = null;
        syncSessionLiveSignal();
      }

      turns.push(result.output);
      const stepText = turns.join(TURN_JOIN);
      onEvent({ type: "step-output-complete", stepIndex, exitCode: result.sessionEnded ? (result.exitCode ?? 1) : 0 });

      let verdict: ValidationVerdict | undefined;
      if (step.validate) {
        onEvent({ type: "validation-start", stepIndex });
        try {
          verdict = await validateOutput({ stepPrompt: basePrompt, expectedResult: step.expectedResult, output: stepText });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          onEvent({ type: "step-failed", stepIndex, error: message });
          onEvent({ type: "flow-failed", error: message });
          return "failed";
        }

        if (cancelled) {
          emitCancelledIfNeeded();
          return "cancelled";
        }

        onEvent({ type: "validation-result", stepIndex, verdict });

        if (!verdict.passed) {
          if (attempt < maxAttempts) {
            onEvent({ type: "step-retry", stepIndex, attempt: attempt + 1, feedback: verdict.feedback });
            attempt++;
            const liveNow = currentLive();
            if (liveNow) {
              await liveNow.sendTurn(RETRY_CONTEXT_TEMPLATE(verdict.feedback));
            } else {
              startFreshInteractiveSession(step, stepIndex, basePrompt + RETRY_CONTEXT_TEMPLATE(verdict.feedback), resolvedCwd);
            }
            onEvent({ type: "step-start", stepIndex, stepName: step.name, agent: step.agent, attempt });
            continue;
          }
          onEvent({ type: "step-failed", stepIndex, error: verdict.feedback });
          onEvent({ type: "flow-failed", error: verdict.feedback });
          return "failed";
        }
      }

      const needsGate = verdict?.needsUserInput === true || step.pauseForReview === true;
      if (!needsGate) {
        stepOutputs[step.name] = stepText;
        onEvent({ type: "step-complete", stepIndex, output: stepText });
        return "success";
      }

      // --- Awaiting-input gate. ---
      onEvent({ type: "step-awaiting-input", stepIndex, stepName: step.name, message: gateMessage(verdict, step.pauseForReview === true) });

      while (true) {
        const gAbort = new AbortController();
        gateAbort = gAbort;
        waitAbort = gAbort;

        const gLive = currentLive();
        const gResult = gLive ? await gLive.awaitTurn(gAbort.signal) : await waitForAbort(gAbort.signal);

        const leftViaContinue = gateAbort === null; // continueFlow() clears gateAbort before aborting
        gateAbort = null;
        waitAbort = null;

        if (cancelled) {
          emitCancelledIfNeeded();
          return "cancelled";
        }

        if (gResult.aborted) {
          if (leftViaContinue) {
            // continueFlow() can race a turn that finished in the same
            // instant (its payload landed on disk, or the PTY just went
            // quiet, just before the next poll tick would have picked it
            // up) — do one last synchronous check so that turn isn't
            // silently dropped from the output.
            const pending = currentLive()?.checkPendingTurn();
            if (pending) turns.push(pending.output);
            break; // leave the gate loop -> step completes below
          }
          continue; // spurious abort; keep waiting
        }

        if (gResult.sessionEnded) {
          onEvent({
            type: "session-note",
            stepIndex,
            note: `Interactive ${step.agent} session ended — attach can no longer accept replies; call continue to proceed.`,
          });
          liveSessions.delete(step.agent);
          currentSession = null;
          syncSessionLiveSignal();
        }

        turns.push(gResult.output);
        const gatedText = turns.join(TURN_JOIN);

        if (step.validate) {
          let gVerdict: ValidationVerdict;
          try {
            gVerdict = await validateOutput({ stepPrompt: basePrompt, expectedResult: step.expectedResult, output: gatedText });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            onEvent({ type: "step-failed", stepIndex, error: message });
            onEvent({ type: "flow-failed", error: message });
            return "failed";
          }

          if (cancelled) {
            emitCancelledIfNeeded();
            return "cancelled";
          }

          onEvent({ type: "validation-result", stepIndex, verdict: gVerdict });

          if (gVerdict.passed && !gVerdict.needsUserInput) {
            verdict = gVerdict;
            break; // leave the gate loop -> step completes below
          }
          onEvent({
            type: "step-awaiting-input",
            stepIndex,
            stepName: step.name,
            message: gateMessage(gVerdict, step.pauseForReview === true),
          });
          continue;
        }
        // validate off: pauseForReview-only gate — stays open regardless of
        // what was typed; only continueFlow() (or cancel) leaves it.
      }

      const finalText = turns.join(TURN_JOIN);
      stepOutputs[step.name] = finalText;
      onEvent({ type: "step-complete", stepIndex, output: finalText });
      return "success";
    }
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
      waitAbort?.abort();
    },
    resize(cols: number, rows: number): void {
      liveCols = Math.max(2, cols);
      liveRows = Math.max(2, rows);
      const target = resolveActiveSession();
      if (target) {
        target.resize(liveCols, liveRows);
      }
    },
    write(data: string): void {
      const target = resolveActiveSession();
      if (target) {
        target.write(data);
      }
    },
    continueFlow(): void {
      if (!gateAbort) return;
      const abort = gateAbort;
      gateAbort = null;
      abort.abort();
    },
    hasLiveSession(): boolean {
      return liveSessions.size > 0;
    },
    closeSession(): void {
      performCloseSession();
    },
  };
}
