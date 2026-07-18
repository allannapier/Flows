// Shared visual language for the Flows TUI.
//
// Note: this file uses JSX (the <Hint> helper), so it must be named
// theme.tsx rather than theme.ts as the spec suggested — a .ts file cannot
// contain JSX syntax under this project's tsconfig.

import type { ReactNode, RefObject } from "react";
import type { ContentChangeEvent, CursorChangeEvent, TabSelectOption, TextareaRenderable } from "@opentui/core";

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------
// Contrast rules:
// - textPrimary is used for ALL real content/values — near-white, always
//   legible against the dark background.
// - textSecondary is for labels/descriptions — still clearly readable, never
//   a low-contrast "dim" value that used to leak into content.
// - chrome (#3a4150-class) is reserved ONLY for decorative/unfocused
//   borders — never for text a user needs to read.
// - accent marks selection markers, focused-pane borders, and titles —
//   a vibrant terminal-hacker green. accentDim is the same hue for less
//   prominent accent uses (unfocused-but-relevant borders, button outlines).
// - selectionBg/selectionFg are the full-width highlight bar for whichever
//   row currently has the cursor.
export const colors = {
  bg: "#1a1b26",
  panel: "#20222f",
  panelAlt: "#1f2335",

  accent: "#34d399",
  accentDim: "#1f9d67",

  textPrimary: "#e6e9f0",
  textSecondary: "#9fb3a8",
  textPlaceholder: "#6b7d74",

  chrome: "#3a4150",

  selectionBg: "#17402c",
  selectionFg: "#f0fdf4",

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

const YES_NO_OPTIONS: TabSelectOption[] = [
  { name: "yes", description: "", value: "yes" },
  { name: "no", description: "", value: "no" },
];

/**
 * A boolean toggle row. At rest it shows a compact "[✓] yes" / "[ ] no"
 * summary (like the old ToggleRow); when activated with ⏎ it swaps in a
 * live segmented `<tab-select>` — left/right to move between yes/no, ⏎ to
 * confirm. Because TabSelectRenderable has no controlled `selectedIndex`
 * prop (only an imperative `setSelectedIndex`), the initial segment is set
 * via a mount-time callback ref rather than a prop.
 */
export function TabToggleRow({
  label,
  selected,
  editing,
  value,
  disabled,
  disabledNote,
  onSelect,
}: {
  label: string;
  selected: boolean;
  editing: boolean;
  value: boolean;
  disabled?: boolean;
  disabledNote?: string;
  onSelect: (value: boolean) => void;
}) {
  const bg = disabled ? undefined : selected ? colors.selectionBg : undefined;
  const labelFg = disabled ? colors.textPlaceholder : selected ? colors.selectionFg : colors.textSecondary;
  const boxFg = disabled ? colors.textPlaceholder : selected ? colors.selectionFg : value ? colors.accent : colors.textSecondary;
  const hint: KeyHintSpec[] = editing
    ? [
        { keys: "←→", label: "choose" },
        { keys: "⏎", label: "confirm" },
      ]
    : [{ keys: "⏎", label: "toggle" }];
  return (
    <box flexDirection="column">
      <box flexDirection="row" backgroundColor={bg}>
        <text fg={labelFg} bg={bg}>
          {marker(selected)}
          {label}:{" "}
        </text>
        {!editing && (
          <text fg={boxFg} bg={bg}>
            {disabled ? (disabledNote ?? "not supported") : value ? "[✓] yes" : "[ ] no"}
          </text>
        )}
        {selected && !disabled && <RowHint hints={hint} bg={bg} />}
      </box>
      {editing && !disabled && (
        <box flexDirection="row" backgroundColor={bg}>
          <text fg={labelFg} bg={bg}>
            {"  "}
          </text>
          <tab-select
            ref={(node) => {
              if (node) node.setSelectedIndex(value ? 0 : 1);
            }}
            focused
            flexGrow={1}
            tabWidth={8}
            showUnderline={false}
            showDescription={false}
            options={YES_NO_OPTIONS}
            onSelect={(_i, option) => onSelect(option?.value === "yes")}
            textColor={colors.textSecondary}
            backgroundColor={colors.bg}
            focusedBackgroundColor={colors.bg}
            focusedTextColor={colors.textSecondary}
            selectedBackgroundColor={colors.accent}
            selectedTextColor={colors.bg}
          />
        </box>
      )}
    </box>
  );
}

/** Collapse a possibly multi-line value into a single-line preview for
 * FieldRow-style "not editing" display (real newlines would otherwise break
 * the single <text> row). */
export function previewLine(value: string, max = 90): string {
  const flat = value.replace(/\r?\n/g, " ⏎ ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A label-above-value row whose value is edited in a multi-line
 * `<textarea>` (4-6 visible rows) instead of a single-line `<input>`.
 * Unlike FieldRow, the textarea is uncontrolled — its live text is read via
 * `textareaRef.current.plainText` (see TextareaRenderable / EditBufferRenderable)
 * rather than an onInput callback, because EditBufferRenderable has no
 * per-keystroke value event. Plain ⏎ inserts a newline (the textarea's own
 * binding), so "esc" is repurposed as the commit key here — the caller
 * reads the ref and applies it on escape instead of discarding like other
 * fields do. */
export function TextAreaFieldRow({
  label,
  selected,
  editing,
  textareaRef,
  initialValue,
  value,
  placeholder,
  rows = 6,
  onContentChange,
  onCursorChange,
}: {
  label: string;
  selected: boolean;
  editing: boolean;
  textareaRef: RefObject<TextareaRenderable | null>;
  initialValue: string;
  value: string;
  placeholder: string;
  rows?: number;
  onContentChange?: (event: ContentChangeEvent) => void;
  onCursorChange?: (event: CursorChangeEvent) => void;
}) {
  const bg = selected ? colors.selectionBg : undefined;
  const labelFg = selected ? colors.selectionFg : colors.textSecondary;
  const hasValue = value.trim() !== "";
  const valueFg = selected ? colors.selectionFg : valueColor(hasValue);
  const hint: KeyHintSpec[] = editing ? [{ keys: "esc", label: "done" }] : [{ keys: "⏎", label: "edit" }];
  return (
    <box flexDirection="column">
      <box flexDirection="row" backgroundColor={bg}>
        <text fg={labelFg} bg={bg}>
          {marker(selected)}
          {label}
        </text>
        {selected && <RowHint hints={hint} bg={bg} />}
      </box>
      {editing ? (
        <box height={rows} border borderStyle="single" borderColor={colors.accent}>
          <textarea
            ref={(node) => {
              // This inline callback is a new function identity every
              // render, so React invokes it (with the *same* node) on every
              // re-render, not just on mount — guard on node identity so
              // gotoBufferEnd() only fires once per real mount. Without
              // this, any state update while editing (e.g. the placeholder
              // autocomplete's onContentChange -> setState) would yank the
              // cursor back to the end on every keystroke.
              const isNewMount = node !== null && node !== textareaRef.current;
              textareaRef.current = node;
              // TextareaRenderable.setText() (used internally for
              // initialValue) leaves the cursor at buffer position 0, so
              // typing would prepend before existing content instead of
              // continuing after it — move to the end on mount.
              if (isNewMount) node.gotoBufferEnd();
            }}
            flexGrow={1}
            focused
            initialValue={initialValue}
            placeholder={placeholder}
            textColor={colors.textPrimary}
            backgroundColor={colors.bg}
            focusedBackgroundColor={colors.bg}
            focusedTextColor={colors.textPrimary}
            placeholderColor={colors.textPlaceholder}
            onContentChange={onContentChange}
            onCursorChange={onCursorChange}
          />
        </box>
      ) : (
        <box flexDirection="row" backgroundColor={bg}>
          <text fg={valueFg} bg={bg}>
            {"  "}
            {hasValue ? previewLine(value) : placeholder}
          </text>
        </box>
      )}
    </box>
  );
}

/** Floating placeholder-autocomplete list shown under a textarea once the
 * user types "{{" — highlights the currently-arrowed-to item. Rendered
 * inline (pushing following rows down) since this is a terminal UI with no
 * real overlay/z-index.
 *
 * Kept permanently mounted and toggled via the `visible` prop rather than
 * conditionally rendered by the caller: removing/re-adding this box as a
 * *child* (mount/unmount) doesn't reliably force an immediate repaint in
 * this renderer — the screen can be left showing a stale frame until some
 * unrelated event (e.g. the next keystroke) happens to repaint it. Toggling
 * `visible` on an already-mounted node is a plain prop update, which (like
 * cursor-highlight changes elsewhere in this app) does repaint immediately. */
export function SuggestionDropdown({
  visible,
  items,
  activeIndex,
  more,
}: {
  visible: boolean;
  items: string[];
  activeIndex: number;
  /** Count of additional matches beyond `items` that aren't shown. */
  more?: number;
}) {
  return (
    <box visible={visible} flexDirection="column" border borderStyle="single" borderColor={colors.accent} marginLeft={2}>
      {items.map((item, i) => {
        const active = i === activeIndex;
        return (
          <text key={item} fg={active ? colors.selectionFg : colors.textSecondary} bg={active ? colors.selectionBg : undefined}>
            {marker(active)}
            {"{{"}
            {item}
            {"}}"}
          </text>
        );
      })}
      {!!more && <text fg={colors.textPlaceholder}>  +{more} more</text>}
    </box>
  );
}

/** A small bordered "button": filled accent-green with dark text when
 * selected/focused, transparent with an accent outline otherwise. There is
 * no native <button> intrinsic in @opentui 0.4.5, so this is a plain <box>
 * + <text>. */
export function Button({
  label,
  selected,
  color,
}: {
  label: string;
  selected: boolean;
  /** Override the accent color (e.g. colors.error for a destructive action). */
  color?: string;
}) {
  const c = color ?? colors.accent;
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={selected ? c : colors.accentDim}
      backgroundColor={selected ? c : undefined}
      paddingLeft={2}
      paddingRight={2}
    >
      <text fg={selected ? colors.bg : c}>{label}</text>
    </box>
  );
}

/** A row of side-by-side `<Button>`s (e.g. Save / Cancel). `gap` between
 * buttons in a *row* box is safe — the sibling-spacing bug this codebase
 * works around only affects flexDirection="column" boxes. */
export function ButtonRow({
  buttons,
}: {
  buttons: Array<{ label: string; selected: boolean; color?: string }>;
}) {
  return (
    <box flexDirection="row" gap={2}>
      {buttons.map((b) => (
        <Button key={b.label} label={b.label} selected={b.selected} color={b.color} />
      ))}
    </box>
  );
}
