import { existsSync } from "node:fs";
import { join } from "node:path";

export interface HistoryEntry {
  hash: string;
  date: string;
  message: string;
}

export interface SnapshotResult {
  /** False only on a genuine, unexpected failure — never for "git isn't
   * installed" or "nothing changed", both of which are expected no-ops. */
  ok: boolean;
  committed: boolean;
  hash?: string;
  error?: string;
}

export interface GitSnapshotter {
  /** Stages the whole data dir and commits iff something actually changed. */
  snapshot(message: string): Promise<SnapshotResult>;
  /** Commit log newest-first, optionally scoped to one path relative to dataDir. */
  history(relativePath?: string, limit?: number): Promise<HistoryEntry[]>;
  /** A file's content as of one historical commit; undefined if it didn't exist then. */
  readFileAt(hash: string, relativePath: string): Promise<string | undefined>;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * A git repo dedicated to `dataDir` (always `data/`, never the app repo
 * root) — auto-committed by the coordinator on every write, giving durable,
 * git-backed undo/redo and history that survives a coordinator restart
 * (unlike the old in-memory UndoStack). See snapshotting-serializer.ts for
 * where this gets called from.
 *
 * Hard contract: every method here fails open and NEVER throws — a git
 * hiccup (or git not being installed at all, which is genuinely the case in
 * this project's base Docker image unless the Dockerfile installs it) must
 * never block an editor save or crash the coordinator. This is load-bearing
 * for snapshotting-serializer.ts's bare `finally { await snapshot(...) }`.
 */
export function createGitSnapshotter(
  dataDir: string,
  gitBin?: string,
): GitSnapshotter {
  const bin = gitBin ?? Bun.env.FLOWBUN_GIT_BIN ?? "git";
  let unavailable = false;
  let repoReady = false;

  async function run(args: string[]): Promise<RunResult> {
    try {
      const proc = Bun.spawn({
        cmd: [bin, ...args],
        cwd: dataDir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { ok: exitCode === 0, stdout, stderr, exitCode };
    } catch (err) {
      // Bun.spawn throws synchronously when the binary can't be found at
      // all (ENOENT) — folding that into the same RunResult shape as a
      // normal non-zero exit means every caller only has one failure shape
      // to handle, not two.
      return { ok: false, stdout: "", stderr: String(err), exitCode: -1 };
    }
  }

  /** Lazily inits the repo (or confirms an existing one still works) on
   * first real use — not at construction time, so a dataDir that doesn't
   * exist yet (fresh install, test temp dir) doesn't matter until the first
   * actual write. Memoized: once unavailable, every future call short-
   * circuits without re-spawning a doomed process. */
  async function ensureRepo(): Promise<boolean> {
    if (unavailable) return false;
    if (repoReady) return true;
    // git refuses to touch a repo owned by a different user than the
    // process running it ("detected dubious ownership") unless explicitly
    // told it's safe — and that mismatch is the *normal* case here, not an
    // edge case: data/ is bind-mounted from the host (typically owned by
    // whoever set up the deployment) into a container that runs as a
    // different uid (root, in this project's own Dockerfile). Every fresh
    // deployment hits this, not just this one dev environment — confirmed
    // by actually hitting it against the real container, not by
    // inspection. --global (not --system) since the container has no
    // meaningful distinction between the two and --global doesn't require
    // root-owned config file access.
    await run(["config", "--global", "--add", "safe.directory", dataDir]);
    const gitDirExists = existsSync(join(dataDir, ".git"));
    if (!gitDirExists) {
      const init = await run(["init", "-b", "main"]);
      if (!init.ok) {
        unavailable = true;
        console.warn(
          `[git-snapshot] git not available — snapshotting disabled: ${init.stderr}`,
        );
        return false;
      }
      // Local (not global) identity so a fresh deployment with no host git
      // config still works unattended.
      await run(["config", "--local", "user.name", "flowbun-snapshot"]);
      await run(["config", "--local", "user.email", "snapshot@flowbun.local"]);
    } else {
      const probe = await run(["rev-parse", "--is-inside-work-tree"]);
      if (!probe.ok) {
        unavailable = true;
        console.warn(
          `[git-snapshot] git not available — snapshotting disabled: ${probe.stderr}`,
        );
        return false;
      }
    }
    repoReady = true;
    console.log(`[git-snapshot] git snapshotting enabled (${dataDir}/.git)`);
    return true;
  }

  async function snapshot(message: string): Promise<SnapshotResult> {
    if (!(await ensureRepo())) return { ok: true, committed: false };
    const add = await run(["add", "-A"]);
    if (!add.ok) return { ok: false, committed: false, error: add.stderr };
    // `git diff --cached --quiet` exits 0 when nothing is staged, 1 when
    // something is — checking this explicitly (rather than trying to
    // distinguish "commit failed because empty" from "commit failed
    // because broken") avoids ever treating a no-op save as an error.
    const diff = await run(["diff", "--cached", "--quiet"]);
    if (diff.exitCode === 0) return { ok: true, committed: false };
    if (diff.exitCode !== 1) {
      return {
        ok: false,
        committed: false,
        error: diff.stderr || `git diff exited ${diff.exitCode}`,
      };
    }
    const commit = await run(["commit", "-m", message]);
    if (!commit.ok) {
      return { ok: false, committed: false, error: commit.stderr };
    }
    const rev = await run(["rev-parse", "HEAD"]);
    return { ok: true, committed: true, hash: rev.stdout.trim() || undefined };
  }

  async function history(
    relativePath?: string,
    limit = 50,
  ): Promise<HistoryEntry[]> {
    if (!(await ensureRepo())) return [];
    const args = ["log", "--format=%H%x1f%aI%x1f%s", "-n", String(limit)];
    if (relativePath) args.push("--", relativePath);
    const result = await run(args);
    if (!result.ok || !result.stdout.trim()) return [];
    return result.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [hash, date, message] = line.split("\x1f");
        return { hash: hash ?? "", date: date ?? "", message: message ?? "" };
      });
  }

  async function readFileAt(
    hash: string,
    relativePath: string,
  ): Promise<string | undefined> {
    if (!(await ensureRepo())) return undefined;
    const result = await run(["show", `${hash}:${relativePath}`]);
    return result.ok ? result.stdout : undefined;
  }

  return { snapshot, history, readFileAt };
}
