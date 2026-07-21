import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import type { BlockRegistry, Wiring } from "flowbun";
import { WiringSchema } from "flowbun/wiring";
import type {
  FlowEntry,
  FlowPackageSummary,
  FlowPackageVersionInfo,
  InstalledFlowPackage,
  InstalledFlowPackageFile,
  TypecheckOutcome,
} from "flowbun/ws";
import { z } from "zod";
import { installNpmPackage } from "./npm-packages";

// ---------------------------------------------------------------------
// registry index schema (what a registry's index.json must look like)
// ---------------------------------------------------------------------

const RegistryFileEntrySchema = z.object({
  path: z.string(),
  sha256: z.string(),
});

const RegistryVersionSchema = z.object({
  version: z.string(),
  description: z.string(),
  author: z.string().optional(),
  flowbun: z.string(),
  npmDependencies: z.record(z.string(), z.string()).default({}),
  blocks: z.array(RegistryFileEntrySchema),
  wiring: z.array(RegistryFileEntrySchema).default([]),
  tests: z.array(z.string()).default([]),
});

const RegistryPackageSchema = z.object({
  name: z.string(),
  versions: z.array(RegistryVersionSchema),
});

const RegistryIndexSchema = z.object({
  schemaVersion: z.number(),
  packages: z.array(RegistryPackageSchema),
});

type RegistryVersion = z.infer<typeof RegistryVersionSchema>;

// ---------------------------------------------------------------------
// pure helpers — exported for unit tests
// ---------------------------------------------------------------------

/**
 * Only understands the ">=x[.y[.z]]" form the registry actually emits
 * (matching flowbun.json's own doc comment) — anything else (carets,
 * ranges, "*") is treated as unparseable rather than guessed at, since a
 * wrong guess here would silently let an incompatible package install.
 */
export function parseFlowbunRange(
  range: string,
): [number, number, number] | undefined {
  const match = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(range.trim());
  if (!match) return undefined;
  return [
    Number(match[1]),
    match[2] === undefined ? 0 : Number(match[2]),
    match[3] === undefined ? 0 : Number(match[3]),
  ];
}

/**
 * true/false once the range parses; undefined when it doesn't (the caller
 * decides how to treat "couldn't tell" — install refuses it outright,
 * browseRegistry reports it as incompatible so the UI doesn't offer it).
 */
export function satisfiesFlowbunRange(
  range: string,
  runtimeVersion: string,
): boolean | undefined {
  const min = parseFlowbunRange(range);
  if (!min) return undefined;
  const cur = runtimeVersion.split(".").map((n) => Number(n) || 0);
  const [curMajor, curMinor, curPatch] = [
    cur[0] ?? 0,
    cur[1] ?? 0,
    cur[2] ?? 0,
  ];
  const [minMajor, minMinor, minPatch] = min;
  if (curMajor !== minMajor) return curMajor > minMajor;
  if (curMinor !== minMinor) return curMinor > minMinor;
  return curPatch >= minPatch;
}

/**
 * Defense against a malicious or broken registry writing outside
 * data/blocks|wiring: must start with exactly "blocks/" or "wiring/", no
 * ".." segment, no absolute path, no backslash. Wiring paths must be flat
 * ("wiring/<file>.json" — no subdirectories); block paths may go one level
 * deeper than "blocks/" only via a "__tests__" directory (matching the
 * registry's own block-name-collision exemption for test files).
 */
export function isSafeRegistryPath(path: string): boolean {
  if (path.includes("\\") || path.includes("..") || path.startsWith("/")) {
    return false;
  }
  if (path.startsWith("wiring/")) {
    const rest = path.slice("wiring/".length);
    return rest.length > 0 && !rest.includes("/");
  }
  if (path.startsWith("blocks/")) {
    const rest = path.slice("blocks/".length);
    if (rest.length === 0) return false;
    if (!rest.includes("/")) return true;
    return (
      rest.startsWith("__tests__/") &&
      rest.slice("__tests__/".length).length > 0
    );
  }
  return false;
}

