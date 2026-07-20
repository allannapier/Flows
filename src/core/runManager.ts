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
import { saveRun, sweepStaleRuns } from "./runStore";

// ANSI 256-color 114 is a muted spring-green, matching the UI's accent
// family without competing with the agent's own colored output.
function stepSeparator(stepIndex: number, stepName: string): string {
  return `\r\n\x1b[2;38;5;114m── step ${stepIndex + 1}: ${stepName} ──\x1b[0m\r\n`;
}

export type StepUiStatus = "pending" | "running" | "validating" | "retrying" | "done" | "failed";

export interface RunStatusMessage {
  text: string;
  kind: "secondary" | "success" | "warning" | "error";
}

export interface PendingAlert {
  stepIndex: number;
  stepName: string;
  error: string;
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
  /** How many times each step has been entered by the engine (increments
   * on each fresh `step-start` for that index, i.e. `attempt === 1`).
   * Greater than 1 means the step was re-executed by a routing jump. */
  executions: number[];
  statusMessage: RunStatusMessage | null;
  finalError: string | null;
  /** Set while a step's `alertOnFailure` gate is open — the run is paused
   * waiting for the UI to call acknowledgeAlert(). Cleared once
   * acknowledged (or, defensively, whenever the run moves on to another
   * event that implies the gate is no longer relevant). */
  pendingAlert: PendingAlert | null;
  /** Raw chunks fed to the agent's PTY output, in order — replayed into a
   * freshly-mounted terminal when a screen (re)attaches to this run. */
  feedLog: string[];
  startedAt: string;
  finishedAt?: string;
  /** Mirrors RunHandle.hasLiveSession() — kept current via the
   * "session-live-changed" event rather than polled. An interactive step's
   * session is no longer killed when the flow finishes, so this can stay
   * true well after status is "complete"/"failed", letting the UI offer
   * "attach" / "close session" on a finished run. Purely in-memory; never
   * reflected in the persisted RunRecord. */
  hasLiveSession: boolean;
}

// Caps how much raw terminal output a single run holds in memory; long-running
// steps with heavy output get their oldest chunks dropped rather than growing
// unbounded for the life of the process.
const MAX_FEED_CHUNKS = 20000;

type Listener = () => void;

const active = new Map<string, ActiveRun>();
const listeners = new Map<string, Set<Listener>>();

