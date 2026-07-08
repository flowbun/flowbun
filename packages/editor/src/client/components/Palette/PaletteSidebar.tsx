import type { BlockPaletteEntry } from "flowbun/ws";

export function PaletteSidebar({
  palette,
  onOpenBlockEditor,
  onAddBlock,
  onCloseMobile,
}: {
  palette: BlockPaletteEntry[];
  onOpenBlockEditor: (file: string) => void;
  /** Provided on mobile only — native HTML5 drag doesn't fire from touch. */
  onAddBlock?: (blockName: string) => void;
  /** Provided on mobile only — renders a close button for the drawer. */
  onCloseMobile?: () => void;
}) {
  return (
    <div className="palette-sidebar">
      <div className="palette-sidebar-header">
        <h3>Blocks</h3>
        {onCloseMobile && (
          <button
            type="button"
            className="palette-close"
            onClick={onCloseMobile}
            aria-label="Close blocks panel"
          >
            ✕
          </button>
        )}
      </div>
      {palette.map((entry) => {
        const file = entry.file;
        return (
          <div key={entry.name} className="palette-entry">
            <button
              type="button"
              className="palette-entry-main"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/flowbun-block", entry.name);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAddBlock?.(entry.name)}
              onDoubleClick={() => {
                if (file) onOpenBlockEditor(file);
              }}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && file) {
                  e.preventDefault();
                  onOpenBlockEditor(file);
                }
              }}
              title={
                onAddBlock
                  ? "Tap to add to canvas"
                  : file
                    ? "Double-click (or Enter) to edit source. Drag onto the canvas to add."
                    : "Built-in block"
              }
            >
              <div className="name">{entry.name}</div>
              <div className="ports">
                in: {Object.keys(entry.inputs).join(", ") || "—"}
                <br />
                out: {Object.keys(entry.outputs).join(", ") || "—"}
              </div>
            </button>
            {file && (
              <button
                type="button"
                className="palette-entry-edit"
                onClick={() => onOpenBlockEditor(file)}
                title="Edit source"
                aria-label={`Edit ${entry.name} source`}
              >
                ✎
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
