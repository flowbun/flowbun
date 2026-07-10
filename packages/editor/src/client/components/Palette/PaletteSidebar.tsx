import type { BlockPaletteEntry } from "flowbun/ws";
import { useRef } from "react";
import { useIsMobile } from "../../hooks/useIsMobile";
import { usePersistedState } from "../../hooks/usePersistedState";
import { useResizablePane } from "../../hooks/useResizablePane";
import { ResizeHandle } from "../shared/ResizeHandle";

const MIN_WIDTH = 160;
const MAX_WIDTH = 480;
const MIN_SECTION_HEIGHT = 60;
const MAX_SECTION_HEIGHT = 600;

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

  const [coreCollapsed, setCoreCollapsed] = usePersistedState(
    "flowbun.palette.coreCollapsed",
    false,
  );
  const [addonsCollapsed, setAddonsCollapsed] = usePersistedState(
    "flowbun.palette.addonsCollapsed",
    false,
  );
  const coreSectionRef = useRef<HTMLDivElement>(null);
  const corePane = useResizablePane(
    "flowbun.palette.coreHeight",
    coreSectionRef,
    { axis: "y", min: MIN_SECTION_HEIGHT, max: MAX_SECTION_HEIGHT },
  );

  // "Core" = the built-in @hass/*/@core/* blocks — buildPalette() (see
  // ws-server.ts) only sets `file` for data/blocks/*.ts entries, so an
  // absent file is exactly the built-in/add-on split we want, with no
  // server-side change needed.
  const coreBlocks = palette.filter((e) => !e.file);
  const addonBlocks = palette.filter((e) => e.file);
  const bothExpanded = !coreCollapsed && !addonsCollapsed;

  function renderEntry(entry: BlockPaletteEntry) {
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
  }

  const coreStyle = coreCollapsed
    ? { flex: "0 0 auto" }
    : {
        flex: corePane.size !== undefined ? `0 0 ${corePane.size}px` : "1 1 0",
        minHeight: 0,
      };
  const addonsStyle = addonsCollapsed
    ? { flex: "0 0 auto" }
    : { flex: "1 1 0", minHeight: 0 };

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
      <div className="palette-sections">
        <div ref={coreSectionRef} className="palette-section" style={coreStyle}>
          <button
            type="button"
            className="palette-section-header"
            onClick={() => setCoreCollapsed((c) => !c)}
            aria-expanded={!coreCollapsed}
          >
            <span className="palette-section-chevron">
              {coreCollapsed ? "▶" : "▼"}
            </span>
            Core
            <span className="palette-section-count">({coreBlocks.length})</span>
          </button>
          {!coreCollapsed && (
            <div className="palette-section-body">
              {coreBlocks.map(renderEntry)}
            </div>
          )}
        </div>

        {!isMobile && bothExpanded && (
          <div className="palette-section-divider">
            <ResizeHandle
              orientation="horizontal"
              pane={corePane}
              label="Resize core blocks section"
            />
          </div>
        )}

        <div className="palette-section" style={addonsStyle}>
          <button
            type="button"
            className="palette-section-header"
            onClick={() => setAddonsCollapsed((c) => !c)}
            aria-expanded={!addonsCollapsed}
          >
            <span className="palette-section-chevron">
              {addonsCollapsed ? "▶" : "▼"}
            </span>
            Add-ons
            <span className="palette-section-count">
              ({addonBlocks.length})
            </span>
          </button>
          {!addonsCollapsed && (
            <div className="palette-section-body">
              {addonBlocks.map(renderEntry)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
