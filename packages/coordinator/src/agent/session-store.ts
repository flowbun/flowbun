import { existsSync, readFileSync, writeFileSync } from "node:fs";

interface StoredSession {
  sessionId: string;
}

/** The coordinator's own tiny pointer to the Claude Agent SDK's session id
 * — separate from the SDK's own `.jsonl` transcript storage under
 * CLAUDE_CONFIG_DIR. Lets a fresh coordinator process `resume` the prior
 * conversation after a restart. Fails open (never throws): a missing or
 * corrupt file just means "no session to resume yet", not a crash. */
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
