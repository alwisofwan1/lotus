/**
 * Facts about the product, each one derived from its source.
 *
 * This module exists because the site's credibility rests on numbers, and numbers
 * transcribed by hand drift. That is not hypothetical: drafting this site produced
 * two wrong claims — a runner count taken from a repo-wide grep instead of the
 * canonical registry, and an MCP tool count citing an ambiguous path when two
 * sidecar copies exist with different surfaces.
 *
 * So every fact carries `probe`: enough information for a test to go read the
 * product's source and fail when the two disagree. `test/facts-match-source.test.ts`
 * is that second caller. The interface is the test surface.
 *
 * ── 2026-09-30, the revamp (plans/lotus-web/REVAMP.md) ──
 *
 * The page shows four facts now, in one strip, and this module holds exactly those four.
 * Two facts left with the section that displayed them: "32 PTY sessions per window" and
 * "367 Tauri commands". The second was already stale — 372 committed, 374 in the working
 * tree the day it was cut — which is the argument for not publishing a number that moves
 * every week unless the page genuinely needs it. A fact that is not on the page is not
 * guarded here; an unguarded fact that IS on the page is the defect this file prevents.
 */

/** Where a fact can be re-derived from, relative to the repo root. */
export type Probe =
  | { kind: "unique-matches"; file: string; pattern: string }
  | { kind: "ts-string-set"; file: string; name: string }
  /** `export const NAME = <integer>;` in a TypeScript source file. */
  | { kind: "ts-const"; file: string; name: string };

export interface Fact {
  /** Rendered verbatim, large. */
  readonly value: string;
  /** The sentence beside it. Says what the number *means*, never what it implies. */
  readonly label: string;
  readonly probe: Probe;
}

export const MCP_TOOL_COUNT = "63";
export const MAX_SPAWN_DEPTH = "3";

/**
 * The agent CLIs a Code pane can launch, in the picker's order: `productName` of every entry in
 * apps/desktop/src/agents.json, which feeds PICKER_AGENT_IDS (agent-registry.ts). The test reads
 * that file and fails when this list and the catalog disagree. Canvas agent NODES are narrower
 * (AGENT_RUNNERS below), so copy that names these eleven must not say "on the canvas".
 */
export const AGENT_CLIS = [
  "Claude Code",
  "Codex",
  "Gemini CLI",
  "OpenCode",
  "Cursor Agent",
  "Droid",
  "GitHub Copilot CLI",
  "Antigravity",
  "Grok",
  "Kimi",
  "Pi",
] as const;
export const AGENT_CATALOG = "apps/desktop/src/agents.json";

/** The runners a canvas agent node keeps (canvas-snapshot-codec.ts). Narrower than
 *  AGENT_CLIS: Gemini, Cursor and the rest launch in Code panes, not as canvas nodes. */
export const AGENT_RUNNERS = ["claude", "ccs", "csp", "codex", "custom"] as const;

const RUNNER_REGISTRY = "apps/desktop/src/modules/codecanvas/services/canvas-snapshot-codec.ts";

/** Named separately from `proof` because it is prose, not a number — but it comes
 *  from the same registry, so the same test guards it. */
export const runnerSupport = {
  sentence: "Claude Code and Codex first-class, anything else through a custom runner.",
  probe: { kind: "ts-string-set", file: RUNNER_REGISTRY, name: "AGENT_RUNNERS" } satisfies Probe,
} as const;

/** The proof strip, in the order it renders. */
export const proof: readonly Fact[] = [
  {
    // "No markup" is true by construction: Lotus has no billing of its own, it drives the
    // CLIs you already pay for. The runner names are what the probe checks.
    value: "BYO",
    label: "The agent CLIs you already pay for. No markup.",
    probe: { kind: "unique-matches", file: AGENT_CATALOG, pattern: '"productName"' },
  },
  {
    value: MCP_TOOL_COUNT,
    label: "MCP tools agents inside Lotus call to hand off work, drive the browser and keep notes.",
    probe: {
      kind: "unique-matches",
      file: "apps/desktop/scripts/lotus-mcp-server.mjs",
      pattern: '"lotus_[a-z_]*[a-z]"',
    },
  },
  {
    value: MAX_SPAWN_DEPTH,
    label: "Generations deep — a chain of agent-spawned agents stops there.",
    probe: {
      kind: "ts-const",
      file: "apps/desktop/src/modules/codecanvas/services/canvas-spawn-depth.ts",
      name: "MAX_SPAWN_DEPTH",
    },
  },
  {
    value: "Rust",
    label: "A native Tauri app. Not a bundled browser.",
    probe: { kind: "unique-matches", file: "apps/desktop/src-tauri/Cargo.toml", pattern: "^tauri\\s*=" },
  },
];
