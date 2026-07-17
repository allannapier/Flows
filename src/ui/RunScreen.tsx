import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard } from "@opentui/react";
import { getFlow } from "../core/storage";
import { runFlow } from "../core/engine";
import type { Flow, RunEvent, RunHandle } from "../types";
import { colors, Hint } from "./theme";

type StepStatus = "pending" | "running" | "validating" | "retrying" | "done" | "failed";

interface LogLine {
  id: number;
  text: string;
  color: string;
}

let logId = 0;

const STATUS_SYMBOL: Record<StepStatus, string> = {
  pending: "○",
  running: "▶",
  validating: "◐",
  retrying: "↻",
  done: "✓",
  failed: "✗",
};

const STATUS_COLOR: Record<StepStatus, string> = {
  pending: colors.dim,
  running: colors.accent,
  validating: colors.accent,
  retrying: colors.warning,
  done: colors.success,
  failed: colors.error,
};

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

  const [statuses, setStatuses] = useState<StepStatus[]>(() => (flow ? flow.steps.map(() => "pending") : []));
  const [attempts, setAttempts] = useState<number[]>(() => (flow ? flow.steps.map(() => 1) : []));
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [flowStatus, setFlowStatus] = useState<"running" | "complete" | "failed">("running");
  const [finalError, setFinalError] = useState<string | null>(null);

  const handleRef = useRef<RunHandle | null>(null);
  const partialLinesRef = useRef<Record<number, string>>({});
  const runIdRef = useRef(0);

  function pushLine(text: string, color: string = colors.text) {
    logId += 1;
    setLogLines((prev) => [...prev, { id: logId, text, color }]);
  }

  function handleEvent(e: RunEvent) {
    switch (e.type) {
      case "flow-start":
        pushLine(`Starting "${e.flowName}" — ${e.totalSteps} step${e.totalSteps === 1 ? "" : "s"}`, colors.accent);
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
        pushLine(
          `▶ Step ${e.stepIndex + 1}: ${e.stepName} (${e.agent})${e.attempt > 1 ? ` — attempt ${e.attempt}` : ""}`,
          colors.accent,
        );
        break;
      case "agent-output": {
        const buf = (partialLinesRef.current[e.stepIndex] ?? "") + e.chunk;
        const parts = buf.split("\n");
        partialLinesRef.current[e.stepIndex] = parts.pop() ?? "";
        for (const line of parts) {
          if (line.length > 0) pushLine(line, colors.textMuted);
        }
        break;
      }
      case "step-output-complete": {
        const remainder = partialLinesRef.current[e.stepIndex];
        if (remainder) {
          pushLine(remainder, colors.textMuted);
          partialLinesRef.current[e.stepIndex] = "";
        }
        break;
      }
      case "validation-start":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "validating";
          return next;
        });
        pushLine("  validating output...", colors.dim);
        break;
      case "validation-result":
        if (e.verdict.passed) {
          pushLine("  ✓ validation passed", colors.success);
        } else {
          pushLine(`  ✗ validation failed: ${e.verdict.feedback}`, colors.error);
        }
        break;
      case "step-retry":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "retrying";
          return next;
        });
        pushLine(`  retrying (attempt ${e.attempt}): ${e.feedback}`, colors.warning);
        break;
      case "step-complete":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "done";
          return next;
        });
        pushLine(`✓ step ${e.stepIndex + 1} complete`, colors.success);
        break;
      case "step-failed":
        setStatuses((prev) => {
          const next = [...prev];
          next[e.stepIndex] = "failed";
          return next;
        });
        pushLine(`✗ step ${e.stepIndex + 1} failed: ${e.error}`, colors.error);
        break;
      case "flow-complete":
        setFlowStatus("complete");
        pushLine("Flow complete.", colors.success);
        break;
      case "flow-failed":
        setFlowStatus("failed");
        setFinalError(e.error);
        pushLine(`Flow failed: ${e.error}`, colors.error);
        break;
    }
  }

  function start() {
    if (!flow) return;
    runIdRef.current += 1;
    partialLinesRef.current = {};
    setStatuses(flow.steps.map(() => "pending"));
    setAttempts(flow.steps.map(() => 1));
    setLogLines([]);
    setFlowStatus("running");
    setFinalError(null);
    handleRef.current = runFlow(flow, params, handleEvent);
  }

  useEffect(() => {
    start();
    return () => {
      handleRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      handleRef.current?.cancel();
      onExit();
      return;
    }
    if (flowStatus !== "running") {
      if (key.name === "q") {
        onExit();
        return;
      }
      if (key.name === "r") {
        start();
        return;
      }
    }
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
          borderColor={colors.dim}
          title="Steps"
          padding={1}
          width={36}
        >
          {flow.steps.map((step, i) => {
            const status = statuses[i] ?? "pending";
            const attempt = attempts[i] ?? 1;
            return (
              <text key={step.id} fg={STATUS_COLOR[status]}>
                {STATUS_SYMBOL[status]} {step.name}
                {attempt > 1 ? ` (x${attempt})` : ""}
              </text>
            );
          })}
        </box>
        <scrollbox
          flexGrow={1}
          border
          borderStyle="rounded"
          borderColor={colors.dim}
          title="Output"
          padding={1}
          stickyScroll
          stickyStart="bottom"
        >
          {logLines.map((l) => (
            <text key={l.id} fg={l.color}>
              {l.text}
            </text>
          ))}
        </scrollbox>
      </box>
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
      <Hint>
        {flowStatus === "running" ? "esc cancel" : "esc/q back to list · r re-run"}
      </Hint>
    </box>
  );
}
