import type { NextConfig } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

// Tauri sets TAURI_ENV_TARGET_TRIPLE during both `tauri dev` and `tauri build`.
// We only want static export during actual production builds (next build),
// not during dev (next dev). Use NODE_ENV to distinguish:
//   - tauri dev  → next dev  → NODE_ENV=development → no export (API routes work)
//   - tauri build → next build → NODE_ENV=production + TAURI_ENV → export
const isTauriBuild =
  !!process.env.TAURI_ENV_TARGET_TRIPLE &&
  process.env.NODE_ENV === "production";

/**
 * The production CSP (`src-tauri/tauri.conf.json`) as a REPORT-ONLY header for `next dev`.
 *
 * `tauri dev` loads the dev server directly, so Tauri never applies its CSP there, and a load the
 * release build blocks (a new CDN, iframe or loopback address) works in dev and breaks in the
 * release — the canvas music player did, 2026-10-15. Report-only blocks nothing; the violation
 * events still fire, and `csp-violation-log.ts` writes them to `~/.lotus-dev/csp-violations.log`.
 * Only what dev itself needs is added: eval and inline scripts for React Refresh, and the HMR socket.
 */
export function devReportOnlyCsp(csp: string): string {
  return csp
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      if (directive.startsWith("script-src ")) return `${directive} 'unsafe-eval' 'unsafe-inline'`;
      if (directive.startsWith("connect-src ")) return `${directive} ws://localhost:* http://localhost:*`;
      return directive;
    })
    .join("; ");
}

function readTauriCsp(): string | null {
  try {
    const config = JSON.parse(readFileSync(path.join(__dirname, "src-tauri/tauri.conf.json"), "utf8"));
    return typeof config?.app?.security?.csp === "string" ? config.app.security.csp : null;
  } catch {
    return null;
  }
}

const tauriCsp = readTauriCsp();

const nextConfig: NextConfig = {
  output: isTauriBuild ? "export" : undefined,
  serverExternalPackages: ["@tauri-apps/api"],
  // A static export has no server to send headers; the release build gets the CSP from Tauri.
  ...(isTauriBuild || !tauriCsp
    ? {}
    : {
        async headers() {
          return [{ source: "/:path*", headers: [{ key: "Content-Security-Policy-Report-Only", value: devReportOnlyCsp(tauriCsp) }] }];
        },
      }),
  turbopack: {
    // Pin the Turbopack root to this package, do NOT let Next infer it.
    //
    // Next infers the root by walking *ancestor* directories for a lockfile and
    // taking the highest one it finds. Today the repo has no root lockfile, so the
    // inferred root is already `apps/desktop` — but that is an accident of the
    // current tree, not a guarantee. A single `bun install` at the repo root would
    // move the inferred root up, pulling `apps/pocket/`, `packages/host/` and
    // `**/src-tauri/target/` into Turbopack's resolve + watch scope. That failure
    // is invisible until a cold compile (see the cache traps in CLAUDE.md), which
    // makes it one of the most expensive classes to diagnose here.
    //
    // Pinning it costs nothing and removes the whole question. See
    // docs/adr/0011-apps-web-isolation-and-turbopack-root.md
    root: __dirname,
  },
  // In Tauri production builds, exclude .server.ts API routes from static export.
  // During dev, all extensions are active so API routes work for both
  // browser mode and tauri dev mode.
  pageExtensions: isTauriBuild
    ? ["js", "jsx", "ts", "tsx"]
    : ["js", "jsx", "ts", "tsx", "server.ts", "server.tsx"],
};

export default nextConfig;
