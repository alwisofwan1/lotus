/**
 * The privacy notice, guarded against the two ways it can rot.
 *
 * It can rot by omission — a heading trimmed, and an Art. 13 obligation quietly
 * stops being met. And it can rot by *the site changing underneath it*, which is the
 * worse one and the reason this file exists: the notice states facts about what this
 * site does (no third-party script, fonts served by Google, the form posts to
 * Buttondown). Every one of those is a property of other files. Change one of those
 * files and the notice becomes a false statement on a legal page, with nothing
 * failing.
 *
 * So the assertions below are mostly biconditional: they fail if the notice stops
 * describing the site, in either direction.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { privacy, footer, hero } from "../src/copy";
import { describeForm, describePlacement, createFormAdapter } from "../src/lib/waitlist";
import { BUTTONDOWN_USERNAME, KNOWN_NOT_OURS } from "../src/lib/waitlist/config";

/**
 * A stand-in handle, so the endpoint assertions describe where the form *would*
 * post and stay true whether or not an account is configured today. Using the live
 * config here would make these tests silently vacuous the moment it is `null`.
 */
const SAMPLE = "sample-account";

const SRC = resolve(dirname(new URL(import.meta.url).pathname), "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const BASE = read("layouts/Base.astro");
const NOTICE = [
  privacy.intro,
  ...privacy.sections.flatMap((s) => [s.heading, ...s.body]),
].join("\n");

describe("the notice covers what GDPR Art. 13 actually asks for", () => {
  // Not a vibe check: each entry is the obligation, and the phrase that proves the
  // notice addresses it. A heading alone would let an empty section pass.
  const OBLIGATIONS: readonly { article: string; proof: RegExp }[] = [
    { article: "13(1)(a) controller identity", proof: /controller of your data is/i },
    { article: "13(1)(b) DPO, or the absence of one", proof: /no Data Protection Officer/i },
    { article: "13(1)(c) purpose", proof: /build log|invite when the macOS build/i },
    { article: "13(1)(c) legal basis", proof: /Art\. 6\(1\)\(a\)/ },
    { article: "13(1)(e) recipients", proof: /Buttondown/ },
    { article: "13(1)(f) third-country transfer", proof: /Standard Contractual Clauses/i },
    { article: "13(2)(a) retention", proof: /until you unsubscribe/i },
    { article: "13(2)(b) access, erasure, portability", proof: /have it deleted/i },
    { article: "13(2)(c) withdrawing consent", proof: /withdraw consent at any time/i },
    { article: "13(2)(d) complaint to a supervisory authority", proof: /supervisory authority/i },
    { article: "13(2)(e) whether providing data is obligatory", proof: /entirely optional/i },
    { article: "22 automated decision-making", proof: /Art\. 22/ },
  ];

  for (const { article, proof } of OBLIGATIONS) {
    it(`addresses ${article}`, () => {
      expect(
        proof.test(NOTICE),
        `The privacy notice no longer addresses ${article}. Restore it — this is a ` +
          `statutory disclosure, not copy to be tightened.`,
      ).toBe(true);
    });
  }
});

describe("the notice describes this site and not a different one", () => {
  it("discloses Google Fonts exactly while the page loads Google Fonts", () => {
    const loadsGoogleFonts = BASE.includes("fonts.googleapis.com");
    const disclosesGoogle = /fonts\.googleapis\.com/.test(NOTICE);

    expect(
      disclosesGoogle,
      loadsGoogleFonts
        ? "Base.astro loads fonts from Google, so every visitor's IP reaches Google. " +
            "The notice must say so."
        : "Base.astro no longer loads Google Fonts — self-hosted at last. Remove the " +
            "disclosure from the notice instead of leaving a stale third party on a " +
            "legal page.",
    ).toBe(loadsGoogleFonts);
  });

  it("only claims there is no third-party script while script-src is self-only", () => {
    const scriptSrc = /"(script-src[^"]*)"/.exec(BASE)?.[1] ?? "";
    expect(scriptSrc, "script-src directive not found in Base.astro").not.toBe("");

    if (/no analytics script|no third-party script|ships no JavaScript/.test(NOTICE)) {
      expect(
        scriptSrc,
        `The notice claims this site runs no third-party script, but the CSP is ` +
          `"${scriptSrc}". Either the claim goes or the directive does.`,
      ).toBe("script-src 'self'");
    }
  });

  it("names Buttondown as the recipient the form actually posts to", () => {
    const plan = describeForm(createFormAdapter(SAMPLE), "hero");
    const host = new URL(plan.action).hostname.replace(/^www\./, "");
    const processor = host.split(".")[0];

    expect(
      new RegExp(processor, "i").test(NOTICE),
      `The form posts to ${host}, so the notice has to name that processor. It ` +
        `currently does not — a recipient the visitor cannot see is the exact ` +
        `omission Art. 13(1)(e) forbids.`,
    ).toBe(true);
  });

  it("lets the form reach that host through the CSP", () => {
    const formAction = /"(form-action[^"]*)"/.exec(BASE)?.[1] ?? "";
    const host = new URL(describeForm(createFormAdapter(SAMPLE), "hero").action).origin;

    expect(
      formAction.includes(host),
      `form-action is "${formAction}" but the form posts to ${host}. ` +
        `form-action does NOT fall back to default-src, so this silently blocks every ` +
        `signup — verified in a browser once already. Add the origin, not a wildcard.`,
    ).toBe(true);
  });
});

