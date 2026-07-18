import { useEffect, useMemo, useRef, useState } from "react";
import { extend, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { decodePasteBytes } from "@opentui/core";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { getFlow } from "../core/storage";
import { runFlow } from "../core/engine";
import type { Flow, RunEvent, RunHandle } from "../types";
import { colors, Hint, marker, type KeyHintSpec } from "./theme";
import { setAttached } from "./attach-state";

extend({ "ghostty-terminal": GhosttyTerminalRenderable });

// Global augmentation interface for extended components — see
// node_modules/@opentui/react/src/types/components.d.ts / jsx-namespace.d.ts.
declare module "@opentui/react" {
  interface OpenTUIComponents {
    "ghostty-terminal": typeof GhosttyTerminalRenderable;
  }
}

type StepStatus = "pending" | "running" | "validating" | "retrying" | "done" | "failed";

interface StatusMessage {
  text: string;
  color: string;
}

const STATUS_SYMBOL: Record<StepStatus, string> = {
  pending: "○",
  running: "▶",
  validating: "◐",
  retrying: "↻",
  done: "✓",
  failed: "✗",
};

const STATUS_COLOR: Record<StepStatus, string> = {
  pending: colors.textSecondary,
  running: colors.accent,
  validating: colors.accent,
  retrying: colors.warning,
  done: colors.success,
  failed: colors.error,
};

const MIN_TERM_COLS = 40;
const MIN_TERM_ROWS = 10;
const STEPS_PANE_WIDTH = 36;
// Steps pane width + row's outer margin (1+1) + pane gap (1) + terminal
// pane's own left/right border (1+1).
const HORIZONTAL_CHROME = STEPS_PANE_WIDTH + 2 + 1 + 2;
// Header line + row's outer margin (1+1) + terminal border (1+1) + status
// strip + hint bar.
const VERTICAL_CHROME = 8;

function stepSeparator(stepIndex: number, stepName: string): string {
  return `\r\n\x1b[2m── step ${stepIndex + 1}: ${stepName} ──\x1b[0m\r\n`;
}

export function RunScreen({
  flowId,
  params,
  onExit,
}: {
  flowId: string;
  params: Record<string, string>;
  onExit: () => void;
}) {
  const flow: Flow | undefined = useMemo(() => getFlow(flowId), [flowId]);
  const { width, height } = useTerminalDimensions();

  const termCols = Math.max(MIN_TERM_COLS, width - HORIZONTAL_CHROME);
  const termRows = Math.max(MIN_TERM_ROWS, height - VERTICAL_CHROME);

  const [statuses, setStatuses] = useState<StepStatus[]>(() => (flow ? flow.steps.map(() => "pending") : []));
  const [attempts, setAttempts] = useState<number[]>(() => (flow ? flow.steps.map(() => 1) : []));
  const [statusMessage, setStatusMessage] = useState<StatusMessage | null>(null);
  const [flowStatus, setFlowStatus] = useState<"running" | "complete" | "failed">("running");
  const [finalError, setFinalError] = useState<string | null>(null);
  const [attachedUi, setAttachedUi] = useState(false);

  const handleRef = useRef<RunHandle | null>(null);
  const termRef = useRef<GhosttyTerminalRenderable | null>(null);

  function handleEvent(e: RunEvent) {
    switch (e.type) {
      case "flow-start":
        break;
      case "step-start":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "running";
          return next;
        });
        setAttempts((prev) => {
          const next = [...prev];
          next[e.stepIndex] = e.attempt;
          return next;
        });
        if (e.attempt === 1) {
          termRef.current?.feed(stepSeparator(e.stepIndex, e.stepName));
        }
        break;
      case "agent-output":
        termRef.current?.feed(e.chunk);
        break;
      case "step-output-complete":
        break;
      case "validation-start":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "validating";
          return next;
        });
        setStatusMessage({ text: "validating output...", color: colors.textSecondary });
        break;
      case "validation-result":
        if (e.verdict.passed) {
          setStatusMessage({ text: "validation passed", color: colors.success });
        } else {
          setStatusMessage({ text: `validation failed: ${e.verdict.feedback}`, color: colors.error });
        }
        break;
      case "step-retry":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "retrying";
          return next;
        });
        setStatusMessage({ text: `retrying (attempt ${e.attempt}): ${e.feedback}`, color: colors.warning });
        break;
      case "step-complete":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "done";
          return next;
        });
        break;
      case "step-failed":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "failed";
          return next;
        });
        setStatusMessage({ text: `step ${e.stepIndex + 1} failed: ${e.error}`, color: colors.error });
        break;
      case "session-note":
        setStatusMessage({ text: e.note, color: colors.warning });
        termRef.current?.feed(`\r\n\x1b[2m[note] ${e.note}\x1b[0m\r\n`);
        break;
      case "flow-complete":
        setFlowStatus("complete");
        detach();
        break;
      case "flow-failed":
        setFlowStatus("failed");
        setFinalError(e.error);
        setStatusMessage({ text: `flow failed: ${e.error}`, color: colors.error });
        detach();
        break;
    }
  }

  function detach() {
    setAttachedUi(false);
    setAttached(false);
  }

  function start() {
    if (!flow) return;
    termRef.current?.reset();
    setStatuses(flow.steps.map(() => "pending"));
    setAttempts(flow.steps.map(() => 1));
    setStatusMessage(null);
    setFlowStatus("running");
    setFinalError(null);
    detach();
    handleRef.current = runFlow(flow, params, handleEvent, { cols: termCols, rows: termRows });
  }

  useEffect(() => {
    start();
    return () => {
      handleRef.current?.cancel();
      setAttached(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  useEffect(() => {
    handleRef.current?.resize(termCols, termRows);
  }, [termCols, termRows]);

  useKeyboard((key) => {
    if (attachedUi) {
      if (key.eventType === "release") return;
      const isDetachKey = key.raw === "\x1d" || key.sequence === "\x1d";
      if (isDetachKey) {
        detach();
        return;
      }
      handleRef.current?.write(key.raw || key.sequence);
      return;
    }

    if (key.name === "escape") {
      handleRef.current?.cancel();
      onExit();
      return;
    }
    if (flowStatus === "running") {
      if (key.name === "a" && !key.ctrl && !key.meta) {
        setAttachedUi(true);
        setAttached(true);
        return;
      }
      return;
    }
    if (key.name === "q" && !key.ctrl && !key.meta) {
      onExit();
      return;
    }
    if (key.name === "r" && !key.ctrl && !key.meta) {
      start();
      return;
    }
  });

  usePaste((event) => {
    if (!attachedUi) return;
    const text = decodePasteBytes(event.bytes);
    handleRef.current?.write(text);
  });

  if (!flow) {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} padding={2}>
        <text fg={colors.error}>Flow not found: {flowId}</text>
        <Hint>esc back</Hint>
      </box>
    );
  }

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={colors.accent}>Running: {flow.name}</text>
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
          {flow.steps.map((step, i) => {
            const status = statuses[i] ?? "pending";
            const attempt = attempts[i] ?? 1;
            const running = status === "running" || status === "validating" || status === "retrying";
            const bg = running ? colors.selectionBg : undefined;
            const fg = running ? colors.selectionFg : STATUS_COLOR[status];
            return (
              <box key={step.id} flexDirection="row" backgroundColor={bg}>
                <text fg={fg} bg={bg}>
                  {/* status symbol doubles as the marker; the bar shows selection */}
                  {" "}
                  {STATUS_SYMBOL[status]} {step.name}
                  {attempt > 1 ? ` (x${attempt})` : ""}
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
          borderColor={attachedUi ? colors.accent : colors.chrome}
          title={attachedUi ? "Terminal (attached — ctrl+] to detach)" : "Terminal"}
        >
          <ghostty-terminal persistent showCursor ref={termRef} cols={termCols} rows={termRows} flexGrow={1} />
        </box>
      </box>
      {statusMessage && (
        <box paddingLeft={1}>
          <text fg={statusMessage.color}>{statusMessage.text}</text>
        </box>
      )}
      {flowStatus === "complete" && (
        <box paddingLeft={1}>
          <text fg={colors.success}>✓ Flow complete</text>
        </box>
      )}
      {flowStatus === "failed" && (
        <box paddingLeft={1}>
          <text fg={colors.error}>✗ Flow failed{finalError ? `: ${finalError}` : ""}</text>
        </box>
      )}
      <Hint hints={runScreenHints(attachedUi, flowStatus)} />
    </box>
  );
}

function runScreenHints(attachedUi: boolean, flowStatus: "running" | "complete" | "failed"): KeyHintSpec[] {
  if (attachedUi) return [{ keys: "ctrl+]", label: "detach · keys go to agent" }];
  if (flowStatus === "running") {
    return [
      { keys: "a", label: "attach" },
      { keys: "esc", label: "cancel" },
    ];
  }
  return [
    { keys: "esc/q", label: "back to list" },
    { keys: "r", label: "re-run" },
  ];
}
