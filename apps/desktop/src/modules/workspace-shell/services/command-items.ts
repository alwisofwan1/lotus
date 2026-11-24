import type { PaneActivity, PaneKind, RailWorkspace } from "@/modules/workspace-shell/types";
import type { ShellAgent } from "@/modules/workspace-shell/services/agent-catalog";
import { PANE_OPTIONS } from "@/modules/workspace-shell/services/pane-presets";
import { paneCountLabel } from "@/modules/workspace-shell/services/cell-mapping";

/**
 * One list of everything the shell can be asked to do, and how to rank it against what was typed.
 *
 * Deliberately NOT canvas's `command-sheet-items`: that one carries priors this shell does not
 * have — six groups, a per-group browse budget tuned against live cells, and an NL "send what you
 * typed" row that must never be pushed below the fold. Inheriting those would mean inheriting
 * decisions made for a different surface. What IS shared is the thing that matters, the catalog of
 * agents, and that lives in Rust (`cli_detect.rs`) where both surfaces read it.
 */

export type CommandGroup = "launch" | "create" | "layout" | "frame" | "goto";

export const COMMAND_GROUP_LABEL: Record<CommandGroup, string> = {
  launch: "Launch agent",
  create: "New pane",
  layout: "Layout",
  frame: "Groups",
  goto: "Go to",
};

const GROUP_ORDER: CommandGroup[] = ["launch", "create", "layout", "frame", "goto"];

export interface CommandItem {
  id: string;
  title: string;
  /** The second line. For a launch row it is the COMMAND — the one thing that differs per row. */
  detail: string;
  /** Extra words the row should answer to, never shown. */
  keywords: string;
  group: CommandGroup;
  /** Right-aligned, and coarser than the group: what happens when you press Enter. */
  tag: string;
  /** Which glyph and hue the row wears. */
  kind: PaneKind;
  /** A pane row's live state, so the sheet can say which agent is waiting before you jump. */
  activity?: PaneActivity;
  /** Listed but not runnable — a CLI this machine does not have. */
  disabled?: boolean;
  run: () => void;
  /** ⇥ on the row: changes what it runs on (the Claude row's account). */
  cycle?: () => void;
  /** With `cycle`: the account ⇥ picked; null = the default. */
  account?: string | null;
}

export interface CommandItemSources {
  agents: readonly ShellAgent[];
  workspaces: readonly RailWorkspace[];
  activeWorkspaceName: string | null;
  onLaunchAgent: (agent: ShellAgent) => void;
  /** The account the Claude row launches on; null = the default. Chosen with ⇥ (decision 10). */
  launchAccount?: string | null;
  onCycleAccount?: (accounts: string[]) => void;
  onCreatePane: (kind: PaneKind) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onOpenPane: (workspaceId: string, paneId: string) => void;
  onOpenFrame: (workspaceId: string, frameId: string) => void;
  /** Panes open in the showing workspace — below two there is nothing to arrange. */
  paneCount: number;
  onTidyPanes: () => void;
}

