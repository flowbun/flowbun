import type { BlockPaletteEntry } from "flowbun/ws";
import { useRef } from "react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useResizablePane } from "../../hooks/useResizablePane";
import { ResizeHandle } from "../shared/ResizeHandle";

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;

export function PaletteSidebar({
  palette,
  onOpenBlockEditor,
  onDeleteBlock,
  onAddBlock,
  onCloseMobile,
  onNewBlock,
}: {
  palette: BlockPaletteEntry[];
  onOpenBlockEditor: (file: string) => void;
  onDeleteBlock: (file: string, name: string) => void;
  /** Provided on mobile only — native HTML5 drag doesn't fire from touch. */
  onAddBlock?: (blockName: string) => void;
  /** Provided on mobile only — renders a close button for the drawer. */
  onCloseMobile?: () => void;
  onNewBlock: () => void;
}) {
  const isMobile = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const pane = useResizablePane("flowbun.paletteWidth", ref, {
    axis: "x",
    min: MIN_WIDTH,
    max: MAX_WIDTH,
  });

  return (
    <div
      ref={ref}
      className="palette-sidebar"
      style={
        !isMobile && pane.size !== undefined ? { width: pane.size } : undefined
      }
    >
      {!isMobile && (
        <ResizeHandle
          orientation="vertical"
          pane={pane}
          label="Resize blocks panel"
        />
      )}
      <div className="palette-sidebar-header">
        <h3>Blocks</h3>
        <div className="palette-sidebar-header-actions">
          <button
            type="button"
            className="new-resource-button"
            onClick={onNewBlock}
            title="New block"
            aria-label="New block"
          >
            + Block
          </button>
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
            {file && (
              <button
                type="button"
                className="palette-entry-delete"
                onClick={() => onDeleteBlock(file, entry.name)}
                title="Delete block"
                aria-label={`Delete ${entry.name}`}
              >
                🗑
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