// Runs left "running"/"awaiting-input" on disk from a previous process (app
// exited or crashed mid-flow) have nothing left to ever finish them —
// rewrite them to "interrupted" once, at module load (i.e. app startup,
// before any run has been started so `active` is still empty).
sweepStaleRuns((runId) => active.has(runId));

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
    if (run.flowId === flowId && (run.status === "running" || run.status === "awaiting-input")) return run;
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
    executions: flow.steps.map(() => 0),
    statusMessage: null,
    finalError: null,
    pendingAlert: null,
    feedLog: [],
    startedAt: new Date().toISOString(),
    hasLiveSession: false,
  };

  function persist(status: RunStatus, error?: string) {
    run.status = status;
    run.finalError = error ?? null;
    if (status === "complete" || status === "failed" || status === "cancelled") {
      run.finishedAt = new Date().toISOString();
    }
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
          run.status = "running";
          run.stepStatuses[e.stepIndex] = "running";
          run.attempts[e.stepIndex] = e.attempt;
          if (e.attempt === 1) {
            run.feedLog.push(stepSeparator(e.stepIndex, e.stepName));
            run.executions[e.stepIndex] = (run.executions[e.stepIndex] ?? 0) + 1;
            const rec = stepRecords[e.stepIndex];
            if (rec) rec.executions = run.executions[e.stepIndex];
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
          run.statusMessage = { text: `retrying (attempt ${e.attempt}): ${e.feedback}`, kind: "warning" };
          break;
        case "step-timeout":
          run.statusMessage = { text: `step ${e.stepIndex + 1} timed out after ${e.minutes}m`, kind: "warning" };
          run.feedLog.push(`\r\n\x1b[2m[timeout] step timed out after ${e.minutes}m\x1b[0m\r\n`);
          break;
        case "step-awaiting-input":
          run.status = "awaiting-input";
          run.statusMessage = { text: e.message, kind: "warning" };
          run.feedLog.push(`\r\n\x1b[2m[awaiting-input] ${e.message}\x1b[0m\r\n`);
          break;
        case "step-complete": {
          run.status = "running";
          run.stepStatuses[e.stepIndex] = "done";
          const rec = stepRecords[e.stepIndex];
          if (rec) {
            rec.status = "done";
            rec.attempts = run.attempts[e.stepIndex] ?? 1;
            rec.output = e.output;
            rec.stats = e.stats;
          }
          break;
        }
        case "step-failed": {
          run.stepStatuses[e.stepIndex] = "failed";
          run.statusMessage = { text: `step ${e.stepIndex + 1} failed: ${e.error}`, kind: "error" };
          const rec = stepRecords[e.stepIndex];
          if (rec) {
            rec.status = "failed";
            rec.attempts = run.attempts[e.stepIndex] ?? 1;
            rec.error = e.error;
            rec.stats = e.stats;
          }
          break;
        }
        case "step-alert":
          run.pendingAlert = { stepIndex: e.stepIndex, stepName: e.stepName, error: e.error };
          run.feedLog.push(`\r\n\x1b[2m[alert] ${e.stepName} failed: ${e.error}\x1b[0m\r\n`);
          break;
        case "session-note":
          run.statusMessage = { text: e.note, kind: "warning" };
          run.feedLog.push(`\r\n\x1b[2m[note] ${e.note}\x1b[0m\r\n`);
          break;
        case "step-jump": {
          const fromName = flow.steps[e.fromIndex]?.name ?? `step ${e.fromIndex + 1}`;
          const toName = flow.steps[e.toIndex]?.name ?? `step ${e.toIndex + 1}`;
          const reasonLabel = e.reason === "success" ? "on success" : "on failure";
          const msg = `jumped ${reasonLabel}: ${fromName} → ${toName}`;
          run.statusMessage = { text: msg, kind: e.reason === "failure" ? "warning" : "secondary" };
          run.feedLog.push(`\r\n\x1b[2;38;5;114m↪ ${msg}\x1b[0m\r\n`);
          // The target step is about to (re-)execute — reset its UI status
          // so the steps pane doesn't keep showing a stale ✓/✗ for it.
          run.stepStatuses[e.toIndex] = "pending";
          run.pendingAlert = null;
          break;
        }
        case "session-live-changed":
          run.hasLiveSession = e.live;
          break;
        case "flow-complete":
          run.pendingAlert = null;
          persist("complete");
          break;
        case "flow-failed":
          run.pendingAlert = null;
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

/** Leaves a run's "awaiting-input" gate immediately (no-op if it isn't
 * currently gated) — the explicit "proceed now" action from the UI. */
export function continueRun(runId: string): void {
  active.get(runId)?.handle.continueFlow();
}

/** Dismisses a run's open step-alert gate (no-op if it isn't currently
 * gated) — the explicit "Dismiss" action from the UI's blocking alert
 * overlay. Clears the run's pendingAlert immediately rather than waiting
 * for a follow-up event, so the overlay closes right away. */
export function acknowledgeAlert(runId: string): void {
  const run = active.get(runId);
  if (!run) return;
  run.pendingAlert = null;
  run.handle.acknowledgeAlert();
  notify(runId);
}

/** Kills any live interactive session for a run and cleans up its scratch
 * dir — the explicit "close session" action from the UI, typically offered
 * once a run has finished but its last interactive session is still alive
 * for attach. Safe to call when nothing is alive, or more than once. Does
 * not change the run's persisted status. */
export function closeRun(runId: string): void {
  active.get(runId)?.handle.closeSession();
}
