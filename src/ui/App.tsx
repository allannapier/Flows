import { useCallback, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { FlowList } from "./FlowList";
import { FlowEditor } from "./FlowEditor";
import { RunParamsForm } from "./RunParamsForm";
import { RunScreen } from "./RunScreen";
import { ConfirmDelete } from "./ConfirmDelete";
import { SettingsScreen } from "./SettingsScreen";
import { isAttached } from "./attach-state";

export type Screen =
  | { name: "list" }
  | { name: "edit"; flowId?: string }
  | { name: "run-params"; flowId: string }
  | { name: "run"; flowId: string; params: Record<string, string> }
  | { name: "confirm-delete"; flowId: string }
  | { name: "settings" };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "list" });
  // Bumped whenever we return to the list so FlowList re-reads storage.
  const [listKey, setListKey] = useState(0);
  const renderer = useRenderer();

  const goList = useCallback(() => {
    setListKey((k) => k + 1);
    setScreen({ name: "list" });
  }, []);

  // Global ctrl+c quit, restoring the behavior the renderer's own
  // exitOnCtrlC used to provide (now disabled in index.tsx because it
  // ignores preventDefault). Suppressed while attached to an agent PTY, so
  // ctrl+c reaches the agent instead of quitting Flows.
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c" && !isAttached()) {
      try {
        renderer.destroy();
      } catch {
        // best effort cleanup
      }
      process.exit(0);
    }
  });

  switch (screen.name) {
    case "list":
      return (
        <FlowList
          key={listKey}
          onRun={(flowId) => setScreen({ name: "run-params", flowId })}
          onNew={() => setScreen({ name: "edit" })}
          onEdit={(flowId) => setScreen({ name: "edit", flowId })}
          onDelete={(flowId) => setScreen({ name: "confirm-delete", flowId })}
          onSettings={() => setScreen({ name: "settings" })}
        />
      );
    case "edit":
      return <FlowEditor flowId={screen.flowId} onDone={goList} onCancel={goList} />;
    case "confirm-delete":
      return (
        <ConfirmDelete
          flowId={screen.flowId}
          onDone={goList}
          onCancel={() => setScreen({ name: "list" })}
        />
      );
    case "run-params": {
      const flowId = screen.flowId;
      return (
        <RunParamsForm
          flowId={flowId}
          onStart={(params) => setScreen({ name: "run", flowId, params })}
          onCancel={() => setScreen({ name: "list" })}
        />
      );
    }
    case "run":
      return <RunScreen flowId={screen.flowId} params={screen.params} onExit={goList} />;
    case "settings":
      return <SettingsScreen onDone={goList} onCancel={() => setScreen({ name: "list" })} />;
  }
}
