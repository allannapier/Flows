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
import {
  deleteFlow,
  duplicateFlow,
  exportFlow,
  getFlow,
  importFlow,
  listFlows,
  newFlowId,
  saveFlow,
  slugifyFlowName,
} from "./storage";
import { renderParamsOnly, renderTemplate } from "./template";
import { runFlow } from "./engine";
import { buildAgentCommand } from "./agents";
import { loadConfig, saveConfig, resolveValidator, maskKey } from "./config";
import {
  agentScratchDir,
  agentSupportsInteractive,
  buildCodexNotifyScript,
  buildOpencodeHookPlugin,
  buildStopHookSettings,
  cleanupRunScratch,
  encodeBracketedPaste,
  extractLastAssistantMessageFromTranscript,
  mergeOpencodeConfig,
  parseStopPayload,
  prepareAgentScratch,
  runScratchDir,
  shellQuote,
  stripJsonComments,
  watchForNewStopFile,
} from "./interactive";

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

async function testFlowPortability(): Promise<void> {
  const original: Flow = {
    id: newFlowId(),
    name: "Portable Flow",
    description: "A flow used by the portability smoke test.",
    parameters: [{ name: "repoPath", description: "target repo", required: true }],
    steps: [
      {
        id: "step-1",
        name: "first",
        agent: "custom",
        customCommand: 'echo "$FLOW_PROMPT"',
        prompt: "hello",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 0,
      },
    ],
    createdAt: "",
    updatedAt: "",
  };
  saveFlow(original);

  // duplicateFlow
  const copy = duplicateFlow(original.id);
  assert.ok(copy, "duplicateFlow should return the new flow");
  assert.notEqual(copy!.id, original.id, "copy should have a fresh id");
  assert.equal(copy!.name, "Portable Flow (copy)");
  assert.notEqual(copy!.steps[0]!.id, original.steps[0]!.id, "copy's step should have a fresh id");
  const refetchedOriginal = getFlow(original.id);
  assert.equal(refetchedOriginal?.name, "Portable Flow", "duplicating must not mutate the original");
  assert.equal(duplicateFlow("does-not-exist"), undefined, "duplicateFlow of a missing id returns undefined");

  // exportFlow
  const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), "flows-export-"));
  const exportPath = path.join(exportDir, "portable-flow.flow.json");
  try {
    const resolved = exportFlow(original.id, exportPath);
    assert.equal(resolved, path.resolve(exportPath));
    const exported = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    assert.equal(exported.name, "Portable Flow");
    assert.equal(exported.id, undefined, "exported JSON must not contain the machine-specific id");
    assert.equal(exported.createdAt, undefined, "exported JSON must not contain createdAt");
    assert.equal(exported.updatedAt, undefined, "exported JSON must not contain updatedAt");
    assert.equal(exported.steps.length, 1);

    let threw = false;
    try {
      exportFlow("does-not-exist", exportPath);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
    }
    assert.ok(threw, "exportFlow should throw for an unknown flow id");

    // importFlow: fresh import recreates the flow with a new id.
    deleteFlow(original.id);
    const imported = importFlow(resolved);
    assert.notEqual(imported.id, original.id);
    assert.equal(imported.name, "Portable Flow", "no name collision -> no suffix");
    assert.equal(imported.steps.length, 1);
    assert.notEqual(imported.steps[0]!.id, "step-1", "imported step should get a fresh id");
    assert.ok(getFlow(imported.id), "imported flow should be persisted");

    // importFlow: name collision gets an "(imported)" suffix instead of
    // overwriting the existing flow.
    const importedAgain = importFlow(resolved);
    assert.equal(importedAgain.name, "Portable Flow (imported)");
    assert.notEqual(importedAgain.id, imported.id);
    assert.ok(getFlow(imported.id), "original import must survive a second import");

    // importFlow: malformed input is rejected and leaves storage untouched.
    const badPath = path.join(exportDir, "bad.flow.json");
    fs.writeFileSync(badPath, JSON.stringify({ name: "No steps here" }), "utf-8");
    const before = listFlows().length;
    threw = false;
    try {
      importFlow(badPath);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
      assert.ok(/steps/i.test((err as Error).message));
    }
    assert.ok(threw, "importFlow should reject a flow with no steps array");
    assert.equal(listFlows().length, before, "a failed import must not change storage");

    fs.writeFileSync(path.join(exportDir, "not-json.flow.json"), "{not json", "utf-8");
    threw = false;
    try {
      importFlow(path.join(exportDir, "not-json.flow.json"));
    } catch {
      threw = true;
    }
    assert.ok(threw, "importFlow should reject invalid JSON");

    threw = false;
    try {
      importFlow(path.join(exportDir, "missing.flow.json"));
    } catch {
      threw = true;
    }
    assert.ok(threw, "importFlow should reject a missing file");

    deleteFlow(imported.id);
    deleteFlow(importedAgain.id);
  } finally {
    fs.rmSync(exportDir, { recursive: true, force: true });
  }

  assert.equal(slugifyFlowName("My Cool Flow!"), "my-cool-flow");
  assert.equal(slugifyFlowName("   "), "flow");

  console.log("flowPortability: OK");
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

