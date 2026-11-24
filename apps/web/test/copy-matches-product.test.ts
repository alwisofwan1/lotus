/**
 * The prose guard.
 *
 * `facts-match-source.test.ts` catches wrong *numbers*, and it works — every number on
 * the page survived the 2026-08-24 audit. What that audit found instead was four wrong
 * *sentences*, because prose was unguarded:
 *
 *   · a Bridge slash menu naming three commands, none of which existed
 *     (`/fleet dispatch` was never a command; `/arrange` is a canvas verb)
 *   · "Every agent in its own worktree", stating an opt-in as the default, against an
 *     ADR whose title says the opposite
 *   · "not a pattern match on scrollback", against an ADR that names output-tail
 *     parsing as one of three activity signals
 *   · a CTA promising a 42-second video and linking to a text heading
 *
 * So this file guards the class. Each assertion below re-derives a *sentence* from the
 * product's source, the same way the numbers already are.
 *
 * It also guards something the other two tests cannot: whether a mechanism is WIRED.
 * Two of the strongest things in the repo — the live feedback loop and the cell
 * supervisor — are complete, tested, and mounted by nothing. Existing in the repository
 * is not shipping, and a landing page is exactly where that distinction goes missing.
 * See `does not sell a mechanism nothing mounts` at the bottom.
 *
 * Same deliberate ADR-0011 exception as `facts-match-source.test.ts`: read-only,
 * test-only, by path. Nothing here reaches `dist/`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as copy from "../src/copy";
import { pocket, story } from "../src/copy";

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
const DESKTOP = "apps/desktop/src";

function read(relative: string): string {
  const full = join(ROOT, relative);
  if (!existsSync(full)) {
    throw new Error(
      `Cited source is missing: ${relative}\n` +
        `A sentence on the site is derived from this file. Re-derive it from wherever ` +
        `that moved to — do not delete the assertion.`,
    );
  }
  return readFileSync(full, "utf8");
}

/** Source with comments removed, so a guard tests code rather than the prose beside it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Every `.ts`/`.tsx` file under a directory, recursively. */
function sourceFiles(relativeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(join(ROOT, relativeDir));
  return out;
}


const WEB = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
const PUBLIC = (rel: string) => readFileSync(new URL(`../public/${rel}`, import.meta.url), "utf8");

/**
 * The Story window (redesign 2026-11-21). The terminal OUTPUT is the agents' own voice,
 * reconstructed; the chrome, the hand-off tool and the permission dialog are pinned to the
 * app.
 */
describe("the Story window is the app's", () => {
  const W = `${DESKTOP}/modules/workspace-shell`;

  it("the hand-off Nara makes is the real MCP tool", () => {
    const sidecar = read("apps/desktop/scripts/lotus-mcp-server.mjs");
    expect(sidecar).toContain('"lotus_dispatch_to_cell"');
    expect(JSON.stringify(story.handoff.nara)).toContain("lotus_dispatch_to_cell");
  });

  it("the mode switch is ShellChrome's, in its order", () => {
    const chrome = read(`${W}/components/ShellChrome.tsx`);
    const order = [...chrome.matchAll(/\{ id: "[a-z]+", label: "([A-Za-z]+)" \}/g)].map((m) => m[1]);
    expect(order).toEqual([...story.modes]);
    for (const c of story.chapters) if (c.mode) expect(story.modes).toContain(c.mode);
  });

  it("the app's mode switch has no soon flag (Chat shipped), so the site's has none either", () => {
    const chrome = read(`${W}/components/ShellChrome.tsx`);
    expect(chrome).toMatch(/\{ id: "chat", label: "Chat" \}/);
    expect(chrome).not.toMatch(/soon/i);
    expect(JSON.stringify(story)).not.toMatch(/\bsoon\b/i);
  });

  it("the status pill says what mode-status.ts says", () => {
    const status = read(`${W}/services/mode-status.ts`);
    expect(status).toContain("`${needsYou} need you`");
    expect(status).toContain("`${unread} done`");
    // Order in the source: need you, then done.
    expect(story.chapters.find((c) => c.id === "handoff")!.status).toMatch(/^\d+ need you · \d+ done$/);
  });

  it("every chapter has its scene, and the scene ids match", () => {
    const src = WEB("sections/Story.astro");
    for (const c of story.chapters) expect(src, `no scene for ${c.id}`).toContain(`data-s="${c.id}"`);
  });
});

