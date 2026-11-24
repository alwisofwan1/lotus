"use client";
import { ChevronRight } from "lucide-react";
import { CanvasBehaviorTab } from "@/modules/codecanvas/components/settings/tabs/CanvasBehaviorTab";
import { StyleTab } from "@/modules/codecanvas/components/settings/tabs/StyleTab";
import { AboutSettingsSection } from "@/modules/settings/components/AboutSettingsSection";
import { AgentTeamsSettingsSection, HookDiagnostics } from "@/modules/settings/components/AgentTeamsSettingsSection";
import { AppearanceSettingsSection } from "@/modules/settings/components/AppearanceSettingsSection";
import { FleetSettingsSection } from "@/modules/settings/components/FleetSettingsSection";
import { SettingsFileSection } from "../components/SettingsFileSection";
import { SettingsSection } from "../components/SettingsSection";
import { SettingToggleRow } from "../components/SettingToggleRow";
import { readNeedsYouAlertSettings } from "@/modules/workspace-shell/hooks/useNeedsYouAlerts";
import { AgentClisSection } from "./AgentClisSection";
import { AgentNamesSection } from "./AgentNamesSection";
import { EditorSection } from "./EditorSection";
import { LotusAppUpdate } from "./UpdatesSection";
import { ManagedHostsGroup } from "@/modules/managed-host/ManagedHostsGroup";

/** General: how Lotus looks, and where file links open. */
export function GeneralSection() {
  return (
    <div className="flex flex-col gap-6">
      <AppearanceSettingsSection />
      <EditorSection />
      <NeedsYouNotifications />
    </div>
  );
}

/** macOS notifications for Needs you (GLOSSARY), only while Lotus is not the front window. */
function NeedsYouNotifications() {
  return (
    <SettingsSection label="Notifications" description="Only while Lotus is not the front window. Clicking one opens the agent.">
      <SettingsFileSection>
        {(settings, update) => {
          const alerts = readNeedsYouAlertSettings(settings);
          const set = (change: Partial<typeof alerts>) =>
            update({ codespace: { ...settings.codespace, needsYouAlerts: { ...alerts, ...change } } });
          return (
            <>
              <SettingToggleRow title="Agent needs input" checked={alerts.needsInput} onChange={(needsInput) => set({ needsInput })} />
              <SettingToggleRow
                title="Agent finished"
                description="The finish sound in Voice already tells you"
                checked={alerts.done}
                onChange={(done) => set({ done })}
              />
            </>
          );
        }}
      </SettingsFileSection>
    </SettingsSection>
  );
}

/**
 * Agents: the agent CLIs (runner flags + versions and updates), Agent Teams, and the fleet
 * tuning knobs behind Advanced.
 */
export function AgentsSection() {
  return (
    <div className="flex flex-col gap-6">
      <AgentClisSection />
      <AgentNamesSection />
      <SettingsFileSection>
        {(settings, update) => (
          <>
            <AgentTeamsSettingsSection settings={settings} update={update} />
            <details className="ui-disclosure">
              <summary>
                <ChevronRight size={12} aria-hidden />
                Advanced
              </summary>
              <div className="flex flex-col gap-6">
                <FleetSettingsSection settings={settings} update={update} />
                <HookDiagnostics />
              </div>
            </details>
          </>
        )}
      </SettingsFileSection>
    </div>
  );
}

/** Canvas: its Style gallery, then how it behaves. */
export function CanvasSection() {
  return (
    <div className="flex flex-col gap-6">
      <StyleTab />
      <CanvasBehaviorTab />
    </div>
  );
}

/** About: the Lotus version and its self-update, then the files Lotus keeps. */
export function AboutSection() {
  return (
    <div className="flex flex-col gap-6">
      <LotusAppUpdate />
      <ManagedHostsGroup />
      <AboutSettingsSection />
    </div>
  );
}
