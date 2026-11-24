"use client";
import {
  useCanvasBehaviorSettings,
  type CommandBarRestPref,
  type TidyMode,
  type TopControlsPref,
} from "@/modules/codecanvas/hooks/useCanvasBehaviorSettings";
import type { ToastPosition } from "@/modules/codecanvas/services/agent-completion-toast";
import { SettingToggleRow } from "@/modules/lotus-settings/components/SettingToggleRow";
import { SettingSegmentedRow } from "@/modules/lotus-settings/components/SettingSegmentedRow";
import { SettingSelectRow } from "@/modules/lotus-settings/components/SettingSelectRow";
import { SettingsSection as Section } from "@/modules/lotus-settings/components/SettingsSection";

const TOP_CONTROLS_OPTIONS: { value: TopControlsPref; label: string }[] = [
  { value: "top-bar", label: "Top bar" },
  { value: "command-bar", label: "In command bar" },
];

const COMMAND_BAR_REST_OPTIONS: { value: CommandBarRestPref; label: string }[] = [
  { value: "slab", label: "Solid bar (default)" },
  { value: "veil", label: "Bottom strip" },
];

const TOAST_POSITION_OPTIONS: { value: ToastPosition; label: string }[] = [
  { value: "bottom-right", label: "Bottom right (default)" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "top-right", label: "Top right" },
  { value: "top-left", label: "Top left" },
  { value: "bottom-center", label: "Bottom center" },
];

const TIDY_OPTIONS: { value: TidyMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "notes", label: "Notes only" },
  { value: "open", label: "When a node opens (default)" },
  { value: "open-close", label: "When a node opens or closes" },
];


// "Canvas — how the canvas behaves". Three groups: Layout, Agents, Behavior. Every row gates a real
// behaviour; new preferences land as a row + a field in useCanvasBehaviorSettings.
export function CanvasBehaviorTab() {
  const {
    allowAgentCanvasControl,
    allowAgentCanvasDraw,
    autoFocusNewNodes,
    restoreViewportOnOpen,
    tidyMode,
    canvasAnimations,
    showToolRail,
    topControls,
    commandBarRest,
    toastPosition,
    completionToastAutoDismiss,
    autoOpenBrowserOnDevServer,
    setBehavior,
  } = useCanvasBehaviorSettings();

  return (
    <div className="flex flex-col gap-6">
      <Section label="Layout">
        <SettingToggleRow
          title="Left toolbar"
          description="Drawing tools on the left edge. Off also disables the drawing shortcuts; V and H still work."
          checked={showToolRail}
          onChange={(v) => setBehavior("showToolRail", v)}
        />
        <SettingSegmentedRow
          title="Top controls"
          description="Project switcher, Canvases and Settings: a top pill, or docked in the command bar."
          options={TOP_CONTROLS_OPTIONS}
          value={topControls}
          onChange={(v) => setBehavior("topControls", v)}
        />
        <SettingSegmentedRow
          title="Command bar"
          description="Solid bar is always visible; Bottom strip gathers into the bar when you focus it."
          options={COMMAND_BAR_REST_OPTIONS}
          value={commandBarRest}
          onChange={(v) => setBehavior("commandBarRest", v)}
        />
      </Section>

      <Section label="Agents">
        <SettingToggleRow
          title="Let agents move the canvas & focus"
          description="Agents may pan, zoom, focus a node or auto-arrange. Your own mouse and voice are never affected."
          checked={allowAgentCanvasControl}
          onChange={(v) => setBehavior("allowAgentCanvasControl", v)}
        />
        <SettingToggleRow
          title="Let agents draw & generate diagrams"
          description="Large batches arrive as a draft you Apply or Discard."
          checked={allowAgentCanvasDraw}
          onChange={(v) => setBehavior("allowAgentCanvasDraw", v)}
        />
        <SettingToggleRow
          title="Auto-open browser on dev server"
          description="Open a Browser Node when a canvas Terminal prints its localhost URL."
          checked={autoOpenBrowserOnDevServer}
          onChange={(v) => setBehavior("autoOpenBrowserOnDevServer", v)}
        />
      </Section>

      <Section label="Behavior">
        <SettingSelectRow
          title="Tidy nodes"
          description="Re-tile the canvas into a grid when a single node opens or closes."
          selectLabel="Tidy nodes"
          options={TIDY_OPTIONS}
          value={tidyMode}
          onChange={(v) => setBehavior("tidyMode", v)}
        />
        <SettingToggleRow
          title="Auto-focus new nodes"
          description="Pan and zoom to a node when it is created."
          checked={autoFocusNewNodes}
          onChange={(v) => setBehavior("autoFocusNewNodes", v)}
        />
        <SettingToggleRow
          title="Restore viewport on open"
          description="Reopen a project at the same pan and zoom."
          checked={restoreViewportOnOpen}
          onChange={(v) => setBehavior("restoreViewportOnOpen", v)}
        />
        <SettingToggleRow
          title="Smooth canvas animations"
          description="Ease nodes in and out and glide the camera. Off, or reduced motion, makes changes instant."
          checked={canvasAnimations}
          onChange={(v) => setBehavior("canvasAnimations", v)}
        />
        <SettingToggleRow
          title="Auto-dismiss completion notifications"
          description="Close the “agent finished” toast after 6 to 10 seconds."
          checked={completionToastAutoDismiss}
          onChange={(v) => setBehavior("completionToastAutoDismiss", v)}
        />
        <SettingSelectRow
          title="Completion toast position"
          description="Where the “agent finished” toast sits. It never steals focus."
          selectLabel="Completion toast position"
          options={TOAST_POSITION_OPTIONS}
          value={toastPosition}
          onChange={(v) => setBehavior("toastPosition", v)}
        />
      </Section>
    </div>
  );
}
