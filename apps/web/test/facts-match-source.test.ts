/**
 * The test that stops the site from lying.
 *
 * Every number on the page is derived from the product's source. Numbers copied by
 * hand drift, and this is not hypothetical — drafting this site produced two wrong
 * claims: a runner count taken from a repo-wide grep instead of the canonical
 * registry, and an MCP tool count citing an ambiguous path when two sidecar copies
 * exist with different surfaces. Both were caught by chance. This catches them by
 * construction.
 *
 * ── A deliberate, narrow exception to ADR-0011 ──
 *
 * ADR-0011 says `apps/web` imports nothing from any other package. This file reads
 * files from `apps/desktop` — by path, at test time. That is not an import: no
 * module resolution, no bundling, nothing reaches `dist/`. But it *is* a coupling,
 * so it is stated rather than smuggled:
 *
 *   - read-only, test-only, never shipped;
 *   - it exists to catch a defect class that already occurred twice;
 *   - if desktop moves these files, this test fails loudly and tells us to
 *     re-verify the claim. That is the desired behaviour, not collateral damage.
 *
 * If `apps/web` is ever split into its own repo, this test cannot come with it.
 * At that point the numbers must either be generated at build time from a published
 * artifact, or dropped from the copy. Do not let it rot into a skipped test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  proof,
  runnerSupport,
  AGENT_RUNNERS,
  AGENT_CLIS,
  AGENT_CATALOG,
  MCP_TOOL_COUNT,
  MAX_SPAWN_DEPTH,
  type Probe,
} from "../src/lib/facts";
import { demo } from "../src/copy";

/** Walk up from this file until the directory holding `.git` — the repo root. */
function repoRoot(): string {
  let dir = resolve(dirname(new URL(import.meta.url).pathname));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("repo root not found — is this running outside the repo?");
}

const ROOT = repoRoot();

function read(relative: string): string {
  const full = join(ROOT, relative);
  if (!existsSync(full)) {
    throw new Error(
      `Cited source is missing: ${relative}\n` +
        `A fact in src/lib/facts cites a file that no longer exists. Re-derive the ` +
        `claim from wherever that moved to, then update the fact's probe — ` +
        `do not delete this assertion.`,
    );
  }
  return readFileSync(full, "utf8");
}

function countUniqueMatches(source: string, pattern: string): number {
  const found = source.match(new RegExp(pattern, "gm")) ?? [];
  return new Set(found).size;
}

/**
 * Revamp, 2026-09-30 (plans/lotus-web/REVAMP.md). The page now shows four facts — BYO, 52,
 * 3, Rust — and this file guards exactly those. Guards for claims the page stopped making
 * were removed WITH the claims, not before: "32 PTY sessions", "367 Tauri commands" (stale
 * already: 372 committed, 374 in the tree), the critic/human-gate node types, the composer's
 * "says why", and "the graph is executable". The last two were also the claims Option B
 * took off the site — nothing in the app can start a graph run yet (LOT2-65).
 */
