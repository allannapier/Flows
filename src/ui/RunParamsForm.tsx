import { useEffect, useMemo, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { getFlow } from "../core/storage";
import type { Flow } from "../types";
import { colors, Hint, RowHint, marker, type KeyHintSpec } from "./theme";

export function RunParamsForm({
  flowId,
  onStart,
  onCancel,
}: {
  flowId: string;
  onStart: (params: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const flow: Flow | undefined = useMemo(() => getFlow(flowId), [flowId]);
  const params = flow?.parameters ?? [];

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of params) initial[p.name] = p.default ?? "";
    return initial;
  });
  const [focusIndex, setFocusIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Flows with no parameters skip straight to running.
  useEffect(() => {
    if (flow && params.length === 0) {
      onStart({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  function trySubmit(candidate: Record<string, string>) {
    for (let i = 0; i < params.length; i++) {
      const p = params[i]!;
      const v = candidate[p.name] ?? "";
      if (p.required && v.trim() === "") {
        setError(`"${p.name}" is required`);
        setFocusIndex(i);
        return;
      }
    }
    setError(null);
    onStart(candidate);
  }

  useKeyboard((key) => {
    if (key.name === "escape") {
      onCancel();
      return;
    }
    if (key.name === "up") {
      setFocusIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.name === "down" || key.name === "tab") {
      setFocusIndex((i) => Math.min(params.length, i + 1));
      return;
    }
    if (key.name === "return" && focusIndex === params.length) {
      trySubmit(values);
    }
  });

  if (!flow) {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} padding={2}>
        <text fg={colors.error}>Flow not found: {flowId}</text>
        <Hint hints={[{ keys: "esc", label: "back" }]} />
      </box>
    );
  }

  if (params.length === 0) {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} padding={2}>
        <text fg={colors.textSecondary}>Starting "{flow.name}"...</text>
      </box>
    );
  }

  const onLastRow = focusIndex === params.length;
  const bottomHints: KeyHintSpec[] = [
    { keys: "⏎", label: onLastRow ? "start" : "next field" },
    { keys: "up/down", label: "move" },
    { keys: "esc", label: "back" },
  ];

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={colors.accent}>Run: {flow.name}</text>
      </box>
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        title="Parameters"
        margin={1}
        padding={1}
      >
        {params.map((p, i) => {
          const focused = focusIndex === i;
          const bg = focused ? colors.selectionBg : undefined;
          const labelFg = focused ? colors.selectionFg : colors.textSecondary;
          return (
            <box key={p.name} flexDirection="column">
              <box flexDirection="row" backgroundColor={bg}>
                <text fg={labelFg} bg={bg}>
                  {marker(focused)}
                  {p.name}
                  {p.required ? " *" : ""}
                  {p.description ? `  — ${p.description}` : ""}
                  {p.default ? `  (default: ${p.default})` : ""}
                </text>
                {focused && <RowHint hints={[{ keys: "⏎", label: "next field" }]} bg={bg} />}
              </box>
              <box flexDirection="row" backgroundColor={bg}>
                <text fg={labelFg} bg={bg}>
                  {"  "}
                </text>
                <input
                  flexGrow={1}
                  focused={focused}
                  placeholder={p.default ?? ""}
                  value={values[p.name] ?? ""}
                  onInput={(v) => setValues((prev) => ({ ...prev, [p.name]: v }))}
                  onSubmit={() => {
                    if (i === params.length - 1) {
                      trySubmit(values);
                    } else {
                      setFocusIndex(i + 1);
                    }
                  }}
                />
              </box>
            </box>
          );
        })}
        <box flexDirection="row" backgroundColor={onLastRow ? colors.selectionBg : undefined}>
          <text
            fg={onLastRow ? colors.selectionFg : colors.success}
            bg={onLastRow ? colors.selectionBg : undefined}
          >
            {marker(onLastRow)}▶ Start flow
          </text>
          {onLastRow && <RowHint hints={[{ keys: "⏎", label: "start" }]} bg={colors.selectionBg} />}
        </box>
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
