# Flows

A terminal UI for orchestrating coding agents. You define a **flow** — a sequence of
steps, each with a prompt, a coding agent to run it, and a desired result — and Flows
runs it end-to-end, using a built-in LLM connection to validate each step's output
before moving on.

Built with [OpenTUI](https://opentui.com/) (`@opentui/react`) on Bun.

## What it does

- **Build flows** in an interactive workflow creator: name, description, typed
  parameters, and any number of steps.
- **Run flows** with parameters: Flows prompts you for the values the flow declares,
  then executes each step in order in your chosen coding agent, streaming output live.
- **Validate results**: after each step, a configurable validator LLM judges the
  agent's output against the step's desired result. Failed steps are retried with the
  validator's feedback sent as a follow-up turn in the same conversation, up to a
  per-step retry limit.
- **Answer the agent's questions**: agents run as real interactive terminal sessions
  inside the app. When a step's output asks you something (the validator detects it,
  or the step opts in with "Pause for review"), the run pauses in an
  **awaiting-input** state — press `a` to attach and type your answer straight into
  the agent's own UI. The flow resumes when the validator sees the questions
  resolved, or immediately when you press `f`.
- **Attach any time**: while a step runs you can attach and watch or intervene —
  including answering the agent CLI's own permission prompts. Sessions survive the
  end of the flow, so you can keep talking to the agent after the last step
  completes.
- **Delete flows** from the same UI.
- **Configure the validator** in Settings: pick a provider (Anthropic, OpenAI, Google,
  or a custom OpenAI-compatible endpoint), model, and API key without leaving the app.

## Supported agents

The first four agents run **interactively** — Flows launches the agent's own
terminal UI inside a PTY and drives it turn by turn. "Turn finished" is detected
with a per-agent mechanism, so there are no fragile timeouts for the three CLIs
that expose a hook:

| Agent | Invocation | Turn detection |
|---|---|---|
| Claude Code | `claude <prompt> --permission-mode acceptEdits --settings <generated>` | `Stop` hook (generated settings file) writes a payload with the last assistant message |
| OpenCode | `opencode --prompt <prompt> --auto <cwd>` with `OPENCODE_CONFIG=<generated>` | generated plugin listens for `session.idle` and fetches the last assistant message via the SDK |
| Codex CLI | `codex <prompt> -c notify=[…] -C <cwd> -a never -s workspace-write` | `notify` program receives `agent-turn-complete` with the last assistant message |
| Gemini CLI | `gemini` (prompt typed as the first turn) | output quiescence (~3s of silence) — heuristic; step output may include some UI chrome |
| Custom | Any shell command; the rendered prompt is exposed as `$FLOW_PROMPT` | process exit (non-interactive) |

The generated hook files live under `$FLOWS_HOME/tmp/<runId>/<agent>/` and are
removed when the run's sessions close. For OpenCode, the generated config is your
global `~/.config/opencode/opencode.json(c)` merged with the plugin entry, so your
providers and settings still apply. Permission handling mirrors Claude's
`acceptEdits`: OpenCode gets `--auto` and Codex gets `-a never -s workspace-write`
so unattended runs don't stall on approval prompts nobody is attached to answer;
anything an agent does still ask is answerable by attaching.

Each step chooses its own agent, so a single flow can mix agents (e.g. implement with
Claude Code, review with a second agent) — each agent keeps its own live session.

Steps can also set "Continue session" to chain into the same agent conversation as
the previous step that used the same agent + working directory in the current run.
For interactive agents the next step's prompt is simply typed into the live session
(bracketed paste), so continuation works for all of them — including Gemini; custom
commands get `$FLOW_CONTINUE`. The first step of a run for a given agent + working
directory always starts fresh, even with the toggle on.

