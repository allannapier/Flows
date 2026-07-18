import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { FlowParameter } from "../types";
import { colors, Hint, FieldRow, TabToggleRow, ButtonRow, type KeyHintSpec } from "./theme";

type FieldKind = "name" | "description" | "default";

const ROWS: Array<"name" | "description" | "required" | "default" | "save" | "cancel"> = [
  "name",
  "description",
  "required",
  "default",
  "save",
  "cancel",
];

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
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<FieldKind | null>(null);
  const [editingRequired, setEditingRequired] = useState(false);
  const [fieldDraft, setFieldDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function beginEdit(field: FieldKind, initial: string) {
    setFieldDraft(initial);
    setEditing(field);
  }

  function commitField() {
    if (editing === "name") setDraft((d) => ({ ...d, name: fieldDraft.trim() }));
    else if (editing === "description") setDraft((d) => ({ ...d, description: fieldDraft }));
    else if (editing === "default") setDraft((d) => ({ ...d, default: fieldDraft || undefined }));
    setEditing(null);
  }

  function trySave() {
    if (draft.name.trim() === "") {
      setError("Parameter name is required");
      setCursor(0);
      return;
    }
    onSave({ ...draft, name: draft.name.trim() });
  }

  function activate(row: (typeof ROWS)[number]) {
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
      case "default":
        beginEdit("default", draft.default ?? "");
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
    if (editing) {
      if (key.name === "escape") setEditing(null);
      return;
    }
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.name === "left" && ROWS[cursor] === "cancel") {
      setCursor(ROWS.indexOf("save"));
      return;
    }
    if (key.name === "right" && ROWS[cursor] === "save") {
      setCursor(ROWS.indexOf("cancel"));
      return;
    }
    if (key.name === "up") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "down") {
      setCursor((c) => Math.min(ROWS.length - 1, c + 1));
      return;
    }
    if (key.name === "return") {
      activate(ROWS[cursor]!);
    }
  });

  const row = ROWS[cursor];
  const bottomHints: KeyHintSpec[] = editingRequired
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
          selected={cursor === 0}
          editing={editing === "name"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.name}
          placeholder="(unnamed)"
        />
        <FieldRow
          label="Description"
          selected={cursor === 1}
          editing={editing === "description"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.description}
          placeholder="(none)"
        />
        <TabToggleRow
          label="Required"
          selected={cursor === 2}
          editing={editingRequired}
          value={draft.required}
          onSelect={(v) => {
            setDraft((d) => ({ ...d, required: v }));
            setEditingRequired(false);
          }}
        />
        <FieldRow
          label="Default value"
          selected={cursor === 3}
          editing={editing === "default"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.default ?? ""}
          placeholder="(none)"
        />
        <ButtonRow
          buttons={[
            { label: "▶ Save parameter", selected: cursor === 4 },
            { label: "Cancel", selected: cursor === 5 },
          ]}
        />
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
