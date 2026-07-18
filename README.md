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
  validator's feedback injected into the prompt, up to a per-step retry limit.
- **Delete flows** from the same UI.
- **Configure the validator** in Settings: pick a provider (Anthropic, OpenAI, Google,
  or a custom OpenAI-compatible endpoint), model, and API key without leaving the app.

## Supported agents

| Agent | Invocation |
|---|---|
| Claude Code | `claude -p <prompt> --output-format text --permission-mode acceptEdits` |
| OpenCode | `opencode run <prompt>` |
| Codex CLI | `codex exec <prompt>` |
| Gemini CLI | `gemini -p <prompt>` |
| Custom | Any shell command; the rendered prompt is exposed as `$FLOW_PROMPT` |

Each step chooses its own agent, so a single flow can mix agents (e.g. implement with
Claude Code, review with a second agent).

Steps can also set "Continue session" to chain into the same agent conversation as the
previous step that used the same agent + working directory in the current run
(`claude -p --continue`, `opencode run --continue`, `codex exec resume --last`, or
`$FLOW_CONTINUE` for custom commands). The first step of a run for a given agent +
working directory always starts fresh, even with the toggle on. Not supported for
Gemini CLI (no verified non-interactive resume).

Agents run inside a real PTY (via `bun-pty`), so they see a proper terminal —
colors, progress rendering, TTY-gated behavior all work. The run screen renders
the live session through Ghostty's terminal emulation
([`ghostty-opentui`](https://www.npmjs.com/package/ghostty-opentui), built on
libghostty-vt), and the validator receives clean text extracted from the
terminal state rather than raw escape sequences. See
`docs/ghostty-terminal-sessions.md` for the design and the planned follow-ups
(persistent per-agent sessions, attach/takeover).

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
  save/cancel actions at the bottom, `esc` to go back
- **Steps** — each step has: name, agent, prompt template, desired result,
  validation on/off, max retries, optional working directory
- **Run screen** — live per-step checklist and streaming agent log; `esc` cancels.
  Press `a` during a run to attach and type directly into the agent's terminal —
  every keystroke goes to the agent PTY and the pane renders it live; `ctrl+]`
  detaches. `ctrl+c` quits Flows everywhere except while attached, where it's
  sent to the agent instead.

### Working directory

A step's working directory defaults to wherever `flow` was launched from (not
necessarily Flows' own install directory) — set per-step to override. That
default is captured once at startup (`src/core/paths.ts`) and shown as the
placeholder on the "Working directory" field in the step editor, so it's
never a silent guess.

Each step is run inside the user's own login shell (`$SHELL -ic 'cd -- <dir>
&& exec <agent command>'`), not `execve`'d directly — so directory-triggered
shell hooks a real terminal would run (direnv, nvm/asdf per-project version
switching, aliases) fire before the agent starts. The rendered prompt also
tells built-in agents their working directory explicitly, so they don't have
to guess (or ask) where to build.

### When an agent asks instead of acting

Agents invoked in single-shot/print mode (e.g. `claude -p`) can't actually
pause mid-task to ask a question — if the prompt is ambiguous, the CLI just
answers with the question as its final output and exits. By the time you'd
notice and attach, the process is already gone, so there's nothing left to
type into.

Flows detects this: when a step's output looks like a stalled question
(short output, last line ends in "?") instead of completed work, the run
pauses with a **"? waiting on you"** step status and an inline answer box in
the run screen. Type a reply and press enter — it's fed back to the agent as
follow-up context and the step retries (consuming one of its retry
attempts), instead of the run silently failing or completing with a question
as its output.

### Prompt templates

Step prompts support placeholders:

- `{{params.<name>}}` — a flow parameter value
- `{{steps.<stepName>.output}}` — the stdout of an earlier step

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
  agents.ts          agent registry + command builders
  paths.ts           launch directory (default working dir) capture/resolution
  session.ts         PTY-backed agent sessions (bun-pty), shell-wrapped with an explicit cd
  template.ts        {{...}} interpolation
  validator.ts       multi-provider structured-output validation (Anthropic/OpenAI/Google/custom)
  engine.ts          sequential run loop, streaming, retries, cancellation, needs-input pausing
src/ui/
  App.tsx            screen router
  FlowList.tsx       main menu
  FlowEditor.tsx     workflow creator
  StepEditor.tsx     per-step form
  RunParamsForm.tsx  parameter entry
  RunScreen.tsx      live run view
  ConfirmDelete.tsx  delete confirmation
  SettingsScreen.tsx validator LLM configuration
```

The engine emits typed `RunEvent`s (step-start, agent-output, validation-result,
step-retry, step-needs-input, flow-complete, ...) that the run screen renders live;
the UI and core share only `src/types.ts`.
