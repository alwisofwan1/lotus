"use client";

import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";

/** Where Lotus keeps its files. Paths match `src-tauri/src/paths.rs`. */
const FILES: Array<{ label: string; desc: string; path: string }> = [
  { label: "Settings file", desc: "Shared with Claude Code", path: "~/.claude/settings.json" },
  { label: "Lotus data", desc: "Teams, runners, voice engines and logs", path: "~/.lotus" },
];

export function AboutSettingsSection() {
  return (
    <SettingsGroup title="Files">
      {FILES.map((file) => (
        <SettingRow key={file.label} label={file.label} description={file.desc}>
          <code className="ds-t-meta font-mono text-(--ui-ink-3)">{file.path}</code>
        </SettingRow>
      ))}
    </SettingsGroup>
  );
}
