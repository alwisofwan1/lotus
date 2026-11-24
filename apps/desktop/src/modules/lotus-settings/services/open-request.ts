/**
 * Which section Lotus Settings shows when it opens (ADR-0054).
 *
 * Every entry point — ⌘, the canvas gear, the Code and Chat rail gears, Dictate, an old
 * `/settings?section=` link — goes through this one pure function, so they cannot drift apart.
 */

export type SettingsGroupId = "lotus" | "canvas" | "code" | "chat";

/** The mode on screen, which is also the name of its Settings Group. */
export type SettingsMode = Exclude<SettingsGroupId, "lotus">;

export type SettingsEntryPoint = "hotkey" | "canvas-gear" | "code-rail" | "chat-rail" | "dictate";

export interface SettingsOpenRequest {
  from?: SettingsEntryPoint;
  /** A section id, new or legacy. Wins over `from`. */
  section?: string;
}

export interface SettingsSectionRef {
  id: string;
  group: SettingsGroupId;
}

/**
 * Ids from earlier layouts, mapped to the section that holds that content now. The 2026-11 cleanup
 * folded 17 sections into 10 (plans/settings-cleanup/AUDIT.md); old links and a remembered id from
 * before it still land on the right page.
 */
const LEGACY_SECTION_IDS: Readonly<Record<string, string>> = {
  editor: "general",
  appearance: "general",
  runners: "agents",
  updates: "agents",
  "lotus-agent": "agents",
  "agent-teams": "agents",
  bridge: "agents",
  "chat-accounts": "accounts",
  "chat-titles": "chat",
  "chat-reading": "chat",
  codechat: "chat",
  permissions: "chat",
  "canvas-style": "canvas",
  style: "canvas",
  "ssh-right-panel": "about",
};

const GROUP_BY_ENTRY: Partial<Record<SettingsEntryPoint, SettingsGroupId>> = {
  "canvas-gear": "canvas",
  "code-rail": "code",
  "chat-rail": "chat",
};

export function resolveSettingsSection(
  sections: readonly SettingsSectionRef[],
  request: SettingsOpenRequest,
  context: { remembered: string | null; mode: SettingsMode | null },
): string {
  const exists = (id: string | null | undefined): id is string => !!id && sections.some((s) => s.id === id);
  const firstOf = (group: SettingsGroupId) => sections.find((s) => s.group === group)?.id;
  const current = (id: string | null | undefined) => (id ? LEGACY_SECTION_IDS[id] ?? id : id);
  const fallback = (exists("general") ? "general" : firstOf("lotus")) ?? sections[0]?.id ?? "";

  if (request.section) {
    const id = current(request.section);
    return exists(id) ? id : fallback;
  }

  const from = request.from ?? "hotkey";
  if (from === "dictate") return exists("voice") ? "voice" : fallback;

  const group = GROUP_BY_ENTRY[from];
  if (group) return firstOf(group) ?? fallback;

  const remembered = current(context.remembered);
  if (exists(remembered)) return remembered;
  return (context.mode && firstOf(context.mode)) || fallback;
}
