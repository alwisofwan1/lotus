import type { VoiceOutputSettings } from "@/lib/tauri-api";
import { agentDoneAlertsEnabled, shouldAlertAgentFinish } from "@/modules/voice-core/agent-done-alert";

/**
 * Agent-done callout policy (ADR-0031), now the shared Agent-Done Alert policy (Lotus #184): a finish
 * the user cannot see is announced whenever the alert is not Off; one on screen only with
 * `wakeOnFinish`. Pure — the trigger (idle watcher) and the playing are wired separately.
 */
export function shouldAnnounceAgentFinish(visible: boolean, settings: VoiceOutputSettings): boolean {
  return shouldAlertAgentFinish(visible, settings);
}

/** Whether the callout channel needs to watch at all (skip polling when the alert is Off). */
export function agentCalloutsEnabled(settings: VoiceOutputSettings | undefined): boolean {
  return agentDoneAlertsEnabled(settings);
}

/** Minimal roster shape the callout resolver needs (matches AgentStatusSnapshot). */
export interface FinishCalloutAgent {
  /** ReactFlow node id. */
  id: string;
  /** Globally unique LOTUS_PANE_ID / stop-hook id when different from the node id. */
  hookPaneId?: string;
  name: string;
  /** The canvas project the agent belongs to — lets a finish be attributed to its repo when it
   *  happens in a project other than the one currently on screen (cross-project callout). */
  projectId?: string;
}

export interface ResolveFinishCalloutCtx {
  /** Live agent status list — a paneId not in it (e.g. a non-canvas terminal) is ignored, UNLESS a
   *  {@link fallbackIdentity} matches it. */
  roster: FinishCalloutAgent[];
  /**
   * Identity for a finished pane whose node has UNMOUNTED (e.g. its project was switched away from,
   * so it is gone from the live roster while its PTY keeps running). Without this, a cross-project
   * finish would silently drop — the roster lookup would miss and the callout be null.
   */
  fallbackIdentity?: FinishCalloutAgent | null;
  /** Whether the finishing pane is on-screen (drives the visible vs background policy). */
  visible: boolean;
  settings: VoiceOutputSettings;
  /** Spoken-reply language for the callout (BCP-47/bare code); en/ja resolved by buildFinishCallout. */
  language?: string;
  /** Rotation index so consecutive finishes don't repeat the identical phrase. */
  variant?: number;
  /** The project currently on screen. A different/unknown active project makes the callout name the repo. */
  activeProjectId?: string | null;
  /** projectId → human repo label (alias / basename). Only consulted when repo attribution is needed. */
  resolveProjectLabel?: (projectId: string) => string | null | undefined;
  /** The active persona's own phrasings. Absent (or absent for this language) keeps the built-in pool. */
  personaPools?: PersonaCalloutPools;
}

/**
 * Resolve the spoken callout for a finished pane, or null when it shouldn't announce. Shared by BOTH
 * the authoritative stop-hook signal and the PTY-idle fallback so they obey one policy and phrasing:
 * the pane must be a known agent (live roster, or the {@link ResolveFinishCalloutCtx.fallbackIdentity}
 * for one whose node unmounted), and {@link shouldAnnounceAgentFinish} must allow it for the pane's
 * on-screen state. When the finish is in a project other than the one on screen — or no active
 * project context is available — the callout names its repo so a multi-project user knows WHERE
 * the work landed. Pure — trigger and speaking wired
 * separately.
 */
export function resolveFinishCallout(paneId: string, ctx: ResolveFinishCalloutCtx): string | null {
  const matchesPane = (agent: FinishCalloutAgent) => agent.id === paneId || agent.hookPaneId === paneId;
  const agent =
    ctx.roster.find(matchesPane) ??
    (ctx.fallbackIdentity && matchesPane(ctx.fallbackIdentity) ? ctx.fallbackIdentity : null);
  if (!agent) return null;
  if (!shouldAnnounceAgentFinish(ctx.visible, ctx.settings)) return null;
  // Cross-project / out-of-project: if the agent's project differs from the one on screen OR the
  // current project is unknown (route transition / app-level future host), speak the repo label when
  // resolvable. Same active-project context keeps today's bare phrasing.
  let projectLabel: string | undefined;
  const agentProjectId = agent.projectId ?? projectIdFromScopedPaneId(agent.hookPaneId) ?? projectIdFromScopedPaneId(paneId);
  if (agentProjectId && ctx.activeProjectId !== agentProjectId) {
    projectLabel = ctx.resolveProjectLabel?.(agentProjectId) ?? undefined;
  }
  return buildFinishCallout(agent.name, ctx.language, ctx.variant ?? 0, projectLabel, ctx.personaPools);
}

/** Rotating phrasings per language. Index 0 is the original line (backward-compatible default);
 *  the rest exist because hearing the identical sentence after every finish is itself what reads
 *  as robotic. Fixed pools keep this channel deterministic and honest (no model in the loop). */
