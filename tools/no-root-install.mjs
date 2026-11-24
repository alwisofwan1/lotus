/**
 * Refuse `bun install` (or npm/yarn/pnpm install) at the repo root.
 *
 * Wired as the root `preinstall` script. The root package.json is pass-through
 * only — it has no dependencies of its own, and installing here would create a
 * root lockfile.
 *
 * Why a root lockfile is harmful, specifically:
 *
 *   Next infers its Turbopack / output-tracing root by walking *ancestor*
 *   directories for a lockfile and taking the highest one it finds. A lockfile at
 *   the repo root therefore moves every Next app's inferred root up to the repo
 *   root, pulling `apps/pocket/`, `packages/host/` and `**\/src-tauri/target/`
 *   into resolve + watch scope. The symptom does not appear until a cold compile,
 *   which makes it one of the most expensive failure classes in this repo (see the
 *   Turbopack and Cargo cache traps documented in CLAUDE.md).
 *
 * `apps/desktop/next.config.ts` now pins `turbopack.root` explicitly, so desktop
 * is protected regardless. This guard exists for the *next* Next app — and to keep
 * the invariant stated out loud rather than surviving by accident.
 *
 * Install per package instead: `bun run install:all`.
 *
 * See docs/adr/0011-apps-web-isolation-and-turbopack-root.md
 */

// Only colourise when stderr is a TTY — otherwise CI logs fill with escape codes.
const tty = Boolean(process.stderr.isTTY);
const BOLD = tty ? "[1m" : "";
const DIM = tty ? "[2m" : "";
const RESET = tty ? "[0m" : "";

const lines = [
  "",
  `${BOLD}Refusing to install at the repo root.${RESET}`,
  "",
  "The root package.json is pass-through only — it has no dependencies. Installing",
  "here would create a root lockfile, and Next resolves its Turbopack root by taking",
  "the highest lockfile in the ancestor chain. That would pull apps/pocket,",
  "packages/host and src-tauri/target into Turbopack's resolve and watch scope.",
  "",
  "The failure is invisible until a cold compile, so it costs hours, not minutes.",
  "",
  `${BOLD}Install per package instead:${RESET}`,
  "",
  "    bun run install:all",
  "",
  `${DIM}Or cd into the one package you meant: apps/desktop, packages/host, apps/web.${RESET}`,
  `${DIM}Background: docs/adr/0011-apps-web-isolation-and-turbopack-root.md${RESET}`,
  "",
];

process.stderr.write(`${lines.join("\n")}\n`);
process.exit(1);
