#!/usr/bin/env node
// Lotus agent-notify hook entry. Invoked by Claude Code / Codex / Cursor /
// OpenCode via their hook configurations. Reads stdin JSON + CLI flags,
// writes a v1 drop file under the dir the parent passed via `--drop-dir`
// (falling back to `~/.lotus/agent-hooks/global/`), exits 0 always.
//
// Hook contract: this script must NEVER fail the parent process. All errors
// are swallowed and we exit 0 so the agent CLI keeps running smoothly.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parseArgs, readStdinSync } from "./parse-args.mjs";
import { resolveDropDir } from "./drop-file.mjs";
import { runHook } from "./run-hook.mjs";

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const stdin = readStdinSync();
    const dropDir = resolveDropDir(args);
    const timestamp = Date.now();
    const randomSuffix = crypto.randomBytes(3).toString("hex");
    const pid = typeof process.pid === "number" ? process.pid : null;

    const result = runHook({
      argv: process.argv,
      args,
      stdin,
      env: process.env,
      dropDir,
      timestamp,
      randomSuffix,
      pid,
      cwd: safeCwd(),
    });

    recordDroppedEvent(result, dropDir, timestamp);
  } catch {
    // Silent — hook scripts must never fail the parent process.
  }
  process.exit(0);
}

/**
 * Fase 0 counter (`plans/session-history-hardening/issues/01`).
 *
 * `skipped-full` is the one outcome that loses a Chat event outright: past
 * `DROP_DIR_SOFT_CAP` the hook declines to write rather than block the agent, and
 * nothing anywhere records that it happened. So a gap in Chat caused by back-pressure
 * is today indistinguishable from an agent that simply did nothing — which is the
 * failure mode this whole plan exists to stop.
 *
 * Only this outcome is counted. `ok` is already evidenced by the drop file itself, and
 * logging every hook event from here would put a second file write on the path whose
 * cost is the reason the cap exists.
 *
 * @param {{outcome: string} | undefined} result
 * @param {string} dropDir
 * @param {number} timestamp
 */
function recordDroppedEvent(result, dropDir, timestamp) {
  if (result?.outcome !== "skipped-full") return;
  try {
    // The drop dir is `<state dir>/agent-hooks/global`, so the diagnostics dir is two
    // levels up. Derived rather than resolved independently: this script is installed
    // into both `~/.lotus` and `~/.lotus-dev`, and only the parent knows which — the
    // same reason `--drop-dir` is passed in at all.
    const stateDir = path.resolve(dropDir, "..", "..");
    const file = path.join(stateDir, "diagnostics", "session-history.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = JSON.stringify({
      at: timestamp,
      layer: "desktop",
      metric: "drop.skipped_full",
      value: 1,
      labels: {},
    });
    fs.appendFileSync(file, line + "\n");
  } catch {
    // A counter must never be the thing that breaks a hook.
  }
}

function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return "";
  }
}

main();
