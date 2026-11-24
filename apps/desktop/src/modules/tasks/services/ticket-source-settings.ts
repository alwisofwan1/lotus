import type { ClaudeSettings } from "@/modules/settings/types";
import { resolveVaultSettings } from "@/modules/tasks/services/vault-settings";
import type { GitHubSourceConfig } from "@/modules/tasks/services/github-issues-source";
import type { FieldMapping, NotionSourceConfig, StatusSchema } from "@/modules/tasks/services/notion-source";

/**
 * Which ticket sources this machine has, kept in `~/.claude/settings.json` under `ticketSources`.
 *
 * `ticketSources` is the LIST: which sources exist, and in what order the nav shows them. The
 * Obsidian vault's folder still lives in `vault.path`, and only there. Two reasons, both about
 * builds that already exist (`plans/ticket-sources/PLAN.md` S7):
 * - an older Lotus reads `vault.path` and knows nothing of `ticketSources`, so the path must stay
 *   where it looks;
 * - an older Lotus that changes or clears the vault writes `vault.path` alone. If the path were
 *   copied into `ticketSources` too, the two would disagree the moment that happened. With one
 *   home for the path there is nothing to disagree about.
 *
 * So: a vault path with no list entry (a file from before this change, or written by an older
 * build) is a source; a list entry with no vault path (cleared by an older build) is not.
 *
 * A Notion source has no second home: its whole entry — database, field mapping, the board's
 * status options — lives in the list (task "Ticket Sources 04").
 */

export interface ObsidianSourceConfig {
  id: string;
  kind: "obsidian";
  /** The Obsidian vault's folder, read from `vault.path`. */
  path: string;
}

export type TicketSourceConfig = ObsidianSourceConfig | NotionSourceConfig | GitHubSourceConfig;

/**
 * The Obsidian source's id. v1 allows one vault (S8), and its id stays the one the tracker used
 * before sources existed, so tasks' backlinks and the kept manual order go on pointing at it.
 */
export const OBSIDIAN_SOURCE_ID = "vault";

type SettingsWithSources = ClaudeSettings & { ticketSources?: unknown };

/** The configured sources, in order. Anything unreadable is left out rather than thrown on. */
export function resolveTicketSources(settings: ClaudeSettings | null | undefined): TicketSourceConfig[] {
  const vaultPath = resolveVaultSettings(settings).path;
  const listed = listEntries(settings);
  const sources: TicketSourceConfig[] = [];

  for (const entry of listed) {
    // Kinds this build cannot run (a Linear entry written by a newer build) are kept in the file by
    // the writers below, but not shown: a source nothing can read would only ever say it failed.
    const kind = entryKind(entry);
    if (kind === "notion") {
      const notion = readNotionEntry(entry);
      if (notion && !sources.some((source) => source.id === notion.id)) sources.push(notion);
      continue;
    }
    if (kind === "github") {
      const github = readGitHubEntry(entry);
      // One repo, one source (PLAN G2): a second entry for the same repo is a hand edit, not a source.
      const taken = (source: TicketSourceConfig) =>
        source.id === github?.id || (source.kind === "github" && source.repo.toLowerCase() === github?.repo.toLowerCase());
      if (github && !sources.some(taken)) sources.push(github);
      continue;
    }
    if (kind !== "obsidian") continue;
    if (!vaultPath || sources.some((source) => source.kind === "obsidian")) continue;
    sources.push({ id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: vaultPath });
  }

  if (vaultPath && !sources.some((source) => source.kind === "obsidian")) {
    sources.push({ id: OBSIDIAN_SOURCE_ID, kind: "obsidian", path: vaultPath });
  }
  return sources;
}

/**
 * The settings with the Obsidian source set to `path`, or removed when `path` is null.
 *
 * Every other key — and every other list entry, including kinds this build does not know — is
 * kept exactly as it was, because this file is shared with Claude Code and with other builds.
 */
export function withObsidianSource(settings: ClaudeSettings | null | undefined, path: string | null): ClaudeSettings {
  const base = (settings ?? {}) as SettingsWithSources;
  const others = listEntries(base).filter((entry) => entryKind(entry) !== "obsidian");
  const trimmed = path?.trim() ?? "";
  const existingIndex = listEntries(base).findIndex((entry) => entryKind(entry) === "obsidian");

  let ticketSources: unknown[];
  if (!trimmed) {
    ticketSources = others;
  } else {
    const entry = { id: OBSIDIAN_SOURCE_ID, kind: "obsidian" };
    // Kept in the place it already had, so re-pointing the vault does not reorder the nav.
    ticketSources = [...others];
    ticketSources.splice(existingIndex < 0 ? others.length : existingIndex, 0, entry);
  }

  return {
    ...base,
    ticketSources,
    // `vault.path` is still written — empty when removed, as disconnecting always did — so an
    // older Lotus sees the same vault, or the same absence of one.
    vault: { ...(base.vault ?? {}), path: trimmed },
  } as ClaudeSettings;
}

