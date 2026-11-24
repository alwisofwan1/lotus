"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/contexts/ThemeContext";
import { getUiZoom, setUiZoom, subscribeUiZoom, UI_ZOOM_STEPS } from "@/lib/ui-zoom";
import { SettingSelectRow } from "@/modules/lotus-settings/components/SettingSelectRow";
import { SettingRow, SettingsGroup } from "@/modules/lotus-settings/components/SettingsGroup";
import { ThemeModeGroup } from "@/modules/settings/components/ThemeModeCard";

const MODE_NAMES = { dark: "Dark", light: "Light" } as const;
const ZOOM_OPTIONS = UI_ZOOM_STEPS.map((step) => ({
  value: String(step),
  label: step === 1 ? "100% (Default)" : `${Math.round(step * 100)}%`,
}));

export function AppearanceSettingsSection() {
  const { themePreference, systemThemeMode, setThemePreference } = useTheme();
  const [zoom, setZoom] = useState(getUiZoom);
  useEffect(() => subscribeUiZoom(setZoom), []);

  return (
    <SettingsGroup title="Appearance">
      <SettingRow
        label="Theme"
        description={
          <>
            Choose how Lotus looks. System follows your macOS setting
            {themePreference === "system" ? <> — currently {MODE_NAMES[systemThemeMode]}</> : null}.
          </>
        }
        body={<ThemeModeGroup value={themePreference} onChange={setThemePreference} />}
      />
      <SettingSelectRow
        title="Interface size"
        description="Scales all text and controls in every Lotus window. ⌘+ and ⌘− step it, ⌘0 resets."
        selectLabel="Interface size"
        options={ZOOM_OPTIONS}
        value={String(zoom)}
        onChange={(next) => void setUiZoom(Number(next)).catch(() => undefined)}
      />
    </SettingsGroup>
  );
}
