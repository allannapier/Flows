# Features To Build

Check off each feature as it is implemented. See `CLAUDE.md` for instructions on how to update this list.

---

## Feature List

- [x] **1. Advanced Flow Steps — Conditional Next-Step Routing**
- [x] **2. Alert on Step Failure**
- [x] **3. Step Stats (turns, tokens, errors, cost)**
- [x] **4. Re-run a Previous Run with the Same Parameters**
- [x] **5. Reusable Flows — Templated & Flow-Level Working Directory**
- [x] **6. Flow Portability — Duplicate, Export, and Import**
- [x] **7. Flow Integrity Linting (save-time + pre-run)**
- [x] **8. Per-Step Timeout Watchdog**
- [x] **9. Terminal Notifications for Background Runs**
- [x] **10. Headless CLI Mode (run flows non-interactively)**
- [x] **11. Directory Path Parameter Type (auto-create on run)**
- [ ] **12. Ad-Hoc Agent Sandbox — Freeform Interactive Session**
- [ ] **13. Save Sandbox Session as a Flow (AI Step Segmentation)**

---

## Detailed Descriptions

---

### 1. Advanced Flow Steps — Conditional Next-Step Routing

**Status:** Complete

**Goal:**  
Allow each step to define routing rules that control which step executes next, based on the validation outcome of that step. Today steps always execute sequentially (step 1 → 2 → 3 …). This feature makes it possible to branch: on success go to step 4, on failure go back to step 2 and re-run it, and so on.

**Where to implement:**

- **`src/types.ts`** — Add a `routing` field to `FlowStep`:

  ```ts
  export interface StepRouting {
    /** 0-based index of the step to jump to when this step passes validation.
     *  If absent, continue to the next sequential step (current behaviour). */
    onSuccess?: number;
    /** 0-based index of the step to jump to when this step fails validation
     *  and has exhausted retries.
     *  If absent, the flow fails as today. */
    onFailure?: number;
    /**
     * Maximum number of times a backward jump (onFailure pointing to an
     * earlier step) is allowed before the flow gives up and treats it as a
     * hard failure.  Defaults to 3. */
    maxJumps?: number;
  }
  ```

  Add `routing?: StepRouting` to `FlowStep`.

- **`src/core/engine.ts`** — The sequential run loop currently uses a simple index counter. Replace it with a step-pointer that consults `step.routing` after each step completes or fails:
  - After a **successful** step: if `routing.onSuccess` is defined, jump the pointer there; otherwise increment normally.
  - After a step that has **exhausted retries** (failed): if `routing.onFailure` is defined, jump the pointer there (and increment a per-route jump counter); if the counter exceeds `maxJumps`, fall through to the existing hard-failure path.
  - Emit a new `RunEvent` type `"step-jump"` with `{ fromIndex, toIndex, reason: "success" | "failure" }` so the UI can show the jump.

- **`src/ui/StepEditor.tsx`** — Add two new optional numeric fields to the step form:
  - "On success, go to step …" (dropdown or number input; blank = next step)
  - "On failure, go to step …" (dropdown or number input; blank = fail flow)
  - Validate that values are valid step indices within the flow and warn against infinite loops.

- **`src/ui/RunScreen.tsx`** — Handle the new `"step-jump"` event in the live checklist renderer so the user sees a visual cue when the flow jumps back or forward.

- **`src/core/runStore.ts` / `src/types.ts`** — `RunStepRecord` should record how many times a step was (re-)executed due to routing, not just the total attempt count.

**Acceptance criteria:**
- A flow can be authored with a step that, on failure, loops back to a prior step up to N times before giving up.
- A flow can be authored with a step that, on success, skips ahead to a non-sequential step.
- The run screen shows the jump visually.
- Existing flows with no routing configured behave exactly as before.

---

### 2. Alert on Step Failure

**Status:** Complete

**Goal:**  
Give flow authors the option to have the flow stop immediately and present a prominent alert to the user when a specific step fails (validation fails and retries are exhausted), rather than silently marking the flow as failed. This is an opt-in, per-step toggle.

**Where to implement:**

- **`src/types.ts`** — Add `alertOnFailure?: boolean` to `FlowStep`. When `true`, a step failure triggers an alert before the flow is marked failed.

- **`src/core/engine.ts`** — After a step exhausts retries and `step.alertOnFailure` is `true`:
  1. Emit a new `RunEvent`: `{ type: "step-alert"; stepIndex: number; stepName: string; error: string }`.
  2. Pause execution (do not yet mark the run as failed) until the UI acknowledges the alert.
  3. Provide a mechanism (e.g. a `RunHandle.acknowledgeAlert()` method) that the UI calls when the user dismisses the alert, after which the run transitions to `"failed"` normally.

