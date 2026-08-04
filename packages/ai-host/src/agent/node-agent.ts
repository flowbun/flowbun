import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { StateScope } from "flowbun";
import { makeStateScope, openStateDb } from "flowbun";
import type {
  AgentCallKind,
  AgentConfig,
  AgentHassConfig,
  AnyAgentConfig,
} from "flowbun/ai/agent";
import {
  DEFAULT_FULL_ACCESS_MAX_TURNS,
  DEFAULT_FULL_ACCESS_TIMEOUT_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
} from "flowbun/ai/agent";
import { hasClaudeCredentials } from "./auth";
import {
  createHassAgentMcpServer,
  type MutableHassHooks,
} from "./hass-mcp-server";
import { createAgentMcpServer, type ToolCaller } from "./mcp-server";

export type AgentCallResult =
  | {
      ok: true;
      text: string;
      costUsd: number;
      durationMs: number;
      numTurns: number;
    }
  | { ok: false; error: string };

export interface AgentNodeCaller {
  call(
    flowName: string,
    nodeId: string,
    input: unknown,
    config: AnyAgentConfig,
    agentKind?: AgentCallKind,
    deviceId?: string,
    /** Streamed pieces of the answer text, called zero or more times
     * before the returned promise settles — only "hass" calls stream
     * (includePartialMessages is enabled for them alone), and pieces are
     * batched on a short timer (see deltaFlushMs) so a fast token stream
     * doesn't become an IPC message per token. */
    onDelta?: (text: string) => void,
  ): Promise<AgentCallResult>;
  /** Aborts every in-flight call belonging to `flowName` — called when that
   * flow's flow-host is about to be killed for a restart/stop, so a call
   * whose result nobody will ever receive doesn't keep running (and
   * costing real API tokens) in the background. */
  cancelForFlow(flowName: string): void;
}

export interface AgentNodeCallerOptions {
  claudeConfigDir: string;
  /** Pinned cwd for every query() call — see runner.ts's own note on why
   * this must stay stable. */
  cwd: string;
  /** The data directory — needed by the "hass" toolset's timer tools,
   * which read/write the shared SQLite state DB (<dataDir>/state/
   * flowbun.sqlite, WAL — the same file every flow-host and worker already
   * opens concurrently) so timers land in the owning flow's state scope,
   * where voice_gate and timer_watchdog look for them. Defaults to `cwd`,
   * which main.ts pins to DATA_DIR anyway. */
  dataDir?: string;
  /** How long the SDK's message stream may go COMPLETELY silent mid-call
   * before the call is declared stalled — the CLI subprocess is killed and
   * the request automatically retried once on a fresh session. Distinct
   * from the per-turn timeout: a busy turn keeps emitting messages (tool
   * use, assistant chunks) and never trips this; only a genuinely hung SDK
   * does. Disabled for fullAccess calls, whose long Bash/WebFetch tool runs
   * are legitimately silent. Default DEFAULT_STALL_TIMEOUT_MS; tests inject
   * a tiny value. */
  stallTimeoutMs?: number;
  /** Streamed text deltas are accumulated and flushed to onDelta at most
   * once per this interval — token-level events arrive every few dozen ms,
   * and each flush costs three IPC hops plus a router fan-out downstream.
   * Default DEFAULT_DELTA_FLUSH_MS; tests inject a tiny value. */
  deltaFlushMs?: number;
}

type QueryFn = typeof query;

function promptFromInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? null);
}

// A hot session is recycled (torn down so the next call boots fresh) after
// this many user turns — the session's conversation history is real context
// that grows every turn, and an unbounded session eventually gets slow and
// expensive, which is exactly what persistSession exists to avoid. 50 turns
// is hours of household voice use; one slow boot-turn per 50 is a fine trade.
const HOT_SESSION_MAX_USER_TURNS = 50;
// And torn down after sitting idle this long — a household asleep overnight
// shouldn't keep a CLI subprocess pinned for no one.
const HOT_SESSION_IDLE_MS = 60 * 60_000;

