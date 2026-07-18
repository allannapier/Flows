// Plain-assert smoke test for the core layer. Not a test framework — run
// directly with:
//
//   FLOWS_HOME=$(mktemp -d) bun run src/core/__smoke__.ts
//
// Exits 0 and prints OK on success; throws (non-zero exit) on failure.

import assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Flow, FlowStep, RunEvent } from "../types";
import { deleteFlow, getFlow, listFlows, newFlowId, saveFlow } from "./storage";
import { renderTemplate } from "./template";
import { runFlow } from "./engine";
import { buildAgentCommand } from "./agents";
import { loadConfig, saveConfig, resolveValidator, maskKey } from "./config";

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
    // The engine now runs the step in a PTY and cleans the output with
    // ptyToText before emitting step-complete; it should contain no raw
    // ANSI escape sequences.
    assert.ok(
      !stepComplete.output.includes("\x1b["),
      `expected step output to be free of ANSI escapes, got: ${JSON.stringify(stepComplete.output)}`,
    );
  }

  console.log("engine: OK");
}

function baseStep(overrides: Partial<FlowStep>): FlowStep {
  return {
    id: "s",
    name: "s",
    agent: "claude",
    prompt: "p",
    expectedResult: "N/A",
    validate: false,
    maxRetries: 0,
    ...overrides,
  };
}

function testBuildAgentCommand(): void {
  const claudeContinue = buildAgentCommand(baseStep({ agent: "claude" }), "hi", true);
  assert.ok(
    claudeContinue.cmd.includes("--continue"),
    `expected claude+continue to include --continue, got: ${JSON.stringify(claudeContinue.cmd)}`,
  );

  const codexContinue = buildAgentCommand(baseStep({ agent: "codex" }), "hi", true);
  assert.deepEqual(codexContinue.cmd, ["codex", "exec", "resume", "--last", "hi"]);

  const codexFresh = buildAgentCommand(baseStep({ agent: "codex" }), "hi", false);
  assert.deepEqual(codexFresh.cmd, ["codex", "exec", "hi"]);

  const geminiContinue = buildAgentCommand(baseStep({ agent: "gemini" }), "hi", true);
  assert.ok(
    !geminiContinue.cmd.some((s) => s.includes("continue") || s.includes("resume")),
    `expected gemini+continue to contain no resume flags, got: ${JSON.stringify(geminiContinue.cmd)}`,
  );

  console.log("buildAgentCommand: OK");
}

