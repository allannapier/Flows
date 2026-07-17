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
  /** Working directory for the agent process (defaults to cwd). */
  workingDir?: string;
}

export interface Flow {
  id: string;
  name: string;
  description: string;
  parameters: FlowParameter[];
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Engine events (core -> UI)
// ---------------------------------------------------------------------------

export interface ValidationVerdict {
  passed: boolean;
  feedback: string;
}

export type RunEvent =
  | { type: "flow-start"; flowName: string; totalSteps: number }
  | { type: "step-start"; stepIndex: number; stepName: string; agent: AgentId; attempt: number }
  | { type: "agent-output"; stepIndex: number; chunk: string }
  | { type: "step-output-complete"; stepIndex: number; exitCode: number }
  | { type: "validation-start"; stepIndex: number }
  | { type: "validation-result"; stepIndex: number; verdict: ValidationVerdict }
  | { type: "step-retry"; stepIndex: number; attempt: number; feedback: string }
  | { type: "step-complete"; stepIndex: number; output: string }
  | { type: "step-failed"; stepIndex: number; error: string }
  | { type: "flow-complete" }
  | { type: "flow-failed"; error: string };

export interface RunHandle {
  /** Resolves when the run finishes (success or failure). Never rejects. */
  done: Promise<void>;
  /** Abort the run (kills the current agent process). */
  cancel(): void;
}

// Implemented in src/core/engine.ts:
//   export function runFlow(flow: Flow, paramValues: Record<string, string>,
//                           onEvent: (e: RunEvent) => void): RunHandle
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
