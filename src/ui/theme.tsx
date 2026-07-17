// Shared visual language for the Flows TUI.
//
// Note: this file uses JSX (the <Hint> helper), so it must be named
// theme.tsx rather than theme.ts as the spec suggested — a .ts file cannot
// contain JSX syntax under this project's tsconfig.

import type { ReactNode } from "react";

export const colors = {
  bg: "#1a1b26",
  panel: "#20222f",
  panelAlt: "#1f2335",
  accent: "#7aa2f7",
  success: "#9ece6a",
  error: "#f7768e",
  warning: "#e0af68",
  dim: "#565f89",
  text: "#c0caf5",
  textMuted: "#a9b1d6",
} as const;

/** Footer hint bar shown at the bottom of every screen. */
export function Hint({ children }: { children: ReactNode }) {
  return (
    <box paddingLeft={1} paddingRight={1} paddingTop={0} paddingBottom={0}>
      <text fg={colors.dim}>{children}</text>
    </box>
  );
}
