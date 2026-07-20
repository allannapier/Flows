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
import { FilePrompt } from "./FilePrompt";
import { isAttached } from "./attach-state";
import { getActiveRun } from "../core/runManager";
import { getFlow, exportFlow, importFlow, slugifyFlowName } from "../core/storage";

export type Screen =
  | { name: "list" }
  | { name: "edit"; flowId?: string }
  | { name: "run-params"; flowId: string; initialParams?: Record<string, string> }
  // `runId` absent = start a fresh run using `params`; present = attach to
  // an existing (in-progress or just-finished) run instead.
  | { name: "run"; flowId: string; runId?: string; params?: Record<string, string> }
  | { name: "history"; flowId: string }
  | { name: "run-detail"; flowId: string; runId: string }
  | { name: "confirm-delete"; flowId: string }
  | { name: "settings" }
  | { name: "export-flow"; flowId: string }
  | { name: "import-flow" };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "list" });
  // Bumped whenever we return to the list so FlowList re-reads storage.
  const [listKey, setListKey] = useState(0);
  // Transient message shown once by FlowList after remounting (export/import
  // outcome) — cleared on every plain goList() so it doesn't resurface later.
  const [listStatus, setListStatus] = useState<string | undefined>(undefined);
  const renderer = useRenderer();

  const goList = useCallback(() => {
    setListKey((k) => k + 1);
    setListStatus(undefined);
    setScreen({ name: "list" });
  }, []);

  const goListWithStatus = useCallback((status: string) => {
    setListKey((k) => k + 1);
    setListStatus(status);
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
          initialStatus={listStatus}
          onRun={(flowId) => setScreen({ name: "run-params", flowId })}
          onResume={(flowId, runId) => setScreen({ name: "run", flowId, runId })}
          onNew={() => setScreen({ name: "edit" })}
          onEdit={(flowId) => setScreen({ name: "edit", flowId })}
          onHistory={(flowId) => setScreen({ name: "history", flowId })}
          onDelete={(flowId) => setScreen({ name: "confirm-delete", flowId })}
          onSettings={() => setScreen({ name: "settings" })}
          onExport={(flowId) => setScreen({ name: "export-flow", flowId })}
          onImport={() => setScreen({ name: "import-flow" })}
        />
      );
    case "edit":
      return (
        <FlowEditor
          flowId={screen.flowId}
          onDone={(status) => (status ? goListWithStatus(status) : goList())}
          onCancel={goList}
        />
      );
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
          initialParams={screen.initialParams}
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
          onRerun={(params) => setScreen({ name: "run-params", flowId, initialParams: params })}
          onBack={() => setScreen({ name: "list" })}
        />
      );
    }
    case "run-detail":
      return (
        <RunDetail
          flowId={screen.flowId}
          runId={screen.runId}
          onRerun={(params) => setScreen({ name: "run-params", flowId: screen.flowId, initialParams: params })}
          onBack={() => setScreen({ name: "history", flowId: screen.flowId })}
        />
      );
    case "settings":
      return <SettingsScreen onDone={goList} onCancel={() => setScreen({ name: "list" })} />;
    case "export-flow": {
      const flowId = screen.flowId;
      const flow = getFlow(flowId);
      const defaultPath = `./${slugifyFlowName(flow?.name ?? "flow")}.flow.json`;
      return (
        <FilePrompt
          title="Export flow"
          label={`Destination path for "${flow?.name ?? flowId}"`}
          initialValue={defaultPath}
          onSubmit={(value) => {
            if (!value.trim()) return "Enter a destination path";
            try {
              const resolved = exportFlow(flowId, value.trim());
              goListWithStatus(`Exported to ${resolved}`);
              return undefined;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }}
          onCancel={() => setScreen({ name: "list" })}
        />
      );
    }
    case "import-flow":
      return (
        <FilePrompt
          title="Import flow"
          label="Source path"
          initialValue=""
          onSubmit={(value) => {
            if (!value.trim()) return "Enter a source path";
            try {
              const flow = importFlow(value.trim());
              goListWithStatus(`Imported "${flow.name}"`);
              return undefined;
            } catch (err) {
              return err instanceof Error ? err.message : String(err);
            }
          }}
          onCancel={() => setScreen({ name: "list" })}
        />
      );
  }
}
