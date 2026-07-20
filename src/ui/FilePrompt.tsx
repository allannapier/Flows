import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { colors, Hint, Button } from "./theme";

const HINTS = [
  { keys: "⏎", label: "confirm" },
  { keys: "esc", label: "cancel" },
];

/**
 * Minimal one-field prompt for a filesystem path (export destination / import
 * source). `onSubmit` performs the action and returns an error message to
 * display (keeping the typed path) or `undefined` on success — the caller is
 * responsible for navigating away in that case.
 */
export function FilePrompt({
  title,
  label,
  initialValue,
  onSubmit,
  onCancel,
}: {
  title: string;
  label: string;
  initialValue: string;
  onSubmit: (value: string) => string | undefined;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | undefined>(undefined);

  useKeyboard((key) => {
    if (key.ctrl || key.meta) return;
    if (key.name === "escape") onCancel();
  });

  function handleSubmit() {
    const err = onSubmit(value);
    if (err) setError(err);
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} justifyContent="center" alignItems="center">
      <box
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        title={title}
        padding={2}
        flexDirection="column"
        gap={1}
        width={70}
      >
        <text fg={colors.textSecondary}>{label}</text>
        <box flexDirection="row" border borderStyle="single" borderColor={colors.chrome}>
          <input
            flexGrow={1}
            focused
            value={value}
            onInput={(v) => {
              setValue(v);
              setError(undefined);
            }}
            onSubmit={handleSubmit}
          />
        </box>
        {error && <text fg={colors.error}>{error}</text>}
        <box flexDirection="row" gap={2}>
          <Button label="⏎ confirm" selected />
          <Button label="esc cancel" selected={false} />
        </box>
      </box>
      <Hint hints={HINTS} />
    </box>
  );
}
