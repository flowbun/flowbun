import { describe, expect, test } from "bun:test";
import type { BlockSummary } from "flowbun";
import { renderBlockSummary } from "./blockSummary";

/** The real @core/scheduler spec (blocks/core-scheduler.ts) — kept verbatim
 * rather than simplified, so these tests fail if that block's summary and
 * this resolver ever drift apart. */
const SCHEDULER: BlockSummary = {
  icon: "🗓",
  switchOn: "mode",
  lines: {
    interval: "every {intervalMs:duration}",
    dailyTime: "{weekdays:weekdays} · {time}",
    sunRelative: "{event} {offsetMinutes:signedMinutes}",
  },
};

/** Convenience for exercising one formatter in isolation. */
function fmt(template: string, config: unknown): string | undefined {
  return renderBlockSummary({ lines: { "*": template } }, config);
}

describe("renderBlockSummary", () => {
  test("no summary spec renders nothing", () => {
    expect(renderBlockSummary(undefined, { time: "15:00" })).toBeUndefined();
  });

  test("the real rowing_wa scheduler node renders its weekday and time", () => {
    expect(
      renderBlockSummary(SCHEDULER, {
        mode: "dailyTime",
        time: "15:00",
        weekdays: [2],
      }),
    ).toBe("🗓 Tue · 15:00");
  });

  test("the scheduler's own default config renders its interval", () => {
    expect(
      renderBlockSummary(SCHEDULER, { mode: "interval", intervalMs: 60_000 }),
    ).toBe("🗓 every 60s");
  });

  test("an omitted offset leaves the sun event standing on its own", () => {
    expect(
      renderBlockSummary(SCHEDULER, { mode: "sunRelative", event: "sunset" }),
    ).toBe("🗓 sunset");
    expect(
      renderBlockSummary(SCHEDULER, {
        mode: "sunRelative",
        event: "sunrise",
        offsetMinutes: -15,
      }),
    ).toBe("🗓 sunrise -15m");
  });

  test("a dailyTime node with no weekdays reads as every day", () => {
    expect(
      renderBlockSummary(SCHEDULER, { mode: "dailyTime", time: "06:30" }),
    ).toBe("🗓 every day · 06:30");
  });
});

describe("switchOn", () => {
  const spec: BlockSummary = {
    switchOn: "mode",
    lines: { a: "line a", "*": "fallback" },
  };

  test("selects the line matching the config's switchOn value", () => {
    expect(renderBlockSummary(spec, { mode: "a" })).toBe("line a");
  });

  test('falls back to "*" for a mode with no line of its own', () => {
    expect(renderBlockSummary(spec, { mode: "zzz" })).toBe("fallback");
  });

  test('falls back to "*" when the switchOn key is absent entirely', () => {
    expect(renderBlockSummary(spec, {})).toBe("fallback");
  });

  test("renders nothing when neither the value nor a fallback has a line", () => {
    const noFallback: BlockSummary = { switchOn: "mode", lines: { a: "A" } };
    expect(renderBlockSummary(noFallback, { mode: "b" })).toBeUndefined();
  });

  test("switchOn values are compared stringified, so numbers/booleans work", () => {
    const numeric: BlockSummary = { switchOn: "n", lines: { "2": "two" } };
    expect(renderBlockSummary(numeric, { n: 2 })).toBe("two");
  });

  test('without switchOn only "*" is consulted', () => {
    expect(renderBlockSummary({ lines: { other: "x" } }, {})).toBeUndefined();
    expect(renderBlockSummary({ lines: { "*": "x" } }, {})).toBe("x");
  });
});