export function buildCommandItems({
  agents,
  workspaces,
  activeWorkspaceName,
  onLaunchAgent,
  launchAccount = null,
  onCycleAccount,
  onCreatePane,
  onOpenWorkspace,
  onOpenPane,
  onOpenFrame,
  paneCount,
  onTidyPanes,
}: CommandItemSources): CommandItem[] {
  // One Claude row, not one per account: its account is picked with ⇥ (mockup decision 10).
  const accounts = agents.flatMap((agent) => (agent.claudeAccount ? [agent.claudeAccount] : []));
  const launch: CommandItem[] = agents
    .filter((agent) => !agent.claudeAccount)
    .map((plain) => {
      const choosable = plain.id === "claude" && plain.installed && accounts.length > 0 && !!onCycleAccount;
      const on = choosable && launchAccount ? launchAccount : null;
      const agent = on ? { ...plain, claudeAccount: on } : plain;
      return {
        id: `launch-${agent.id}`,
        title: agent.name,
        // The command, not a sentence. Seven rows that all read "start an agent" carry no information
        // where it is needed most; the binary and its flags are what differ.
        detail: !agent.installed
          ? `${agent.command} · not found on this machine`
          : agent.command,
        keywords: `agent cli run launch start ${agent.id}${choosable ? ` account ${accounts.join(" ")}` : ""}`,
        group: "launch" as const,
        tag: "AGENT",
        kind: "terminal" as const,
        disabled: !agent.installed,
        run: () => onLaunchAgent(agent),
        ...(choosable ? { cycle: () => onCycleAccount!(accounts), account: on } : {}),
      };
    });

  const create: CommandItem[] = PANE_OPTIONS.map((option) => ({
    id: `create-${option.kind}`,
    title: option.label,
    detail: option.detail,
    keywords: `pane new add open ${option.kind}`,
    group: "create",
    tag: "PANE",
    kind: option.kind,
    run: () => onCreatePane(option.kind),
  }));

  // Offered only when there is something to arrange: a row that does nothing to one pane is a row
  // that teaches you to distrust the list.
  const layout: CommandItem[] =
    paneCount >= 2
      ? [
          {
            id: "layout-tidy",
            title: "Tidy panes",
            detail: `arrange ${paneCount} panes into an even grid`,
            keywords: "arrange tidy grid layout balance even",
            group: "layout",
            tag: "LAYOUT",
            kind: "editor",
            run: onTidyPanes,
          },
        ]
      : [];

  const frame: CommandItem[] = [];
  const goto: CommandItem[] = [];
  for (const workspace of workspaces) {
    // A split has no name to search by: its panes are found as panes.
    for (const f of workspace.frames?.filter((candidate) => !candidate.split) ?? []) {
      frame.push({
        id: `frame-${f.id}`,
        title: f.name,
        detail: `${workspace.name} · ${paneCountLabel(f.paneCount)}`,
        keywords: "group frame open switch context",
        group: "frame",
        tag: "GROUP",
        kind: "editor",
        run: () => onOpenFrame(workspace.id, f.id),
      });
    }
    // The folder already on screen is not somewhere to go.
    if (workspace.name !== activeWorkspaceName) {
      goto.push({
        id: `goto-workspace-${workspace.id}`,
        title: workspace.name,
        detail: `workspace · ${workspace.panes.length} pane${workspace.panes.length === 1 ? "" : "s"}`,
        keywords: `workspace folder open switch ${workspace.id}`,
        group: "goto",
        tag: "GO TO",
        kind: "editor",
        run: () => onOpenWorkspace(workspace.id),
      });
    }
    for (const pane of workspace.panes) {
      goto.push({
        id: `goto-pane-${pane.id}`,
        title: pane.title,
        detail: `${[workspace.name, groupLabel(workspace.frames?.find((f) => f.paneIds.includes(pane.id)))].filter(Boolean).join(" / ")} · ${pane.meta || pane.kind}`,
        keywords: `pane focus open ${pane.kind}`,
        group: "goto",
        tag: "GO TO",
        kind: pane.kind,
        activity: pane.activity,
        run: () => onOpenPane(workspace.id, pane.id),
      });
    }
  }

  return [...launch, ...create, ...layout, ...frame, ...goto];
}

const groupLabel = (frame: { name: string; split: boolean } | undefined) => (frame ? (frame.split ? "Split" : frame.name) : null);

/** Nothing typed: the curated sections. See `rankCommandItems`. */
export function isBrowseQuery(query: string): boolean {
  return query.trim().length === 0;
}

/** How many rows a single group may spend in browse mode, so no group pushes another off screen. */
export const BROWSE_GROUP_LIMIT = 5;
export const SEARCH_LIMIT = 9;

/**
 * A row matches only when EVERY word typed appears somewhere in it, and scores by where.
 *
 * Word-by-word rather than substring: "cl code" should find Claude Code, and it does not if the
 * query is matched whole. A title hit outranks a detail hit because the title is what was read.
 */
export function scoreCommandMatch(item: Pick<CommandItem, "title" | "detail" | "keywords" | "disabled">, query: string): number | null {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;

  const title = item.title.toLowerCase();
  const haystack = `${title} ${item.detail.toLowerCase()} ${item.keywords.toLowerCase()}`;

  let score = 0;
  for (const word of words) {
    if (!haystack.includes(word)) return null;
    if (title.startsWith(word)) score += 6;
    else if (new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(title)) score += 4;
    else if (title.includes(word)) score += 2;
    else score += 1;
  }
  // A CLI that is not on this machine still matches, but never wins: it cannot be run.
  return item.disabled ? score - 3 : score;
}

export interface RankedCommands {
  /** Flat, in render order. Headings are carried by `sections` and only in browse mode. */
  items: CommandItem[];
  /** Browse mode only: where each heading falls, keyed by the index of its first row. */
  sections: { index: number; label: string }[];
}

/**
 * Browse shows sections. Search does not.
 *
 * Once the rows are ordered by relevance the groups are no longer contiguous, and a heading above
 * a list that is no longer its group is a heading that lies about what follows it. So search
 * returns one flat ranked list and lets the tag column carry the classification.
 */
export function rankCommandItems(items: readonly CommandItem[], query: string): RankedCommands {
  if (isBrowseQuery(query)) {
    const ordered: CommandItem[] = [];
    const sections: { index: number; label: string }[] = [];
    for (const group of GROUP_ORDER) {
      const rows = items.filter((item) => item.group === group).slice(0, BROWSE_GROUP_LIMIT);
      if (rows.length === 0) continue;
      sections.push({ index: ordered.length, label: COMMAND_GROUP_LABEL[group] });
      ordered.push(...rows);
    }
    return { items: ordered, sections };
  }

  const scored = items
    .map((item) => ({ item, score: scoreCommandMatch(item, query) }))
    .filter((entry): entry is { item: CommandItem; score: number } => entry.score !== null)
    .sort((left, right) => right.score - left.score)
    .slice(0, SEARCH_LIMIT)
    .map((entry) => entry.item);

  return { items: scored, sections: [] };
}
