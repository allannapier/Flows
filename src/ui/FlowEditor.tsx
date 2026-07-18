import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { getFlow, saveFlow, newFlowId } from "../core/storage";
import type { Flow, FlowParameter, FlowStep } from "../types";
import { colors, Hint, SimpleRow, FieldRow, type KeyHintSpec } from "./theme";
import { ParamForm } from "./ParamForm";
import { StepEditor } from "./StepEditor";

type RowKind =
  | { kind: "name" }
  | { kind: "description" }
  | { kind: "param"; index: number }
  | { kind: "add-param" }
  | { kind: "step"; index: number }
  | { kind: "add-step" }
  | { kind: "save" }
  | { kind: "cancel" };

function emptyFlow(): Flow {
  const now = new Date().toISOString();
  return {
    id: newFlowId(),
    name: "",
    description: "",
    parameters: [],
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
}

function classifyRow(draft: Flow, idx: number): RowKind {
  let i = idx;
  if (i === 0) return { kind: "name" };
  i--;
  if (i === 0) return { kind: "description" };
  i--;
  if (i < draft.parameters.length) return { kind: "param", index: i };
  i -= draft.parameters.length;
  if (i === 0) return { kind: "add-param" };
  i--;
  if (i < draft.steps.length) return { kind: "step", index: i };
  i -= draft.steps.length;
  if (i === 0) return { kind: "add-step" };
  i--;
  if (i === 0) return { kind: "save" };
  return { kind: "cancel" };
}

function totalRows(draft: Flow): number {
  // name, description, params..., add-param, steps..., add-step, save, cancel
  return 2 + draft.parameters.length + 1 + draft.steps.length + 1 + 2;
}

type Mode = "browse" | "edit-field" | "param-form" | "step-form";

export function FlowEditor({
  flowId,
  onDone,
  onCancel,
}: {
  flowId?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Flow>(() => {
    if (flowId) {
      const existing = getFlow(flowId);
      if (existing) return structuredClone(existing);
    }
    return emptyFlow();
  });
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>("browse");
  const [editingField, setEditingField] = useState<"name" | "description" | null>(null);
  const [fieldDraft, setFieldDraft] = useState("");
  const [paramFormIndex, setParamFormIndex] = useState<number | null>(null);
  const [stepFormIndex, setStepFormIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = totalRows(draft);
  const safeCursor = Math.max(0, Math.min(cursor, rows - 1));

  function doSave() {
    if (draft.name.trim() === "") {
      setError("Flow name is required");
      setCursor(0);
      return;
    }
    saveFlow({ ...draft, name: draft.name.trim() });
    onDone();
  }

  function beginEditField(field: "name" | "description") {
    setFieldDraft(field === "name" ? draft.name : draft.description);
    setEditingField(field);
    setMode("edit-field");
  }

  function commitField() {
    setDraft((d) =>
      editingField === "name" ? { ...d, name: fieldDraft } : editingField === "description" ? { ...d, description: fieldDraft } : d,
    );
    setEditingField(null);
    setMode("browse");
  }

  function removeAt(row: RowKind) {
    if (row.kind === "param") {
      setDraft((d) => ({ ...d, parameters: d.parameters.filter((_, i) => i !== row.index) }));
      setCursor((c) => Math.max(0, c - 1));
    } else if (row.kind === "step") {
      setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== row.index) }));
      setCursor((c) => Math.max(0, c - 1));
    }
  }

  function moveStep(index: number, dir: -1 | 1) {
    setDraft((d) => {
      const target = index + dir;
      if (target < 0 || target >= d.steps.length) return d;
      const steps = [...d.steps];
      const tmp = steps[index]!;
      steps[index] = steps[target]!;
      steps[target] = tmp;
      return { ...d, steps };
    });
    setCursor((c) => c + dir);
  }

  function activate(row: RowKind) {
    switch (row.kind) {
      case "name":
        beginEditField("name");
        break;
      case "description":
        beginEditField("description");
        break;
      case "param":
        setParamFormIndex(row.index);
        setMode("param-form");
        break;
      case "add-param":
        setParamFormIndex(null);
        setMode("param-form");
        break;
      case "step":
        setStepFormIndex(row.index);
        setMode("step-form");
        break;
      case "add-step":
        setStepFormIndex(null);
        setMode("step-form");
        break;
      case "save":
        doSave();
        break;
      case "cancel":
        onCancel();
        break;
    }
  }

  useKeyboard((key) => {
    if (mode === "edit-field") {
      if (key.name === "escape") {
        setEditingField(null);
        setMode("browse");
      }
      return;
    }
    if (mode !== "browse") {
      // param-form / step-form manage their own keyboard handling.
      return;
    }
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.ctrl && key.name === "s") {
      doSave();
      return;
    }
    const row = classifyRow(draft, safeCursor);
    if (key.shift && key.name === "up" && row.kind === "step") {
      moveStep(row.index, -1);
      return;
    }
    if (key.shift && key.name === "down" && row.kind === "step") {
      moveStep(row.index, 1);
      return;
    }
    if (key.name === "up") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "down") {
      setCursor((c) => Math.min(rows - 1, c + 1));
      return;
    }
    if (key.name === "return") {
      activate(row);
      return;
    }
    if (key.name === "d" && !key.ctrl && !key.meta) {
      removeAt(row);
    }
  });

  if (mode === "param-form") {
    const existing: FlowParameter | null = paramFormIndex === null ? null : draft.parameters[paramFormIndex] ?? null;
    return (
      <ParamForm
        param={existing}
        onCancel={() => setMode("browse")}
        onSave={(p) => {
          setDraft((d) => {
            const parameters = [...d.parameters];
            if (paramFormIndex === null) parameters.push(p);
            else parameters[paramFormIndex] = p;
            return { ...d, parameters };
          });
          setMode("browse");
        }}
      />
    );
  }

  if (mode === "step-form") {
    const existing: FlowStep | null = stepFormIndex === null ? null : draft.steps[stepFormIndex] ?? null;
    return (
      <StepEditor
        step={existing}
        onCancel={() => setMode("browse")}
        onSave={(s) => {
          setDraft((d) => {
            const steps = [...d.steps];
            if (stepFormIndex === null) steps.push(s);
            else steps[stepFormIndex] = s;
            return { ...d, steps };
          });
          setMode("browse");
        }}
      />
    );
  }

  const cur = classifyRow(draft, safeCursor);
  const isRow = (kind: RowKind["kind"], index?: number) =>
    cur.kind === kind && (index === undefined || (cur as any).index === index);

  const paramsActive = cur.kind === "param" || cur.kind === "add-param";
  const stepsActive = cur.kind === "step" || cur.kind === "add-step";
  const editingField_ = mode === "edit-field";

  // Contextual bottom hint bar: the selected row's own keys, plus
  // screen-level keys that are always available in browse mode.
  const bottomHints: KeyHintSpec[] = editingField_
    ? [
        { keys: "⏎", label: "save" },
        { keys: "esc", label: "cancel" },
      ]
    : [
        ...(cur.kind === "param" || cur.kind === "step"
          ? [
              { keys: "⏎", label: "open" },
              { keys: "d", label: "delete" },
              ...(cur.kind === "step" ? [{ keys: "⇧↑/⇧↓", label: "move" }] : []),
            ]
          : cur.kind === "add-param" || cur.kind === "add-step"
            ? [{ keys: "⏎", label: "add" }]
            : cur.kind === "save"
              ? [{ keys: "⏎", label: "save" }]
              : cur.kind === "cancel"
                ? [{ keys: "⏎", label: "back" }]
                : [{ keys: "⏎", label: "edit" }]),
        { keys: "ctrl+s", label: "save flow" },
        { keys: "esc", label: "back" },
      ];

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={colors.accent}>{flowId ? "Edit flow" : "New flow"}</text>
      </box>
      {/* No gap/marginBottom between the column children here: OpenTUI 0.4.5
          draws the first text child of nested boxes one row down (overlapping
          its sibling) when this column layout uses inter-sibling spacing. */}
      <box flexGrow={1} flexDirection="column" border borderStyle="rounded" borderColor={colors.chrome} margin={1} padding={1}>
        <FieldRow
          label="Name"
          selected={isRow("name")}
          editing={editingField_ && editingField === "name"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.name}
          placeholder="(unnamed)"
        />
        <FieldRow
          label="Description"
          selected={isRow("description")}
          editing={editingField_ && editingField === "description"}
          fieldDraft={fieldDraft}
          onInput={setFieldDraft}
          onSubmit={commitField}
          value={draft.description}
          placeholder="(none)"
        />

        <box
          flexDirection="column"
          border
          borderStyle="single"
          borderColor={paramsActive ? colors.accent : colors.chrome}
          title={`Parameters (${draft.parameters.length})`}
          padding={1}
        >
          {draft.parameters.length === 0 && <text fg={colors.textSecondary}>No parameters.</text>}
          {draft.parameters.map((p, i) => (
            <SimpleRow
              key={p.name + i}
              selected={isRow("param", i)}
              hint={[
                { keys: "⏎", label: "open" },
                { keys: "d", label: "delete" },
              ]}
            >
              {p.name}
              {p.required ? " *" : ""}
              {p.description ? ` — ${p.description}` : ""}
            </SimpleRow>
          ))}
          <SimpleRow selected={isRow("add-param")} fg={colors.success} hint={[{ keys: "⏎", label: "add" }]}>
            + add parameter
          </SimpleRow>
        </box>

        <box
          flexDirection="column"
          border
          borderStyle="single"
          borderColor={stepsActive ? colors.accent : colors.chrome}
          title={`Steps (${draft.steps.length})`}
          padding={1}
        >
          {draft.steps.length === 0 && <text fg={colors.textSecondary}>No steps.</text>}
          {draft.steps.map((s, i) => (
            <SimpleRow
              key={s.id}
              selected={isRow("step", i)}
              hint={[
                { keys: "⏎", label: "open" },
                { keys: "d", label: "delete" },
                { keys: "⇧↑/⇧↓", label: "move" },
              ]}
            >
              {i + 1}. {s.name} ({s.agent})
            </SimpleRow>
          ))}
          <SimpleRow selected={isRow("add-step")} fg={colors.success} hint={[{ keys: "⏎", label: "add" }]}>
            + add step
          </SimpleRow>
        </box>

        <SimpleRow selected={isRow("save")} fg={colors.success} hint={[{ keys: "⏎", label: "save" }]}>
          ▶ Save flow
        </SimpleRow>
        <SimpleRow selected={isRow("cancel")} fg={colors.textSecondary} hint={[{ keys: "⏎", label: "back" }]}>
          Cancel
        </SimpleRow>
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