describe("unresolvable placeholders blank the whole line", () => {
  test("a missing config key blanks the line rather than leaking the template", () => {
    expect(fmt("at {time}", {})).toBeUndefined();
  });

  test("a null value blanks the line", () => {
    expect(fmt("at {time}", { time: null })).toBeUndefined();
  });

  test("one unresolvable placeholder blanks a line the rest of which resolved", () => {
    expect(fmt("{a} and {b}", { a: "here" })).toBeUndefined();
  });

  test("a formatter that declines the value blanks the line", () => {
    expect(fmt("{time:time}", { time: "half past three" })).toBeUndefined();
  });

  test("an unknown formatter name blanks the line instead of leaking the raw value", () => {
    expect(
      fmt("{token:nosuchformatter}", { token: "hunter2" }),
    ).toBeUndefined();
  });

  test("an empty config object is treated the same as a missing one", () => {
    expect(fmt("{x}", undefined)).toBeUndefined();
    expect(fmt("{x}", "not an object")).toBeUndefined();
  });

  test("a line that resolves to nothing at all renders nothing", () => {
    expect(fmt("{offset:signedMinutes}", { offset: 0 })).toBeUndefined();
  });
});

describe("plain placeholders", () => {
  test("stringify the raw value", () => {
    expect(fmt("{n} items", { n: 3 })).toBe("3 items");
    expect(fmt("{on}", { on: false })).toBe("false");
  });

  test("an empty string resolves (it is a value), leaving the rest of the line", () => {
    expect(fmt(":{port}{path}", { port: 8130, path: "" })).toBe(":8130");
    expect(fmt(":{port}{path}", { port: 8130, path: "/hook" })).toBe(
      ":8130/hook",
    );
  });

  test("dotted paths reach into nested config objects", () => {
    expect(
      fmt("{target.entity_id}", { target: { entity_id: "light.hall" } }),
    ).toBe("light.hall");
    expect(fmt("{target.entity_id}", { target: {} })).toBeUndefined();
    expect(fmt("{target.entity_id}", {})).toBeUndefined();
  });

  test("text with no placeholders passes through", () => {
    expect(fmt("always this", {})).toBe("always this");
  });

  test("double spaces left by an empty placeholder are collapsed", () => {
    expect(fmt("a {mid} b", { mid: "" })).toBe("a b");
  });
});

describe("icon", () => {
  test("is prefixed to the resolved line", () => {
    expect(renderBlockSummary({ icon: "⚡", lines: { "*": "on" } }, {})).toBe(
      "⚡ on",
    );
  });

  test("is not rendered on its own when the line blanks out", () => {
    expect(
      renderBlockSummary({ icon: "⚡", lines: { "*": "{x}" } }, {}),
    ).toBeUndefined();
  });
});

describe("weekdays formatter", () => {
  const w = (weekdays: unknown) => fmt("{weekdays:weekdays}", { weekdays });

  test("a single day (0=Sunday indexing)", () => {
    expect(w([2])).toBe("Tue");
    expect(w([0])).toBe("Sun");
    expect(w([6])).toBe("Sat");
  });

  test("collapses a contiguous run of three or more", () => {
    expect(w([1, 2, 3, 4, 5])).toBe("Mon–Fri");
    expect(w([1, 2, 3])).toBe("Mon–Wed");
  });

  test("a two-day run is listed, not collapsed", () => {
    expect(w([0, 6])).toBe("Sat, Sun");
    expect(w([1, 2])).toBe("Mon, Tue");
  });

  test("weeks render Monday-first even though the indexing is Sunday-first", () => {
    expect(w([0, 1])).toBe("Mon, Sun");
    expect(w([0, 1, 2, 3, 4, 5, 6])).toBe("Mon–Sun");
  });

  test("non-contiguous days are comma-listed, in Monday-first order", () => {
    expect(w([5, 1])).toBe("Mon, Fri");
    expect(w([0, 3])).toBe("Wed, Sun");
  });

  test("mixed runs and singles", () => {
    expect(w([1, 2, 3, 6])).toBe("Mon–Wed, Sat");
  });

  test("duplicates are ignored", () => {
    expect(w([2, 2])).toBe("Tue");
  });

  test("omitted means every day — not a missing value", () => {
    expect(w(undefined)).toBe("every day");
    expect(fmt("{weekdays:weekdays} · {time}", { time: "15:00" })).toBe(
      "every day · 15:00",
    );
  });

  test("an out-of-range or non-numeric day blanks the line", () => {
    expect(w([8])).toBeUndefined();
    expect(w([-1])).toBeUndefined();
    expect(w([1.5])).toBeUndefined();
    expect(w(["mon"])).toBeUndefined();
    expect(w("everyday")).toBeUndefined();
  });

  test("an empty list blanks the line (it could never fire)", () => {
    expect(w([])).toBeUndefined();
  });
});

