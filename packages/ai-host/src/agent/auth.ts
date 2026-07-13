import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Proactive check, not a caught error from query() itself — more reliable
 * than pattern-matching a thrown message that could change across SDK
 * versions, and lets callers give a precise, actionable instruction instead
 * of a generic failure. `claude setup-token` prints a long-lived token for
 * CLAUDE_CODE_OAUTH_TOKEN rather than writing a credentials file when run
 * non-interactively, so both paths count as authenticated. Shared by both
 * the interactive chat runner and per-flow-node agent calls — one auth
 * story for every Claude Agent SDK caller in this process.
 */
export function hasClaudeCredentials(claudeConfigDir: string): boolean {
  const hasCredentialsFile = existsSync(
    join(claudeConfigDir, ".credentials.json"),
  );
  const hasEnvToken = Boolean(
    Bun.env.CLAUDE_CODE_OAUTH_TOKEN || Bun.env.ANTHROPIC_API_KEY,
  );
  return hasCredentialsFile || hasEnvToken;
}
