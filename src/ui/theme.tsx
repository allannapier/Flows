// Shared visual language for the Flows TUI.
//
// Note: this file uses JSX (the <Hint> helper), so it must be named
// theme.tsx rather than theme.ts as the spec suggested — a .ts file cannot
// contain JSX syntax under this project's tsconfig.

import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
// Contrast rules:
// - textPrimary is used for ALL real content/values — near-white, always
//   legible against the dark background.
// - textSecondary is for labels/descriptions — still clearly readable, never
//   the old low-contrast #565f89 "dim" value that used to leak into content.
// - chrome (#565f89-class) is reserved ONLY for decorative/unfocused
//   borders — never for text a user needs to read.
// - accent marks selection markers, focused-pane borders, and titles.
// - selectionBg/selectionFg are the full-width highlight bar for whichever
//   row currently has the cursor.
export const colors = {
  bg: "#1a1b26",
  panel: "#20222f",
  panelAlt: "#1f2335",

  accent: "#7aa2f7",

  textPrimary: "#e6e9f0",
  textSecondary: "#9aa5ce",
  textPlaceholder: "#6b7394",

  chrome: "#565f89",

  selectionBg: "#283b5b",
  selectionFg: "#f4f6fb",

  success: "#9ece6a",
  warning: "#e0af68",
  error: "#f7768e",
} as const;

// ---------------------------------------------------------------------------
// Keyboard hints
// ---------------------------------------------------------------------------

export interface KeyHintSpec {
  keys: string;
  label: string;
}

/**
 * Footer hint bar shown at the bottom of every screen.
 *
 * Pass either raw children (for one-off strings, rendered in secondary
 * color) or a `hints` array of {keys,label} pairs to get consistent
 * "⏎ accent + label secondary" rendering separated by a dim "·".
 */
export function Hint({
  children,
  hints,
}: {
  children?: ReactNode;
  hints?: KeyHintSpec[];
}) {
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0}>
      {hints ? (
        <text>
          {hints.map((h, i) => (
            <span key={h.keys + h.label}>
              {i > 0 ? <span fg={colors.chrome}> · </span> : null}
              <span fg={colors.accent}>{h.keys}</span>
              <span fg={colors.textSecondary}> {h.label}</span>
            </span>
          ))}
        </text>
      ) : (
        <text fg={colors.textSecondary}>{children}</text>
      )}
    </box>
  );
}

/** Inline "⏎ edit"-style fragment for rendering an action hint directly on
 * the selected row (right side / after the value). `bg` should match the
 * row's highlight background so the hint fills the same bar. */
export function RowHint({ hints, bg }: { hints: KeyHintSpec[]; bg?: string }) {
  return (
    <text bg={bg}>
      {hints.map((h, i) => (
        <span key={h.keys + h.label} bg={bg}>
          {"  "}
          <span fg={colors.accent} bg={bg}>{h.keys}</span>
          <span fg={colors.textSecondary} bg={bg}> {h.label}</span>
        </span>
      ))}
    </text>
  );
}

/** Leading cursor marker: "▸ " when selected, two spaces otherwise, so
 * unselected rows stay aligned with selected ones. */
export function marker(selected: boolean): string {
  return selected ? "▸ " : "  ";
}

/** Color for a value that may be empty/placeholder ("(unnamed)", "(none)",
 * "(cwd)", ...) — placeholder text is muted+distinct so real values pop. */
export function valueColor(hasValue: boolean): string {
  return hasValue ? colors.textPrimary : colors.textPlaceholder;
}

// ---------------------------------------------------------------------------
// Shared row components (FlowEditor / StepEditor / ParamForm)
// ---------------------------------------------------------------------------
// Every cursor-navigated row gets: a full-width selection bar + bright text
// when selected, a leading "▸ "/"  " marker, and (when selected) an inline
// action hint. Per an OpenTUI 0.4.5 layout quirk, rows never use
// gap/marginBottom between siblings in a flexDirection="column" box — each
// row is its own box instead.

/** A single-line selectable row (list entries, "+ add x", save/cancel). */
export function SimpleRow({
  selected,
  fg,
  hint,
  children,
}: {
  selected: boolean;
  fg?: string;
  hint?: KeyHintSpec[];
  children: ReactNode;
}) {
  const bg = selected ? colors.selectionBg : undefined;
  const color = selected ? colors.selectionFg : (fg ?? colors.textPrimary);
  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text fg={color} bg={bg}>
        {marker(selected)}
        {children}
      </text>
      {selected && hint && hint.length > 0 && <RowHint hints={hint} bg={bg} />}
    </box>
  );
}

/** A label-above-value editable text field row, e.g. Name / Description /
 * Prompt. When `editing`, the value line is replaced by a focused <input>
 * and the inline hint switches to "⏎ save · esc cancel". */
export function FieldRow({
  label,
  selected,
  editing,
  fieldDraft,
  onInput,
  onSubmit,
  value,
  placeholder,
}: {
  label: string;
  selected: boolean;
  editing: boolean;
  fieldDraft: string;
  onInput: (v: string) => void;
  onSubmit: () => void;
  value: string;
  placeholder: string;
}) {
  const bg = selected ? colors.selectionBg : undefined;
  const labelFg = selected ? colors.selectionFg : colors.textSecondary;
  const hasValue = value.trim() !== "";
  const valueFg = selected ? colors.selectionFg : valueColor(hasValue);
  const hint: KeyHintSpec[] = editing
    ? [
        { keys: "⏎", label: "save" },
        { keys: "esc", label: "cancel" },
      ]
    : [{ keys: "⏎", label: "edit" }];
  return (
    <box flexDirection="column">
      <box flexDirection="row" backgroundColor={bg}>
        <text fg={labelFg} bg={bg}>
          {marker(selected)}
          {label}
        </text>
        {selected && !editing && <RowHint hints={hint} bg={bg} />}
      </box>
      <box flexDirection="row" backgroundColor={bg}>
        {editing ? (
          <>
            <text fg={valueFg} bg={bg}>
              {"  "}
            </text>
            <input flexGrow={1} focused value={fieldDraft} onInput={onInput} onSubmit={onSubmit} />
          </>
        ) : (
          <text fg={valueFg} bg={bg}>
            {"  "}
            {value || placeholder}
          </text>
        )}
        {selected && editing && <RowHint hints={hint} bg={bg} />}
      </box>
    </box>
  );
}

/** A boolean toggle row rendered as "[✓] yes" / "[ ] no". */
export function ToggleRow({
  label,
  selected,
  value,
  disabled,
  disabledNote,
}: {
  label: string;
  selected: boolean;
  value: boolean;
  disabled?: boolean;
  disabledNote?: string;
}) {
  const bg = disabled ? undefined : selected ? colors.selectionBg : undefined;
  const labelFg = disabled ? colors.textPlaceholder : selected ? colors.selectionFg : colors.textSecondary;
  const boxFg = disabled ? colors.textPlaceholder : selected ? colors.selectionFg : value ? colors.success : colors.textSecondary;
  const hint: KeyHintSpec[] = [{ keys: "⏎", label: "toggle" }];
  return (
    <box flexDirection="row" backgroundColor={bg}>
      <text fg={labelFg} bg={bg}>
        {marker(selected)}
        {label}:{" "}
      </text>
      <text fg={boxFg} bg={bg}>
        {disabled ? (disabledNote ?? "not supported") : value ? "[✓] yes" : "[ ] no"}
      </text>
      {selected && !disabled && <RowHint hints={hint} bg={bg} />}
    </box>
  );
}
