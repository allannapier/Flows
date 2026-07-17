// Plain-assert smoke test for the core layer. Not a test framework — run
// directly with:
//
//   FLOWS_HOME=$(mktemp -d) bun run src/core/__smoke__.ts
//
// Exits 0 and prints OK on success; throws (non-zero exit) on failure.

import assert from "node:assert";
import type { Flow, RunEvent } from "../types";
import { deleteFlow, getFlow, listFlows, newFlowId, saveFlow } from "./storage";
import { renderTemplate } from "./template";
import { runFlow } from "./engine";

async function testStorage(): Promise<void> {
  const id = newFlowId();
  assert.equal(typeof id, "string");
  assert.ok(id.length > 0);

  const flow: Flow = {
    id,
    name: "Smoke Test Flow",
    description: "A flow used by the core smoke test.",
    parameters: [],
    steps: [],
    createdAt: "",
    updatedAt: "",
  };

  saveFlow(flow);

  const all = listFlows();
  assert.ok(all.some((f) => f.id === id), "saved flow should appear in listFlows()");

  const fetched = getFlow(id);
  assert.ok(fetched, "getFlow() should find the saved flow");
  assert.equal(fetched?.name, "Smoke Test Flow");
  assert.ok(fetched?.createdAt, "createdAt should be set on save");
  assert.ok(fetched?.updatedAt, "updatedAt should be set on save");

  deleteFlow(id);
  assert.equal(getFlow(id), undefined, "getFlow() should return undefined after delete");

  console.log("storage: OK");
}

function testTemplate(): void {
  const rendered = renderTemplate(
    "Hello {{params.name}}, previous step said: {{ steps.first.output }}.",
    { name: "World" },
    { first: "hi there" },
  );
  assert.equal(rendered, "Hello World, previous step said: hi there.");

  let threw = false;
  try {
    renderTemplate("{{params.missing}}", {}, {});
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error);
    assert.ok((err as Error).message.includes("params.missing"));
  }
  assert.ok(threw, "renderTemplate should throw on unknown placeholder");

  console.log("template: OK");
}

async function testEngine(): Promise<void> {
  const flow: Flow = {
    id: newFlowId(),
    name: "Custom Echo Flow",
    description: "One-step flow using the custom agent.",
    parameters: [],
    steps: [
      {
        id: "step-1",
        name: "echo",
        agent: "custom",
        customCommand: 'echo "hello $FLOW_PROMPT"',
        prompt: "world",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 0,
      },
    ],
    createdAt: "",
    updatedAt: "",
  };

  const events: RunEvent[] = [];
  const handle = runFlow(flow, {}, (e) => events.push(e));
  await handle.done;

  const types = events.map((e) => e.type);
  assert.ok(types.includes("flow-start"), `expected flow-start, got: ${types.join(",")}`);
  assert.ok(types.includes("step-complete"), `expected step-complete, got: ${types.join(",")}`);
  assert.ok(types.includes("flow-complete"), `expected flow-complete, got: ${types.join(",")}`);
  assert.ok(!types.includes("flow-failed"), `unexpected flow-failed, got: ${types.join(",")}`);

  const stepComplete = events.find((e) => e.type === "step-complete");
  assert.ok(stepComplete && stepComplete.type === "step-complete");
  if (stepComplete && stepComplete.type === "step-complete") {
    assert.ok(
      stepComplete.output.includes("hello world"),
      `expected step output to include "hello world", got: ${JSON.stringify(stepComplete.output)}`,
    );
  }

  console.log("engine: OK");
}

async function main(): Promise<void> {
  if (!process.env.FLOWS_HOME) {
    throw new Error("Set FLOWS_HOME to a temp directory before running this smoke test.");
  }

  await testStorage();
  testTemplate();
  await testEngine();

  console.log("OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
