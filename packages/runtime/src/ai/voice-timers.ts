import type { StateScope } from "../block";

/**
 * A flow-state-backed kitchen-timer store — the flowbun-native replacement
 * for Home Assistant's built-in HassStartTimer/HassCancelTimer/
 * HassTimerStatus intents, which only run when HA's OWN sentence-matching
 * conversation agent handles the utterance and are therefore bypassed
 * entirely once a flowbun flow is the pipeline's conversation agent.
 *
 * Shared by three consumers, which is why it lives here in the runtime
 * (exported as "flowbun/ai/voice-timers") rather than inside any one block:
 * - @ai/openai_agent's start_timer/cancel_timer/timer_status tools (create,
 *   cancel, query — during a voice turn),
 * - the voice-assist package's timer_watchdog block (claim expired timers
 *   and announce them through the originating satellite),
 * - voice_gate (inject active timers into every prompt's context so "how
 *   long left?" is answerable with zero tool calls).
 *
 * Everything lives under ONE flow-state key as a single document
 * (`{nextId, timers}`), so an add/cancel/claim is one read-modify-write.
 * The watchdog's poll runs on its own interval outside the router's
 * serialized delivery, so two writers *can* technically interleave — an
 * agent tool call adding a timer in the same millisecond the watchdog
 * claims an expired one could lose one of the writes. Accepted knowingly:
 * the collision window is single-digit milliseconds once per second against
 * human-initiated timer operations, and the blast radius is one lost
 * timer operation in a home voice assistant, not corrupted state. A real
 * fix needs transactions the StateScope API deliberately doesn't expose.
 *
 * Timers survive flow restarts for free (absolute `expiresAt` in SQLite) —
 * a restart that overlaps an expiry just announces it on the first
 * watchdog tick after coming back up.
 */

export const VOICE_TIMERS_STATE_KEY = "voice.timers";

export interface VoiceTimer {
  /** Auto-incremented, spoken ordinal ("timer 2"). Numbering resets to 1
   * once the list empties — matching how people (and Alexa/Google) count
   * timers: "first timer, second timer" within a cooking session, not a
   * lifetime-monotonic id. */
  id: number;
  /** Optional spoken label ("pasta"). */
  name?: string;
  startedAt: number;
  durationMs: number;
  expiresAt: number;
  /** HA device_id of the satellite the request came from — lets the
   * watchdog announce through the same speaker that set the timer. */
  deviceId?: string;
}

interface TimerDoc {
  nextId: number;
  timers: VoiceTimer[];
}

async function readDoc(state: StateScope): Promise<TimerDoc> {
  const doc = await state.get<TimerDoc>(VOICE_TIMERS_STATE_KEY);
  if (!doc || !Array.isArray(doc.timers)) return { nextId: 1, timers: [] };
  return doc;
}

async function writeDoc(state: StateScope, doc: TimerDoc): Promise<void> {
  // Numbering resets once nothing is running — see VoiceTimer.id.
  await state.set(VOICE_TIMERS_STATE_KEY, {
    nextId: doc.timers.length === 0 ? 1 : doc.nextId,
    timers: doc.timers,
  });
}

/** "1 hour 10 minutes", "90 seconds" -> "1 minute 30 seconds", "45 seconds". */
export function humanizeDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (seconds || parts.length === 0)
    parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);
  return parts.join(" ");
}

/** The spoken handle for a timer: its name if it has one, else its ordinal. */
export function timerLabel(timer: VoiceTimer): string {
  return timer.name ? `the ${timer.name} timer` : `timer ${timer.id}`;
}

export interface StartTimerOptions {
  hours?: number;
  minutes?: number;
  seconds?: number;
  name?: string;
  deviceId?: string;
}

export async function startTimer(
  state: StateScope,
  opts: StartTimerOptions,
): Promise<{ ok: true; timer: VoiceTimer } | { ok: false; error: string }> {
  const durationMs =
    ((opts.hours ?? 0) * 3600 +
      (opts.minutes ?? 0) * 60 +
      (opts.seconds ?? 0)) *
    1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return {
      ok: false,
      error: "a timer needs a positive duration (hours/minutes/seconds)",
    };
  }
  const doc = await readDoc(state);
  const now = Date.now();
  const timer: VoiceTimer = {
    id: doc.nextId,
    ...(opts.name ? { name: opts.name } : {}),
    startedAt: now,
    durationMs,
    expiresAt: now + durationMs,
    ...(opts.deviceId ? { deviceId: opts.deviceId } : {}),
  };
  await writeDoc(state, {
    nextId: doc.nextId + 1,
    timers: [...doc.timers, timer],
  });
  return { ok: true, timer };
}

