import { useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { TabSelectOption, TextareaRenderable } from "@opentui/core";
import { AGENTS, agentAvailable, agentSupportsContinuation } from "../core/agents";
import type { FlowParameter, FlowStep } from "../types";
import {
  colors,
  Hint,
  FieldRow,
  TabToggleRow,
  TextAreaFieldRow,
  ButtonRow,
  RowHint,
  SuggestionDropdown,
  marker,
  type KeyHintSpec,
} from "./theme";

type TextField = "name" | "customCommand" | "prompt" | "expectedResult" | "maxRetries" | "workingDir";

/** Fields whose value is a {{...}} template that can be autocompleted. */
type PlaceholderField = "prompt" | "expectedResult";

const MAX_SUGGESTIONS = 8;

interface SuggestState {
  field: PlaceholderField;
  /** Offset in plainText right after the triggering "{{". */
  anchor: number;
  items: string[];
  index: number;
  /** How many additional matches were cut off past MAX_SUGGESTIONS. */
  overflow: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function newStepId(): string {
  return crypto.randomUUID();
}

export function StepEditor({
  step,
  parameters,
  priorStepNames,
  previousStep,
  onSave,
  onCancel,
}: {
  step: FlowStep | null;
  /** The enclosing flow's parameters, offered as {{params.<name>}} suggestions. */
  parameters: FlowParameter[];
  /** Names of steps that will have already run by the time this step runs,
   * offered as {{steps.<name>.output}} suggestions. */
  priorStepNames: string[];
  /** When adding a brand-new step, the step immediately before it (if any) —
   * its agent/workingDir/validate/maxRetries are reused as defaults so
   * consecutive similar steps don't require retyping them. */
  previousStep?: FlowStep;
  onSave: (step: FlowStep) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<FlowStep>(
    step
      ? { ...step }
      : {
          id: newStepId(),
          name: "",
          agent: previousStep?.agent ?? AGENTS[0]?.id ?? "claude",
          customCommand: previousStep?.agent === "custom" ? previousStep.customCommand : undefined,
          prompt: "",
          expectedResult: "",
          validate: previousStep?.validate ?? true,
          maxRetries: previousStep?.maxRetries ?? 1,
          workingDir: previousStep?.workingDir,
          continueSession: false,
        },
  );
  const [cursor, setCursor] = useState(0);
  const [editingField, setEditingField] = useState<TextField | null>(null);
  const [editingAgent, setEditingAgent] = useState(false);
  const [editingValidate, setEditingValidate] = useState(false);
  const [editingContinue, setEditingContinue] = useState(false);
  const [fieldDraft, setFieldDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [suggest, setSuggest] = useState<SuggestState | null>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);
  // Anchor the user last dismissed with Escape, so recomputeSuggestions
  // doesn't immediately reopen the same popup (see dismissSuggest below).
  const dismissedRef = useRef<{ field: PlaceholderField; anchor: number } | null>(null);

  const placeholderItems = useMemo(() => {
    const paramItems = parameters.filter((p) => p.name.trim() !== "").map((p) => `params.${p.name}`);
    const stepItems = priorStepNames.filter((n) => n.trim() !== "").map((n) => `steps.${n}.output`);
    return [...paramItems, ...stepItems];
  }, [parameters, priorStepNames]);

  function computeSuggestState(field: PlaceholderField): SuggestState | null {
    const ta = textareaRef.current;
    if (!ta) return null;
    const text = ta.plainText;
    const cursor = ta.cursorOffset;
    const openIdx = text.slice(0, cursor).lastIndexOf("{{");
    if (openIdx === -1) return null;
    const anchor = openIdx + 2;
    // The user explicitly dismissed the popup for this exact "{{" with
    // Escape — don't reopen it until they start a new one (a different
    // anchor) or finish editing.
    if (dismissedRef.current && dismissedRef.current.field === field && dismissedRef.current.anchor === anchor) {
      return null;
    }
    const rawQuery = text.slice(anchor, cursor);
    // A "}}" in between means this placeholder is already closed (or we're
    // re-scanning right after inserting one) — nothing to suggest. A
    // newline means the user has moved on without closing it.
    if (rawQuery.includes("}}") || rawQuery.includes("\n")) return null;
    const q = rawQuery.trimStart().toLowerCase();
    const matches = placeholderItems
      .filter((p) => p.toLowerCase().includes(q))
      .sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)));
    if (matches.length === 0) return null;
    return {
      field,
      anchor,
      items: matches.slice(0, MAX_SUGGESTIONS),
      index: 0,
      overflow: Math.max(0, matches.length - MAX_SUGGESTIONS),
    };
  }

  function sameSuggestState(a: SuggestState | null, b: SuggestState | null): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
      a.field === b.field &&
      a.anchor === b.anchor &&
      a.index === b.index &&
      a.items.length === b.items.length &&
      a.items.every((item, i) => item === b.items[i])
    );
  }

  /** Re-scan the focused textarea for an open "{{" before the cursor and
   * refresh (or close) the suggestion dropdown accordingly. Called after
   * every content/cursor change while editing prompt/expectedResult — and,
   * per the underlying renderable's implementation, possibly more often
   * than that with no real change (e.g. cursor blink). Bailing out to the
   * *same* state object when nothing changed (rather than always building a
   * fresh one) matters: a fresh object would fail React's Object.is check
   * every time and force an endless re-render loop. */
  function recomputeSuggestions(field: PlaceholderField) {
    const next = computeSuggestState(field);
    setSuggest((prev) => (sameSuggestState(prev, next) ? prev : next));
  }

  /** Replace the partial text the user has typed since the triggering "{{"
   * (anchor is already right after it) through the live cursor with the
   * chosen placeholder's path plus its closing "}}". */
  function acceptSuggestion() {
    if (!suggest) return;
    const ta = textareaRef.current;
    if (!ta) {
      setSuggest(null);
      return;
    }
    const text = ta.plainText;
    const cursor = ta.cursorOffset;
    const before = text.slice(0, suggest.anchor);
    const after = text.slice(cursor);
    const inserted = `${suggest.items[suggest.index]}}}`;
    ta.replaceText(before + inserted + after);
    ta.cursorOffset = before.length + inserted.length;
    setSuggest(null);
  }

  /** Close the popup on Escape without touching the placeholder text. This
   * is the one popup-closing transition with no accompanying text edit —
   * unlike typing "{{" (opens it) or accepting a suggestion (closes it via
   * replaceText) — and toggling the popup's visibility alone was found not
   * to reliably repaint immediately in this renderer (it only caught up on
   * the next unrelated keystroke). Recording the dismissal and nudging the
   * buffer with a no-op replaceText forces the same repaint path typing
   * already uses, while dismissedRef (checked in computeSuggestState) stops
   * that nudge's own onContentChange from reopening the same popup. */
  function dismissSuggest() {
    if (suggest) dismissedRef.current = { field: suggest.field, anchor: suggest.anchor };
    setSuggest(null);
    const ta = textareaRef.current;
    if (ta) {
      const pos = ta.cursorOffset;
      ta.replaceText(ta.plainText);
      ta.cursorOffset = pos;
    }
  }

  const rows: string[] = ["name", "agent"];
  if (draft.agent === "custom") rows.push("customCommand");
  rows.push(
    "prompt",
    "expectedResult",
    "validate",
    "continueSession",
    "maxRetries",
    "workingDir",
    "save",
    "cancel",
  );
  const safeCursor = clamp(cursor, 0, rows.length - 1);

  function beginEdit(field: TextField, initial: string) {
    setFieldDraft(initial);
    setEditingField(field);
  }

  function commitField() {
    setDraft((d) => {
      switch (editingField) {
        case "name":
          return { ...d, name: fieldDraft.trim() };
        case "customCommand":
          return { ...d, customCommand: fieldDraft || undefined };
        case "maxRetries": {
          const n = Number.parseInt(fieldDraft, 10);
          return { ...d, maxRetries: clamp(Number.isNaN(n) ? 0 : n, 0, 5) };
        }
        case "workingDir":
          return { ...d, workingDir: fieldDraft || undefined };
        default:
          return d;
      }
    });
    setEditingField(null);
  }

  /** Prompt / expected result are edited in a <textarea>, which is
   * uncontrolled — read its live value off the ref rather than fieldDraft,
   * and treat "esc" as the commit key (plain ⏎ inserts a newline inside a
   * textarea, so it can't double as "save" the way it does for <input>). */
  function commitTextareaField(field: "prompt" | "expectedResult") {
    const val = textareaRef.current?.plainText ?? fieldDraft;
    setDraft((d) => (field === "prompt" ? { ...d, prompt: val } : { ...d, expectedResult: val }));
    setEditingField(null);
    setSuggest(null);
    dismissedRef.current = null;
  }

  function trySave() {
    if (draft.name.trim() === "") {
      setError("Step name is required");
      setCursor(rows.indexOf("name"));
      return;
    }
    if (draft.prompt.trim() === "") {
      setError("Prompt is required");
      setCursor(rows.indexOf("prompt"));
      return;
    }
    if (draft.agent === "custom" && !draft.customCommand?.trim()) {
      setError("Custom command is required for the custom agent");
      setCursor(rows.indexOf("customCommand"));
      return;
    }
    onSave({ ...draft, name: draft.name.trim() });
  }

  function activate(row: string) {
    switch (row) {
      case "name":
        beginEdit("name", draft.name);
        break;
      case "agent":
        setEditingAgent(true);
        break;
      case "customCommand":
        beginEdit("customCommand", draft.customCommand ?? "");
        break;
      case "prompt":
        setFieldDraft(draft.prompt);
        setEditingField("prompt");
        break;
      case "expectedResult":
        setFieldDraft(draft.expectedResult);
        setEditingField("expectedResult");
        break;
      case "validate":
        setEditingValidate(true);
        break;
      case "continueSession":
        if (!agentSupportsContinuation(draft.agent)) break;
        setEditingContinue(true);
        break;
      case "maxRetries":
        beginEdit("maxRetries", String(draft.maxRetries));
        break;
      case "workingDir":
        beginEdit("workingDir", draft.workingDir ?? "");
        break;
      case "save":
        trySave();
        break;
      case "cancel":
        onCancel();
        break;
    }
  }

  useKeyboard((key) => {
    if (editingAgent) {
      if (key.name === "escape") setEditingAgent(false);
      return;
    }
    if (editingValidate) {
      if (key.name === "escape") setEditingValidate(false);
      return;
    }
    if (editingContinue) {
      if (key.name === "escape") setEditingContinue(false);
      return;
    }
    if (editingField === "prompt" || editingField === "expectedResult") {
      if (suggest && suggest.field === editingField) {
        // Intercept before the textarea's own handling: preventDefault stops
        // it from also inserting a newline/moving its cursor for the same
        // keystroke (global "keypress" listeners run before the focused
        // renderable's own handler — see @opentui/core's KeyHandler).
        if (key.name === "escape") {
          key.preventDefault();
          dismissSuggest();
          return;
        }
        if (key.name === "up") {
          key.preventDefault();
          setSuggest((s) => (s ? { ...s, index: (s.index - 1 + s.items.length) % s.items.length } : s));
          return;
        }
        if (key.name === "down") {
          key.preventDefault();
          setSuggest((s) => (s ? { ...s, index: (s.index + 1) % s.items.length } : s));
          return;
        }
        if (key.name === "return") {
          key.preventDefault();
          acceptSuggestion();
          return;
        }
      }
      if (key.name === "escape") commitTextareaField(editingField);
      return;
    }
    if (editingField) {
      if (key.name === "escape") setEditingField(null);
      return;
    }
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.name === "left" && rows[safeCursor] === "cancel") {
      setCursor(rows.indexOf("save"));
      return;
    }
    if (key.name === "right" && rows[safeCursor] === "save") {
      setCursor(rows.indexOf("cancel"));
      return;
    }
    if (key.name === "up") {
      setCursor((c) => clamp(c - 1, 0, rows.length - 1));
      return;
    }
    if (key.name === "down") {
      setCursor((c) => clamp(c + 1, 0, rows.length - 1));
      return;
    }
    if (key.name === "return") {
      activate(rows[safeCursor]!);
    }
  });

  const agentOptions: TabSelectOption[] = AGENTS.map((a) => ({
    name: agentAvailable(a) ? a.label : `${a.label}*`,
    description: a.binary ? `binary: ${a.binary}` : "custom shell command",
    value: a.id,
  }));
  const agentLabel = AGENTS.find((a) => a.id === draft.agent)?.label ?? draft.agent;
  const isRow = (name: string) => rows[safeCursor] === name;

  // Contextual bottom hint bar: keys available for the currently selected
  // row, plus screen-level keys.
  const bottomHints: KeyHintSpec[] = editingAgent
    ? [
        { keys: "←→", label: "choose" },
        { keys: "⏎", label: "confirm" },
        { keys: "esc", label: "cancel" },
      ]
    : editingValidate || editingContinue
      ? [
          { keys: "←→", label: "choose" },
          { keys: "⏎", label: "confirm" },
          { keys: "esc", label: "cancel" },
        ]
      : editingField === "prompt" || editingField === "expectedResult"
        ? suggest && suggest.field === editingField
          ? [
              { keys: "↑↓", label: "select" },
              { keys: "⏎", label: "insert" },
              { keys: "esc", label: "close" },
            ]
          : [{ keys: "esc", label: "done" }]
        : editingField
          ? [
              { keys: "⏎", label: "save" },
              { keys: "esc", label: "cancel" },
            ]
          : [
              ...(rows[safeCursor] === "agent"
                ? [{ keys: "⏎", label: "choose" }]
                : rows[safeCursor] === "validate" || rows[safeCursor] === "continueSession"
                  ? [{ keys: "⏎", label: "toggle" }]
                  : rows[safeCursor] === "save"
                    ? [
                        { keys: "⏎", label: "save" },
                        { keys: "→", label: "cancel" },
                      ]
                    : rows[safeCursor] === "cancel"
                      ? [
                          { keys: "⏎", label: "back" },
                          { keys: "←", label: "save" },
                        ]
                      : [{ keys: "⏎", label: "edit" }]),
              { keys: "up/down", label: "move" },
              { keys: "esc", label: "back" },
            ];

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        title={step ? "Edit step" : "New step"}
        margin={1}
        padding={1}
      >
        <FieldRow
          label="Name"
          selected={isRow("name")}
          editing={editingField === "name"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.name}
          placeholder="(unnamed)"
        />

        <box flexDirection="column">
          <box flexDirection="row" backgroundColor={isRow("agent") ? colors.selectionBg : undefined}>
            <text fg={isRow("agent") ? colors.selectionFg : colors.textSecondary} bg={isRow("agent") ? colors.selectionBg : undefined}>
              {marker(isRow("agent"))}Agent
            </text>
            {isRow("agent") && !editingAgent && (
              <RowHint hints={[{ keys: "⏎", label: "choose" }]} bg={colors.selectionBg} />
            )}
          </box>
          {editingAgent ? (
            <box height={3}>
              <tab-select
                ref={(node) => {
                  if (node) node.setSelectedIndex(Math.max(0, AGENTS.findIndex((a) => a.id === draft.agent)));
                }}
                focused
                flexGrow={1}
                tabWidth={20}
                showDescription
                options={agentOptions}
                onSelect={(_i, option) => {
                  if (option) setDraft((d) => ({ ...d, agent: option.value }));
                  setEditingAgent(false);
                }}
                textColor={colors.textPrimary}
                backgroundColor={colors.bg}
                focusedBackgroundColor={colors.bg}
                focusedTextColor={colors.textPrimary}
                selectedBackgroundColor={colors.selectionBg}
                selectedTextColor={colors.selectionFg}
                selectedDescriptionColor={colors.selectionFg}
              />
            </box>
          ) : (
            <box flexDirection="row" backgroundColor={isRow("agent") ? colors.selectionBg : undefined}>
              <text
                fg={isRow("agent") ? colors.selectionFg : colors.textPrimary}
                bg={isRow("agent") ? colors.selectionBg : undefined}
              >
                {"  "}
                {agentLabel}
              </text>
            </box>
          )}
        </box>

        {draft.agent === "custom" && (
          <FieldRow
            label="Custom command (uses $FLOW_PROMPT)"
            selected={isRow("customCommand")}
            editing={editingField === "customCommand"}
            fieldDraft={fieldDraft}
            onInput={setFieldDraft}
            onSubmit={commitField}
            value={draft.customCommand ?? ""}
            placeholder="(none)"
          />
        )}

        <TextAreaFieldRow
          label="Prompt (type {{ for suggestions from params/prior steps)"
          selected={isRow("prompt")}
          editing={editingField === "prompt"}
          textareaRef={textareaRef}
          initialValue={fieldDraft}
          value={draft.prompt}
          placeholder="(empty)"
          onContentChange={() => recomputeSuggestions("prompt")}
          onCursorChange={() => recomputeSuggestions("prompt")}
        />
        <SuggestionDropdown
          visible={editingField === "prompt" && suggest?.field === "prompt"}
          items={suggest?.field === "prompt" ? suggest.items : []}
          activeIndex={suggest?.field === "prompt" ? suggest.index : 0}
          more={suggest?.field === "prompt" ? suggest.overflow : 0}
        />

        <TextAreaFieldRow
          label="Expected result (used by the validator; type {{ for suggestions)"
          selected={isRow("expectedResult")}
          editing={editingField === "expectedResult"}
          textareaRef={textareaRef}
          initialValue={fieldDraft}
          value={draft.expectedResult}
          placeholder="(empty)"
          onContentChange={() => recomputeSuggestions("expectedResult")}
          onCursorChange={() => recomputeSuggestions("expectedResult")}
        />
        <SuggestionDropdown
          visible={editingField === "expectedResult" && suggest?.field === "expectedResult"}
          items={suggest?.field === "expectedResult" ? suggest.items : []}
          activeIndex={suggest?.field === "expectedResult" ? suggest.index : 0}
          more={suggest?.field === "expectedResult" ? suggest.overflow : 0}
        />

        <TabToggleRow
          label="Validate output"
          selected={isRow("validate")}
          editing={editingValidate}
          value={draft.validate}
          onSelect={(v) => {
            setDraft((d) => ({ ...d, validate: v }));
            setEditingValidate(false);
          }}
        />

        <TabToggleRow
          label="Continue session"
          selected={isRow("continueSession")}
          editing={editingContinue}
          value={!!draft.continueSession}
          disabled={!agentSupportsContinuation(draft.agent)}
          disabledNote="not supported for this agent"
          onSelect={(v) => {
            setDraft((d) => ({ ...d, continueSession: v }));
            setEditingContinue(false);
          }}
        />

        <FieldRow
          label="Max retries (0-5)"
          selected={isRow("maxRetries")}
          editing={editingField === "maxRetries"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={String(draft.maxRetries)}
          placeholder="0"
        />

        <FieldRow
          label="Working directory (optional)"
          selected={isRow("workingDir")}
          editing={editingField === "workingDir"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.workingDir ?? ""}
          placeholder="(cwd)"
        />

        <ButtonRow
          buttons={[
            { label: "▶ Save step", selected: isRow("save") },
            { label: "Cancel", selected: isRow("cancel") },
          ]}
        />
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
