import { useState } from "react";
import { useKeyboard } from "@opentui/react";
import { getRun } from "../core/runStore";
import type { RunRecord, RunStepRecord } from "../types";
import { colors, Hint, SimpleRow, type KeyHintSpec } from "./theme";

const STATUS_SYMBOL: Record<RunStepRecord["status"], string> = {
  pending: "○",
  done: "✓",
  failed: "✗",
};

const STATUS_COLOR: Record<RunStepRecord["status"], string> = {
  pending: colors.textSecondary,
  done: colors.success,
  failed: colors.error,
};

/** Output is capped to this many lines in the preview pane — full text
 * lives in the run's JSON file under ~/.flows/runs/ for anyone who needs it. */
const MAX_PREVIEW_LINES = 30;

/** Read-only summary of a finished run: step statuses plus each step's
 * captured output. Used when the run is no longer in runManager's active
 * registry (already finished and the app may have restarted since) — a
 * still-active run instead reattaches to the live RunScreen. */
export function RunDetail({ flowId, runId, onBack }: { flowId: string; runId: string; onBack: () => void }) {
  const [run] = useState<RunRecord | undefined>(() => getRun(flowId, runId));
  const [stepCursor, setStepCursor] = useState(0);

  const steps = run?.steps ?? [];
  const safeCursor = Math.max(0, Math.min(stepCursor, steps.length - 1));

  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") {
      onBack();
      return;
    }
    if (key.name === "up") {
      setStepCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "down") {
      setStepCursor((c) => Math.min(steps.length - 1, c + 1));
    }
  });

  const bottomHints: KeyHintSpec[] = [
    { keys: "up/down", label: "select step" },
    { keys: "esc/q", label: "back" },
  ];

  if (!run) {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} padding={2}>
        <text fg={colors.error}>Run not found: {runId}</text>
        <Hint>esc back</Hint>
      </box>
    );
  }

  const selectedStep = steps[safeCursor];
  const outputLines = (selectedStep?.output ?? selectedStep?.error ?? "").split("\n");
  const truncated = outputLines.length > MAX_PREVIEW_LINES;
  const visibleLines = outputLines.slice(0, MAX_PREVIEW_LINES);

  const paramsSummary = Object.entries(run.params)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box paddingLeft={1} paddingTop={1} flexDirection="column">
        <text fg={colors.accent}>Run detail: {run.flowName}</text>
        <text fg={colors.textSecondary}>
          {run.status} · started {new Date(run.startedAt).toLocaleString()}
          {run.finishedAt ? ` · finished ${new Date(run.finishedAt).toLocaleString()}` : ""}
          {paramsSummary ? ` · ${paramsSummary}` : ""}
        </text>
        {run.error && <text fg={colors.error}>{run.error}</text>}
      </box>
      <box flexDirection="row" flexGrow={1} margin={1} gap={1}>
        <box flexDirection="column" border borderStyle="rounded" borderColor={colors.chrome} title="Steps" padding={1} width={36}>
          {steps.length === 0 && <text fg={colors.textSecondary}>No steps.</text>}
          {steps.map((s, i) => (
            <SimpleRow key={s.stepId} selected={safeCursor === i} fg={STATUS_COLOR[s.status]}>
              {STATUS_SYMBOL[s.status]} {s.stepName}
              {s.attempts > 1 ? ` (x${s.attempts})` : ""}
            </SimpleRow>
          ))}
        </box>
        <box
          flexDirection="column"
          flexGrow={1}
          border
          borderStyle="rounded"
          borderColor={colors.chrome}
          title={selectedStep ? `Output: ${selectedStep.stepName}` : "Output"}
          padding={1}
        >
          {!selectedStep && <text fg={colors.textSecondary}>Select a step to see its output.</text>}
          {selectedStep && visibleLines.length === 0 && <text fg={colors.textSecondary}>(no output captured)</text>}
          {visibleLines.map((line, i) => (
            <text key={i} fg={colors.textPrimary}>
              {line || " "}
            </text>
          ))}
          {truncated && (
            <text fg={colors.textPlaceholder}>… truncated — full output in ~/.flows/runs/{flowId}/{runId}.json</text>
          )}
        </box>
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
