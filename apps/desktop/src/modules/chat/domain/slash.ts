/**
 * The `/` picker in the composer: what the agent offers, how typing filters it, and the text a
 * pick sends. Plan: plans/chat-skills/PLAN.md.
 */

export type SlashKind = "command" | "skill";

export interface SlashItem {
  kind: SlashKind;
  name: string;
  description: string;
  argumentHint: string | null;
  /** "user", "project", "plugin", "built-in", … — shown in the detail line. */
  source: string | null;
  path: string | null;
}

/** Builtins that make sense in Chat; Claude's others (config, model, …) are terminal UI. */
const CHAT_COMMANDS: Record<string, string> = {
  clear: "Start fresh context in this thread",
  compact: "Summarize the conversation to free up context",
};

/** One row of the SDK's `supportedCommands()`. */
export interface ClaudeCommand {
  name: string;
  description: string;
  argumentHint?: string;
  builtin?: boolean;
}

const SCOPE_TAG = /\s*\((user|project|local|claude\.ai sync)\)\s*$/;

/** Claude: commands = `clear`/`compact`; skills = the `reloadSkills()` names plus every non-builtin. */
export function claudeSlashItems(commands: readonly ClaudeCommand[], skillNames: readonly string[]): SlashItem[] {
  const skills = new Set(skillNames);
  const items: SlashItem[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    const hint = c.argumentHint?.trim() || null;
    if (c.name in CHAT_COMMANDS) {
      items.push({ kind: "command", name: c.name, description: CHAT_COMMANDS[c.name], argumentHint: null, source: "built-in", path: null });
      continue;
    }
    if (c.builtin && !skills.has(c.name)) continue;
    const tag = SCOPE_TAG.exec(c.description)?.[1];
    items.push({
      kind: "skill",
      name: c.name,
      description: c.description.replace(SCOPE_TAG, "").trim(),
      argumentHint: hint,
      source: c.name.includes(":") ? "plugin" : (tag ?? (c.builtin ? "built-in" : null)),
      path: null,
    });
  }
  return items;
}

/** One row of Codex `skills/list`. */
export interface CodexSkill {
  name: string;
  description: string;
  shortDescription?: string | null;
  path: string;
  scope: string;
  enabled: boolean;
}

/** Codex: `clear`/`compact` (the bridge runs them as app-server methods), then its skills. */
export function codexSlashItems(skills: readonly CodexSkill[]): SlashItem[] {
  const seen = new Set<string>();
  const commands = Object.entries(CHAT_COMMANDS).map(([name, description]): SlashItem => ({
    kind: "command",
    name,
    description,
    argumentHint: null,
    source: "built-in",
    path: null,
  }));
  return [...commands, ...skills.flatMap((s) => {
    if (!s.enabled || seen.has(s.name)) return [];
    seen.add(s.name);
    const source = s.scope === "repo" ? "project" : s.scope;
    return [{ kind: "skill" as const, name: s.name, description: (s.shortDescription || s.description).trim(), argumentHint: null, source, path: s.path }];
  })];
}

export interface SlashMatch {
  item: SlashItem;
  /** Indexes in `item.name` that matched, for highlighting. */
  hits: number[];
  /** Shown in the "Recent" group, above the rest. */
  recent?: boolean;
}

/** Subsequence match on the name, or null. Prefers runs and word starts by taking the first hits. */
function fuzzy(name: string, query: string): number[] | null {
  const hits: number[] = [];
  let from = 0;
  for (const ch of query) {
    const at = name.indexOf(ch, from);
    if (at < 0) return null;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

const range = (start: number, length: number) => Array.from({ length }, (_, i) => start + i);

/**
 * Filter and rank: exact → leaf after `plugin:` → prefix → substring → fuzzy name → description.
 * Commands sort before skills at each rank; ties keep the list order. An empty query keeps all.
 */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashMatch[] {
  const q = query.toLowerCase();
  const ranked: { match: SlashMatch; rank: number; index: number }[] = [];
  items.forEach((item, index) => {
    const add = (rank: number, hits: number[]) => ranked.push({ match: { item, hits }, rank, index });
    const name = item.name.toLowerCase();
    const leafAt = name.lastIndexOf(":") + 1;
    const sub = name.indexOf(q);
    if (q === "") return add(0, []);
    if (name === q) return add(0, range(0, q.length));
    if (leafAt > 0 && name.slice(leafAt) === q) return add(1, range(leafAt, q.length));
    if (name.startsWith(q)) return add(2, range(0, q.length));
    if (leafAt > 0 && name.startsWith(q, leafAt)) return add(2, range(leafAt, q.length));
    if (sub >= 0) return add(3, range(sub, q.length));
    const f = fuzzy(name, q);
    if (f) return add(4, f);
    if (item.description.toLowerCase().includes(q)) add(5, []);
  });
  const kindOrder = (m: SlashMatch) => (m.item.kind === "command" ? 0 : 1);
  ranked.sort((a, b) => kindOrder(a.match) - kindOrder(b.match) || a.rank - b.rank || a.index - b.index);
  return ranked.map((r) => r.match);
}

/** The text sent for a picked skill and what was typed after it. */
export function slashMessage(name: string, rest: string): string {
  const tail = rest.trim();
  return tail ? `/${name} ${tail}` : `/${name}`;
}

/** Up to `limit` recently picked skills that are in `matches`, moved to the front and marked. */
export function withRecent(matches: readonly SlashMatch[], recent: readonly string[], limit = 3): SlashMatch[] {
  const front = recent
    .flatMap((name) => matches.find((m) => m.item.kind === "skill" && m.item.name === name) ?? [])
    .slice(0, limit);
  return [...front.map((m) => ({ ...m, recent: true })), ...matches.filter((m) => !front.includes(m))];
}

/** The recent list after picking `name`: newest first, no repeats, at most `max`. */
export function rememberRecent(recent: readonly string[], name: string, max = 8): string[] {
  return [name, ...recent.filter((n) => n !== name)].slice(0, max);
}