export function sha256OfBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * `source` is either an http(s) base URL or a local filesystem path (a
 * registry checkout) — the same duality FLOWBUN_REGISTRY_URL supports so
 * this can be exercised against a local registry checkout in dev/tests and
 * air-gapped deployments, not just a live GitHub raw URL.
 */
export async function fetchRegistryBytes(
  source: string,
  relPath: string,
): Promise<Uint8Array> {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const url = `${source}/${relPath}`;
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      throw new Error(`failed to fetch ${url}: ${err}`);
    }
    if (!res.ok) {
      throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  const path = join(source, relPath);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`registry file not found: ${path}`);
  }
  return new Uint8Array(await file.arrayBuffer());
}

async function fetchRegistryIndex(
  source: string,
): Promise<z.infer<typeof RegistryIndexSchema>> {
  const bytes = await fetchRegistryBytes(source, "index.json");
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new Error(`registry index at ${source} is not valid JSON: ${err}`);
  }
  const parsed = RegistryIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `registry index at ${source} has an unexpected shape: ${parsed.error.message}`,
    );
  }
  if (parsed.data.schemaVersion !== 1) {
    throw new Error(
      `registry index at ${source} has schemaVersion ${parsed.data.schemaVersion}; this coordinator only understands 1 — update flowbun`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------
// tracking file — data/flowbun-packages.json
// ---------------------------------------------------------------------

export interface FlowPackagesFile {
  schemaVersion: 1;
  packages: InstalledFlowPackage[];
}

function trackingFilePath(dataDir: string): string {
  return join(dataDir, "flowbun-packages.json");
}

export async function readTrackingFile(
  dataDir: string,
): Promise<FlowPackagesFile> {
  const file = Bun.file(trackingFilePath(dataDir));
  if (!(await file.exists())) return { schemaVersion: 1, packages: [] };
  return (await file.json()) as FlowPackagesFile;
}

export async function writeTrackingFile(
  dataDir: string,
  data: FlowPackagesFile,
): Promise<void> {
  const sorted: FlowPackagesFile = {
    schemaVersion: 1,
    packages: [...data.packages].sort((a, b) => a.name.localeCompare(b.name)),
  };
  await Bun.write(
    trackingFilePath(dataDir),
    `${JSON.stringify(sorted, null, 2)}\n`,
  );
}

/** Thrown by update() when local modifications exist and `force` wasn't
 * set — ws-server.ts special-cases this to populate
 * pkg.flow.updateResult.modifiedFiles. */
export class ModifiedFilesError extends Error {
  constructor(
    message: string,
    public readonly files: string[],
  ) {
    super(message);
    this.name = "ModifiedFilesError";
  }
}

// ---------------------------------------------------------------------
// the manager
// ---------------------------------------------------------------------

export interface FlowPackageDeps {
  dataDir: string;
  registrySource: string;
  runtimeVersion: string;
  /** main.ts owns this Map and keeps it current across reloads. */
  flows: Map<string, FlowEntry>;
  /** `registry` is a `let` in main.ts reassigned on every blocks reload —
   * must be read fresh each time, never captured once at construction. */
  getBlockRegistry: () => BlockRegistry;
  reloadBlocksAndRestartAll: (label?: string) => Promise<TypecheckOutcome>;
  reloadWiringFile: (path: string, label?: string) => Promise<TypecheckOutcome>;
  deleteFlow: (file: string) => Promise<void>;
  markSelfWrite: (path: string) => void;
  forgetUndo: (relPath: string) => void;
}

export interface FlowPackageManager {
  browseRegistry(): Promise<{ source: string; packages: FlowPackageSummary[] }>;
  listInstalled(): Promise<InstalledFlowPackage[]>;
  install(
    name: string,
    version?: string,
  ): Promise<{ version: string; output: string; typecheck: TypecheckOutcome }>;
  uninstall(name: string): Promise<{ output: string; modifiedFiles: string[] }>;
  update(
    name: string,
    opts?: { version?: string; force?: boolean },
  ): Promise<{ version: string; output: string; typecheck: TypecheckOutcome }>;
}

interface FetchedFile {
  path: string; // registry-relative, e.g. "blocks/foo.ts"
  bytes: Uint8Array;
}

/**
 * `versionPrefix` is "packages/<name>/<version>" -- index.json's own file
 * entries are version-relative ("blocks/foo.ts"), but the actual fetch URL
 * needs the full "<base>/packages/<name>/<version>/<path>" per the
 * registry's documented layout. The returned FetchedFile.path stays
 * version-relative (that's what's tracked and what install-target mapping
 * uses), only the fetch itself is prefixed.
 */
async function fetchAndVerify(
  source: string,
  versionPrefix: string,
  entries: { path: string; sha256: string }[],
): Promise<FetchedFile[]> {
  const out: FetchedFile[] = [];
  for (const entry of entries) {
    if (!isSafeRegistryPath(entry.path)) {
      throw new Error(
        `registry entry "${entry.path}" is not a safe install path`,
      );
    }
    const bytes = await fetchRegistryBytes(
      source,
      `${versionPrefix}/${entry.path}`,
    );
    const actual = sha256OfBytes(bytes);
    if (actual !== entry.sha256) {
      throw new Error(
        `"${entry.path}" hash mismatch — expected ${entry.sha256}, got ${actual}`,
      );
    }
    out.push({ path: entry.path, bytes });
  }
  return out;
}

/** blocks/foo.ts -> foo ; blocks/__tests__/foo.test.ts -> __tests__/foo.test */
function blockStem(relPath: string): string {
  return relPath.slice("blocks/".length).replace(/\.ts$/, "");
}

function wiringBasename(relPath: string): string {
  return relPath.slice("wiring/".length);
}

export function createFlowPackageManager(
  deps: FlowPackageDeps,
): FlowPackageManager {
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function resolveVersion(
    versions: RegistryVersion[],
    requested: string | undefined,
  ): RegistryVersion {
    if (requested === undefined) {
      const first = versions[0];
      if (!first) throw new Error("package has no published versions");
      return first;
    }
    const found = versions.find((v) => v.version === requested);
    if (!found) throw new Error(`version "${requested}" not found`);
    return found;
  }

  function checkCompatible(v: RegistryVersion): void {
    const compatible = satisfiesFlowbunRange(v.flowbun, deps.runtimeVersion);
    if (compatible === undefined) {
      throw new Error(
        `can't parse compat range "${v.flowbun}" for ${v.version} — this flowbun may be too old for this package`,
      );
    }
    if (!compatible) {
      throw new Error(
        `${v.version} requires flowbun ${v.flowbun}, this is ${deps.runtimeVersion}`,
      );
    }
  }

  /** Recovers a file-backed block's internal name from its data/blocks/
   * relative path — mirrors main.ts's deleteBlock, since the registry is
   * keyed by name, not filename (they're expected to match, but only
   * discoverBlocks enforces that, not this lookup). */
  function blockNameForFile(relFile: string): string | undefined {
    const registry = deps.getBlockRegistry();
    for (const [name, entry] of registry.entries()) {
      if (entry.origin !== "user") continue;
      if (
        relative(join(deps.dataDir, "blocks"), entry.modulePath) === relFile
      ) {
        return name;
      }
    }
    return undefined;
  }

  /** Every node in every flow that references `blockName`, formatted for an
   * error message — excludes flows whose wiring file is itself one of
   * `ownWiringFiles` (a package's own demo flow referencing its own block
   * is not a conflict). */
  function referencingNodes(
    blockName: string,
    ownWiringFiles: Set<string>,
  ): string[] {
    const hits: string[] = [];
    for (const entry of deps.flows.values()) {
      if (ownWiringFiles.has(entry.file)) continue;
      for (const [nodeId, node] of Object.entries(entry.wiring.nodes)) {
        if (node.block === blockName) {
          hits.push(`node "${nodeId}" in flow "${entry.wiring.name}"`);
        }
      }
    }
    return hits;
  }

  async function browseRegistry(): Promise<{
    source: string;
    packages: FlowPackageSummary[];
  }> {
    const index = await fetchRegistryIndex(deps.registrySource);
    const tracking = await readTrackingFile(deps.dataDir);
    const installedByName = new Map(tracking.packages.map((p) => [p.name, p]));
    const packages: FlowPackageSummary[] = index.packages.map((pkg) => ({
      name: pkg.name,
      installedVersion: installedByName.get(pkg.name)?.version,
      versions: pkg.versions.map(
        (v): FlowPackageVersionInfo => ({
          version: v.version,
          description: v.description,
          author: v.author,
          flowbun: v.flowbun,
          compatible:
            satisfiesFlowbunRange(v.flowbun, deps.runtimeVersion) === true,
          npmDependencies: v.npmDependencies,
          blocks: v.blocks.map((b) => b.path),
          wiring: v.wiring.map((w) => w.path),
          tests: v.tests,
        }),
      ),
    }));
    return { source: deps.registrySource, packages };
  }

  async function listInstalled(): Promise<InstalledFlowPackage[]> {
    return (await readTrackingFile(deps.dataDir)).packages;
  }

  async function install(
    name: string,
    version?: string,
  ): Promise<{ version: string; output: string; typecheck: TypecheckOutcome }> {
    return serialize(async () => {
      const tracking = await readTrackingFile(deps.dataDir);
      const already = tracking.packages.find((p) => p.name === name);
      if (already) {
        throw new Error(
          `"${name}" is already installed (${already.version}) — use pkg.flow.update instead`,
        );
      }

      const index = await fetchRegistryIndex(deps.registrySource);
      const pkg = index.packages.find((p) => p.name === name);
      if (!pkg) throw new Error(`"${name}" not found in registry`);
      const v = resolveVersion(pkg.versions, version);
      checkCompatible(v);

      // Collisions -- all read-only, before any fetch.
      for (const b of v.blocks) {
        if (!isSafeRegistryPath(b.path)) {
          throw new Error(
            `registry entry "${b.path}" is not a safe install path`,
          );
        }
        const stem = blockStem(b.path);
        if (!stem.includes("/")) {
          // Not a __tests__ file -- subject to the flat block-name registry.
          if (deps.getBlockRegistry().has(stem)) {
            throw new Error(`block "${stem}" already exists (name collision)`);
          }
        }
        const abs = join(deps.dataDir, b.path);
        if (await Bun.file(abs).exists()) {
          throw new Error(`"${b.path}" already exists on disk`);
        }
      }
      for (const w of v.wiring) {
        if (!isSafeRegistryPath(w.path)) {
          throw new Error(
            `registry entry "${w.path}" is not a safe install path`,
          );
        }
        const base = wiringBasename(w.path);
        if (deps.flows.has(base)) {
          throw new Error(
            `wiring file "${base}" already exists (name collision)`,
          );
        }
        const abs = join(deps.dataDir, w.path);
        if (await Bun.file(abs).exists()) {
          throw new Error(`"${w.path}" already exists on disk`);
        }
      }
      // Internal wiring `name` uniqueness -- Supervisor/status callback key
      // flows by wiring.name, not filename, so a duplicate cross-talks
      // status between two files even with distinct filenames.
      const existingFlowNames = new Set(
        [...deps.flows.values()].map((e) => e.wiring.name),
      );
      const namesInThisPackage = new Set<string>();

      // Buffered fetch+verify -- all or nothing, zero writes on any failure.
      const versionPrefix = `packages/${name}/${v.version}`;
      const blockFiles = await fetchAndVerify(
        deps.registrySource,
        versionPrefix,
        v.blocks,
      );
      const wiringFiles = await fetchAndVerify(
        deps.registrySource,
        versionPrefix,
        v.wiring,
      );

      const preparedWiring: {
        path: string;
        bytes: Uint8Array;
        hash: string;
      }[] = [];
      for (const w of wiringFiles) {
        let parsed: Wiring;
        try {
          parsed = WiringSchema.parse(
            JSON.parse(new TextDecoder().decode(w.bytes)),
          );
        } catch (err) {
          throw new Error(`"${w.path}" is not valid wiring: ${err}`);
        }
        if (
          existingFlowNames.has(parsed.name) ||
          namesInThisPackage.has(parsed.name)
        ) {
          throw new Error(
            `flow name "${parsed.name}" (from "${w.path}") collides with an existing flow`,
          );
        }
        namesInThisPackage.add(parsed.name);
        const forced: Wiring = { ...parsed, disabled: true };
        const bytes = new TextEncoder().encode(
          `${JSON.stringify(forced, null, 2)}\n`,
        );
        preparedWiring.push({
          path: w.path,
          bytes,
          hash: sha256OfBytes(bytes),
        });
      }

      // npm deps -- nothing written to blocks/wiring yet; a failure here
      // leaves at most an idempotent partial `bun add` in data/package.json.
      for (const [dep, range] of Object.entries(v.npmDependencies)) {
        const result = await installNpmPackage(deps.dataDir, `${dep}@${range}`);
        if (!result.ok) {
          throw new Error(
            `failed to add npm dependency "${dep}@${range}": ${result.output}`,
          );
        }
      }

      // Writes -- markSelfWrite before each write (watcher can fire before
      // a queued reload -- same ordering ws-server.ts's own handlers use).
      const written: string[] = [];
      const trackedFiles: InstalledFlowPackageFile[] = [];
      try {
        for (const b of blockFiles) {
          const abs = join(deps.dataDir, b.path);
          deps.markSelfWrite(abs);
          await Bun.write(abs, b.bytes);
          written.push(abs);
          trackedFiles.push({ path: b.path, sha256: sha256OfBytes(b.bytes) });
        }
        for (const w of preparedWiring) {
          const abs = join(deps.dataDir, w.path);
          deps.markSelfWrite(abs);
          await Bun.write(abs, w.bytes);
          written.push(abs);
          trackedFiles.push({ path: w.path, sha256: w.hash });
        }
      } catch (err) {
        for (const abs of written) {
          try {
            await Bun.file(abs).delete();
          } catch {
            // best effort
          }
        }
        throw err;
      }

      tracking.packages.push({
        name,
        version: v.version,
        source: deps.registrySource,
        installedAt: new Date().toISOString(),
        npmDependencies: v.npmDependencies,
        files: trackedFiles,
      });
      await writeTrackingFile(deps.dataDir, tracking);

      const blocksOutcome = await deps.reloadBlocksAndRestartAll(
        `install flow package: ${name}@${v.version}`,
      );
      const outputs = [blocksOutcome.output];
      let ok = blocksOutcome.ok;
      for (const w of preparedWiring) {
        const abs = join(deps.dataDir, w.path);
        const outcome = await deps.reloadWiringFile(
          abs,
          `install flow package: ${name}@${v.version} (${wiringBasename(w.path)})`,
        );
        outputs.push(outcome.output);
        ok = ok && outcome.ok;
      }

      return {
        version: v.version,
        output: `installed ${name}@${v.version}: ${trackedFiles.length} file(s), ${Object.keys(v.npmDependencies).length} npm dependency(ies)`,
        typecheck: { ok, output: outputs.filter(Boolean).join("\n\n") },
      };
    });
  }

  async function uninstall(
    name: string,
  ): Promise<{ output: string; modifiedFiles: string[] }> {
    return serialize(async () => {
      const tracking = await readTrackingFile(deps.dataDir);
      const idx = tracking.packages.findIndex((p) => p.name === name);
      if (idx === -1) throw new Error(`"${name}" is not installed`);
      const pkg = tracking.packages[idx] as InstalledFlowPackage;

      const wiringFiles = pkg.files.filter((f) => f.path.startsWith("wiring/"));
      const blockFiles = pkg.files.filter((f) => f.path.startsWith("blocks/"));
      const ownWiringBasenames = new Set(
        wiringFiles.map((f) => wiringBasename(f.path)),
      );

      // Guard everything before deleting anything.
      const offenders: string[] = [];
      for (const b of blockFiles) {
        const file = b.path.slice("blocks/".length);
        const blockName = blockNameForFile(file);
        if (!blockName) continue; // already gone from disk/registry
        offenders.push(...referencingNodes(blockName, ownWiringBasenames));
      }
      if (offenders.length > 0) {
        throw new Error(
          `can't uninstall "${name}": still referenced by ${offenders.join(", ")} — remove it from the flow first`,
        );
      }

      // Missing counts as modified too (same convention update() uses) --
      // a locally-deleted file is just as worth flagging as a locally-
      // edited one.
      const modifiedFiles: string[] = [];
      for (const f of pkg.files) {
        const abs = join(deps.dataDir, f.path);
        const file = Bun.file(abs);
        if (!(await file.exists())) {
          modifiedFiles.push(f.path);
          continue;
        }
        const actual = sha256OfBytes(new Uint8Array(await file.arrayBuffer()));
        if (actual !== f.sha256) modifiedFiles.push(f.path);
      }

      for (const w of wiringFiles) {
        const base = wiringBasename(w.path);
        if (deps.flows.has(base)) {
          await deps.deleteFlow(base);
        } else {
          const abs = join(deps.dataDir, w.path);
          if (await Bun.file(abs).exists()) {
            deps.markSelfWrite(abs);
            await Bun.file(abs).delete();
          }
        }
      }
      for (const b of blockFiles) {
        const abs = join(deps.dataDir, b.path);
        if (await Bun.file(abs).exists()) {
          deps.markSelfWrite(abs);
          await Bun.file(abs).delete();
        }
        deps.forgetUndo(b.path);
      }

      tracking.packages.splice(idx, 1);
      await writeTrackingFile(deps.dataDir, tracking);
      await deps.reloadBlocksAndRestartAll(`uninstall flow package: ${name}`);

      const depNames = Object.keys(pkg.npmDependencies);
      const npmNote =
        depNames.length > 0
          ? ` npm dependencies (${depNames.join(", ")}) were NOT removed — they may be shared; use pkg.npm.remove if unwanted.`
          : "";
      return {
        output: `uninstalled ${name}@${pkg.version}: ${pkg.files.length} file(s) removed.${npmNote}`,
        modifiedFiles,
      };
    });
  }

  async function update(
    name: string,
    opts: { version?: string; force?: boolean } = {},
  ): Promise<{ version: string; output: string; typecheck: TypecheckOutcome }> {
    return serialize(async () => {
      const tracking = await readTrackingFile(deps.dataDir);
      const idx = tracking.packages.findIndex((p) => p.name === name);
      if (idx === -1) throw new Error(`"${name}" is not installed`);
      const installed = tracking.packages[idx] as InstalledFlowPackage;

      const index = await fetchRegistryIndex(deps.registrySource);
      const pkg = index.packages.find((p) => p.name === name);
      if (!pkg) throw new Error(`"${name}" not found in registry`);
      const v = resolveVersion(pkg.versions, opts.version);
      if (v.version === installed.version) {
        throw new Error(`already at ${v.version}`);
      }
      checkCompatible(v);

      const modifiedFiles: string[] = [];
      for (const f of installed.files) {
        const abs = join(deps.dataDir, f.path);
        const file = Bun.file(abs);
        if (!(await file.exists())) {
          modifiedFiles.push(f.path);
          continue;
        }
        const actual = sha256OfBytes(new Uint8Array(await file.arrayBuffer()));
        if (actual !== f.sha256) modifiedFiles.push(f.path);
      }
      if (modifiedFiles.length > 0 && !opts.force) {
        throw new ModifiedFilesError(
          `"${name}" has locally modified files: ${modifiedFiles.join(", ")} — pass force to overwrite`,
          modifiedFiles,
        );
      }

      const ownWiringBasenames = new Set(
        v.wiring.map((w) => wiringBasename(w.path)),
      );
      const oldPaths = new Set(installed.files.map((f) => f.path));
      const newPaths = new Set([...v.blocks, ...v.wiring].map((f) => f.path));
      const removedPaths = [...oldPaths].filter((p) => !newPaths.has(p));

      // Guard removed blocks against flows outside this package.
      const offenders: string[] = [];
      for (const p of removedPaths) {
        if (!p.startsWith("blocks/")) continue;
        const file = p.slice("blocks/".length);
        const blockName = blockNameForFile(file);
        if (!blockName) continue;
        offenders.push(...referencingNodes(blockName, ownWiringBasenames));
      }
      if (offenders.length > 0) {
        throw new Error(
          `can't update "${name}": ${offenders.join(", ")} still reference(s) a block this version removes`,
        );
      }

      const existingFlowNames = new Set(
        [...deps.flows.values()]
          .filter((e) => !ownWiringBasenames.has(e.file))
          .map((e) => e.wiring.name),
      );
      const namesInThisPackage = new Set<string>();

      const versionPrefix = `packages/${name}/${v.version}`;
      const blockFiles = await fetchAndVerify(
        deps.registrySource,
        versionPrefix,
        v.blocks,
      );
      const wiringFiles = await fetchAndVerify(
        deps.registrySource,
        versionPrefix,
        v.wiring,
      );
      const preparedWiring: {
        path: string;
        bytes: Uint8Array;
        hash: string;
      }[] = [];
      for (const w of wiringFiles) {
        let parsed: Wiring;
        try {
          parsed = WiringSchema.parse(
            JSON.parse(new TextDecoder().decode(w.bytes)),
          );
        } catch (err) {
          throw new Error(`"${w.path}" is not valid wiring: ${err}`);
        }
        if (
          existingFlowNames.has(parsed.name) ||
          namesInThisPackage.has(parsed.name)
        ) {
          throw new Error(
            `flow name "${parsed.name}" (from "${w.path}") collides with an existing flow`,
          );
        }
        namesInThisPackage.add(parsed.name);
        const forced: Wiring = { ...parsed, disabled: true };
        const bytes = new TextEncoder().encode(
          `${JSON.stringify(forced, null, 2)}\n`,
        );
        preparedWiring.push({
          path: w.path,
          bytes,
          hash: sha256OfBytes(bytes),
        });
      }

      for (const [dep, range] of Object.entries(v.npmDependencies)) {
        if (installed.npmDependencies[dep] === range) continue;
        const result = await installNpmPackage(deps.dataDir, `${dep}@${range}`);
        if (!result.ok) {
          throw new Error(
            `failed to add npm dependency "${dep}@${range}": ${result.output}`,
          );
        }
      }

      // Remove files the new version drops.
      for (const p of removedPaths) {
        const abs = join(deps.dataDir, p);
        if (await Bun.file(abs).exists()) {
          deps.markSelfWrite(abs);
          await Bun.file(abs).delete();
        }
        if (p.startsWith("blocks/")) deps.forgetUndo(p);
      }

      const written: string[] = [];
      const trackedFiles: InstalledFlowPackageFile[] = [];
      try {
        for (const b of blockFiles) {
          const abs = join(deps.dataDir, b.path);
          deps.markSelfWrite(abs);
          await Bun.write(abs, b.bytes);
          written.push(abs);
          trackedFiles.push({ path: b.path, sha256: sha256OfBytes(b.bytes) });
        }
        for (const w of preparedWiring) {
          const abs = join(deps.dataDir, w.path);
          deps.markSelfWrite(abs);
          await Bun.write(abs, w.bytes);
          written.push(abs);
          trackedFiles.push({ path: w.path, sha256: w.hash });
        }
      } catch (err) {
        for (const abs of written) {
          try {
            await Bun.file(abs).delete();
          } catch {
            // best effort
          }
        }
        throw err;
      }

      tracking.packages[idx] = {
        name,
        version: v.version,
        source: deps.registrySource,
        installedAt: new Date().toISOString(),
        npmDependencies: v.npmDependencies,
        files: trackedFiles,
      };
      await writeTrackingFile(deps.dataDir, tracking);

      const blocksOutcome = await deps.reloadBlocksAndRestartAll(
        `update flow package: ${name} ${installed.version}→${v.version}`,
      );
      const outputs = [blocksOutcome.output];
      let ok = blocksOutcome.ok;
      for (const w of preparedWiring) {
        const abs = join(deps.dataDir, w.path);
        const outcome = await deps.reloadWiringFile(
          abs,
          `update flow package: ${name} ${installed.version}→${v.version} (${wiringBasename(w.path)})`,
        );
        outputs.push(outcome.output);
        ok = ok && outcome.ok;
      }

      return {
        version: v.version,
        output: `updated ${name}: ${installed.version} → ${v.version}`,
        typecheck: { ok, output: outputs.filter(Boolean).join("\n\n") },
      };
    });
  }

  return { browseRegistry, listInstalled, install, uninstall, update };
}