function testRenderParamsOnly(): void {
  const rendered = renderParamsOnly("/repos/{{params.repoName}}", { repoName: "flows" });
  assert.equal(rendered, "/repos/flows");

  let threw = false;
  try {
    renderParamsOnly("{{params.missing}}", {});
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error);
    assert.ok((err as Error).message.includes("params.missing"));
  }
  assert.ok(threw, "renderParamsOnly should throw on unknown param");

  threw = false;
  try {
    renderParamsOnly("{{steps.first.output}}", {});
  } catch (err) {
    threw = true;
    assert.ok(err instanceof Error);
    assert.ok(
      (err as Error).message.includes("steps.first.output"),
      `expected message to name the rejected placeholder, got: ${(err as Error).message}`,
    );
  }
  assert.ok(threw, "renderParamsOnly should reject {{steps.*.output}} placeholders");

  console.log("renderParamsOnly: OK");
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
    assert.deepEqual(
      stepComplete.stats,
      { turns: 1, tokensUsed: 0, errorCount: 0, estimatedCostUsd: undefined },
      `expected zeroed stats for a non-validated, non-retried step, got: ${JSON.stringify(stepComplete.stats)}`,
    );
  }

  console.log("engine: OK");
}

async function testEngineStepStatsOnRetry(): Promise<void> {
  const counterFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flows-retry-")), "count");
  const flow: Flow = {
    id: newFlowId(),
    name: "Retry Stats Flow",
    description: "One-step flow that fails twice (non-zero exit) before succeeding.",
    parameters: [],
    steps: [
      {
        id: "step-1",
        name: "flaky",
        agent: "custom",
        customCommand: `n=$(cat '${counterFile}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counterFile}'; [ "$n" -ge 3 ] && exit 0; exit 1`,
        prompt: "unused",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 2,
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

  const stepComplete = events.find((e) => e.type === "step-complete");
  assert.ok(stepComplete && stepComplete.type === "step-complete");
  if (stepComplete && stepComplete.type === "step-complete") {
    assert.deepEqual(
      stepComplete.stats,
      { turns: 3, tokensUsed: 0, errorCount: 2, estimatedCostUsd: undefined },
      `expected turns=3/errorCount=2 after two failed attempts, got: ${JSON.stringify(stepComplete.stats)}`,
    );
  }

  console.log("engine step stats on retry: OK");
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

async function testEngineAlertOnFailure(): Promise<void> {
  const flow: Flow = {
    id: newFlowId(),
    name: "Alert On Failure Flow",
    description: "One-step flow whose step always fails, with alertOnFailure set.",
    parameters: [],
    steps: [
      {
        id: "step-1",
        name: "always-fails",
        agent: "custom",
        customCommand: "exit 1",
        prompt: "unused",
        expectedResult: "N/A",
        validate: false,
        maxRetries: 0,
        alertOnFailure: true,
      },
    ],
    createdAt: "",
    updatedAt: "",
  };

  const events: RunEvent[] = [];
  let sawAlert = false;
  const handle = runFlow(flow, {}, (e) => {
    events.push(e);
    if (e.type === "step-alert") sawAlert = true;
  });

  const deadline = Date.now() + 5000;
  while (!sawAlert && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(sawAlert, "expected step-alert to be emitted");
  const stepFailed = events.find((e) => e.type === "step-failed");
  assert.ok(stepFailed, "step-failed should already have been emitted alongside step-alert");
  if (stepFailed && stepFailed.type === "step-failed") {
    assert.deepEqual(
      stepFailed.stats,
      { turns: 1, tokensUsed: 0, errorCount: 1, estimatedCostUsd: undefined },
      `expected turns=1/errorCount=1 for a single failed attempt, got: ${JSON.stringify(stepFailed.stats)}`,
    );
  }
  assert.ok(
    !events.some((e) => e.type === "flow-failed"),
    "flow-failed should not fire until the alert is acknowledged",
  );

  // Give the (already-resolved) engine a beat to prove it's genuinely
  // parked, not just about to emit flow-failed on its own.
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    !events.some((e) => e.type === "flow-failed"),
    "flow-failed should still not have fired without acknowledgeAlert()",
  );

  handle.acknowledgeAlert();
  await handle.done;

  assert.ok(
    events.some((e) => e.type === "flow-failed"),
    `expected flow-failed after acknowledgeAlert(), got: ${events.map((e) => e.type).join(",")}`,
  );

  console.log("engine alertOnFailure: OK");
}

async function testEngineWorkingDir(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flows-workdir-"));
  try {
    // 1. Flow-level workingDir, templated with a run param, used as the
    //    default when no step-level workingDir is set.
    const flow: Flow = {
      id: newFlowId(),
      name: "Flow-Level WorkingDir",
      description: "Step has no workingDir; flow-level default applies.",
      parameters: [{ name: "repoPath", description: "target dir", required: true }],
      workingDir: "{{params.repoPath}}",
      steps: [
        {
          id: "step-1",
          name: "pwd",
          agent: "custom",
          customCommand: "pwd",
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
    const handle = runFlow(flow, { repoPath: tmpDir }, (e) => events.push(e));
    await handle.done;

    assert.ok(
      !events.some((e) => e.type === "flow-failed"),
      `unexpected flow-failed, got: ${JSON.stringify(events.filter((e) => e.type === "flow-failed"))}`,
    );
    const stepComplete = events.find((e) => e.type === "step-complete");
    assert.ok(stepComplete && stepComplete.type === "step-complete");
    if (stepComplete && stepComplete.type === "step-complete") {
      assert.ok(
        stepComplete.output.includes(fs.realpathSync(tmpDir)),
        `expected step to run in flow-level workingDir, got: ${JSON.stringify(stepComplete.output)}`,
      );
    }

    // 2. Step-level workingDir overrides the flow-level default.
    const stepDir = fs.mkdtempSync(path.join(tmpDir, "step-"));
    const overrideFlow: Flow = {
      ...flow,
      id: newFlowId(),
      steps: [{ ...flow.steps[0]!, workingDir: stepDir }],
    };
    const overrideEvents: RunEvent[] = [];
    const overrideHandle = runFlow(overrideFlow, { repoPath: tmpDir }, (e) => overrideEvents.push(e));
    await overrideHandle.done;
    const overrideComplete = overrideEvents.find((e) => e.type === "step-complete");
    assert.ok(overrideComplete && overrideComplete.type === "step-complete");
    if (overrideComplete && overrideComplete.type === "step-complete") {
      assert.ok(
        overrideComplete.output.includes(fs.realpathSync(stepDir)),
        `expected step-level workingDir to override the flow default, got: ${JSON.stringify(overrideComplete.output)}`,
      );
    }

    // 3. A working directory that renders to a non-existent path fails the
    //    step immediately (no agent launched) with the resolved path in the
    //    error, and never emits step-start for it.
    const missingDir = path.join(tmpDir, "does-not-exist");
    const missingFlow: Flow = {
      ...flow,
      id: newFlowId(),
      workingDir: missingDir,
    };
    const missingEvents: RunEvent[] = [];
    const missingHandle = runFlow(missingFlow, { repoPath: tmpDir }, (e) => missingEvents.push(e));
    await missingHandle.done;
    assert.ok(
      !missingEvents.some((e) => e.type === "step-start"),
      "step-start should never fire when the working directory doesn't exist",
    );
    const missingFailed = missingEvents.find((e) => e.type === "step-failed");
    assert.ok(missingFailed && missingFailed.type === "step-failed" && missingFailed.error.includes(missingDir));
    assert.ok(
      missingEvents.some((e) => e.type === "flow-failed"),
      "expected flow-failed after the working-directory check fails the only step",
    );

    // 4. {{steps.*.output}} in a working directory is rejected with a clear
    //    error and never launches the agent.
    const stepsPlaceholderFlow: Flow = {
      ...flow,
      id: newFlowId(),
      workingDir: undefined,
      steps: [{ ...flow.steps[0]!, workingDir: "{{steps.pwd.output}}" }],
    };
    const stepsPlaceholderEvents: RunEvent[] = [];
    const stepsPlaceholderHandle = runFlow(stepsPlaceholderFlow, { repoPath: tmpDir }, (e) => stepsPlaceholderEvents.push(e));
    await stepsPlaceholderHandle.done;
    assert.ok(!stepsPlaceholderEvents.some((e) => e.type === "step-start"));
    const rejectedFailed = stepsPlaceholderEvents.find((e) => e.type === "step-failed");
    assert.ok(
      rejectedFailed &&
        rejectedFailed.type === "step-failed" &&
        rejectedFailed.error.includes("steps.pwd.output"),
      `expected step-failed naming the rejected placeholder, got: ${JSON.stringify(rejectedFailed)}`,
    );

    console.log("engine workingDir (flow-level, override, missing dir, steps.* rejection): OK");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

function testShellQuote(): void {
  assert.equal(shellQuote("/plain/path"), "'/plain/path'");
  assert.equal(shellQuote("/it's/tricky"), `'/it'\\''s/tricky'`);
  console.log("shellQuote: OK");
}

function testBuildStopHookSettings(): void {
  const settings = buildStopHookSettings("/tmp/flows-stops") as {
    hooks: { Stop: [{ hooks: [{ type: string; command: string }] }] };
  };
  const command = settings.hooks.Stop[0].hooks[0].command;
  assert.equal(command, `cat > '/tmp/flows-stops'/stop-$(date +%s%N).json`);
  assert.equal(settings.hooks.Stop[0].hooks[0].type, "command");
  console.log("buildStopHookSettings: OK");
}

function testParseStopPayload(): void {
  const payload = parseStopPayload(
    JSON.stringify({
      session_id: "abc",
      transcript_path: "/tmp/t.jsonl",
      cwd: "/repo",
      last_assistant_message: "done",
      hook_event_name: "Stop",
      stop_hook_active: false,
    }),
  );
  assert.ok(payload);
  assert.equal(payload?.last_assistant_message, "done");
  assert.equal(payload?.session_id, "abc");

  assert.equal(parseStopPayload("not json"), undefined);
  assert.equal(parseStopPayload("null"), undefined);
  console.log("parseStopPayload: OK");
}

function testExtractLastAssistantMessageFromTranscript(): void {
  const lines = [
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "first reply" }] },
    }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "and then?" }] } }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "second reply, part 1" },
          { type: "text", text: "part 2" },
        ],
      },
    }),
    "", // trailing blank line should be tolerated
  ].join("\n");

  const extracted = extractLastAssistantMessageFromTranscript(lines);
  assert.equal(extracted, "second reply, part 1\npart 2");

  assert.equal(extractLastAssistantMessageFromTranscript(""), undefined);
  assert.equal(extractLastAssistantMessageFromTranscript("garbage\nnot json either"), undefined);

  console.log("extractLastAssistantMessageFromTranscript: OK");
}

