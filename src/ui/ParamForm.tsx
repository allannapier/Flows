import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { FlowParameter } from "../types";
import { colors, Hint } from "./theme";

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
        setDraft((d) => ({ ...d, required: !d.required }));
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
    if (editing) {
      if (key.name === "escape") setEditing(null);
      return;
    }
    if (key.name === "escape") {
      onCancel();
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
        <box flexDirection="column">
          <text fg={cursor === 0 ? colors.accent : colors.text}>Name</text>
          {editing === "name" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.name || "(unnamed)"}</text>
          )}
        </box>
        <box flexDirection="column">
          <text fg={cursor === 1 ? colors.accent : colors.text}>Description</text>
          {editing === "description" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.description || "(none)"}</text>
          )}
        </box>
        <text fg={cursor === 2 ? colors.accent : colors.text}>
          Required: {draft.required ? "[x] yes" : "[ ] no"}
        </text>
        <box flexDirection="column">
          <text fg={cursor === 3 ? colors.accent : colors.text}>Default value</text>
          {editing === "default" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.default || "(none)"}</text>
          )}
        </box>
        <text fg={cursor === 4 ? colors.accent : colors.success}>▶ Save parameter</text>
        <text fg={cursor === 5 ? colors.accent : colors.dim}>Cancel</text>
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint>enter edit/toggle/save · up/down move · esc back</Hint>
    </box>
  );
}
