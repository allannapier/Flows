import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import type { TabSelectOption, TabSelectRenderable } from "@opentui/core";
import { getFlow } from "../core/storage";
import type { Flow } from "../types";
import { colors, Hint, RowHint, Button, marker, type KeyHintSpec } from "./theme";

export function RunParamsForm({
  flowId,
  initialParams,
  onStart,
  onCancel,
}: {
  flowId: string;
  /** Prior run's recorded parameter values (re-run), pre-filling the form.
   *  Values for parameters no longer on the flow are ignored; parameters
   *  added since fall back to their normal default. */
  initialParams?: Record<string, string>;
  onStart: (params: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const flow: Flow | undefined = useMemo(() => getFlow(flowId), [flowId]);
  const params = flow?.parameters ?? [];

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const p of params) {
      const recorded = initialParams?.[p.name];
      if (p.choices?.length) {
        // Choice params always have a valid selection (never free-typed
        // empty) — fall back to default/first choice if the recorded value
        // is no longer one of the flow's choices.
        initial[p.name] = recorded !== undefined && p.choices.includes(recorded) ? recorded : (p.default ?? p.choices[0] ?? "");
      } else {
        initial[p.name] = recorded ?? p.default ?? "";
      }
    }
    return initial;
  });
  const [focusIndex, setFocusIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Tracks which choice-param tab-selects have already had their initial
  // selection set, keyed by param name — the ref callback below is a new
  // function identity every render, so React invokes it (with the *same*
  // node) on every re-render, not just on mount. setSelectedIndex() also
  // fires onChange, so calling it unguarded on every render would trigger
  // setValues -> re-render -> ref fires again -> infinite update loop (see
  // the identical gotoBufferEnd fix in theme.tsx's TextAreaFieldRow).
  const initializedTabSelects = useRef<Record<string, TabSelectRenderable>>({});

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
                  {p.choices?.length ? `  (${p.choices.join(" / ")})` : p.default ? `  (default: ${p.default})` : ""}
                </text>
                {focused && (
                  <RowHint
                    hints={
                      p.choices?.length ? [{ keys: "←→", label: "choose" }, { keys: "⏎", label: "next field" }] : [{ keys: "⏎", label: "next field" }]
                    }
                    bg={bg}
                  />
                )}
              </box>
              {p.choices?.length ? (
                <box height={3}>
                  <tab-select
                    ref={(node) => {
                      if (!node || initializedTabSelects.current[p.name] === node) return;
                      initializedTabSelects.current[p.name] = node;
                      const idx = Math.max(0, p.choices!.indexOf(values[p.name] ?? ""));
                      node.setSelectedIndex(idx);
                    }}
                    focused={focused}
                    flexGrow={1}
                    tabWidth={14}
                    showDescription={false}
                    options={p.choices.map((c): TabSelectOption => ({ name: c, description: "", value: c }))}
                    onChange={(_idx, option) => {
                      if (option) setValues((prev) => ({ ...prev, [p.name]: option.value }));
                    }}
                    onSelect={(_idx, option) => {
                      if (option) setValues((prev) => ({ ...prev, [p.name]: option.value }));
                      if (i === params.length - 1) trySubmit(values);
                      else setFocusIndex(i + 1);
                    }}
                    textColor={colors.textPrimary}
                    backgroundColor={colors.bg}
                    focusedBackgroundColor={colors.bg}
                    focusedTextColor={colors.textPrimary}
                    selectedBackgroundColor={colors.selectionBg}
                    selectedTextColor={colors.selectionFg}
                  />
                </box>
              ) : (
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
              )}
            </box>
          );
        })}
        <box flexDirection="row">
          <Button label="▶ Start flow" selected={onLastRow} />
          {onLastRow && <RowHint hints={[{ keys: "⏎", label: "start" }]} />}
        </box>
        {error && <text fg={colors.error}>{error}</text>}
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
