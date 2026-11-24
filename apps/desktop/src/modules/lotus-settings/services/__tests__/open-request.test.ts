import { describe, expect, it } from "vitest";
import { resolveSettingsSection, type SettingsSectionRef } from "../open-request";

// The registry since the 2026-11 cleanup: ten sections, one per mode gear.
const FULL: SettingsSectionRef[] = [
  { id: "general", group: "lotus" },
  { id: "agents", group: "lotus" },
  { id: "accounts", group: "lotus" },
  { id: "voice", group: "lotus" },
  { id: "chat", group: "chat" },
  { id: "canvas", group: "canvas" },
  { id: "codespace", group: "code" },
  { id: "hotkeys", group: "lotus" },
  { id: "mobile", group: "lotus" },
  { id: "about", group: "lotus" },
];

// What this ticket ships: no Code or Chat sections yet, no Editor.
const PARTIAL: SettingsSectionRef[] = [
  { id: "voice", group: "lotus" },
  { id: "runners", group: "lotus" },
  { id: "canvas-style", group: "canvas" },
  { id: "canvas", group: "canvas" },
];

describe("resolveSettingsSection", () => {
  it("opens the canvas gear on Canvas even when another section is remembered", () => {
    expect(resolveSettingsSection(FULL, { from: "canvas-gear" }, { remembered: "voice", mode: "canvas" })).toBe("canvas");
  });

  it("opens the Code and Chat rail gears on their own group", () => {
    expect(resolveSettingsSection(FULL, { from: "code-rail" }, { remembered: "voice", mode: "code" })).toBe("codespace");
    expect(resolveSettingsSection(FULL, { from: "chat-rail" }, { remembered: "voice", mode: "chat" })).toBe("chat");
  });

  it("opens Dictate on Lotus › Voice", () => {
    expect(resolveSettingsSection(FULL, { from: "dictate" }, { remembered: "hotkeys", mode: "code" })).toBe("voice");
  });

  it("reopens the hotkey on the remembered section, including one remembered before the cleanup", () => {
    expect(resolveSettingsSection(FULL, { from: "hotkey" }, { remembered: "hotkeys", mode: "canvas" })).toBe("hotkeys");
    expect(resolveSettingsSection(FULL, { from: "hotkey" }, { remembered: "runners", mode: "canvas" })).toBe("agents");
  });

  it("defaults the hotkey to the first section of the current mode's group", () => {
    expect(resolveSettingsSection(FULL, { from: "hotkey" }, { remembered: null, mode: "canvas" })).toBe("canvas");
    expect(resolveSettingsSection(FULL, { from: "hotkey" }, { remembered: null, mode: "chat" })).toBe("chat");
  });

  it("defaults to General when there is no mode, and ignores a remembered id that no longer exists", () => {
    expect(resolveSettingsSection(FULL, { from: "hotkey" }, { remembered: "gone", mode: null })).toBe("general");
  });

  it("maps every legacy Settings page id to its new home", () => {
    const at = (section: string) => resolveSettingsSection(FULL, { section }, { remembered: "voice", mode: "code" });
    const moved: Record<string, string> = {
      general: "general", editor: "general", appearance: "general",
      runners: "agents", updates: "agents", "lotus-agent": "agents", "agent-teams": "agents", bridge: "agents",
      "chat-accounts": "accounts", "chat-titles": "chat", "chat-reading": "chat", codechat: "chat", permissions: "chat",
      "canvas-style": "canvas", style: "canvas", "ssh-right-panel": "about", codespace: "codespace", about: "about",
    };
    for (const [old, now] of Object.entries(moved)) expect(at(old), old).toBe(now);
  });

  it("lets an explicit section win over the entry point", () => {
    expect(resolveSettingsSection(FULL, { from: "canvas-gear", section: "hotkeys" }, { remembered: null, mode: "canvas" })).toBe("hotkeys");
  });

  it("falls back to the first section when the target group or section is not there yet", () => {
    expect(resolveSettingsSection(PARTIAL, { from: "code-rail" }, { remembered: null, mode: "code" })).toBe("voice");
    expect(resolveSettingsSection(PARTIAL, { section: "general" }, { remembered: null, mode: "code" })).toBe("voice");
    expect(resolveSettingsSection(PARTIAL, { from: "hotkey" }, { remembered: null, mode: "chat" })).toBe("voice");
  });
});