export async function listTimers(state: StateScope): Promise<VoiceTimer[]> {
  return (await readDoc(state)).timers;
}

/**
 * Resolves which timer(s) an id/name refers to. No id and no name means
 * "the timer" — unambiguous only when exactly one is running. Name matching
 * is case-insensitive exact first, then unique substring, so "cancel the
 * pasta timer" finds a timer named "pasta water".
 */
function matchTimers(
  timers: VoiceTimer[],
  query: { id?: number; name?: string },
): { matched: VoiceTimer[]; error?: string } {
  if (query.id !== undefined) {
    const byId = timers.filter((t) => t.id === query.id);
    return byId.length > 0
      ? { matched: byId }
      : { matched: [], error: `no timer ${query.id} is running` };
  }
  if (query.name) {
    const needle = query.name.toLowerCase();
    const exact = timers.filter((t) => t.name?.toLowerCase() === needle);
    if (exact.length > 0) return { matched: exact };
    const partial = timers.filter((t) =>
      t.name?.toLowerCase().includes(needle),
    );
    if (partial.length === 1) return { matched: partial };
    return {
      matched: [],
      error:
        partial.length === 0
          ? `no timer named "${query.name}" is running`
          : `"${query.name}" matches more than one timer — say which one`,
    };
  }
  if (timers.length === 1 && timers[0]) return { matched: [timers[0]] };
  return {
    matched: [],
    error:
      timers.length === 0
        ? "no timers are running"
        : `${timers.length} timers are running — say which one (by number or name)`,
  };
}

export async function cancelTimer(
  state: StateScope,
  query: { id?: number; name?: string },
): Promise<
  { ok: true; cancelled: VoiceTimer[] } | { ok: false; error: string }
> {
  const doc = await readDoc(state);
  const { matched, error } = matchTimers(doc.timers, query);
  if (error || matched.length === 0) {
    return { ok: false, error: error ?? "no matching timer" };
  }
  const matchedIds = new Set(matched.map((t) => t.id));
  await writeDoc(state, {
    nextId: doc.nextId,
    timers: doc.timers.filter((t) => !matchedIds.has(t.id)),
  });
  return { ok: true, cancelled: matched };
}

export interface TimerStatus {
  id: number;
  name?: string;
  remaining: string;
  remainingSeconds: number;
  duration: string;
}

export function describeTimer(timer: VoiceTimer, now: number): TimerStatus {
  const remainingMs = Math.max(0, timer.expiresAt - now);
  return {
    id: timer.id,
    ...(timer.name ? { name: timer.name } : {}),
    remaining: humanizeDuration(remainingMs),
    remainingSeconds: Math.round(remainingMs / 1000),
    duration: humanizeDuration(timer.durationMs),
  };
}

export async function timerStatus(
  state: StateScope,
  query: { id?: number; name?: string },
  now = Date.now(),
): Promise<{ ok: true; timers: TimerStatus[] } | { ok: false; error: string }> {
  const doc = await readDoc(state);
  // No id/name on a status query means "tell me about all of them" — unlike
  // cancel, where acting on an ambiguous target would be destructive.
  if (query.id === undefined && !query.name) {
    return { ok: true, timers: doc.timers.map((t) => describeTimer(t, now)) };
  }
  const { matched, error } = matchTimers(doc.timers, query);
  if (error || matched.length === 0) {
    return { ok: false, error: error ?? "no matching timer" };
  }
  return { ok: true, timers: matched.map((t) => describeTimer(t, now)) };
}

/**
 * Removes and returns every expired timer — the watchdog calls this once
 * per tick and announces whatever comes back. Claim-then-announce (rather
 * than announce-then-remove) means a crash mid-announce drops the
 * announcement instead of repeating it forever; for a kitchen timer,
 * silence once beats "pasta is ready" every second until someone restarts
 * the flow.
 */
export async function claimExpiredTimers(
  state: StateScope,
  now = Date.now(),
): Promise<VoiceTimer[]> {
  const doc = await readDoc(state);
  const expired = doc.timers.filter((t) => t.expiresAt <= now);
  if (expired.length === 0) return [];
  await writeDoc(state, {
    nextId: doc.nextId,
    timers: doc.timers.filter((t) => t.expiresAt > now),
  });
  return expired;
}
