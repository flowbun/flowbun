// Generic "flow-host" stand-in child process for the S2 IPC spike.
// Mode is selected via argv[2] so each test can spawn a purpose-built child.

const mode = process.argv[2];

function send(msg: unknown) {
  // process.send is only defined when the parent spawned us with an `ipc` option.
  (process as any).send(msg);
}

if (mode === "roundtrip") {
  process.on("message", (msg: any) => {
    if (msg?.type === "ping") {
      const childObj = {
        id: 999,
        name: "child-generated-object",
        createdAt: new Date("2021-11-05T09:00:00.000Z"),
        nested: {
          depth: 2,
          values: [1, 2, { deep: "value", when: new Date(2000, 0, 1) }],
          nullable: null,
        },
        flags: [true, false, true],
      };
      send({ type: "pong", echoed: msg.payload, childObj });
    }
  });
} else if (mode === "crash-burst") {
  const crashAfter = Number(process.argv[3]);
  let count = 0;
  process.on("message", (msg: any) => {
    if (msg?.type === "burst") {
      count++;
      send({ type: "ack", seq: msg.seq });
      if (count === crashAfter) {
        // Simulate a flow-host crashing mid-burst while other messages are still in flight.
        process.exit(1);
      }
    }
  });
} else if (mode === "exit-clean") {
  process.on("message", (msg: any) => {
    if (msg?.type === "please-exit-clean") {
      send({ type: "exiting" });
      process.exit(0);
    }
  });
} else if (mode === "idle-until-killed") {
  process.on("message", (msg: any) => {
    if (msg?.type === "ping") send({ type: "pong" });
  });
  // Otherwise just sits here waiting for the parent to kill() it.
} else if (mode === "throughput") {
  let recvCount = 0;
  process.on("message", (msg: any) => {
    if (msg?.type === "p2c") {
      recvCount++;
    } else if (msg?.type === "p2c-end") {
      send({ type: "p2c-report", count: recvCount });
    } else if (msg?.type === "start-c2p") {
      const durationMs = msg.durationMs;
      const payload = "x".repeat(80); // ~100 bytes once wrapped in the envelope object
      const end = Date.now() + durationMs;
      let seq = 0;
      while (Date.now() < end) {
        send({ type: "c2p", seq, payload });
        seq++;
      }
      send({ type: "c2p-done", count: seq });
    }
  });
} else {
  console.error(`child.ts: unknown mode ${JSON.stringify(mode)}`);
  process.exit(2);
}
