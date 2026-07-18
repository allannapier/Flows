import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { extend, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/react";
import { decodePasteBytes } from "@opentui/core";
import { GhosttyTerminalRenderable } from "ghostty-opentui/terminal-buffer";
import { resolveWorkingDir } from "../core/paths";
import { getFlow } from "../core/storage";
import { answerRun, cancelRun, getActiveRun, startRun, subscribeRun, type StepUiStatus } from "../core/runManager";
import type { Flow } from "../types";
import { colors, Hint, type KeyHintSpec } from "./theme";
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
  "needs-input": "?",
  done: "✓",
  failed: "✗",
};

const STATUS_COLOR: Record<StepUiStatus, string> = {
  pending: colors.textSecondary,
  running: colors.accent,
  validating: colors.accent,
  retrying: colors.warning,
  "needs-input": colors.warning,
  done: colors.success,
  failed: colors.error,
};

const MESSAGE_COLOR: Record<"secondary" | "success" | "warning" | "error", string> = {
  secondary: colors.textSecondary,
  success: colors.success,
  warning: colors.warning,
  error: colors.error,
};

/** Keeps the tail of a path (the informative end) when it's too long for a
 * narrow pane, rather than truncating from the front like previewLine does. */
function truncatePath(path: string, max: number): string {
  return path.length > max ? `…${path.slice(-(max - 1))}` : path;
}

const MIN_TERM_COLS = 40;
const MIN_TERM_ROWS = 10;
const STEPS_PANE_WIDTH = 36;
// Steps pane width + row's outer margin (1+1) + pane gap (1) + terminal
// pane's own left/right border (1+1).
const HORIZONTAL_CHROME = STEPS_PANE_WIDTH + 2 + 1 + 2;
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
  const [answerDraft, setAnswerDraft] = useState("");
  const [, forceUpdate] = useReducer((n) => n + 1, 0);

  const termRef = useRef<GhosttyTerminalRenderable | null>(null);
  // How many of the run's feedLog chunks have already been fed to the
  // *current* terminal instance — lets us both replay history on first
  // attach and stream only new chunks afterwards, without re-feeding.
  const fedCountRef = useRef(0);
  const seenRunIdRef = useRef<string | null>(null);

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

  const run = runId ? getActiveRun(runId) : undefined;
  // A pending question takes priority over attach — there's no live PTY to
  // attach to by the time a step pauses on one (the agent already exited
  // after asking; see engine.ts's looksLikeClarifyingQuestion).
  const answering = !attachedUi && !!run?.pendingQuestion;

  // Clear any half-typed answer once the pause it belonged to is gone
  // (answered, step moved on, or a different step is now asking).
  const pendingQuestionKey = run?.pendingQuestion ? `${run.pendingQuestion.stepIndex}` : null;
  const lastPendingKeyRef = useRef<string | null>(null);
  if (lastPendingKeyRef.current !== pendingQuestionKey) {
    lastPendingKeyRef.current = pendingQuestionKey;
    if (answerDraft !== "") setAnswerDraft("");
  }

  function submitAnswer() {
    if (!runId || !answerDraft.trim()) return;
    answerRun(runId, answerDraft.trim());
    setAnswerDraft("");
  }

  // New run instance (fresh start or re-run) — reset the terminal and feed
  // bookkeeping so replay starts from that run's beginning, not wherever the
  // previous one left off.
  if (seenRunIdRef.current !== runId) {
    seenRunIdRef.current = runId;
    fedCountRef.current = 0;
    termRef.current?.reset();
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
    if (answering) {
      // Every other key is handled by the focused <input> below (see
      // FieldRow's identical pattern in theme.tsx) — it manages its own
      // text buffer and calls submitAnswer() via onSubmit.
      return;
    }
    if (run?.status === "running") {
      if (key.name === "a" && !key.ctrl && !key.meta) {
        setAttachedUi(true);
        setAttached(true);
        return;
      }
      if (key.name === "c" && !key.ctrl && !key.meta) {
        if (runId) cancelRun(runId);
        return;
      }
      return;
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
    if (!attachedUi) return;
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
            const running = status === "running" || status === "validating" || status === "retrying";
            const bg = running ? colors.selectionBg : undefined;
            const fg = running ? colors.selectionFg : STATUS_COLOR[status];
            return (
              <box key={step.id} flexDirection="column" backgroundColor={bg}>
                <text fg={fg} bg={bg}>
                  {/* status symbol doubles as the marker; the bar shows selection */}
                  {" "}
                  {STATUS_SYMBOL[status]} {step.name}
                  {attempt > 1 ? ` (x${attempt})` : ""}
                </text>
                {running && (
                  <text fg={colors.textSecondary} bg={bg}>
                    {"   "}
                    {truncatePath(resolveWorkingDir(step.workingDir), STEPS_PANE_WIDTH - 5)}
                  </text>
                )}
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
      {run.pendingQuestion && (
        <box flexDirection="column" border borderStyle="rounded" borderColor={colors.warning} margin={1} marginTop={0} padding={1}>
          <text fg={colors.warning}>? {run.flow.steps[run.pendingQuestion.stepIndex]?.name ?? "step"} is waiting on you:</text>
          <text fg={colors.textPrimary}>{run.pendingQuestion.question}</text>
          <box flexDirection="row">
            <text fg={colors.textSecondary}>{"> "}</text>
            <input
              flexGrow={1}
              focused={answering}
              value={answerDraft}
              onInput={setAnswerDraft}
              onSubmit={submitAnswer}
            />
          </box>
        </box>
      )}
      {run.statusMessage && !run.pendingQuestion && (
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
      <Hint hints={runScreenHints(attachedUi, answering, run.status)} />
    </box>
  );
}

function runScreenHints(
  attachedUi: boolean,
  answering: boolean,
  status: "running" | "complete" | "failed" | "cancelled",
): KeyHintSpec[] {
  if (attachedUi) return [{ keys: "ctrl+]", label: "detach · keys go to agent" }];
  if (answering) return [{ keys: "⏎", label: "send answer" }, { keys: "esc", label: "back (keeps waiting)" }];
  if (status === "running") {
    return [
      { keys: "a", label: "attach" },
      { keys: "c", label: "cancel" },
      { keys: "esc", label: "back (keeps running)" },
    ];
  }
  return [
    { keys: "esc/q", label: "back to list" },
    { keys: "r", label: "re-run" },
  ];
}
