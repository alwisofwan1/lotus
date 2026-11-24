import type {
  FactoryAgentDefinition,
  FactoryAgentEdit,
  FactoryCatalog,
  FactoryDefinition,
  FactoryDefinitionView,
  FactoryRole,
} from "@/lib/tauri/graph-run";

import type { FactoryCheckTrialSource } from "./factory-check-trial";

/**
 * The Agents tab (FI5): who does what in a repo's factory, with which model, skills and MCP
 * servers. Pure parts; the tab reads and writes through {@link FactoryAgentsSource}. Saves go to
 * the checkout only: a run reads `origin/<base>`, so a change counts once it is pushed.
 */

export const AGENTS_DIR = ".lotus/factory/agents";
export const FACTORY_FILE = ".lotus/factory.toml";

/** What the tab reads and writes; the shell builds it, tests fake it. */
export interface FactoryAgentsSource {
  /** The repos to pick from (Tasks' GitHub sources). */
  repos: { id: string; repo: string }[];
  /** The user's checkout of `repo`, or null when no open workspace holds it. */
  findCheckout(repo: string): Promise<string | null>;
  /** `repo` lets a repo with no factory of its own show Lotus's private one (#169). */
  view(checkout: string, repo: string): Promise<FactoryDefinitionView>;
  catalog(checkout: string, base: string | null, repo: string): Promise<FactoryCatalog>;
  /** Starts Lotus's private factory for `repo`: on this Mac only, never in the repo. */
  setupPrivate(repo: string, gate: string): Promise<FactoryDefinition>;
  suggestChecks(checkout: string): Promise<{ label: string; command: string; evidence: string }[]>;
  /** Explicit native trials; omitted by older/test adapters without an execution runtime. */
  checks?: FactoryCheckTrialSource;
  saveGate(checkout: string, repo: string, gate: string, privateFactory: boolean): Promise<FactoryDefinition>;
  removePrivate(repo: string): Promise<string>;
  restorePrivate(repo: string, recoveryId: string): Promise<FactoryDefinition>;
  /** Delegation presets an agent can run as. */
  presets(): Promise<{ id: string; name: string }[]>;
  /** `agent` null = Use built-in (the file is deleted). */
  /** `checkout` is the folder the view edits: the checkout, or the private factory's folder. */
  saveAgent(checkout: string, role: FactoryRole, agent: FactoryAgentEdit | null): Promise<FactoryDefinition>;
  saveShared(checkout: string, skills: string[], mcp: string[]): Promise<FactoryDefinition>;
}

export interface RoleInfo {
  role: FactoryRole;
  /** What it does, in one line. */
  does: string;
  /** The slice that first runs it; until then its settings wait. Null = runs today. */
  usedFrom: string | null;
}

export const ROLES: readonly RoleInfo[] = [
  { role: "triage", does: "Sizes the ticket and checks it is ready", usedFrom: null },
  { role: "spec", does: "Asks you questions, then writes the spec", usedFrom: null },
  { role: "implement", does: "Writes the code and a test for each AC", usedFrom: null },
  { role: "review", does: "Checks the change against the spec", usedFrom: null },
  { role: "handoff", does: "Writes the pull request description", usedFrom: "FI8" },
];

export const agentPath = (role: FactoryRole) => `${AGENTS_DIR}/${role}.md`;

/** The pane's starting values for an agent. */
export function editOf(agent: FactoryAgentDefinition): FactoryAgentEdit {
  return {
    preset: agent.preset,
    model: agent.model,
    sameModel: agent.sameModel,
    skills: [...agent.skills],
    mcp: [...agent.mcp],
    timeoutMinutes: agent.timeoutMinutes,
    maxQuestions: agent.maxQuestions,
    prompt: agent.prompt,
  };
}

export function sameEdit(a: FactoryAgentEdit, b: FactoryAgentEdit): boolean {
  const same = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return (
    (a.preset ?? null) === (b.preset ?? null) &&
    (a.model?.trim() || null) === (b.model?.trim() || null) &&
    a.sameModel === b.sameModel &&
    same(a.skills, b.skills) &&
    same(a.mcp, b.mcp) &&
    a.timeoutMinutes === b.timeoutMinutes &&
    a.maxQuestions === b.maxQuestions &&
    a.prompt.trim() === b.prompt.trim()
  );
}

/** The model line of a row: the preset's name, or who picks when there is none. */
export function modelLabel(agent: FactoryAgentDefinition, presets: { id: string; name: string }[]): string {
  const preset = !agent.preset
    ? agent.role === "implement"
      ? "Run's choice"
      : "Same as implementer"
    : (presets.find((p) => p.id === agent.preset)?.name ?? agent.preset);
  return agent.model ? `${preset} · ${agent.model}` : preset;
}

/** Whether the role's file (or factory.toml for `null`) differs from origin. */
export function isUnpushed(view: FactoryDefinitionView, role: FactoryRole | null): boolean {
  const path = role ? agentPath(role) : FACTORY_FILE;
  return view.unpushed.some((file) => file.path === path);
}

export function unpushedLine(view: FactoryDefinitionView): string | null {
  const count = view.unpushed.length;
  if (count === 0) return null;
  return `${count} file${count === 1 ? "" : "s"} not pushed`;
}

