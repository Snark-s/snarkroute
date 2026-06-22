import { Play } from "lucide-react";

export function RouteNodeRunActions({
  nodeId,
  canRunNodeOnly,
  onRunNodeOnly,
  onRunNodeWithDependencies
}: {
  nodeId: string;
  canRunNodeOnly: boolean;
  onRunNodeOnly?: (nodeId: string) => void;
  onRunNodeWithDependencies?: (nodeId: string) => void;
}) {
  return (
    <div className="nodeRunActions">
      <button
        className="nodeRunButton nodrag nopan"
        type="button"
        title={canRunNodeOnly ? "Run this node only" : "Run this node only after all inputs have ready outputs"}
        disabled={!canRunNodeOnly}
        onClick={(event) => {
          event.stopPropagation();
          onRunNodeOnly?.(nodeId);
        }}
      >
        <Play size={12} />
      </button>
      <button
        className="nodeRunButton dependency nodrag nopan"
        type="button"
        title="Run this node with upstream dependencies"
        onClick={(event) => {
          event.stopPropagation();
          onRunNodeWithDependencies?.(nodeId);
        }}
      >
        <span className="nodeRunDoubleArrow">&gt;&gt;</span>
      </button>
    </div>
  );
}