- **`src/ui/RunScreen.tsx`** — Listen for the `"step-alert"` event and render a blocking modal/overlay over the run screen showing the step name and error. Provide a single "Dismiss" action that calls `RunHandle.acknowledgeAlert()`. While the alert is showing, all other key bindings (attach, continue, cancel, scroll) should be suspended.

- **`src/ui/StepEditor.tsx`** — Add a boolean toggle "Alert on failure" (default: off) to the step form, below the existing "Pause for review" toggle.

**Acceptance criteria:**
- When "Alert on failure" is enabled on a step and that step fails, the run screen shows a blocking alert overlay with the step name and failure reason.
- The user must dismiss the alert before the run is marked as failed and the screen returns to its normal state.
- Steps without the flag behave exactly as today.
- The flag is persisted in the flow definition JSON.

---

### 3. Step Stats (turns, tokens, error count, cost)

**Status:** Complete

**Goal:**  
Track and display per-step execution statistics in the run detail view: how many agent turns the step took, total tokens consumed, how many validation errors occurred during retries, and estimated cost.

**Where to implement:**

- **`src/types.ts`**
  - Add a `StepStats` interface:

    ```ts
    export interface StepStats {
      turns: number;
      /** Total tokens (input + output) reported by the validator LLM for this step. */
      tokensUsed: number;
      /** Number of validation failures (failed attempts) before the step completed or gave up. */
      errorCount: number;
      /** Estimated cost in USD, computed from tokensUsed and the validator model's known pricing.
       *  undefined when the model's pricing is unknown. */
      estimatedCostUsd?: number;
    }
    ```

  - Add `stats?: StepStats` to `RunStepRecord`.

- **`src/core/validator.ts`** — The validator already calls the LLM. Capture token usage from the LLM response (all three provider SDKs expose `usage.input_tokens` / `usage.output_tokens` or equivalent) and return it alongside the `ValidationVerdict`.

- **`src/core/engine.ts`**
  - Count agent turns per step (each completion-hook/turn-end event is one turn).
  - Accumulate token counts from each validator call for the step.
  - Count validation failures (each retry is one error).
  - After the step finishes (success or failure), compute `estimatedCostUsd` using a small static price table ($/1k tokens) keyed by model name for known Anthropic/OpenAI/Google models; leave `undefined` for unknown models.
  - Write the completed `StepStats` onto `RunStepRecord.stats` and persist it.

- **`src/ui/RunDetail.tsx`** — The run detail view already shows per-step outputs. For each step that has `stats`, render a compact stats row beneath the step output, e.g.:

  ```
  Turns: 3 · Tokens: 4,210 · Errors: 1 · Cost: ~$0.021
  ```

  Show "—" for any stat that is unavailable (e.g. cost when model is unknown).

**Acceptance criteria:**
- After a run completes, the run detail view shows per-step turn count, token count, error count, and estimated cost.
- Stats are persisted in the run JSON so they are still visible after restarting the app.
- Steps that had no validator calls (validation disabled) show turns and error count only; tokens and cost are omitted/zero.
- The stats display is compact and does not break the existing layout.

---

### 4. Re-run a Previous Run with the Same Parameters

**Status:** Complete

**Goal:**  
Let the user restart a flow directly from run history without re-typing parameter values. Runs already persist their `params` in `RunRecord`, but today the only way to run again is to go back to the flow list and fill in the parameter form from scratch. This is the most common loop while iterating on a flow ("tweak the flow, run it again with the same inputs").

**Where to implement:**

- **`src/ui/App.tsx`** — Extend the `Screen` union's `"run-params"` variant with an optional `initialParams?: Record<string, string>` field and pass it through to `RunParamsForm`.

- **`src/ui/RunParamsForm.tsx`** — Accept an optional `initialParams` prop. When present, pre-fill each parameter's input with the value from `initialParams` (falling back to the parameter's `default` as today). For `choices` parameters, pre-select the matching choice; if the recorded value is no longer in `choices` (the flow changed since the run), fall back to the default/first choice. Parameters that no longer exist on the flow are silently dropped; new parameters added since the recorded run behave as if unset.

- **`src/ui/RunHistory.tsx`** — Add an `r` key binding ("re-run") on the selected run: navigate to `run-params` with that run's `params` as `initialParams`. Add it to the bottom hints.

- **`src/ui/RunDetail.tsx`** — Add the same `r` binding when inspecting a finished run, so the user can re-run straight from the detail view. This requires `RunDetail`'s parent (`App.tsx`) to provide an `onRerun(params)` callback alongside `onBack`.

**Acceptance criteria:**
- Pressing `r` on a run in history (or in run detail) opens the parameter form pre-filled with that run's recorded values; the user can still edit any value before starting.
- Flows with no parameters skip straight to the run screen, same as pressing enter on the flow today.
- Recorded values for parameters that were removed from the flow are ignored, and parameters added since the run fall back to their defaults — no crash in either direction.
- Starting the re-run creates a brand-new `RunRecord`; the original run is untouched.

---

