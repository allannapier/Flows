import { useCallback, useState } from "react";
import { FlowList } from "./FlowList";
import { FlowEditor } from "./FlowEditor";
import { RunParamsForm } from "./RunParamsForm";
import { RunScreen } from "./RunScreen";
import { ConfirmDelete } from "./ConfirmDelete";

export type Screen =
  | { name: "list" }
  | { name: "edit"; flowId?: string }
  | { name: "run-params"; flowId: string }
  | { name: "run"; flowId: string; params: Record<string, string> }
  | { name: "confirm-delete"; flowId: string };

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: "list" });
  // Bumped whenever we return to the list so FlowList re-reads storage.
  const [listKey, setListKey] = useState(0);

  const goList = useCallback(() => {
    setListKey((k) => k + 1);
    setScreen({ name: "list" });
  }, []);

  switch (screen.name) {
    case "list":
      return (
        <FlowList
          key={listKey}
          onRun={(flowId) => setScreen({ name: "run-params", flowId })}
          onNew={() => setScreen({ name: "edit" })}
          onEdit={(flowId) => setScreen({ name: "edit", flowId })}
          onDelete={(flowId) => setScreen({ name: "confirm-delete", flowId })}
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
  }
}
