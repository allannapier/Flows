import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { extend, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { decodePasteBytes, TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { getFlow } from "../core/storage";
import {
  acknowledgeAlert,
  cancelRun,
  closeRun,
  continueRun,
  getActiveRun,
  setViewedRun,
  startRun,
  subscribeRun,
  type StepUiStatus,
} from "../core/runManager";
import type { Flow, RunStatus } from "../types";
import { Button, colors, Hint, type KeyHintSpec } from "./theme";
import { setAttached } from "./attach-state";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

// Global augmentation interface for extended components — see
// node_modules/@opentui/react/src/types/components.d.ts / jsx-namespace.d.ts.
declare module "@opentui/react" {
  interface OpenTUIComponents {
    "ghostty-terminal": typeof GhosttyTerminalRenderable;
  }
}

const STATUS_SYMBOL: Record<StepUiStatus, string> = {
  pending: "○",
  running: "▶",
  validating: "◐",
  retrying: "↻",
  done: "✓",
  failed: "✗",
};

const STATUS_COLOR: Record<StepUiStatus, string> = {
  pending: colors.textSecondary,
  running: colors.accent,
  validating: colors.accent,
  retrying: colors.warning,
  done: colors.success,
  failed: colors.error,
};

const MESSAGE_COLOR: Record<"secondary" | "success" | "warning" | "error", string> = {
  secondary: colors.textSecondary,
  success: colors.success,
  warning: colors.warning,
  error: colors.error,
};

const MIN_TERM_COLS = 40;
const MIN_TERM_ROWS = 10;
const STEPS_PANE_WIDTH = 36;
// Steps pane width + row's outer margin (1+1) + pane gap (1) + terminal
// pane's own left/right border (1+1) + the scrollbox's vertical scrollbar
// column (1), which only appears once there's more output than fits.
const HORIZONTAL_CHROME = STEPS_PANE_WIDTH + 2 + 1 + 2 + 1;
// Header line + row's outer margin (1+1) + terminal border (1+1) + status
// strip + hint bar.
const VERTICAL_CHROME = 8;

/**
 * Runs a flow (or attaches to one already running) and shows its live PTY
 * output. The run itself is owned by runManager, not this component — pass
 * `runId` to attach to an existing run (in progress or just finished) or
 * `params` to start a fresh one. Leaving this screen (Escape) never kills
 * the underlying run; only the explicit "c" cancel key does.
 */
export function RunScreen({
  flowId,
  runId: initialRunId,
  params,
  onExit,
}: {
  flowId: string;
  runId?: string;
  params?: Record<string, string>;
  onExit: () => void;
}) {
  const flow: Flow | undefined = useMemo(() => getFlow(flowId), [flowId]);
  const { width, height } = useTerminalDimensions();

  const termCols = Math.max(MIN_TERM_COLS, width - HORIZONTAL_CHROME);
  const termRows = Math.max(MIN_TERM_ROWS, height - VERTICAL_CHROME);

  const [runId, setRunId] = useState<string | null>(initialRunId ?? null);
  const [attachedUi, setAttachedUi] = useState(false);
  // Whether the detached terminal view has been scrolled away from the live
  // bottom — drives the pane title's "scrolled" suffix and whether newly
  // streamed output should keep pulling the view back down (it shouldn't,
  // while the user is reading scrollback).
  const [scrolledUp, setScrolledUp] = useState(false);
  const [, forceUpdate] = useReducer((n) => n + 1, 0);

  const termRef = useRef<GhosttyTerminalRenderable | null>(null);
  const scrollBoxRef = useRef<ScrollBoxRenderable | null>(null);
  // How many of the run's feedLog chunks have already been fed to the
  // *current* terminal instance — lets us both replay history on first
  // attach and stream only new chunks afterwards, without re-feeding.
  const fedCountRef = useRef(0);
  const seenRunIdRef = useRef<string | null>(null);

  // Re-derives `scrolledUp` from the scrollbox's actual position — called
  // after every manual scroll action (the box's own sticky-bottom logic
  // handles the rest: it keeps pinned to the bottom on new output until the
  // user scrolls away, then stays put).
  function syncScrolledUp() {
    const box = scrollBoxRef.current;
    if (!box) return;
    const maxScrollTop = Math.max(0, box.scrollHeight - box.viewport.height);
    setScrolledUp(maxScrollTop > 0 && box.scrollTop < maxScrollTop - 1);
  }

  // Start a fresh run if we weren't handed an existing one to attach to.
  useEffect(() => {
    if (!flow || runId || !params) return;
    setRunId(startRun(flow, params, { cols: termCols, rows: termRows }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  useEffect(() => {
    if (!runId) return;
    return subscribeRun(runId, forceUpdate);
  }, [runId]);

  // Tells runManager this run is on-screen so it suppresses completion/
  // failure notifications for it (awaiting-input/step-alert still bell).
  // Cleared on every runId change (including the final unmount), not just
  // at the end, so navigating from one run straight to another never leaves
  // the old id registered as "viewed".
  useEffect(() => {
    if (!runId) return;
    setViewedRun(runId);
    return () => setViewedRun(null);
  }, [runId]);

  const run = runId ? getActiveRun(runId) : undefined;

  // New run instance (fresh start or re-run) — reset the terminal and feed
  // bookkeeping so replay starts from that run's beginning, not wherever the
  // previous one left off.
  if (seenRunIdRef.current !== runId) {
    seenRunIdRef.current = runId;
    fedCountRef.current = 0;
    termRef.current?.reset();
    scrollBoxRef.current?.scrollTo(0);
    setScrolledUp(false);
  }

  // Replay any feedLog chunks not yet fed to this terminal instance. Runs
  // after every render (cheap no-op once caught up) rather than gating on a
  // dependency array, since new chunks arrive via runManager's subscription
  // rather than through props.
  useEffect(() => {
    const term = termRef.current;
    if (!run || !term) return;
    for (let i = fedCountRef.current; i < run.feedLog.length; i++) term.feed(run.feedLog[i]!);
    fedCountRef.current = run.feedLog.length;
  });

  useEffect(() => {
    run?.handle.resize(termCols, termRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [termCols, termRows, runId]);

  useEffect(() => {
    return () => setAttached(false);
  }, []);

  function detach() {
    setAttachedUi(false);
    setAttached(false);
  }

  function rerun() {
    if (!flow || !run) return;
    detach();
    setRunId(startRun(flow, run.params, { cols: termCols, rows: termRows }));
  }

  useKeyboard((key) => {
    // A blocking step-failure alert takes over the whole screen: every
    // other binding (attach, continue, cancel, scroll, even keys otherwise
    // forwarded to an attached agent PTY) is suspended until dismissed.
    if (run?.pendingAlert) {
      if (key.eventType === "release") return;
      if (!key.ctrl && !key.meta && (key.name === "return" || key.name === "d")) {
        if (runId) acknowledgeAlert(runId);
      }
      return;
    }
    if (attachedUi) {
      if (key.eventType === "release") return;
      const isDetachKey = key.raw === "\x1d" || key.sequence === "\x1d";
      if (isDetachKey) {
        detach();
        return;
      }
      run?.handle.write(key.raw || key.sequence);
      return;
    }

    if (key.name === "escape") {
      // Deliberately does NOT cancel the run — it keeps going in the
      // background and can be re-attached from the flow list or history.
      onExit();
      return;
    }
    // Terminal scrollback — detached mode only; while attached these keys
    // forward straight to the agent's own PTY (handled by the branch above).
    if (key.name === "pageup") {
      scrollBoxRef.current?.scrollBy(-1, "viewport");
      syncScrolledUp();
      return;
    }
    if (key.name === "pagedown") {
      scrollBoxRef.current?.scrollBy(1, "viewport");
      syncScrolledUp();
      return;
    }
    if (key.shift && key.name === "up") {
      scrollBoxRef.current?.scrollBy(-1, "step");
      syncScrolledUp();
      return;
    }
    if (key.shift && key.name === "down") {
      scrollBoxRef.current?.scrollBy(1, "step");
      syncScrolledUp();
      return;
    }
    const runInFlight = run?.status === "running" || run?.status === "awaiting-input";
    if (runInFlight) {
      if (key.name === "a" && !key.ctrl && !key.meta) {
        setAttachedUi(true);
        setAttached(true);
        return;
      }
      if (key.name === "c" && !key.ctrl && !key.meta) {
        if (runId) cancelRun(runId);
        return;
      }
      if (run?.status === "awaiting-input" && key.name === "f" && !key.ctrl && !key.meta) {
        if (runId) continueRun(runId);
        return;
      }
      return;
    }
    // Finished run whose interactive session is still alive — the agent TUI
    // stays usable until explicitly closed (or a re-run replaces it).
    if (run?.hasLiveSession) {
      if (key.name === "a" && !key.ctrl && !key.meta) {
        setAttachedUi(true);
        setAttached(true);
        return;
      }
      if (key.name === "x" && !key.ctrl && !key.meta) {
        if (runId) closeRun(runId);
        return;
      }
    }
    if (key.name === "q" && !key.ctrl && !key.meta) {
      onExit();
      return;
    }
    if (key.name === "r" && !key.ctrl && !key.meta) {
      rerun();
      return;
    }
  });

  usePaste((event) => {
    if (!attachedUi || run?.pendingAlert) return;
    const text = decodePasteBytes(event.bytes);
    run?.handle.write(text);
  });

  if (!flow) {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} padding={2}>
        <text fg={colors.error}>Flow not found: {flowId}</text>
        <Hint>esc back</Hint>
      </box>
    );
  }

  if (!run) {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} padding={2}>
        <text fg={colors.textSecondary}>Starting "{flow.name}"...</text>
      </box>
    );
  }

  const displayFlow = run.flow;

  if (run.pendingAlert) {
    const alert = run.pendingAlert;
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} justifyContent="center" alignItems="center">
        <box
          border
          borderStyle="rounded"
          borderColor={colors.error}
          title="Step failed"
          padding={2}
          flexDirection="column"
          gap={1}
          width={Math.min(termCols, 72)}
        >
          <text>
            <span fg={colors.textSecondary}>Step "</span>
            <span fg={colors.textPrimary} attributes={TextAttributes.BOLD}>
              {alert.stepName}
            </span>
            <span fg={colors.textSecondary}>" failed:</span>
          </text>
          <text fg={colors.error}>{alert.error}</text>
          <box flexDirection="row" gap={2}>
            <Button label="⏎ Dismiss" selected color={colors.error} />
          </box>
        </box>
        <Hint hints={[{ keys: "⏎/d", label: "dismiss" }]} />
      </box>
    );
  }

  const isAwaitingInput = run.status === "awaiting-input";
  let terminalBorderColor: string = colors.chrome;
  let terminalTitle: string;
  if (attachedUi) {
    terminalBorderColor = colors.accent;
    terminalTitle = isAwaitingInput
      ? "Terminal (attached — answer the agent, ctrl+] to detach)"
      : "Terminal (attached — ctrl+] to detach)";
  } else if (isAwaitingInput) {
    terminalBorderColor = colors.warning;
    terminalTitle = "Terminal (agent is asking — press a to answer)";
  } else if (run.status !== "running" && run.hasLiveSession) {
    terminalTitle = "Terminal (session still live — a to attach)";
  } else {
    terminalTitle = "Terminal";
  }
  if (!attachedUi && scrolledUp) {
    terminalTitle += " · scrolled ↑ (PgDn to follow)";
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={colors.accent}>Running: {displayFlow.name}</text>
      </box>
      <box flexDirection="row" flexGrow={1} margin={1} gap={1}>
        <box
          flexDirection="column"
          border
          borderStyle="rounded"
          borderColor={colors.chrome}
          title="Steps"
          padding={1}
          width={STEPS_PANE_WIDTH}
        >
          {displayFlow.steps.map((step, i) => {
            const status = run.stepStatuses[i] ?? "pending";
            const attempt = run.attempts[i] ?? 1;
            const executions = run.executions[i] ?? 0;
            const running = status === "running" || status === "validating" || status === "retrying";
            const bg = running ? colors.selectionBg : undefined;
            const fg = running ? colors.selectionFg : STATUS_COLOR[status];
            // Show "x2" once a routing jump has re-entered the step; still
            // show retry attempts within the current execution as "a2" so
            // both signals are readable at a glance without colliding.
            const executionsBadge = executions > 1 ? ` x${executions}` : "";
            const attemptBadge = attempt > 1 ? ` a${attempt}` : "";
            return (
              <box key={step.id} flexDirection="row" backgroundColor={bg}>
                <text fg={fg} bg={bg}>
                  {/* status symbol doubles as the marker; the bar shows selection */}
                  {" "}
                  {STATUS_SYMBOL[status]} {step.name}
                  {executionsBadge}
                  {attemptBadge}
                </text>
              </box>
            );
          })}
        </box>
        <box
          flexDirection="column"
          flexGrow={1}
          border
          borderStyle="rounded"
          borderColor={terminalBorderColor}
          title={terminalTitle}
        >
          {attachedUi && (
            // A keyboard shortcut can't double as a button here — every key
            // is forwarded straight to the agent PTY while attached (see the
            // useKeyboard handler above), so a mouse click is the only way
            // to offer a non-ctrl+] way to detach.
            <box flexDirection="row" justifyContent="flex-end" paddingRight={1}>
              <Button label="Detach" selected={false} onMouseDown={detach} />
            </box>
          )}
          <scrollbox ref={scrollBoxRef} flexGrow={1} stickyScroll stickyStart="bottom" scrollX={false}>
            <ghostty-terminal persistent showCursor ref={termRef} cols={termCols} rows={termRows} />
          </scrollbox>
        </box>
      </box>
      {run.statusMessage && (
        <box paddingLeft={1}>
          <text fg={MESSAGE_COLOR[run.statusMessage.kind]}>{run.statusMessage.text}</text>
        </box>
      )}
      {run.status === "complete" && (
        <box paddingLeft={1}>
          <text fg={colors.success}>✓ Flow complete</text>
        </box>
      )}
      {run.status === "failed" && (
        <box paddingLeft={1}>
          <text fg={colors.error}>✗ Flow failed{run.finalError ? `: ${run.finalError}` : ""}</text>
        </box>
      )}
      {run.status === "cancelled" && (
        <box paddingLeft={1}>
          <text fg={colors.warning}>⊘ Flow cancelled</text>
        </box>
      )}
      <Hint hints={runScreenHints(attachedUi, run.status, run.hasLiveSession)} />
    </box>
  );
}

function runScreenHints(attachedUi: boolean, status: RunStatus, hasLiveSession: boolean): KeyHintSpec[] {
  if (attachedUi) {
    if (status === "awaiting-input") {
      return [
        { keys: "(type)", label: "your answer in the agent TUI" },
        { keys: "ctrl+]", label: "detach" },
      ];
    }
    return [{ keys: "ctrl+]", label: "detach · keys go to agent" }];
  }
  if (status === "awaiting-input") {
    return [
      { keys: "a", label: "attach & answer" },
      { keys: "f", label: "continue flow" },
      { keys: "c", label: "cancel" },
      { keys: "esc", label: "back" },
    ];
  }
  if (status === "running") {
    return [
      { keys: "a", label: "attach" },
      { keys: "c", label: "cancel" },
      { keys: "esc", label: "back (keeps running)" },
    ];
  }
  if (hasLiveSession) {
    return [
      { keys: "a", label: "attach (session live)" },
      { keys: "x", label: "close session" },
      { keys: "r", label: "re-run" },
      { keys: "esc/q", label: "back" },
    ];
  }
  return [
    { keys: "esc/q", label: "back to list" },
    { keys: "r", label: "re-run" },
  ];
}