describe("every fact on the page is still true of the source it cites", () => {
  it("cites files that exist", () => {
    for (const fact of proof) {
      expect(() => read(fact.probe.file)).not.toThrow();
    }
  });

  it("the proof strip shows exactly the four guarded facts, in order", () => {
    expect(proof.map((f) => f.value)).toEqual(["BYO", MCP_TOOL_COUNT, MAX_SPAWN_DEPTH, "Rust"]);
  });

  it(`${MCP_TOOL_COUNT} MCP tools, counted from the desktop sidecar and no other copy`, () => {
    // There are TWO sidecars with different surfaces. The site's claim is about the
    // desktop app's surface, so the count must come from that file specifically.
    const desktop = read("apps/desktop/scripts/lotus-mcp-server.mjs");
    expect(String(countUniqueMatches(desktop, '"lotus_[a-z_]*[a-z]"'))).toBe(MCP_TOOL_COUNT);

    const host = "packages/host/mcp/lotus-mcp-server.mjs";
    if (existsSync(join(ROOT, host))) {
      const hostCount = countUniqueMatches(read(host), '"lotus_[a-z_]*[a-z]"');
      expect(
        String(hostCount),
        "The two sidecars now agree. If that is real, say which one the copy means — " +
          "the ambiguity is what produced a wrong citation once already.",
      ).not.toBe(MCP_TOOL_COUNT);
    }
  });

  it("3 generations of agent-spawned agent, from the constant that enforces it", () => {
    const fact = proof.find((f) => f.value === MAX_SPAWN_DEPTH)!;
    expect(fact.probe.kind).toBe("ts-const");
    const src = read(fact.probe.file);
    const match = new RegExp(`export const ${(fact.probe as Extract<Probe, { kind: "ts-const" }>).name}\\s*=\\s*(\\d+)\\s*;`).exec(src);
    expect(match, "MAX_SPAWN_DEPTH is gone from canvas-spawn-depth.ts").not.toBeNull();
    expect(match![1]).toBe(MAX_SPAWN_DEPTH);
  });

  it("the agent list on the page is the Code pane's catalog, in its order", () => {
    // The hero chip counts these, and the FAQ and the "Works with" row name them.
    const catalog = JSON.parse(read(AGENT_CATALOG));
    const names = (Array.isArray(catalog) ? catalog : Object.values(catalog).find(Array.isArray)) as { productName: string }[];
    expect([...AGENT_CLIS]).toEqual(names.map((a) => a.productName));
  });

  it("names only the runners that are actually agent runners", () => {
    const src = read(runnerSupport.probe.file);
    const match = src.match(/AGENT_RUNNERS\s*=\s*new Set\(\[([^\]]*)\]\)/);

    expect(match, "AGENT_RUNNERS is gone from the codec").not.toBeNull();
    const actual = [...match![1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);

    expect(actual.sort()).toEqual([...AGENT_RUNNERS].sort());
    // "BYO: your Claude Code and Codex subscriptions" names these two.
    expect(actual).toEqual(expect.arrayContaining(["claude", "codex"]));

    // Forbidden claim (issues/06 §7 item 6): Gemini and Cursor live on the
    // code-chat surface, not here. If they ever become real agent runners this
    // fails, and the copy gets to change — deliberately.
    for (const forbidden of ["gemini", "cursor"]) {
      expect(actual, `${forbidden} is now an agent runner — revisit the copy`).not.toContain(
        forbidden,
      );
    }
  });

  it("is a Tauri app, so 'Rust · not a bundled browser' holds", () => {
    const cargo = read("apps/desktop/src-tauri/Cargo.toml");
    expect(cargo).toMatch(/^tauri\s*=/m);

    const desktopPkg = read("apps/desktop/package.json");
    expect(desktopPkg, "an electron dependency appeared").not.toMatch(/"electron"\s*:/);
  });

  it("macOS and Windows only, so no other platform claim is allowed", () => {
    const conf = JSON.parse(read("apps/desktop/src-tauri/tauri.conf.json")) as {
      bundle?: { targets?: unknown };
    };
    // Forbidden claim (issues/06 §7 item 2). If targets grow, the copy may say more —
    // but only then.
    expect(conf.bundle?.targets).toEqual(["app", "dmg"]);
    // Windows is built by CI with an explicit --bundles override, not the conf targets.
    const win = read(".github/workflows/release-windows.yml");
    expect(win).toMatch(/--bundles nsis/);
    expect(win, "the site links this stable name").toContain("Lotus-windows-x64-setup.exe");
    expect(read("apps/desktop/scripts/release-macos.mjs"), "the site links this stable name").toContain(
      "Lotus-macos-arm64.dmg",
    );
  });
});

/**
 * The demo CTA names a duration, which is a claim like any other. It drifted once
 * already: the copy said "90-second demo" while the rendered cut was 42 s, because the
 * label was written before the video existed. The video's own timeline is the source of
 * truth, so read it.
 *
 * Same ADR-0011 exception as above — read-only, test-only, by path. `tools/` is not a
 * package `apps/web` may import from, and it still isn't.
 */
describe("the demo CTA's duration matches the rendered video", () => {
  const TIMELINE_FILE = "tools/remotion-lotus-hero/src/theme.ts";

  it("names the length the composition actually is", () => {
    const source = read(TIMELINE_FILE);

    // The composition is the sum of every scene's durationInFrames at 30 fps.
    const durations = [...source.matchAll(/durationInFrames:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(
      durations.length,
      `No scene durations found in ${TIMELINE_FILE}. If TIMELINE changed shape, re-derive ` +
        `the total here rather than deleting this assertion.`,
    ).toBeGreaterThan(1);

    const fps = Number(/FPS\s*=\s*(\d+)/.exec(source)?.[1] ?? 30);
    const seconds = Math.round(durations.reduce((a, b) => a + b, 0) / fps);
    // Read from `demo.hostedLabel`, not from the rendered CTA. While no video is
    // hosted the CTA does not mention a duration at all (see the demo seam in copy.ts),
    // and a claim that only appears once hosting lands is a claim nothing checks in the
    // meantime — which is how "90-second demo" survived against a 42 s cut.
    const claimed = Number(/(\d+)-second demo/.exec(demo.hostedLabel)?.[1]);

    expect(
      claimed,
      `demo.hostedLabel says "${demo.hostedLabel}" but the composition is ${seconds}s. ` +
        `Change the copy, or change the cut — not this test.`,
    ).toBe(seconds);
  });
});
