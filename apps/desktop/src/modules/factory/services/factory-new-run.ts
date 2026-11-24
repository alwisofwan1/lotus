import type { GraphRunStartInput } from "@/lib/tauri/graph-run";
import { DEFAULT_CAP_USD, factoryRefLabel, factoryStartInput, type FactoryRef, type FactoryRunState } from "./factory-run";

/**
 * The New run sheet: many tickets of one source, one Factory Run each. The tickets are a repo's
 * GitHub issues, or a Notion database's tickets (#168) built in a repo picked beside it. Pure parts and a starter built
 * on ports, so the sheet is testable with no app. The tries are not a choice: the runner allows
 * {@link FACTORY_MAX_ATTEMPTS}, fixed in Rust (`factory::runner::MAX_ATTEMPTS`).
 */

export const FACTORY_MAX_ATTEMPTS = 2;
export { DEFAULT_CAP_USD };

/** A GitHub ticket source, as the sheet offers it. */
export interface FactoryRepo {
  id: string;
  repo: string;
  account: string;
  name: string;
}

/** A Notion database in Tasks, as the sheet offers it (#168). Its tickets have no repo of their own. */
export interface FactoryNotionSource {
  id: string;
  name: string;
}

/** A local folder New run works in (a Notion run's "Workspace"): one repo, or a meta-repo of sub-repos. */
export interface FactoryWorkspace {
  id: string;
  path: string;
  name: string;
}

/** What a workspace holds: the connected GitHub repo that is the folder itself (null = none), and its sub-repos by folder name. */
export interface FactoryWorkspaceInfo {
  repo: FactoryRepo | null;
  /** The folder is a meta-repo (no repo of its own, sub-repos): `repo` then only names the folder and carries the account; triage picks the sub-repo. */
  meta?: boolean;
  subRepos: string[];
}

export interface FactoryIssue {
  /** The issue number, or the Notion ticket id (`TKT-123`). */
  number: FactoryRef;
  title: string;
}

export interface FactoryBatchRequest {
  /** Where the code is: the run's worktree, branch and draft PR. */
  repo: FactoryRepo;
  /** Where the tickets are: `repo.id` for its GitHub issues, or a Notion source id. */
  sourceId: string;
  issues: FactoryRef[];
  implementer: string;
  /** Required: the engine refuses a Factory Run without a cap. */
  capUsd: number;
  /** The Workspace folder the run works in (a Notion run); absent = look the repo's checkout up. */
  workspace?: string;
  /** The workspace is a meta-repo: the run records it, and triage routes it to a sub-repo (ADR-0063). */
  meta?: boolean;
  /** A meta-repo run: every connected source's gh account by `owner/name`, for the sub-repo triage picks. */
  repoAccounts?: Record<string, string>;
}

/** One issue's start: null when it started, else why not. */
export interface FactoryBatchResult {
  issue: FactoryRef;
  error: string | null;
}

/** The branch a repo's Factory PRs go into. `fromFile`: set by `base` in `.lotus/factory.toml`. */
export interface FactoryBase {
  name: string;
  fromFile: boolean;
}

/** "PRs go into: develop (from .lotus/factory.toml)", shown before a run starts (LOT2-192). */
export function prsGoInto(base: FactoryBase): string {
  return `PRs go into: ${base.name} (${base.fromFile ? "from .lotus/factory.toml" : "the default branch"})`;
}

/** The parts of a repo's factory definition the New Run sheet shows before a start. */
export interface FactoryRepoDefaults {
  implementer: string | null;
  /** null = unknown. */
  base: FactoryBase | null;
}

/** What the sheet reads and does; the shell builds it from Tasks' own issue list. */
export interface FactoryNewRunSource {
  repos: FactoryRepo[];
  /** Notion databases in Tasks; absent or empty = GitHub issues only. */
  notion?: FactoryNotionSource[];
  /** The source's open tickets, as Tasks last read them: a repo id, or a Notion source id. */
  issues(sourceId: string): FactoryIssue[];
  /** Local folders a Notion run can work in; absent or empty = pick a GitHub repo as before. */
  workspaces?: FactoryWorkspace[];
  /** What the folder holds; see {@link FactoryWorkspaceInfo}. */
  inspectWorkspace?(path: string): Promise<FactoryWorkspaceInfo>;
  /** The presets that can run the implementer (Claude only). */
  presets(): Promise<{ id: string; name: string }[]>;
  /**
   * What the next run of `repo` reads from its definition: the Implement role's preset in Settings
   * (null = none), and the branch its PRs go into (null = unknown). Absent = the sheet cannot tell,
   * and starts at the first preset.
   */
  defaultsOf?(repo: string): Promise<FactoryRepoDefaults>;
  start(request: FactoryBatchRequest): Promise<FactoryBatchResult[]>;
}

/** A run in these states still holds its issue: the engine refuses a second one. */
const HOLDS_ISSUE: ReadonlySet<FactoryRunState> = new Set([
  "running",
  "paused",
  "recovery-required",
  "needs-answers",
  "needs-approval",
  "triage-blocked",
  "done",
]);

/**
 * The repo's issues that cannot start: a running, paused or waiting run still holds its issue
 * (`MemberBusy`), and so does a draft PR still open (`done`) — a second run would open a second PR.
 * Only the newest run of each issue counts.
 */
