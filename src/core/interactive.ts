// Interactive agent sessions: instead of a one-shot process that exits after
// a single reply, an interactive-capable agent step spawns its CLI as a real
// TUI (prompt auto-submitted as turn 1, or typed as the first turn where the
// CLI doesn't support that) and stays alive so the engine can drive further
// turns (retries, follow-up answers) into the same conversation, and so a
// user can attach and answer questions live.
//
// Two turn-completion strategies, unified behind the InteractiveAgentSession
// interface:
//
//  - Hook-based (claude, opencode, codex): each CLI has some mechanism to run
//    a command / plugin callback when a turn finishes, and we use that to
//    write one small JSON payload file into a scratch "stops" directory per
//    turn. The engine watches that directory rather than waiting for the
//    process to exit (which, in interactive mode, only happens on /exit or a
//    crash). See HOOK_ADAPTERS below for the per-agent wiring — settings.json
//    for claude, a generated plugin + merged config for opencode, a notify
//    script for codex.
//  - Quiescence-based (gemini): no hook mechanism is available, so a turn is
//    considered complete once the PTY has produced no output for
//    QUIESCENCE_MS following at least some output since the turn started.
//    Turn output is reconstructed from the raw bytes since the turn started
//    via the same ptyToText renderer the exec path already uses. This is a
//    simplification — see QuiescenceSession's doc comment for the tradeoffs.
//
// custom commands have no CLI-level interactivity contract Flows can drive,
// so they stay on the exec path.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ptyToText } from "ghostty-opentui";
import type { AgentId } from "../types";
import { AgentSession } from "./session";

// ---------------------------------------------------------------------------
// Output cleaning (shared with the exec path in engine.ts).
// ---------------------------------------------------------------------------

// Matches CSI sequences (ESC [ ... final byte) used as a fallback cleaner
// when ptyToText itself throws on malformed input.
const ANSI_CSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
// Matches OSC sequences (ESC ] ... BEL or ST).
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

function stripAnsiFallback(s: string): string {
  return s.replace(ANSI_OSC_RE, "").replace(ANSI_CSI_RE, "");
}

export function cleanOutput(raw: string, cols: number, rows: number): string {
  try {
    return ptyToText(raw, { cols, rows });
  } catch {
    return stripAnsiFallback(raw);
  }
}

// ---------------------------------------------------------------------------
// Scratch directories — one root per run, one subdirectory per agent used in
// that run (a run can mix agents across steps, each with its own live
// session and its own generated hook files).
// ---------------------------------------------------------------------------

function flowsHome(): string {
  return process.env.FLOWS_HOME ?? path.join(os.homedir(), ".flows");
}

export function runScratchDir(runId: string): string {
  return path.join(flowsHome(), "tmp", runId);
}

export function agentScratchDir(runId: string, agent: AgentId): string {
  return path.join(runScratchDir(runId), agent);
}

export function cleanupRunScratch(runId: string): void {
  try {
    fs.rmSync(runScratchDir(runId), { recursive: true, force: true });
  } catch {
    // Best effort — nothing to do if it's already gone or unwritable.
  }
}

/** POSIX single-quote a path for safe interpolation into a shell command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function ensureStopsDir(dir: string): string {
  const stopsDir = path.join(dir, "stops");
  fs.mkdirSync(stopsDir, { recursive: true });
  return stopsDir;
}

/** Generated per-agent scratch: a stops/ directory (empty for the
 * quiescence agent, which has no hook files) plus any adapter-specific
 * generated file paths, keyed by name (e.g. settingsPath, configPath). */
export interface AgentScratch {
  dir: string;
  stopsDir: string;
  files: Record<string, string>;
}

// ---------------------------------------------------------------------------
// claude: Stop hook.
// ---------------------------------------------------------------------------

/** The claude `settings.json` content that makes every agent turn write one
 * JSON payload file into `stopsDir` when it finishes (the Stop hook). The
 * `$(date +%s%N)` suffix is intentionally left unquoted so the shell expands
 * it — only the (static) directory portion is quoted. */
