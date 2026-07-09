import {
  KEYBOARD_STEP,
  type ResizablePane,
} from "../../hooks/useResizablePane";

/**
 * A thin drag strip pinned to one edge of a resizeable pane — the pane
 * itself must be `position: relative` for this to anchor correctly (it's
 * absolutely positioned). Pointer events (not mouse events) so dragging
 * works the same via touch, mouse, or pen; also focusable and arrow-key
 * adjustable (ARIA's "separator" role requires both, since — unlike a
 * plain `<hr>` — this one actually moves).
 */
export function ResizeHandle({
  orientation,
  pane,
  label,
}: {
  /** "vertical": a vertical strip you drag left/right (sidebar width).
   * "horizontal": a horizontal strip you drag up/down (panel height). */
  orientation: "vertical" | "horizontal";
  pane: ResizablePane;
  label: string;
}) {
  const growKey = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
  const shrinkKey = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> can't be dragged/focused/arrow-key-adjusted — this is a movable separator (ARIA's own distinction), not a static one.
    <div
      className={`resize-handle resize-handle-${orientation}`}
      onPointerDown={pane.startResize}
      role="separator"
      tabIndex={0}
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={pane.min}
      aria-valuemax={pane.max}
      aria-valuenow={pane.size ?? pane.min}
      onKeyDown={(e) => {
        if (e.key === growKey) {
          e.preventDefault();
          pane.adjustBy(KEYBOARD_STEP);
        } else if (e.key === shrinkKey) {
          e.preventDefault();
          pane.adjustBy(-KEYBOARD_STEP);
        }
      }}
    />
  );
}
