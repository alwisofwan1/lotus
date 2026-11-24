// Argv + stdin parsing for the agent-notify hook script. Pure functions —
// no filesystem, no process state — so the unit tests can assert behaviour
// without spawning a subprocess.

import fs from "node:fs";

/**
 * Parse `--key value` and `--flag` style arguments. Last value wins on repeat.
 * Positional args (no `--` prefix) are silently dropped — hooks always pass
 * structured flags.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== "string" || !token.startsWith("--")) continue;
    const key = token.slice(2);
    if (!key) continue;
    const next = argv[i + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

/**
 * Read all of stdin synchronously. Returns "" when stdin is a TTY (interactive
 * shell — no payload piped). On Windows, defends against a parent that forgets
 * to close stdin by gating on `fstat`. On Unix the kernel always EOFs piped
 * stdin so the plain read is safe.
 *
 * @returns {string}
 */
export function readStdinSync() {
  if (process.stdin.isTTY) return "";
  if (process.platform === "win32") {
    try {
      const stat = fs.fstatSync(0);
      if (!stat || (!stat.isFIFO() && !stat.isFile())) return "";
      if (typeof stat.size === "number" && stat.size === 0 && stat.isFile()) {
        return "";
      }
    } catch {
      return "";
    }
  }
  try {
    const buf = fs.readFileSync(0, "utf8");
    return typeof buf === "string" ? buf : "";
  } catch {
    return "";
  }
}
