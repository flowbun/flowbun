import { join } from "node:path";
import type { CoordinatorToFlowHost, FlowHostToCoordinator } from "flowbun/ipc";
import type { HaRelay } from "./ha-relay";
import type { LogBuffer } from "./log-buffer";

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 30_000;
const CRASH_LOOP_MAX = 5;
const CRASH_LOOP_WINDOW_MS = 300_000;
const DEGRADE_ERROR_THRESHOLD = 5;
const DEGRADE_WINDOW_MS = 60_000;

export type FlowStatus =
  | { kind: "starting" }
  | { kind: "running"; pid: number; since: number }
  | { kind: "degraded"; pid: number; since: number; reason: string }
  | { kind: "restarting"; attempt: number; nextAttemptAt: number }
  | {
      kind: "failed-typecheck";
      at: number;
      output: string;
      stillRunning: boolean;
      pid?: number;
    }
  | { kind: "crash-looped"; at: number; attempts: number };

interface FlowRuntime {
  wiringPath: string;
  flowName: string;
  subprocess: Bun.Subprocess | null;
  status: FlowStatus;
  crashTimestamps: number[];
  errorTimestamps: number[];
  expectingExit: boolean;
}

export class Supervisor {
  private flows = new Map<string, FlowRuntime>();

  constructor(
    private readonly dataDir: string,
    private readonly haRelay: HaRelay,
    private readonly logBuffer: LogBuffer,
  ) {}

  async startFlow(wiringPath: string, flowName: string): Promise<void> {
    const rt: FlowRuntime = {
      wiringPath,
      flowName,
      subprocess: null,
      status: { kind: "starting" },
      crashTimestamps: [],
      errorTimestamps: [],
      expectingExit: false,
    };
    this.flows.set(flowName, rt);
    this.spawn(rt);
  }

  private spawn(rt: FlowRuntime): void {
    const mainPath = join(
      import.meta.dir,
      "..",
      "..",
      "flow-host",
      "src",
      "main.ts",
    );
    rt.subprocess = Bun.spawn({
      cmd: [process.execPath, "run", mainPath, rt.wiringPath],
      env: { ...Bun.env, FLOWBUN_DATA_DIR: this.dataDir },
      ipc: (message, subprocess) =>
        this.onMessage(rt, message as FlowHostToCoordinator, subprocess),
      stdio: ["ignore", "inherit", "inherit"],
      // bun-types declares signalCode as `number | null`, but spikes/s2-ipc's
      // test3-exit-signals.ts confirmed at runtime it's actually a string
      // signal name ("SIGTERM"/"SIGKILL") or null — trusting observed
      // behavior over the stale type declaration here.
      onExit: (_subprocess, exitCode, signalCode) =>
        this.onExit(rt, exitCode, signalCode as unknown as string | null),
    });
  }

  private onMessage(
    rt: FlowRuntime,
    msg: FlowHostToCoordinator,
    subprocess: Bun.Subprocess,
  ): void {
    switch (msg.type) {
      case "ready":
        this.setStatus(rt, {
          kind: "running",
          pid: subprocess.pid,
          since: Date.now(),
        });
        break;
      case "hass.subscribe":
        this.haRelay.subscribe(
          rt.flowName,
          msg.nodeId,
          msg.entity,
          (payload) => {
            subprocess.send({
              type: "hass.event",
              nodeId: msg.nodeId,
              port: "changed",
              payload,
            } satisfies CoordinatorToFlowHost);
          },
        );
        break;
      case "hass.action.call":
        this.haRelay.call(msg.call, msg.dryRunOverride).then(
          ({ dryRun }) => {
            subprocess.send({
              type: "hass.action.result",
              requestId: msg.requestId,
              ok: true,
              dryRun,
            } satisfies CoordinatorToFlowHost);
          },
          (err) => {
            subprocess.send({
              type: "hass.action.result",
              requestId: msg.requestId,
              ok: false,
              error: String(err),
              dryRun: msg.dryRunOverride ?? false,
            } satisfies CoordinatorToFlowHost);
          },
        );
        break;
      case "log":
        for (const entry of msg.entries) {
          this.logBuffer.push(entry);
          if (entry.level === "error") this.noteError(rt);
        }
        break;
    }
  }

