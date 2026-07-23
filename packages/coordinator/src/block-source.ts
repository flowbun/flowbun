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
