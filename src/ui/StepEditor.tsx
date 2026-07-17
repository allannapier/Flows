import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { SelectOption } from "@opentui/core";
import { AGENTS, agentAvailable } from "../core/agents";
import type { FlowStep } from "../types";
import { colors, Hint } from "./theme";

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
        },
  );
  const [cursor, setCursor] = useState(0);
  const [editingField, setEditingField] = useState<TextField | null>(null);
  const [editingAgent, setEditingAgent] = useState(false);
  const [fieldDraft, setFieldDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rows: string[] = ["name", "agent"];
  if (draft.agent === "custom") rows.push("customCommand");
  rows.push("prompt", "expectedResult", "validate", "maxRetries", "workingDir", "save", "cancel");
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
        case "prompt":
          return { ...d, prompt: fieldDraft };
        case "expectedResult":
          return { ...d, expectedResult: fieldDraft };
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
        beginEdit("prompt", draft.prompt);
        break;
      case "expectedResult":
        beginEdit("expectedResult", draft.expectedResult);
        break;
      case "validate":
        setDraft((d) => ({ ...d, validate: !d.validate }));
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
    if (editingField) {
      if (key.name === "escape") setEditingField(null);
      return;
    }
    if (key.name === "escape") {
      onCancel();
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

  const agentOptions: SelectOption[] = AGENTS.map((a) => ({
    name: agentAvailable(a) ? a.label : `${a.label} (not installed)`,
    description: a.binary ? `binary: ${a.binary}` : "custom shell command",
    value: a.id,
  }));
  const agentLabel = AGENTS.find((a) => a.id === draft.agent)?.label ?? draft.agent;

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
        <box flexDirection="column">
          <text fg={rows[safeCursor] === "name" ? colors.accent : colors.text}>Name</text>
          {editingField === "name" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.name || "(unnamed)"}</text>
          )}
        </box>

        <box flexDirection="column">
          <text fg={rows[safeCursor] === "agent" ? colors.accent : colors.text}>Agent</text>
          {editingAgent ? (
            <select
              focused
              height={AGENTS.length * 2}
              options={agentOptions}
              selectedIndex={Math.max(0, AGENTS.findIndex((a) => a.id === draft.agent))}
              onSelect={(_i, option) => {
                if (option) setDraft((d) => ({ ...d, agent: option.value }));
                setEditingAgent(false);
              }}
            />
          ) : (
            <text fg={colors.textMuted}>{agentLabel}</text>
          )}
        </box>

        {draft.agent === "custom" && (
          <box flexDirection="column">
            <text fg={rows[safeCursor] === "customCommand" ? colors.accent : colors.text}>
              Custom command (uses $FLOW_PROMPT)
            </text>
            {editingField === "customCommand" ? (
              <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
            ) : (
              <text fg={colors.textMuted}>{draft.customCommand || "(none)"}</text>
            )}
          </box>
        )}

        <box flexDirection="column">
          <text fg={rows[safeCursor] === "prompt" ? colors.accent : colors.text}>
            Prompt (supports {"{{params.<name>}}"} and {"{{steps.<name>.output}}"})
          </text>
          {editingField === "prompt" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.prompt || "(empty)"}</text>
          )}
        </box>

        <box flexDirection="column">
          <text fg={rows[safeCursor] === "expectedResult" ? colors.accent : colors.text}>
            Expected result (used by the validator)
          </text>
          {editingField === "expectedResult" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.expectedResult || "(empty)"}</text>
          )}
        </box>

        <text fg={rows[safeCursor] === "validate" ? colors.accent : colors.text}>
          Validate output: {draft.validate ? "[x] yes" : "[ ] no"}
        </text>

        <box flexDirection="column">
          <text fg={rows[safeCursor] === "maxRetries" ? colors.accent : colors.text}>Max retries (0-5)</text>
          {editingField === "maxRetries" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.maxRetries}</text>
          )}
        </box>

        <box flexDirection="column">
          <text fg={rows[safeCursor] === "workingDir" ? colors.accent : colors.text}>Working directory (optional)</text>
          {editingField === "workingDir" ? (
            <input focused value={fieldDraft} onInput={setFieldDraft} onSubmit={commitField} />
          ) : (
            <text fg={colors.textMuted}>{draft.workingDir || "(cwd)"}</text>
          )}
        </box>

        <text fg={rows[safeCursor] === "save" ? colors.accent : colors.success}>▶ Save step</text>
        <text fg={rows[safeCursor] === "cancel" ? colors.accent : colors.dim}>Cancel</text>
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint>enter edit/toggle/save · up/down move · esc back</Hint>
    </box>
  );
}
