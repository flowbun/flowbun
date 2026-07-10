import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "flowbun/ws";
import { ChatEventBuffer } from "./chat-event-buffer";

function turnStarted(turnId: string): ChatEvent {
  return { kind: "turn.started", turnId, at: 0 };
}

describe("ChatEventBuffer", () => {
  test("push appends and notifies per-event listeners", () => {
    const buf = new ChatEventBuffer();
    const seen: ChatEvent[] = [];
    buf.subscribe((e) => seen.push(e));
    buf.push(turnStarted("t1"));
    expect(buf.all()).toEqual([turnStarted("t1")]);
    expect(seen).toEqual([turnStarted("t1")]);
  });

  test("push trims to capacity", () => {
    const buf = new ChatEventBuffer(2);
    buf.push(turnStarted("t1"));
    buf.push(turnStarted("t2"));
    buf.push(turnStarted("t3"));
    expect(buf.all()).toEqual([turnStarted("t2"), turnStarted("t3")]);
  });

  test("replace wholesale-replaces the buffer and notifies reset listeners, not per-event ones", () => {
    const buf = new ChatEventBuffer();
    buf.push(turnStarted("old"));

    const pushSeen: ChatEvent[] = [];
    const resetSeen: (readonly ChatEvent[])[] = [];
    buf.subscribe((e) => pushSeen.push(e));
    buf.subscribeReset((events) => resetSeen.push(events));

    buf.replace([turnStarted("new1"), turnStarted("new2")]);

    expect(buf.all()).toEqual([turnStarted("new1"), turnStarted("new2")]);
    expect(pushSeen).toEqual([]);
    expect(resetSeen).toEqual([[turnStarted("new1"), turnStarted("new2")]]);
  });

  test("replace also trims to capacity", () => {
    const buf = new ChatEventBuffer(1);
    buf.replace([turnStarted("a"), turnStarted("b"), turnStarted("c")]);
    expect(buf.all()).toEqual([turnStarted("c")]);
  });

  test("unsubscribeReset stops further notifications", () => {
    const buf = new ChatEventBuffer();
    const seen: (readonly ChatEvent[])[] = [];
    const listener = (events: readonly ChatEvent[]) => seen.push(events);
    buf.subscribeReset(listener);
    buf.unsubscribeReset(listener);
    buf.replace([turnStarted("x")]);
    expect(seen).toEqual([]);
  });
});