// See AgentNodeCallerOptions.stallTimeoutMs. 12s comfortably clears a cold
// SDK boot (~4-5s to the first system message) and any bounded MCP tool
// round-trip, while still leaving room for a fresh-session retry to finish
// inside a voice flow's ~25s reply budget.
export const DEFAULT_STALL_TIMEOUT_MS = 12_000;

// See AgentNodeCallerOptions.deltaFlushMs. 120ms is far below anything a
// listener could perceive (HA's streaming TTS only engages after ~60 chars
// anyway) while collapsing a per-few-tokens event stream ~5-10x.
export const DEFAULT_DELTA_FLUSH_MS = 120;

/** Extracts the answer-text piece from one SDK message, or null for
 * anything that isn't a top-level assistant text delta (tool-use deltas,
 * thinking deltas, subagent streams, lifecycle events). Requires
 * includePartialMessages on the query — without it no stream_event
 * messages exist and streaming silently never happens. */
// biome-ignore lint/suspicious/noExplicitAny: same wide-SDK-union narrowing as resultFromMessage below
function textDeltaFromMessage(message: any): string | null {
  if (message?.type !== "stream_event" || message.parent_tool_use_id) {
    return null;
  }
  const event = message.event;
  if (event?.type !== "content_block_delta") return null;
  return event.delta?.type === "text_delta" &&
    typeof event.delta.text === "string"
    ? event.delta.text
    : null;
}

/** Time-batches delta text: pieces accumulate and flush to onDelta at most
 * once per flushMs. flush() is also called directly before a result is
 * returned, so the tail of the answer is never left behind on a timer that
 * would outlive the call. */
function makeDeltaBatcher(
  onDelta: (text: string) => void,
  flushMs: number,
): { push: (text: string) => void; flush: () => void } {
  let buf = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf) {
      const text = buf;
      buf = "";
      onDelta(text);
    }
  };
  return {
    push: (text) => {
      buf += text;
      timer ??= setTimeout(flush, flushMs);
    },
    flush,
  };
}

/** Thrown by the read loops when the stream stalls; call() keys its
 * retry-once behavior off this marker string, so keep it distinctive. */
const STALL_MARKER = "no SDK activity for";

function stallError(nodeId: string, stallMs: number): Error {
  return new Error(
    `agent node "${nodeId}" stalled: ${STALL_MARKER} ${stallMs}ms — killing the session`,
  );
}

const STALLED = Symbol("stalled");

/** Races one stream read against the stall clock. The clock only ever runs
 * while a read is pending — every message that arrives starts a fresh race —
 * which is exactly "restart if the SDK stops responding", not "restart if
 * the turn is slow". */
function raceStall<T>(
  read: Promise<T>,
  stallMs: number,
): Promise<T | typeof STALLED> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(STALLED), stallMs);
    read.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * One live streaming-input query() session, kept warm across calls. The
 * whole point: the SDK's per-call overhead (CLI subprocess boot, MCP
 * handshake, system-prompt processing) is paid once at creation, and every
 * later turn is just push-a-message / read-until-result — measured at
 * roughly 3-4s saved per voice-assistant turn.
 *
 * The flip side, documented rather than hidden: a hot session is ONE
 * conversation. Every turn shares the session's accumulated history —
 * across satellites, across HA conversation_ids. For a household voice
 * assistant that's usually a feature; a node that needs strictly isolated
 * calls should leave persistSession off.
 */
interface HotSession {
  fingerprint: string;
  abortController: AbortController;
  push(text: string): void;
  stream: AsyncGenerator<unknown, void>;
  busy: boolean;
  userTurns: number;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  untrack: () => void;
  /** The hass toolset's per-call context (see MutableHassHooks) — the
   * session's MCP server closes over this ref once at creation, and each
   * hotCall updates `current.deviceId` before pushing its prompt. Unused
   * (but harmlessly present) for "full" sessions. */
  hooks: MutableHassHooks;
}

