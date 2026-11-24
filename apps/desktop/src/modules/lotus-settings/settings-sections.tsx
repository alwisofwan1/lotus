import { Bot, FolderGit2, Frame, Info, Keyboard, KeyRound, MessageSquare, Smartphone, SquareTerminal, SunMoon, Volume2, type LucideIcon } from "lucide-react";
import { lazy } from "react";
import type { SettingsSectionRef } from "./services/open-request";

// Loaded on first view, not with the app shell: the provider is mounted on every route, and the
// sections pull in voice, runners and the Canvas Style engine.
const tab = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })));
const GeneralSection = tab(() => import("./sections/LotusSections"), "GeneralSection");
const AgentsSection = tab(() => import("./sections/LotusSections"), "AgentsSection");
const AccountsSection = tab(() => import("./sections/CodeSections"), "AccountsSection");
const VoiceTab = tab(() => import("@/modules/codecanvas/components/settings/tabs/VoiceTab"), "VoiceTab");
const ChatSection = tab(() => import("./sections/CodeSections"), "ChatSection");
const CanvasSection = tab(() => import("./sections/LotusSections"), "CanvasSection");
const CodeSpaceSection = tab(() => import("./sections/CodeSections"), "CodeSpaceSection");
const WorktreesSection = tab(() => import("./sections/WorktreesSection"), "WorktreesSection");
const HotkeysTab = tab(() => import("@/modules/codecanvas/components/settings/tabs/HotkeysTab"), "HotkeysTab");
const MobileTab = tab(() => import("@/modules/codecanvas/components/settings/tabs/MobileTab"), "MobileTab");
const AboutSection = tab(() => import("./sections/LotusSections"), "AboutSection");

export interface SettingsSectionEntry extends SettingsSectionRef {
  title: string;
  icon: LucideIcon;
  render: () => React.ReactNode;
}

/**
 * Every section of Lotus Settings, in sidebar order. The sidebar is one flat list; `group` only
 * picks where a mode's gear opens (canvas gear → Canvas, Code rail → CodeSpace, Chat rail → Chat).
 * Only list sections backed by a real working setting — no "coming soon" placeholders.
 *
 * A section used by more than one mode belongs to *Lotus*, never to a mode's group (ADR-0054).
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionEntry[] = [
  { group: "lotus", id: "general", title: "General", icon: SunMoon, render: () => <GeneralSection /> },
  { group: "lotus", id: "agents", title: "Agents", icon: Bot, render: () => <AgentsSection /> },
  { group: "lotus", id: "accounts", title: "Accounts", icon: KeyRound, render: () => <AccountsSection /> },
  { group: "lotus", id: "voice", title: "Voice", icon: Volume2, render: () => <VoiceTab /> },
  { group: "chat", id: "chat", title: "Chat", icon: MessageSquare, render: () => <ChatSection /> },
  { group: "canvas", id: "canvas", title: "Canvas", icon: Frame, render: () => <CanvasSection /> },
  { group: "code", id: "codespace", title: "CodeSpace", icon: SquareTerminal, render: () => <CodeSpaceSection /> },
  { group: "lotus", id: "worktrees", title: "Worktrees", icon: FolderGit2, render: () => <WorktreesSection /> },
  { group: "lotus", id: "hotkeys", title: "Hotkeys", icon: Keyboard, render: () => <HotkeysTab /> },
  { group: "lotus", id: "mobile", title: "Mobile", icon: Smartphone, render: () => <MobileTab /> },
  { group: "lotus", id: "about", title: "About", icon: Info, render: () => <AboutSection /> },
];
