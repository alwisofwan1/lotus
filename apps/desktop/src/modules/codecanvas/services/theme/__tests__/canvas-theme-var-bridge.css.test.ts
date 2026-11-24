import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BUILTIN_THEMES } from "../builtin-themes";
import { resolveCanvasTheme } from "../resolve-canvas-theme";
import { toCanvasThemeStyle } from "../canvas-theme-style";

/**
 * The bridge contract, and the only test here that generalises rather than checks one token.
 *
 * `toCanvasThemeStyle` renames every var the resolver produces from `--x` to `--ct-x` and
 * CanvasPage injects that as inline style on `.codecanvas-shell`. Nothing then consumes
 * `--ct-x` directly: `theme.css` has to declare the PUBLIC name as
 * `--x: var(--ct-x, <fallback>)`. Miss that one line and the token is undefined, every
 * declaration referencing it is invalid at computed-value time, and the consumer silently
 * falls back — or inherits, which is worse because it usually looks plausible.
 *
 * This has now happened twice in this file. The `--node-floor-solid` comment in theme.css
 * records the first: a terminal viewport that went transparent, betrayed only by a one-row
 * strip of glass along the bottom edge. The second was all four `--canvas-font-*` roles,
 * unbridged since the resolver first emitted them — so `fonts.mono` on a theme reached
 * nothing, and the suite that was supposed to cover it asserted the CSS *text* named the
 * token, which it did, while the token itself was undefined.
 *
 * That is the lesson worth encoding: a stylesheet assertion cannot see an undefined variable.
 * So this test does not check any specific token. It asks the resolver what it emits and
 * requires a bridge for each, which makes the next missing bridge a red test rather than a
 * visual puzzle.
 */

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every canvas stylesheet that is allowed to declare a bridge. */
const CANVAS_CSS = stripCssComments(
  ["src/styles/canvas/theme.css", "src/styles/canvas/node-shell.css"].map(read).join("\n"),
);

/**
 * Vars the resolver emits that are deliberately NOT bridged, each with the reason.
 *
 * Keep this list adversarial. Every entry is a token whose value reaches no rule, so the
 * bar for adding one is proof that nothing needs it — not "the test is failing".
 */
const UNBRIDGED_BY_DESIGN: Record<string, string> = {
  // The material travels as `data-canvas-material` on .codecanvas-shell, which is what
  // theme.css branches on (`[data-canvas-material="solid"]`). CSS cannot select on a custom
  // property's value without style queries, so a var was never usable here. Verified: no
  // stylesheet and no component reads --node-surface-style; the only other references are
  // the resolver that writes it and the resolver's own unit test.
  "--node-surface-style": "material is carried by the data-canvas-material attribute instead",
};

/** The union of var names the resolver emits across the whole built-in catalog. */
function emittedVarNames(): string[] {
  const names = new Set<string>();
  for (const theme of BUILTIN_THEMES) {
    for (const key of Object.keys(resolveCanvasTheme(theme))) names.add(key);
  }
  return [...names].filter((n) => !(n in UNBRIDGED_BY_DESIGN)).sort();
}

