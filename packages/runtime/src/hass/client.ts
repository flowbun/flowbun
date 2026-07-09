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
  attributes: Record<string, unknown>;
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
  entity: {
    listEntities(): string[];
    getCurrentState(entityId: string): SimpleEntityState | undefined;
  };
}

export interface HassEntitySummary {
  id: string;
  friendlyName?: string;
}

export interface EntityStateReading {
  entity: string;
  state: string;
  attributes: Record<string, unknown>;
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

/**
 * Read-only enumeration for the editor's entity autocomplete — never touches
 * hass.call, so it's safe regardless of isDryRun().
 */
export async function listHassEntities(): Promise<HassEntitySummary[]> {
  const hass = await getHass();
  return hass.entity.listEntities().map((id) => ({
    id,
    friendlyName: hass.entity.getCurrentState(id)?.attributes.friendly_name as
      | string
      | undefined,
  }));
}

/**
 * On-demand snapshot read of any entity's current state+attributes — the
 * boundary @hass/read (hass/read.ts) leans on. Safe regardless of
 * isDryRun(): never touches hass.call, same reasoning as listHassEntities.
 */
export async function readEntityState(
  entityId: string,
): Promise<EntityStateReading | undefined> {
  const hass = await getHass();
  const current = hass.entity.getCurrentState(entityId);
  if (!current) return undefined;
  return {
    entity: entityId,
    state: current.state,
    attributes: current.attributes,
  };
}

let dryRun: boolean | null = null;

/** Defaults to true (safe-by-default): a missing FLOWBUN_DRY_RUN fails toward not touching real devices. */
export function isDryRun(): boolean {
  if (dryRun === null) dryRun = (Bun.env.FLOWBUN_DRY_RUN ?? "true") !== "false";
  return dryRun;
}