describe("the permission prompt is Claude Code's own, answered by its digit", () => {
  const FIXTURE = "apps/desktop/src-tauri/src/permission_prompt_fixtures/bash-prompt-60col.txt";
  const p = story.permission;

  it("reads like the prompt the app captured", () => {
    const fixture = read(FIXTURE);
    for (const line of [p.title, p.question, p.hint, "❯ 1. Yes"]) {
      expect(fixture, `"${line}" is not in the captured Claude Code prompt`).toContain(line);
    }
    // Option shapes: the fixture's options, with this page's project in the blank.
    expect(p.options.map((o) => o.label)).toEqual([
      "Yes",
      expect.stringMatching(/^Yes, and always allow access to .+ from this project$/),
      "Yes, and switch to auto mode",
      "No",
    ]);
    expect(fixture).toMatch(/2\. Yes, and always allow access to .+/);
    expect(fixture).toMatch(/3\. Yes, and switch to auto mode/);
    expect(fixture).toMatch(/4\. No/);
  });

  it("the window and the phone draw the same prompt, every option with its digit", () => {
    const rust = read("apps/desktop/src-tauri/src/permission_prompt.rs");
    expect(rust.length, "permission_prompt.rs is empty").toBeGreaterThan(0);
    expect(WEB("sections/Story.astro")).toMatch(/pm\.options\.map/);
    expect(WEB("sections/Pocket.astro")).toMatch(/pm\.options\.map\(\(o\) => <span><b>\{o\.key\}<\/b>/);
  });
});

describe("Pocket says what Pocket says", () => {
  const P = "apps/pocket/lib";

  it("the state word and the composer are the app's", () => {
    const pocketSrc = (dir: string): string =>
      readdirSync(join(ROOT, dir), { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".dart"))
        .map((f) => readFileSync(join(ROOT, dir, f), "utf8"))
        .join("\n");
    const all = pocketSrc(P);
    expect(all).toContain(`'${pocket.phone.states.asking}'`);
    expect(all).toContain(`'${pocket.phone.composer}'`);
  });

  it("is a teaser, never an availability claim (ADR-9)", () => {
    expect(JSON.stringify(pocket)).not.toMatch(/download|available now|coming soon|ships in|app store|play store/i);
  });
});

/**
 * The page's two scripts, and what they may not do.
 *
 * The privacy notice says the page carries two small scripts that make no network request,
 * store nothing and send nothing. That is only worth saying if it stays true, so it is
 * enforced. motion.js may touch the clipboard in one way only: writing the command a visitor
 * asked to copy.
 */
describe("the page's scripts are inert", () => {
  const motion = stripComments(PUBLIC("motion.js"));
  const os = stripComments(PUBLIC("download-os.js"));

  it("observe nothing, send nothing, store nothing", () => {
    const FORBIDDEN = [/\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /localStorage/, /sessionStorage/, /indexedDB/i, /document\.cookie/, /postMessage/, /getUserMedia/, /mediaDevices/, /AudioContext/, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, /\beval\s*\(/, /new Function\s*\(/];
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(motion), `motion.js matches ${pattern}`).toBe(false);
      expect(pattern.test(os), `download-os.js matches ${pattern}`).toBe(false);
    }
    const notice = JSON.stringify(copy.privacy);
    expect(notice).toMatch(/two small scripts/i);
    expect(notice).toMatch(/no network request/i);
    expect(notice).toMatch(/operating system your browser reports/);
  });

  it("motion.js reads nothing about the visitor and only writes the clipboard on Copy", () => {
    const uses = [...motion.matchAll(/navigator\.[\w.]+/g)].map((m) => m[0]);
    expect(new Set(uses)).toEqual(new Set(["navigator.clipboard", "navigator.clipboard.writeText"]));
    expect(motion).not.toMatch(/readText|clipboard\.read\b/);
    expect(JSON.stringify(copy.privacy)).toMatch(/copies an install command when you press Copy/);
  });

  it("there is one script tag in the page's sections, and it loads motion.js", () => {
    const files = [
      ...readdirSync(new URL("../src/sections", import.meta.url)).map((f) => `sections/${f}`),
      "pages/index.astro",
      "layouts/Base.astro",
    ].filter((f) => f.endsWith(".astro"));
    const blocks = files.flatMap((f) =>
      (WEB(f).match(/<script\b(?![^>]*type="application\/ld\+json")[\s\S]*?<\/script>/g) ?? []).map((b) => ({ f, b })),
    );
    expect(blocks.map((x) => x.f)).toEqual(["pages/index.astro"]);
    expect(blocks[0].b).toMatch(/src="\/motion\.js"/);
  });
});

describe("the static frame is complete without a script", () => {
  it("no content is revealed by an animation (CHECKPOINTS.md, rv-1)", () => {
    // Entrance keyframes may move things; they may not fade them in from nothing, because a
    // renderer that freezes animations would then show nothing.
    for (const file of ["sections/Hero.astro", "sections/Story.astro", "sections/Pocket.astro"]) {
      const src = WEB(file);
      for (const [, , body] of src.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?\})\s*\}/g)) {
        const from = /(?:from|0%)\s*\{([^}]*)\}/.exec(body)?.[1] ?? "";
        expect(from, `${file}: an entrance animation starts invisible`).not.toMatch(/opacity:\s*0(?![.\d])/);
        expect(from).not.toMatch(/visibility:\s*hidden/);
      }
    }
  });

  it("whatever starts hidden is hidden only once the script has run", () => {
    // `.js` is set by motion.js. A rule that hides scene content must sit behind it.
    const story = WEB("sections/Story.astro");
    for (const m of story.matchAll(/^\s*([^{}\n]*\[data-d\][^{}\n]*)\{\s*\n\s*opacity:\s*0;/gm)) {
      expect(m[1], "a [data-d] rule hides content without the script").toContain(":global(.js)");
    }
  });

  it("the skip link and the nav go to sections that exist", () => {
    const ids = ["sections/Story.astro", "sections/Install.astro", "sections/Faq.astro"].flatMap((f) =>
      [...WEB(f).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]),
    );
    expect(WEB("pages/index.astro")).toContain('href="#story"');
    expect(ids).toContain("story");
    for (const l of copy.nav.links) expect(ids, `${l.href} has no section`).toContain(l.href.split("#")[1]);
    expect(ids).toContain(copy.download.install.href.split("#")[1]);
  });

  it("no retired claim is smuggled back in through an HTML comment", () => {
    // Astro copies `<!-- … -->` into dist/ verbatim; notes belong in frontmatter.
    const templates = [
      ...readdirSync(join(ROOT, "apps/web/src/sections")).map((f) => join(ROOT, "apps/web/src/sections", f)),
      ...readdirSync(join(ROOT, "apps/web/src/components")).map((f) => join(ROOT, "apps/web/src/components", f)),
      join(ROOT, "apps/web/src/pages/index.astro"),
    ].filter((f) => f.endsWith(".astro"));
    for (const file of templates) {
      const body = readFileSync(file, "utf8").split(/^---$/m).slice(2).join("---");
      expect([...body.matchAll(/<!--[\s\S]*?-->/g)], `${file} ships an HTML comment into dist/`).toEqual([]);
    }
  });
});

