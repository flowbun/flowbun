import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { LoadedFlow } from "../router/types";
import { generateWireAssertions } from "./generate";

export interface TypecheckResult {
  ok: boolean;
  output: string;
  durationMs: number;
}

// this file lives at packages/runtime/src/typecheck/run.ts
const RUNTIME_PKG_DIR = join(import.meta.dir, "..", "..");

/**
 * Writes the synthetic wire-assertion file + a self-contained tsconfig (not
 * extending tsconfig.base.json, so unrelated monorepo tsconfig churn can
 * never affect this gate) under `<dataDir>/generated/`, then shells out to
 * the runtime package's own resolved `tsc` binary. Must be called, and must
 * succeed, before any flow's Router is built or any process() runs.
 */
export async function runTypecheck(
  flows: LoadedFlow[],
  dataDir: string,
): Promise<TypecheckResult> {
  const generatedDir = join(dataDir, "generated");
  mkdirSync(generatedDir, { recursive: true });

  const runtimeSrcRel = relative(generatedDir, join(RUNTIME_PKG_DIR, "src"));
  // data/generated has no node_modules of its own, so ambient Bun globals
  // (used transitively via flowbun/hass/client.ts) need an explicit
  // typeRoots pointing back at the runtime package's own @types.
  const runtimeTypesRel = relative(
    generatedDir,
    join(RUNTIME_PKG_DIR, "node_modules", "@types"),
  );

  writeFileSync(
    join(generatedDir, "wires.check.ts"),
    generateWireAssertions(flows),
  );

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      incremental: true,
      tsBuildInfoFile: "./.tsbuildinfo",
      typeRoots: [runtimeTypesRel],
      types: ["bun"],
      paths: {
        flowbun: [`${runtimeSrcRel}/index.ts`],
        "flowbun/hass/trigger": [`${runtimeSrcRel}/hass/trigger.ts`],
        "flowbun/hass/action": [`${runtimeSrcRel}/hass/action.ts`],
        "flowbun/hass/read": [`${runtimeSrcRel}/hass/read.ts`],
        // Resolved fine without an explicit entry too (moduleResolution:
        // "bundler" falls back to node_modules/flowbun's package.json
        // "exports" map), but every sibling subpath gets one, and relying
        // on the implicit fallback for just this one is a trap for the
        // next person who assumes this list is exhaustive.
        "flowbun/hass/client": [`${runtimeSrcRel}/hass/client.ts`],
        "flowbun/hass/exposed-entities": [
          `${runtimeSrcRel}/hass/exposed-entities.ts`,
        ],
        "flowbun/http/in": [`${runtimeSrcRel}/http/in.ts`],
        "flowbun/core/scheduler": [`${runtimeSrcRel}/core/scheduler.ts`],
        "flowbun/core/inject": [`${runtimeSrcRel}/core/inject.ts`],
        "flowbun/core/debug": [`${runtimeSrcRel}/core/debug.ts`],
        "flowbun/ai/agent": [`${runtimeSrcRel}/ai/agent.ts`],
        "flowbun/ai/voice-timers": [`${runtimeSrcRel}/ai/voice-timers.ts`],
        "flowbun/auth": [`${runtimeSrcRel}/auth/session.ts`],
      },
    },
    files: ["wires.check.ts"],
  };
  writeFileSync(
    join(generatedDir, "tsconfig.check.json"),
    JSON.stringify(tsconfig, null, 2),
  );

  const tscBin = join(RUNTIME_PKG_DIR, "node_modules", ".bin", "tsc");
  const start = performance.now();
  const proc = Bun.spawn({
    cmd: [tscBin, "-p", "tsconfig.check.json"],
    cwd: generatedDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {
    ok: exitCode === 0,
    output: `${stdout}${stderr}`.trim(),
    durationMs: performance.now() - start,
  };
}