### 5. Reusable Flows — Templated & Flow-Level Working Directory

**Status:** Complete

**Goal:**  
Make one flow usable against many projects. Today `FlowStep.workingDir` is a fixed literal path (`src/core/engine.ts` resolves `step.workingDir || process.cwd()`), so a flow that operates on a repo is welded to one checkout — running the same "implement + review" flow on a different repo means editing every step. This feature (a) allows `{{params.<name>}}` placeholders in working directories so the target directory becomes a run-time parameter, and (b) adds a flow-level default working directory so per-step values are only needed when a step diverges.

**Where to implement:**

- **`src/types.ts`** — Add `workingDir?: string` to `Flow` (flow-level default, may contain `{{params.*}}` placeholders). Document on `FlowStep.workingDir` that it also supports `{{params.*}}` and overrides the flow default.

- **`src/core/template.ts`** — Export a `renderParamsOnly(template, params)` helper (or an options flag on `renderTemplate`) that resolves `{{params.*}}` but rejects `{{steps.*}}` placeholders with a clear error — step outputs are multi-line agent text and must never become a path.

- **`src/core/engine.ts`** — Where the step's cwd is resolved (`const resolvedCwd = step.workingDir || process.cwd()`), change resolution to: rendered `step.workingDir` → rendered `flow.workingDir` → `process.cwd()`. After rendering, expand a leading `~` to `os.homedir()`. Validate that the resolved path exists and is a directory **before** launching the agent; if not, fail the step immediately with an error naming the resolved path (no agent session is started, no retries — a missing directory won't fix itself). Note: session-continuation grouping (same agent + working directory) must compare **resolved** paths, so two steps whose templates render to the same directory still share a session.

- **`src/ui/FlowEditor.tsx`** — Add an optional "Working directory" field to the flow-level form (next to name/description), with help text mentioning `{{params.*}}` support.

- **`src/ui/StepEditor.tsx`** — Update the existing per-step working-directory field's help text: supports `{{params.*}}`, blank = flow default.

**Acceptance criteria:**
- A flow with a `repoPath` parameter and flow-level working directory `{{params.repoPath}}` runs all its steps in the directory supplied at run time, with no per-step working directories set.
- A step-level working directory still overrides the flow default, and both support `{{params.*}}` and leading `~`.
- A working directory that renders to a non-existent path fails the step immediately with an error that includes the resolved path — the agent is never launched.
- Using `{{steps.*.output}}` in a working directory is rejected with a clear error.
- Existing flows (no flow-level working directory, literal step paths) behave exactly as before.

---

### 6. Flow Portability — Duplicate, Export, and Import

**Status:** Complete

**Goal:**  
Flows are trapped in `$FLOWS_HOME/flows/*.json` on one machine. Users need to iterate on a copy without breaking a working flow (duplicate), share a flow with a teammate or check it into a repo (export), and bring someone else's flow in (import).

**Where to implement:**

- **`src/core/storage.ts`**
  - `duplicateFlow(id: string): Flow | undefined` — deep-copies the flow with a fresh id (`newFlowId()`), name suffixed `" (copy)"`, fresh timestamps, and saves it. Step `id`s are regenerated too (they only need to be unique within the flow).
  - `exportFlow(id: string, destPath: string): string` — writes the flow JSON (minus `id`, `createdAt`, `updatedAt` — portability metadata is regenerated on import) to `destPath`; returns the resolved absolute path. Default filename: `<slugified-flow-name>.flow.json`.
  - `importFlow(srcPath: string): Flow` — reads and validates the JSON (must have `name`, `steps` array with the required step fields; unknown extra fields are preserved), assigns a fresh id and timestamps, regenerates step ids, and appends `" (imported)"` to the name if a flow with the same name already exists. Throws with a readable message on malformed input.

- **`src/ui/FlowList.tsx`** — New key bindings and hints: `c` duplicate the selected flow (list refreshes with the copy selected), `x` export the selected flow, `i` import a flow.

- **`src/ui/App.tsx` + a small new screen `src/ui/FilePrompt.tsx`** — `x` and `i` need a path: a minimal one-field screen (single text input, enter to confirm, esc to cancel) that prompts for the destination path (export, pre-filled with `./<slug>.flow.json`) or the source path (import). On success, return to the list showing a transient status line ("Exported to …" / "Imported '<name>'"); on failure, show the error on the same prompt screen without losing the typed path.

**Acceptance criteria:**
- Duplicating a flow produces an independent copy — editing one never mutates the other — named "<original> (copy)".
- Export writes a JSON file that contains no machine-specific ids/timestamps; importing it on another machine (or after deleting the original) recreates the flow with all steps, parameters, routing, and per-step settings intact.
- Importing a file that isn't a valid flow shows a readable error and leaves storage untouched.
- Name collisions on import are resolved with an "(imported)" suffix, never by overwriting an existing flow.

---

