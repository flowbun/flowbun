import { createContext, useContext } from "react";

/** Keyed by nodeId only (already scoped to the active flow by FlowCanvas) —
 * a plain context rather than node.data so BlockNode picks up new
 * timestamps without going through the wiring-driven node reset in
 * FlowCanvas's sync effect (which would otherwise clobber in-progress
 * drag/selection state on every incoming log). */
const LastProcessedContext = createContext<Map<string, number>>(new Map());

export const LastProcessedProvider = LastProcessedContext.Provider;

export function useLastProcessed(nodeId: string): number | undefined {
  return useContext(LastProcessedContext).get(nodeId);
}