Agents run inside a real PTY (via `bun-pty`), so they see a proper terminal —
colors, progress rendering, TTY-gated behavior all work. The run screen renders
the live session through Ghostty's terminal emulation
([`ghostty-opentui`](https://www.npmjs.com/package/ghostty-opentui), built on
libghostty-vt), and the validator receives clean per-turn text from the agent's
own completion hook rather than scraped terminal bytes. See
`docs/ghostty-terminal-sessions.md` for the design history.

## Install & run

Requires [Bun](https://bun.sh) and at least one coding agent CLI on your PATH.

```sh
bun install
export ANTHROPIC_API_KEY=sk-ant-...   # needed for step validation (default provider)
bun run start
```

### Validator LLM configuration

The validator judges each step's output against its expected result. It's configured
per-provider, resolved in this order:

1. **Settings screen** (`s` from the flow list) — provider, model, API key, and (for
   the custom provider) base URL, stored in `$FLOWS_HOME/config.json`.
2. **`config.json` env-var fallback** — any field left blank in Settings falls back to
   an environment variable for that provider (see table below). The default provider
   is Anthropic with model `claude-opus-4-8` if nothing is configured at all.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | — | API key fallback for the Anthropic validator provider |
| `OPENAI_API_KEY` | — | API key fallback for the OpenAI and custom (OpenAI-compatible) validator providers |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | API key fallback for the Google validator provider |
| `FLOWS_VALIDATOR_MODEL` | `claude-opus-4-8` | Model fallback for the Anthropic validator provider |
| `FLOWS_HOME` | `~/.flows` | Where flow definitions and `config.json` are stored |

**Security note:** the API key entered in Settings is written to
`$FLOWS_HOME/config.json` in plain text, with file permissions restricted to `0600`
(owner read/write only). Leave the field blank in Settings to rely on the environment
variable instead of persisting a key to disk.

### Troubleshooting

**`Cannot find module 'react/jsx-dev-runtime'` (or `Cannot find package 'react'`) with a
`.bun/install/cache/...` path** — the project's `node_modules` is missing, so Bun
auto-installed `@opentui/react` into its global cache, where the `react` peer can't be
resolved. Run `bun install` in the repo root, then `bun run start`. If it persists,
check you're in the repo root and `node_modules/react` exists; `bun install --force`
rebuilds it.

## Using the app

- **Flow list** — `enter` run · `n` new flow · `e` edit · `d` delete · `s` settings · `q` quit
- **Flow editor** — arrow keys to move, `enter` to edit a field or open a section,
  save/cancel actions at the bottom, `esc` to go back. A flow can set a default
  **working directory** (supports `{{params.<name>}}`, e.g. `{{params.repoPath}}`)
  used by every step that doesn't set its own.
- **Steps** — each step has: name, agent, prompt template, desired result,
  validation on/off, max retries, optional working directory (overrides the
  flow's default; also supports `{{params.*}}` and a leading `~`)
- **Steps** (additional options) — "Continue session" chains into the previous
  step's conversation; "Pause for review" always pauses after the step so you can
  talk to the agent before the flow moves on
- **Run screen** — live per-step checklist next to the agent's real terminal.
  - `a` attaches: every keystroke goes to the agent's TUI (type answers, drive its
    menus, answer its permission prompts); `ctrl+]` detaches. `ctrl+c` quits Flows
    everywhere except while attached, where it's sent to the agent instead.
  - When the agent asks you something, the run pauses as **awaiting-input** (the
    pane border highlights and the hint changes): `a` attach & answer, `f` continue
    the flow without further answers, `c` cancel. With validation on, the flow
    auto-continues once a later turn passes and asks nothing further.
  - Scrollback while detached: `PgUp`/`PgDn` page, `shift+↑`/`shift+↓` step; output
    auto-follows the bottom until you scroll up.
  - After the flow finishes, the last agent session stays alive — attach and keep
    working with it until you close it or start another run.
  - `esc` leaves the screen with the run (and its sessions) continuing in the
    background; resume it from the flow list or history.
- **Run history** (`h` on a flow) — every run with status, params, duration:
  `complete`, `failed`, `cancelled`, `running`/`awaiting input` (live, enter to
  re-attach), or `interrupted` (Flows exited while it ran; marked at next startup).

### Prompt templates

Step prompts support placeholders:

- `{{params.<name>}}` — a flow parameter value
- `{{steps.<stepName>.output}}` — an earlier step's output: every assistant turn
  of that step (including answers it gave after you replied to its questions),
  joined with `---` separators

so later steps can build on earlier results, e.g.

> Review the changes described below and fix any issues:
> `{{steps.implement.output}}`

## Architecture

```
index.tsx            entry point (createCliRenderer + createRoot)
src/types.ts         shared contract (Flow, FlowStep, RunEvent, ...)
src/core/
  storage.ts         JSON persistence in $FLOWS_HOME/flows
  config.ts          validator LLM config persistence ($FLOWS_HOME/config.json) + resolution
  agents.ts          agent registry + exec-mode command builders
  session.ts         PTY-backed agent sessions (bun-pty)
  interactive.ts     interactive-session adapters: per-agent spawn + turn detection
                     (claude Stop hook, opencode session.idle plugin, codex notify,
                     gemini quiescence), scratch/hook file management
  template.ts        {{...}} interpolation
  validator.ts       multi-provider structured-output validation (Anthropic/OpenAI/Google/custom)
                     + follow-up-question detection (needsUserInput)
  engine.ts          sequential run loop, interactive turn loop, awaiting-input gate,
                     retries, cancellation
  runManager.ts      in-memory registry of active runs (survives leaving the run screen),
                     attach/continue/cancel surface, startup sweep of interrupted runs
  runStore.ts        run history persistence in $FLOWS_HOME/runs
src/ui/
  App.tsx            screen router + global ctrl+c/attach gating
  FlowList.tsx       main menu (offers resume of live runs)
  FlowEditor.tsx     workflow creator
  StepEditor.tsx     per-step form (agent, validation, continue session, pause for review)
  RunParamsForm.tsx  parameter entry
  RunScreen.tsx      live run view: terminal pane, attach/scrollback, awaiting-input keys
  RunHistory.tsx     per-flow run history
  RunDetail.tsx      finished-run inspection (per-step outputs)
  ConfirmDelete.tsx  delete confirmation
  SettingsScreen.tsx validator LLM configuration
```

The engine emits typed `RunEvent`s (step-start, agent-output, validation-result,
step-retry, flow-complete, ...) that the run screen renders live; the UI and core
share only `src/types.ts`.