export function busyIssues(
  rows: readonly { repo: string; issue: FactoryRef; state: FactoryRunState }[],
  repo: string,
): Map<FactoryRef, "running" | "pr-open"> {
  const name = repo.toLowerCase();
  return new Map(
    rows
      .filter((r) => r.repo.toLowerCase() === name && HOLDS_ISSUE.has(r.state))
      .map((r) => [r.issue, r.state === "done" ? ("pr-open" as const) : ("running" as const)]),
  );
}

const trimSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * The tickets that cannot start in a workspace: a run held on the ticket anywhere under the
 * folder (its checkout is the folder or a sub-repo inside it) counts, whichever repo it is for.
 */
export function busyIssuesInWorkspace(
  rows: readonly { repo: string; issue: FactoryRef; state: FactoryRunState; ticket?: { checkout: string } }[],
  workspace: string,
): Map<FactoryRef, "running" | "pr-open"> {
  const root = trimSlash(workspace);
  return new Map(
    rows
      .filter((r) => {
        const checkout = r.ticket ? trimSlash(r.ticket.checkout) : null;
        return checkout !== null && (checkout === root || checkout.startsWith(`${root}/`)) && HOLDS_ISSUE.has(r.state);
      })
      .map((r) => [r.issue, r.state === "done" ? ("pr-open" as const) : ("running" as const)]),
  );
}

/** The cap field's value: a positive number of dollars, or null when it is not one. */
export function parseCap(text: string): number | null {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) && value >= 0.01 ? value : null;
}

/** By number (`7`, `#7`), Notion id (`TKT-123`, or just `123`) or a piece of the title. */
export function filterIssues<T extends FactoryIssue>(issues: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase().replace(/^#/, "");
  if (!q) return [...issues];
  return issues.filter((issue) => {
    const ref = String(issue.number).toLowerCase();
    return ref === q || (typeof issue.number === "string" && ref.endsWith(`-${q}`)) || issue.title.toLowerCase().includes(q);
  });
}

/**
 * Which preset the implementer runs as, and where that came from. Settings' Implement preset is
 * the starting point (the runner never reads that field itself: the run's implementer is what
 * New run sends); a pick in the sheet is for this batch only.
 */
export function implementerChoice(
  presets: readonly { id: string }[],
  fromSettings: string | null,
  chosen: string | null,
): { id: string; caption: string } {
  const known = (id: string | null) => id !== null && presets.some((p) => p.id === id);
  const settings = known(fromSettings) ? fromSettings : null;
  if (known(chosen) && chosen !== settings) return { id: chosen!, caption: "this batch only" };
  if (settings) return { id: settings, caption: "from Settings" };
  return { id: presets[0]?.id ?? "", caption: fromSettings ? "Settings preset not on this Mac" : "not set in Settings" };
}

export function newRunFooter(count: number, capUsd: number | null): string {
  if (count === 0) return "No ticket picked";
  const runs = `${count} run${count === 1 ? "" : "s"}`;
  return capUsd === null ? runs : `${runs} · up to $${(count * capUsd).toFixed(2)}`;
}

export interface FactoryRunStarterDeps {
  /** The user's checkout of the repo, or null when no local workspace holds it. */
  findCheckout(repo: string): Promise<string | null>;
  /** The Canvas Project a run in that checkout is recorded under. */
  projectIdOf(checkout: string): string;
  /**
   * The ticket's title and body, or null when it is gone from the list. A Notion ticket also gives
   * its page, and its body holds its properties (#168).
   */
  readIssue(
    sourceId: string,
    ref: FactoryRef,
  ): Promise<{ title: string; body: string | null; notion?: { pageId: string; url: string } } | null>;
  start(input: GraphRunStartInput): Promise<string>;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Starts each issue on its own; one that fails does not stop the others. Results keep the order asked. */
export function createFactoryRunStarter(deps: FactoryRunStarterDeps): (request: FactoryBatchRequest) => Promise<FactoryBatchResult[]> {
  return async ({ repo, sourceId, issues, implementer, capUsd, workspace, meta, repoAccounts }) => {
    const checkout = workspace ?? (await deps.findCheckout(repo.repo).catch(() => null));
    if (!checkout) {
      const error = `No open workspace holds a checkout of ${repo.repo}. Open it in the sidebar first.`;
      return issues.map((issue) => ({ issue, error }));
    }
    const projectId = deps.projectIdOf(checkout);
    return Promise.all(
      issues.map(async (number): Promise<FactoryBatchResult> => {
        try {
          const ticket = await deps.readIssue(sourceId, number);
          if (!ticket) return { issue: number, error: `Could not read ${factoryRefLabel(number)} from the ticket list.` };
          await deps.start(
            factoryStartInput({
              projectId,
              repo: repo.repo,
              issue: { number, title: ticket.title, body: ticket.body },
              ...(ticket.notion ? { notion: ticket.notion } : {}),
              account: repo.account,
              checkout,
              ...(meta ? { workspace: checkout, ...(repoAccounts ? { repoAccounts } : {}) } : {}),
              implementer,
              budgetCap: capUsd,
            }),
          );
          return { issue: number, error: null };
        } catch (cause) {
          return { issue: number, error: messageOf(cause) };
        }
      }),
    );
  };
}
