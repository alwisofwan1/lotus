import type { BridgeSettingsRaw, ClaudeSettings } from "@/modules/settings/types";

/**
 * The settings the fleet snapshot actually reads.
 *
 * What replaced `bridge-settings.ts`: that module resolved persona, context injection, planner
 * CLIs, logging and notifications for a Bridge that has been retired. Three fields survived the
 * retirement because live code reads them — all three in `useMcpFleetPush`, which is what tells
 * agents and the phone who is in this window.
 *
 * **The stored path is still `bridge.orchestration`.** A storage key is not a name anyone reads;
 * it is where the value someone already chose sits. Renaming it to match a section title would
 * silently reset these knobs on every machine that has them set.
 */

export type FleetSettings = {
  /** How long a change waits before the fleet snapshot goes out. */
  fleetPushDebounceMs: number;
  /** Push immediately when a cell spawns or exits, bypassing the debounce. */
  forceFleetSnapshotOnSpawn: boolean;
  /** Keep a pane whose process ended visible to agents asking who is here. */
  includeExitedInFleet: boolean;
};

export const DEFAULT_FLEET_SETTINGS: FleetSettings = {
  fleetPushDebounceMs: 150,
  forceFleetSnapshotOnSpawn: true,
  includeExitedInFleet: false,
};

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asClampedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Read the three fields, and ignore everything else the file carries.
 *
 * Settings written by an older build still hold persona, context, providers, logging and
 * notifications under the same key. They are not errors — they are a previous version of this
 * app's opinion — so they are passed over rather than rejected.
 */
export function resolveFleetSettings(settings: ClaudeSettings | null | undefined): FleetSettings {
  const raw = (settings as { bridge?: BridgeSettingsRaw } | null | undefined)?.bridge?.orchestration;
  if (!raw || typeof raw !== "object") return { ...DEFAULT_FLEET_SETTINGS };
  const record = raw as Record<string, unknown>;
  return {
    fleetPushDebounceMs: asClampedInt(
      record.fleetPushDebounceMs,
      DEFAULT_FLEET_SETTINGS.fleetPushDebounceMs,
      0,
      1000,
    ),
    forceFleetSnapshotOnSpawn: asBool(
      record.forceFleetSnapshotOnSpawn,
      DEFAULT_FLEET_SETTINGS.forceFleetSnapshotOnSpawn,
    ),
    includeExitedInFleet: asBool(
      record.includeExitedInFleet,
      DEFAULT_FLEET_SETTINGS.includeExitedInFleet,
    ),
  };
}
