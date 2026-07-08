import { join } from "node:path";

/**
 * Runs a block's source through Biome — the same formatter/config the rest
 * of the repo uses (biome.json at the repo root) — before it's written to
 * disk, via `biome format --stdin-file-path` so nothing touches the
 * filesystem directly. Uses the explicit node_modules/.bin path rather than
 * relying on PATH resolution, since this runs however the coordinator
 * process itself was launched (dev, or two levels of Bun.spawn deep inside
 * the Docker entrypoint).
 *
 * Never blocks a save: if Biome can't parse the source (e.g. it's
 * mid-edit and syntactically broken) or the binary is missing entirely,
 * the raw source is written as-is — the real typecheck gate, not the
 * formatter, is what actually reports a problem.
 */
export async function formatWithBiome(
  source: string,
  relativePath: string,
  repoRoot: string,
): Promise<string> {
  try {
    const biomeBin = join(repoRoot, "node_modules", ".bin", "biome");
    const proc = Bun.spawn({
      cmd: [biomeBin, "format", `--stdin-file-path=${relativePath}`],
      cwd: repoRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    proc.stdin.write(source);
    proc.stdin.end();
    const [formatted, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return exitCode === 0 && formatted.length > 0 ? formatted : source;
  } catch {
    return source;
  }
}
