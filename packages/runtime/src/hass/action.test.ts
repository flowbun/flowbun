import { afterEach, describe, expect, test } from "bun:test";
import {
  type ActionCall,
  performHassAction,
  resolveHassService,
  setHassCallTransport,
} from "./action";
import type { SimpleHass } from "./client";

function fakeHass(
  call: Record<
    string,
    Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
  >,
): SimpleHass {
  return {
    call,
    refBy: { id: () => ({ onUpdate: () => () => {} }) },
    entity: { listEntities: () => [], getCurrentState: () => undefined },
    // biome-ignore lint/suspicious/noExplicitAny: test double, socket isn't exercised by these tests
    socket: { sendMessage: async () => undefined as any },
  };
}

describe("resolveHassService", () => {
  test("throws when the domain isn't registered", () => {
    expect(() => resolveHassService(fakeHass({}), "light", "turn_on")).toThrow(
      'Home Assistant service "light.turn_on" is not available',
    );
  });

  test("throws when the domain exists but the service doesn't", () => {
    const hass = fakeHass({ light: { turn_off: async () => undefined } });
    expect(() => resolveHassService(hass, "light", "turn_on")).toThrow(
      'Home Assistant service "light.turn_on" is not available',
    );
  });

  test("returns the service function when it exists", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const hass = fakeHass({
      light: {
        turn_on: async (args) => {
          calls.push(args);
        },
      },
    });
    const fn = resolveHassService(hass, "light", "turn_on");
    await fn({ brightness: 128 });
    expect(calls).toEqual([{ brightness: 128 }]);
  });
});

// performHassAction() only reaches resolveHassService()/getHass() via its
// direct-connection branch (no callTransport installed) -- exercised for
// real by the flow-host's own main-thread relay handler in
// worker-manager.ts. These tests instead go through the callTransport seam
// (installed by worker-entry.ts in the real topology), which is enough to
// confirm performHassAction's dry-run short-circuit and data/target merging
// without needing a real or mocked Home Assistant connection.
describe("performHassAction via a fake transport", () => {
  afterEach(() => {
    setHassCallTransport(null);
  });

  test("dry-run never calls the transport", async () => {
    const calls: ActionCall[] = [];
    setHassCallTransport({
      call: async (call) => {
        calls.push(call);
      },
    });
    await performHassAction({ domain: "light", service: "turn_on" }, true);
    expect(calls).toEqual([]);
  });

  test("a live call is relayed through the transport with dryRun passed along", async () => {
    const calls: Array<{ call: ActionCall; dryRun: boolean }> = [];
    setHassCallTransport({
      call: async (call, dryRun) => {
        calls.push({ call, dryRun });
      },
    });
    const call: ActionCall = {
      domain: "light",
      service: "turn_on",
      data: { brightness: 128 },
    };
    await performHassAction(call, false);
    expect(calls).toEqual([{ call, dryRun: false }]);
  });
});