/**
 * Owns every flow node's @ai/agent calls. Deliberately independent of
 * runner.ts's chat AgentRunner: no shared session, no shared busy flag, no
 * `resume` — every call is a fresh, ephemeral session, so flow-node calls
 * run concurrently with each other and with an interactive chat turn
 * instead of queuing behind one global flag.
 */
export function createAgentNodeCaller(
  opts: AgentNodeCallerOptions,
  callTool: ToolCaller,
  queryFn: QueryFn = query,
): AgentNodeCaller {
  const controllersByFlow = new Map<string, Set<AbortController>>();
  const hotSessions = new Map<string, HotSession>();

  // One shared connection to the same WAL-mode SQLite file every flow-host
  // already has open — opened lazily so an ai-host that never runs a hass
  // agent never touches it.
  let stateDb: ReturnType<typeof openStateDb> | null = null;
  function flowStateScope(flowName: string): StateScope {
    if (!stateDb) {
      // openStateDb creates the file but not its directory — and on a
      // fresh deployment this process can win the race against the first
      // flow-host that would otherwise have created it.
      const stateDir = join(opts.dataDir ?? opts.cwd, "state");
      mkdirSync(stateDir, { recursive: true });
      stateDb = openStateDb(join(stateDir, "flowbun.sqlite"));
    }
    return makeStateScope(stateDb, "flow", flowName);
  }

  /** fullAccess is an @ai/agent-only concept — a "hass" call never has it,
   * whatever its config JSON might claim. */
  function isFullAccess(config: AnyAgentConfig, kind: AgentCallKind): boolean {
    return kind === "full" && (config as AgentConfig).fullAccess === true;
  }

  function makeHassHooks(
    kind: AgentCallKind,
    flowName: string,
    deviceId: string | undefined,
  ): MutableHassHooks {
    return {
      current: {
        ...(kind === "hass" ? { flowState: flowStateScope(flowName) } : {}),
        ...(deviceId === undefined ? {} : { deviceId }),
      },
    };
  }

  function track(flowName: string, controller: AbortController): () => void {
    let set = controllersByFlow.get(flowName);
    if (!set) {
      set = new Set();
      controllersByFlow.set(flowName, set);
    }
    set.add(controller);
    return () => {
      set?.delete(controller);
      if (set?.size === 0) controllersByFlow.delete(flowName);
    };
  }

  function destroyHotSession(key: string, session: HotSession): void {
    session.dead = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.abortController.abort();
    session.untrack();
    if (hotSessions.get(key) === session) hotSessions.delete(key);
  }

  function cancelForFlow(flowName: string): void {
    for (const [key, session] of hotSessions) {
      if (key.startsWith(`${flowName}::`)) destroyHotSession(key, session);
    }
    const set = controllersByFlow.get(flowName);
    if (!set) return;
    for (const controller of set) controller.abort();
    controllersByFlow.delete(flowName);
  }

  function buildQueryOptions(
    config: AnyAgentConfig,
    maxTurns: number,
    abortController: AbortController,
    kind: AgentCallKind,
    hassHooks: MutableHassHooks,
  ): Options {
    if (kind === "hass") {
      // @ai/agent-hass: only the hass/timer MCP toolset (in-process — see
      // hass-mcp-server.ts), and the configured systemPrompt VERBATIM as
      // the whole system prompt (no claude_code preset preamble) —
      // deliberately mirroring what @ai/openai_agent sends its server.
      const c = config as AgentHassConfig;
      return {
        cwd: opts.cwd,
        model: c.model || undefined,
        maxTurns,
        abortController,
        tools: [],
        // Emits stream_event messages carrying token-level text deltas —
        // what the delta streaming below (textDeltaFromMessage) feeds on.
        includePartialMessages: true,
        mcpServers: {
          hass: createHassAgentMcpServer(
            {
              enableHassTools: c.enableHassTools === true,
              enableTimerTools: c.enableTimerTools === true,
            },
            hassHooks,
          ),
        },
        allowedTools: ["mcp__hass__*"],
        systemPrompt: c.systemPrompt,
      };
    }
    const full = config as AgentConfig;
    // MCP server fresh per query() — see mcp-server.ts's own comment on why
    // a shared instance would throw on the second concurrent connect.
    const mcpServer = createAgentMcpServer(callTool);
    return {
      cwd: opts.cwd,
      model: full.model || undefined,
      maxTurns,
      abortController,
      // Bounded mode still gets the flowbun MCP tools (same scope as
      // the interactive chat agent) — only fullAccess additionally
      // inherits the SDK's full built-in tool set (Bash/Read/Write/
      // Edit/WebFetch/WebSearch/...) by omitting `tools` entirely.
      ...(full.fullAccess ? {} : { tools: [] }),
      mcpServers: { flowbun: mcpServer },
      allowedTools: ["mcp__flowbun__*"],
      ...(full.fullAccess
        ? {
            permissionMode: "bypassPermissions" as const,
            allowDangerouslySkipPermissions: true,
          }
        : {}),
      systemPrompt: {
        type: "preset" as const,
        preset: "claude_code" as const,
        append: full.systemPrompt,
      },
    };
  }

  /** Maps one SDK message to a settled AgentCallResult, or null for any
   * intermediate message — shared by the one-shot consume loop and the hot
   * session's read-until-result loop. */
  // biome-ignore lint/suspicious/noExplicitAny: the SDK message union is wide; both call sites narrow on .type/.subtype exactly like the pre-hot-session code did
  function resultFromMessage(message: any): AgentCallResult | null {
    if (message?.type !== "result") return null;
    if (message.subtype === "success") {
      return {
        ok: true,
        text: message.result,
        costUsd: message.total_cost_usd,
        durationMs: message.duration_ms,
        numTurns: message.num_turns,
      };
    }
    return {
      ok: false,
      error: message.errors?.join("; ") || message.subtype,
    };
  }

  function turnTimeout(
    nodeId: string,
    timeoutMs: number,
    abortController: AbortController,
  ): { promise: Promise<never>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abortController.abort();
        reject(
          new Error(`agent node "${nodeId}" timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
    });
    // A rejected-but-raceless timeout must never surface as an unhandled
    // rejection (the hot path cancels it after a fast result).
    promise.catch(() => {});
    return { promise, cancel: () => clearTimeout(timer) };
  }

  async function oneShotCall(
    flowName: string,
    nodeId: string,
    promptText: string,
    config: AnyAgentConfig,
    timeoutMs: number,
    maxTurns: number,
    kind: AgentCallKind,
    deviceId: string | undefined,
    onDelta?: (text: string) => void,
  ): Promise<AgentCallResult> {
    const abortController = new AbortController();
    const untrack = track(flowName, abortController);

    try {
      const stream = queryFn({
        prompt: promptText,
        options: buildQueryOptions(
          config,
          maxTurns,
          abortController,
          kind,
          makeHassHooks(kind, flowName, deviceId),
        ),
      });

      const batcher = onDelta
        ? makeDeltaBatcher(onDelta, opts.deltaFlushMs ?? DEFAULT_DELTA_FLUSH_MS)
        : null;
      // fullAccess turns run long, legitimately silent tools (Bash,
      // WebFetch) — the stall watchdog only guards bounded calls.
      const stallMs = isFullAccess(config, kind)
        ? 0
        : (opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
      const timeout = turnTimeout(nodeId, timeoutMs, abortController);
      const consume = (async (): Promise<AgentCallResult> => {
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const next = stallMs
            ? await raceStall(iterator.next(), stallMs)
            : await iterator.next();
          if (next === STALLED) {
            abortController.abort();
            throw stallError(nodeId, stallMs);
          }
          if (next.done) {
            return { ok: false, error: "agent stream ended without a result" };
          }
          if (batcher) {
            const piece = textDeltaFromMessage(next.value);
            if (piece !== null) batcher.push(piece);
          }
          const settled = resultFromMessage(next.value);
          if (settled) {
            batcher?.flush();
            return settled;
          }
        }
      })();
      // If `timeout` wins the race, `consume` is still running in the
      // background against an aborted stream — it will settle (resolve or
      // reject) once the abort propagates, but by then nothing awaits it;
      // this swallows that so it can never surface as an unhandled
      // rejection.
      consume.catch(() => {});

      try {
        return await Promise.race([consume, timeout.promise]);
      } finally {
        timeout.cancel();
      }
    } catch (err) {
      return { ok: false, error: String(err) };
    } finally {
      untrack();
    }
  }

  function createHotSession(
    flowName: string,
    fingerprint: string,
    config: AnyAgentConfig,
    maxTurns: number,
    kind: AgentCallKind,
  ): HotSession {
    const abortController = new AbortController();
    const untrack = track(flowName, abortController);
    const hooks = makeHassHooks(kind, flowName, undefined);

    const queue: string[] = [];
    let notify: (() => void) | null = null;
    async function* userMessages(): AsyncGenerator<SDKUserMessage> {
      while (!abortController.signal.aborted) {
        while (queue.length === 0 && !abortController.signal.aborted) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        if (abortController.signal.aborted) return;
        const text = queue.shift() as string;
        yield {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
          session_id: "",
        } as unknown as SDKUserMessage;
      }
    }

    const stream = queryFn({
      prompt: userMessages(),
      options: buildQueryOptions(
        config,
        // In streaming-input mode the SDK counts turns across the whole
        // session, not per pushed message — scaled by the session's own
        // user-turn budget so a healthy session never trips it, while a
        // runaway single turn is still bounded by the per-turn timeout
        // abort below.
        maxTurns * HOT_SESSION_MAX_USER_TURNS,
        abortController,
        kind,
        hooks,
      ),
    }) as AsyncGenerator<unknown, void>;

    return {
      fingerprint,
      abortController,
      push: (text) => {
        queue.push(text);
        notify?.();
        notify = null;
      },
      stream,
      busy: false,
      userTurns: 0,
      dead: false,
      idleTimer: null,
      untrack,
      hooks,
    };
  }

  async function hotCall(
    flowName: string,
    nodeId: string,
    promptText: string,
    config: AnyAgentConfig,
    timeoutMs: number,
    maxTurns: number,
    kind: AgentCallKind,
    deviceId: string | undefined,
    onDelta?: (text: string) => void,
  ): Promise<AgentCallResult> {
    const key = `${flowName}::${nodeId}`;
    const fingerprint = JSON.stringify({ kind, config });

    let session = hotSessions.get(key);
    if (session?.busy) {
      // A second call while a turn is in flight (shouldn't happen from one
      // flow node — the router serializes — but don't build on that): leave
      // the hot session alone and answer this one cold.
      return oneShotCall(
        flowName,
        nodeId,
        promptText,
        config,
        timeoutMs,
        maxTurns,
        kind,
        deviceId,
        onDelta,
      );
    }
    if (session && (session.dead || session.fingerprint !== fingerprint)) {
      destroyHotSession(key, session);
      session = undefined;
    }
    if (!session) {
      session = createHotSession(flowName, fingerprint, config, maxTurns, kind);
      hotSessions.set(key, session);
    }

    session.busy = true;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    // The session's MCP server reads hooks through this ref at invocation
    // time — refresh the per-call satellite id before the prompt lands.
    session.hooks.current.deviceId = deviceId;
    const timeout = turnTimeout(nodeId, timeoutMs, session.abortController);
    try {
      session.push(promptText);
      const batcher = onDelta
        ? makeDeltaBatcher(onDelta, opts.deltaFlushMs ?? DEFAULT_DELTA_FLUSH_MS)
        : null;
      const stallMs = isFullAccess(config, kind)
        ? 0
        : (opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS);
      const readUntilResult = (async (): Promise<AgentCallResult> => {
        while (true) {
          const next = stallMs
            ? await raceStall(session.stream.next(), stallMs)
            : await session.stream.next();
          if (next === STALLED) throw stallError(nodeId, stallMs);
          if (next.done) {
            return { ok: false, error: "agent stream ended without a result" };
          }
          if (batcher) {
            const piece = textDeltaFromMessage(next.value);
            if (piece !== null) batcher.push(piece);
          }
          const settled = resultFromMessage(next.value);
          if (settled) {
            batcher?.flush();
            return settled;
          }
        }
      })();
      readUntilResult.catch(() => {});

      const result = await Promise.race([readUntilResult, timeout.promise]);
      session.userTurns++;
      if (!result.ok || session.userTurns >= HOT_SESSION_MAX_USER_TURNS) {
        // Any per-turn failure poisons the shared stream state — recycle
        // rather than risk the next turn reading this one's leftovers. The
        // turn-budget recycle is just context hygiene (see HotSession's
        // own doc comment).
        destroyHotSession(key, session);
      }
      return result;
    } catch (err) {
      destroyHotSession(key, session);
      return { ok: false, error: String(err) };
    } finally {
      timeout.cancel();
      session.busy = false;
      if (!session.dead) {
        session.idleTimer = setTimeout(() => {
          const current = hotSessions.get(key);
          if (current && !current.busy) destroyHotSession(key, current);
        }, HOT_SESSION_IDLE_MS);
        // Bun supports unref on timers — an idle hot session must never be
        // the thing keeping the ai-host process (or a test run) alive.
        (session.idleTimer as unknown as { unref?: () => void }).unref?.();
      }
    }
  }

  async function call(
    flowName: string,
    nodeId: string,
    input: unknown,
    config: AnyAgentConfig,
    agentKind: AgentCallKind = "full",
    deviceId?: string,
    onDelta?: (text: string) => void,
  ): Promise<AgentCallResult> {
    if (!hasClaudeCredentials(opts.claudeConfigDir)) {
      return {
        ok: false,
        error:
          "Claude isn't set up yet. Run once: ./scripts/setup-claude-auth.sh",
      };
    }

    const full = isFullAccess(config, agentKind);
    const timeoutMs =
      config.timeoutMs ||
      (full ? DEFAULT_FULL_ACCESS_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const maxTurns =
      config.maxTurns ||
      (full ? DEFAULT_FULL_ACCESS_MAX_TURNS : DEFAULT_MAX_TURNS);
    const promptText = promptFromInput(input);

    const attempt = () =>
      config.persistSession
        ? hotCall(
            flowName,
            nodeId,
            promptText,
            config,
            timeoutMs,
            maxTurns,
            agentKind,
            deviceId,
            onDelta,
          )
        : oneShotCall(
            flowName,
            nodeId,
            promptText,
            config,
            timeoutMs,
            maxTurns,
            agentKind,
            deviceId,
            onDelta,
          );

    const result = await attempt();
    // A stall means the SDK subprocess hung, not that the request was hard —
    // the hung session is already dead (aborted by the read loop / hotCall's
    // catch), so one automatic retry on a fresh session is the "restart it"
    // behavior, and usually turns a would-be spoken failure into a normal
    // answer. Slow-but-alive turns (per-turn timeout) are NOT retried: those
    // failed because the work itself exceeded its budget.
    if (!result.ok && result.error.includes(STALL_MARKER)) {
      return attempt();
    }
    return result;
  }

  return { call, cancelForFlow };
}
