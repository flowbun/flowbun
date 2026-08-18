import type { BlockSummary } from "flowbun";

/**
 * Client half of block.ts's BlockSummary: turns one block-type-wide template
 * into the one line a *specific* node shows on the canvas. It lives here, not
 * in the runtime, because the split is forced by the wire — the palette is
 * broadcast per block type and can only carry data, so the per-node
 * resolution has nowhere else to happen (see BlockSummary's own doc comment).
 *
 * The governing rule throughout: never emit something half-true. A
 * placeholder that can't be resolved blanks the entire line rather than
 * leaking a literal "{time}" onto a node, because a summary is a
 * convenience — a wrong one costs more than a missing one, especially on a
 * canvas whose nodes drive real hardware.
 */

/** Rendered length cap for `truncate`. Tuned against the node's own
 * `minWidth: 140` in BlockNode.tsx: much beyond this and a single entity id
 * dictates the width of every node on the canvas. */
const TRUNCATE_AT = 24;

/** Monday-first, deliberately: `Date.getDay()` (and therefore
 * SchedulerConfig.weekdays) is 0=Sunday..6=Saturday, but a schedule reads far
 * better as "Mon–Fri" than as the "Sun, Mon–Fri" that Sunday-first ordering
 * would produce for the same set. The indexing stays HA/JS-native everywhere
 * else; only this rendering rotates. */
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The closed set of named formatters — closed on purpose. Every formatter is
 * a rendering decision baked into the runtime's block definitions and shipped
 * over the wire as a *name*, so an open/pluggable set would mean a block
 * could ask the editor to run something the editor has never heard of; the
 * only sane answer to an unknown name is then "render nothing", which is what
 * resolvePlaceholder does.
 *
 * Returning `undefined` means "I decline this value" and blanks the whole
 * line. Returning `""` means "correctly renders as nothing" and leaves the
 * rest of the line standing — the distinction matters (see `signedMinutes`).
 */
const FORMATTERS: Record<string, (value: unknown) => string | undefined> = {
  /** SchedulerConfig.weekdays: 0=Sunday..6=Saturday, omitted meaning every
   * day (see core/scheduler.ts) — so `undefined` is not a missing value here,
   * it is a meaningful one. Contiguous runs collapse only at length 3+: a
   * two-day run rendered as "Sat–Sun" is longer than "Sat, Sun" and reads
   * worse. Out-of-range days are rejected outright rather than rendered as
   * `undefined` — nextDailyTime() throws on them, so the node isn't running
   * and shouldn't claim a schedule. */
  weekdays(value) {
    if (value === undefined || value === null) return "every day";
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const ordinals: number[] = [];
    for (const day of value) {
      if (typeof day !== "number" || !Number.isInteger(day)) return undefined;
      if (day < 0 || day > 6) return undefined;
      // 0=Sunday..6=Saturday -> 0=Monday..6=Sunday.
      const ordinal = (day + 6) % 7;
      if (!ordinals.includes(ordinal)) ordinals.push(ordinal);
    }
    ordinals.sort((a, b) => a - b);

    const runs: number[][] = [];
    for (const ordinal of ordinals) {
      const run = runs[runs.length - 1];
      const previous = run?.[run.length - 1];
      if (run && previous !== undefined && ordinal === previous + 1) {
        run.push(ordinal);
      } else {
        runs.push([ordinal]);
      }
    }
    return runs
      .map((run) => {
        const names = run.map((ordinal) => WEEKDAY_NAMES[ordinal] ?? "");
        return run.length >= 3
          ? `${names[0]}–${names[names.length - 1]}`
          : names.join(", ");
      })
      .join(", ");
  },

  /** Milliseconds -> the coarsest unit that stays honest. Sub-two-minute
   * values stay in seconds ("60s", not "1m") because that is how poll
   * intervals are spoken about and how they're written in config; above that,
   * minutes and hours read better than a three-digit second count. Seconds
   * are dropped once hours are involved — "1h 30m 12s" is noise on a node. */
  duration(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return undefined;
    }
    if (value < 1000) return `${Math.round(value)}ms`;
    const totalSeconds = Math.round(value / 1000);
    if (totalSeconds < 120) return `${totalSeconds}s`;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    if (hours === 0) return `${minutes}m`;
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  },

  /** "HH:MM" pass-through, normalizing the single-digit hour that
   * nextDailyTime() also accepts ("9:05" -> "09:05") so a column of scheduler
   * nodes lines up. Anything else is rejected rather than shown: a malformed
   * time is a config error the scheduler throws on. */
  time(value) {
    if (typeof value !== "string") return undefined;
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return undefined;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return undefined;
    return `${String(hours).padStart(2, "0")}:${match[2]}`;
  },

  /** Explicitly `""` (not `undefined`) for a zero or absent offset: the
   * scheduler's sunRelative line is "{event} {offsetMinutes:signedMinutes}",
   * and "sunset" on its own is a perfectly good summary — blanking the line
   * because the offset happens to be zero would hide the most common
   * sun-relative config there is. */
  signedMinutes(value) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    const whole = Math.round(value);
    if (whole === 0) return "";
    return whole > 0 ? `+${whole}m` : `${whole}m`;
  },

  /** Keeps one long value from setting the width of every node — see
   * TRUNCATE_AT. The untruncated config is always one hover away (BlockNode
   * puts the whole thing in the node's `title`). */
  truncate(value) {
    if (value === undefined || value === null) return undefined;
    const text = String(value);
    return text.length > TRUNCATE_AT
      ? `${text.slice(0, TRUNCATE_AT - 1)}…`
      : text;
  },

  /** Confirms a value is set without ever putting it on screen. This one is
   * load-bearing rather than cosmetic: block configs routinely hold live
   * credentials (data/blocks/matrix_poll.ts's config carries a working Matrix
   * access token, and it is the obvious next block to summarize), and a
   * canvas is the single most screenshotted, screenshared surface in the
   * editor. Any summary touching a secret must go through here — the raw
   * placeholder form would leak it verbatim. Absent stays absent, so an
   * unconfigured credential doesn't masquerade as a configured one. */
  secret(value) {
    if (value === undefined || value === null || value === "") return undefined;
    return "••••";
  },
};

