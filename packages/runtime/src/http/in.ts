import type { Logger } from "../block";

/**
 * Config for @http/in — the generic "listen for HTTP on a port" boundary
 * block (Node-RED's http-in + http-response pair collapsed into one duplex
 * block; see block.ts's DuplexBlockDef doc comment for why it must be one
 * node). The server runs inside the node's own Worker, i.e. in the flow's
 * process tree — never in the coordinator — so one flow's endpoint dying,
 * restarting, or hanging can't take any other flow's endpoint with it.
 */
export interface HttpInConfig {
  /** TCP port to listen on. 0 picks a free port (useful only for tests —
   * a real deployment wants a stable, documented port). */
  port: number;
  /** Bind address. Default "0.0.0.0" — inside the container this must be
   * reachable by whatever calls it (e.g. Home Assistant), so remember to
   * publish the port in docker-compose too. */
  hostname: string;
  /** If non-empty, only this exact URL pathname is accepted; anything else
   * gets a 404 without ever reaching the flow. */
  path: string;
  /** If non-empty, callers must send "Authorization: Bearer <token>";
   * anything else gets a 401 without ever reaching the flow. */
  token: string;
  /** How long to hold a request open waiting for the flow to wire a message
   * back into the block's `reply` input before answering 504. */
  replyTimeoutMs: number;
}

export interface HttpInRequest {
  /** Correlation handle: a reply message must carry this exact id back. */
  requestId: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed JSON when the request's content-type is application/json (an
   * unparseable body is a 400, never emitted); raw text otherwise;
   * undefined when there's no body (GET etc.). */
  body: unknown;
}

export interface HttpInReply {
  requestId: string;
  /** Default 200. */
  status?: number;
  headers?: Record<string, string>;
  /** An object/array body is JSON-serialized with an application/json
   * content-type; a string is sent verbatim as text/plain; undefined sends
   * an empty body. */
  body?: unknown;
}

/**
 * One streamed piece of a reply, delivered on the block's `chunk` input
 * BEFORE the final `reply` message with the same requestId. The first chunk
 * for a request switches its held-open response into streaming mode: 200
 * with content-type application/x-ndjson, one `{"delta": <text>}` line per
 * chunk, closed by a final `{"done": true, "status": ..., "body": ...}`
 * line when the `reply` message lands (its status can no longer change the
 * HTTP status line at that point — it rides in the done line instead).
 * A request that never receives a chunk answers exactly as before, so
 * callers that don't know about streaming see no difference.
 */
export interface HttpInChunk {
  requestId: string;
  text: string;
}

interface PendingRequest {
  /** Hands a Response to the held-open fetch() — no bookkeeping. In
   * streaming mode this is called ONCE, at the first chunk, with the
   * streaming Response; the entry then stays pending until the final
   * reply/timeout so later chunks still find it. */
  deliver: (res: Response) => void;
  /** Clears the timeout and removes the entry from `pending` — every
   * terminal path (normal reply, streamed done-line, timeout, shutdown)
   * must end in exactly one finish(). */
  finish: () => void;
  /** Set once the first chunk arrives — see HttpInChunk. */
  stream?: { write: (line: string) => void; close: () => void };
}

// Module-level, keyed by UUID rather than held per-server: process() (the
// reply side) and subscribe() (the server side) are separate hooks on the
// block def with no shared instance object, but they always run in the same
// module instance — one Worker per node in the real topology. Keying by
// random UUID keeps this correct even if several @http/in nodes ever share
// one module registry (the in-process topology): a reply can only ever find
// the request that minted its id.
const pending = new Map<string, PendingRequest>();

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function parseBody(
  req: Request,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  if (req.method === "GET" || req.method === "HEAD") {
    return { ok: true, body: undefined };
  }
  const contentType = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (text === "") return { ok: true, body: undefined };
  if (contentType.includes("application/json")) {
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch {
      return { ok: false, error: "request body is not valid JSON" };
    }
  }
  return { ok: true, body: text };
}

/**
 * Starts the real listener and returns its stop function — the shape
 * blocks/http-in.ts's subscribe() hands straight back to the runtime, same
 * split as hass/trigger.ts vs blocks/hass-trigger.ts. `emitRequest` is
 * called once per accepted request; the returned promise held open inside
 * fetch() resolves when answerHttpRequest() below is handed the matching
 * requestId (or the timeout fires first).
 */
