import { getTimes } from "suncalc";

export interface SchedulerConfig {
  mode: "interval" | "dailyTime" | "sunRelative";
  /** mode: "interval" */
  intervalMs?: number;
  /** mode: "dailyTime", 24h local time "HH:MM" */
  time?: string;
  /** mode: "sunRelative" */
  event?: "sunrise" | "sunset";
  /** mode: "sunRelative", minutes added to the event time (may be negative) */
  offsetMinutes?: number;
  /** mode: "sunRelative" */
  latitude?: number;
  /** mode: "sunRelative" */
  longitude?: number;
}

export interface SchedulerOutputs {
  fired: { at: number };
}

/** Next instant `HH:MM` (24h, local time) occurs at or after `now` — today if it hasn't passed yet, else tomorrow. */
export function nextDailyTime(time: string, now: Date): Date {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`invalid dailyTime "${time}", expected "HH:MM"`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/**
 * Next `event` (sunrise/sunset) instant, offset by `offsetMinutes`, at or
 * after `now` — computed for today first; if that has already passed, falls
 * forward to tomorrow's occurrence instead of firing immediately (recomputed
 * from suncalc's real day-boundary sun times, not a raw +24h shift, so DST
 * transitions and the seasonal drift of sunrise/sunset self-correct).
 */
export function nextSunRelative(
  event: "sunrise" | "sunset",
  offsetMinutes: number,
  latitude: number,
  longitude: number,
  now: Date,
): Date {
  // Static property access, not `times[event]` — noUncheckedIndexedAccess
  // would otherwise widen a dynamic-key lookup to `Date | undefined` even
  // though `event` is narrowed to the two known keys. suncalc types these as
  // `Date | null` because at extreme latitudes the sun can stay above/below
  // the horizon all day — never happens for this app's real-world
  // (UK-latitude) usage, but still needs a defined behavior: fail loudly
  // rather than silently scheduling against `Invalid Date`.
  const pick = (times: ReturnType<typeof getTimes>): Date => {
    const t = event === "sunrise" ? times.sunrise : times.sunset;
    if (!t) {
      throw new Error(
        `sun never rises/sets today at latitude ${latitude} — no "${event}" instant to schedule against`,
      );
    }
    return t;
  };

  const offsetMs = offsetMinutes * 60_000;
  const todayTarget = new Date(
    pick(getTimes(now, latitude, longitude)).getTime() + offsetMs,
  );
  if (todayTarget.getTime() > now.getTime()) return todayTarget;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return new Date(
    pick(getTimes(tomorrow, latitude, longitude)).getTime() + offsetMs,
  );
}

/** Computes the next fire instant for `config` relative to `now` — the pure scheduling decision, kept separate from registerScheduler's real setTimeout side effect so it's directly unit-testable. */
export function nextFireTime(config: SchedulerConfig, now: Date): Date {
  switch (config.mode) {
    case "dailyTime":
      if (!config.time) throw new Error('dailyTime mode requires "time"');
      return nextDailyTime(config.time, now);
    case "sunRelative":
      if (!config.event) throw new Error('sunRelative mode requires "event"');
      if (config.latitude === undefined || config.longitude === undefined) {
        throw new Error('sunRelative mode requires "latitude" and "longitude"');
      }
      return nextSunRelative(
        config.event,
        config.offsetMinutes ?? 0,
        config.latitude,
        config.longitude,
        now,
      );
    case "interval":
      if (!config.intervalMs)
        throw new Error('interval mode requires "intervalMs"');
      return new Date(now.getTime() + config.intervalMs);
    default:
      throw new Error(`unknown scheduler mode "${config.mode}"`);
  }
}

/**
 * Called once per node at Worker init (see the block's own `subscribe` in
 * blocks/core-scheduler.ts), NOT per message — unlike @hass/trigger's HA
 * connection, a timer isn't a shared external resource, so there's no need
 * to host this in the flow-host's own main thread: each node's Worker just
 * owns its own setTimeout chain. Returns an unsubscribe function that clears
 * the pending timer, called once, at Worker terminate. Kept as a standalone
 * export (rather than inlined into `subscribe`) so the pure scheduling
 * decision (`nextFireTime`, above) and the real setTimeout side effect stay
 * separately testable.
 */
export function registerScheduler(
  config: SchedulerConfig,
  onFire: (payload: SchedulerOutputs["fired"]) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function scheduleNext(): void {
    if (stopped) return;
    const now = new Date();
    const next = nextFireTime(config, now);
    const delay = Math.max(0, next.getTime() - now.getTime());
    timer = setTimeout(() => {
      if (stopped) return;
      onFire({ at: Date.now() });
      scheduleNext();
    }, delay);
  }

  scheduleNext();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
