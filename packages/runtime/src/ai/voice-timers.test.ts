import { describe, expect, test } from "bun:test";
import type { StateScope } from "../block";
import {
  cancelTimer,
  claimExpiredTimers,
  humanizeDuration,
  listTimers,
  startTimer,
  timerLabel,
  timerStatus,
} from "./voice-timers";

function fakeStateScope(): StateScope {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string) {
      return store.get(key) as T | undefined;
    },
    async set<T>(key: string, value: T) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

describe("humanizeDuration", () => {
  test("composes hours/minutes/seconds and pluralizes correctly", () => {
    expect(humanizeDuration(45_000)).toBe("45 seconds");
    expect(humanizeDuration(1_000)).toBe("1 second");
    expect(humanizeDuration(90_000)).toBe("1 minute 30 seconds");
    expect(humanizeDuration(600_000)).toBe("10 minutes");
    expect(humanizeDuration(3_900_000)).toBe("1 hour 5 minutes");
    expect(humanizeDuration(0)).toBe("0 seconds");
  });
});

describe("startTimer / numbering", () => {
  test("timers get incrementing ids and correct expiry", async () => {
    const state = fakeStateScope();
    const before = Date.now();
    const first = await startTimer(state, { minutes: 10 });
    const second = await startTimer(state, { seconds: 30, name: "pasta" });
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.timer.id).toBe(1);
    expect(second.timer.id).toBe(2);
    expect(second.timer.name).toBe("pasta");
    expect(first.timer.expiresAt).toBeGreaterThanOrEqual(before + 600_000);
    expect(await listTimers(state)).toHaveLength(2);
  });

  test("a zero or missing duration is rejected", async () => {
    const state = fakeStateScope();
    expect((await startTimer(state, {})).ok).toBe(false);
    expect((await startTimer(state, { minutes: 0 })).ok).toBe(false);
    expect((await startTimer(state, { minutes: -5 })).ok).toBe(false);
  });

  test("numbering resets to 1 once the list empties, but not while timers remain", async () => {
    const state = fakeStateScope();
    await startTimer(state, { minutes: 1 });
    await startTimer(state, { minutes: 2 });
    await cancelTimer(state, { id: 1 });
    // One timer still running — numbering keeps counting.
    const third = await startTimer(state, { minutes: 3 });
    if (!third.ok) throw new Error("expected ok");
    expect(third.timer.id).toBe(3);
    await cancelTimer(state, { id: 2 });
    await cancelTimer(state, { id: 3 });
    const fresh = await startTimer(state, { minutes: 4 });
    if (!fresh.ok) throw new Error("expected ok");
    expect(fresh.timer.id).toBe(1);
  });
});

describe("cancelTimer matching", () => {
  test("cancels by id, by exact name, and by unique substring", async () => {
    const state = fakeStateScope();
    await startTimer(state, { minutes: 1, name: "pasta water" });
    await startTimer(state, { minutes: 2, name: "eggs" });
    await startTimer(state, { minutes: 3 });

    const byName = await cancelTimer(state, { name: "Eggs" });
    if (!byName.ok) throw new Error("expected ok");
    expect(byName.cancelled[0]?.name).toBe("eggs");

    const bySubstring = await cancelTimer(state, { name: "pasta" });
    if (!bySubstring.ok) throw new Error("expected ok");
    expect(bySubstring.cancelled[0]?.name).toBe("pasta water");

    const byId = await cancelTimer(state, { id: 3 });
    if (!byId.ok) throw new Error("expected ok");
    expect(await listTimers(state)).toHaveLength(0);
  });

  test("no id/name cancels the only running timer, but errors when ambiguous or empty", async () => {
    const state = fakeStateScope();
    expect((await cancelTimer(state, {})).ok).toBe(false);

    await startTimer(state, { minutes: 1 });
    const sole = await cancelTimer(state, {});
    expect(sole.ok).toBe(true);

    await startTimer(state, { minutes: 1 });
    await startTimer(state, { minutes: 2 });
    const ambiguous = await cancelTimer(state, {});
    if (ambiguous.ok) throw new Error("expected error");
    expect(ambiguous.error).toContain("2 timers");
  });

  test("unknown ids and names error without touching the list", async () => {
    const state = fakeStateScope();
    await startTimer(state, { minutes: 1, name: "pasta" });
    expect((await cancelTimer(state, { id: 9 })).ok).toBe(false);
    expect((await cancelTimer(state, { name: "rice" })).ok).toBe(false);
    expect(await listTimers(state)).toHaveLength(1);
  });
});

describe("timerStatus", () => {
  test("no query reports every running timer with remaining time", async () => {
    const state = fakeStateScope();
    const now = Date.now();
    await startTimer(state, { minutes: 10 });
    await startTimer(state, { seconds: 90, name: "tea" });
    const status = await timerStatus(state, {}, now + 60_000);
    if (!status.ok) throw new Error("expected ok");
    expect(status.timers).toHaveLength(2);
    expect(status.timers[0]?.remaining).toBe("9 minutes");
    expect(status.timers[1]?.remaining).toBe("30 seconds");
    expect(status.timers[1]?.name).toBe("tea");
  });

  test("an expired-but-unclaimed timer reports 0 seconds, not negative", async () => {
    const state = fakeStateScope();
    const now = Date.now();
    await startTimer(state, { seconds: 10 });
    const status = await timerStatus(state, {}, now + 60_000);
    if (!status.ok) throw new Error("expected ok");
    expect(status.timers[0]?.remainingSeconds).toBe(0);
  });

  test("an empty list is ok:true with zero timers, not an error", async () => {
    const status = await timerStatus(fakeStateScope(), {});
    if (!status.ok) throw new Error("expected ok");
    expect(status.timers).toHaveLength(0);
  });
});

describe("claimExpiredTimers", () => {
  test("removes and returns only expired timers, preserving the rest", async () => {
    const state = fakeStateScope();
    const now = Date.now();
    await startTimer(state, { seconds: 5, name: "done" });
    await startTimer(state, { minutes: 10, name: "later" });

    const claimed = await claimExpiredTimers(state, now + 6_000);
    expect(claimed.map((t) => t.name)).toEqual(["done"]);
    // Claiming is idempotent — the same expiry never comes back twice.
    expect(await claimExpiredTimers(state, now + 6_000)).toHaveLength(0);
    expect((await listTimers(state)).map((t) => t.name)).toEqual(["later"]);
  });

  test("claiming the last timer resets numbering for the next one", async () => {
    const state = fakeStateScope();
    const now = Date.now();
    await startTimer(state, { seconds: 1 });
    await claimExpiredTimers(state, now + 2_000);
    const next = await startTimer(state, { minutes: 1 });
    if (!next.ok) throw new Error("expected ok");
    expect(next.timer.id).toBe(1);
  });
});

describe("timerLabel", () => {
  test("prefers the name, falls back to the ordinal", () => {
    const base = { startedAt: 0, durationMs: 1, expiresAt: 1 };
    expect(timerLabel({ id: 2, name: "pasta", ...base })).toBe(
      "the pasta timer",
    );
    expect(timerLabel({ id: 2, ...base })).toBe("timer 2");
  });
});
