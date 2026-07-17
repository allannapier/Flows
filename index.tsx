// Flows TUI entry point.

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { App } from "./src/ui/App";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("Flows requires an interactive terminal (TTY). Run it directly in a terminal, not piped.");
  process.exit(0);
}

const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<App />);
