import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { TabSelectOption } from "@opentui/core";
import {
  loadConfig,
  saveConfig,
  maskKey,
  PROVIDER_LABELS,
  PROVIDER_ENV_VAR,
  type ValidatorConfig,
  type ValidatorProvider,
} from "../core/config";
import { validateOutput } from "../core/validator";
import { colors, Hint, FieldRow, ButtonRow, RowHint, TabToggleRow, marker, type KeyHintSpec } from "./theme";

const PROVIDER_ORDER: ValidatorProvider[] = ["anthropic", "openai", "google", "custom"];

type TextField = "model" | "apiKey" | "baseUrl";

type TestStatus =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "success"; passed: boolean }
  | { kind: "error"; message: string };

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function modelPlaceholder(provider: ValidatorProvider): string {
  switch (provider) {
    case "anthropic":
      return "claude-opus-4-8 (default)";
    case "openai":
      return "e.g. gpt-5.1";
    case "google":
      return "e.g. gemini-2.5-flash";
    case "custom":
      return "model id required";
  }
}

export function SettingsScreen({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<ValidatorConfig>(() => ({ ...loadConfig().validator }));
  const [notifications, setNotifications] = useState(() => loadConfig().notifications ?? true);
  const [editingNotifications, setEditingNotifications] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [editingField, setEditingField] = useState<TextField | null>(null);
  const [editingProvider, setEditingProvider] = useState(false);
  const [fieldDraft, setFieldDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: "idle" });

  const buttonRows = ["save", "test", "cancel"] as const;
  const rows: string[] = ["provider", "model", "apiKey"];
  if (draft.provider === "custom") rows.push("baseUrl");
  rows.push("notifications");
  rows.push(...buttonRows);
  const safeCursor = clamp(cursor, 0, rows.length - 1);
  const isRow = (name: string) => rows[safeCursor] === name;

  function beginEdit(field: TextField, initial: string) {
    setFieldDraft(initial);
    setEditingField(field);
    setError(null);
  }

  function commitField() {
    setDraft((d) => {
      switch (editingField) {
        case "model":
          return { ...d, model: fieldDraft.trim() || undefined };
        case "apiKey":
          return { ...d, apiKey: fieldDraft.trim() || undefined };
        case "baseUrl":
          return { ...d, baseUrl: fieldDraft.trim() || undefined };
        default:
          return d;
      }
    });
    setEditingField(null);
  }

  function activate(row: string) {
    switch (row) {
      case "provider":
        setEditingProvider(true);
        break;
      case "model":
        beginEdit("model", draft.model ?? "");
        break;
      case "apiKey":
        beginEdit("apiKey", draft.apiKey ?? "");
        break;
      case "baseUrl":
        beginEdit("baseUrl", draft.baseUrl ?? "");
        break;
      case "notifications":
        setEditingNotifications(true);
        break;
      case "save":
        trySave();
        break;
      case "test":
        runTest();
        break;
      case "cancel":
        onCancel();
        break;
    }
  }

  function trySave() {
    if (draft.provider !== "anthropic" && !draft.model?.trim()) {
      setError(`Model is required for ${PROVIDER_LABELS[draft.provider]}`);
      setCursor(rows.indexOf("model"));
      return;
    }
    if (draft.provider === "custom" && !draft.baseUrl?.trim()) {
      setError("Base URL is required for the custom provider");
      setCursor(rows.indexOf("baseUrl"));
      return;
    }
    saveConfig({ validator: draft, notifications });
    onDone();
  }

  async function runTest() {
    setError(null);
    setTestStatus({ kind: "testing" });
    try {
      const { verdict } = await validateOutput({
        stepPrompt: "Say OK",
        expectedResult: "The output says OK",
        output: "OK",
        configOverride: { validator: draft, notifications },
      });
      setTestStatus({ kind: "success", passed: verdict.passed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestStatus({ kind: "error", message });
    }
  }

  useKeyboard((key) => {
    if (testStatus.kind === "testing") {
      if (key.name === "escape") onCancel();
      return;
    }
    if (editingProvider) {
      if (key.name === "escape") setEditingProvider(false);
      return;
    }
    if (editingNotifications) {
      if (key.name === "escape") setEditingNotifications(false);
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
    const currentIsButton = (buttonRows as readonly string[]).includes(rows[safeCursor] ?? "");
    if (currentIsButton && (key.name === "left" || key.name === "right")) {
      const idx = buttonRows.indexOf(rows[safeCursor] as (typeof buttonRows)[number]);
      const nextIdx = clamp(idx + (key.name === "left" ? -1 : 1), 0, buttonRows.length - 1);
      setCursor(rows.indexOf(buttonRows[nextIdx]!));
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

  const providerOptions: TabSelectOption[] = PROVIDER_ORDER.map((p) => ({
    name: PROVIDER_LABELS[p],
    description: `env: ${PROVIDER_ENV_VAR[p]}`,
    value: p,
  }));

  const apiKeyDisplay = draft.apiKey ? maskKey(draft.apiKey) : "";

  const bottomHints: KeyHintSpec[] =
    testStatus.kind === "testing"
      ? [{ keys: "esc", label: "cancel" }]
      : editingProvider || editingNotifications
        ? [
            { keys: "←→", label: "choose" },
            { keys: "⏎", label: "confirm" },
            { keys: "esc", label: "cancel" },
          ]
        : editingField
          ? [
              { keys: "⏎", label: "save" },
              { keys: "esc", label: "cancel" },
            ]
          : [
              ...(rows[safeCursor] === "provider"
                ? [{ keys: "⏎", label: "choose" }]
                : rows[safeCursor] === "save"
                  ? [
                      { keys: "⏎", label: "save" },
                      { keys: "←→", label: "move" },
                    ]
                  : rows[safeCursor] === "test"
                    ? [
                        { keys: "⏎", label: "test" },
                        { keys: "←→", label: "move" },
                      ]
                    : rows[safeCursor] === "cancel"
                      ? [
                          { keys: "⏎", label: "back" },
                          { keys: "←→", label: "move" },
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
        title="Settings"
        margin={1}
        padding={1}
      >
        <box border borderStyle="single" borderColor={colors.chrome} title="Validator LLM" flexDirection="column" padding={1}>
          <box flexDirection="column">
            <box flexDirection="row" backgroundColor={isRow("provider") ? colors.selectionBg : undefined}>
              <text fg={isRow("provider") ? colors.selectionFg : colors.textSecondary} bg={isRow("provider") ? colors.selectionBg : undefined}>
                {marker(isRow("provider"))}Provider
              </text>
              {isRow("provider") && !editingProvider && (
                <RowHint hints={[{ keys: "⏎", label: "choose" }]} bg={colors.selectionBg} />
              )}
            </box>
            {editingProvider ? (
              <box height={3}>
                <tab-select
                  ref={(node) => {
                    if (node) node.setSelectedIndex(Math.max(0, PROVIDER_ORDER.indexOf(draft.provider)));
                  }}
                  focused
                  flexGrow={1}
                  tabWidth={22}
                  showDescription
                  options={providerOptions}
                  onSelect={(_i, option) => {
                    if (option) setDraft((d) => ({ ...d, provider: option.value as ValidatorProvider }));
                    setEditingProvider(false);
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
              <box flexDirection="row" backgroundColor={isRow("provider") ? colors.selectionBg : undefined}>
                <text
                  fg={isRow("provider") ? colors.selectionFg : colors.textPrimary}
                  bg={isRow("provider") ? colors.selectionBg : undefined}
                >
                  {"  "}
                  {PROVIDER_LABELS[draft.provider]}
                </text>
              </box>
            )}
          </box>

          <FieldRow
            label="Model"
            selected={isRow("model")}
            editing={editingField === "model"}
            fieldDraft={fieldDraft}
            onInput={setFieldDraft}
            onSubmit={commitField}
            value={draft.model ?? ""}
            placeholder={modelPlaceholder(draft.provider)}
          />

          <FieldRow
            label="API key"
            selected={isRow("apiKey")}
            editing={editingField === "apiKey"}
            fieldDraft={fieldDraft}
            onInput={setFieldDraft}
            onSubmit={commitField}
            value={apiKeyDisplay}
            placeholder="(not set)"
          />
          <box flexDirection="row">
            <text fg={colors.textPlaceholder}>
              {"  "}stored in $FLOWS_HOME/config.json (0600); env {PROVIDER_ENV_VAR[draft.provider]} used if empty
            </text>
          </box>

          {draft.provider === "custom" && (
            <FieldRow
              label="Base URL"
              selected={isRow("baseUrl")}
              editing={editingField === "baseUrl"}
              fieldDraft={fieldDraft}
              onInput={setFieldDraft}
              onSubmit={commitField}
              value={draft.baseUrl ?? ""}
              placeholder="https://api.example.com/v1"
            />
          )}
        </box>

        <box border borderStyle="single" borderColor={colors.chrome} title="General" flexDirection="column" padding={1}>
          <TabToggleRow
            label="Notifications"
            selected={isRow("notifications")}
            editing={editingNotifications}
            value={notifications}
            onSelect={(v) => {
              setNotifications(v);
              setEditingNotifications(false);
            }}
          />
          {isRow("notifications") && !editingNotifications && (
            <text fg={colors.textSecondary}>
              {"  "}bell + desktop notification when a backgrounded run needs you or finishes
            </text>
          )}

          <ButtonRow
            buttons={[
              { label: "Save", selected: isRow("save") },
              { label: "Test", selected: isRow("test") },
              { label: "Cancel", selected: isRow("cancel") },
            ]}
          />

          {testStatus.kind === "testing" && <text fg={colors.textSecondary}>testing...</text>}
          {testStatus.kind === "success" && (
            <text fg={colors.success}>✓ validator responded (passed={String(testStatus.passed)})</text>
          )}
          {testStatus.kind === "error" && <text fg={colors.error}>{testStatus.message}</text>}
          {error && <text fg={colors.error}>{error}</text>}
        </box>
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
