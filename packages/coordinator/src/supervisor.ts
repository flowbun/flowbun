import { join } from "node:path";
import type { CoordinatorToFlowHost, FlowHostToCoordinator } from "flowbun/ipc";
import type { FlowStatus, HassEntitySummary } from "flowbun/ws";
import type { AiHostClient } from "./ai-host-client";
import type { LogBuffer } from "./log-buffer";

const BACKOFF_BASE_MS = 500;
const BACKOFF_FACTOR = 2;
const BACKOFF_CAP_MS = 30_000;
const CRASH_LOOP_MAX = 5;
const CRASH_LOOP_WINDOW_MS = 300_000;
const DEGRADE_ERROR_THRESHOLD = 5;
const DEGRADE_WINDOW_MS = 60_000;

// FlowStatus now lives in flowbun/ws (it has to cross the coordinator ->
// browser boundary); re-exported here so nothing else in coordinator/ needs
// to change its import.
export type { FlowStatus };

interface FlowRuntime {
  wiringPath: string;
  flowName: string;
  subprocess: Bun.Subprocess | null;
  status: FlowStatus;
  crashTimestamps: number[];
  errorTimestamps: number[];
  expectingExit: boolean;
  // Node ids this flow's WorkerManager has reported permanently dead (see
  // ipc/protocol.ts's "node.dead") -- cleared in spawn() since a fresh
  // subprocess starts every worker fresh, with nothing dead yet.
  deadNodeIds: Set<string>;
}

export class Supervisor {
  private flows = new Map<string, FlowRuntime>();
  // Coordinator-side mirror of DistributedExecutor's pendingActions/
  // pendingReads pattern (packages/flow-host/src/distributed-executor.ts),
  // reversed: this is the one coordinator-initiated request/response pair
  // (fireNode), where every other hass.*.call/result pair is flow-host-
  // initiated instead.
  // Each entry also carries the flowName its request was sent to, so a
  // dying subprocess's own entries can be picked out and rejected (see
  // rejectPending()) without touching unrelated flows' in-flight requests.
  private pendingFires = new Map<
    number,
    {
      flowName: string;
      resolve: (result: { ok: boolean; error?: string }) => void;
    }
  >();
  private nextFireRequestId = 1;
  // Coordinator-initiated, same shape as pendingFires — this coordinator
  // holds no HA connection of its own (see hass/client.ts), so answering
  // "what entities exist" means asking whichever flow-host happens to be
  // running (see queryHassEntities()).
  private pendingEntityQueries = new Map<
    number,
    {
      flowName: string;
      resolve: (
        result:
          | { ok: true; entities: HassEntitySummary[] }
          | { ok: false; error: string },
      ) => void;
    }
  >();
  private nextEntityQueryRequestId = 1;

