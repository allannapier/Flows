import { useKeyboard } from "@opentui/react";
import { TextAttributes } from "@opentui/core";
import { getFlow, deleteFlow } from "../core/storage";
import { deleteRunsForFlow } from "../core/runStore";
import { colors, Hint, Button } from "./theme";

const HINTS = [
  { keys: "y", label: "confirm" },
  { keys: "n/esc", label: "cancel" },
];

export function ConfirmDelete({
  flowId,
  onDone,
  onCancel,
}: {
  flowId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const flow = getFlow(flowId);

  useKeyboard((key) => {
    if (key.ctrl || key.meta) return;
    if (key.name === "y") {
      deleteFlow(flowId);
      deleteRunsForFlow(flowId);
      onDone();
    } else if (key.name === "n" || key.name === "escape") {
      onCancel();
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={colors.bg} justifyContent="center" alignItems="center">
      <box
        border
        borderStyle="rounded"
        borderColor={colors.error}
        title="Delete flow"
        padding={2}
        flexDirection="column"
        gap={1}
      >
        <text>
          <span fg={colors.textSecondary}>Delete flow "</span>
          <span fg={colors.textPrimary} attributes={TextAttributes.BOLD}>
            {flow ? flow.name : flowId}
          </span>
          <span fg={colors.textSecondary}>"?</span>
        </text>
        <text fg={colors.textSecondary}>This cannot be undone.</text>
        <box flexDirection="row" gap={2}>
          <Button label="y delete" selected color={colors.error} />
          <Button label="N cancel" selected={false} />
        </box>
      </box>
      <Hint hints={HINTS} />
    </box>
  );
}