export async function startHttpIn(
  config: HttpInConfig,
  log: Logger,
  emitRequest: (request: HttpInRequest) => void,
): Promise<{ stop: () => void; port: number }> {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new Error(`@http/in: invalid port ${JSON.stringify(config.port)}`);

  const ownRequestIds = new Set<string>();

  const server = Bun.serve({
    port: config.port,
    hostname: config.hostname || "0.0.0.0",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (config.token) {
        if (req.headers.get("authorization") !== `Bearer ${config.token}`) {
          return jsonResponse(401, { error: "unauthorized" });
        }
      }
      if (config.path && url.pathname !== config.path) {
        return jsonResponse(404, { error: "not found" });
      }
      const parsed = await parseBody(req);
      if (!parsed.ok) return jsonResponse(400, { error: parsed.error });

      const requestId = crypto.randomUUID();
      const responsePromise = new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          const entry = pending.get(requestId);
          pending.delete(requestId);
          ownRequestIds.delete(requestId);
          log.warn("http_in.reply_timeout", {
            requestId,
            path: url.pathname,
            timeoutMs: config.replyTimeoutMs,
          });
          if (entry?.stream) {
            // The 200 + NDJSON stream already went out at the first chunk —
            // all that's left is to say why it's ending early, in-band.
            entry.stream.write(
              `${JSON.stringify({
                error: `no final reply from flow within ${config.replyTimeoutMs}ms`,
              })}\n`,
            );
            entry.stream.close();
          } else {
            resolve(
              jsonResponse(504, {
                error: `no reply from flow within ${config.replyTimeoutMs}ms`,
              }),
            );
          }
        }, config.replyTimeoutMs);
        pending.set(requestId, {
          deliver: resolve,
          finish: () => {
            clearTimeout(timer);
            pending.delete(requestId);
            ownRequestIds.delete(requestId);
          },
        });
      });
      ownRequestIds.add(requestId);

      emitRequest({
        requestId,
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: Object.fromEntries(req.headers),
        body: parsed.body,
      });
      return responsePromise;
    },
  });
  log.info("http_in.listening", {
    port: server.port,
    hostname: config.hostname || "0.0.0.0",
    path: config.path || "(any)",
    auth: config.token ? "bearer" : "none",
  });

  return {
    port: server.port ?? config.port,
    stop: () => {
      // Answer everything still in flight before closing — a held-open
      // request outliving its server would otherwise just hang the caller
      // until their own client timeout. The stop itself is graceful (no
      // `true`): a force-close tears the socket down before those 503s can
      // actually flush, so the caller would see ECONNRESET instead.
      for (const requestId of [...ownRequestIds]) {
        const entry = pending.get(requestId);
        if (!entry) continue;
        if (entry.stream) {
          entry.stream.write(
            `${JSON.stringify({ error: "flow shutting down" })}\n`,
          );
          entry.stream.close();
        } else {
          entry.deliver(jsonResponse(503, { error: "flow shutting down" }));
        }
        entry.finish();
      }
      void server.stop();
    },
  };
}

/**
 * The reply side — blocks/http-in.ts's process() forwards its `reply` input
 * here. Returns false when the requestId matches nothing still pending
 * (already timed out, already answered, or plain wrong), which the block
 * logs rather than throws: a late reply is an expected race, not a bug.
 */
export function answerHttpRequest(reply: HttpInReply): boolean {
  const entry = pending.get(reply.requestId);
  if (!entry) return false;

  if (entry.stream) {
    // Streaming mode: the status line went out with the first chunk, so
    // the final status/body ride in the closing done-line instead.
    entry.stream.write(
      `${JSON.stringify({
        done: true,
        status: reply.status ?? 200,
        body: reply.body ?? null,
      })}\n`,
    );
    entry.finish();
    entry.stream.close();
    return true;
  }

  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  let bodyText: string;
  if (reply.body === undefined) {
    bodyText = "";
  } else if (typeof reply.body === "string") {
    bodyText = reply.body;
    headers["content-type"] ??= "text/plain; charset=utf-8";
  } else {
    bodyText = JSON.stringify(reply.body);
    headers["content-type"] ??= "application/json";
  }
  entry.deliver(
    new Response(bodyText, { status: reply.status ?? 200, headers }),
  );
  entry.finish();
  return true;
}

/**
 * The chunk side — blocks/http-in.ts's process() forwards its `chunk` input
 * here. The first chunk for a request delivers the streaming Response (200,
 * application/x-ndjson) and every chunk — first included — writes one
 * `{"delta": <text>}` line. Same false-on-unknown-id contract as
 * answerHttpRequest: a chunk racing a timeout/answer is expected, not a bug.
 */
export function streamHttpChunk(chunk: HttpInChunk): boolean {
  const entry = pending.get(chunk.requestId);
  if (!entry) return false;

  if (!entry.stream) {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    const encoder = new TextEncoder();
    // enqueue/close throw once the client has gone away or the stream is
    // already closed — a disconnect mid-stream must not take the node's
    // Worker down with it, so both swallow. The reply timeout still ends
    // the pending entry's lifecycle either way.
    entry.stream = {
      write: (line) => {
        try {
          controller.enqueue(encoder.encode(line));
        } catch {}
      },
      close: () => {
        try {
          controller.close();
        } catch {}
      },
    };
    entry.deliver(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      }),
    );
  }
  entry.stream.write(`${JSON.stringify({ delta: chunk.text })}\n`);
  return true;
}
