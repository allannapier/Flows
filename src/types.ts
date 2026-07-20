// Shared contract between the core engine (src/core) and the TUI (src/ui).
// Both sides code against these types; do not change signatures without
// updating both sides.

export type AgentId = "claude" | "opencode" | "codex" | "gemini" | "custom";

export interface AgentDefinition {
  id: AgentId;
  label: string;
  /** Binary the built-in agent needs on PATH (undefined for custom). */
  binary?: string;
}

export interface FlowParameter {
  name: string;
  description: string;
  required: boolean;
  default?: string;
  /**
   * When set (non-empty), this parameter is a single-select from this fixed
   * list rather than free text — both when authoring the flow and when
   * supplying values to run it. Absent/empty means free text.
   */
  choices?: string[];
}

export interface StepRouting {
  /** 0-based index of the step to jump to when this step passes validation.
   *  If absent, continue to the next sequential step (current behaviour). */
  onSuccess?: number;
  /** 0-based index of the step to jump to when this step fails validation
   *  and has exhausted retries.
   *  If absent, the flow fails as today. */
  onFailure?: number;
  /**
   * Maximum number of times a backward jump (onFailure pointing to an
   * earlier step) is allowed before the flow gives up and treats it as a
   * hard failure.  Defaults to 3. */
  maxJumps?: number;
}

