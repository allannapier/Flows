import { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { listRuns } from "../core/runStore";
import { getActiveRun } from "../core/runManager";
import type { RunRecord } from "../types";
import { colors, Hint, SimpleRow, type KeyHintSpec } from "./theme";

const STATUS_GLYPH: Record<RunRecord["status"], string> = {
  running: "▶",
  complete: "✓",
  failed: "✗",
  cancelled: "⊘",
};

const STATUS_COLOR: Record<RunRecord["status"], string> = {
  running: colors.accent,
  complete: colors.success,
  failed: colors.error,
  cancelled: colors.warning,
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(startedAt: string, finishedAt?: string): string {
  if (!finishedAt) return "in progress";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0 || Number.isNaN(ms)) return "";
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return `${mins}m${rem ? ` ${rem}s` : ""}`;
}

export function RunHistory({
  flowId,
  flowName,
  onSelectRun,
  onBack,
}: {
  flowId: string;
  flowName: string;
  onSelectRun: (runId: string) => void;
  onBack: () => void;
}) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    setRuns(listRuns(flowId));
  }, [flowId]);

  const safeCursor = Math.max(0, Math.min(cursor, runs.length - 1));

  useKeyboard((key) => {
    if (key.name === "escape") {
      onBack();
      return;
    }
    if (key.name === "up") {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.name === "down") {
      setCursor((c) => Math.min(runs.length - 1, c + 1));
      return;
    }
    if (key.name === "return") {
      const run = runs[safeCursor];
      if (run) onSelectRun(run.id);
    }
  });

  const bottomHints: KeyHintSpec[] = [
    { keys: "⏎", label: "open" },
    { keys: "up/down", label: "move" },
    { keys: "esc", label: "back" },
  ];

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box paddingLeft={1} paddingTop={1}>
        <text fg={colors.accent}>History: {flowName}</text>
      </box>
      <box
        flexGrow={1}
        flexDirection="column"
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        title={`Runs (${runs.length})`}
        margin={1}
        padding={1}
      >
        {runs.length === 0 && <text fg={colors.textSecondary}>No runs yet.</text>}
        {runs.map((run, i) => {
          const isLive = !!getActiveRun(run.id);
          const paramsSummary = Object.entries(run.params)
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          return (
            <SimpleRow key={run.id} selected={safeCursor === i} fg={STATUS_COLOR[run.status]} hint={[{ keys: "⏎", label: "open" }]}>
              {STATUS_GLYPH[run.status]} {formatWhen(run.startedAt)}
              {"  "}
              {run.status}
              {isLive && run.status === "running" ? " (live)" : ""}
              {"  "}
              {formatDuration(run.startedAt, run.finishedAt)}
              {paramsSummary ? `  — ${paramsSummary}` : ""}
              {run.error ? `  (${run.error})` : ""}
            </SimpleRow>
          );
        })}
      </box>
      <Hint hints={bottomHints} />
    </box>
  );
}
