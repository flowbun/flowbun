/**
 * Monaco's TypeScript worker runs in the browser with no access to the real
 * `node_modules`/workspace resolution the server-side typecheck gate uses —
 * without this, it flags every `import ... from "flowbun"` in a block file
 * as unresolvable ("Cannot find module 'flowbun'"), even though the real
 * `tsc` run (shown after Save) resolves it fine. This is a hand-maintained
 * mirror of `packages/runtime/src/block.ts`'s public block-authoring
 * surface — the only part of `flowbun` a block file ever imports — purely
 * so Monaco's live squiggles stop lying. It is NOT the source of truth: the
 * server-side typecheck on save is, and always wins.
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
`;
