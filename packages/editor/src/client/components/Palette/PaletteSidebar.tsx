import type { BlockPaletteEntry } from "flowbun/ws";

export function PaletteSidebar({
  palette,
  onOpenBlockEditor,
}: {
  palette: BlockPaletteEntry[];
  onOpenBlockEditor: (file: string) => void;
}) {
  return (
    <div className="palette-sidebar">
      <h3>Blocks</h3>
      {palette.map((entry) => (
        <button
          key={entry.name}
          type="button"
          className="palette-entry"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("application/flowbun-block", entry.name);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDoubleClick={() => {
            if (entry.file) onOpenBlockEditor(entry.file);
          }}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === " ") && entry.file) {
              e.preventDefault();
              onOpenBlockEditor(entry.file);
            }
          }}
          title={
            entry.file
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
      ))}
    </div>
  );
}
