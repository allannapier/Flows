# Features To Build

Check off each feature as it is implemented. See `CLAUDE.md` for instructions on how to update this list.

---

## Feature List

- [x] **1. Advanced Flow Steps — Conditional Next-Step Routing**
- [x] **2. Alert on Step Failure**
- [ ] **3. Step Stats (turns, tokens, errors, cost)**

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

**Status:** Not started

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