  private noteError(rt: FlowRuntime): void {
    const now = Date.now();
    rt.errorTimestamps = rt.errorTimestamps.filter(
      (t) => now - t < DEGRADE_WINDOW_MS,
    );
    rt.errorTimestamps.push(now);
    if (
      rt.errorTimestamps.length >= DEGRADE_ERROR_THRESHOLD &&
      rt.status.kind === "running"
    ) {
      this.setStatus(rt, {
        kind: "degraded",
        pid: rt.status.pid,
        since: rt.status.since,
        reason: `${rt.errorTimestamps.length} error logs in ${DEGRADE_WINDOW_MS}ms`,
      });
    }
  }

  private onExit(
    rt: FlowRuntime,
    exitCode: number | null,
    signalCode: string | null,
  ): void {
    if (rt.expectingExit) {
      rt.expectingExit = false;
      return;
    }
    const now = Date.now();
    rt.crashTimestamps = rt.crashTimestamps.filter(
      (t) => now - t < CRASH_LOOP_WINDOW_MS,
    );
    rt.crashTimestamps.push(now);
    this.logBuffer.push({
      level: "error",
      msg: "flow.crashed",
      meta: { exitCode, signalCode },
      at: now,
      flow: rt.flowName,
    });

    if (rt.crashTimestamps.length > CRASH_LOOP_MAX) {
      this.setStatus(rt, {
        kind: "crash-looped",
        at: now,
        attempts: rt.crashTimestamps.length,
      });
      return;
    }
    const attempt = rt.crashTimestamps.length;
    const delay = Math.min(
      BACKOFF_BASE_MS * BACKOFF_FACTOR ** (attempt - 1),
      BACKOFF_CAP_MS,
    );
    this.setStatus(rt, {
      kind: "restarting",
      attempt,
      nextAttemptAt: now + delay,
    });
    setTimeout(() => this.spawn(rt), delay);
  }

  /** Reload path — caller (main.ts) has already run and passed the typecheck gate. */
  async restartFlow(flowName: string): Promise<void> {
    const rt = this.flows.get(flowName);
    if (!rt) return;
    rt.crashTimestamps = []; // a deliberate, successful reload earns a fresh crash-loop window
    if (rt.subprocess) {
      rt.expectingExit = true;
      rt.subprocess.send({ type: "shutdown" } satisfies CoordinatorToFlowHost);
      const exitedInTime = await Promise.race([
        rt.subprocess.exited.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 3000)),
      ]);
      if (!exitedInTime) rt.subprocess.kill("SIGKILL");
    }
    this.setStatus(rt, { kind: "starting" });
    this.spawn(rt);
  }

  markFailedTypecheck(flowName: string, output: string): void {
    const rt = this.flows.get(flowName);
    if (!rt) return;
    const pid =
      rt.status.kind === "running" || rt.status.kind === "degraded"
        ? rt.status.pid
        : undefined;
    this.setStatus(rt, {
      kind: "failed-typecheck",
      at: Date.now(),
      output,
      stillRunning: pid !== undefined,
      pid,
    });
  }

  markAllFailedTypecheck(output: string): void {
    for (const rt of this.flows.values())
      this.markFailedTypecheck(rt.flowName, output);
  }

  private setStatus(rt: FlowRuntime, status: FlowStatus): void {
    rt.status = status;
    console.log(
      `[coordinator] flow "${rt.flowName}" status:`,
      JSON.stringify(status),
    );
  }

  getStatus(flowName: string): FlowStatus | undefined {
    return this.flows.get(flowName)?.status;
  }

  async stopAll(): Promise<void> {
    for (const rt of this.flows.values()) {
      rt.expectingExit = true;
      rt.subprocess?.kill();
    }
  }
}
