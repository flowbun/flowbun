import { generateRequestId } from "../../lib/requestId";
import { navigate } from "../../lib/route";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { CreateResourceDialog } from "../shared/CreateResourceDialog";

export function NewFlowDialog({ onClose }: { onClose: () => void }) {
  const { send } = useFlowbunSocket();

  return (
    <CreateResourceDialog
      title="New flow"
      label="Flow name"
      placeholder="e.g. Kitchen Lights"
      previewSuffix=".json"
      ariaLabel="Create new flow"
      onClose={onClose}
      onCreate={async (name) => {
        const r = await send({
          type: "flow.create",
          requestId: generateRequestId(),
          name,
        });
        if (r.type !== "flow.createResult") {
          return { ok: false, error: "unexpected response from server" };
        }
        if (r.ok) navigate(r.file, null);
        return r;
      }}
    />
  );
}
