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

/** URL/filename-safe version of a flow name, used as the default export
 * filename. Falls back to "flow" if the name has no alphanumeric characters. */
export function slugifyFlowName(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "flow";
}

/** Deep-copies a flow under a fresh id, with a fresh id for every step too
 * (step ids only need to be unique within the flow, so regenerating them is
 * safe), a " (copy)"-suffixed name, and fresh timestamps. Returns undefined
 * if the source flow doesn't exist. The copy is already persisted. */
export function duplicateFlow(id: string): Flow | undefined {
  const original = getFlow(id);
  if (!original) return undefined;
  const now = new Date().toISOString();
  const copy: Flow = {
    ...original,
    id: newFlowId(),
    name: `${original.name} (copy)`,
    steps: original.steps.map((step) => ({ ...step, id: crypto.randomUUID() })),
    createdAt: now,
    updatedAt: now,
  };
  saveFlow(copy);
  return copy;
}

/** Writes a portable copy of the flow (no machine-specific id/timestamps) to
 * `destPath`. Returns the resolved absolute path. Throws if the flow doesn't
 * exist or the file can't be written. */
export function exportFlow(id: string, destPath: string): string {
  const flow = getFlow(id);
  if (!flow) throw new Error(`Flow not found: ${id}`);
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...portable } = flow;
  const resolved = path.resolve(destPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(portable, null, 2), "utf-8");
  return resolved;
}

/** Reads and validates a flow JSON file exported by `exportFlow` (or hand-
 * authored to the same shape), assigns it a fresh id/timestamps and fresh
 * step ids, and persists it. If a flow with the same name already exists,
 * appends " (imported)" to the name rather than overwriting it. Throws with
 * a readable message on missing/malformed input; storage is left untouched
 * in that case. */
export function importFlow(srcPath: string): Flow {
  const resolved = path.resolve(srcPath);
  let raw: string;
  try {
    raw = fs.readFileSync(resolved, "utf-8");
  } catch {
    throw new Error(`Could not read file: ${resolved}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Not a valid JSON file: ${resolved}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Flow file must contain a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.name !== "string" || !obj.name.trim()) {
    throw new Error("Flow file is missing a 'name' field");
  }
  if (!Array.isArray(obj.steps)) {
    throw new Error("Flow file is missing a 'steps' array");
  }
  if (obj.parameters !== undefined && !Array.isArray(obj.parameters)) {
    throw new Error("Flow file's 'parameters' field must be an array");
  }

  const steps = obj.steps.map((s, i) => {
    if (!s || typeof s !== "object" || Array.isArray(s)) {
      throw new Error(`Step ${i + 1} is not an object`);
    }
    const step = s as Record<string, unknown>;
    if (typeof step.name !== "string" || !step.name.trim()) {
      throw new Error(`Step ${i + 1} is missing a 'name'`);
    }
    if (typeof step.agent !== "string") {
      throw new Error(`Step ${i + 1} is missing an 'agent'`);
    }
    if (typeof step.prompt !== "string") {
      throw new Error(`Step ${i + 1} ("${step.name}") is missing a 'prompt'`);
    }
    if (typeof step.expectedResult !== "string") {
      throw new Error(`Step ${i + 1} ("${step.name}") is missing 'expectedResult'`);
    }
    if (typeof step.validate !== "boolean") {
      throw new Error(`Step ${i + 1} ("${step.name}") is missing 'validate'`);
    }
    if (typeof step.maxRetries !== "number") {
      throw new Error(`Step ${i + 1} ("${step.name}") is missing 'maxRetries'`);
    }
    return { ...step, id: crypto.randomUUID() };
  });

  const now = new Date().toISOString();
  const nameTaken = listFlows().some((f) => f.name === obj.name);
  const name = nameTaken ? `${obj.name} (imported)` : (obj.name as string);

  const flow: Flow = {
    ...(obj as unknown as Flow),
    id: newFlowId(),
    name,
    steps: steps as Flow["steps"],
    createdAt: now,
    updatedAt: now,
  };

  saveFlow(flow);
  return flow;
}
