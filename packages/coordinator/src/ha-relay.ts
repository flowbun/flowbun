import type { ActionCall } from "flowbun/hass/action";
import { performHassAction } from "flowbun/hass/action";
import type {
  EntityStateReading,
  HassEntitySummary,
} from "flowbun/hass/client";
import { isDryRun, listHassEntities } from "flowbun/hass/client";
import { performHassRead } from "flowbun/hass/read";
import type { TriggerOutputs } from "flowbun/hass/trigger";
import { registerHassTrigger } from "flowbun/hass/trigger";

interface Subscription {
  unsubscribe: () => void;
  listeners: Map<string, (payload: TriggerOutputs["changed"]) => void>;
}

/**
 * The only place getHass()/isDryRun()/registerHassTrigger() run for real in
 * the distributed topology — the coordinator is the sole holder of the HA
 * connection. Flow-hosts relay through here over IPC (see supervisor.ts).
 *
 * Known limitation, not fixed here: per spikes/s3-da-hass/RESULTS.md, a dead
 * HA endpoint at initial boot isn't a catchable rejection — DA's own
 * top-level bootstrap error handler logs and calls `process.exit(1)`
 * directly, taking the whole coordinator process down with it. A JS-level
 * retry wrapper around getHass() can't help (there's nothing to catch); a
 * real fix would mean bootstrapping DA in its own isolated, restartable
 * child process, which is out of scope for this phase. Once a first boot
 * succeeds, DA's own reconnect-after-drop logic (proven in S3) takes over
 * and this limitation no longer applies.
 */
export class HaRelay {
  private subsByEntity = new Map<string, Subscription>();

  /** One real DA subscription per entity, shared across every @hass/trigger node that references it. */
  async subscribe(
    flowName: string,
    nodeId: string,
    entity: string,
    onChange: (p: TriggerOutputs["changed"]) => void,
  ): Promise<void> {
    let sub = this.subsByEntity.get(entity);
    if (!sub) {
      const listeners = new Map<
        string,
        (p: TriggerOutputs["changed"]) => void
      >();
      const unsubscribe = await registerHassTrigger({ entity }, (payload) => {
        for (const l of listeners.values()) l(payload);
      });
      sub = { unsubscribe, listeners };
      this.subsByEntity.set(entity, sub);
    }
    sub.listeners.set(`${flowName}::${nodeId}`, onChange);
  }

  unsubscribeFlow(flowName: string): void {
    for (const [entity, sub] of this.subsByEntity) {
      for (const key of [...sub.listeners.keys()]) {
        if (key.startsWith(`${flowName}::`)) sub.listeners.delete(key);
      }
      if (sub.listeners.size === 0) {
        sub.unsubscribe();
        this.subsByEntity.delete(entity);
      }
    }
  }

  async call(
    call: ActionCall,
    dryRunOverride?: boolean,
  ): Promise<{ dryRun: boolean }> {
    const dryRun = dryRunOverride ?? isDryRun();
    await performHassAction(call, dryRun); // performHassAction itself lazily calls getHass() when !dryRun
    return { dryRun };
  }

  /** On-demand snapshot read of any entity's current state+attributes — always runs for real, no dry-run gate (see performHassRead's own comment). */
  read(entity: string): Promise<EntityStateReading> {
    return performHassRead(entity);
  }

  /** Powers the editor's entity autocomplete (see ConfigEditor.tsx). */
  listEntities(): Promise<HassEntitySummary[]> {
    return listHassEntities();
  }
}
