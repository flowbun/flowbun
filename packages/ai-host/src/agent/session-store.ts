import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ChatSessionSummary } from "flowbun/ws";

interface StoredSession {
  sessionId: string;
}

/** The coordinator's own tiny pointer to the Claude Agent SDK's *current*
 * session id — separate from the SDK's own `.jsonl` transcript storage
 * under CLAUDE_CONFIG_DIR, and separate from `listSessions` below (which
 * enumerates every past session, not just this one). Lets a fresh
 * coordinator process `resume` the prior conversation after a restart.
 * Fails open (never throws): a missing or corrupt file just means "no
 * session to resume yet", not a crash. */
export function readSessionId(sessionFile: string): string | undefined {
  try {
    if (!existsSync(sessionFile)) return undefined;
    const parsed = JSON.parse(
      readFileSync(sessionFile, "utf8"),
    ) as StoredSession;
    return parsed.sessionId;
  } catch {
    return undefined;
  }
}

export function writeSessionId(sessionFile: string, sessionId: string): void {
  try {
    writeFileSync(
      sessionFile,
      JSON.stringify({ sessionId } satisfies StoredSession),
    );
  } catch {
    // Best-effort — worst case, the next coordinator restart starts a fresh
    // conversation instead of resuming, same as if this file never existed.
  }
}

/** Clears the current-session pointer (used by "start a new session") — the
 * *next* sendMessage then omits `resume` entirely, so the SDK mints a fresh
 * session id on that turn. Doesn't touch the abandoned session's own
 * transcript on disk; it remains fully resumable via listSessions. */
export function clearSessionId(sessionFile: string): void {
  try {
    if (existsSync(sessionFile)) unlinkSync(sessionFile);
  } catch {
    // Best-effort, same reasoning as writeSessionId.
  }
}

/** Every session's `.jsonl` transcript lives at
 * `<claudeConfigDir>/projects/<encoded-cwd>/<sessionId>.jsonl`. Rather than
 * reimplementing the SDK's own (private, version-dependent) cwd-encoding
 * scheme, this globs for it instead — this app only ever runs with one
 * pinned cwd (see runner.ts's own comment on why `cwd` must stay stable),
 * so there is only ever one matching project subdirectory in practice,
 * regardless of what the encoding actually looks like. */
function sessionGlob(sessionId = "*"): Bun.Glob {
  return new Bun.Glob(join("projects", "*", `${sessionId}.jsonl`));
}

/** Absolute path to a specific session's transcript, or undefined if no
 * matching file exists (e.g. a stale/foreign session id). */
export function findSessionTranscriptPath(
  claudeConfigDir: string,
  sessionId: string,
): string | undefined {
  for (const rel of sessionGlob(sessionId).scanSync({
    cwd: claudeConfigDir,
  })) {
    return join(claudeConfigDir, rel);
  }
  return undefined;
}

const TITLE_MAX_LENGTH = 60;

function firstUserTextTitle(jsonlText: string): string | undefined {
  for (const line of jsonlText.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "user") continue;
    const content = (record as { message?: { content?: unknown } }).message
      ?.content;
    if (!Array.isArray(content)) continue;
    const textBlock = content.find(
      (b) => (b as { type?: string })?.type === "text",
    ) as { text?: string } | undefined;
    if (textBlock?.text) return textBlock.text.slice(0, TITLE_MAX_LENGTH);
  }
  return undefined;
}

function firstTimestamp(jsonlText: string): number | undefined {
  const firstLine = jsonlText.split("\n").find((l) => l.trim());
  if (!firstLine) return undefined;
  try {
    const record = JSON.parse(firstLine) as { timestamp?: string };
    return record.timestamp ? Date.parse(record.timestamp) : undefined;
  } catch {
    return undefined;
  }
}

/** Enumerates every session this app has ever had, newest-used first — the
 * data source for the chat panel's session picker. Best-effort per file: a
 * transcript that fails to read/parse is skipped rather than failing the
 * whole list. */
export function listSessions(claudeConfigDir: string): ChatSessionSummary[] {
  const summaries: ChatSessionSummary[] = [];
  let matches: string[];
  try {
    matches = [...sessionGlob().scanSync({ cwd: claudeConfigDir })];
  } catch {
    return [];
  }
  for (const rel of matches) {
    const abs = join(claudeConfigDir, rel);
    const id = rel.slice(rel.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
    try {
      const text = readFileSync(abs, "utf8");
      const stat = statSync(abs);
      summaries.push({
        id,
        title: firstUserTextTitle(text) ?? id,
        startedAt: firstTimestamp(text) ?? stat.birthtimeMs,
        lastUsedAt: stat.mtimeMs,
      });
    } catch {
      // Skip unreadable/corrupt transcripts rather than failing the list.
    }
  }
  return summaries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}
