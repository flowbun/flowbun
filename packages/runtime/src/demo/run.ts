import { join } from "node:path";
import { discoverBlocks } from "../discovery/block-loader";
import { isDryRun } from "../hass/client";
import { registerHassTrigger } from "../hass/trigger";
import {
  createConsoleLogger,
  createTracingLogger,
  type TraceEntry,
} from "../logger";
import { Router } from "../router/router";
import type { LoadedFlow } from "../router/types";
import { openStateDb } from "../state/db";
import { runTypecheck } from "../typecheck/run";
import { assembleFlow } from "../wiring/flow-assembly";
import { loadWiringFile } from "../wiring/loader";

const DATA_DIR =
  Bun.env.FLOWBUN_DATA_DIR ??
  join(import.meta.dir, "..", "..", "..", "..", "data");
const DEMO_WINDOW_MS = Number(Bun.env.FLOWBUN_DEMO_WINDOW_MS ?? 120_000);

function printTrace(traces: Map<string, TraceEntry[]>, traceId: string): void {
  const entries = traces.get(traceId) ?? [];
  console.log(`\n[demo] trace ${traceId}:`);
  for (const entry of entries) {
    const m = entry.meta ?? {};
    console.log(
      `  seq=${m.seq ?? "-"} causationSeq=${m.causationSeq ?? "-"} ${entry.msg} ${JSON.stringify(m)}`,
    );
  }
}

async function main(): Promise<void> {
  console.log(`[demo] dry run mode: ${isDryRun()}`);
  console.log(`[demo] data dir: ${DATA_DIR}`);

  const registry = await discoverBlocks(DATA_DIR);
  console.log(
    `[demo] discovered ${registry.size} block types: ${[...registry.keys()].join(", ")}`,
  );

  const wiringDir = join(DATA_DIR, "wiring");
  const wiringFiles: string[] = [];
  for await (const file of new Bun.Glob("*.json").scan({ cwd: wiringDir })) {
    wiringFiles.push(join(wiringDir, file));
  }

  const db = openStateDb(join(DATA_DIR, "state", "flowbun.sqlite"));

  const flows: LoadedFlow[] = [];
  for (const file of wiringFiles) {
    const wiring = await loadWiringFile(file);
    flows.push(assembleFlow(wiring, registry, db));
  }
  console.log(
    `[demo] loaded ${flows.length} flow(s): ${flows.map((f) => f.name).join(", ")}`,
  );

  const check = await runTypecheck(flows, DATA_DIR);
  if (!check.ok) {
    console.error(
      `[demo] typecheck FAILED (${Math.round(check.durationMs)}ms):\n${check.output}`,
    );
    process.exit(1);
  }
  console.log(`[demo] typecheck OK (${Math.round(check.durationMs)}ms)`);

  const { logger, traces } = createTracingLogger(createConsoleLogger());
  const routers = new Map(
    flows.map((flow) => [flow.name, new Router(flow, logger)] as const),
  );

  // --- outdoor_temp_demo: fetch + Zod proof point ---
  const tempRouter = routers.get("outdoor_temp_demo");
  if (tempRouter) {
    const traceId = tempRouter.ingress("temp", "poll", { at: Date.now() });
    await tempRouter.waitForIdle();
    printTrace(traces, traceId);
  }

  // --- hallway_lights: real, read-only motion subscription; dry-run action ---
  const hallwayRouter = routers.get("hallway_lights");
  if (hallwayRouter) {
    console.log(
      `\n[demo] hallway_lights: subscribing (read-only) to binary_sensor.hallway_motion for up to ${DEMO_WINDOW_MS}ms — walk past the sensor to see the full trace.`,
    );
    const unsubscribe = await registerHassTrigger(
      { entity: "binary_sensor.hallway_motion" },
      (payload) => {
        const traceId = hallwayRouter.emitFromSource(
          "motion",
          "changed",
          payload,
        );
        hallwayRouter.waitForIdle().then(() => printTrace(traces, traceId));
      },
    );

    if (DEMO_WINDOW_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, DEMO_WINDOW_MS));
      unsubscribe();
      console.log(
        `[demo] demo window elapsed (${DEMO_WINDOW_MS}ms) — exiting.`,
      );
    } else {
      console.log(
        "[demo] running indefinitely (FLOWBUN_DEMO_WINDOW_MS=0) — Ctrl-C to stop.",
      );
      await new Promise(() => {});
    }
  }

  db.close();
  // DA's live websocket connection keeps handles open that would otherwise
  // hold the event loop alive indefinitely even after main() returns.
  process.exit(0);
}

main().catch((err) => {
  console.error("[demo] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
