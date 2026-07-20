// Flows entry point. With no subcommand this launches the interactive TUI
// (requires a TTY, as before). `run`/`list`/`--help` are headless CLI
// subcommands that work without one — see FEATURES.md #10 and src/cli/run.ts.

const argv = process.argv.slice(2);
const [cmd, ...rest] = argv;

function printHelp(): void {
  console.log(`Flows — multi-step agent workflow orchestrator

Usage:
  bun run start                                    Launch the interactive TUI (requires a TTY)
  bun run start run <flow-name-or-id> [options]     Run a flow headlessly (no TTY required)
  bun run start list                                List saved flows
  bun run start --help                              Show this help

Options for "run":
  --param key=value   Set a flow parameter (repeatable)
  --json              Emit one JSON RunEvent per line on stdout instead of
                       human-readable log lines

Headless runs never wait on a human: a step that would pause for input
(awaiting-input) proceeds immediately, and a step-failure alert
(alertOnFailure) is auto-acknowledged. Ctrl-C cancels the run.

Exit codes: 0 success, 1 flow failure/cancellation, 2 usage error.`);
}

if (cmd === "--help" || cmd === "-h") {
  printHelp();
} else if (cmd === "list") {
  const { listFlows } = await import("./src/core/storage");
  const flows = listFlows();
  if (flows.length === 0) {
    console.log("No flows found.");
  } else {
    for (const f of flows) {
      console.log(`${f.id}  ${f.name}  (${f.steps.length} step${f.steps.length === 1 ? "" : "s"})`);
    }
  }
} else if (cmd === "run") {
  const { cliRun } = await import("./src/cli/run");
  process.exitCode = await cliRun(rest);
} else if (cmd !== undefined) {
  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exitCode = 2;
} else {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("Flows requires an interactive terminal (TTY). Run it directly in a terminal, not piped.");
    process.exit(0);
  }

  const { createCliRenderer } = await import("@opentui/core");
  const { createRoot } = await import("@opentui/react");
  const { App } = await import("./src/ui/App");

  // The renderer's built-in exitOnCtrlC handler destroys the app
  // unconditionally (it does not respect preventDefault), which would make
  // it impossible to send ctrl+c to an attached agent PTY. We own ctrl+c
  // ourselves — see src/ui/App.tsx.
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  createRoot(renderer).render(<App />);
}