function testEncodeBracketedPaste(): void {
  assert.equal(encodeBracketedPaste("hello"), "\x1b[200~hello\x1b[201~");
  console.log("encodeBracketedPaste: OK");
}

function testRunScratchLifecycle(): void {
  const runId = `smoke-${crypto.randomUUID()}`;

  const claudeScratch = prepareAgentScratch(runId, "claude");
  assert.ok(claudeScratch.dir.endsWith("claude"));
  assert.equal(agentScratchDir(runId, "claude"), claudeScratch.dir);
  assert.ok(fs.existsSync(claudeScratch.files.settingsPath!), "settings.json should be written");
  assert.ok(fs.existsSync(claudeScratch.stopsDir), "stops/ dir should be created");
  const settingsContent = JSON.parse(fs.readFileSync(claudeScratch.files.settingsPath!, "utf-8"));
  assert.ok(settingsContent.hooks?.Stop, "settings.json should contain a Stop hook");

  const opencodeScratch = prepareAgentScratch(runId, "opencode");
  assert.ok(fs.existsSync(opencodeScratch.files.pluginPath!), "flows-hook.js should be written");
  assert.ok(fs.existsSync(opencodeScratch.files.configPath!), "opencode-config.json should be written");
  const opencodeConfig = JSON.parse(fs.readFileSync(opencodeScratch.files.configPath!, "utf-8"));
  assert.ok(
    Array.isArray(opencodeConfig.plugin) && opencodeConfig.plugin.length === 1,
    `expected exactly one plugin entry, got: ${JSON.stringify(opencodeConfig.plugin)}`,
  );

  const codexScratch = prepareAgentScratch(runId, "codex");
  assert.ok(fs.existsSync(codexScratch.files.notifyScriptPath!), "notify-capture.sh should be written");
  const mode = fs.statSync(codexScratch.files.notifyScriptPath!).mode & 0o777;
  assert.equal(mode, 0o755, `expected notify script mode 0755, got ${mode.toString(8)}`);

  const geminiScratch = prepareAgentScratch(runId, "gemini");
  assert.equal(geminiScratch.stopsDir, "", "gemini (quiescence) scratch should have no stops dir");
  assert.deepEqual(geminiScratch.files, {});
  assert.ok(fs.existsSync(geminiScratch.dir), "gemini scratch dir should still be created for cleanup symmetry");

  cleanupRunScratch(runId);
  assert.ok(!fs.existsSync(runScratchDir(runId)), "run scratch dir should be removed after cleanup");

  // Cleanup of an already-gone dir should not throw.
  cleanupRunScratch(runId);

  console.log("runScratch lifecycle (all agents): OK");
}

