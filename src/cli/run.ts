// Headless (non-interactive) flow runner — the CLI front end for
// `bun run start run <flow> [--param k=v ...] [--json]`. Translates the
// engine's RunEvents into log lines (or line-delimited JSON) and answers
// any gate that would otherwise wait on a human, since there isn't one.
// Runs are started through runManager exactly like a TUI run, so they
// persist and show up in run history the same way.

import type { Flow, RunEvent } from "../types";
import { listFlows } from "../core/storage";
import { lintFlow } from "../core/lint";
import { acknowledgeAlert, cancelRun, closeRun, continueRun, getActiveRun, startRun } from "../core/runManager";

/** Prints a two-line usage/help block for the `run` subcommand specifically
 * (index.tsx's --help covers the whole CLI). */
export function printRunUsage(): void {
  console.error("Usage: bun run start run <flow-name-or-id> [--param key=value ...] [--json]");
}

function resolveFlow(flows: Flow[], ref: string): Flow | { error: string } {
  const byId = flows.find((f) => f.id === ref);
  if (byId) return byId;

  const byName = flows.filter((f) => f.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    return {
      error: `Multiple flows are named "${ref}" — run by id instead:\n${byName.map((f) => `  ${f.id}  ${f.name}`).join("\n")}`,
    };
  }

  if (flows.length === 0) return { error: `No flow found matching "${ref}" (no flows saved yet)` };
  return {
    error: `No flow found matching "${ref}". Available flows:\n${flows.map((f) => `  ${f.id}  ${f.name}`).join("\n")}`,
  };
}

function buildParams(flow: Flow, paramFlags: string[]): { params: Record<string, string> } | { error: string } {
  const provided: Record<string, string> = {};
  for (const flag of paramFlags) {
    const eq = flag.indexOf("=");
    if (eq === -1) return { error: `Invalid --param "${flag}" — expected key=value` };
    provided[flag.slice(0, eq)] = flag.slice(eq + 1);
  }

  const known = new Set(flow.parameters.map((p) => p.name));
  for (const key of Object.keys(provided)) {
    if (!known.has(key)) return { error: `Unknown parameter "${key}" for flow "${flow.name}"` };
  }

  const params: Record<string, string> = {};
  for (const p of flow.parameters) {
    const value = provided[p.name] ?? p.default ?? "";
    if (p.required && value.trim() === "") return { error: `Missing required parameter "${p.name}"` };
    if (p.choices?.length && value !== "" && !p.choices.includes(value)) {
      return { error: `Parameter "${p.name}" must be one of: ${p.choices.join(", ")} (got "${value}")` };
    }
    params[p.name] = value;
  }
  return { params };
}

function stepLabel(flow: Flow, index: number): string {
  const name = flow.steps[index]?.name ?? `step ${index + 1}`;
  return `[${index + 1}/${flow.steps.length}] ${name}`;
}

/** Human-readable progress line for an event, or undefined for events with
 * nothing worth logging headlessly (raw agent output, validation-start,
 * live-session bookkeeping). Printed to stderr; step outputs and the final
 * summary go to stdout separately (see runHeadless). */
function progressLine(e: RunEvent, flow: Flow): string | undefined {
  switch (e.type) {
    case "flow-start":
      return `Running "${e.flowName}" (${e.totalSteps} step${e.totalSteps === 1 ? "" : "s"})`;
    case "step-start":
      return e.attempt > 1 ? `${stepLabel(flow, e.stepIndex)} — retrying (attempt ${e.attempt})` : `${stepLabel(flow, e.stepIndex)} — started`;
    case "validation-result":
      return e.verdict.passed ? undefined : `${stepLabel(flow, e.stepIndex)} — validation failed: ${e.verdict.feedback}`;
    case "step-retry":
      return `${stepLabel(flow, e.stepIndex)} — retrying (attempt ${e.attempt}): ${e.feedback}`;
    case "step-timeout":
      return `${stepLabel(flow, e.stepIndex)} — timed out after ${e.minutes}m`;
    case "step-complete":
      return `${stepLabel(flow, e.stepIndex)} — complete`;
    case "step-failed":
      return `${stepLabel(flow, e.stepIndex)} — failed: ${e.error}`;
    case "step-jump":
      return `↪ jumped ${e.reason === "success" ? "on success" : "on failure"}: ${stepLabel(flow, e.fromIndex)} → ${stepLabel(flow, e.toIndex)}`;
    case "step-awaiting-input":
      return `${stepLabel(flow, e.stepIndex)} — awaiting input: ${e.message} (headless: auto-continuing)`;
    case "step-alert":
      return `${stepLabel(flow, e.stepIndex)} — alert: ${e.error} (headless: auto-acknowledging)`;
    case "session-note":
      return `${stepLabel(flow, e.stepIndex)} — note: ${e.note}`;
    case "flow-complete":
      return "Flow complete.";
    case "flow-failed":
      return `Flow failed: ${e.error}`;
    default:
      return undefined;
  }
}