/** The names this Mac does not have; admit refuses a run that names one (FI4). */
export function missingNames(names: string[], kind: "skills" | "mcp", catalog: FactoryCatalog | null): string[] {
  if (!catalog) return [];
  const have = new Set(kind === "skills" ? catalog.skills.map((s) => s.id) : catalog.mcp.map((m) => m.name));
  return names.filter((name) => !have.has(name));
}

export type SkillFilter = "all" | FactoryCatalog["skills"][number]["source"];

/** Catalog skills matching ID, description or plugin provenance and source, in catalog order. */
export function filterSkills(catalog: FactoryCatalog, query: string, filter: SkillFilter) {
  const q = query.trim().toLowerCase();
  return catalog.skills.filter(
    (skill) =>
      (filter === "all" || skill.source === filter) &&
      (!q || skill.id.toLowerCase().includes(q) || (skill.description ?? "").toLowerCase().includes(q) || (skill.plugin ?? "").toLowerCase().includes(q)),
  );
}

export function filterServers(catalog: FactoryCatalog, query: string) {
  const q = query.trim().toLowerCase();
  return catalog.mcp.filter((server) => !q || server.name.toLowerCase().includes(q) || server.target.toLowerCase().includes(q) || (server.plugin ?? "").toLowerCase().includes(q));
}

/** `names` with `name` added at the end, or taken out. */
export function toggled(names: string[], name: string): string[] {
  return names.includes(name) ? names.filter((n) => n !== name) : [...names, name];
}

export interface KitName {
  name: string;
  /** Named by `.lotus/factory.toml` (Every agent), not by this role's own file. */
  shared: boolean;
  /** Not in this Mac's catalog: a run that names it is refused (FI4). */
  missing: boolean;
}

/** What one run of a role is given, found by name. */
export interface RoleKit {
  skills: KitName[];
  mcp: KitName[];
  /** Triage reads only the ticket and the code: no server, not even the shared ones. */
  noMcp: boolean;
}

/**
 * The skills and MCP servers a run of `role` gets: Every agent's names first, then the role's own,
 * each once. Mirrors `wanted()` in factory/kit.rs, so the Agents tab shows what the run will receive
 * and not only what the role's own file lists. `own` is passed apart from the definition so the
 * pane can show a draft before it is saved.
 */
export function roleKit(
  role: FactoryRole,
  shared: { skills: string[]; mcp: string[] },
  own: { skills: string[]; mcp: string[] },
  catalog: FactoryCatalog | null,
): RoleKit {
  const merge = (all: string[], mine: string[], kind: "skills" | "mcp"): KitName[] => {
    const missing = new Set(missingNames([...all, ...mine], kind, catalog));
    const out: KitName[] = [];
    for (const [names, isShared] of [[all, true], [mine, false]] as const) {
      for (const name of names) if (!out.some((n) => n.name === name)) out.push({ name, shared: isShared, missing: missing.has(name) });
    }
    return out;
  };
  const noMcp = role === "triage";
  return { skills: merge(shared.skills, own.skills, "skills"), mcp: noMcp ? [] : merge(shared.mcp, own.mcp, "mcp"), noMcp };
}

/** The runner's own words when a run would be refused for names this Mac lacks; null when none. */
export function kitRefusal(role: string, kit: RoleKit): string | null {
  const names = [
    ...kit.skills.filter((n) => n.missing).map((n) => `skill "${n.name}"`),
    ...kit.mcp.filter((n) => n.missing).map((n) => `MCP server "${n.name}"`),
  ];
  return names.length ? `the ${role} agent needs what this Mac no longer has: ${names.join(", ")}` : null;
}

export const kitMissing = (kit: RoleKit): number => [...kit.skills, ...kit.mcp].filter((n) => n.missing).length;

/** At most `max` names to draw; the rest fold into one "+N more". A missing name is never folded away. */
export function foldNames(names: KitName[], max = 5): { shown: KitName[]; hidden: number } {
  if (names.length <= max) return { shown: names, hidden: 0 };
  const ordered = [...names.filter((n) => n.missing), ...names.filter((n) => !n.missing)].slice(0, max);
  return { shown: names.filter((n) => ordered.includes(n)), hidden: names.length - max };
}

/** One integration warning as a row: what it is about, one sentence, and the whole text to expand. */
export interface NoteSummary {
  title: string;
  summary: string;
  detail: string;
}

const SUMMARY_MAX = 160;

/**
 * The discovery notes are written as paragraphs for the details view. A row needs less: the plugin the
 * note names (when it starts "Plugin <id> is enabled…") and its first sentence. The full text is kept
 * as `detail`, never rewritten, so nothing the runner said is lost.
 */
export function summarizeNote(note: string): NoteSummary {
  const detail = note.trim();
  const first = detail.split(/(?<=[.!?])\s/)[0] ?? detail;
  const plugin = /^Plugin (\S+) (is enabled [\s\S]*)$/.exec(first);
  const sentence = plugin ? plugin[2] : first;
  const summary = sentence.charAt(0).toUpperCase() + sentence.slice(1);
  return {
    title: plugin ? plugin[1] : "Integration note",
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : summary,
    detail,
  };
}
