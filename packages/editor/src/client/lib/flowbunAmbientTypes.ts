/**
 * Monaco's TypeScript worker runs in the browser with no access to the real
 * `node_modules`/workspace resolution the server-side typecheck gate uses —
 * without this, it flags every `import ... from "flowbun"` (or one of its
 * subpaths) in a block file as unresolvable ("Cannot find module"), even
 * though the real `tsc` run (shown after Save) resolves it fine. This is a
 * hand-maintained mirror of every subpath a block file is allowed to import
 * from directly — bare `flowbun` (block.ts's defineBlock surface) plus
 * every `flowbun/hass/*`/`flowbun/core/*` subpath the server-side typecheck
 * gate's own generated tsconfig recognizes (see
 * packages/runtime/src/typecheck/run.ts's `paths`) — purely so Monaco's
 * live squiggles stop lying. It is NOT the source of truth: the server-side
 * typecheck on save is, and always wins.
 *
 * Started out covering only bare "flowbun" on the assumption that was the
 * only thing a block ever imported; battery_controller.ts and
 * meter_compare.ts importing `flowbun/hass/client`/`flowbun/hass/action`
 * directly (to read live HA state and call HA services from inside a
 * regular block, not just through @hass/trigger/@hass/action) proved that
 * assumption wrong, so every recognized subpath is covered now instead of
 * patching this one omission at a time.
 */
export const FLOWBUN_AMBIENT_TYPES = `
declare module "flowbun" {
  export type PortShape = object;

  export interface StateScope {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  }

  export interface Logger {
    debug(msg: string, meta?: Record<string, unknown>): void;
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  }

  export interface BlockContext<Config = unknown> {
    config: Config;
    state: { block: StateScope; flow: StateScope; global: StateScope };
    log: Logger;
    traceId: string;
    seq: number;
    port: string;
  }

  export interface BlockDef<
    Config,
    Inputs extends PortShape,
    Outputs extends PortShape,
  > {
    name: string;
    config: Config;
    inputs: Inputs;
    outputs: Outputs;
    process(
      inputs: Inputs,
      ctx: BlockContext<Config>,
    ): Promise<Partial<Outputs> | void>;
  }

  export function defineBlock<
    Config,
    Inputs extends PortShape,
    Outputs extends PortShape,
  >(
    def: BlockDef<Config, Inputs, Outputs>,
  ): BlockDef<Config, Inputs, Outputs>;

  export type AnyBlockDef = BlockDef<any, any, any>;
  export type InputsOf<B extends AnyBlockDef> =
    B extends BlockDef<any, infer I, any> ? I : never;
  export type OutputsOf<B extends AnyBlockDef> =
    B extends BlockDef<any, any, infer O> ? O : never;
}

declare module "flowbun/hass/client" {
  export interface SimpleEntityState {
    state: string;
    last_updated: string;
    attributes: Record<string, unknown>;
  }

  export interface SimpleEntityRef {
    onUpdate(
      cb: (newState: SimpleEntityState, oldState: SimpleEntityState) => void,
    ): () => void;
  }

  export interface SimpleHass {
    refBy: { id(entityId: string): SimpleEntityRef };
    call: Record<
      string,
      Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
    >;
    entity: {
      listEntities(): string[];
      getCurrentState(entityId: string): SimpleEntityState | undefined;
    };
  }

  export interface HassEntitySummary {
    id: string;
    friendlyName?: string;
  }

  export interface EntityStateReading {
    entity: string;
    state: string;
    attributes: Record<string, unknown>;
  }

  export function getHass(): Promise<SimpleHass>;
  export function listHassEntities(): Promise<HassEntitySummary[]>;
  export function readEntityState(
    entityId: string,
  ): Promise<EntityStateReading | undefined>;
  export function isDryRun(): boolean;
}

declare module "flowbun/hass/action" {
  export interface ActionCall {
    domain: string;
    service: string;
    target?: { entity_id: string | string[] };
    data?: Record<string, unknown>;
  }

  export interface ActionConfig {
    target?: { entity_id: string | string[] };
    dryRun?: boolean;
  }

  export function performHassAction(
    call: ActionCall,
    dryRun: boolean,
  ): Promise<void>;
}

declare module "flowbun/hass/trigger" {
  export interface TriggerConfig {
    entity: string;
  }

  export interface TriggerOutputs {
    changed: {
      entity: string;
      state: string;
      previous: string | null;
      at: number;
    };
  }

  export function registerHassTrigger(
    config: TriggerConfig,
    onChange: (payload: TriggerOutputs["changed"]) => void,
  ): Promise<() => void>;
}

declare module "flowbun/hass/read" {
  import type { EntityStateReading } from "flowbun/hass/client";

  export interface ReadConfig {
    entity: string;
  }

  export function performHassRead(entity: string): Promise<EntityStateReading>;
}

declare module "flowbun/core/scheduler" {
  export interface SchedulerConfig {
    mode: "interval" | "dailyTime" | "sunRelative";
    /** mode: "interval" */
    intervalMs?: number;
    /** mode: "dailyTime", 24h local time "HH:MM" */
    time?: string;
    /** mode: "dailyTime", local days-of-week the schedule may fire on (0=Sunday..6=Saturday, matching Date.getDay()); omitted means every day */
    weekdays?: number[];
    /** mode: "sunRelative" */
    event?: "sunrise" | "sunset";
    /** mode: "sunRelative", minutes added to the event time (may be negative) */
    offsetMinutes?: number;
    /** mode: "sunRelative" */
    latitude?: number;
    /** mode: "sunRelative" */
    longitude?: number;
  }

  export interface SchedulerOutputs {
    fired: { at: number };
  }

  export function nextDailyTime(
    time: string,
    now: Date,
    weekdays?: number[],
  ): Date;
  export function nextSunRelative(
    event: "sunrise" | "sunset",
    offsetMinutes: number,
    latitude: number,
    longitude: number,
    now: Date,
  ): Date;
  export function nextFireTime(config: SchedulerConfig, now: Date): Date;
  export function registerScheduler(
    config: SchedulerConfig,
    onFire: (payload: SchedulerOutputs["fired"]) => void,
  ): () => void;
}

declare module "flowbun/core/inject" {
  export interface InjectConfig {
    /** Optional custom button label/tooltip shown in the editor; falls back to "Fire" when empty. */
    label: string;
  }

  export interface InjectOutputs {
    fired: { at: number };
  }
}

declare module "flowbun/core/debug" {
  export function serializeForDebug(value: unknown): string;
}
`;
