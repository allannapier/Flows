// In-memory registry of in-progress (and just-finished) runs, kept alive
// independently of any UI screen. RunScreen used to own a run's state
// directly (via its own `runFlow()` call and local React state); leaving
// that screen unmounted the terminal and — because its cleanup cancelled
// the run — killed the agent process too, with no way back in. Runs are
// started here instead, so navigating away just stops *watching*; the run
// keeps going, and any screen can re-attach to it by id via getActiveRun.
//
// Finished runs are written to disk via runStore (see saveRun below) so
// they show up in run history even after this in-memory entry is later
// pruned or the app restarts. Only in-memory: the live PTY/agent handle and
// the raw terminal feed log — those can't survive a restart regardless.

import type { Flow, RunEvent, RunHandle, RunOptions, RunRecord, RunStatus, RunStepRecord } from "../types";
import { runFlow } from "./engine";
import { saveRun } from "./runStore";

// ANSI 256-color 114 is a muted spring-green, matching the UI's accent
// family without competing with the agent's own colored output.
function stepSeparator(stepIndex: number, stepName: string): string {
  return `\r\n\x1b[2;38;5;114m── step ${stepIndex + 1}: ${stepName} ──\x1b[0m\r\n`;
}

export type StepUiStatus = "pending" | "running" | "validating" | "retrying" | "needs-input" | "done" | "failed";

export interface RunStatusMessage {
  text: string;
  kind: "secondary" | "success" | "warning" | "error";
}

export interface ActiveRun {
  id: string;
  flowId: string;
  flow: Flow;
  params: Record<string, string>;
  handle: RunHandle;
  status: RunStatus;
  stepStatuses: StepUiStatus[];
  attempts: number[];
  statusMessage: RunStatusMessage | null;
  /** Set while a step is paused on "step-needs-input"; cleared as soon as
   * the run moves past that pause (retry, completion, or failure). */
  pendingQuestion: { stepIndex: number; question: string } | null;
  finalError: string | null;
  /** Raw chunks fed to the agent's PTY output, in order — replayed into a
   * freshly-mounted terminal when a screen (re)attaches to this run. */
  feedLog: string[];
  startedAt: string;
  finishedAt?: string;
}

// Caps how much raw terminal output a single run holds in memory; long-running
// steps with heavy output get their oldest chunks dropped rather than growing
// unbounded for the life of the process.
const MAX_FEED_CHUNKS = 20000;

type Listener = () => void;

const active = new Map<string, ActiveRun>();
const listeners = new Map<string, Set<Listener>>();

function notify(runId: string): void {
  for (const l of listeners.get(runId) ?? []) l();
}

/** Subscribe to updates for a specific run. Returns an unsubscribe function. */
export function subscribeRun(runId: string, listener: Listener): () => void {
  if (!listeners.has(runId)) listeners.set(runId, new Set());
  listeners.get(runId)!.add(listener);
  return () => {
    listeners.get(runId)?.delete(listener);
  };
}

export function getActiveRun(runId: string): ActiveRun | undefined {
  return active.get(runId);
}

/** The run currently in progress for a flow, if any — used to offer
 * "resume" instead of starting a second concurrent run from the flow list. */
export function getInProgressRunForFlow(flowId: string): ActiveRun | undefined {
  for (const run of active.values()) {
    if (run.flowId === flowId && run.status === "running") return run;
  }
  return undefined;
}

