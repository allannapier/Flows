import { useEffect, useReducer, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { SelectOption } from "@opentui/core";
import { listFlows, duplicateFlow } from "../core/storage";
import { getInProgressRunForFlow } from "../core/runManager";
import type { Flow } from "../types";
import { colors, Hint } from "./theme";

const HINTS = [
  { keys: "⏎", label: "run" },
  { keys: "n", label: "new" },
  { keys: "e", label: "edit" },
  { keys: "h", label: "history" },
  { keys: "c", label: "duplicate" },
  { keys: "x", label: "export" },
  { keys: "i", label: "import" },
  { keys: "d", label: "delete" },
  { keys: "s", label: "settings" },
  { keys: "q", label: "quit" },
];

export function FlowList({
  onRun,
  onResume,
  onNew,
  onEdit,
  onHistory,
  onDelete,
  onSettings,
  onExport,
  onImport,
  initialStatus,
}: {
  onRun: (flowId: string) => void;
  /** A run is already in progress for this flow — reattach to it instead of
   * starting a new one. */
  onResume: (flowId: string, runId: string) => void;
  onNew: () => void;
  onEdit: (flowId: string) => void;
  onHistory: (flowId: string) => void;
  onDelete: (flowId: string) => void;
  onSettings: () => void;
  onExport: (flowId: string) => void;
  onImport: () => void;
  /** Transient status line to show on mount (e.g. after an export/import
   * completed and navigated back here). */
  initialStatus?: string;
}) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [status, setStatus] = useState<string | undefined>(initialStatus);
  const renderer = useRenderer();
  // getInProgressRunForFlow is read fresh on every render (see `options`
  // below), but nothing normally triggers a re-render while a background
  // run finishes on its own — poll so the "● running" tag doesn't go stale
  // while just sitting on this screen.
  const [, pulse] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    setFlows(listFlows());
  }, []);

  useEffect(() => {
    const id = setInterval(pulse, 2000);
    return () => clearInterval(id);
  }, []);

  function activate(f: Flow) {
    const inProgress = getInProgressRunForFlow(f.id);
    if (inProgress) onResume(f.id, inProgress.id);
    else onRun(f.id);
  }

  useKeyboard((key) => {
    if (key.ctrl || key.meta) return;
    if (key.name === "q") {
      try {
        renderer.destroy();
      } catch {
        // best effort cleanup
      }
      process.exit(0);
    } else if (key.name === "n") {
      onNew();
    } else if (key.name === "e") {
      const f = flows[selectedIndex];
      if (f) onEdit(f.id);
    } else if (key.name === "h") {
      const f = flows[selectedIndex];
      if (f) onHistory(f.id);
    } else if (key.name === "d") {
      const f = flows[selectedIndex];
      if (f) onDelete(f.id);
    } else if (key.name === "s") {
      onSettings();
    } else if (key.name === "c") {
      const f = flows[selectedIndex];
      if (f) {
        const copy = duplicateFlow(f.id);
        if (copy) {
          const updated = listFlows();
          setFlows(updated);
          const idx = updated.findIndex((x) => x.id === copy.id);
          setSelectedIndex(idx >= 0 ? idx : selectedIndex);
          setStatus(`Duplicated as "${copy.name}"`);
        }
      }
    } else if (key.name === "x") {
      const f = flows[selectedIndex];
      if (f) onExport(f.id);
    } else if (key.name === "i") {
      onImport();
    } else if (key.name === "return") {
      const f = flows[selectedIndex];
      if (f) activate(f);
    }
  });

  const options: SelectOption[] = flows.map((f) => {
    const inProgress = getInProgressRunForFlow(f.id);
    const base = `${f.description || "No description"}  ·  ${f.steps.length} step${f.steps.length === 1 ? "" : "s"}`;
    const liveTag =
      inProgress?.status === "awaiting-input" ? "  ·  ⧖ waiting on you" : inProgress ? "  ·  ● running" : "";
    return {
      name: f.name || "(untitled flow)",
      description: `${base}${liveTag}`,
      value: f.id,
    };
  });

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <ascii-font text="FLOWS" font="tiny" color={colors.accent} />
        <text fg={colors.textSecondary}>Run multi-step agent workflows</text>
        {status && <text fg={colors.accent}>{status}</text>}
      </box>
      <box
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={colors.accent}
        title="Flows"
        margin={1}
        padding={1}
      >
        {flows.length === 0 ? (
          <text>
            <span fg={colors.textSecondary}>No flows yet. Press </span>
            <span fg={colors.accent}>n</span>
            <span fg={colors.textSecondary}> to create your first flow.</span>
          </text>
        ) : (
          <select
            focused
            flexGrow={1}
            options={options}
            selectedIndex={selectedIndex}
            onChange={(index) => setSelectedIndex(index)}
            onSelect={(_index, option) => {
              const f = flows.find((flow) => flow.id === option?.value);
              if (f) activate(f);
            }}
            textColor={colors.textPrimary}
            backgroundColor={colors.bg}
            focusedBackgroundColor={colors.bg}
            focusedTextColor={colors.textPrimary}
            selectedBackgroundColor={colors.selectionBg}
            selectedTextColor={colors.selectionFg}
            descriptionColor={colors.textSecondary}
            selectedDescriptionColor={colors.selectionFg}
          />
        )}
      </box>
      <Hint hints={HINTS} />
    </box>
  );
}
