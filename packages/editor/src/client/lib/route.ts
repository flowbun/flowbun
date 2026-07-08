import { useSyncExternalStore } from "react";

export interface Route {
  file: string | null;
  nodeId: string | null;
}

/**
 * Path-based, hierarchical URLs: /flow/<file> and, optionally,
 * /flow/<file>/node/<nodeId>. Purely client-side — the server has no idea
 * what a "flow" is (see server.ts's "/*" SPA fallback); this module is the
 * only place that parses or builds these paths, so the two stay in sync.
 */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "flow" || !parts[1]) return { file: null, nodeId: null };
  const file = decodeURIComponent(parts[1]);
  const nodeId =
    parts[2] === "node" && parts[3] ? decodeURIComponent(parts[3]) : null;
  return { file, nodeId };
}

export function buildPath(file: string | null, nodeId: string | null): string {
  if (!file) return "/";
  const base = `/flow/${encodeURIComponent(file)}`;
  return nodeId ? `${base}/node/${encodeURIComponent(nodeId)}` : base;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

function getSnapshot(): string {
  return window.location.pathname;
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, getSnapshot);
  return parseRoute(pathname);
}

/**
 * pushState/replaceState don't fire "popstate" themselves — only the
 * browser's own back/forward does — so useRoute (via useSyncExternalStore)
 * would never notice a programmatic navigation without this manual dispatch.
 */
export function navigate(
  file: string | null,
  nodeId: string | null,
  options?: { replace?: boolean },
): void {
  const path = buildPath(file, nodeId);
  if (path === window.location.pathname) return;
  if (options?.replace) {
    history.replaceState(null, "", path);
  } else {
    history.pushState(null, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}
