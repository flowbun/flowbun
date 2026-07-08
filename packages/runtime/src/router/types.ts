import type { AnyBlockDef, StateScope } from "../block";

export interface Envelope {
  seq: number;
  traceId: string;
  causationSeq: number | null;
  emittedAt: number;
}

export interface QueuedDelivery {
  nodeId: string;
  port: string;
  payload: unknown;
  envelope: Envelope;
}

export interface LoadedNode {
  nodeId: string;
  block: AnyBlockDef;
  blockSpecifier: string;
  blockModulePath: string;
  config: unknown;
  blockState: StateScope;
  /** See router.ts's deliver() — a disabled node is loaded (state, config,
   * everything) but never executed, and never subscribed for @hass/trigger. */
  disabled: boolean;
}

export interface LoadedFlow {
  name: string;
  nodes: Map<string, LoadedNode>;
  /** key: "srcNodeId.srcPort" -> destinations */
  wireIndex: Map<string, Array<{ nodeId: string; port: string }>>;
  flowState: StateScope;
  globalState: StateScope;
}