describe("duration formatter", () => {
  const d = (ms: unknown) => fmt("{ms:duration}", { ms });

  test("stays in seconds below two minutes", () => {
    expect(d(60_000)).toBe("60s");
    expect(d(90_000)).toBe("90s");
    expect(d(1_000)).toBe("1s");
  });

  test("sub-second values keep their milliseconds", () => {
    expect(d(250)).toBe("250ms");
    expect(d(0)).toBe("0ms");
  });

  test("minutes", () => {
    expect(d(300_000)).toBe("5m");
    expect(d(120_000)).toBe("2m");
  });

  test("hours, with minutes only when non-zero", () => {
    expect(d(7_200_000)).toBe("2h");
    expect(d(5_400_000)).toBe("1h 30m");
  });

  test("a non-numeric or negative value blanks the line", () => {
    expect(d("60000")).toBeUndefined();
    expect(d(-1)).toBeUndefined();
    expect(d(Number.NaN)).toBeUndefined();
    expect(d(undefined)).toBeUndefined();
  });
});

describe("time formatter", () => {
  const t = (time: unknown) => fmt("{time:time}", { time });

  test("passes through an already-padded time", () => {
    expect(t("15:00")).toBe("15:00");
    expect(t("00:00")).toBe("00:00");
  });

  test("normalizes a single-digit hour", () => {
    expect(t("9:05")).toBe("09:05");
  });

  test("rejects anything that isn't HH:MM", () => {
    expect(t("25:00")).toBeUndefined();
    expect(t("12:60")).toBeUndefined();
    expect(t("noon")).toBeUndefined();
    expect(t(1500)).toBeUndefined();
    expect(t(undefined)).toBeUndefined();
  });
});

describe("signedMinutes formatter", () => {
  const s = (offset: unknown) =>
    fmt("sunset {offset:signedMinutes}", { offset });

  test("signs a non-zero offset", () => {
    expect(s(30)).toBe("sunset +30m");
    expect(s(-15)).toBe("sunset -15m");
  });

  test("zero and absent render as nothing, without blanking the line", () => {
    expect(s(0)).toBe("sunset");
    expect(s(undefined)).toBe("sunset");
    expect(s(null)).toBe("sunset");
  });

  test("a non-numeric offset blanks the line", () => {
    expect(s("30")).toBeUndefined();
  });
});

describe("truncate formatter", () => {
  const t = (value: unknown) => fmt("{v:truncate}", { v: value });

  test("passes through anything short enough", () => {
    expect(t("sensor.hallway")).toBe("sensor.hallway");
    expect(t("x".repeat(24))).toBe("x".repeat(24));
  });

  test("clamps a long value with an ellipsis", () => {
    const clamped = t("sensor.givtcp_ab1234_battery_state_of_charge");
    expect(clamped).toBe("sensor.givtcp_ab1234_ba…");
    // Never longer than the cap itself: 23 characters plus the ellipsis.
    expect(clamped).toHaveLength(24);
  });

  test("stringifies a non-string value", () => {
    expect(t(["a", "b"])).toBe("a,b");
  });

  test("a missing value blanks the line", () => {
    expect(t(undefined)).toBeUndefined();
  });
});

describe("secret formatter", () => {
  test("never renders the value", () => {
    const rendered = fmt("token {t:secret}", { t: "syt_averyrealtoken" });
    expect(rendered).toBe("token ••••");
    expect(rendered).not.toContain("syt_");
  });

  test("an unset secret stays absent rather than faking dots", () => {
    expect(fmt("{t:secret}", {})).toBeUndefined();
    expect(fmt("{t:secret}", { t: "" })).toBeUndefined();
  });
});
