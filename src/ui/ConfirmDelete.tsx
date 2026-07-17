import { useKeyboard } from "@opentui/react";
import { getFlow, deleteFlow } from "../core/storage";
import { colors, Hint } from "./theme";

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
    if (key.name === "y") {
      deleteFlow(flowId);
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
        <text fg={colors.text}>
          Delete flow "{flow ? flow.name : flowId}"?
        </text>
        <text fg={colors.dim}>This cannot be undone.</text>
        <text fg={colors.warning}>y / N</text>
      </box>
      <Hint>y confirm · n/esc cancel</Hint>
    </box>
  );
}
