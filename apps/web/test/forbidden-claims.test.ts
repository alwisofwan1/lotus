/**
 * The forbidden-claims list, enforced instead of remembered.
 *
 * `plans/lotus-web/issues/06-strategi-go-to-market.md` §7 lists claims the site must
 * not make. Three of them are not caution — they are factually wrong, and they are
 * exactly the sentences a marketer reaches for. A list in a document only helps the
 * person who happens to re-read it; this fails the build instead.
 *
 * Scope note: this walks the strings in `copy.ts`, which is where all copy lives by
 * convention. If a sentence is ever typed directly into a `.astro` file it escapes
 * this net — which is one more reason the convention exists.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import * as copy from "../src/copy";

/** Every string reachable from the copy module, with a path for the error message. */
function strings(value: unknown, path = "copy"): { path: string; text: string }[] {
  if (typeof value === "string") return [{ path, text: value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  }
  return [];
}

const ALL = strings(copy);
/** Release notes are published copy too (changelog, GitHub Release, update feed). */
const NOTES_DIR = `${import.meta.dirname}/../src/releases`;
const NOTES = readdirSync(NOTES_DIR).filter((f) => f.endsWith(".md")).map((f) => ({ path: `releases/${f}`, text: readFileSync(`${NOTES_DIR}/${f}`, "utf8") }));
const CORPUS = ALL.map((s) => s.text).join("\n");

interface Rule {
  readonly claim: string;
  readonly pattern: RegExp;
  readonly why: string;
  /** Site copy only: release notes may name a CLI that ships on another surface. */
  readonly copyOnly?: boolean;
}

const FORBIDDEN: readonly Rule[] = [
  {
    claim: "privacy / data locality",
    pattern: /(never|does not|doesn't)\s+leave[s]?\s+your\s+(machine|computer|device)/i,
    why:
      "Factually false. Lotus drives vendor CLIs that send code to their APIs — " +
      "local describes the process, not the data. issues/06 §7 item 1.",
  },
  {
    claim: "Linux availability",
    pattern: /\blinux\b/i,
    why:
      "Only macOS (bundle targets) and Windows (release-windows.yml) are built. " +
      "issues/06 §7 item 2. Windows came off this list on 2026-11-07 when its release " +
      "workflow started publishing an installer — facts-match-source.test.ts checks that.",
  },
  {
    claim: "speed or productivity multiplier",
    pattern: /\b\d+\s*x\b|\b\d+%\s*(faster|quicker|more productive)/i,
    why: "No benchmark exists for any such number. issues/06 §7 item 4.",
  },
  {
    claim: "testimonial or adoption count",
    pattern: /\b(loved by|trusted by|join \d|\d+[,\d]*\+? (users|developers|teams|installs))\b/i,
    why: "There are no users yet. issues/06 §7 item 7.",
  },
  {
    claim: "a verification guarantee",
    pattern:
      /(never (ships|escapes|gets through)|always catch|catches (every|all)|guarantee|prevents (all|every)|no bad (code|output))/i,
    why:
      "The hero now sells a critic that gates output, and the obvious next sentence is " +
      "'so nothing bad ships'. It is not true: a critic is an agent with a verdict, not a " +
      "proof. The copy says a critic *can* close the gate, and it has to stay hedged.",
  },
  {
    claim: "team / enterprise capability",
    pattern: /\b(enterprise|sso|multi-?tenant|per-?seat)\b/i,
    why: "The target is a single Device Operator. issues/06 §7 item 8.",
  },
];

describe("forbidden claims never reach the copy", () => {
  it.each(FORBIDDEN)("does not claim: $claim", ({ pattern, why, copyOnly }) => {
    const offenders = (copyOnly ? ALL : [...ALL, ...NOTES]).filter((s) => pattern.test(s.text));
    expect(
      offenders.map((o) => `${o.path}: ${o.text}`),
      `Forbidden claim found.\n${why}`,
    ).toEqual([]);
  });

  it("pins the hero headline, because changing it is never a one-file edit", () => {
    // Not pedantry. The headline lives in six places that must move together, and it
    // has already been rewritten twice:
    //   src/copy.ts · scripts/og-card.html · public/og.png (re-render!) ·
    //   og:image:alt in src/layouts/Base.astro · site.description ·
    //   mockups/lotus-web.pen (the revamp's design file)
    // A failure here means: decide deliberately, update all six, then update this test
    // and record the decision in issues/01. It must not drift silently.
    expect(copy.hero.headline.lead).toBe("Draw how your agents work together.");
    expect(copy.hero.headline.turn).toBe("Lotus runs it.");

    // The meta description has to argue the same thing the headline does, or a shared
    // link previews one product and opens another.
    expect(copy.site.description).toMatch(/hand work to each other|hand off/i);
    // Option B (2026-09-30) took the gate out of the description because no click could
    // start a graph run (LOT2-65). The Run Node made it reachable on 2026-10-03, so it is
    // back — and copy-matches-product.test.ts reads the app to keep that true.
    expect(copy.site.description).toMatch(/ask|wait/i);
  });

  it("states the platforms, so the limit (no Linux, no Intel Mac) is visible rather than implied", () => {
    expect(copy.site.platform).toBe("macOS and Windows");
    expect(CORPUS).toContain("Apple Silicon");
  });

  /**
   * Not a claim, but the same class of defect, and the same walker finds it: for almost
   * every section there is no Markdown step between `copy.ts` and the page, so a backtick
   * renders as a backtick. That is how "`safe` keeps the CLI's own permission prompts"
   * reached a built page looking like a typo.
   *
   * `privacy` is the one exception, and it is a real one rather than a carve-out for
   * convenience: `pages/privacy.astro` deliberately renders backticked terms as `<code>`,
   * because the channel tags it lists genuinely are literals. Its renderer allows that
   * and nothing else through.
   *
   * So the rule is scoped to the surfaces that have no renderer. Adding another
   * backtick-rendering page means adding it here — deliberately, with the renderer to
   * point at. Everywhere else, code styling gets an element: the capabilities list
   * already does this with its `code` array.
   */
  it("contains no Markdown syntax on the surfaces that cannot render it", () => {
    const RENDERS_CODE_SPANS = ["copy.privacy"];
    const offenders = ALL.filter(
      (s) =>
        !RENDERS_CODE_SPANS.some((prefix) => s.path.startsWith(prefix)) &&
        (s.text.includes("`") ||
          /\*\*\S/.test(s.text) ||
          // SINGLE asterisks too. The pattern only caught `**bold**`, so
          // "Busy *right now* has no single honest signal" shipped its asterisks to the
          // rendered page as punctuation — the same defect as the backticks, one character
          // narrower. Emphasis is an element here, never syntax.
          /(?:^|[\s(])\*\S/.test(s.text) ||
          /\[[^\]]+\]\([^)]+\)/.test(s.text)),
    );
    expect(
      offenders.map((o) => `${o.path}: ${o.text}`),
      "This copy goes straight into markup with no Markdown step. Use an element for " +
        "code, or plain words.",
    ).toEqual([]);
  });

  it("the one exception still has the renderer that justifies it", () => {
    // If privacy.astro stops turning backticks into <code>, the allowlist above is
    // silently wrong and the privacy page starts showing backticks.
    const page = readFileSync(
      new URL("../src/pages/privacy.astro", import.meta.url),
      "utf8",
    );
    expect(
      page,
      "privacy.astro no longer renders backticked terms as <code>, so `copy.privacy` " +
        "must come off the allowlist above and its backticks must go.",
    ).toMatch(/`\(\[\^`\]\+\)`|<code>\$1<\/code>/);
  });

  it("mentions Pocket without claiming availability or a date", () => {
    const phone = ALL.filter((s) => /\bphone\b/i.test(s.text));
    expect(phone.length, "the paired-phone capability disappeared from the copy").toBeGreaterThan(
      0,
    );
    for (const { text } of phone) {
      expect(text, "reads as an availability claim").not.toMatch(
        /\b(download|available now|coming (soon|in)|ships? (in|on))\b/i,
      );
    }
  });
});