  constructor(
    private readonly dataDir: string,
    private readonly logBuffer: LogBuffer,
    private readonly aiHostClient: AiHostClient,
    private readonly onStatusChange?: (
      flow: string,
      status: FlowStatus,
    ) => void,
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
      deadNodeIds: new Set(),
    };
    this.flows.set(flowName, rt);
    this.spawn(rt);
  }

  /** Registers a flow that isn't running and won't be spawning a subprocess
   * right now — either because it never got to run at all (assembleFlow
   * rejected its wiring, or it failed the initial typecheck gate) or because
   * its wiring has `disabled: true` (a deliberate, non-failure choice; see
   * main.ts's applyRunState). Either way it still gets a status the editor
   * can show, and a Supervisor entry so a later call looks it up by name
   * instead of silently no-oping on a flow the supervisor never heard of
   * (restartFlow/stopFlow both do this). */
  registerInactive(
    wiringPath: string,
    flowName: string,
    status: FlowStatus,
  ): void {
    const rt: FlowRuntime = {
      wiringPath,
      flowName,
      subprocess: null,
      status: { kind: "starting" },
      crashTimestamps: [],
      errorTimestamps: [],
      expectingExit: false,
      deadNodeIds: new Set(),
    };
    this.flows.set(flowName, rt);
    this.setStatus(rt, status);
  }

  private spawn(rt: FlowRuntime): void {
    // A respawning flow-host might have in-flight work whose result nobody
    // will ever receive once this subprocess is gone — an @ai/agent call
    // shouldn't keep running (and costing real API tokens) in the
    // background. A no-op on first boot (nothing in flight yet). See
    // ai-host-client.ts's own comment on cancelForFlow. (Each flow-host's
    // own HA connection/subscriptions — see hass/client.ts — die with its
    // process and get re-established fresh by the new one; there's no
    // coordinator-side listener bookkeeping to clear anymore.)
    this.aiHostClient.cancelForFlow(rt.flowName);
    // A fresh subprocess starts every WorkerManager fresh -- nothing is
    // dead yet, regardless of what the previous incarnation reported.
    rt.deadNodeIds.clear();
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
      case "hass.entities.result": {
        const pending = this.pendingEntityQueries.get(msg.requestId);
        if (!pending) break;
        this.pendingEntityQueries.delete(msg.requestId);
        pending.resolve(
          msg.ok
            ? { ok: true, entities: msg.entities }
            : { ok: false, error: msg.error },
        );
        break;
      }
      case "flow.fireNode.result": {
        const pending = this.pendingFires.get(msg.requestId);
        if (!pending) break;
        this.pendingFires.delete(msg.requestId);
        pending.resolve(
          msg.ok ? { ok: true } : { ok: false, error: msg.error },
        );
        break;
      }
      case "agent.call":
        this.aiHostClient
          .callAgent(rt.flowName, msg.nodeId, msg.input, msg.config)
          .then((result) => {
            subprocess.send({
              type: "agent.result",
              requestId: msg.requestId,
              ...result,
            } satisfies CoordinatorToFlowHost);
          });
        break;
      case "log":
        for (const entry of msg.entries) {
          this.logBuffer.push(entry);
          if (entry.level === "error") this.noteError(rt);
        }
        break;
      case "node.dead":
        this.noteNodeDead(rt, msg.nodeId);
        break;
    }
  }

  /** A node's respawn budget is exhausted -- unlike a transient error-log
   * spike (see noteError), nothing will bring it back on its own. Folds
   * every dead node this flow has reported into one "degraded" status
   * (reusing the same FlowStatus kind noteError already uses, so the
   * editor's existing FlowStatusBadge rendering picks this up for free) —
   * left alone if the flow isn't currently running/degraded, since there's
   * no pid/since to attach the status to in that case. */
  private noteNodeDead(rt: FlowRuntime, nodeId: string): void {
    rt.deadNodeIds.add(nodeId);
    this.logBuffer.push({
      level: "error",
      msg: "node.dead",
      meta: { nodeId },
      at: Date.now(),
      flow: rt.flowName,
    });
    if (rt.status.kind !== "running" && rt.status.kind !== "degraded") return;
    this.setStatus(rt, {
      kind: "degraded",
      pid: rt.status.pid,
      since: rt.status.since,
      reason: `node(s) permanently dead (respawn limit exceeded): ${[...rt.deadNodeIds].join(", ")}`,
    });
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

  /** Rejects (and removes) every pendingFires/pendingEntityQueries entry
   * that was sent to this flow's now-dead subprocess — otherwise a
   * flow.fireNode or entity-query request racing a crash (or even a
   * deliberate restart/stop, since this subprocess is gone either way)
   * hangs forever with no reply ever sent back to the browser. Called from
   * onExit(), which fires whenever the subprocess actually exits,
   * regardless of whether that exit was expected. */
  private rejectPending(rt: FlowRuntime): void {
    const error = "flow-host exited before responding";
    for (const [id, pending] of this.pendingFires) {
      if (pending.flowName !== rt.flowName) continue;
      this.pendingFires.delete(id);
      pending.resolve({ ok: false, error });
    }
    for (const [id, pending] of this.pendingEntityQueries) {
      if (pending.flowName !== rt.flowName) continue;
      this.pendingEntityQueries.delete(id);
      pending.resolve({ ok: false, error });
    }
  }

  private onExit(
    rt: FlowRuntime,
    exitCode: number | null,
    signalCode: string | null,
  ): void {
    this.rejectPending(rt);
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

  /** Sends "shutdown", waits (up to 3s) for a graceful exit, force-kills
   * otherwise. Shared by restartFlow (which respawns after) and stopFlow
   * (which doesn't). */
  private async shutdownCurrent(rt: FlowRuntime): Promise<void> {
    if (!rt.subprocess) return;
    rt.expectingExit = true;
    // A deliberate restart/stop should abort this flow's in-flight agent
    // calls immediately, rather than waiting for the flow-host's 3s grace
    // period (or the call's own timeout) to eventually notice nobody's
    // listening for the result anymore.
    this.aiHostClient.cancelForFlow(rt.flowName);
    rt.subprocess.send({ type: "shutdown" } satisfies CoordinatorToFlowHost);
    const exitedInTime = await Promise.race([
      rt.subprocess.exited.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!exitedInTime) rt.subprocess.kill("SIGKILL");
  }

  /** Reload path — caller (main.ts) has already run and passed the typecheck gate. */
  async restartFlow(flowName: string): Promise<void> {
    const rt = this.flows.get(flowName);
    if (!rt) return;
    rt.crashTimestamps = []; // a deliberate, successful reload earns a fresh crash-loop window
    await this.shutdownCurrent(rt);
    this.setStatus(rt, { kind: "starting" });
    this.spawn(rt);
  }

  /** Stops a flow's subprocess and forgets it entirely (unlike restartFlow,
   * doesn't respawn) — used when its wiring file is deleted from disk. */
  async stopFlow(flowName: string): Promise<void> {
    const rt = this.flows.get(flowName);
    if (!rt) return;
    await this.shutdownCurrent(rt);
    this.flows.delete(flowName);
  }

  /** Relays a manual @core/inject fire (from the editor's canvas button) to the owning flow-host, awaiting its ack. */
  fireNode(
    flowName: string,
    nodeId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const rt = this.flows.get(flowName);
    if (!rt?.subprocess) {
      return Promise.resolve({
        ok: false,
        error: `flow "${flowName}" is not running`,
      });
    }
    const requestId = this.nextFireRequestId++;
    rt.subprocess.send({
      type: "flow.fireNode",
      requestId,
      nodeId,
    } satisfies CoordinatorToFlowHost);
    return new Promise((resolve) => {
      this.pendingFires.set(requestId, { flowName: rt.flowName, resolve });
    });
  }

  /** Asks whichever flow-host happens to be running to answer "what HA
   * entities exist" — this coordinator holds no HA connection of its own
   * (see hass/client.ts, and worker-manager.ts's own doc comment on why
   * every @hass/* node now opens its own independent connection). Degrades
   * gracefully to an empty list, not an error, when no flow is running —
   * this backs only the editor's entity autocomplete and the chat/agent's
   * `hass_entities` MCP tool, neither of which is on any node's real
   * execution path. */
  queryHassEntities(): Promise<HassEntitySummary[]> {
    const rt = [...this.flows.values()].find(
      (r) => r.subprocess && r.status.kind === "running",
    );
    if (!rt?.subprocess) return Promise.resolve([]);
    const requestId = this.nextEntityQueryRequestId++;
    rt.subprocess.send({
      type: "hass.entities.query",
      requestId,
    } satisfies CoordinatorToFlowHost);
    return new Promise((resolve) => {
      this.pendingEntityQueries.set(requestId, {
        flowName: rt.flowName,
        resolve: (result) => resolve(result.ok ? result.entities : []),
      });
    });
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

  private setStatus(rt: FlowRuntime, status: FlowStatus): void {
    rt.status = status;
    console.log(
      `[coordinator] flow "${rt.flowName}" status:`,
      JSON.stringify(status),
    );
    this.onStatusChange?.(rt.flowName, status);
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