### 7. Flow Integrity Linting (save-time + pre-run)

**Status:** Complete

**Goal:**  
Several editing operations can silently corrupt a flow today: renaming a step breaks every `{{steps.<oldName>.output}}` placeholder that references it (the run then throws mid-flow), duplicate step names make placeholder resolution ambiguous, deleting or reordering steps invalidates `routing.onSuccess`/`onFailure` indices, and prompts can reference parameters that don't exist. None of this is caught until a run fails at the broken step. Add a lint pass that catches these at save time and before every run.

**Where to implement:**

- **`src/core/lint.ts`** (new file) — `lintFlow(flow: Flow): FlowLintIssue[]` where `FlowLintIssue = { severity: "error" | "warning"; stepIndex?: number; message: string }`. Checks, at minimum:
  - **error** — a `{{params.<name>}}` placeholder in any step prompt (or working directory, once feature 5 lands) names a parameter the flow doesn't declare;
  - **error** — a `{{steps.<name>.output}}` placeholder names a step that doesn't exist;
  - **error** — `routing.onSuccess`/`onFailure` is out of range for the flow's current step count;
  - **error** — a step with `agent: "custom"` has an empty `customCommand`;
  - **warning** — two steps share the same `name` (placeholder references are ambiguous — first match wins);
  - **warning** — a `{{steps.<name>.output}}` placeholder references a step that comes **later** in the flow (its output will be empty/unknown on a purely sequential pass);
  - **warning** — a parameter `default` is not one of its `choices`.
  Reuse the placeholder regex from `src/core/template.ts` (export it or add a `listPlaceholders(template)` helper there) rather than duplicating the parsing.

- **`src/ui/FlowEditor.tsx`** — Run `lintFlow` on save. Errors block the save and are listed (with step numbers) in the editor's status area; warnings are shown but don't block. Also maintain referential integrity proactively: when a step is **renamed**, rewrite `{{steps.<oldName>.output}}` to the new name across all other steps' prompts; when steps are **reordered or deleted** (`moveStep` / `removeAt`), remap or clear routing indices that pointed at moved/removed steps, telling the user what was cleared.

- **`src/ui/RunParamsForm.tsx`** (or `App.tsx` just before entering the run screen) — Run `lintFlow` before starting a run; if any **errors** exist (e.g. the flow JSON was hand-edited or imported), show them and refuse to start instead of failing mid-run.

**Acceptance criteria:**
- Renaming a step in the editor automatically updates every prompt that referenced it; no `{{steps.*.output}}` reference is left dangling after a rename.
- Reordering or deleting steps never leaves `routing` pointing at the wrong step — indices are remapped (reorder) or cleared with a visible notice (delete).
- Saving a flow whose prompt references an unknown parameter or step is blocked with a message naming the offending step and placeholder.
- Starting a run of a flow with lint errors (e.g. imported/hand-edited JSON) is refused with the same readable list, before any agent launches.

---

### 8. Per-Step Timeout Watchdog

**Status:** Complete

**Goal:**  
Nothing in the engine bounds how long a step may run. A wedged agent (hung CLI, network stall, a Gemini session that never goes quiescent) leaves the flow "running" forever — especially bad for backgrounded runs the user isn't watching. Add an opt-in per-step timeout: when a turn exceeds it, the attempt is treated as a failed attempt (so retries/routing/alerts apply), instead of hanging.

**Where to implement:**

- **`src/types.ts`**
  - Add `timeoutMinutes?: number` to `FlowStep` (absent or `0` = no timeout, current behaviour).
  - Add a `RunEvent` variant `{ type: "step-timeout"; stepIndex: number; minutes: number }`, emitted just before the attempt is failed, so the UI can say *why* the attempt ended.

- **`src/core/engine.ts`** — Arm a timer whenever a step attempt starts waiting on the agent (both the interactive turn-completion wait and the custom-agent process wait). Reset it on each completed turn. On expiry: emit `"step-timeout"`, kill the step's agent process/session (reuse the cancellation path's process-kill logic, without cancelling the whole run), and treat the attempt exactly like a validation failure — feedback string `"Step timed out after N minutes"` — so `maxRetries`, `routing.onFailure`, and `alertOnFailure` all behave uniformly. Retried attempts start a **fresh** session (the old one was killed) even when `continueSession` is set. The timer must not fire while the run is gated on the user (`awaiting-input` or an open alert) — user thinking time isn't agent time.

- **`src/ui/StepEditor.tsx`** — Numeric "Timeout (minutes)" field, blank/0 = none, next to "Max retries".

- **`src/ui/RunScreen.tsx`** — Render `"step-timeout"` in the live checklist (e.g. `⏱ timed out after 15m`) so the retry that follows is explicable.

