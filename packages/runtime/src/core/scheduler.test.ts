import { describe, expect, test } from "bun:test";
import {
  nextDailyTime,
  nextFireTime,
  nextSunRelative,
  registerScheduler,
} from "./scheduler";

describe("nextDailyTime", () => {
  test("returns today's occurrence when the time hasn't passed yet", () => {
    const now = new Date(2026, 5, 15, 6, 0, 0);
    const next = nextDailyTime("22:30", now);
    expect(next.getFullYear()).toBe(2026);
    expect(next.getMonth()).toBe(5);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(22);
    expect(next.getMinutes()).toBe(30);
  });

  test("rolls over to tomorrow once today's time has passed", () => {
    const now = new Date(2026, 5, 15, 23, 0, 0);
    const next = nextDailyTime("22:30", now);
    expect(next.getDate()).toBe(16);
    expect(next.getHours()).toBe(22);
    expect(next.getMinutes()).toBe(30);
  });

  test("throws on a malformed time string", () => {
    expect(() => nextDailyTime("not-a-time", new Date())).toThrow();
  });
});

describe("nextSunRelative", () => {
  // London, mid-summer: sunrise well before 06:00 local.
  const LAT = 51.5416;
  const LON = -0.1022;

  test("applies a negative offset before today's sunrise when not yet passed", () => {
    const now = new Date(2026, 5, 15, 3, 0, 0);
    const next = nextSunRelative("sunrise", -15, LAT, LON, now);
    expect(next.getDate()).toBe(15);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });

  test("rolls over to tomorrow once today's offset instant has passed", () => {
    const now = new Date(2026, 5, 15, 12, 0, 0);
    const next = nextSunRelative("sunrise", -15, LAT, LON, now);
    expect(next.getDate()).toBe(16);
  });

  test("sunset mode targets the evening, after sunrise mode's instant", () => {
    const now = new Date(2026, 5, 15, 3, 0, 0);
    const sunrise = nextSunRelative("sunrise", 0, LAT, LON, now);
    const sunset = nextSunRelative("sunset", 0, LAT, LON, now);
    expect(sunset.getTime()).toBeGreaterThan(sunrise.getTime());
  });
});

describe("nextFireTime", () => {
  test("interval mode adds intervalMs to now", () => {
    const now = new Date(2026, 5, 15, 10, 0, 0);
    const next = nextFireTime({ mode: "interval", intervalMs: 300_000 }, now);
    expect(next.getTime() - now.getTime()).toBe(300_000);
  });

  test("dailyTime mode requires time", () => {
    expect(() => nextFireTime({ mode: "dailyTime" }, new Date())).toThrow();
  });

  test("sunRelative mode requires event/lat/lon", () => {
    expect(() =>
      nextFireTime({ mode: "sunRelative", event: "sunrise" }, new Date()),
    ).toThrow();
  });

  test("interval mode requires intervalMs", () => {
    expect(() => nextFireTime({ mode: "interval" }, new Date())).toThrow();
  });
});

describe("registerScheduler", () => {
  test("fires repeatedly on the configured interval and stops on unsubscribe", async () => {
    const fires: number[] = [];
    const stop = registerScheduler(
      { mode: "interval", intervalMs: 20 },
      (payload) => fires.push(payload.at),
    );
    await new Promise((resolve) => setTimeout(resolve, 70));
    stop();
    const countAtStop = fires.length;
    expect(countAtStop).toBeGreaterThanOrEqual(2);

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fires.length).toBe(countAtStop);
  });
});