describe("theme var bridge", () => {
  const names = emittedVarNames();

  it("emits a non-trivial number of vars, so an empty sweep cannot pass vacuously", () => {
    expect(names.length).toBeGreaterThan(25);
  });

  it("keeps the unbridged allowlist honest — every entry must still be emitted", () => {
    // A stale exemption is how this guard would rot: the token gets renamed or dropped, the
    // entry stays, and it silently excuses the NEXT token that happens to take that name.
    const emitted = new Set(Object.keys(resolveCanvasTheme(BUILTIN_THEMES[0])));
    for (const name of Object.keys(UNBRIDGED_BY_DESIGN)) {
      expect(emitted.has(name), `${name} is exempted but no longer emitted — drop the entry`).toBe(
        true,
      );
    }
  });

  it.each(names.map((n) => [n] as const))("%s is bridged from its --ct-* source", (name) => {
    const publicName = name; // e.g. --canvas-font-mono
    const source = `--ct-${name.slice(2)}`; // e.g. --ct-canvas-font-mono
    // The declaration must read the --ct-* twin. `[^;]*` keeps this tolerant of the nested
    // var() fallbacks the file uses, without accepting a declaration that ignores the source.
    const bridge = new RegExp(
      `${publicName.replace(/[-]/g, "\\-")}\\s*:\\s*[^;]*var\\(\\s*${source.replace(/[-]/g, "\\-")}\\b`,
    );
    expect(
      CANVAS_CSS,
      `no bridge for ${publicName}: theme.css must declare "${publicName}: var(${source}, <fallback>)" or the resolver's value never reaches a rule`,
    ).toMatch(bridge);
  });

  it("renames every var to the --ct-* layer and drops nothing on the way", () => {
    // Guards the rename itself: a bridge is useless if the style object uses another name.
    for (const theme of BUILTIN_THEMES) {
      const resolved = resolveCanvasTheme(theme);
      const injected = toCanvasThemeStyle(theme) as unknown as Record<string, string>;
      expect(Object.keys(injected).length).toBe(Object.keys(resolved).length);
      for (const [key, value] of Object.entries(resolved)) {
        expect(injected[`--ct-${key.slice(2)}`], `${theme.id}: ${key} lost in rename`).toBe(value);
      }
    }
  });

  it("bridges the optional hud role to the app mono, not to a canvas token", () => {
    // The one bridge whose fallback is a PERMANENT value rather than a first-paint stand-in:
    // themes without a `fonts.hud` keep it forever. It has to equal what the agent-node.css
    // consumers resolved to before the bucket existed, or five themes change silently.
    const decl = CANVAS_CSS.match(/--canvas-font-hud\s*:[^;]*;/)?.[0] ?? "";
    expect(decl).toMatch(/var\(\s*--ct-canvas-font-hud\s*,/);
    expect(decl, "a pixel face here would leak into every theme").not.toMatch(/Silkscreen|Pixelify/);

    // It must not reach the app mono through a NAME. The isolation block below remaps
    // `--font-mono` to the theme mono inside this shell, so `var(--font-mono, …)` here — which
    // is what this line said until the font bridge landed — would redirect hud onto a canvas
    // token while the declaration text stayed byte-identical. That is the failure this file's
    // own header warns about, arriving through a redefinition instead of an omission.
    expect(decl, "hud must not read a name the isolation block remaps").not.toMatch(
      /var\(\s*--font-mono/,
    );
    // Scope this to the FALLBACK — the declaration's own name obviously contains the prefix.
    const fallback = decl.replace(/^[^,]*,/, "");
    expect(fallback, "hud must not fall back onto a canvas token").not.toMatch(/--canvas-font-/);
  });

  it("keeps the hud fallback equal to the app mono stack in globals.css", () => {
    // The literal above is a COPY, so it can drift. Compare the two rather than restating
    // either: whichever file moves first, this goes red and names the other.
    const hud = CANVAS_CSS.match(
      /--canvas-font-hud\s*:\s*var\(\s*--ct-canvas-font-hud\s*,([^;]*)\)\s*;/,
    )?.[1];
    // globals.css keeps a `var(--font-geist-mono, …)` hook in front of the real stack; geist is
    // not a dependency, so the stack is the fallback and that is what actually renders.
    const app = stripCssComments(read("src/app/globals.css")).match(
      /--font-mono\s*:\s*var\(\s*--font-geist-mono\s*,([^;]*)\)\s*;/,
    )?.[1];

    const families = (stack: string | undefined): string[] =>
      (stack ?? "")
        .split(",")
        .map((f) => f.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);

    expect(families(hud).length, "could not read the hud fallback stack").toBeGreaterThan(1);
    expect(
      families(hud),
      "theme.css --canvas-font-hud and globals.css --font-mono have drifted apart",
    ).toEqual(families(app));
  });
});

/**
 * The typographic half of APP-TOKEN ISOLATION.
 *
 * The colour remap has been in theme.css since Garden of Dawn made the two theme systems
 * visibly disagree. The font names were left out, so canvas surfaces recoloured with the theme
 * while still rendering in the app's faces — a theme's `fonts.mono` reached nothing but the
 * terminal chrome, and `fonts.body` reached four declarations in the entire module.
 *
 * These assertions are deliberately about the SHELL rule, not about any consumer: the point of
 * the remap is that a component never has to know it exists.
 */
describe("app-token isolation — font roles", () => {
  const shell = CANVAS_CSS.match(/^\.codecanvas-shell\s*\{[\s\S]*?^\}/m)?.[0] ?? "";

  it("finds the shell rule at all, so the assertions below cannot pass vacuously", () => {
    expect(shell).toMatch(/--fg\s*:\s*var\(--canvas-text\)/);
  });

  it("points the app mono at the theme mono inside the canvas", () => {
    expect(shell).toMatch(/--font-mono\s*:\s*var\(\s*--canvas-font-mono\s*\)/);
  });

  it("points the app sans at the theme body face inside the canvas", () => {
    // --font-sans is additionally DEAD outside this shell: globals.css defines it as
    // var(--font-geist-sans), and nothing defines --font-geist-sans.
    expect(shell).toMatch(/--font-sans\s*:\s*var\(\s*--canvas-font-body\s*\)/);
  });

  it("leaves the app sans broken-by-omission outside the canvas, so this stays a canvas fix", () => {
    // Not a licence to ignore it — a note that the repair here is scoped, and globals.css is
    // still the place to fix the app-wide token. Kept as an assertion so that when someone does
    // fix it, they are pointed at this comment rather than surprised by it.
    const globals = stripCssComments(read("src/app/globals.css"));
    const declaresGeistSans = /--font-geist-sans\s*:/.test(globals);
    expect(
      declaresGeistSans,
      "globals.css now defines --font-geist-sans — drop the note in theme.css",
    ).toBe(false);
  });
});