const CALLOUT_POOLS: Record<"ja" | "en", ((name: string) => string)[]> = {
  ja: [
    (n) => `${n}が完了しました。`,
    (n) => `${n}の作業が終わりました。`,
    (n) => `${n}が一段落つきました。`,
  ],
  en: [
    (n) => `${n} is done.`,
    (n) => `${n} just finished.`,
    (n) => `${n} wrapped up its task.`,
    (n) => `All done from ${n}.`,
  ],
};

/** Repo-aware phrasings for a cross-project finish — the agent finished in a project OTHER than the
 *  one on screen, so the repo is named. Kept as their own natural sentences (not string-surgery on
 *  the bare pool) so every rotation reads well with the repo woven in. */
export function projectIdFromScopedPaneId(paneId: string | undefined): string | undefined {
  const match = paneId?.match(/^canvas:([^:]+):/);
  return match?.[1];
}

/**
 * Per-language phrasings a persona supplies for its own finish callouts, each with a `{name}`
 * placeholder. A language the persona has no pool for falls back to the built-in one, so a persona
 * can carry English lines only without silencing Japanese.
 *
 * Stays a fixed pool rather than a model call: this channel is deterministic and honest by design.
 */
export type PersonaCalloutPools = Partial<Record<"ja" | "en", readonly string[]>>;

const CROSS_PROJECT_POOLS: Record<"ja" | "en", ((name: string, repo: string) => string)[]> = {
  ja: [
    (n, r) => `${r}の${n}が完了しました。`,
    (n, r) => `${r}で${n}の作業が終わりました。`,
    (n, r) => `${r}の${n}が一段落つきました。`,
  ],
  en: [
    (n, r) => `${n} is done in ${r}.`,
    (n, r) => `${n} just finished in ${r}.`,
    (n, r) => `${r}: ${n} wrapped up.`,
    (n, r) => `All done from ${n} in ${r}.`,
  ],
};

/**
 * The short spoken line for a finished agent. A callout has no user query to mirror, so its
 * language follows the configured voice-INPUT language (BCP-47) — a Japanese user hears Japanese.
 * Only Japanese and English are spoken (Indonesian is dropped as a reply language — its TTS voice
 * reads unnatural); anything else, including Indonesian input, keeps English. `variant` (a
 * caller-kept counter) rotates through the pool so back-to-back finishes don't repeat verbatim.
 * When `projectLabel` is a non-blank repo name, the line names it (cross-project finish); otherwise
 * it stays bare.
 */
export function buildFinishCallout(
  name: string,
  language?: string,
  variant = 0,
  projectLabel?: string,
  personaPools?: PersonaCalloutPools,
): string {
  const trimmed = name.trim();
  const lang = language?.toLowerCase() ?? "";
  const key = lang.startsWith("ja") ? "ja" : "en";
  const fallbackName = key === "ja" ? "エージェント" : "Agent";
  const displayName = trimmed || fallbackName;
  const repo = projectLabel?.trim();
  // A persona pool has no {repo} slot, so it is only preferred for a bare finish. A cross-project
  // finish keeps the built-in repo-aware phrasing — losing WHERE the work landed to gain a register
  // is a bad trade.
  const personaPool = repo ? undefined : personaPools?.[key];
  if (personaPool?.length) {
    const pick = personaPool[((variant % personaPool.length) + personaPool.length) % personaPool.length];
    return pick.replaceAll("{name}", displayName);
  }
  if (repo) {
    const crossPool = CROSS_PROJECT_POOLS[key];
    const crossPick = crossPool[((variant % crossPool.length) + crossPool.length) % crossPool.length];
    return crossPick(displayName, repo);
  }
  const pool = CALLOUT_POOLS[key];
  const pick = pool[((variant % pool.length) + pool.length) % pool.length];
  return pick(displayName);
}

/**
 * Whether a runner's turn ends are reported by an installed CLI hook (Claude Stop hook, Codex
 * `notify`). Hook-capable panes must NEVER fall back to the byte-idle heuristic: the hook is exact
 * and per-turn, while the heuristic misreads repaints/echo as turns — for these runners a missed
 * hook is better silent than falsely announced. A custom runner wrapping a second Claude account
 * (`claude_family` registry flag) fires the same global Stop hook, so it counts too.
 */
export function isHookCapableRunner(runner: string | undefined, claudeFamily?: boolean): boolean {
  if (claudeFamily) return true;
  return runner === "claude" || runner === "codex";
}

/** Axis-aligned rect (screen pixels). */
export interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** True when two screen rects overlap — used to decide if an agent node is within the viewport. */
export function rectsIntersect(a: ScreenRect, b: ScreenRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * The "visible" in the callout policy means "the user is plausibly looking at this node RIGHT
 * NOW" — which requires the app window to be focused and unhidden, not just the node rect to sit
 * inside the viewport. A blurred/minimized window is the away-from-app case background callouts
 * exist for, so it always classifies as background (RCA: the old rect-only check silenced exactly
 * those finishes under the default wakeOnFinish=off).
 */
export function computeAnnounceVisibility(
  rectVisible: boolean,
  appFocused: boolean,
  documentHidden: boolean,
): boolean {
  return rectVisible && appFocused && !documentHidden;
}
