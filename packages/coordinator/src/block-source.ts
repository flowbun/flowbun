/**
 * Every block this codebase ships or generates (packages/runtime/src/blocks/
 * *.ts, main.ts's blockSkeleton) writes `name: "..."` as a bare string
 * literal on its own line, as the first property of the defineBlock() call
 * -- so a line-anchored regex is enough to read or rewrite it without a real
 * TS parser. Anchoring on "first match in the file" is what keeps this safe
 * against a block whose own `config` shape happens to have a nested `name`
 * field too: defineBlock's own name is always written before it.
 */
const NAME_FIELD = /^(\s*name:\s*)"((?:[^"\\]|\\.)*)"/m;

export function extractBlockName(source: string): string | undefined {
  const match = source.match(NAME_FIELD);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[2]}"`);
  } catch {
    return undefined;
  }
}

/** Rewrites the block source's own `name:` field in place. Throws if it
 * can't find that field, or if what's there doesn't match `oldName` --
 * duplicateBlock relies on that second check to notice a stale/renamed
 * registry entry rather than silently mangling the wrong block. */
export function renameBlockDefName(
  source: string,
  oldName: string,
  newName: string,
): string {
  const match = source.match(NAME_FIELD);
  if (!match) {
    throw new Error('could not find a `name: "..."` field in block source');
  }
  let current: string | undefined;
  try {
    current = JSON.parse(`"${match[2]}"`);
  } catch {
    current = undefined;
  }
  if (current !== oldName) {
    throw new Error(
      `block source's name field ("${current}") doesn't match expected "${oldName}"`,
    );
  }
  const escapedNew = JSON.stringify(newName).slice(1, -1);
  return source.replace(
    NAME_FIELD,
    (_full, prefix: string) => `${prefix}"${escapedNew}"`,
  );
}

/**
 * The only relative import specifiers a built-in block may use, and the
 * public `flowbun` subpath each becomes once the block's source is copied
 * out of the package and into data/blocks/.
 *
 * SOURCE OF TRUTH: packages/runtime/package.json's `exports` map. A block
 * under data/blocks/ resolves `"flowbun/..."` through that map and nothing
 * else, so a subpath missing from it is unreachable no matter how sensible
 * the file layout looks. Everything below beyond `"../block"` is exactly the
 * two-segment `./<dir>/<mod>` entries of that map; block-source.test.ts
 * asserts the two stay in sync, so adding an export subpath without
 * extending this table fails a test rather than silently producing
 * duplicates that never load.
 *
 * `"../block"` is the one hand-mapped case: defineBlock lives in
 * src/block.ts, which is not itself exported -- it reaches the outside world
 * only by being re-exported from src/index.ts, i.e. the map's `"."` entry.
 */
export const PUBLIC_IMPORTS: Readonly<Record<string, string>> = {
  "../block": "flowbun",
  "../ai/agent": "flowbun/ai/agent",
  "../ai/hass-tools": "flowbun/ai/hass-tools",
  "../ai/openai-agent": "flowbun/ai/openai-agent",
  "../ai/voice-timers": "flowbun/ai/voice-timers",
  "../core/scheduler": "flowbun/core/scheduler",
  "../core/inject": "flowbun/core/inject",
  "../core/debug": "flowbun/core/debug",
  "../core/switch": "flowbun/core/switch",
  "../hass/trigger": "flowbun/hass/trigger",
  "../hass/action": "flowbun/hass/action",
  "../hass/read": "flowbun/hass/read",
  "../hass/client": "flowbun/hass/client",
  "../hass/exposed-entities": "flowbun/hass/exposed-entities",
  "../http/in": "flowbun/http/in",
};

/**
 * Matches the module specifier of an import/export-from statement, but only
 * a *relative* one (`"./x"` / `"../x"`) -- bare specifiers are somebody
 * else's package and must survive untouched.
 *
 * Same regex-not-a-TS-parser tradeoff as NAME_FIELD above, and for the same
 * reason: every source this runs against is either shipped in this repo
 * (packages/runtime/src/blocks/*.ts) or biome-formatted on the way out, so
 * the shape is known rather than arbitrary. The line anchor plus
 * "no quote/backtick between line start and the `from`/`import` keyword" is
 * what keeps a string or template literal that merely *contains*
 * `from "../x"` from being rewritten as if it were an import — prose about
 * imports inside a block's own doc string is a real thing blocks do.
 * Multi-line named-import blocks
 * are handled by anchoring on the `} from "..."` line rather than on the
 * `import` keyword, which by then is several lines up (http-in.ts and
 * openai-agent.ts are both written that way).
 */
const RELATIVE_IMPORT = /^([^"'`\n]*\b(?:from|import)\s*)"(\.[^"\n]*)"/gm;

/**
 * Rewrites a built-in block's package-relative import specifiers to the
 * public `flowbun` subpaths that a file under data/blocks/ can actually
 * resolve, so duplicateBlock's copy of a built-in loads instead of dying on
 * import.
 *
 * Why this exists at all: built-ins live *inside* the flowbun package and
 * import each other package-relatively (`"../block"`,
 * `"../core/scheduler"`). Copied verbatim into data/blocks/ those resolve
 * against data/ instead, and Bun rejects the module outright --
 * `ResolveMessage: Cannot find module '../block' from
 * '.../data/blocks/core_scheduler_2.ts'`. Nothing surfaced that: discovery
 * (packages/runtime/src/discovery/block-loader.ts) catches a failing import,
 * logs `[discoverBlocks] ... failed to import, skipping it` and continues,
 * and the reload typecheck passes regardless because typecheck/generate.ts
 * only emits imports for blocks some flow actually references -- which a
 * just-duplicated block never is. So duplicateBlock reported success, the
 * editor opened the new file, and the block simply never appeared in the
 * palette. Silently, for every built-in.
 *
 * Throws rather than best-efforts an unmappable specifier: emitting a file
 * that is guaranteed never to load is precisely the failure mode above, and
 * the whole point here is to make it loud. This is not hypothetical --
 * blocks/agent-hass.ts and blocks/openai-agent.ts import `"../ai/openai-agent"`
 * and blocks/core-switch.ts imports `"../core/switch"`, neither of which is
 * in the exports map, so duplicating those three genuinely cannot work until
 * runtime's package.json exports the module they need.
 */
export function rewriteRelativeImports(source: string): string {
  const blockName = extractBlockName(source) ?? "<unnamed block>";
  return source.replace(
    RELATIVE_IMPORT,
    (_full, prefix: string, specifier: string) => {
      const mapped = PUBLIC_IMPORTS[specifier];
      if (!mapped) {
        throw new Error(
          `block "${blockName}" imports "${specifier}", which has no public "flowbun/..." equivalent — ` +
            `a copy under data/blocks/ could never resolve it. Add the module to packages/runtime/package.json's ` +
            `"exports" map (and to PUBLIC_IMPORTS in block-source.ts) to make this block duplicable.`,
        );
      }
      return `${prefix}"${mapped}"`;
    },
  );
}
