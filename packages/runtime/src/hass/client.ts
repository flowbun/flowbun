import { QuickBoot } from "@digital-alchemy/hass";

/**
 * DA's entity-id and service-call types only become useful (specific string
 * literals instead of an empty mapping) once `type-writer` has generated
 * code against a live instance (see spikes/s3-da-hass). We deliberately
 * don't commit that generated output — it's a full dump of the household's
 * entity/device registry — so DA's own `ANY_ENTITY`/`iCallService` types are
 * effectively empty here. This minimal shape is the one, explicit,
 * contained boundary cast that lets @hass/trigger and @hass/action work
 * against plain entity-id/domain/service strings instead.
 */
export interface SimpleEntityState {
  state: string;
  last_updated: string;
}

export interface SimpleEntityRef {
  onUpdate(
    cb: (newState: SimpleEntityState, oldState: SimpleEntityState) => void,
  ): () => void;
}

export interface SimpleHass {
  refBy: { id(entityId: string): SimpleEntityRef };
  call: Record<
    string,
    Record<string, (args?: Record<string, unknown>) => Promise<unknown>>
  >;
}

let hassPromise: Promise<SimpleHass> | null = null;

export function getHass(): Promise<SimpleHass> {
  if (!hassPromise) {
    hassPromise = QuickBoot("flowbun").then(
      (app) => app.hass as unknown as SimpleHass,
    );
  }
  return hassPromise;
}

let dryRun: boolean | null = null;

/** Defaults to true (safe-by-default): a missing FLOWBUN_DRY_RUN fails toward not touching real devices. */
export function isDryRun(): boolean {
  if (dryRun === null) dryRun = (Bun.env.FLOWBUN_DRY_RUN ?? "true") !== "false";
  return dryRun;
}
