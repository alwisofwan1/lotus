import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLEET_SETTINGS,
  resolveFleetSettings,
} from "@/modules/codespace/services/bridge/fleet-settings";
import type { ClaudeSettings } from "@/modules/settings/types";

const withBridge = (orchestration: Record<string, unknown>) =>
  ({ bridge: { orchestration } } as unknown as ClaudeSettings);

describe("resolveFleetSettings", () => {
  it("falls back to defaults when nothing is stored", () => {
    expect(resolveFleetSettings(null)).toEqual(DEFAULT_FLEET_SETTINGS);
    expect(resolveFleetSettings({} as ClaudeSettings)).toEqual(DEFAULT_FLEET_SETTINGS);
  });

  it("reads the three fields someone can set", () => {
    const out = resolveFleetSettings(
      withBridge({ fleetPushDebounceMs: 400, forceFleetSnapshotOnSpawn: false, includeExitedInFleet: true }),
    );
    expect(out).toEqual({
      fleetPushDebounceMs: 400,
      forceFleetSnapshotOnSpawn: false,
      includeExitedInFleet: true,
    });
  });

  it("clamps a debounce that would starve or flood the snapshot", () => {
    expect(resolveFleetSettings(withBridge({ fleetPushDebounceMs: -50 })).fleetPushDebounceMs).toBe(0);
    expect(resolveFleetSettings(withBridge({ fleetPushDebounceMs: 9_000 })).fleetPushDebounceMs).toBe(1000);
    expect(resolveFleetSettings(withBridge({ fleetPushDebounceMs: 12.6 })).fleetPushDebounceMs).toBe(13);
  });

  it("ignores a value of the wrong type rather than passing it through", () => {
    const out = resolveFleetSettings(withBridge({ fleetPushDebounceMs: "fast", includeExitedInFleet: "yes" }));
    expect(out).toEqual(DEFAULT_FLEET_SETTINGS);
  });

  /*
    A settings file written before the Bridge was retired still carries persona, context,
    providers, logging and notifications under the same key. They are a previous version of this
    app's opinion, not an error — passing over them is the whole compatibility story.
  */
  it("reads its three fields out of a file full of retired ones", () => {
    const legacy = {
      bridge: {
        persona: { mode: "preset", presetId: "whatever" },
        context: { includeOpenTabs: true },
        providers: { claude: { path: "/usr/local/bin/claude" } },
        logging: { verbose: true },
        notifications: { enabled: true, soundEnabled: true },
        orchestration: {
          waitIdleAfterSpawn: true,
          waitIdleTimeoutMs: 30_000,
          fleetPushDebounceMs: 250,
        },
      },
    } as unknown as ClaudeSettings;

    expect(resolveFleetSettings(legacy)).toEqual({
      fleetPushDebounceMs: 250,
      forceFleetSnapshotOnSpawn: DEFAULT_FLEET_SETTINGS.forceFleetSnapshotOnSpawn,
      includeExitedInFleet: DEFAULT_FLEET_SETTINGS.includeExitedInFleet,
    });
  });
});
