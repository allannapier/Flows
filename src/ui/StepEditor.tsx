import { useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { TabSelectOption, TextareaRenderable } from "@opentui/core";
import { AGENTS, agentAvailable, agentSupportsContinuation } from "../core/agents";
import type { FlowStep } from "../types";
import {
  colors,
  Hint,
  FieldRow,
  TabToggleRow,
  TextAreaFieldRow,
  ButtonRow,
  RowHint,
  marker,
  type KeyHintSpec,
} from "./theme";

type TextField = "name" | "customCommand" | "prompt" | "expectedResult" | "maxRetries" | "workingDir";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function newStepId(): string {
  return crypto.randomUUID();
}

export function StepEditor({
  step,
  onSave,
  onCancel,
}: {
  step: FlowStep | null;
  onSave: (step: FlowStep) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<FlowStep>(
    step
      ? { ...step }
      : {
          id: newStepId(),
          name: "",
          agent: AGENTS[0]?.id ?? "claude",
          prompt: "",
          expectedResult: "",
          validate: true,
          maxRetries: 1,
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
  const textareaRef = useRef<TextareaRenderable | null>(null);

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
        ? [{ keys: "esc", label: "done" }]
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
          label={`Prompt (supports {{params.<name>}} and {{steps.<name>.output}})`}
          selected={isRow("prompt")}
          editing={editingField === "prompt"}
          textareaRef={textareaRef}
          initialValue={fieldDraft}
          value={draft.prompt}
          placeholder="(empty)"
        />

        <TextAreaFieldRow
          label="Expected result (used by the validator)"
          selected={isRow("expectedResult")}
          editing={editingField === "expectedResult"}
          textareaRef={textareaRef}
          initialValue={fieldDraft}
          value={draft.expectedResult}
          placeholder="(empty)"
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
