import { useEffect, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import type { SelectOption } from "@opentui/core";
import { listFlows } from "../core/storage";
import type { Flow } from "../types";
import { colors, Hint } from "./theme";

export function FlowList({
  onRun,
  onNew,
  onEdit,
  onDelete,
}: {
  onRun: (flowId: string) => void;
  onNew: () => void;
  onEdit: (flowId: string) => void;
  onDelete: (flowId: string) => void;
}) {
  const [flows, setFlows] = useState<Flow[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const renderer = useRenderer();

  useEffect(() => {
    setFlows(listFlows());
  }, []);

  useKeyboard((key) => {
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
    } else if (key.name === "d") {
      const f = flows[selectedIndex];
      if (f) onDelete(f.id);
    } else if (key.name === "return") {
      const f = flows[selectedIndex];
      if (f) onRun(f.id);
    }
  });

  const options: SelectOption[] = flows.map((f) => ({
    name: f.name || "(untitled flow)",
    description: `${f.description || "No description"}  ·  ${f.steps.length} step${f.steps.length === 1 ? "" : "s"}`,
    value: f.id,
  }));

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <ascii-font text="FLOWS" font="tiny" color={colors.accent} />
        <text fg={colors.textMuted}>Run multi-step agent workflows</text>
      </box>
      <box
        flexGrow={1}
        border
        borderStyle="rounded"
        borderColor={colors.dim}
        focusedBorderColor={colors.accent}
        title="Flows"
        margin={1}
        padding={1}
      >
        {flows.length === 0 ? (
          <text fg={colors.dim}>No flows yet. Press n to create one.</text>
        ) : (
          <select
            focused
            options={options}
            selectedIndex={selectedIndex}
            onChange={(index) => setSelectedIndex(index)}
            onSelect={(_index, option) => {
              if (option) onRun(option.value as string);
            }}
            selectedTextColor={colors.accent}
            descriptionColor={colors.dim}
          />
        )}
      </box>
      <Hint>enter run · n new · e edit · d delete · q quit</Hint>
    </box>
  );
}
