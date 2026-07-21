import { join } from "node:path";
import type { NpmPackageEntry } from "flowbun/ws";

/**
 * `data/` has no package.json until the first install — `bun add` would
 * create a minimal one itself, but writing it explicitly up front keeps
 * every caller (including the startup self-heal, which needs to check for
 * this file's *existence* to decide whether to run at all) working against
 * a guaranteed-consistent starting point rather than relying on bun's own
 * implicit init behavior.
 */
async function ensureDataPackageJson(dataDir: string): Promise<void> {
  const path = join(dataDir, "package.json");
  if (await Bun.file(path).exists()) return;
  await Bun.write(
    path,
    `${JSON.stringify({ name: "flowbun-data", private: true }, null, 2)}\n`,
  );
}

/**
 * Every `bun` invocation here runs with `cwd: dataDir` against data/'s own
 * package.json/bun.lock/node_modules — a project independent of the
 * workspace root's, deliberately not part of `workspaces: ["packages/*"]"
 * (see the plan this was built from). Captures combined stdout+stderr as
 * one string, same style as runtime/src/typecheck/run.ts's `runTypecheck`
 * and format-block.ts's `formatWithBiome` — this codebase's existing
 * convention for "shell out, report the whole output back," not
 * line-by-line streaming.
 */
async function runBun(
  dataDir: string,
  args: string[],
): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", ...args],
    cwd: dataDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, output: `${stdout}${stderr}`.trim() };
}

/**
 * Resyncs data/node_modules to whatever data/package.json + data/bun.lock
 * already say, on every coordinator boot (local dev and Docker alike — see
 * main.ts's call site) — the same directory getting bind-mounted onto a
 * fresh container, or a stopped-and-restarted container whose node_modules
 * layer wasn't preserved, must not silently lose every installed package.
 * A no-op (skips the `bun install` call entirely) if nothing has ever been
 * installed, so a project with no data-scoped dependencies pays no startup
 * cost. Fails open — logs and returns — same convention git-snapshot.ts's
 * ensureRepo() already uses for "the tool isn't available/didn't work":
 * a broken self-heal must not block the coordinator from starting.
 */
export async function selfHealNpmInstall(dataDir: string): Promise<void> {
  if (!(await Bun.file(join(dataDir, "package.json")).exists())) return;
  try {
    const result = await runBun(dataDir, ["install"]);
    if (result.ok) {
      console.log("[coordinator] data/: npm dependencies resynced");
    } else {
      console.error(
        `[coordinator] data/: npm self-heal install failed, continuing anyway:\n${result.output}`,
      );
    }
  } catch (err) {
    console.error(`[coordinator] data/: npm self-heal install threw: ${err}`);
  }
}

/**
 * Reads what's *declared* (data/package.json's dependencies) and cross
 * references what's actually *resolved* on disk (each package's own
 * installed package.json under data/node_modules) — a package can be
 * declared but not yet resolved if node_modules was wiped and the self-heal
 * install hasn't run yet, hence resolvedVersion being optional.
 */
export async function listNpmPackages(
  dataDir: string,
): Promise<NpmPackageEntry[]> {
  const pkgJsonFile = Bun.file(join(dataDir, "package.json"));
  if (!(await pkgJsonFile.exists())) return [];
  const pkgJson = (await pkgJsonFile.json()) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkgJson.dependencies ?? {};
  const entries: NpmPackageEntry[] = [];
  for (const [name, requestedRange] of Object.entries(deps)) {
    const installedFile = Bun.file(
      join(dataDir, "node_modules", name, "package.json"),
    );
    let resolvedVersion: string | undefined;
    if (await installedFile.exists()) {
      const installed = (await installedFile.json()) as { version?: string };
      resolvedVersion = installed.version;
    }
    entries.push({ name, requestedRange, resolvedVersion });
  }
  return entries;
}

// Serializes every install/remove into one total order — `bun add`/`bun
// remove` both rewrite package.json and bun.lock on disk, so two concurrent
// calls (e.g. two browser tabs) racing each other could corrupt either
// file. A single module-level chain is enough: like main.ts's own
// serializeReload, these are bursty, human-paced operations, not a
// throughput-sensitive path.
let queue: Promise<unknown> = Promise.resolve();
function serializeNpm<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function installNpmPackage(
  dataDir: string,
  spec: string,
): Promise<{ ok: boolean; output: string }> {
  return serializeNpm(async () => {
    await ensureDataPackageJson(dataDir);
    return runBun(dataDir, ["add", spec]);
  });
}

export async function removeNpmPackage(
  dataDir: string,
  name: string,
): Promise<{ ok: boolean; output: string }> {
  return serializeNpm(async () => {
    await ensureDataPackageJson(dataDir);
    return runBun(dataDir, ["remove", name]);
  });
}
