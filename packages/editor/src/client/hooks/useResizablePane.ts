import { type RefObject, useCallback, useRef, useState } from "react";

const KEYBOARD_STEP = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export interface ResizablePane {
  /** `undefined` until either localStorage has a value or the user has
   * actually resized once — the caller should only apply an explicit
   * width/height style when this is defined, leaving the pane at its
   * normal CSS-driven size otherwise (avoids having to guess a numeric
   * default that matches what the stylesheet would've produced, e.g. the
   * header bar's natural content height). */
  size: number | undefined;
  min: number;
  max: number;
  startResize: (e: React.PointerEvent) => void;
  /** Keyboard resizing (ResizeHandle's arrow-key handler) — a discrete
   * step, persisted immediately rather than waiting for a drag-end. */
  adjustBy: (delta: number) => void;
}

/**
 * Drag-to-resize for a single pane, persisted to localStorage so the size
 * survives a reload.
 *
 * `paneRef` supplies the pane's *current* rendered size as the drag's
 * starting point (via offsetWidth/offsetHeight) rather than trusting
 * whatever `size` state happens to hold — correct on the very first drag
 * even when `size` is still undefined.
 */
export function useResizablePane(
  storageKey: string,
  paneRef: RefObject<HTMLElement | null>,
  {
    axis,
    min,
    max,
    invert = false,
  }: { axis: "x" | "y"; min: number; max: number; invert?: boolean },
): ResizablePane {
  const [size, setSize] = useState<number | undefined>(() => {
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored ? Number(stored) : Number.NaN;
    return Number.isFinite(parsed) ? clamp(parsed, min, max) : undefined;
  });
  // Avoids re-subscribing move/up listeners (and re-running this callback's
  // own identity) on every size change during a drag.
  const latestRef = useRef(size);

  const currentSize = useCallback(
    (): number =>
      latestRef.current ??
      (axis === "x"
        ? paneRef.current?.offsetWidth
        : paneRef.current?.offsetHeight) ??
      min,
    [axis, min, paneRef],
  );

  const startResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startCoord = axis === "x" ? e.clientX : e.clientY;
      const startSize = currentSize();
      const cursor = axis === "x" ? "col-resize" : "row-resize";
      const prevCursor = document.body.style.cursor;
      const prevUserSelect = document.body.style.userSelect;
      document.body.style.cursor = cursor;
      document.body.style.userSelect = "none";

      // Coalesced to at most one state update per animation frame — a
      // pane resizing changes the canvas area's size too, which React Flow
      // watches via its own ResizeObserver; committing a raw pointermove's
      // worth of updates synchronously (pointermove can fire well faster
      // than 60/sec) piles up more resize-observe-layout cycles than a
      // single frame can deliver, which is exactly what triggers the
      // (otherwise benign) "ResizeObserver loop completed with undelivered
      // notifications" warning — and in this project's dev server, that
      // warning surfaces as a fullscreen blocking error overlay, not just
      // console noise. One update per frame is what a drag should look
      // like on screen anyway; nothing is lost by not committing faster
      // than the display can show it.
      let pendingCoord = startCoord;
      let rafId: number | null = null;
      function commit() {
        rafId = null;
        const delta = (pendingCoord - startCoord) * (invert ? -1 : 1);
        const next = clamp(startSize + delta, min, max);
        latestRef.current = next;
        setSize(next);
      }
      function onMove(ev: PointerEvent) {
        pendingCoord = axis === "x" ? ev.clientX : ev.clientY;
        if (rafId === null) rafId = requestAnimationFrame(commit);
      }
      function onUp() {
        if (rafId !== null) cancelAnimationFrame(rafId);
        commit(); // the pointer's final position always lands, even mid-frame
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = prevCursor;
        document.body.style.userSelect = prevUserSelect;
        if (latestRef.current !== undefined) {
          window.localStorage.setItem(storageKey, String(latestRef.current));
        }
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [axis, min, max, invert, storageKey, currentSize],
  );

  const adjustBy = useCallback(
    (delta: number) => {
      const next = clamp(currentSize() + delta, min, max);
      latestRef.current = next;
      setSize(next);
      window.localStorage.setItem(storageKey, String(next));
    },
    [min, max, storageKey, currentSize],
  );

  return { size, min, max, startResize, adjustBy };
}

export { KEYBOARD_STEP };