export function buildStopHookSettings(stopsDir: string): Record<string, unknown> {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: `cat > ${shellQuote(stopsDir)}/stop-$(date +%s%N).json`,
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// opencode: a generated plugin (Stop-equivalent: the "session.idle" event)
// merged into the user's global opencode config so their own plugins/auth
// keep working.
// ---------------------------------------------------------------------------

/** Source for a per-run opencode plugin: on every "session.idle" event
 * (opencode's turn-complete signal), fetches the session's messages via the
 * plugin API client, extracts the last assistant message's text parts, and
 * writes it to a new file in `stopsDir` — same shape/naming scheme as
 * claude's Stop hook payloads (`last_assistant_message`), so the shared
 * stops-dir watcher and payload reader work unchanged. */
export function buildOpencodeHookPlugin(stopsDir: string): string {
  return `export default async function ({ client }) {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;
      try {
        const sessionID = event.properties.sessionID;
        const res = await client.session.messages({ path: { id: sessionID } });
        const data = res.data ?? [];
        let lastText = "";
        for (let i = data.length - 1; i >= 0; i--) {
          const m = data[i];
          if (!m || m.info?.role !== "assistant") continue;
          const parts = m.parts ?? [];
          const texts = parts.filter((p) => p.type === "text").map((p) => p.text);
          lastText = texts.join("\\n").trim();
          if (lastText) break;
        }
        const fs = await import("node:fs");
        const path = await import("node:path");
        const file = path.join(${JSON.stringify(stopsDir)}, \`stop-\${Date.now()}\${process.hrtime.bigint()}.json\`);
        fs.writeFileSync(file, JSON.stringify({ sessionID, last_assistant_message: lastText }));
      } catch {
        // Best-effort — a missed write just means this turn's stop file
        // doesn't appear; the engine has no timeout here, so it keeps
        // waiting for the next one rather than hanging on a silent throw.
      }
    },
  };
}
`;
}

/** Best-effort JSONC comment stripper: removes `//` line comments and
 * `/* ... *\/` block comments that appear outside string literals. Not a
 * full JSON5 parser — good enough for hand-authored config files with
 * simple comments, which is what opencode.jsonc files are in practice. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) inString = false;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Merges our generated plugin into the user's global opencode config
 * (rather than replacing it wholesale — OPENCODE_CONFIG otherwise clobbers
 * their own plugins/settings). `globalConfigText` is the raw file contents
 * if a global config exists, undefined otherwise (auth lives elsewhere and
 * survives regardless). Malformed config falls back to an empty base rather
 * than throwing, since this is best-effort merging of a file we don't own. */
export function mergeOpencodeConfig(
  globalConfigText: string | undefined,
  pluginFileUrl: string,
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  if (globalConfigText) {
    try {
      const parsed: unknown = JSON.parse(stripJsonComments(globalConfigText));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }
  const existingPlugins = Array.isArray(base.plugin) ? (base.plugin as unknown[]) : [];
  return { ...base, plugin: [...existingPlugins, pluginFileUrl] };
}

function opencodeGlobalConfigPath(): string | undefined {
  const dir = path.join(os.homedir(), ".config", "opencode");
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

function readOpencodeGlobalConfig(): string | undefined {
  const p = opencodeGlobalConfigPath();
  if (!p) return undefined;
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// codex: the `notify` program (invoked with the event JSON as argv[1] on
// events including "agent-turn-complete", which carries the turn's final
// assistant message).
// ---------------------------------------------------------------------------

/** A tiny notify-capture script: codex invokes it as `<script> <json>` on
 * every notify-worthy event; this writes that JSON verbatim to a new file in
 * `stopsDir`, using the same naming scheme as the other adapters. */
export function buildCodexNotifyScript(stopsDir: string): string {
  return `#!/bin/sh\nprintf '%s' "$1" > ${shellQuote(stopsDir)}/notify-$(date +%s%N).json\n`;
}

// ---------------------------------------------------------------------------
// Stop/notify payload parsing (shared JSON-file-in-a-directory mechanism).
// ---------------------------------------------------------------------------

/** Parses a stop/notify payload file's contents. Returns undefined (rather
 * than throwing) on invalid JSON — a partially-written file can be read
 * mid-write since these hooks write non-atomically. */
export function parseStopPayload(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function readStopFile(stopsDir: string, filename: string): Record<string, unknown> | undefined {
  try {
    const raw = fs.readFileSync(path.join(stopsDir, filename), "utf-8");
    return parseStopPayload(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transcript fallback (claude only): when a Stop payload has no
// last_assistant_message (or there is no Stop payload at all, e.g. the
// process crashed), fall back to scanning the transcript JSONL for the last
// assistant text.
// ---------------------------------------------------------------------------

/** Scans a transcript JSONL blob (one JSON object per line) for the last
 * assistant message's text content, joining multiple text blocks within
 * that message with "\n". Malformed lines are skipped. Returns undefined if
 * no assistant text is found anywhere in the transcript. */
export function extractLastAssistantMessageFromTranscript(jsonlText: string): string | undefined {
  let last: string | undefined;
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    if (rec.type !== "assistant") continue;
    const message = rec.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter((b): b is { type: string; text: string } => {
        return (
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>).type === "text" &&
          typeof (b as Record<string, unknown>).text === "string"
        );
      })
      .map((b) => b.text);
    const joined = texts.join("\n").trim();
    if (joined) last = joined;
  }
  return last;
}

export function readTranscriptLastMessage(transcriptPath: string | undefined): string | undefined {
  if (!transcriptPath) return undefined;
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    return extractLastAssistantMessageFromTranscript(raw);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Bracketed paste — how the engine types a prompt into a live TUI. Verified
// against claude, opencode, and codex's input boxes, and gemini's; none leak
// the paste markers into the submitted text.
// ---------------------------------------------------------------------------

export function encodeBracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`;
}

// ---------------------------------------------------------------------------
// Directory watching for new stop/notify files.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 250;

/** Resolves with the filename of the first payload file that appears in
 * `stopsDir` and isn't already in `seen` (added to `seen` immediately once
 * found), or with null if `signal` aborts first. Polls rather than relying
 * solely on fs.watch, which can be flaky depending on platform/filesystem. */
export function watchForNewStopFile(
  stopsDir: string,
  seen: Set<string>,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    function finish(value: string | null) {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }

    function onAbort() {
      finish(null);
    }

    function check() {
      let entries: string[];
      try {
        entries = fs.readdirSync(stopsDir);
      } catch {
        return;
      }
      for (const f of entries) {
        if (!f.endsWith(".json") || seen.has(f)) continue;
        seen.add(f);
        finish(f);
        return;
      }
    }

    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener("abort", onAbort);

    check();
    if (!settled) timer = setInterval(check, POLL_INTERVAL_MS);
  });
}

function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Shared session interface.
// ---------------------------------------------------------------------------

export interface TurnResult {
  /** The turn's final assistant message (from the hook payload / transcript
   * fallback, or the quiescence-reconstructed terminal text), or "" if
   * nothing could be extracted. */
  output: string;
  /** True when the underlying process exited instead of completing a turn
   * normally (crash, /exit, etc.) — the session is no longer usable. */
  sessionEnded: boolean;
  /** True when the wait was cut short by the caller's AbortSignal rather
   * than by a real turn completing. output is always "" in this case. */
  aborted: boolean;
  exitCode?: number;
}

/** Uniform surface the engine drives regardless of which agent/mechanism is
 * behind it — see HookBasedSession (claude/opencode/codex) and
 * QuiescenceSession (gemini). */
export interface InteractiveAgentSession {
  readonly session: AgentSession;
  sendTurn(text: string): Promise<void>;
  awaitTurn(signal: AbortSignal): Promise<TurnResult>;
  /** Synchronous, no-poll-delay check for a turn that already completed —
   * see HookBasedSession's implementation for why this exists. */
  checkPendingTurn(): TurnResult | null;
  resize(cols: number, rows: number): void;
  write(data: string): void;
  kill(): void;
}

const PASTE_SUBMIT_DELAY_MS = 150;

// ---------------------------------------------------------------------------
// HookBasedSession — claude, opencode, codex: a live TUI session whose turn
// completion is signalled by a generated hook/plugin/notify mechanism
// writing a JSON file into a scratch directory.
// ---------------------------------------------------------------------------

/** Per-agent wiring for HookBasedSession: how to prepare its generated
 * files, how to spawn it (prompt baked into argv — proven to auto-submit as
 * turn 1 for all three), and how to pull turn output out of its payload
 * shape (field names differ per agent). */
interface HookAdapter {
  prepareScratch(runId: string): AgentScratch;
  buildSpawnCommand(prompt: string, cwd: string, scratch: AgentScratch): { cmd: string[]; env?: Record<string, string> };
  extractOutput(payload: Record<string, unknown>): { output: string; transcriptPath?: string };
}

const claudeHookAdapter: HookAdapter = {
  prepareScratch(runId) {
    const dir = agentScratchDir(runId, "claude");
    const stopsDir = ensureStopsDir(dir);
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify(buildStopHookSettings(stopsDir), null, 2), "utf-8");
    return { dir, stopsDir, files: { settingsPath } };
  },
  buildSpawnCommand(prompt, _cwd, scratch) {
    return { cmd: ["claude", prompt, "--permission-mode", "acceptEdits", "--settings", scratch.files.settingsPath!] };
  },
  extractOutput(payload) {
    return {
      output: typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "",
      transcriptPath: typeof payload.transcript_path === "string" ? payload.transcript_path : undefined,
    };
  },
};

const opencodeHookAdapter: HookAdapter = {
  prepareScratch(runId) {
    const dir = agentScratchDir(runId, "opencode");
    const stopsDir = ensureStopsDir(dir);
    const pluginPath = path.join(dir, "flows-hook.js");
    fs.writeFileSync(pluginPath, buildOpencodeHookPlugin(stopsDir), "utf-8");
    const merged = mergeOpencodeConfig(readOpencodeGlobalConfig(), `file://${pluginPath}`);
    const configPath = path.join(dir, "opencode-config.json");
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");
    return { dir, stopsDir, files: { configPath, pluginPath } };
  },
  buildSpawnCommand(prompt, cwd, scratch) {
    // --auto: auto-approve permissions, mirroring claude's --permission-mode
    // acceptEdits — without it, opencode's TUI would block on a permission
    // prompt nobody is attached to answer non-interactively.
    return {
      cmd: ["opencode", "--prompt", prompt, "--auto", cwd],
      env: { OPENCODE_CONFIG: scratch.files.configPath! },
    };
  },
  extractOutput(payload) {
    return { output: typeof payload.last_assistant_message === "string" ? payload.last_assistant_message : "" };
  },
};

const codexHookAdapter: HookAdapter = {
  prepareScratch(runId) {
    const dir = agentScratchDir(runId, "codex");
    const stopsDir = ensureStopsDir(dir);
    const scriptPath = path.join(dir, "notify-capture.sh");
    fs.writeFileSync(scriptPath, buildCodexNotifyScript(stopsDir), "utf-8");
    fs.chmodSync(scriptPath, 0o755);
    return { dir, stopsDir, files: { notifyScriptPath: scriptPath } };
  },
  buildSpawnCommand(prompt, cwd, scratch) {
    const notifyArg = JSON.stringify([scratch.files.notifyScriptPath!]);
    // -a never -s workspace-write: never prompt for approval (nobody's
    // attached to answer non-interactively), but keep edits scoped to the
    // working directory — the closest codex equivalent of claude's
    // --permission-mode acceptEdits.
    return {
      cmd: ["codex", prompt, "-c", `notify=${notifyArg}`, "-C", cwd, "-a", "never", "-s", "workspace-write"],
    };
  },
  extractOutput(payload) {
    const raw = payload["last-assistant-message"];
    return { output: typeof raw === "string" ? raw : "" };
  },
};

const HOOK_ADAPTERS: Partial<Record<AgentId, HookAdapter>> = {
  claude: claudeHookAdapter,
  opencode: opencodeHookAdapter,
  codex: codexHookAdapter,
};

export interface HookBasedSessionOptions {
  adapter: HookAdapter;
  cmd: string[];
  env?: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
  stopsDir: string;
  onData: (chunk: string) => void;
}

export class HookBasedSession implements InteractiveAgentSession {
  readonly session: AgentSession;
  private readonly stopsDir: string;
  private readonly seen: Set<string>;
  private readonly adapter: HookAdapter;
  private lastTranscriptPath: string | undefined;

  constructor(opts: HookBasedSessionOptions) {
    this.adapter = opts.adapter;
    this.stopsDir = opts.stopsDir;
    // Pre-seed with whatever payload files already exist so a fresh session
    // sharing a run's stopsDir with a prior (killed) session doesn't
    // misread that session's leftover files as its own turn completing.
    this.seen = new Set(safeReaddir(opts.stopsDir));

    this.session = new AgentSession({
      cmd: opts.cmd,
      env: opts.env,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      onData: opts.onData,
    });
  }

  /** Types `text` into the live TUI as a new turn (bracketed paste + Enter). */
  async sendTurn(text: string): Promise<void> {
    this.session.write(encodeBracketedPaste(text));
    await new Promise((r) => setTimeout(r, PASTE_SUBMIT_DELAY_MS));
    this.session.write("\r");
  }

  private resolveFromFile(filename: string): TurnResult {
    const payload = readStopFile(this.stopsDir, filename);
    if (!payload) return { output: "", sessionEnded: false, aborted: false };
    const { output: rawOutput, transcriptPath } = this.adapter.extractOutput(payload);
    if (transcriptPath) this.lastTranscriptPath = transcriptPath;
    let output = rawOutput.trim();
    if (!output && transcriptPath) output = readTranscriptLastMessage(transcriptPath) ?? "";
    return { output, sessionEnded: false, aborted: false };
  }

  async awaitTurn(signal: AbortSignal): Promise<TurnResult> {
    const localAbort = new AbortController();
    const forwardAbort = () => localAbort.abort();
    signal.addEventListener("abort", forwardAbort);

    try {
      const stopWait = watchForNewStopFile(this.stopsDir, this.seen, localAbort.signal).then(
        (file) => ({ kind: "stop" as const, file }),
      );
      const exitWait = this.session.exited.then((code) => ({ kind: "exit" as const, code }));

      const winner = await Promise.race([stopWait, exitWait]);

      if (winner.kind === "exit") {
        const output = readTranscriptLastMessage(this.lastTranscriptPath) ?? "";
        return { output, sessionEnded: true, aborted: false, exitCode: winner.code };
      }

      if (winner.file === null) {
        return { output: "", sessionEnded: false, aborted: true };
      }

      return this.resolveFromFile(winner.file);
    } finally {
      signal.removeEventListener("abort", forwardAbort);
      if (!localAbort.signal.aborted) localAbort.abort();
    }
  }

  /** Synchronous, one-shot check for a payload file that's already on disk
   * and not yet consumed — no polling delay. Used to avoid losing a turn
   * that completed in the same instant an abort (e.g. continueFlow())
   * fires, before the next scheduled poll tick would have picked it up. */
  checkPendingTurn(): TurnResult | null {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.stopsDir);
    } catch {
      return null;
    }
    for (const f of entries) {
      if (!f.endsWith(".json") || this.seen.has(f)) continue;
      this.seen.add(f);
      return this.resolveFromFile(f);
    }
    return null;
  }

  resize(cols: number, rows: number): void {
    this.session.resize(cols, rows);
  }

  write(data: string): void {
    this.session.write(data);
  }

  kill(): void {
    this.session.kill();
  }
}

// ---------------------------------------------------------------------------
// QuiescenceSession — gemini: no hook mechanism, so a turn is considered
// complete once the PTY goes quiet for QUIESCENCE_MS after producing some
// output. gemini's CLI (as installed: 0.1.7) has no flag to pre-fill the
// initial prompt into an interactive session, so the session is spawned bare
// and the prompt is typed as the first turn — which also means the first
// awaitTurn() call has to wait out gemini's own startup churn (splash
// screen, an observed ~20s auth-refresh retry loop) before it can type.
//
// Limitation: turn output is reconstructed by re-rendering only the raw
// bytes since the turn's boundary through ptyToText, not a real incremental
// diff against a persistent virtual terminal — simple, and clean in every
// case observed during testing (the CLI fully redraws its prompt/input box
// after each submission), but a turn boundary that lands mid-escape-sequence
// could in principle produce a few garbled leading characters.
// ---------------------------------------------------------------------------

const QUIESCENCE_MS = 3000;
const QUIESCENCE_POLL_MS = 300;

export interface QuiescenceSessionOptions {
  cmd: string[];
  cwd: string;
  cols: number;
  rows: number;
  onData: (chunk: string) => void;
  /** Sent as the first turn once startup churn settles (see class doc). */
  initialPrompt: string;
}

export class QuiescenceSession implements InteractiveAgentSession {
  readonly session: AgentSession;
  private cols: number;
  private rows: number;
  private lastChunkAt = Date.now();
  private hasOutputSinceBoundary = false;
  private boundaryRawLen = 0;
  private pendingInitialPrompt: string | undefined;

  constructor(opts: QuiescenceSessionOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.pendingInitialPrompt = opts.initialPrompt;
    this.session = new AgentSession({
      cmd: opts.cmd,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      onData: (chunk) => {
        this.lastChunkAt = Date.now();
        this.hasOutputSinceBoundary = true;
        opts.onData(chunk);
      },
    });
  }

  async sendTurn(text: string): Promise<void> {
    this.boundaryRawLen = this.session.raw.length;
    this.hasOutputSinceBoundary = false;
    this.session.write(encodeBracketedPaste(text));
    await new Promise((r) => setTimeout(r, PASTE_SUBMIT_DELAY_MS));
    this.session.write("\r");
  }

  private extractTurnOutput(): string {
    const delta = this.session.raw.slice(this.boundaryRawLen);
    return cleanOutput(delta, this.cols, this.rows).trim();
  }

  private waitForQuiescence(signal: AbortSignal): Promise<TurnResult> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setInterval> | null = null;

      const finish = (r: TurnResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(r);
      };
      const onAbort = () => finish({ output: "", sessionEnded: false, aborted: true });

      if (signal.aborted) {
        finish({ output: "", sessionEnded: false, aborted: true });
        return;
      }
      signal.addEventListener("abort", onAbort);

      this.session.exited.then((code) =>
        finish({ output: this.extractTurnOutput(), sessionEnded: true, aborted: false, exitCode: code }),
      );

      timer = setInterval(() => {
        if (this.hasOutputSinceBoundary && Date.now() - this.lastChunkAt >= QUIESCENCE_MS) {
          finish({ output: this.extractTurnOutput(), sessionEnded: false, aborted: false });
        }
      }, QUIESCENCE_POLL_MS);
    });
  }

  async awaitTurn(signal: AbortSignal): Promise<TurnResult> {
    if (this.pendingInitialPrompt !== undefined) {
      const prompt = this.pendingInitialPrompt;
      this.pendingInitialPrompt = undefined;
      // Wait out startup churn (splash screen, possible auth refresh) before
      // typing — a fixed short delay isn't reliable here (auth refresh alone
      // took ~20s in testing); reusing the quiescence wait handles this
      // naturally since it only resolves once output has actually stopped.
      const startupResult = await this.waitForQuiescence(signal);
      if (startupResult.aborted || startupResult.sessionEnded) return startupResult;
      await this.sendTurn(prompt);
    }
    return this.waitForQuiescence(signal);
  }

  checkPendingTurn(): TurnResult | null {
    if (this.hasOutputSinceBoundary && Date.now() - this.lastChunkAt >= QUIESCENCE_MS) {
      return { output: this.extractTurnOutput(), sessionEnded: false, aborted: false };
    }
    return null;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.session.resize(cols, rows);
  }

  write(data: string): void {
    this.session.write(data);
  }

  kill(): void {
    this.session.kill();
  }
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------

/** Agents that run as a real interactive TUI session rather than a one-shot
 * process. Custom commands have no CLI-level interactivity contract Flows
 * can drive and stay on the exec path. */
export function agentSupportsInteractive(agent: AgentId): boolean {
  return agent === "claude" || agent === "opencode" || agent === "codex" || agent === "gemini";
}

export function prepareAgentScratch(runId: string, agent: AgentId): AgentScratch {
  const adapter = HOOK_ADAPTERS[agent];
  if (adapter) return adapter.prepareScratch(runId);
  // Quiescence agent (gemini): no generated hook files, just its own
  // subdirectory for symmetry with the hook agents' cleanup.
  const dir = agentScratchDir(runId, agent);
  fs.mkdirSync(dir, { recursive: true });
  return { dir, stopsDir: "", files: {} };
}

export interface CreateInteractiveSessionOptions {
  prompt: string;
  cwd: string;
  cols: number;
  rows: number;
  scratch: AgentScratch;
  onData: (chunk: string) => void;
}

export function createInteractiveSession(agent: AgentId, opts: CreateInteractiveSessionOptions): InteractiveAgentSession {
  const adapter = HOOK_ADAPTERS[agent];
  if (adapter) {
    const built = adapter.buildSpawnCommand(opts.prompt, opts.cwd, opts.scratch);
    return new HookBasedSession({
      adapter,
      cmd: built.cmd,
      env: built.env,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      stopsDir: opts.scratch.stopsDir,
      onData: opts.onData,
    });
  }
  if (agent === "gemini") {
    return new QuiescenceSession({
      cmd: ["gemini"],
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      onData: opts.onData,
      initialPrompt: opts.prompt,
    });
  }
  throw new Error(`Agent "${agent}" does not support interactive sessions`);
}