/** The settings with one Notion source added, or replaced when its id is already listed. */
export function withNotionSource(settings: ClaudeSettings | null | undefined, source: NotionSourceConfig): ClaudeSettings {
  const base = (settings ?? {}) as SettingsWithSources;
  const entries = listEntries(base);
  const at = entries.findIndex((entry) => entryId(entry) === source.id);
  const ticketSources = [...entries];
  if (at < 0) ticketSources.push(source);
  else ticketSources[at] = source;
  return { ...base, ticketSources } as ClaudeSettings;
}

/**
 * The settings with one GitHub source added (PLAN G2, G14). A repo that is already a source — by id
 * or by name in any letter case — is not added again: the settings come back unchanged.
 */
export function withGitHubSource(settings: ClaudeSettings | null | undefined, source: GitHubSourceConfig): ClaudeSettings {
  const base = (settings ?? {}) as SettingsWithSources;
  if (hasGitHubRepo(settings, source.repo) || listEntries(base).some((entry) => entryId(entry) === source.id)) {
    return base as ClaudeSettings;
  }
  return { ...base, ticketSources: [...listEntries(base), source] } as ClaudeSettings;
}

/** `repo` is already a GitHub source, in any letter case. */
export function hasGitHubRepo(settings: ClaudeSettings | null | undefined, repo: string): boolean {
  const wanted = repo.trim().toLowerCase();
  return resolveTicketSources(settings).some((source) => source.kind === "github" && source.repo.toLowerCase() === wanted);
}

/** The settings without the source `id`. The vault is removed with `withObsidianSource(…, null)`. */
export function withoutSource(settings: ClaudeSettings | null | undefined, id: string): ClaudeSettings {
  const base = (settings ?? {}) as SettingsWithSources;
  return { ...base, ticketSources: listEntries(base).filter((entry) => entryId(entry) !== id) } as ClaudeSettings;
}

function entryId(entry: unknown): unknown {
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>).id : undefined;
}

/** A Notion entry, or null when it lacks what a source needs. Hand-edited files are expected. */
function readNotionEntry(entry: unknown): NotionSourceConfig | null {
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(e.id)) return null;
  if (typeof e.dataSourceId !== "string" || !e.dataSourceId) return null;
  const mapping = (e.mapping ?? {}) as Record<string, unknown>;
  const field = (name: keyof FieldMapping) => (typeof mapping[name] === "string" ? (mapping[name] as string) : null);
  return {
    id: e.id,
    kind: "notion",
    name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : "Notion database",
    dataSourceId: e.dataSourceId,
    url: typeof e.url === "string" ? e.url : null,
    mapping: {
      title: field("title"),
      key: field("key"),
      status: field("status"),
      assignee: field("assignee"),
      labels: field("labels"),
      parent: field("parent"),
    },
    statuses: readStatuses(e.statuses),
    permission: e.permission === "manage" ? "manage" : "read_only",
    ...(e.matchNotes === true ? { matchNotes: true } : {}),
  };
}

/** A GitHub login: what `gh` and GitHub accept, and nothing that could reach a command line. */
const GITHUB_ACCOUNT = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** `owner/name`, as `lotus_automation::github_issues::split_repo` accepts it. */
const GITHUB_REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` that a GitHub source can be made of — what a person typed, before it is added. */
export function isGitHubRepoName(repo: string): boolean {
  if (!GITHUB_REPO.test(repo)) return false;
  const name = repo.split("/")[1];
  return name !== "." && name !== "..";
}

/**
 * A GitHub entry (PLAN G16), or null when it lacks what a source needs. Rust checks the same entry
 * again before any call; this only keeps a source that could never sync off the board.
 */
function readGitHubEntry(entry: unknown): GitHubSourceConfig | null {
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(e.id)) return null;
  if (typeof e.account !== "string" || !GITHUB_ACCOUNT.test(e.account)) return null;
  if (typeof e.repo !== "string" || !GITHUB_REPO.test(e.repo)) return null;
  const name = e.repo.split("/")[1];
  if (name === "." || name === "..") return null;
  return {
    id: e.id,
    kind: "github",
    account: e.account,
    repo: e.repo,
    name: typeof e.name === "string" && e.name.trim() ? e.name.trim() : e.repo,
  };
}

function readStatuses(raw: unknown): StatusSchema | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { options?: unknown; groups?: unknown };
  const options = Array.isArray(r.options)
    ? r.options.flatMap((o) =>
        o && typeof o === "object" && typeof (o as { id?: unknown }).id === "string"
          ? [{ id: (o as { id: string }).id, name: String((o as { name?: unknown }).name ?? ""), color: typeof (o as { color?: unknown }).color === "string" ? (o as { color: string }).color : null }]
          : [],
      )
    : [];
  const groups = Array.isArray(r.groups)
    ? r.groups.flatMap((g) => {
        const group = g as { id?: unknown; name?: unknown; optionIds?: unknown };
        if (typeof group.id !== "string") return [];
        const optionIds = Array.isArray(group.optionIds) ? group.optionIds.filter((id): id is string => typeof id === "string") : [];
        return [{ id: group.id, name: String(group.name ?? ""), optionIds }];
      })
    : [];
  return { options, groups };
}

function listEntries(settings: ClaudeSettings | null | undefined): unknown[] {
  const raw = (settings as SettingsWithSources | null | undefined)?.ticketSources;
  return Array.isArray(raw) ? raw : [];
}

function entryKind(entry: unknown): unknown {
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>).kind : undefined;
}
