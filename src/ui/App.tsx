import { useCallback, useState } from "react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { FlowList } from "./FlowList";
import { FlowEditor } from "./FlowEditor";
import { RunParamsForm } from "./RunParamsForm";
import { RunScreen } from "./RunScreen";
import { RunHistory } from "./RunHistory";
import { RunDetail } from "./RunDetail";
import { ConfirmDelete } from "./ConfirmDelete";
import { SettingsScreen } from "./SettingsScreen";
import { isAttached } from "./attach-state";
import { getActiveRun } from "../core/runManager";
import { getFlow } from "../core/storage";

export type Screen =
  | { name: "list" }
  | { name: "edit"; flowId?: string }
  | { name: "run-params"; flowId: string }
  // `runId` absent = start a fresh run using `params`; present = attach to
  // an existing (in-progress or just-finished) run instead.
  | { name: "run"; flowId: string; runId?: string; params?: Record<string, string> }
  | { name: "history"; flowId: string }
  | { name: "run-detail"; flowId: string; runId: string }
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
          onResume={(flowId, runId) => setScreen({ name: "run", flowId, runId })}
          onNew={() => setScreen({ name: "edit" })}
          onEdit={(flowId) => setScreen({ name: "edit", flowId })}
          onHistory={(flowId) => setScreen({ name: "history", flowId })}
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
      return (
        <RunScreen flowId={screen.flowId} runId={screen.runId} params={screen.params} onExit={goList} />
      );
    case "history": {
      const flowId = screen.flowId;
      const flowName = getFlow(flowId)?.name ?? flowId;
      return (
        <RunHistory
          flowId={flowId}
          flowName={flowName}
          onSelectRun={(runId) => {
            if (getActiveRun(runId)) setScreen({ name: "run", flowId, runId });
            else setScreen({ name: "run-detail", flowId, runId });
          }}
          onBack={() => setScreen({ name: "list" })}
        />
      );
    }
    case "run-detail":
      return (
        <RunDetail
          flowId={screen.flowId}
          runId={screen.runId}
          onBack={() => setScreen({ name: "history", flowId: screen.flowId })}
        />
      );
    case "settings":
      return <SettingsScreen onDone={goList} onCancel={() => setScreen({ name: "list" })} />;
  }
}
