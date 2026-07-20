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

/**
 * The router only ever populates the ONE port whose message just triggered a
 * given process() call (see router/router.ts's deliver()) — every other
 * declared input is `undefined` at runtime. This maps `Inputs` to a union of
 * "exactly one port present, the rest undefined" shapes, so that's what
 * `process()`'s parameter type actually says, instead of the lie that every
 * port is simultaneously populated. For a block with exactly one input port
 * (the overwhelming majority in this codebase) the union has one member, so
 * this is a no-op — existing single-input blocks need no changes. A block
 * declaring more than one input port must narrow (via `ctx.port` or an
 * `!== undefined` check) before touching a port it wasn't just told fired;
 * FiringInputs is what makes skipping that narrowing a compile error instead
 * of a runtime `undefined`.
 */
export type FiringInputs<Inputs extends PortShape> = {
  [Fired in keyof Inputs]: {
    [Port in keyof Inputs]: Port extends Fired ? Inputs[Port] : undefined;
  };
}[keyof Inputs];

interface BlockDefBase<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
> {
  name: string;
  config: Config;
  inputs: Inputs;
  outputs: Outputs;
}

/** An ordinary block: fires once per message arriving at one input port, returns (or emits nothing for) the ports it produced. The default kind — `kind` may be omitted. */
export interface TransformBlockDef<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
> extends BlockDefBase<Config, Inputs, Outputs> {
  kind?: "transform";
  // `void` here is load-bearing, not stylistic: a block's `process` typically
  // has no explicit return-type annotation, so a body that only ever falls
  // through / bare-`return`s (see hass/action.ts) gets inferred as
  // `Promise<void>` — and `Promise<void>` is NOT assignable to
  // `Promise<Partial<Outputs> | undefined>` (void's assignability is
  // one-directional). Swapping this to `undefined` breaks the typecheck gate
  // for exactly the blocks that don't emit on every path — verified by
  // actually running the gate, not just by reasoning about it.
  process(
    inputs: FiringInputs<Inputs>,
    ctx: BlockContext<Config>,
    // biome-ignore lint/suspicious/noConfusingVoidType: intentional, see comment above
  ): Promise<Partial<Outputs> | void>;
}

/**
 * A source: never invoked through normal mailbox delivery (no input ever
 * fires it) — it produces output ports on its own schedule instead. Two ways
 * a source can actually emit, not mutually exclusive:
 *
 * - `subscribe`: a live, ongoing subscription. Called once, during a
 *   Worker's `init` (see flow-host/src/worker-entry.ts) for a Worker-hosted
 *   source, or directly in the flow-host's own main thread for one whose
 *   `hosted` is `"flow-host"` (see below) — before any other message can
 *   arrive either way. `emit` pushes a value out an output port at any later
 *   time, independent of any request-response cycle; the returned
 *   unsubscribe function is called once, at shutdown. Optional: a source
 *   with no `subscribe` only ever emits when externally fired (see
 *   `fireable`) — @core/inject is exactly this.
 * - `fireable`: this source can be manually fired on demand — a browser
 *   button click relayed over IPC (`flow.fireNode`), calling
 *   `router.emitFromSource()` directly rather than anything on this
 *   interface. @core/inject is the one block that sets this today; see
 *   flow-host/src/main.ts's `flow.fireNode` handler.
 *
 * `hosted: "flow-host"` marks a source that needs a capability only the
 * flow-host's own main thread has (today, just @hass/trigger: the flow's one
 * real Home Assistant connection) rather than an ordinary per-node Worker —
 * see WorkerManager's own doc comment. Omitted (the common case) means "runs
 * in a normal Worker like any other node," even though it has no inputs.
 */
export interface SourceBlockDef<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
> extends BlockDefBase<Config, Inputs, Outputs> {
  kind: "source";
  hosted?: "flow-host";
  fireable?: boolean;
  subscribe?(
    ctx: BlockContext<Config>,
    emit: (port: keyof Outputs & string, payload: unknown) => void,
  ): Promise<() => void>;
}

/**
 * A block whose real execution happens entirely outside the router/executor
 * — driven by normal wire delivery like a transform (the router still
 * enqueues and delivers to it like any other node), but `process()` is never
 * called: the executor recognizes `kind: "relay"` and dispatches elsewhere
 * instead (today, DistributedExecutor relays @ai/agent to the coordinator,
 * and onward to the dedicated ai-host process — the only place holding
 * Claude credentials). The only reason this is a distinct kind from
 * TransformBlockDef rather than just "a transform whose process() happens to
 * never run" is honesty: a relay block has no `process` to type-check
 * against at all.
 */
export interface RelayBlockDef<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
> extends BlockDefBase<Config, Inputs, Outputs> {
  kind: "relay";
}

export type BlockDef<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
> =
  | TransformBlockDef<Config, Inputs, Outputs>
  | SourceBlockDef<Config, Inputs, Outputs>
  | RelayBlockDef<Config, Inputs, Outputs>;

/**
 * `inputs`/`outputs` are phantom-typed: authors write `{} as Shape`, and the
 * value is never read at runtime, only its type. Which overload applies is
 * decided by `kind` (absent/`"transform"` vs `"source"` vs `"relay"`) — see
 * each interface's own doc comment above for what each actually means and
 * how it's invoked.
 */
export function defineBlock<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
>(
  def: TransformBlockDef<Config, Inputs, Outputs>,
): TransformBlockDef<Config, Inputs, Outputs>;
export function defineBlock<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
>(
  def: SourceBlockDef<Config, Inputs, Outputs>,
): SourceBlockDef<Config, Inputs, Outputs>;
export function defineBlock<
  Config,
  Inputs extends PortShape,
  Outputs extends PortShape,
>(
  def: RelayBlockDef<Config, Inputs, Outputs>,
): RelayBlockDef<Config, Inputs, Outputs>;
export function defineBlock(def: AnyBlockDef): AnyBlockDef {
  return def;
}

// biome-ignore lint/suspicious/noExplicitAny: intentionally erased for use as a generic constraint
export type AnyBlockDef = BlockDef<any, any, any>;
export type InputsOf<B extends AnyBlockDef> =
  B extends BlockDef<infer _C, infer I, infer _O> ? I : never;
export type OutputsOf<B extends AnyBlockDef> =
  B extends BlockDef<infer _C, infer _I, infer O> ? O : never;