function testAgentSupportsInteractive(): void {
  assert.equal(agentSupportsInteractive("claude"), true);
  assert.equal(agentSupportsInteractive("opencode"), true);
  assert.equal(agentSupportsInteractive("codex"), true);
  assert.equal(agentSupportsInteractive("gemini"), true);
  assert.equal(agentSupportsInteractive("custom"), false);
  console.log("agentSupportsInteractive: OK");
}

function testBuildOpencodeHookPlugin(): void {
  const plugin = buildOpencodeHookPlugin("/tmp/oc-stops");
  assert.ok(plugin.includes('"/tmp/oc-stops"'), "plugin source should embed the stops dir as a JSON string literal");
  assert.ok(plugin.includes("session.idle"), "plugin should listen for session.idle");
  assert.ok(plugin.includes("last_assistant_message"), "plugin payload should use the shared field name");
  console.log("buildOpencodeHookPlugin: OK");
}

function testStripJsonComments(): void {
  const input = [
    "{",
    '  // a line comment',
    '  "a": 1, /* inline block */ "b": "value // not a comment",',
    '  "c": "quote: \\" still a string"',
    "}",
  ].join("\n");
  const stripped = stripJsonComments(input);
  const parsed = JSON.parse(stripped);
  assert.deepEqual(parsed, { a: 1, b: "value // not a comment", c: 'quote: " still a string' });
  console.log("stripJsonComments: OK");
}

