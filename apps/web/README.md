# `apps/web` — Lotus Web

The marketing and waitlist site. Astro 7 + Tailwind 4, static output, deployed to
Cloudflare Pages.

Decisions live in [`plans/lotus-web/map.md`](../../plans/lotus-web/map.md); the
execution order lives in [`PLAN.md`](../../plans/lotus-web/PLAN.md). This README only
covers running it.

```bash
# from the repo root — pass-through scripts
bun run web:dev        # dev server
bun run web:build      # static build into dist/
bun run web:preview    # serve the built output
bun run web:check      # astro check (types + template diagnostics)
```

## Three rules that are easy to break

**Never `bun install` at the repo root.** A root lockfile moves every Next app's
inferred Turbopack root up to the repo root, and the failure is invisible until a cold
compile. A `preinstall` guard refuses it. Install per package, or run
`bun run install:all`. Background:
[`docs/adr/0011`](../../docs/adr/0011-apps-web-isolation-and-turbopack-root.md).

**This package imports nothing from any other package.** Not `apps/desktop`, not
`packages/host`, not `contract/`. Brand assets in `src/assets/brand/` are *copies* —
see the `SOURCE.md` beside them. Nothing enforces this; it is structurally awkward
rather than blocked.

**TypeScript is pinned to `^6` on purpose.** `astro check` needs a programmatic API
that TypeScript's native compiler (7.x) does not ship yet. Bumping to 7 silently kills
type-checking.

## Where things go

| Path | What |
|---|---|
| `src/copy.ts` | **Every word on the site.** Re-exports the facts below so sections import all text from one place |
| `src/lib/waitlist/` | The only behaviour on the site: the work-email rule, channel tagging, endpoint construction, and the navigate-vs-inline adapter choice. **No DOM types** |
| `src/lib/facts/` | Numbers derived from the product's source, each with a `probe` a test can re-derive it from |
| `src/sections/` | One file per page section, single-use |
| `src/components/` | Only what is used more than once |
| `src/layouts/Base.astro` | The only `<html>` shell — head, OG tags, fonts, CSP |
| `src/assets/brand/` | Copied brand marks, with provenance |
| `src/assets/demo/` | Demo imagery, under a hard size budget — see `SOURCE.md` there |
| `src/styles/global.css` | Design tokens. Deliberately **not** the desktop app's `DESIGN.md` |

## Tests

```bash
bun run test        # vitest, node environment
bun run test:watch
```

Nine files. The rest, in one line each: `demo-machine` and `demo-interactive` (the live demo's
state machine and wiring), `copy-matches-product` and `forbidden-claims` (claims checked
against the product and the forbidden list), `seo-head` (the built `dist/` metadata),
`privacy-notice` and `privacy-desktop` (the legal pages match what the site does). The two
below are the ones whose reasoning is not obvious:

- **`test/facts-match-source.test.ts`** reads the product's actual source and fails
  when the site's numbers no longer match it. Drafting this site produced two wrong
  claims by hand-transcription; this catches that class by construction. It also
  guards two forbidden claims — it fails if Gemini or Cursor become real agent
  runners, and if bundle targets grow past macOS. It is a deliberate, narrow
  exception to the no-imports rule, on the terms set out in the ADR amendment.
- **`test/waitlist.test.ts`** covers the work-email rule and the adapter seam. It
  runs in Node with no DOM and no network — if a test here ever needs a browser, the
  logic has leaked into the UI.

## Architecture, and what was deliberately not built

There are exactly **two seams**, because only two things actually vary: the waitlist
submission (two shipping adapters plus a fake) and the code-derived facts (the test
is the second caller). There is no `domain/`, `application/` or `infrastructure/`
layer, no repository pattern, no DI container, and no i18n abstraction. On a site
with one form and no data those are shallow modules — large interface, thin
implementation — and they cost maintenance without buying capability. Reasoning in
[`issues/05`](../../plans/lotus-web/issues/05-arsitektur-dan-struktur-folder.md).

## Claims are constrained

Copy on this site is bound by a forbidden-claims list in
[`issues/06` §7](../../plans/lotus-web/issues/06-strategi-go-to-market.md). Three of them
are not caution, they are factually wrong: no privacy claims ("your code never leaves
your machine" is false — Lotus drives vendor CLIs that send code to their APIs), no
Windows/Linux availability (bundle targets are macOS only), and no Pocket availability
or dates. Read the list before writing copy.