export function startRun(flow: Flow, params: Record<string, string>, options?: RunOptions): string {
  const id = crypto.randomUUID();
  const stepRecords: RunStepRecord[] = flow.steps.map((s) => ({
    stepId: s.id,
    stepName: s.name,
    status: "pending",
    attempts: 0,
  }));

  const run: ActiveRun = {
    id,
    flowId: flow.id,
    flow,
    params,
    // runFlow (below) needs `run` to exist first so its event callback can
    // close over it — set for real immediately after.
    handle: undefined as unknown as RunHandle,
    status: "running",
    stepStatuses: flow.steps.map(() => "pending"),
    attempts: flow.steps.map(() => 1),
    statusMessage: null,
    pendingQuestion: null,
    finalError: null,
    feedLog: [],
    startedAt: new Date().toISOString(),
  };

  function persist(status: RunStatus, error?: string) {
    run.status = status;
    run.finalError = error ?? null;
    if (status !== "running") run.finishedAt = new Date().toISOString();
    const record: RunRecord = {
      id,
      flowId: flow.id,
      flowName: flow.name,
      params,
      status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      error,
      steps: stepRecords,
    };
    try {
      saveRun(record);
    } catch {
      // Best-effort — an in-memory run is still usable even if the disk
      // write fails (e.g. a read-only FLOWS_HOME).
    }
  }

  const handle = runFlow(
    flow,
    params,
    (e: RunEvent) => {
      switch (e.type) {
        case "step-start":
          run.stepStatuses[e.stepIndex] = "running";
          run.attempts[e.stepIndex] = e.attempt;
          run.pendingQuestion = null;
          if (e.attempt === 1) {
            run.feedLog.push(stepSeparator(e.stepIndex, e.stepName));
          }
          break;
        case "agent-output":
          run.feedLog.push(e.chunk);
          if (run.feedLog.length > MAX_FEED_CHUNKS) {
            run.feedLog.splice(0, run.feedLog.length - MAX_FEED_CHUNKS);
          }
          break;
        case "validation-start":
          run.stepStatuses[e.stepIndex] = "validating";
          run.statusMessage = { text: "validating output...", kind: "secondary" };
          break;
        case "validation-result":
          run.statusMessage = e.verdict.passed
            ? { text: "validation passed", kind: "success" }
            : { text: `validation failed: ${e.verdict.feedback}`, kind: "error" };
          break;
        case "step-retry":
          run.stepStatuses[e.stepIndex] = "retrying";
          run.pendingQuestion = null;
          run.statusMessage = { text: `retrying (attempt ${e.attempt}): ${e.feedback}`, kind: "warning" };
          break;
        case "step-needs-input":
          run.stepStatuses[e.stepIndex] = "needs-input";
          run.pendingQuestion = { stepIndex: e.stepIndex, question: e.question };
          run.statusMessage = { text: "agent is waiting on a question — answer below", kind: "warning" };
          break;
        case "step-complete": {
          run.stepStatuses[e.stepIndex] = "done";
          run.pendingQuestion = null;
          const rec = stepRecords[e.stepIndex];
          if (rec) {
            rec.status = "done";
            rec.attempts = run.attempts[e.stepIndex] ?? 1;
            rec.output = e.output;
          }
          break;
        }
        case "step-failed": {
          run.stepStatuses[e.stepIndex] = "failed";
          run.pendingQuestion = null;
          run.statusMessage = { text: `step ${e.stepIndex + 1} failed: ${e.error}`, kind: "error" };
          const rec = stepRecords[e.stepIndex];
          if (rec) {
            rec.status = "failed";
            rec.attempts = run.attempts[e.stepIndex] ?? 1;
            rec.error = e.error;
          }
          break;
        }
        case "session-note":
          run.statusMessage = { text: e.note, kind: "warning" };
          run.feedLog.push(`\r\n\x1b[2m[note] ${e.note}\x1b[0m\r\n`);
          break;
        case "flow-complete":
          persist("complete");
          break;
        case "flow-failed":
          persist(e.error === "Cancelled by user" ? "cancelled" : "failed", e.error);
          break;
      }
      notify(id);
    },
    options,
  );

  run.handle = handle;
  active.set(id, run);
  // Persist immediately (status "running") so this run shows up in history
  // right away rather than only once it finishes.
  persist("running");
  return id;
}

export function cancelRun(runId: string): void {
  active.get(runId)?.handle.cancel();
}

/** Answers a run's pending "needs-input" pause, if any (no-op otherwise). */
export function answerRun(runId: string, text: string): void {
  active.get(runId)?.handle.answerInput(text);
}
