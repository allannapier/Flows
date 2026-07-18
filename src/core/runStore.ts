// JSON-file persistence for run history — one pretty-printed JSON file per
// run under `${FLOWS_HOME}/runs/<flowId>/<runId>.json`. Mirrors storage.ts's
// approach for flows. Written by runManager.ts as a run progresses and
// finishes; read by the run history UI.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RunRecord } from "../types";

/** Runs beyond this many (per flow, oldest first) are pruned on save. */
const MAX_RUNS_PER_FLOW = 50;

function runsDir(flowId: string): string {
  const home = process.env.FLOWS_HOME ?? path.join(os.homedir(), ".flows");
  return path.join(home, "runs", flowId);
}

function ensureRunsDir(flowId: string): string {
  const dir = runsDir(flowId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runPath(flowId: string, runId: string): string {
  return path.join(runsDir(flowId), `${runId}.json`);
}

export function listRuns(flowId: string): RunRecord[] {
  const dir = ensureRunsDir(flowId);
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const runs: RunRecord[] = [];
  for (const entry of entries) {
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(dir, entry), "utf-8")) as RunRecord);
    } catch {
      // Skip corrupt files.
    }
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs;
}

export function getRun(flowId: string, runId: string): RunRecord | undefined {
  try {
    return JSON.parse(fs.readFileSync(runPath(flowId, runId), "utf-8")) as RunRecord;
  } catch {
    return undefined;
  }
}

export function saveRun(record: RunRecord): void {
  ensureRunsDir(record.flowId);
  fs.writeFileSync(runPath(record.flowId, record.id), JSON.stringify(record, null, 2), "utf-8");
  pruneOldRuns(record.flowId);
}

function pruneOldRuns(flowId: string): void {
  const runs = listRuns(flowId);
  for (const stale of runs.slice(MAX_RUNS_PER_FLOW)) {
    try {
      fs.unlinkSync(runPath(flowId, stale.id));
    } catch {
      // Already gone; nothing to do.
    }
  }
}

export function deleteRunsForFlow(flowId: string): void {
  try {
    fs.rmSync(runsDir(flowId), { recursive: true, force: true });
  } catch {
    // Nothing to clean up.
  }
}

export function newRunId(): string {
  return crypto.randomUUID();
}
