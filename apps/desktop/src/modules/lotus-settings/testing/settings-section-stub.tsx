import { Settings } from "lucide-react";
import type { SettingsGroupId } from "../services/open-request";
import type { SettingsSectionEntry } from "../settings-sections";

/** A section with no Tauri traffic, for tests of whatever opens Lotus Settings. Titled by its id. */
export function settingsSectionStub(group: SettingsGroupId, id: string): SettingsSectionEntry {
  return { group, id, title: id, icon: Settings, render: () => <p>{id} body</p> };
}
