import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../block";
import type { HttpInConfig, HttpInRequest } from "./in";
import { answerHttpRequest, startHttpIn, streamHttpChunk } from "./in";

const silentLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function config(overrides: Partial<HttpInConfig> = {}): HttpInConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    path: "",
    token: "",
    replyTimeoutMs: 5_000,
    ...overrides,
  };
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

async function start(
  cfg: HttpInConfig,
  onRequest: (r: HttpInRequest) => void,
): Promise<number> {
  const { stop, port } = await startHttpIn(cfg, silentLog, onRequest);
  stops.push(stop);
  return port;
}

describe("startHttpIn / answerHttpRequest", () => {
  test("round-trips a JSON request through emit and reply", async () => {
    const port = await start(config(), (req) => {
      expect(req.method).toBe("POST");
      expect(req.body).toEqual({ text: "hello" });
      answerHttpRequest({
        requestId: req.requestId,
        body: { echoed: req.body },
      });
    });
    const res = await fetch(`http://127.0.0.1:${port}/converse?a=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ echoed: { text: "hello" } });
  });

  test("query params and path reach the emitted request", async () => {
    let seen: HttpInRequest | undefined;
    const port = await start(config(), (req) => {
      seen = req;
      answerHttpRequest({ requestId: req.requestId });
    });
    await fetch(`http://127.0.0.1:${port}/some/path?foo=bar&n=2`);
    expect(seen?.path).toBe("/some/path");
    expect(seen?.query).toEqual({ foo: "bar", n: "2" });
    expect(seen?.body).toBeUndefined();
  });

  test("string reply body is sent as text/plain, custom status honored", async () => {
    const port = await start(config(), (req) => {
      answerHttpRequest({ requestId: req.requestId, status: 201, body: "ok" });
    });
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("ok");
  });

  test("path filter 404s everything else without emitting", async () => {
    let emitted = 0;
    const port = await start(config({ path: "/converse" }), () => {
      emitted++;
    });
    const res = await fetch(`http://127.0.0.1:${port}/other`);
    expect(res.status).toBe(404);
    expect(emitted).toBe(0);
  });

  test("bearer token gates requests without emitting", async () => {
    let emitted = 0;
    const port = await start(config({ token: "s3cret" }), (req) => {
      emitted++;
      answerHttpRequest({ requestId: req.requestId });
    });
    const denied = await fetch(`http://127.0.0.1:${port}/`);
    expect(denied.status).toBe(401);
    const wrong = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    expect(emitted).toBe(0);
    const allowed = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(allowed.status).toBe(200);
    expect(emitted).toBe(1);
  });

  test("malformed JSON body is a 400, never emitted", async () => {
    let emitted = 0;
    const port = await start(config(), () => {
      emitted++;
    });
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(emitted).toBe(0);
  });

  test("non-JSON body arrives as raw text", async () => {
    let seenBody: unknown;
    const port = await start(config(), (req) => {
      seenBody = req.body;
      answerHttpRequest({ requestId: req.requestId });
    });
    await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "plain words",
    });
    expect(seenBody).toBe("plain words");
  });

  test("no reply within replyTimeoutMs answers 504", async () => {
    const port = await start(config({ replyTimeoutMs: 50 }), () => {
      // deliberately never reply
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("50ms");
  });

  test("a reply after the timeout reports unknown requestId", async () => {
    let lateId = "";
    const port = await start(config({ replyTimeoutMs: 30 }), (req) => {
      lateId = req.requestId;
    });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(504);
    expect(answerHttpRequest({ requestId: lateId })).toBe(false);
  });

  test("chunks stream as NDJSON delta lines closed by the reply's done line", async () => {
    const port = await start(config(), (req) => {
      expect(streamHttpChunk({ requestId: req.requestId, text: "Hel" })).toBe(
        true,
      );
      expect(streamHttpChunk({ requestId: req.requestId, text: "lo." })).toBe(
        true,
      );
      answerHttpRequest({
        requestId: req.requestId,
        body: { text: "Hello.", conversation_id: "c1" },
      });
    });
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { delta: "Hel" },
      { delta: "lo." },
      {
        done: true,
        status: 200,
        body: { text: "Hello.", conversation_id: "c1" },
      },
    ]);
  });

  test("a request that never chunks answers plain JSON exactly as before", async () => {
    const port = await start(config(), (req) => {
      answerHttpRequest({ requestId: req.requestId, body: { text: "hi" } });
    });
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ text: "hi" });
  });

  test("timeout mid-stream ends the NDJSON body with an in-band error line", async () => {
    const port = await start(config({ replyTimeoutMs: 80 }), (req) => {
      streamHttpChunk({ requestId: req.requestId, text: "partial" });
      // ...and no final reply ever arrives.
    });
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST" });
    expect(res.status).toBe(200); // status went out with the first chunk
    const lines = (await res.text())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toEqual({ delta: "partial" });
    expect(lines[1]?.error).toContain("no final reply");
  });

  test("a chunk for an unknown/settled requestId returns false", () => {
    expect(streamHttpChunk({ requestId: "nope", text: "x" })).toBe(false);
  });

  test("unknown requestId returns false", () => {
    expect(answerHttpRequest({ requestId: "nope" })).toBe(false);
  });

  test("stop() answers still-pending requests with 503", async () => {
    let stopFn: (() => void) | undefined;
    const { stop, port } = await startHttpIn(
      config({ replyTimeoutMs: 60_000 }),
      silentLog,
      () => {
        // don't reply; stop the server while the request is held open
        queueMicrotask(() => stopFn?.());
      },
    );
    stopFn = stop;
    stops.push(stop);
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(503);
  });

  test("rejects a nonsense port instead of silently serving elsewhere", async () => {
    expect(
      startHttpIn(config({ port: 99999 }), silentLog, () => {}),
    ).rejects.toThrow("invalid port");
  });

  test("two concurrent requests correlate independently", async () => {
    const seen: HttpInRequest[] = [];
    const port = await start(config(), (req) => {
      seen.push(req);
      if (seen.length === 2) {
        // Answer in reverse arrival order to prove correlation is by id,
        // not ordering.
        for (const r of [...seen].reverse()) {
          answerHttpRequest({ requestId: r.requestId, body: r.body });
        }
      }
    });
    const [a, b] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ who: "a" }),
      }),
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ who: "b" }),
      }),
    ]);
    expect(await a.json()).toEqual({ who: "a" });
    expect(await b.json()).toEqual({ who: "b" });
  });
});