describe("the notice is reachable from every place that asks for an email", () => {
  const PLACEMENTS = ["sections/Hero.astro", "sections/Footer.astro"] as const;

  for (const file of PLACEMENTS) {
    it(`${file} links the notice beside its form`, () => {
      const source = read(file);
      expect(source, `${file} has no form — has a placement moved?`).toContain("<form");
      expect(
        source.includes('href="/privacy/"'),
        `${file} collects an email address without linking the privacy notice. ` +
          `GDPR Art. 13(1) requires the information at the point of collection. ` +
          `An anchor into the footer does not count — that is what this replaced.`,
      ).toBe(true);
    });
  }

  it("tags each placement differently, or the channel tag measures nothing", () => {
    const adapter = createFormAdapter(SAMPLE);
    const tagOf = (channel: "hero" | "footer") =>
      describeForm(adapter, channel).hidden.find((h) => h.name === "tag")?.value;

    expect(tagOf("hero")).toBe("hero");
    expect(tagOf("footer")).toBe("footer");
    expect(tagOf("hero")).not.toBe(tagOf("footer"));
  });
});

describe("unfilled placeholders stay visible and stay counted", () => {
  /**
   * `<angle bracket>` values are deliberately unfilled — inventing a legal entity on
   * a legal page would be a fabrication. But an unfilled placeholder that nobody is
   * tracking is how a site launches with `<legal entity name>` in production, so the
   * set is pinned: a new one fails here and has to be added deliberately.
   */
  const EXPECTED = new Set([
    "<legal entity name>",
    "<registered postal address>",
    "<privacy contact email>",
  ]);

  it("has exactly the placeholders we know about", () => {
    const found = new Set([...NOTICE.matchAll(/<[a-z][^>]*>/g)].map((m) => m[0]));
    expect(
      [...found].sort(),
      "A placeholder appeared or disappeared in the privacy notice. If it was filled " +
        "in, remove it from EXPECTED here too — that is the point of this list.",
    ).toEqual([...EXPECTED].sort());
  });

  it("uses the same placeholder for the address as the footer does", () => {
    expect(
      NOTICE.includes(footer.postalAddress),
      `The notice and the footer must name the same address. The footer says ` +
        `"${footer.postalAddress}".`,
    ).toBe(true);
  });

  it("promises the unsubscribe the notice relies on", () => {
    expect(hero.fineprint).toMatch(/unsubscribe/i);
    expect(NOTICE).toMatch(/one-click unsubscribe/i);
  });
});

/**
 * The most expensive thing learned building this page, kept as a test.
 *
 * `config.ts` used to hold `BUTTONDOWN_USERNAME = "lotus"` as a harmless-looking
 * placeholder. `https://buttondown.com/lotus` is a real newsletter belonging to a
 * real person — so the "placeholder" was a stranger's mailing list, and the only
 * reason nothing leaked is that the site's own CSP happened to block cross-origin
 * form submission. Fixing the CSP is what made it dangerous.
 */
