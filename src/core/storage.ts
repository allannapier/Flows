// JSON-file persistence for flows.
//
// Flows are stored as one pretty-printed JSON file per flow under
// `${FLOWS_HOME}/flows/<id>.json` (FLOWS_HOME defaults to ~/.flows).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Flow } from "../types";

function flowsDir(): string {
  const home = process.env.FLOWS_HOME ?? path.join(os.homedir(), ".flows");
  return path.join(home, "flows");
}

function ensureFlowsDir(): string {
  const dir = flowsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function flowPath(id: string): string {
  return path.join(flowsDir(), `${id}.json`);
}

export function listFlows(): Flow[] {
  const dir = ensureFlowsDir();
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const flows: Flow[] = [];
  for (const entry of entries) {
    try {
      const raw = fs.readFileSync(path.join(dir, entry), "utf-8");
      const flow = JSON.parse(raw) as Flow;
      flows.push(flow);
    } catch {
      // Skip corrupt files.
    }
  }
  flows.sort((a, b) => a.name.localeCompare(b.name));
  return flows;
}

export function getFlow(id: string): Flow | undefined {
  ensureFlowsDir();
  try {
    const raw = fs.readFileSync(flowPath(id), "utf-8");
    return JSON.parse(raw) as Flow;
  } catch {
    return undefined;
  }
}

export function saveFlow(flow: Flow): void {
  ensureFlowsDir();
  const now = new Date().toISOString();
  const toSave: Flow = {
    ...flow,
    createdAt: flow.createdAt || now,
    updatedAt: now,
  };
  fs.writeFileSync(flowPath(toSave.id), JSON.stringify(toSave, null, 2), "utf-8");
}

export function deleteFlow(id: string): void {
  ensureFlowsDir();
  try {
    fs.unlinkSync(flowPath(id));
  } catch {
    // Already gone; nothing to do.
  }
}

export function newFlowId(): string {
  return crypto.randomUUID();
}
