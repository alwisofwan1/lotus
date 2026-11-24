"use client";

import { useEffect, useState } from "react";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";
import type { ClaudeSettings } from "@/modules/settings/types";
import { Status } from "@/components/ui/status";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import { getAgentHooksHealth, type AgentHooksHealth } from "@/lib/tauri/codespace";

export function AgentTeamsSettingsSection({
  settings,
  update,
}: {
  settings: ClaudeSettings;
  update: (patch: Partial<ClaudeSettings>) => void;
}) {
  const experimentalTeams = settings.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1";

  const setExperimentalTeams = (enabled: boolean) => {
    update({
      env: {
        ...settings.env,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: enabled ? "1" : "0",
      },
    });
  };

  return (
    <SettingsGroup title="Agent teams">
      <SettingToggleRow
        title="Agent teams in my own claude sessions"
        description="For sessions you start yourself; teams Lotus launches always have it on."
        checked={experimentalTeams}
        onChange={setExperimentalTeams}
      />
    </SettingsGroup>
  );
}

/** Agent-notify hook health, shown under Agents › Advanced. Renders nothing until Rust answers. */
export function HookDiagnostics() {
  const [health, setHealth] = useState<AgentHooksHealth | null>(null);

  useEffect(() => {
    getAgentHooksHealth().then(setHealth).catch(() => setHealth(null));
  }, []);

  if (!health) return null;
  const checks = [
    { label: "Scripts installed", ok: health.scripts_installed },
    { label: "Stop hook registered", ok: health.stop_hook_registered },
    { label: "Notification hook registered", ok: health.notification_hook_registered },
  ];
  const allHealthy = checks.every((c) => c.ok);

  return (
    <SettingsGroup
      title="Hook diagnostics"
      footer={allHealthy ? undefined : "Restart Lotus to reinstall scripts and re-register hooks."}
    >
      {checks.map((check) => (
        <SettingRow key={check.label} label={check.label}>
          <Status tone={check.ok ? "ok" : "warn"}>{check.ok ? "OK" : "Missing"}</Status>
        </SettingRow>
      ))}
    </SettingsGroup>
  );
}