describe("the waitlist never posts to an account we do not own", () => {
  it("is closed while no account is configured", () => {
    if (BUTTONDOWN_USERNAME !== null) return; // configured — covered by the case below

    for (const channel of ["hero", "footer"] as const) {
      const placement = describePlacement(channel);
      expect(
        placement.open,
        `${channel} is open with no account configured. There is nowhere safe for it ` +
          `to post — a guessed handle is somebody else's list.`,
      ).toBe(false);
    }
  });

  it("refuses a handle known to belong to someone else", () => {
    expect(
      KNOWN_NOT_OURS,
      "`lotus` must stay on this list: buttondown.com/lotus is a real newsletter " +
        "owned by someone else, checked in a browser 2026-08-23.",
    ).toContain("lotus");

    if (BUTTONDOWN_USERNAME === null) return;
    expect(
      KNOWN_NOT_OURS.includes(BUTTONDOWN_USERNAME.trim().toLowerCase()),
      `BUTTONDOWN_USERNAME is set to "${BUTTONDOWN_USERNAME}", which is on the ` +
        `not-ours list. That address belongs to someone else.`,
    ).toBe(false);
  });

  it("opens both placements, with distinct tags, once a real handle is set", () => {
    // Proves the closed state is a gate and not a dead end: the same seam, given a
    // handle nobody else owns, produces two working placements.
    const plans = (["hero", "footer"] as const).map((c) => describeForm(createFormAdapter(SAMPLE), c));
    const tags = plans.map((p) => p.hidden.find((h) => h.name === "tag")?.value);

    expect(new Set(tags).size).toBe(2);
    for (const plan of plans) {
      expect(new URL(plan.action).hostname).toBe("buttondown.com");
      expect(plan.action).toContain(SAMPLE);
    }
  });
});

/**
 * Every internal link points at something that exists.
 *
 * This generalises two defects that already shipped here. The privacy link pointed
 * at `#legal`, an anchor that existed but held no notice; and before `404.astro`,
 * every unmatched path returned the homepage with HTTP 200, so a broken link looked
 * like a working one. Both were found by hand. A dead internal link has no error
 * anywhere — the visitor just lands somewhere wrong.
 */
describe("internal links resolve", () => {
  // Redesign 2026-11-21: the page is these files now. A missing file FAILS here (below) —
  // the old list silently skipped removed sections, which is how a guard quietly stops
  // guarding anything.
  const SECTIONS = [
    "pages/index.astro",
    "pages/changelog.astro",
    "sections/Hero.astro",
    "sections/Story.astro",
    "sections/Pocket.astro",
    "sections/Install.astro",
    "sections/Faq.astro",
    "sections/Footer.astro",
  ] as const;

  /** A route is a page file: `/privacy/` is built from `pages/privacy.astro`. */
  function routeExists(path: string): boolean {
    const slug = path.replace(/^\/+|\/+$/g, "");
    if (slug === "") return true; // the homepage
    for (const candidate of [`pages/${slug}.astro`, `pages/${slug}/index.astro`, `pages/${slug}.ts`]) {
      try {
        read(candidate);
        return true;
      } catch {
        /* try the next shape */
      }
    }
    return false;
  }

  const ANCHORS = new Set(
    SECTIONS.flatMap((file) => {
      let source: string;
      try {
        source = read(file);
      } catch {
        return [];
      }
      return [...source.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    }),
  );

  for (const file of SECTIONS) {
    it(`${file} has no dead internal link`, () => {
      const source = read(file);

      const dead = [...source.matchAll(/href="(\/[^"]*|#[^"]+)"/g)]
        .map((m) => m[1])
        .filter((href) => {
          if (href.startsWith("#")) return !ANCHORS.has(href.slice(1));
          const [path] = href.split("#");
          return !routeExists(path);
        });

      expect(
        dead,
        `${file} links to ${dead.join(", ")}, which resolve to nothing. A dead ` +
          `internal link fails silently — the visitor simply lands somewhere wrong.`,
      ).toEqual([]);
    });
  }
});
