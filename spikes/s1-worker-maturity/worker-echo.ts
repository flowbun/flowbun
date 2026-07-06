// worker-echo.ts
//
// Shared "echo" worker used by several spike tests. Simulates the kind of
// trivial block-instance worker Flowbun would run: it receives a message
// envelope, does a cheap transform, and posts back a reply. It also
// supports a few special command payloads used by other tests (throw,
// infinite loop, idle/no-op) so we don't need five almost-identical files.
//
// Envelope shape (matches the real Flowbun message envelope):
//   { type: string, at: number, payload: unknown }

export type Envelope = {
  type: string;
  at: number;
  payload: unknown;
};

self.onmessage = (event: MessageEvent<Envelope>) => {
  const msg = event.data;

  if (!msg || typeof msg !== "object") {
    postMessage({ type: "error", at: Date.now(), payload: "bad envelope" });
    return;
  }

  switch (msg.type) {
    case "ping": {
      // Trivial echo/transform: wrap payload, bump a counter-ish field.
      const reply: Envelope = {
        type: "pong",
        at: Date.now(),
        payload: { echoedFrom: msg.at, original: msg.payload },
      };
      postMessage(reply);
      break;
    }

    case "throw": {
      // Deliberately throw an uncaught error to test failure-mode handling.
      throw new Error("deliberate worker failure: " + JSON.stringify(msg.payload));
    }

    case "spin": {
      // Deliberately hang forever to test terminate() behavior.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // busy loop, never yields
      }
      // unreachable
    }

    case "relay": {
      // Echo the payload back completely unwrapped, so the parent can do a
      // direct deep-equal comparison against what it sent (isolates fidelity
      // of the round trip rather than comparing through a wrapper object).
      postMessage({ type: "relay-reply", at: Date.now(), payload: msg.payload });
      break;
    }

    case "noop": {
      // idle worker: do nothing, just acknowledge boot so parent knows
      // the worker thread is alive.
      postMessage({ type: "ready", at: Date.now(), payload: null });
      break;
    }

    default: {
      postMessage({
        type: "unknown",
        at: Date.now(),
        payload: `unrecognized message type: ${String(msg.type)}`,
      });
    }
  }
};

// Announce readiness immediately on boot so the parent can measure
// "worker alive" latency / confirm the thread actually started.
postMessage({ type: "ready", at: Date.now(), payload: null });
