# `apps/web` is isolated by structure, and the Turbopack root is pinned

## Status

accepted

## Context

Lotus is adding a third app, `apps/web` — a static marketing and waitlist site
(`plans/lotus-web/`). Two questions had to be settled
before it existed: what `apps/web` is allowed to reach for, and what stops it from
breaking the desktop build.

The second question turned out to be the dangerous one, and not for the reason it
first appeared. The obvious worry was "two Next apps in one repo will fight over
`.next/`". That worry is misplaced — Next derives its Turbopack and
output-tracing root by walking **ancestor** directories for a lockfile and taking
the highest one it finds. It never looks at siblings. So `apps/web/bun.lock` cannot
reach `apps/desktop`.

The real hazard is a single `bun install` at the repo root. That creates a root
lockfile, which becomes the highest in the ancestor chain for *every* Next app in
the tree, moving each inferred root up to the repo root and pulling
`apps/pocket/`, `packages/host/` and `**/src-tauri/target/` into resolve and watch
scope. This repo survives that today **by accident**: `install:all`
(`package.json`) deliberately `cd`s into each package, and no lockfile exists at
the root or in any ancestor up to `/`.

That accident is a bad thing to rely on, because the symptom is invisible until a
cold compile. This repo has already lost time to exactly that class twice — the
Cargo `target/` absolute-path cache and the Turbopack `.next/` absolute-path cache,
both documented in [`CLAUDE.md`](../../CLAUDE.md). Both presented as an error whose
message named a path that had not existed for weeks.

On the first question, the boundary turned out to need no tooling. The repo's
dependency rule is already one-way — desktop → host, never the reverse — and
crossing it is structurally awkward: `apps/desktop/tsconfig.json` maps only
`@/*` → `./src/*`, there is no tsconfig at the repo root, and without workspaces a
package name like `@lotus/desktop` cannot be resolved from another package. The
only way across is an explicit multi-level relative path, which is conspicuous in
review. The evidence that this holds: `apps/desktop/src` imports `packages/host`
**zero** times, and the single deliberate crossing —
`apps/desktop/scripts/build-host-bundle.mjs` — uses
`../../../packages/host/package.json` in plain sight.

## Decision

**`apps/web` imports nothing from any other package.** Not `apps/desktop`, not
`packages/host`, not `contract/`. Brand assets are **copied** into
`apps/web/src/assets/brand/` with a comment naming the source. Duplicating three
SVG files is accepted in exchange for not coupling the web build to the desktop
tree.

**No lint boundary is added.** Enforcing a rule that is already structurally hard
to break buys nothing, and this repo has no import-boundary tooling to extend.

**`packages/brand/` is not created.** It would be an abstraction with one
consumer; desktop does not use it.

**`turbopack.root` is pinned explicitly** in `apps/desktop/next.config.ts` rather
than inferred. Next synchronises `turbopack.root` and `outputFileTracingRoot` to a
single value, so pinning one pins both; this repo sets neither elsewhere.

**A root `preinstall` guard refuses installs at the repo root**
(`tools/no-root-install.mjs`), and the invariant is written into `CLAUDE.md`. The
pin makes the hazard harmless; the guard makes it audible.

## Considered Options

- **ESLint `no-restricted-imports` on `apps/web`** — rejected. It would enforce a
  boundary that is already awkward to cross, and `apps/web` has no ESLint setup to
  extend.
- **A cross-boundary build step copying assets from `apps/desktop/public`** —
  rejected. It would add a second crossing to a repo that deliberately has exactly
  one, and it makes the web build fail when the desktop tree shifts.
- **Allowing `apps/web` to read `contract/`** — rejected. A static marketing site
  has no use for the cross-app contract; this opens a door that is hard to close
  later.
- **A CI check that fails when a root lockfile appears** — rejected as the primary
  guard. CI runs after a commit, while the damage is local and has already
  happened by then. It catches the wrong thing at the wrong time.
- **Documentation only** — rejected. It is how the repo handles desktop → host and
  it works there, but this hazard is silent when violated, so it needs a mechanism
  as well as a sentence.

## Consequences

- A logo change means editing two places. Accepted, and cheaper than the coupling.
- `bun install` at the repo root now **fails loudly** instead of quietly poisoning
  the next cold compile. Use `bun run install:all`, which installs per package.
- Desktop's Turbopack root no longer depends on the absence of a root lockfile, so
  it is safe even if the guard is bypassed.
- Adding a fourth app is now cheap: the pattern is its own `package.json`, its own
  lockfile, no imports across packages, and a pinned root if it is a Next app.
- **Still unenforced:** nothing prevents a new relative-path import from
  `apps/web` into a sibling package. If that ever happens, revisit the ESLint
  option above rather than assuming discipline held.

## Amendment 2026-08-23 — one narrow exception, stated rather than smuggled

`apps/web/test/facts-match-source.test.ts` **reads files from `apps/desktop`** by
path, at test time. That is not an import — no module resolution, no bundling,
nothing reaches `dist/` — but it is a coupling, and pretending otherwise would make
the rule above a half-truth.

It is allowed, narrowly, because of what it buys. The site's credibility rests on
numbers taken from the product's source (`32` concurrent PTY sessions, `46` MCP
tools, which runners are real). Numbers transcribed by hand drift, and that already
happened twice while drafting this site: a runner count taken from a repo-wide grep
instead of the canonical registry, and an MCP tool count citing an ambiguous path
when two sidecars exist with different surfaces. Both were caught by luck. The test
catches them by construction, and it also guards two entries on the
forbidden-claims list — it fails if Gemini or Cursor ever become real agent runners,
and if the bundle targets grow past macOS.

The terms of the exception:

- **read-only, test-only, never shipped.** If it ever influences `dist/`, it has
  stopped being this exception and needs its own decision.
- **Failing loudly is the feature.** If desktop moves `pty.rs`, this test fails and
  says to re-derive the claim. That is the intended behaviour, not collateral damage.
- **It does not survive a repo split.** If `apps/web` moves to its own repo, the
  numbers must either be generated at build time from a published artifact or
  dropped from the copy. Do not let the test rot into a skip.

Also decided here: `web:test` **is** part of `test:all`. The earlier reasoning for
excluding it — "a static waitlist site has no test suite" — stopped being true the
moment this test existed.

### The exception now covers `tools/` too, on the same terms

The same test also reads `tools/remotion-lotus-hero/src/theme.ts`, to check that the
demo CTA's stated duration matches the composition's actual length. It is here for the
same reason and under the same terms: that exact claim had already drifted — the copy
said "90-second demo" while the rendered cut was 42 s, because the label was written
before the video existed.

Widening a stated exception is cheap; the thing to avoid is widening it silently. So
the boundary is drawn where the argument actually holds: **`apps/web` may read any file
in this repo at test time to verify a claim it makes, and may import from nothing.**
That is one rule instead of a growing list of blessed paths, and it stays honest
because it constrains the mechanism (read, at test time, to verify) rather than the
directory.
