# CLAUDE.md — Agent Instructions for the Flows Repository

This file contains conventions and instructions for AI agents working in this repository.

---

## Updating the Feature List (`FEATURES.md`)

`FEATURES.md` is the canonical backlog for this project. It contains a checklist at the top and a detailed description section for each feature below.

### When a feature is implemented

1. Open `FEATURES.md`.
2. In the checklist at the top of the file, change the feature's line from:
   ```
   - [ ] **N. Feature Name**
   ```
   to:
   ```
   - [x] **N. Feature Name**
   ```
3. In the feature's detailed description section, update the **Status** line from:
   ```
   **Status:** Not started
   ```
   to:
   ```
   **Status:** Complete
   ```
4. Commit the updated `FEATURES.md` alongside your implementation changes.

### When a new feature is added to the list

1. Add a new `- [ ]` entry to the checklist at the top of `FEATURES.md`.
2. Add a corresponding detailed description section at the bottom of `FEATURES.md`, following the same structure as the existing features:
   - **Feature number and name** as the heading.
   - **Status:** Not started
   - **Goal:** one or two sentences explaining what the feature does and why.
   - **Where to implement:** file-by-file breakdown covering types, core, and UI changes.
   - **Acceptance criteria:** bullet list of observable, testable outcomes.
3. Make the description detailed enough that another agent can read it and implement the feature without additional context.

---

## General Conventions

- The project uses **Bun** as the runtime and package manager. Run `bun install` and `bun run start`.
- Shared types between core and UI live in `src/types.ts`. Update both sides when you change a type.
- The engine emits typed `RunEvent`s consumed by the UI — add new event variants there when a feature needs new signals.
- Run `bun run start` to smoke-test changes interactively; there is no automated test suite yet.
