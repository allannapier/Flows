import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { TabSelectOption } from "@opentui/core";
import type { FlowParameter } from "../types";
import { colors, Hint, FieldRow, TabToggleRow, ButtonRow, RowHint, marker, type KeyHintSpec } from "./theme";

type FieldKind = "name" | "description" | "default" | "choices";
type InputType = "text" | "choice";

const INPUT_TYPE_OPTIONS: TabSelectOption[] = [
  { name: "Free text", description: "type any value at run time", value: "text" },
  { name: "Choices", description: "pick from a fixed list at run time", value: "choice" },
];

function parseChoices(text: string): string[] {
  return Array.from(new Set(text.split(",").map((s) => s.trim()).filter(Boolean)));
}

export function ParamForm({
  param,
  onSave,
  onCancel,
}: {
  param: FlowParameter | null;
  onSave: (param: FlowParameter) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<FlowParameter>(
    param ? { ...param } : { name: "", description: "", required: false, default: "" },
  );
  const [inputType, setInputType] = useState<InputType>(param?.choices?.length ? "choice" : "text");
  const [choicesText, setChoicesText] = useState<string>(param?.choices?.join(", ") ?? "");
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<FieldKind | null>(null);
  const [editingRequired, setEditingRequired] = useState(false);
  const [editingInputType, setEditingInputType] = useState(false);
  const [editingDefaultChoice, setEditingDefaultChoice] = useState(false);
  const [fieldDraft, setFieldDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rows: Array<"name" | "description" | "required" | "inputType" | "choices" | "default" | "save" | "cancel"> = [
    "name",
    "description",
    "required",
    "inputType",
  ];
  if (inputType === "choice") rows.push("choices");
  rows.push("default", "save", "cancel");
  const safeCursor = Math.max(0, Math.min(cursor, rows.length - 1));

  const parsedChoices = parseChoices(choicesText);

  function beginEdit(field: FieldKind, initial: string) {
    setFieldDraft(initial);
    setEditing(field);
  }

  function commitField() {
    if (editing === "name") setDraft((d) => ({ ...d, name: fieldDraft.trim() }));
    else if (editing === "description") setDraft((d) => ({ ...d, description: fieldDraft }));
    else if (editing === "default") setDraft((d) => ({ ...d, default: fieldDraft || undefined }));
    else if (editing === "choices") setChoicesText(fieldDraft);
    setEditing(null);
  }

  function trySave() {
    if (draft.name.trim() === "") {
      setError("Parameter name is required");
      setCursor(rows.indexOf("name"));
      return;
    }
    if (inputType === "choice" && parsedChoices.length === 0) {
      setError("Add at least one choice, or switch input type back to Free text");
      setCursor(rows.indexOf("choices"));
      return;
    }
    const choices = inputType === "choice" ? parsedChoices : undefined;
    const finalDefault =
      inputType === "choice" ? (draft.default && choices!.includes(draft.default) ? draft.default : undefined) : draft.default;
    onSave({ ...draft, name: draft.name.trim(), default: finalDefault, choices });
  }

  function activate(row: (typeof rows)[number]) {
    switch (row) {
      case "name":
        beginEdit("name", draft.name);
        break;
      case "description":
        beginEdit("description", draft.description);
        break;
      case "required":
        setEditingRequired(true);
        break;
      case "inputType":
        setEditingInputType(true);
        break;
      case "choices":
        beginEdit("choices", choicesText);
        break;
      case "default":
        if (inputType === "choice") setEditingDefaultChoice(true);
        else beginEdit("default", draft.default ?? "");
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
    if (editingRequired) {
      if (key.name === "escape") setEditingRequired(false);
      return;
    }
    if (editingInputType) {
      if (key.name === "escape") setEditingInputType(false);
      return;
    }
    if (editingDefaultChoice) {
      if (key.name === "escape") setEditingDefaultChoice(false);
      return;
    }
    if (editing) {
      if (key.name === "escape") setEditing(null);
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
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "down") {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
      return;
    }
    if (key.name === "return") {
      activate(rows[safeCursor]!);
    }
  });

  const row = rows[safeCursor];
  const isRow = (name: string) => row === name;
  const bottomHints: KeyHintSpec[] = editingRequired || editingInputType || editingDefaultChoice
    ? [
        { keys: "←→", label: "choose" },
        { keys: "⏎", label: "confirm" },
        { keys: "esc", label: "cancel" },
      ]
    : editing
      ? [
          { keys: "⏎", label: "save" },
          { keys: "esc", label: "cancel" },
        ]
      : [
          ...(row === "required"
            ? [{ keys: "⏎", label: "toggle" }]
            : row === "inputType"
              ? [{ keys: "⏎", label: "choose" }]
              : row === "default" && inputType === "choice"
                ? [{ keys: "⏎", label: "choose" }]
                : row === "save"
                  ? [
                      { keys: "⏎", label: "save" },
                      { keys: "→", label: "cancel" },
                    ]
                  : row === "cancel"
                    ? [
                        { keys: "⏎", label: "back" },
                        { keys: "←", label: "save" },
                      ]
                    : [{ keys: "⏎", label: "edit" }]),
          { keys: "up/down", label: "move" },
          { keys: "esc", label: "back" },
        ];

  const defaultOptions: TabSelectOption[] = [
    { name: "(none)", description: "", value: "" },
    ...parsedChoices.map((c) => ({ name: c, description: "", value: c })),
  ];
  const defaultIndex = draft.default ? Math.max(0, parsedChoices.indexOf(draft.default) + 1) : 0;

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        title={param ? "Edit parameter" : "New parameter"}
        margin={1}
        padding={1}
      >
        <FieldRow
          label="Name"
          selected={isRow("name")}
          editing={editing === "name"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.name}
          placeholder="(unnamed)"
        />
        <FieldRow
          label="Description"
          selected={isRow("description")}
          editing={editing === "description"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.description}
          placeholder="(none)"
        />
        <TabToggleRow
          label="Required"
          selected={isRow("required")}
          editing={editingRequired}
          value={draft.required}
          onSelect={(v) => {
            setDraft((d) => ({ ...d, required: v }));
            setEditingRequired(false);
          }}
        />

        <box flexDirection="column">
          <box flexDirection="row" backgroundColor={isRow("inputType") ? colors.selectionBg : undefined}>
            <text
              fg={isRow("inputType") ? colors.selectionFg : colors.textSecondary}
              bg={isRow("inputType") ? colors.selectionBg : undefined}
            >
              {marker(isRow("inputType"))}Input type
            </text>
            {isRow("inputType") && !editingInputType && (
              <RowHint hints={[{ keys: "⏎", label: "choose" }]} bg={colors.selectionBg} />
            )}
          </box>
          {editingInputType ? (
            <box height={3}>
              <tab-select
                ref={(node) => {
                  if (node) node.setSelectedIndex(inputType === "choice" ? 1 : 0);
                }}
                focused
                flexGrow={1}
                tabWidth={16}
                showDescription
                options={INPUT_TYPE_OPTIONS}
                onSelect={(_i, option) => {
                  if (option) setInputType(option.value as InputType);
                  setEditingInputType(false);
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
            <box flexDirection="row" backgroundColor={isRow("inputType") ? colors.selectionBg : undefined}>
              <text
                fg={isRow("inputType") ? colors.selectionFg : colors.textPrimary}
                bg={isRow("inputType") ? colors.selectionBg : undefined}
              >
                {"  "}
                {inputType === "choice" ? "Choices" : "Free text"}
              </text>
            </box>
          )}
        </box>

        {inputType === "choice" && (
          <FieldRow
            label="Choices (comma-separated)"
            selected={isRow("choices")}
            editing={editing === "choices"}
            fieldDraft={fieldDraft}
            onInput={setFieldDraft}
            onSubmit={commitField}
            value={choicesText}
            placeholder="e.g. small, medium, large"
          />
        )}

        {inputType === "choice" ? (
          <box flexDirection="column">
            <box flexDirection="row" backgroundColor={isRow("default") ? colors.selectionBg : undefined}>
              <text
                fg={isRow("default") ? colors.selectionFg : colors.textSecondary}
                bg={isRow("default") ? colors.selectionBg : undefined}
              >
                {marker(isRow("default"))}Default value
              </text>
              {isRow("default") && !editingDefaultChoice && (
                <RowHint hints={[{ keys: "⏎", label: "choose" }]} bg={colors.selectionBg} />
              )}
            </box>
            {editingDefaultChoice ? (
              <box height={3}>
                <tab-select
                  ref={(node) => {
                    if (node) node.setSelectedIndex(defaultIndex);
                  }}
                  focused
                  flexGrow={1}
                  tabWidth={14}
                  showDescription={false}
                  options={defaultOptions}
                  onSelect={(_i, option) => {
                    setDraft((d) => ({ ...d, default: option?.value || undefined }));
                    setEditingDefaultChoice(false);
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
              <box flexDirection="row" backgroundColor={isRow("default") ? colors.selectionBg : undefined}>
                <text
                  fg={isRow("default") ? colors.selectionFg : colors.textPrimary}
                  bg={isRow("default") ? colors.selectionBg : undefined}
                >
                  {"  "}
                  {draft.default || "(none)"}
                </text>
              </box>
            )}
          </box>
        ) : (
          <FieldRow
            label="Default value"
            selected={isRow("default")}
            editing={editing === "default"}
            fieldDraft={fieldDraft}
            onInput={setFieldDraft}
            onSubmit={commitField}
            value={draft.default ?? ""}
            placeholder="(none)"
          />
        )}

        <ButtonRow
          buttons={[
            { label: "▶ Save parameter", selected: isRow("save") },
            { label: "Cancel", selected: isRow("cancel") },
          ]}
        />
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