/** `{a.b}` walks into nested config objects. Needed because not every
 * summarizable value sits at the top level — @hass/action's target is
 * `{ entity_id: ... }` — and the alternative (a per-shape formatter) would
 * mean growing the closed formatter set for every new config shape. */
function lookup(config: Record<string, unknown>, path: string): unknown {
  let current: unknown = config;
  for (const key of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Placeholder syntax: `{path}` or `{path:formatter}`. Neither part may
 * contain a brace or colon, so an unbalanced/garbled template simply fails to
 * match and is left alone rather than being partially chewed. */
const PLACEHOLDER = /\{([^{}:]+)(?::([^{}:]+))?\}/g;

function resolvePlaceholder(
  config: Record<string, unknown>,
  path: string,
  formatterName: string | undefined,
): string | undefined {
  const raw = lookup(config, path);
  if (formatterName !== undefined) {
    const formatter = FORMATTERS[formatterName];
    // Unknown formatter name: the block was authored against a newer editor
    // than this one. Rendering the raw value instead would silently drop the
    // masking/rounding the author asked for — with `secret` in this set,
    // that is a leak, not a cosmetic downgrade.
    if (!formatter) return undefined;
    return formatter(raw);
  }
  if (raw === undefined || raw === null) return undefined;
  return String(raw);
}

/**
 * Resolves `summary` against one node's `config`, or `undefined` when there
 * is nothing worth showing — the caller renders nothing at all in that case,
 * rather than reserving an empty row.
 */
export function renderBlockSummary(
  summary: BlockSummary | undefined,
  config: unknown,
): string | undefined {
  if (!summary) return undefined;
  const record: Record<string, unknown> =
    typeof config === "object" && config !== null
      ? (config as Record<string, unknown>)
      : {};

  // Without `switchOn` only "*" is consulted: a template picked by "whatever
  // key happens to be first" would silently change meaning as a block's spec
  // grows a second line.
  const selector =
    summary.switchOn === undefined
      ? undefined
      : String(lookup(record, summary.switchOn));
  const template =
    (selector === undefined ? undefined : summary.lines[selector]) ??
    summary.lines["*"];
  if (template === undefined) return undefined;

  let resolvable = true;
  const text = template.replace(PLACEHOLDER, (_match, path, formatterName) => {
    const resolved = resolvePlaceholder(
      record,
      path as string,
      formatterName as string | undefined,
    );
    if (resolved === undefined) resolvable = false;
    return resolved ?? "";
  });
  if (!resolvable) return undefined;

  // Collapse the gaps left by placeholders that legitimately rendered as
  // nothing (a zero sun offset, an empty @http/in path), so the line doesn't
  // carry the ghost of its template's spacing.
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed === "") return undefined;
  return summary.icon ? `${summary.icon} ${collapsed}` : collapsed;
}
