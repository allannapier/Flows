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
- **Validate results**: after each step, the built-in LLM (Anthropic API) judges the
  agent's output against the step's desired result. Failed steps are retried with the
  validator's feedback injected into the prompt, up to a per-step retry limit.
- **Delete flows** from the same UI.

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
export ANTHROPIC_API_KEY=sk-ant-...   # needed for step validation
bun run start
```

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Built-in validator LLM (only needed if any step has validation on) |
| `FLOWS_VALIDATOR_MODEL` | `claude-opus-4-8` | Model used to validate step output |
| `FLOWS_HOME` | `~/.flows` | Where flow definitions are stored (`$FLOWS_HOME/flows/*.json`) |

## Using the app

- **Flow list** — `enter` run · `n` new flow · `e` edit · `d` delete · `q` quit
- **Flow editor** — arrow keys to move, `enter` to edit a field or open a section,
  save/cancel actions at the bottom, `esc` to go back
- **Steps** — each step has: name, agent, prompt template, desired result,
  validation on/off, max retries, optional working directory
- **Run screen** — live per-step checklist and streaming agent log; `esc` cancels.
  Press `a` during a run to attach and type directly into the agent's terminal —
  every keystroke goes to the agent PTY and the pane renders it live; `ctrl+]`
  detaches. `ctrl+c` quits Flows everywhere except while attached, where it's
  sent to the agent instead.

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
  agents.ts          agent registry + command builders
  session.ts         PTY-backed agent sessions (bun-pty)
  template.ts        {{...}} interpolation
  validator.ts       Anthropic API structured-output validation
  engine.ts          sequential run loop, streaming, retries, cancellation
src/ui/
  App.tsx            screen router
  FlowList.tsx       main menu
  FlowEditor.tsx     workflow creator
  StepEditor.tsx     per-step form
  RunParamsForm.tsx  parameter entry
  RunScreen.tsx      live run view
  ConfirmDelete.tsx  delete confirmation
```

The engine emits typed `RunEvent`s (step-start, agent-output, validation-result,
step-retry, flow-complete, ...) that the run screen renders live; the UI and core
share only `src/types.ts`.