export interface FlowStep {
  id: string;
  name: string;
  agent: AgentId;
  /**
   * Only for agent === "custom": a shell command that receives the rendered
   * prompt in the FLOW_PROMPT environment variable, e.g. `mytool run "$FLOW_PROMPT"`.
   */
  customCommand?: string;
  /**
   * Prompt template. Supports {{params.<name>}} and {{steps.<stepName>.output}}
   * placeholders (stepName = the `name` of an earlier step).
   */
  prompt: string;
  /** Natural-language description of the desired result; used by the validator. */
  expectedResult: string;
  /** Whether to run LLM validation on the agent output before proceeding. */
  validate: boolean;
  /** Retries after a failed validation (0 = no retries). */
  maxRetries: number;
  /**
   * Working directory for the agent process. Supports {{params.<name>}}
   * placeholders (not {{steps.*.output}} — step outputs are multi-line
   * agent text and must never become a path). Overrides the flow-level
   * `Flow.workingDir` when set; falls back to it, then process.cwd(), when
   * absent.
   */
  workingDir?: string;
  /**
   * Continue the same agent conversation as the previous step in this run
   * that used the same agent + working directory (fresh session if none yet).
   * Supported: claude, opencode, codex, custom (via $FLOW_CONTINUE). Ignored
   * for agents without non-interactive resume (gemini).
   */
  continueSession?: boolean;
  /**
   * Pause after this step succeeds so the user can read the agent's output
   * and, if it asked questions, reply before the flow continues. Same
   * pause also triggers automatically when validation detects the agent is
   * waiting on the user (see ValidationVerdict.needsUserInput) — this flag
   * is for forcing it unconditionally. Requires an agent that supports
   * session continuation to actually let the user reply; otherwise the
   * flow just proceeds with a note.
   */
  pauseForReview?: boolean;
  /**
   * Optional conditional next-step routing. When absent, the step behaves
   * as before: on success proceed to the next sequential step; on failure
   * (retries exhausted) fail the whole flow.
   */
  routing?: StepRouting;
  /**
   * When true, a failure of this step (validation fails and retries are
   * exhausted) pauses the run and shows a blocking alert to the user
   * instead of silently proceeding straight to the flow-failed outcome
   * (or a routing jump). The run resumes — and is then marked failed, or
   * routed, as normal — once the user dismisses the alert.
   */
  alertOnFailure?: boolean;
  /**
   * Maximum time, in minutes, a single agent turn/attempt of this step may
   * run before the engine kills it and treats the attempt as a failure —
   * maxRetries, routing.onFailure, and alertOnFailure all apply exactly as
   * they would for a validation failure. Absent or 0 means no timeout
   * (current behaviour). Time spent gated on the user (awaiting-input or an
   * unacknowledged alertOnFailure) never counts toward this — the timer only
   * runs while a turn/process is actually in flight.
   */
  timeoutMinutes?: number;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  parameters: FlowParameter[];
  steps: FlowStep[];
  /**
   * Default working directory for every step that doesn't set its own
   * `workingDir`. Supports {{params.<name>}} placeholders (not
   * {{steps.*.output}}) so the same flow can target a different checkout
   * per run. Falls back to process.cwd() when absent.
   */
  workingDir?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Engine events (core -> UI)
// ---------------------------------------------------------------------------

export interface ValidationVerdict {
  passed: boolean;
  feedback: string;
  /** True when the agent's output explicitly asks the user questions or
   * requests a decision before proceeding. Independent of `passed` — a step
   * can pass validation and still need user input (e.g. a planning step
   * that finished its plan but is asking which option to pick). */
  needsUserInput?: boolean;
  /** One-line summary of what's being asked, present only when
   * needsUserInput is true. */
  questionsSummary?: string;
}

/** Per-execution statistics for a single step, computed by the engine as the
 * step runs and attached to its "step-complete" / "step-failed" event. */
export interface StepStats {
  /** How many agent turns the step took (one per attempt on the exec path,
   * one per completed turn — including retries and awaiting-input turns —
   * on the interactive path). */
  turns: number;
  /** Total tokens (input + output) reported by the validator LLM across all
   * validation calls made for this step execution. 0 when validation is off
   * or no provider usage was reported. */
  tokensUsed: number;
  /** Number of validation failures (failed attempts) before the step
   * completed or gave up. */
  errorCount: number;
  /** Estimated cost in USD, computed from tokensUsed and the validator
   * model's known pricing. undefined when the model's pricing is unknown or
   * no tokens were used. */
  estimatedCostUsd?: number;
}

export type RunEvent =
  | { type: "flow-start"; flowName: string; totalSteps: number }
  | { type: "step-start"; stepIndex: number; stepName: string; agent: AgentId; attempt: number }
  | { type: "agent-output"; stepIndex: number; chunk: string }
  | { type: "step-output-complete"; stepIndex: number; exitCode: number }
  | { type: "validation-start"; stepIndex: number }
  | { type: "validation-result"; stepIndex: number; verdict: ValidationVerdict }
  | { type: "step-retry"; stepIndex: number; attempt: number; feedback: string }
  /** A step's `timeoutMinutes` was exceeded while waiting on an agent
   * turn/process. Emitted just before the engine kills that turn/process and
   * treats the attempt as a failure (see FlowStep.timeoutMinutes) — the
   * "step-retry" or "step-failed" that follows explains the outcome. */
  | { type: "step-timeout"; stepIndex: number; minutes: number }
  | { type: "step-complete"; stepIndex: number; output: string; stats: StepStats }
  | { type: "step-failed"; stepIndex: number; error: string; stats: StepStats }
  | { type: "session-note"; stepIndex: number; note: string }
  /** The engine's step pointer jumped non-sequentially because of a step's
   * `routing` configuration — either forward-skipping on success or
   * looping/branching on failure. Purely informational; the target step's
   * own "step-start" fires immediately after. */
  | { type: "step-jump"; fromIndex: number; toIndex: number; reason: "success" | "failure" }
  /** A step with `alertOnFailure` exhausted its retries. The run pauses
   * (after already emitting "step-failed") until the UI acknowledges via
   * RunHandle.acknowledgeAlert(), at which point the run resumes and is
   * marked failed (or routed to another step) as normal. */
  | { type: "step-alert"; stepIndex: number; stepName: string; error: string }
  /** A claude step's turn finished and the flow is now paused waiting on the
   * user — either the validator detected the agent is asking a question
   * (needsUserInput) or the step has pauseForReview. `message` is a
   * human-readable summary (includes questionsSummary when present). The
   * interactive session stays alive; the user can attach and reply, or the
   * UI can call RunHandle.continueFlow() to proceed immediately. */
  | { type: "step-awaiting-input"; stepIndex: number; stepName: string; message: string }
  | { type: "flow-complete" }
  | { type: "flow-failed"; error: string }
  /** Fires whenever whether this run has a live interactive agent session
   * transitions (0 live sessions <-> at least 1). An interactive step's
   * session is no longer killed automatically when the flow finishes —
   * it survives so the user can keep attaching and chatting with it — so
   * this can fire well after "flow-complete"/"flow-failed", whenever the
   * surviving session ends on its own (crash, /exit) or is explicitly
   * closed via RunHandle.closeSession(). Purely in-memory signal — never
   * reflected in the persisted RunRecord. */
  | { type: "session-live-changed"; live: boolean };

export interface RunHandle {
  /** Resolves when the run finishes (success or failure). Never rejects. */
  done: Promise<void>;
  /** Abort the run (kills the current agent process and any live
   * interactive session, and cleans up the run's scratch dir). */
  cancel(): void;
  /** Resize the PTY of the currently running step (no-op when idle). */
  resize(cols: number, rows: number): void;
  /** Write raw bytes to the PTY of the currently running step (no-op when idle). */
  write(data: string): void;
  /** Leave an "awaiting-input" gate immediately and proceed to the next
   * step, keeping whatever output has accumulated so far for the gated
   * step. No-op when the run isn't currently gated. */
  continueFlow(): void;
  /** Dismisses a currently-open "step-alert" gate (see RunEvent), letting
   * the run resume and proceed to its normal failure/routing handling.
   * No-op when the run isn't currently gated on an alert. */
  acknowledgeAlert(): void;
  /** True if an interactive agent session is currently alive for this run
   * — including after the flow has finished, since a finished flow's last
   * interactive session is kept alive for the user to keep chatting with
   * (see "session-live-changed" for the reactive version). */
  hasLiveSession(): boolean;
  /** Kills any live interactive session for this run and cleans up its
   * scratch dir. Safe to call at any time, including when nothing is
   * alive (no-op) or more than once. Independent of the run's
   * status/RunRecord — closing the session after a flow has already
   * finished does not change its persisted outcome. */
  closeSession(): void;
}

/** Optional terminal size hints for runFlow; defaults to 120x30. */
export interface RunOptions {
  cols?: number;
  rows?: number;
}

// ---------------------------------------------------------------------------
// Run history (persisted record of a finished/in-progress run)
// ---------------------------------------------------------------------------

export type RunStatus =
  | "running"
  | "complete"
  | "failed"
  | "cancelled"
  /** The run is paused, waiting on the user before it can continue (e.g. a
   * step whose agent asked a follow-up question). Set/cleared by the engine
   * around claude steps' interactive turns — see RunEvent's
   * "step-awaiting-input" and RunHandle.continueFlow(). */
  | "awaiting-input"
  /** Flows exited (or crashed) while this run was "running" or
   * "awaiting-input" — rewritten at startup by runStore's stale-run sweep
   * since there's no in-memory run left to finish it. */
  | "interrupted";

export interface RunStepRecord {
  stepId: string;
  stepName: string;
  status: "pending" | "done" | "failed";
  attempts: number;
  /** How many times this step has been (re-)executed by the engine because
   * of `routing` jumps (forward skips do not increment; only entering the
   * step does). 1 for a normal single execution, more when an earlier step
   * looped back into it. Absent on records from before this field existed. */
  executions?: number;
  /** Cleaned (non-ANSI) output text, present once the step has completed. */
  output?: string;
  error?: string;
  /** Turn/token/error/cost stats for this step's (latest) execution. Absent
   * on records from before this field existed. */
  stats?: StepStats;
}

/** A single run of a flow — one JSON file per run under
 * `${FLOWS_HOME}/runs/<flowId>/<runId>.json`. Written (and kept up to date)
 * by src/core/runManager.ts; read by the run history UI via
 * src/core/runStore.ts. */
export interface RunRecord {
  id: string;
  flowId: string;
  /** Snapshot of the flow's name at run time, so history stays readable
   * even if the flow is later renamed or deleted. */
  flowName: string;
  params: Record<string, string>;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  steps: RunStepRecord[];
}

// Implemented in src/core/engine.ts:
//   export function runFlow(flow: Flow, paramValues: Record<string, string>,
//                           onEvent: (e: RunEvent) => void, options?: RunOptions): RunHandle
//
// Implemented in src/core/storage.ts:
//   export function listFlows(): Flow[]
//   export function getFlow(id: string): Flow | undefined
//   export function saveFlow(flow: Flow): void          // upsert by id
//   export function deleteFlow(id: string): void
//   export function newFlowId(): string
//
// Implemented in src/core/agents.ts:
//   export const AGENTS: AgentDefinition[]
//   export function agentAvailable(agent: AgentDefinition): boolean
