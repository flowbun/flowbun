// structured-clone.ts
//
// Verifies postMessage/structuredClone fidelity across the Worker boundary,
// using envelopes shaped like Flowbun's real message envelope:
//   { type: string, at: number, payload: unknown }
//
// Checks:
//  1. A round trip (parent -> worker -> parent) of a payload containing
//     nested objects, arrays, and a Date survives with deep equality and
//     without being the same object reference.
//  2. Sending something structured-clone cannot handle (a function) is
//     rejected (throws), rather than silently corrupting data.

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!deepEqual((a as any)[k], (b as any)[k])) return false;
  }
  return true;
}

async function main() {
  const results: { name: string; pass: boolean; detail: string }[] = [];

  const url = new URL("./worker-echo.ts", import.meta.url).href;
  const worker = new Worker(url);

  await new Promise<void>((resolve) => {
    const onReady = (e: MessageEvent) => {
      if ((e.data as any)?.type === "ready") {
        worker.removeEventListener("message", onReady as any);
        resolve();
      }
    };
    worker.addEventListener("message", onReady as any);
  });

  // --- Test 1: round trip fidelity with a rich nested payload ---
  const complexPayload = {
    str: "hello flowbun",
    num: 42.5,
    bool: true,
    nul: null,
    nested: {
      arr: [1, 2, 3, { deep: "value", arr2: [true, false, null] }],
      date: new Date("2026-01-01T00:00:00.000Z"),
      map_like: { a: 1, b: 2 },
    },
    topArr: ["a", "b", { c: 3 }],
    date: new Date(2020, 0, 1),
  };

  const roundTrip = await new Promise<any>((resolve) => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as any;
      if (data?.type === "relay-reply") {
        worker.removeEventListener("message", onMsg as any);
        resolve(data.payload);
      }
    };
    worker.addEventListener("message", onMsg as any);
    worker.postMessage({ type: "relay", at: Date.now(), payload: complexPayload });
  });

  const isDeepEqual = deepEqual(complexPayload, roundTrip);
  const isNotSameRef = roundTrip !== complexPayload && roundTrip.nested !== complexPayload.nested;
  const dateSurvived =
    roundTrip.nested.date instanceof Date &&
    roundTrip.nested.date.getTime() === complexPayload.nested.date.getTime();

  results.push({
    name: "round-trip deep equality (parent->worker->parent)",
    pass: isDeepEqual,
    detail: isDeepEqual ? "structurally identical" : `MISMATCH: ${JSON.stringify(roundTrip)}`,
  });
  results.push({
    name: "round-trip is a clone, not a shared reference",
    pass: isNotSameRef,
    detail: isNotSameRef ? "confirmed distinct object identity" : "FAIL: same reference returned",
  });
  results.push({
    name: "Date instance survives clone (type preserved, not stringified)",
    pass: dateSurvived,
    detail: dateSurvived
      ? `Date preserved: ${roundTrip.nested.date.toISOString()}`
      : `FAIL: got ${typeof roundTrip.nested.date}: ${roundTrip.nested.date}`,
  });

  // --- Test 2: non-cloneable value (function) should be rejected ---
  let threw = false;
  let errMsg = "";
  try {
    worker.postMessage({
      type: "ping",
      at: Date.now(),
      payload: { fn: () => 1 },
    });
    // give it a moment in case failure is async/silent
    await new Promise((r) => setTimeout(r, 200));
  } catch (err) {
    threw = true;
    errMsg = err instanceof Error ? err.message : String(err);
  }
  results.push({
    name: "postMessage with a function payload is rejected (throws DataCloneError)",
    pass: threw,
    detail: threw ? `threw as expected: ${errMsg}` : "FAIL: did not throw; may have silently dropped the function",
  });

  worker.terminate();

  console.log("\n=== structured-clone fidelity results ===");
  let allPass = true;
  for (const r of results) {
    console.log(`[${r.pass ? "PASS" : "FAIL"}] ${r.name}\n       ${r.detail}`);
    if (!r.pass) allPass = false;
  }
  console.log(`\nOverall: ${allPass ? "PASS" : "FAIL"}`);
  process.exit(allPass ? 0 : 1);
}

main();
