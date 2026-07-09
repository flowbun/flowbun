import { generateRequestId } from "../../lib/requestId";
import { useFlowbunSocket } from "../../ws/FlowbunSocketContext";
import { CreateResourceDialog } from "../shared/CreateResourceDialog";

export function NewBlockDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Called with the new block's filename so the caller can open it
   * straight in the Monaco editor for immediate customization. */
  onCreated: (file: string) => void;
}) {
  const { send } = useFlowbunSocket();

  return (
    <CreateResourceDialog
      title="New block"
      label="Block name"
      placeholder="e.g. Temperature Converter"
      previewSuffix=".ts"
      ariaLabel="Create new block"
      onClose={onClose}
      onCreate={async (name) => {
        const r = await send({
          type: "block.create",
          requestId: generateRequestId(),
          name,
        });
        if (r.type !== "block.createResult") {
          return { ok: false, error: "unexpected response from server" };
        }
        if (r.ok) onCreated(r.file);
        return r;
      }}
    />
  );
}