describe("does not sell a mechanism nothing mounts", () => {
/**
 * Every pattern is word-boundaried, and that is not style — the first draft of this
 * guard was written without boundaries and produced two false failures immediately:
 *
 *   · `/stalled/`    matched "already in·stalled" in the economics copy
 *   · `/supervisor/` matched "national supervisor·y authority" in the privacy notice
 *
 * Which is the same lesson `facts-match-source.test.ts` already records about a bare
 * `toContain("arrange")` matching "rearrangeXX". A loose substring is not a guard, and a
 * guard that cries wolf gets deleted by the next person in a hurry. The
 * `patterns are specific enough to be trusted` case below pins the fix.
 */
  const UNWIRED: readonly { name: string; needle: RegExp; pitch: RegExp }[] = [
    {
      name: "the bounded live feedback loop",
      needle: /useLiveLoop|canvas-live-loop-runner/,
      pitch: /\blive loop\b|\bfeedback loop\b|\bsilent pass\b|\bstalled\b|\biteration ceiling\b/i,
    },
    {
      name: "the cell supervisor",
      needle: /services\/supervisor/,
      pitch: /\bsupervisor\b|\bcircuit breaker\b|\banomal(y|ies)\b/i,
    },
  ];

  const CONSUMER_DIRS = [
    `${DESKTOP}/modules/codecanvas/components`,
    `${DESKTOP}/modules/codecanvas/containers`,
    `${DESKTOP}/modules/codespace/components`,
    `${DESKTOP}/modules/codespace/containers`,
    // The Workspace, since 2026-09-21 — the shell a user actually lands in.
    `${DESKTOP}/modules/workspace-shell/components`,
    `${DESKTOP}/modules/workspace-shell/containers`,
    // Where a canvas node draws itself — a Run button could land here too.
    `${DESKTOP}/modules/codecanvas/components/nodes`,
  ];

  // The vision statement and the headline are excluded: they are the product's direction,
  // pinned elsewhere, and deliberately allowed to say more than the demo shows (Option B).
  const { site: _site, hero: _hero, ...rest } = copy;
  const copyCorpus = JSON.stringify({ ...rest, site: { ..._site, positioning: "" }, hero: { ..._hero, headline: "" } });

  it.each(UNWIRED)("$name is still unwired, so the copy stays quiet about it", ({ needle, pitch, name }) => {
    const mounted = CONSUMER_DIRS.flatMap(sourceFiles).some((f) => needle.test(readFileSync(f, "utf8")));

    if (mounted) {
      // Good news, and a deliberate failure: go sell it.
      throw new Error(
        `${name} is now mounted in a user-facing surface. It is one of the strongest ` +
          `mechanisms in the product and the site says nothing about it. Write that ` +
          `section, then move this case out of UNWIRED.`,
      );
    }

    expect(
      pitch.test(copyCorpus),
      `The copy pitches ${name}, and nothing in the app mounts it. Advertising a ` +
        `capability that does not reach a user is the defect ` +
        `research/lotus-web-content-audit.md was written about — and the product's own ` +
        `nl-hint-phrases.ts holds itself to the opposite rule.`,
    ).toBe(false);
  });

  it("the graph run left this list: a click starts it now (Run Node, 2026-10-03)", () => {
    // It was here as "nothing in the app starts a run" (LOT2-65), and its needle was a CSS
    // class no component rendered. When the Run Node shipped, that needle could not see it —
    // the guard went blind instead of red. These are the reachable steps, read from source:
    // ⌘K "New Run from Selection" → Run → a member human gate goes to `waiting`.
    const C = `${DESKTOP}/modules/codecanvas`;
    expect(read(`${C}/services/commands/command-sheet-items.ts`)).toContain('"New Run from Selection"');
    // `onClick={onRun}`, or since resume shipped `onClick={resumable ? onResume : onRun}`.
    expect(read(`${C}/components/nodes/RunNodeCard.tsx`)).toMatch(/onClick=\{[^}]*\bonRun\}/);
    const gate = read(`${C}/components/nodes/HumanGateNode.tsx`);
    // The run hook now patches through humanGateWaitPatch, which sets status "waiting".
    expect(gate).toContain("run: () => patchGate(humanGateWaitPatch(Date.now()))");
    expect(read(`${C}/services/human-gate-decision.ts`)).toContain('return { status: "waiting", waitingSince: now };');
    expect(gate).toContain('disabled={status !== "waiting"} onClick={approve}');
    expect(copy.site.description, "the gate is reachable, so the description may say so").toMatch(/\bgates?\b/i);
  });

  it("patterns are specific enough to be trusted", () => {
    // The words that produced the false failures, plus their neighbours. If a future
    // pattern edit drops the boundaries, this fails here rather than in a real run.
    const INNOCENT = [
      "the agent CLIs you already installed and pay for",
      "your national supervisory authority",
      "installer",
      "loophole",
      "anomalous",
    ];
    for (const { name, pitch } of UNWIRED) {
      for (const text of INNOCENT) {
        expect(
          pitch.test(text),
          `The pitch pattern for ${name} matches "${text}", which is not a pitch. ` +
            `Word-boundary it — a guard that fires on ordinary prose gets deleted.`,
        ).toBe(false);
      }
    }
  });

  it("would actually catch the pitch it is guarding against", () => {
    // A guard nobody has seen fire is a guard nobody trusts. These are the sentences
    // that were drafted and cut; each must be caught by its own pattern.
    const DRAFTED: readonly [string, string][] = [
      [
        "the bounded live feedback loop",
        "The agent retries against its own task until a verdict passes, and there is never a silent pass.",
      ],
      [
        "the cell supervisor",
        "A supervisor watches the panes, and a circuit breaker caps it at three interventions per cell per hour.",
      ],
    ];
    for (const [name, sentence] of DRAFTED) {
      const rule = UNWIRED.find((u) => u.name === name)!;
      expect(rule.pitch.test(sentence), `${name}: the guard would have missed its own cut draft`).toBe(
        true,
      );
    }
  });
});
