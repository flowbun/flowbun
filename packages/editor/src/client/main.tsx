import "@xyflow/react/dist/style.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/shared/ErrorBoundary";

// "ResizeObserver loop completed with undelivered notifications." is a
// known-benign browser quirk, not a real error: it fires whenever a
// ResizeObserver callback itself causes another resize within the same
// animation frame, which the spec caps at one extra retry before logging
// this instead of just silently deferring to the next frame. Two distinct
// triggers seen in this app: dragging a resizeable pane (see
// useResizablePane, already throttled to one state update per frame at
// that call site) and switching between flows with very different node
// counts — React Flow keeps its own internal ResizeObserver on the canvas
// container and per-node elements, mounting/unmounting a batch of them at
// once on a flow switch, which is out of this app's own code to throttle.
// Patching the constructor globally, rather than chasing each call site,
// fixes the root cause everywhere at once: every observer on the page
// (this app's own, React Flow's, any future one) gets its callback
// deferred to the next frame, which is exactly the "defer instead of
// warn" behavior the spec already falls back to when it isn't racing
// itself within a single frame. A standard, widely-used workaround for
// this exact warning (e.g. cited against react-virtualized, AntD,
// Chart.js) — imperceptible to users, since a one-frame-later resize
// reaction is still well under 16ms.
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class ThrottledResizeObserver extends (
  NativeResizeObserver
) {
  constructor(callback: ResizeObserverCallback) {
    super((entries, observer) => {
      requestAnimationFrame(() => callback(entries, observer));
    });
  }
};

// Backstop for whatever residual case still slips through the above (e.g.
// a resize that happens to land right at a frame boundary) — this is the
// same class of known-benign message, just not the primary fix anymore.
window.addEventListener("error", (e) => {
  if (
    e.message ===
    "ResizeObserver loop completed with undelivered notifications."
  ) {
    e.stopImmediatePropagation();
  }
});

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");
createRoot(container).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
