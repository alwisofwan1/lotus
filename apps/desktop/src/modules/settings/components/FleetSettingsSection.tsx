"use client";

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import type { BridgeSettingsRaw, ClaudeSettings } from "@/modules/settings/types";
import { NumberStepper } from "@/components/ui/number-stepper";
import {
  DEFAULT_FLEET_SETTINGS,
  resolveFleetSettings,
} from "@/modules/codespace/services/bridge/fleet-settings";

/**
 * The two knobs that still turn something.
 *
 * This replaces a 573-line "Bridge" section whose rows configured persona, context injection,
 * planner CLIs, logging and notifications — for a Bridge that was retired. Exactly two of its
 * fields were read by live code, both in `useMcpFleetPush`, so exactly two rows survive. A settings
 * page is a promise that each control does something; the rest were breaking it.
 */

type Props = {
  settings: ClaudeSettings;
  update: (patch: Partial<ClaudeSettings>) => void;
};

export function FleetSettingsSection({ settings, update }: Props) {
  const fleet = useMemo(() => resolveFleetSettings(settings), [settings]);

  /*
    Still written under the `bridge` key.

    The storage path is not a name anyone reads — it is where the value someone chose already sits.
    Renaming it would silently reset both knobs on every machine that has them set, to make a JSON
    key match a section title.
  */
  const setFleet = (patch: BridgeSettingsRaw["orchestration"]) => {
    const current = (settings as { bridge?: BridgeSettingsRaw }).bridge;
    update({
      bridge: {
        ...(current ?? {}),
        orchestration: { ...(current?.orchestration ?? {}), ...(patch ?? {}) },
      },
    } as Partial<ClaudeSettings>);
  };

  return (
    <SettingsGroup
      title="Fleet & MCP"
      action={
        <Button variant="ghost" size="sm" onClick={() => setFleet({ ...DEFAULT_FLEET_SETTINGS })}>
          Reset to defaults
        </Button>
      }
    >
      <SettingRow
        label="Fleet push debounce (ms)"
        description="How long a change waits before the fleet snapshot is pushed to agents. Lower is more accurate, higher is less CPU. 0–1000."
      >
        <NumberStepper
          label="Fleet push debounce"
          min={0}
          max={1000}
          step={25}
          unit="ms"
          value={fleet.fleetPushDebounceMs}
          onChange={(fleetPushDebounceMs) => setFleet({ fleetPushDebounceMs })}
        />
      </SettingRow>
      <SettingRow
        label="List exited panes in the fleet"
        description="Keeps a pane whose process has ended visible to agents asking who is here. Off hides it as soon as it exits."
      >
        <Switch
          checked={fleet.includeExitedInFleet}
          onChange={(value) => setFleet({ includeExitedInFleet: value })}
          label="List exited panes in the fleet"
        />
      </SettingRow>
    </SettingsGroup>
  );
}