async function testEngineContinuation(): Promise<void> {
  const flow: Flow = {
    id: newFlowId(),
    name: "Continuation Flow",
    description: "Three-step flow exercising $FLOW_CONTINUE plumbing.",
    parameters: [],
    steps: [
      {
        id: "step-1",
        name: "first",
        agent: "custom",
        customCommand: 'echo "cont=$FLOW_CONTINUE"',
        prompt: "a",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 0,
        continueSession: true,
      },
      {
        id: "step-2",
        name: "second",
        agent: "custom",
        customCommand: 'echo "cont=$FLOW_CONTINUE"',
        prompt: "b",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 0,
        continueSession: true,
      },
      {
        id: "step-3",
        name: "third",
        agent: "custom",
        customCommand: 'echo "cont=$FLOW_CONTINUE"',
        prompt: "c",
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

  assert.ok(
    !events.some((e) => e.type === "flow-failed"),
    `unexpected flow-failed, got: ${JSON.stringify(events.filter((e) => e.type === "flow-failed"))}`,
  );

  const completes = events.filter((e) => e.type === "step-complete");
  assert.equal(completes.length, 3, `expected 3 step-complete events, got ${completes.length}`);

  const [first, second, third] = completes;
  assert.ok(first && first.type === "step-complete" && first.output.includes("cont=0"));
  assert.ok(second && second.type === "step-complete" && second.output.includes("cont=1"));
  assert.ok(third && third.type === "step-complete" && third.output.includes("cont=0"));

  console.log("engine continuation: OK");
}

async function testEngineWrite(): Promise<void> {
  const flow: Flow = {
    id: newFlowId(),
    name: "Interactive Read Flow",
    description: "One-step flow exercising RunHandle.write() (Phase 3 attach).",
    parameters: [],
    steps: [
      {
        id: "step-1",
        name: "prompt",
        agent: "custom",
        customCommand: 'read line; echo "got:$line"',
        prompt: "unused",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 0,
      },
    ],
    createdAt: "",
    updatedAt: "",
  };

  const events: RunEvent[] = [];
  let sawStepStart = false;
  const handle = runFlow(flow, {}, (e) => {
    events.push(e);
    if (e.type === "step-start") sawStepStart = true;
  });

  // Wait for the step's PTY to spawn and the shell's `read` to be waiting on
  // stdin before writing — mirrors what RunScreen does when a user attaches
  // and types.
  const deadline = Date.now() + 5000;
  while (!sawStepStart && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(sawStepStart, "expected step-start before writing to the PTY");

  await new Promise((r) => setTimeout(r, 300));
  handle.write("ping\r");

  await handle.done;

  const types = events.map((e) => e.type);
  assert.ok(types.includes("step-complete"), `expected step-complete, got: ${types.join(",")}`);
  assert.ok(!types.includes("flow-failed"), `unexpected flow-failed, got: ${JSON.stringify(events.filter((e) => e.type === "flow-failed"))}`);

  const stepComplete = events.find((e) => e.type === "step-complete");
  assert.ok(stepComplete && stepComplete.type === "step-complete");
  if (stepComplete && stepComplete.type === "step-complete") {
    assert.ok(
      stepComplete.output.includes("got:ping"),
      `expected step output to include "got:ping", got: ${JSON.stringify(stepComplete.output)}`,
    );
  }

  console.log("engine write (attach interactivity): OK");
}

async function testEngineNeedsInput(): Promise<void> {
  // A step whose command asks a short question the first time it runs, then
  // succeeds once answered — exercising the "step-needs-input" pause/resume
  // path (engine.ts's looksLikeClarifyingQuestion + RunHandle.answerInput),
  // which stands in for an agent CLI that exits after asking rather than
  // blocking on stdin (see session/engine changes for why that can't be
  // "attached" to after the fact).
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flows-needs-input-")), "asked");
  const flow: Flow = {
    id: newFlowId(),
    name: "Needs Input Flow",
    description: "One-step flow exercising step-needs-input.",
    parameters: [],
    steps: [
      {
        id: "step-1",
        name: "ask-then-build",
        agent: "custom",
        customCommand: `test -f ${marker} && echo done || { touch ${marker}; echo "should I build this here?"; }`,
        prompt: "unused",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 1,
      },
    ],
    createdAt: "",
    updatedAt: "",
  };

  const events: RunEvent[] = [];
  const handle = runFlow(flow, {}, (e) => events.push(e));

  const deadline = Date.now() + 5000;
  while (!events.some((e) => e.type === "step-needs-input") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const needsInput = events.find((e) => e.type === "step-needs-input");
  assert.ok(needsInput && needsInput.type === "step-needs-input", "expected a step-needs-input event");
  if (needsInput && needsInput.type === "step-needs-input") {
    assert.ok(needsInput.question.includes("should I build this here?"), `unexpected question: ${needsInput.question}`);
  }
  assert.ok(!events.some((e) => e.type === "step-complete"), "step should not have completed before being answered");

  handle.answerInput("yes, use the current directory");
  await handle.done;

  const types = events.map((e) => e.type);
  assert.ok(types.includes("step-complete"), `expected step-complete, got: ${types.join(",")}`);
  assert.equal(types.filter((t) => t === "step-needs-input").length, 1, "expected exactly one needs-input pause");

  const stepComplete = events.find((e) => e.type === "step-complete");
  assert.ok(stepComplete && stepComplete.type === "step-complete" && stepComplete.output.includes("done"));

  console.log("engine needs-input (answer resumes the step): OK");
}

function testConfig(): void {
  const home = process.env.FLOWS_HOME!;
  const configFile = path.join(home, "config.json");
  fs.rmSync(configFile, { force: true });

  const defaults = loadConfig();
  assert.deepEqual(defaults, { validator: { provider: "anthropic" } });

  saveConfig({
    validator: {
      provider: "openai",
      model: "gpt-5.1",
      apiKey: "sk-test-1234",
    },
  });

  const reloaded = loadConfig();
  assert.equal(reloaded.validator.provider, "openai");
  assert.equal(reloaded.validator.model, "gpt-5.1");
  assert.equal(reloaded.validator.apiKey, "sk-test-1234");

  const mode = fs.statSync(configFile).mode & 0o777;
  assert.equal(mode, 0o600, `expected config.json mode 0600, got ${mode.toString(8)}`);

  fs.rmSync(configFile, { force: true });
  console.log("config: OK");
}

function testResolveValidator(): void {
  const home = process.env.FLOWS_HOME!;
  const configFile = path.join(home, "config.json");
  const savedEnv = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    FLOWS_VALIDATOR_MODEL: process.env.FLOWS_VALIDATOR_MODEL,
  };

  try {
    fs.rmSync(configFile, { force: true });
    delete process.env.FLOWS_VALIDATOR_MODEL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = "sk-ant-abcd1234";

    const resolved = resolveValidator();
    assert.equal(resolved.provider, "anthropic");
    assert.equal(resolved.model, "claude-opus-4-8");
    assert.equal(resolved.apiKey, "sk-ant-abcd1234");
    assert.equal(resolved.apiKeyEnvVar, "ANTHROPIC_API_KEY");

    let threw = false;
    try {
      resolveValidator({ validator: { provider: "openai", apiKey: "sk-x" } });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes("Settings"), (err as Error).message);
    }
    assert.ok(threw, "expected resolveValidator to throw for openai without a model");

    threw = false;
    try {
      resolveValidator({ validator: { provider: "custom", model: "gpt-4o-mini", apiKey: "sk-x" } });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes("Settings"), (err as Error).message);
    }
    assert.ok(threw, "expected resolveValidator to throw for custom without a baseUrl");
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k as keyof typeof savedEnv];
      else process.env[k as keyof typeof savedEnv] = v;
    }
    fs.rmSync(configFile, { force: true });
  }

  console.log("resolveValidator: OK");
}

function testMaskKey(): void {
  assert.equal(maskKey(undefined), "(not set)");
  assert.equal(maskKey(""), "(not set)");
  assert.equal(maskKey("sk-abcdef1234"), "••••1234");
  console.log("maskKey: OK");
}

async function main(): Promise<void> {
  if (!process.env.FLOWS_HOME) {
    throw new Error("Set FLOWS_HOME to a temp directory before running this smoke test.");
  }

  await testStorage();
  testTemplate();
  await testEngine();
  testBuildAgentCommand();
  await testEngineContinuation();
  await testEngineWrite();
  await testEngineNeedsInput();
  testConfig();
  testResolveValidator();
  testMaskKey();

  console.log("OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