**Acceptance criteria:**
- A step with a 1-minute timeout whose agent produces no completed turn within a minute is killed and marked as a failed attempt; with retries remaining, a fresh attempt starts.
- Timeout failures flow through the existing machinery: retries are consumed, `routing.onFailure` routes, `alertOnFailure` alerts, and with none of those the flow fails with a timeout error.
- Time spent in `awaiting-input` or on an unacknowledged alert never counts toward the timeout.
- Steps without `timeoutMinutes` behave exactly as today, and the field is persisted in the flow JSON.

---

### 9. Terminal Notifications for Background Runs

**Status:** Complete

**Goal:**  
The whole point of backgrounded runs (`esc` from the run screen) and the awaiting-input gate is that the user does something else while agents work — but Flows currently has no way to call them back. Emit a terminal bell and (where supported) a desktop notification when a run needs the user or finishes while they aren't looking at it.

**Where to implement:**

- **`src/core/notify.ts`** (new file) — `notify(title: string, body: string): void` that writes to stdout: BEL (`\x07`) plus an OSC 777 notification sequence (`\x1b]777;notify;<title>;<body>\x07`), which iTerm2/kitty/foot/WezTerm surface as a desktop notification and other terminals ignore harmlessly. No external processes, no dependencies.

- **`src/core/config.ts` + `src/ui/SettingsScreen.tsx`** — Add a `notifications: boolean` setting (default **on**) persisted in `config.json`, with a toggle in Settings.

- **`src/core/runManager.ts`** — The run manager already observes every run's events; it decides *when* to notify. Fire on: a run entering `awaiting-input`, a `"step-alert"`, and terminal outcomes (`flow-complete` / `flow-failed`). Suppress the notification when the user is already looking at that run — the run screen registers the currently-viewed run id with the manager (a `setViewedRun(runId | null)` call on mount/unmount, alongside the existing attach surface) — except `awaiting-input` and `step-alert`, which should still ring the bell (no OSC body needed) even on-screen, since the user may have looked away from a long-running step.

- **`src/ui/RunScreen.tsx`** — Register/unregister the viewed run id per the above.

**Acceptance criteria:**
- With the run screen closed (`esc`), a run that pauses for input, hits an alert, completes, or fails triggers a bell + OSC 777 notification naming the flow and what happened.
- Watching the run on-screen suppresses completion/failure notifications; awaiting-input still bells.
- The Settings toggle turns all of it off, and the setting persists across restarts.
- Terminals without OSC 777 support show no garbage output (the sequence is ignored; the bell still works).

---

### 10. Headless CLI Mode (run flows non-interactively)

**Status:** Complete

**Goal:**  
Flows can only be run by a human inside the TUI. A headless mode — `bun run start run <flow> --param k=v` — lets flows run from scripts, cron, and CI, turning authored flows into reusable automation. The engine is already fully decoupled from the UI (it emits typed `RunEvent`s), so this is mostly a new thin front-end.

**Where to implement:**

- **`index.tsx`** — Before the TTY check, parse `process.argv`. With no subcommand, behave exactly as today (TUI, TTY required). Subcommands:
  - `run <flow-name-or-id> [--param key=value ...] [--json]` — run headless (works without a TTY; the current hard TTY exit must only apply to the TUI path);
  - `list` — print flow names, ids, and step counts;
  - `--help` — usage text.

- **`src/cli/run.ts`** (new file) — Headless runner:
  - Resolve the flow by exact id, then unique name match (ambiguous or missing → error listing candidates, exit 2).
  - Build params from `--param` flags + parameter defaults; any required parameter still missing → error naming it, exit 2. Validate `choices` values.
  - Call `runFlow` and translate events to log lines on stderr (`[2/5] implement — started`, `— validation failed (attempt 1/3): …`, `— complete`), with step outputs and the final summary on stdout; `--json` instead emits one JSON line per `RunEvent` for machine consumption.
  - **Gate policy:** there is no user, so `"step-awaiting-input"` is answered by calling `continueFlow()` immediately, and `"step-alert"` by `acknowledgeAlert()` — the run never blocks on a human. Note this in `--help`.
  - Persist the run through `runManager` exactly like a TUI run (it must appear in run history), and exit 0 on `flow-complete`, 1 on `flow-failed`/cancellation (SIGINT → `handle.cancel()`, then exit 1).

- **`src/core/runManager.ts`** — Ensure starting a run does not depend on any UI module being loaded (it shouldn't today; verify and keep it that way).

**Acceptance criteria:**
- `bun run start run "My Flow" --param repo=/tmp/x` executes the whole flow without a TTY, streams progress, and exits 0 on success / 1 on failure / 2 on usage errors.
- Awaiting-input pauses and failure alerts never hang a headless run — they auto-continue/auto-acknowledge, and the log says so.
- The run appears in the TUI's run history afterwards, indistinguishable from an interactive run.
- `--json` output is line-delimited JSON parseable by tools like `jq`; plain `bun run start` still launches the TUI unchanged.

---

### 11. Directory Path Parameter Type (auto-create on run)

**Status:** Complete

**Goal:**  
Today a parameter is either free text or a fixed `choices` list (`FlowParameter` in `src/types.ts`). When a flow's `workingDir` (or a step's) is templated from a parameter (feature 5) and the user points it at a folder that doesn't exist yet — e.g. a brand-new project directory — the step fails immediately with "Working directory not found", because `resolveStepWorkingDir` only validates, it never creates. Add a `directoryPath` parameter type so authors can mark a parameter as "this value is a folder", and have the engine create it (`mkdir -p` semantics) at run setup time, before any step runs, instead of failing.