function runAndWait(flow: Flow, params: Record<string, string>, json: boolean): Promise<number> {
  return new Promise((resolve) => {
    let outcome: "complete" | "failed" | "cancelled" = "failed";
    let finalError: string | undefined;

    const runId = startRun(flow, params, undefined, (e: RunEvent) => {
      if (json) {
        console.log(JSON.stringify(e));
      } else {
        const line = progressLine(e, flow);
        if (line) console.error(line);
        if (e.type === "step-complete") {
          console.log(`\n=== ${flow.steps[e.stepIndex]?.name ?? `step ${e.stepIndex + 1}`} ===\n${e.output}`);
        }
      }

      switch (e.type) {
        case "step-awaiting-input":
          // No user to wait on — proceed immediately.
          continueRun(runId);
          break;
        case "step-alert":
          // No user to dismiss the alert — acknowledge so the run resumes
          // to its normal failure/routing handling.
          acknowledgeAlert(runId);
          break;
        case "flow-complete":
          outcome = "complete";
          break;
        case "flow-failed":
          outcome = e.error === "Cancelled by user" ? "cancelled" : "failed";
          finalError = e.error;
          break;
      }
    }, true);

    const onSigint = () => {
      console.error("[headless] received interrupt, cancelling run...");
      cancelRun(runId);
    };
    process.on("SIGINT", onSigint);

    getActiveRun(runId)!.handle.done.then(() => {
      process.off("SIGINT", onSigint);
      // Nothing will ever attach to a headless run's interactive session —
      // close it so the process can exit instead of hanging on a live PTY.
      closeRun(runId);
      if (!json) {
        console.log(outcome === "complete" ? "\nResult: complete" : `\nResult: ${outcome}${finalError ? ` — ${finalError}` : ""}`);
      }
      resolve(outcome === "complete" ? 0 : 1);
    });
  });
}

/** Entry point for the `run` subcommand. Returns the process exit code
 * (0 success, 1 flow failure/cancellation, 2 usage error) — the caller is
 * responsible for actually exiting the process. */
export async function cliRun(args: string[]): Promise<number> {
  let flowRef: string | undefined;
  const paramFlags: string[] = [];
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--param") {
      const value = args[++i];
      if (value === undefined) {
        console.error("--param requires a key=value argument");
        return 2;
      }
      paramFlags.push(value);
    } else if (arg.startsWith("--param=")) {
      paramFlags.push(arg.slice("--param=".length));
    } else if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      printRunUsage();
      return 2;
    } else if (flowRef === undefined) {
      flowRef = arg;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      printRunUsage();
      return 2;
    }
  }

  if (!flowRef) {
    printRunUsage();
    return 2;
  }

  const resolved = resolveFlow(listFlows(), flowRef);
  if ("error" in resolved) {
    console.error(resolved.error);
    return 2;
  }
  const flow = resolved;

  const paramsResult = buildParams(flow, paramFlags);
  if ("error" in paramsResult) {
    console.error(paramsResult.error);
    return 2;
  }

  const lintErrors = lintFlow(flow).filter((i) => i.severity === "error");
  if (lintErrors.length > 0) {
    console.error(`"${flow.name}" has integrity errors and cannot be run:`);
    for (const issue of lintErrors) {
      console.error(`  ${issue.stepIndex !== undefined ? `Step ${issue.stepIndex + 1}: ` : ""}${issue.message}`);
    }
    return 2;
  }

  return runAndWait(flow, paramsResult.params, json);
}