function testMergeOpencodeConfig(): void {
  const noGlobal = mergeOpencodeConfig(undefined, "file:///a/flows-hook.js");
  assert.deepEqual(noGlobal, { plugin: ["file:///a/flows-hook.js"] });

  const withGlobal = mergeOpencodeConfig(
    JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: ["file:///existing.js"], theme: "dark" }),
    "file:///a/flows-hook.js",
  );
  assert.deepEqual(withGlobal, {
    $schema: "https://opencode.ai/config.json",
    plugin: ["file:///existing.js", "file:///a/flows-hook.js"],
    theme: "dark",
  });

  const withNoPluginArray = mergeOpencodeConfig(JSON.stringify({ theme: "dark" }), "file:///a/flows-hook.js");
  assert.deepEqual(withNoPluginArray, { theme: "dark", plugin: ["file:///a/flows-hook.js"] });

  // Malformed global config falls back to an empty base rather than throwing.
  const malformed = mergeOpencodeConfig("{not json", "file:///a/flows-hook.js");
  assert.deepEqual(malformed, { plugin: ["file:///a/flows-hook.js"] });

  console.log("mergeOpencodeConfig: OK");
}

function testBuildCodexNotifyScript(): void {
  const script = buildCodexNotifyScript("/tmp/codex-stops");
  assert.ok(script.startsWith("#!/bin/sh\n"), "notify script should have a shebang");
  assert.equal(script, `#!/bin/sh\nprintf '%s' "$1" > '/tmp/codex-stops'/notify-$(date +%s%N).json\n`);
  console.log("buildCodexNotifyScript: OK");
}