**Where to implement:**

- **`src/types.ts`** — Add `directoryPath?: boolean` to `FlowParameter`, documented as: when `true`, this parameter's value is a filesystem directory path; at run start the engine resolves it (expanding a leading `~`, resolving to an absolute path) and creates it recursively if it doesn't already exist, rather than requiring it to pre-exist. Mutually exclusive with `choices` in the UI (a directory can't also be a fixed-choice list), but no runtime code needs to enforce that beyond what the editor does.

- **`src/core/engine.ts`** — Add a setup step at the top of `runFlow`, before the step loop begins (and before the first `"step-start"`/agent launch of any kind):
  - For each `flow.parameters` entry with `directoryPath === true` and a non-empty value in `paramValues`: expand a leading `~` (reuse `expandHome`), resolve to an absolute path (`path.resolve`), and `fs.mkdirSync(resolved, { recursive: true })`.
  - If the resolved path already exists but is not a directory (e.g. it's a regular file), fail the run immediately with a clear error naming the parameter and path — same "fail before launching anything" precedent as `resolveStepWorkingDir` in feature 5 — instead of throwing later from a half-started run.
  - Write the resolved absolute path back into `paramValues[param.name]` so every `{{params.<name>}}` reference downstream (including `Flow.workingDir` / `FlowStep.workingDir`) sees the canonical, guaranteed-to-exist path.
  - Emit a new `RunEvent`: `{ type: "param-directory-ready"; paramName: string; path: string; created: boolean }` for each directory parameter processed (`created: true` when it didn't exist before this call), so the run screen/CLI log can show what was set up.

- **`src/ui/ParamForm.tsx`** — Extend the existing "Input type" tab-select (currently `Free text` / `Choices`) with a third option, `Directory path` (description: "a folder; created automatically at run time if missing"). When selected: hide the "Choices" field (same as `Free text` today), keep "Default value" as a free-text field (a default folder path, optional), and on save set `directoryPath: true` and `choices: undefined` on the saved `FlowParameter` (mirroring how `choices` is set/cleared today).

- **`src/ui/RunParamsForm.tsx`** — For parameters with `directoryPath === true`, show a hint next to the field (similar to how `choices` are listed today), e.g. `(directory — created automatically if missing)`, so the user filling in the value knows a typo creates a new folder rather than erroring.

- **`src/ui/RunScreen.tsx`** (and the CLI's event-to-log-line translation in `src/cli/run.ts`) — Render the new `"param-directory-ready"` event, e.g. `✓ created directory for "repoPath": /tmp/new-project` (only worth a line when `created` is true; silently skip/no-op when the directory already existed).

- **`src/core/lint.ts`** — Add a warning: a parameter has both `choices` and `directoryPath` set (shouldn't happen via the editor, but guards hand-edited/imported JSON) — `directoryPath` is ignored in that case.

**Acceptance criteria:**
- A flow parameter marked "Directory path" whose supplied value is a path that doesn't exist on disk is created (including any missing intermediate directories) before the flow's first step starts; the flow no longer fails with "Working directory not found" for that value.
- If the supplied path already exists as a directory, nothing changes on disk and the run proceeds exactly as before.
- If the supplied path exists but is a file (not a directory), the run fails immediately with a clear error naming the parameter and path, before any agent is launched.
- Using `{{params.<name>}}` (from a directory-path parameter) as a flow- or step-level `workingDir` always resolves to an existing directory by the time the step runs.
- Existing parameters (no `directoryPath` set) behave exactly as today, in both the TUI and headless CLI paths.

---

### 12. Ad-Hoc Agent Sandbox — Freeform Interactive Session

**Status:** Not started

**Goal:**
Today the only way to drive a coding agent through Flows is to first author a `Flow` with one or more `FlowStep`s. Sometimes a user just wants to open a conversation with an agent against a working directory and iterate freely — try a prompt, see what it does, follow up, course-correct — before they know what the reusable steps even are. Add a "sandbox" mode: pick an agent and a working directory, chat with it turn by turn in the TUI, with no prompt template, no `expectedResult`, no validation and no retries. This session's transcript is the raw material feature 13 turns into a Flow.

**Where to implement:**

- **`src/types.ts`** — Add:

  ```ts
  export interface SandboxTurn {
    role: "user" | "agent";
    text: string;
    at: string; // ISO timestamp
  }

  export interface SandboxSession {
    id: string;
    agent: AgentId;
    workingDir: string;
    turns: SandboxTurn[];
    startedAt: string;
    updatedAt: string;
    /** True once the underlying process has exited (crash, `/exit`, or an
     * explicit close) — no more turns can be sent, but the transcript is
     * still readable and can still be turned into a Flow (feature 13). */
    ended: boolean;
  }
  ```

  Only agents where `agentSupportsInteractive(agent)` is true (`claude`, `opencode`, `codex`, `gemini` — see `src/core/interactive.ts`) are eligible; `custom` has no interactive contract, same restriction the engine already applies to `continueSession`/`pauseForReview`.

- **`src/core/sandbox.ts`** (new file) — Mirrors the shape of `src/core/runManager.ts` but for sessions that aren't tied to a `Flow`/`RunRecord`:
  - `sandboxDir()` — `${FLOWS_HOME}/sandbox`, following the same `FLOWS_HOME`-rooted convention as `storage.ts`'s `flowsDir()` and `interactive.ts`'s scratch dirs.
  - `startSandbox(agent: AgentId, workingDir: string, openingPrompt: string, opts: { cols: number; rows: number }): SandboxHandle` — generates a fresh id, calls `prepareAgentScratch(id, agent)` and `createInteractiveSession(agent, { prompt: openingPrompt, cwd: workingDir, ...opts, scratch, onData })` exactly as `engine.ts` does for an interactive step, records the opening prompt as the first `"user"` turn, and awaits the reply via `awaitTurn`/`checkPendingTurn` to append the `"agent"` turn once the hook/quiescence signal fires.
  - `SandboxHandle` exposes: `send(text: string): Promise<void>` (records a `"user"` turn, calls the underlying session's `sendTurn`, then awaits and records the `"agent"` reply turn), `resize`/`write` (passthrough to the underlying `AgentSession`, for raw attach same as `RunHandle`), `cancel()` (kills the session, marks `ended: true`), and a `subscribe(listener)` pattern matching `runManager.ts`'s `subscribeRun`.
  - Persist the `SandboxSession` record to `sandboxDir()/<id>.json` after every turn (so a crash or restart doesn't lose the transcript — same durability guarantee `RunRecord`s already get from `runStore.ts`).
  - `listSandboxSessions(): SandboxSession[]` and `getSandboxSession(id): SandboxSession | undefined` for the UI to list/resume.

- **`src/ui/SandboxScreen.tsx`** (new file):
  - When opened with no existing session: a small form — agent picker (reuse `AGENTS` filtered to `agentSupportsInteractive`, same "unavailable binary" greying-out `agentAvailable` already does elsewhere), a working-directory text field (default `process.cwd()`, supports `~` expansion like `resolveStepWorkingDir`), and an opening-prompt text field. Submitting calls `startSandbox`.
  - Once live: render the agent's PTY output using the same renderer `RunScreen.tsx` already uses (`cleanOutput` / `ptyToText`), with the same attach model — `f` to attach (raw keystrokes forwarded via `handle.write`, `attach-state.ts`'s `setAttached(true)`, same as `RunScreen`), `esc` to detach back to the list while the session keeps running in the background.
  - A dedicated single-line prompt input (separate from raw attach) is always available while a turn isn't in flight: typing text and pressing Enter calls `handle.send(text)` — this is the primary way to have a turn-by-turn conversation without fighting the agent CLI's own input box, mirroring how `engine.ts` already drives retries via `sendTurn` rather than raw keystrokes.
  - A visible list of past turns (role + truncated text) above the live pane, so the user can scroll back through the conversation so far.

- **`src/ui/FlowList.tsx`** — Add a new key binding, e.g. `a` "agent session", listed in the bottom hints alongside `n` (new flow); it navigates to a new list of sandbox sessions (existing + "start new"), analogous to how `x`/`i` open `FilePrompt`.

- **`src/ui/App.tsx`** — Extend `Screen` with `{ name: "sandbox"; sandboxId?: string }` (absent = show the start form; present = resume/attach to that session) and a `{ name: "sandbox-list" }` entry point from `FlowList`.

**Acceptance criteria:**
- A user can pick an available interactive agent, a working directory, and an opening prompt, and get a live back-and-forth conversation with that agent inside the TUI, with no flow or steps defined anywhere.
- Sending a follow-up turn while the agent is still working on the previous one is disabled/queued rather than corrupting the session.
- Detaching (`esc`) leaves the agent process and conversation running; returning to the sandbox list and reselecting the session reattaches to the same live conversation.
- The full transcript (ordered user/agent turns, agent id, working directory) survives an app restart via the persisted `SandboxSession` file.
- Ending the session (agent process exits, or the user explicitly closes it) marks it `ended` but keeps the transcript readable/exportable.

---

### 13. Save Sandbox Session as a Flow (AI Step Segmentation)

**Status:** Not started

**Goal:**
Once a sandbox session (feature 12) has gone well, the user shouldn't have to manually re-derive `FlowStep`s from memory. Add a "Save as Flow" action that hands the whole transcript — agent, working directory, and every user/agent turn — to an LLM that has been taught the full `Flow`/`FlowStep` contract, and gets back a segmented, ready-to-review draft flow: one step per coherent instruction, each with a real `prompt` and an `expectedResult` written in the same actionable style the existing step validator (`src/core/validator.ts`) already expects. The draft opens in the existing flow editor for review — nothing is written to `$FLOWS_HOME/flows` until the user explicitly saves it there.

**Where to implement:**

- **`src/core/flowFromTranscript.ts`** (new file):
  - `renderTranscriptForLlm(session: SandboxSession): string` — flattens `session.turns` into the same `---`-turn-separated format `validator.ts`'s `SYSTEM_PROMPT` already tells the validator LLM to expect ("The output may be a multi-turn transcript with turns separated by `---` lines"), so a segmentation prompt and a later validation prompt read consistently.
  - A system prompt that fully specifies the contract the LLM must produce against — explicitly documenting, in plain language, the parts of `FlowStep` (`src/types.ts`) relevant to authoring: `prompt` supports `{{params.<name>}}` and `{{steps.<stepName>.output}}` placeholders; `expectedResult` is judged later by a separate strict QA validator, so it must be specific and checkable, not a restatement of the prompt; steps in one sandbox conversation all share one live agent conversation, so every step after the first should be marked `continueSession: true`; one step should correspond to one coherent user instruction — merge trivial clarifying back-and-forth into the step it belongs to rather than emitting a step per literal turn.
  - `segmentTranscriptIntoFlow(session: SandboxSession, configOverride?: AppConfig): Promise<{ name: string; description: string; steps: Array<{ name: string; prompt: string; expectedResult: string }> }>` — dispatches to whichever provider `resolveValidator` (`src/core/config.ts`) resolves to, reusing the same three-provider call shapes `validator.ts` already has (Anthropic/OpenAI/Google, each with a JSON schema response) but with a schema for `{ name, description, steps: [...] }` instead of `VERDICT_SCHEMA`. This is a distinct call from `validateOutput` (authoring assistance, not a pass/fail judgment) but shares the provider dispatch pattern.
  - `draftFlowFromSandbox(session: SandboxSession, segmented): Flow` — assembles a full, not-yet-persisted `Flow`: fresh `id` (`newFlowId()`), `name`/`description` from the LLM, `parameters: []`, `workingDir: session.workingDir`, and `steps` built from the segmented list with `agent: session.agent`, `validate: true`, `maxRetries: 1`, `continueSession: i > 0`, and fresh step ids. Does not call `saveFlow`.

- **`src/ui/SandboxScreen.tsx`** — Add a key binding (e.g. `s`, "save as flow"), enabled only once the session has at least one completed turn. Shows a brief in-progress indicator while `segmentTranscriptIntoFlow` runs, then hands the draft to `App.tsx`. On failure (network/auth error, malformed LLM JSON), show a readable error on the sandbox screen and leave the live session untouched — the user can retry without losing the conversation.

- **`src/ui/FlowEditor.tsx`** — Add an optional `initialFlow?: Flow` prop, for a draft that hasn't been saved yet (distinct from the existing `flowId`-driven load path via `getFlow`). When present, populate the form from it directly. Saving persists it via `saveFlow` the same way a brand-new flow is saved today (the draft already carries a fresh id from `draftFlowFromSandbox`); cancelling discards the draft — it was never written to storage. Run the existing `lintFlow` (feature 7) on the draft before it's shown, surfacing any segmentation mistakes (e.g. a hallucinated `{{steps.X.output}}` reference) as ordinary editor warnings/errors.

- **`src/ui/App.tsx`** — Extend the `"edit"` screen variant with an optional `initialFlow?: Flow`, and thread an `onSaveAsFlow(flow: Flow)` callback into `SandboxScreen` that navigates to `{ name: "edit", initialFlow: flow }`.

**Acceptance criteria:**
- From a sandbox session with at least one completed turn, "Save as Flow" opens the flow editor with a draft flow: one step per coherent instruction in the conversation, each step's `agent` and `workingDir` matching the session, and `continueSession: true` on every step after the first.
- The draft is never written to `$FLOWS_HOME/flows/` until the user explicitly saves it from the editor; cancelling discards it entirely, and the sandbox session itself is unaffected either way.
- Generated `expectedResult` text is specific enough for the existing validator to judge future runs against — not a generic restatement of the prompt.
- A segmentation call that fails (provider error, bad JSON) shows a readable error on the sandbox screen and leaves the transcript/live process untouched; the user can retry.
- A sandbox session with zero completed turns cannot be saved as a flow — the action is disabled with a hint why.
