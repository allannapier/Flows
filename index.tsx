// Flows TUI entry point.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./src/ui/App";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Flows requires an interactive terminal (TTY). Run it directly in a terminal, not piped.");
  process.exit(0);
}

// The renderer's built-in exitOnCtrlC handler destroys the app
// unconditionally (it does not respect preventDefault), which would make it
// impossible to send ctrl+c to an attached agent PTY. We own ctrl+c
// ourselves — see src/ui/App.tsx.
const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<App />);
