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
  /** Which input port's message triggered this invocation — see the note below. */
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
  // `void` here is load-bearing, not stylistic: a block's `process` typically
  // has no explicit return-type annotation, so a body that only ever falls
  // through / bare-`return`s (see hass/action.ts) gets inferred as
  // `Promise<void>` — and `Promise<void>` is NOT assignable to
  // `Promise<Partial<Outputs> | undefined>` (void's assignability is
  // one-directional). Swapping this to `undefined` breaks the typecheck gate
  // for exactly the blocks that don't emit on every path — verified by
  // actually running the gate, not just by reasoning about it.
  process(
    inputs: Inputs,
    ctx: BlockContext<Config>,
    // biome-ignore lint/suspicious/noConfusingVoidType: intentional, see comment above
  ): Promise<Partial<Outputs> | void>;
  /**
   * Optional — only source-style blocks with a live external subscription
   * need it (today, just @hass/trigger). Called once, during a Worker's
   * `init` (see flow-host/src/worker-entry.ts), before any `exec` message
   * can arrive; `emit` pushes a value out an output port at any later time,
   * independent of `process()`/the request-response `exec` cycle — the
   * returned unsubscribe function is called once, at `terminate`. A block
   * with a `subscribe` still declares `inputs: {}` and a no-op `process()`
   * for the same reason @hass/trigger's own no-op process() already exists:
   * so the type machinery (InputsOf/OutputsOf, the typecheck generator)
   * treats it uniformly with every other block.
   */
  subscribe?(
    ctx: BlockContext<Config>,
    emit: (port: keyof Outputs & string, payload: unknown) => void,
  ): Promise<() => void>;
}

/**
 * `inputs`/`outputs` are phantom-typed: authors write `{} as Shape`, and the
 * value is never read at runtime, only its type. The router only ever
 * populates the ONE port whose message just triggered this call — every
 * other declared port is `undefined` at runtime despite the type looking
 * complete. This holds for every block in this codebase because they all
 * declare exactly one input port; a block that declares more than one must
 * branch on `ctx.port` before touching any port it wasn't told just fired.
 * See router/router.ts for the delivery semantics this relies on.
 */
export function defineBlock<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
>(def: BlockDef<Config, Inputs, Outputs>): BlockDef<Config, Inputs, Outputs> {
  return def;
}

// biome-ignore lint/suspicious/noExplicitAny: intentionally erased for use as a generic constraint
export type AnyBlockDef = BlockDef<any, any, any>;
export type InputsOf<B extends AnyBlockDef> =
  B extends BlockDef<infer _C, infer I, infer _O> ? I : never;
export type OutputsOf<B extends AnyBlockDef> =
  B extends BlockDef<infer _C, infer _I, infer O> ? O : never;
