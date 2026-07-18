# Exploration: Ghostty-backed terminal sessions per agent

**Status: all three phases implemented — Phase 1 (PTY execution + terminal pane), Phase 2 (--continue chaining), and Phase 3 (attach/takeover).** This doc records what the
Ghostty library ecosystem offers, what was proven in a spike, and a proposed
design for giving each agent step a real terminal session inside Flows.

## Why

Today (`src/core/engine.ts`) each step runs the agent CLI headlessly via
`Bun.spawn` with piped stdout/stderr. That works, but:

- Agents see a non-TTY, so they disable colors, progress rendering, and
  anything interactive. Some CLIs behave differently or refuse features
  without a TTY.
- Our run screen shows a flat text log; full-screen agent output (spinners,
  progress bars, redraws) would render as garbage if an agent emitted it.
- There is no path to "attach" to a running agent and interact with it.

Running each agent inside a **PTY we own**, and interpreting its output with a
**real terminal emulation library**, removes all three limits.

## What Ghostty provides (and what it doesn't)

[Ghostty](https://ghostty.org) is decomposing its core into **libghostty** —
"a cross-platform, zero-dependency C and Zig library for building terminal
emulators or utilizing terminal functionality." The first shipped piece is
**libghostty-vt**: VT sequence parsing and full terminal state (grid, styles,
cursor, scrollback, OSC/SGR, Kitty keyboard/graphics), with C/Zig APIs and
WASM support. It is battle-tested (it *is* Ghostty's emulation core) but the
API is still pre-1.0.

Explicitly **not** in libghostty-vt: PTY spawning, process management,
rendering. Embedders bring their own.

### The pieces that fit our stack

| Need | Package | Notes |
|---|---|---|
| Terminal emulation | `ghostty-opentui` (npm) | libghostty-vt via N-API for Bun/Node. `ptyToJson` (styled grid), `ptyToText` (clean text), plus a **`GhosttyTerminalRenderable` OpenTUI component** — a `<ghostty-terminal>` element for our exact UI library. Linux/macOS native; Windows text-only fallback. |
| PTY spawning | `bun-pty` (npm) | Native PTY for Bun: `spawn`, `write`, `resize`, `onData`, `kill`. ~390k downloads/month. |
| Alternative bindings | `@coder/libghostty-vt-node`, `ghostty-web` | Node-API and WASM bindings if we ever need them. |

### Ghostling — the official reference embedder

[`ghostty-org/ghostling`](https://github.com/ghostty-org/ghostling) is
Ghostty's minimal reference terminal: a single-file C program that wires a PTY
into libghostty-vt and renders the resulting grid with Raylib. It is the
canonical demonstration of the intended embedding pattern — *the embedder
supplies the PTY and the renderer; libghostty-vt does everything in between*
(parsing, state, reflow, scrollback, Kitty keyboard input encoding).

That is precisely the shape proposed below, with our stack's equivalents:
`bun-pty` in place of Ghostling's C PTY glue, and OpenTUI (via
`ghostty-opentui`'s renderable) in place of Raylib. We get Ghostling's
architecture without writing C — the npm bindings wrap the same library.

## Spike results (validated in this container)

1. **`bun-pty` works under Bun 1.3**: spawned an interactive bash in a PTY,
   wrote input, resized live (`pty.resize(120, 40)`), captured output, killed
   cleanly.
2. **`ptyToText` produces clean, LLM-ready text** from raw ANSI session bytes —
   exactly what the validator wants instead of raw escape-laden output.
3. **Full-screen TUI state reconstructs faithfully**: feeding a mid-session
   capture of Flows' own run screen (alternate screen, box drawing, colors)
   through `ptyToText` reproduced the frame text-perfectly.
4. **`ptyToJson` returns styled spans** (`{text, fg, bg, flags}` per span) —
   the input a renderer needs.

One caveat found: after a TUI process exits it leaves the alternate screen, so
the *final* buffer is empty. Session state must be read **while the session is
live** (grid snapshots), not from the byte stream after exit. That is exactly
the model we want anyway.

## Proposed design

### Phase 1 — PTY execution + terminal pane (low risk, high payoff)

Keep today's one-process-per-step model, but run it in a PTY:

- `src/core/session.ts`: `AgentSession` wrapping `bun-pty` — spawn the same
  headless commands `buildAgentCommand` produces, `onData` accumulates raw
  bytes, `resize` follows the UI pane, kill on cancel. Engine change is small:
  swap `Bun.spawn` for `AgentSession` in the attempt loop; completion is still
  process exit.
- Run screen: register `GhosttyTerminalRenderable` via `extend()` and replace
  the hand-rolled log pane with `<ghostty-terminal ansi={sessionBytes}>` —
  agents now render colors/progress exactly as in a real terminal.
- Validator input becomes `ptyToText(rawBytes)` — cleaner than raw stdout when
  agents emit ANSI.

### Phase 2 — persistent sessions per agent

**Implemented:** the `--continue`-chaining route below, gated per run: a step's
effective continuation is `step.continueSession && agentSupportsContinuation(agent)
&& sessionStarted.has(agent+cwd)` — so the first step for a given (agent, working
directory) pair in a run always starts fresh, subsequent steps/retries for that pair
resume it, and unsupported agents (Gemini) emit a `session-note` and run fresh. The
generic interactive-persistent-PTY route remains future work.

Two complementary routes:

- **Claude Code, robustly**: keep headless calls but chain them with
  `claude -p --continue` (or `--resume <session-id>`) in the same PTY working
  directory — real conversational continuity across steps with a
  machine-readable completion signal (process exit), no TUI driving.
- **Generic interactive sessions**: keep one PTY alive per agent for the whole
  flow; steps are written as input. Requires idle/prompt detection to know when
  a step is "done" — heuristic (output quiescence) and therefore best kept
  opt-in per step (`sessionMode: "persistent"`).

### Phase 3 — attach/takeover (the endgame)

Because Flows owns the PTY and the emulation, the run screen can offer
"press `a` to attach": forward OpenTUI keyboard events as bytes to the PTY and
render the live grid — Flows becomes a small terminal multiplexer for its
agents, tmux-style. libghostty-vt's input-encoding APIs (Kitty keys, mouse
SGR) cover the encoding side when we need fidelity beyond printable keys.

**Implemented:** `a` attaches while a flow is running (`RunScreen`); every
keypress is forwarded raw to the live step's PTY via `RunHandle.write()` (new
in `src/types.ts`/`src/core/engine.ts`/`src/core/session.ts`), using
`KeyEvent.raw` (falling back to `.sequence`) so control sequences and Kitty
keyboard-protocol bytes pass through unmodified; pastes forward too via
`usePaste` + `decodePasteBytes`. `ctrl+]` (`raw === "\x1d"`) detaches. Because
OpenTUI 0.4.5's `exitOnCtrlC` renderer option destroys the app unconditionally
and ignores `preventDefault()`, `index.tsx` now passes `exitOnCtrlC: false`
and `src/ui/App.tsx` owns global ctrl+c-to-quit itself, gated on a small
attach flag (`src/ui/attach-state.ts`) so ctrl+c reaches the agent instead of
quitting Flows while attached.

## Risks & mitigations

- **Pre-1.0 APIs** (libghostty-vt, ghostty-opentui): pin versions; our surface
  area is 3 functions + 1 renderable.
- **Native modules** (bun-pty, ghostty-opentui N-API): both ship prebuilds for
  Linux/macOS x64+arm64; Windows degrades to text-only parsing — acceptable
  (flows still run; pane falls back to the current log view).
- **Completion detection in persistent interactive mode**: inherently
  heuristic; mitigated by keeping Phase 2's `--continue` route as the default
  for Claude Code and making interactive persistence opt-in.

## Recommendation

Adopt Phase 1 now (small, isolated change; immediate UX and validator
improvements), Phase 2's `--continue` chaining for Claude Code next, and treat
Phase 3 as a feature milestone once panes are in.
