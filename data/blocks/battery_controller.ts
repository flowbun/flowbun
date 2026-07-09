import { defineBlock } from "flowbun";

interface ActionCall {
  domain: string;
  service: string;
  target?: { entity_id: string };
  data?: Record<string, unknown>;
}

// flow-scoped state keys the state_cache nodes in battery_controller.json
// write into (see state_cache.ts) — kept here as the one place naming them;
// the wiring file's node configs must use these exact strings.
const GRID_POWER_KEY = "battery_controller:grid_power";
const CHARGE_ON_KEY = "battery_controller:charge_on";
const DISCHARGE_ON_KEY = "battery_controller:discharge_on";

/**
 * Translated from a Home Assistant automation (grid-zero-export battery
 * controller) — original YAML kept below for reference. Wire this node's
 * `changed` input from a @hass/trigger on the grid power meter (the
 * original automation's sole trigger); `b`/chg_on/dis_on — which the
 * original reads live via `states(...)`/`is_state(...)` regardless of what
 * triggered it — are supplied here by three state_cache nodes instead (see
 * state_cache.ts's own doc comment for why).
 */
export default defineBlock({
  name: "battery_controller",
  config: {
    chargeSwitchEntity: "switch.ef_60046_charging_task",
    dischargeSwitchEntity: "switch.ef_60046_discharging_task",
    chargeLimitEntity: "number.ef_60046_charging_power_limit",
    dischargeLimitEntity: "number.ef_60046_discharging_power_limit",
    setpoint: 30,
    deadband: 20,
    maxDischarge: 200,
    maxCharge: 800,
  },
  inputs: {
    changed: {} as {
      entity: string;
      state: string;
      previous: string | null;
      at: number;
    },
  },
  outputs: {
    chargeOn: {} as ActionCall,
    chargeOff: {} as ActionCall,
    dischargeOn: {} as ActionCall,
    dischargeOff: {} as ActionCall,
    setChargeLimit: {} as ActionCall,
    setDischargeLimit: {} as ActionCall,
  },
  async process({ changed }, ctx) {
    // Mirrors the source automation's own trigger filter
    // (`not_to: [unavailable, unknown]`) — @hass/trigger has no equivalent
    // built in, so it's replicated here instead.
    if (changed.state === "unavailable" || changed.state === "unknown") return;

    const m = Number.parseFloat(changed.state) || 0;
    const b = (await ctx.state.flow.get<number>(GRID_POWER_KEY)) ?? 0;
    const chgOn = (await ctx.state.flow.get<boolean>(CHARGE_ON_KEY)) ?? false;
    const disOn =
      (await ctx.state.flow.get<boolean>(DISCHARGE_ON_KEY)) ?? false;
    const target = m + b - ctx.config.setpoint;

    const chargeSwitch = (state: "on" | "off"): ActionCall => ({
      domain: "switch",
      service: state === "on" ? "turn_on" : "turn_off",
      target: { entity_id: ctx.config.chargeSwitchEntity },
    });
    const dischargeSwitch = (state: "on" | "off"): ActionCall => ({
      domain: "switch",
      service: state === "on" ? "turn_on" : "turn_off",
      target: { entity_id: ctx.config.dischargeSwitchEntity },
    });

    if (target > ctx.config.deadband) {
      // Importing more than desired -- cover it by discharging.
      return {
        chargeOff: chgOn ? chargeSwitch("off") : undefined,
        setDischargeLimit: {
          domain: "number",
          service: "set_value",
          target: { entity_id: ctx.config.dischargeLimitEntity },
          // Python's round() and Math.round() differ on exact .5 ties
          // (banker's vs. half-up) -- irrelevant at watt-scale precision.
          data: {
            value: Math.round(Math.min(target, ctx.config.maxDischarge)),
          },
        },
        dischargeOn: disOn ? undefined : dischargeSwitch("on"),
      };
    }

    if (target < -ctx.config.deadband) {
      // Exporting more than desired -- absorb it by charging.
      return {
        dischargeOff: disOn ? dischargeSwitch("off") : undefined,
        setChargeLimit: {
          domain: "number",
          service: "set_value",
          target: { entity_id: ctx.config.chargeLimitEntity },
          data: {
            value: Math.round(Math.min(-target, ctx.config.maxCharge)),
          },
        },
        chargeOn: chgOn ? undefined : chargeSwitch("on"),
      };
    }

    // Within the deadband -- neither charging nor discharging is needed.
    return {
      dischargeOff: disOn ? dischargeSwitch("off") : undefined,
      chargeOff: chgOn ? chargeSwitch("off") : undefined,
    };
  },
});

// Original Home Assistant automation this block was translated from:
//
// alias: Battery grid-zero controller
// description: ""
// triggers:
//   - entity_id: sensor.shellyemg3_d885ac0d3b44_energy_meter_0_power
//     not_to:
//       - unavailable
//       - unknown
//     trigger: state
// actions:
//   - choose:
//       - conditions:
//           - condition: template
//             value_template: "{{ target > db }}"
//         sequence:
//           - if:
//               - condition: template
//                 value_template: "{{ chg_on }}"
//             then:
//               - target:
//                   entity_id: switch.ef_60046_charging_task
//                 action: switch.turn_off
//           - target:
//               entity_id: number.ef_60046_discharging_power_limit
//             data:
//               value: "{{ [target, max_dis] | min | round(0) }}"
//             action: number.set_value
//           - if:
//               - condition: template
//                 value_template: "{{ not dis_on }}"
//             then:
//               - target:
//                   entity_id: switch.ef_60046_discharging_task
//                 action: switch.turn_on
//       - conditions:
//           - condition: template
//             value_template: "{{ target < (-1 * db) }}"
//         sequence:
//           - if:
//               - condition: template
//                 value_template: "{{ dis_on }}"
//             then:
//               - target:
//                   entity_id: switch.ef_60046_discharging_task
//                 action: switch.turn_off
//           - target:
//               entity_id: number.ef_60046_charging_power_limit
//             data:
//               value: "{{ [(-1 * target), max_chg] | min | round(0) }}"
//             action: number.set_value
//           - if:
//               - condition: template
//                 value_template: "{{ not chg_on }}"
//             then:
//               - target:
//                   entity_id: switch.ef_60046_charging_task
//                 action: switch.turn_on
//     default:
//       - if:
//           - condition: template
//             value_template: "{{ dis_on }}"
//         then:
//           - target:
//               entity_id: switch.ef_60046_discharging_task
//             action: switch.turn_off
//       - if:
//           - condition: template
//             value_template: "{{ chg_on }}"
//         then:
//           - target:
//               entity_id: switch.ef_60046_charging_task
//             action: switch.turn_off
// variables:
//   m: >-
//     {{ states('sensor.shellyemg3_d885ac0d3b44_energy_meter_0_power') | float(0)
//     }}
//   b: "{{ states('sensor.ef_60046_grid_power') | float(0) }}"
//   sp: 30
//   db: 20
//   max_dis: 200
//   max_chg: 800
//   target: "{{ m + b - sp }}"
//   chg_on: "{{ is_state('switch.ef_60046_charging_task','on') }}"
//   dis_on: "{{ is_state('switch.ef_60046_discharging_task','on') }}"
// mode: single
