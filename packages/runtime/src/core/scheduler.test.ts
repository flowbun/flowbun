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

describe("nextDailyTime with weekdays", () => {
  // 2026-06-15 is a Monday (getDay() === 1); asserted in the first test so
  // every hardcoded weekday expectation below is anchored to a checked fact.
  const MONDAY = new Date(2026, 5, 15, 6, 0, 0);

  test("fires today when today's weekday is allowed and the time hasn't passed", () => {
    expect(MONDAY.getDay()).toBe(1);
    const next = nextDailyTime("22:30", MONDAY, [1]);
    expect(next.getDate()).toBe(15);
    expect(next.getHours()).toBe(22);
    expect(next.getMinutes()).toBe(30);
  });

  test("skips to the next allowed weekday when today is not allowed", () => {
    // Tuesday only, asked on a Monday -> Tuesday the 16th.
    const next = nextDailyTime("15:00", MONDAY, [2]);
    expect(next.getDate()).toBe(16);
    expect(next.getDay()).toBe(2);
    expect(next.getHours()).toBe(15);
    expect(next.getMinutes()).toBe(0);
  });

  test("wraps a full week when today is the only allowed day but the time has passed", () => {
    const lateMonday = new Date(2026, 5, 15, 23, 0, 0);
    const next = nextDailyTime("22:30", lateMonday, [1]);
    expect(next.getDate()).toBe(22);
    expect(next.getDay()).toBe(1);
    expect(next.getHours()).toBe(22);
  });

  test("picks the nearest of multiple allowed weekdays", () => {
    // Sunday and Thursday allowed, asked on a Monday -> Thursday the 18th
    // comes before next Sunday the 21st.
    const next = nextDailyTime("15:00", MONDAY, [0, 4]);
    expect(next.getDate()).toBe(18);
    expect(next.getDay()).toBe(4);
  });

  test("falls to a later allowed day this week once today's time has passed", () => {
    const lateMonday = new Date(2026, 5, 15, 23, 0, 0);
    const next = nextDailyTime("22:30", lateMonday, [1, 3]);
    expect(next.getDate()).toBe(17);
    expect(next.getDay()).toBe(3);
  });

  test("throws on an empty weekdays list", () => {
    expect(() => nextDailyTime("15:00", MONDAY, [])).toThrow(/empty/);
  });

  test("throws on out-of-range or non-integer weekday values", () => {
    expect(() => nextDailyTime("15:00", MONDAY, [7])).toThrow(
      /invalid weekday/,
    );
    expect(() => nextDailyTime("15:00", MONDAY, [-1])).toThrow(
      /invalid weekday/,
    );
    expect(() => nextDailyTime("15:00", MONDAY, [1.5])).toThrow(
      /invalid weekday/,
    );
  });

  test("omitted weekdays behaves exactly like every day", () => {
    const restricted = nextDailyTime("22:30", MONDAY, [0, 1, 2, 3, 4, 5, 6]);
    const unrestricted = nextDailyTime("22:30", MONDAY);
    expect(restricted.getTime()).toBe(unrestricted.getTime());
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

  test("dailyTime mode forwards weekdays to nextDailyTime", () => {
    // Monday the 15th, Tuesday-only schedule -> Tuesday the 16th.
    const now = new Date(2026, 5, 15, 6, 0, 0);
    const next = nextFireTime(
      { mode: "dailyTime", time: "15:00", weekdays: [2] },
      now,
    );
    expect(next.getDate()).toBe(16);
    expect(next.getDay()).toBe(2);
  });

  test("dailyTime mode surfaces weekday validation errors", () => {
    expect(() =>
      nextFireTime(
        { mode: "dailyTime", time: "15:00", weekdays: [] },
        new Date(),
      ),
    ).toThrow();
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