function testParseStopPayloadVariants(): void {
  // claude
  const claude = parseStopPayload(JSON.stringify({ last_assistant_message: "hi", transcript_path: "/t.jsonl" }));
  assert.equal(claude?.last_assistant_message, "hi");

  // opencode (our own plugin's payload shape)
  const opencode = parseStopPayload(JSON.stringify({ sessionID: "ses_1", last_assistant_message: "done" }));
  assert.equal(opencode?.last_assistant_message, "done");

  // codex (hyphenated field names)
  const codex = parseStopPayload(
    JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "STEP ONE DONE" }),
  );
  assert.equal(codex?.["last-assistant-message"], "STEP ONE DONE");

  console.log("parseStopPayload variants: OK");
}

async function testWatchForNewStopFile(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flows-stopwatch-"));
  try {
    const seen = new Set<string>();

    // A file already present before watching starts should be picked up
    // immediately by the initial check (not just future writes).
    fs.writeFileSync(path.join(dir, "stop-1.json"), "{}", "utf-8");
    const abort1 = new AbortController();
    const found1 = await watchForNewStopFile(dir, seen, abort1.signal);
    assert.equal(found1, "stop-1.json");
    assert.ok(seen.has("stop-1.json"));

    // A second call should not re-report the same file, and should resolve
    // once a genuinely new one appears.
    const abort2 = new AbortController();
    const wait2 = watchForNewStopFile(dir, seen, abort2.signal);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(dir, "stop-2.json"), "{}", "utf-8");
    const found2 = await wait2;
    assert.equal(found2, "stop-2.json");

    // Aborting before anything new appears should resolve with null rather
    // than hanging (no timeouts elsewhere in this mechanism rely on this).
    const abort3 = new AbortController();
    const wait3 = watchForNewStopFile(dir, seen, abort3.signal);
    abort3.abort();
    const found3 = await wait3;
    assert.equal(found3, null);

    console.log("watchForNewStopFile: OK");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (!process.env.FLOWS_HOME) {
    throw new Error("Set FLOWS_HOME to a temp directory before running this smoke test.");
  }

  await testStorage();
  await testFlowPortability();
  testTemplate();
  testRenderParamsOnly();
  await testEngine();
  await testEngineStepStatsOnRetry();
  testBuildAgentCommand();
  await testEngineContinuation();
  await testEngineWrite();
  await testEngineAlertOnFailure();
  await testEngineWorkingDir();
  testConfig();
  testResolveValidator();
  testMaskKey();
  testShellQuote();
  testBuildStopHookSettings();
  testParseStopPayload();
  testExtractLastAssistantMessageFromTranscript();
  testEncodeBracketedPaste();
  testRunScratchLifecycle();
  await testWatchForNewStopFile();
  testAgentSupportsInteractive();
  testBuildOpencodeHookPlugin();
  testStripJsonComments();
  testMergeOpencodeConfig();
  testBuildCodexNotifyScript();
  testParseStopPayloadVariants();

  console.log("OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
