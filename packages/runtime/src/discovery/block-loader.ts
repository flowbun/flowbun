import { join, relative } from "node:path";
import type { AnyBlockDef } from "../block";
import type { BlockRegistry } from "../wiring/flow-assembly";

function isBlockDef(
  mod: Record<string, unknown>,
): mod is { default: AnyBlockDef } {
  // Deliberately untyped (Record<string, unknown>, not Partial<AnyBlockDef>)
  // — this validates genuinely untrusted input (whatever a dynamic import()
  // handed back), and Partial<> over a discriminated union erases the
  // discriminant's "required"-ness, which defeats exactly the kind-based
  // narrowing this function needs to do below.
  const def = mod.default;
  if (typeof def !== "object" || def === null) return false;
  const d = def as Record<string, unknown>;
  if (typeof d.name !== "string") return false;
  if (typeof d.inputs !== "object" || d.inputs === null) return false;
  if (typeof d.outputs !== "object" || d.outputs === null) return false;
  // A transform (the default kind — `kind` omitted or "transform") must have
  // a real process(); a source or relay never calls process() at all (see
  // block.ts's SourceBlockDef/RelayBlockDef doc comments), so it's valid
  // without one. A duplex needs both hooks — that's its whole definition
  // (see block.ts's DuplexBlockDef doc comment).
  if (d.kind === undefined || d.kind === "transform") {
    return typeof d.process === "function";
  }
  if (d.kind === "duplex") {
    return typeof d.process === "function" && typeof d.subscribe === "function";
  }
  return d.kind === "source" || d.kind === "relay";
}

/**
 * Scans every `*.ts` file directly under `dir`, dynamic-importing each and
 * registering its `defineBlock` default export — shared by both the stdlib
 * scan and the `<dataDir>/blocks` user scan below, so a built-in block
 * (packages/runtime/src/blocks/*.ts) is discovered exactly the same way a
 * user's own block is: no separate registration path, no privileged
 * shortcut. `origin` only records provenance for consumers that need it
 * (e.g. the editor's core-vs-add-on palette split); it has no effect on how
 * the block itself is loaded or run.
 */
async function scanBlockDir(
  dir: string,
  generatedDir: string,
  origin: "builtin" | "user",
  registry: BlockRegistry,
): Promise<void> {
  const glob = new Bun.Glob("*.ts");
  for await (const file of glob.scan({ cwd: dir })) {
    const absPath = join(dir, file);
    // Bun's ES module cache is keyed by the resolved specifier string, not
    // file content or mtime -- a bare `import(absPath)` on the *second*
    // discoverBlocks() call for the same path within one coordinator
    // process returns the module object from the first call, silently
    // ignoring whatever's actually on disk now. Every real block file
    // already gets imported once at coordinator startup, so this bit
    // *every* live block-port edit made through the editor after that,
    // not just repeated reloads (e.g. restoreFlow's write-then-validate):
    // assembleFlow kept validating against the stale, startup-time port
    // shape instead of the just-saved one. A cache-busting query string
    // forces a genuinely fresh read+evaluate every call, matching what
    // every caller here already assumes ("the registry reflects what's on
    // disk right now"). Built-in blocks never change without a container
    // rebuild (which starts a fresh process anyway), so this is pure
    // overhead for them, not a correctness requirement — kept uniform
    // rather than special-cased for the sake of one branch fewer.
    // A syntactically broken block file (a real possibility mid-edit, or a
    // typo saved by mistake) makes `import()` throw -- previously bare and
    // uncaught here, which took discoverBlocks(), and every one of its
    // callers (coordinator startup, every reload path, every flow-host
    // subprocess's own registry build) down with it: one bad block file
    // could crash the entire coordinator process, not just fail to load.
    // Skipping the broken file here instead means any flow that actually
    // references it fails on its own, in the open, via assembleFlow's
    // already-isolated "unknown block" error (see loadAllFlows/
    // reloadBlocksAndRestartAll in coordinator/main.ts) -- a flow that
    // doesn't reference it is completely unaffected, exactly like any
    // other single-flow structural failure.
    let mod: Record<string, unknown>;
    try {
      mod = await import(`${absPath}?t=${Date.now()}`);
    } catch (err) {
      console.error(
        `[discoverBlocks] ${absPath} failed to import, skipping it:\n${err}`,
      );
      continue;
    }
    if (!isBlockDef(mod)) {
      console.error(
        `[discoverBlocks] ${absPath} does not have a valid defineBlock default export, skipping it`,
      );
      continue;
    }
    const existing = registry.get(mod.default.name);
    if (existing?.origin === "builtin" && origin === "user") {
      // The `@hass/*`/`@core/*`/`@ai/*` namespaces are reserved for stdlib
      // blocks (see this function's own doc comment) — a user block can't
      // shadow one by reusing its name. Scanning order (stdlib first, see
      // discoverBlocks below) is what makes this check meaningful: by the
      // time a user block's own name is checked, every builtin is already
      // registered.
      console.error(
        `[discoverBlocks] ${absPath}: block name "${mod.default.name}" is reserved by a built-in block, skipping it`,
      );
      continue;
    }
    const relSpecifier = relative(generatedDir, absPath).replace(/\.ts$/, "");
    registry.set(mod.default.name, {
      def: mod.default,
      specifier: relSpecifier.startsWith(".")
        ? relSpecifier
        : `./${relSpecifier}`,
      modulePath: absPath,
      origin,
    });
  }
}

/**
 * Scans `packages/runtime/src/blocks/*.ts` (the nine built-in blocks —
 * `@hass/trigger`, `@hass/action`, `@hass/read`, `@core/scheduler`,
 * `@core/inject`, `@core/debug`, `@ai/agent`, `@http/in`, `@ai/openai_agent`)
 * and `<dataDir>/blocks/*.ts`
 * (everything a user has written), registering both sets through the exact
 * same scan/import/validate path — see scanBlockDir's own doc comment.
 */
export async function discoverBlocks(dataDir: string): Promise<BlockRegistry> {
  const registry: BlockRegistry = new Map();
  const generatedDir = join(dataDir, "generated");

  const stdlibDir = join(import.meta.dir, "..", "blocks");
  await scanBlockDir(stdlibDir, generatedDir, "builtin", registry);

  const blocksDir = join(dataDir, "blocks");
  await scanBlockDir(blocksDir, generatedDir, "user", registry);

  return registry;
}
