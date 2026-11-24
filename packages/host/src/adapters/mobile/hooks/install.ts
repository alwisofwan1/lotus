import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { atomicWriteSync } from "../../../core/atomic-write.js";
import type { Logger } from "../../../core/logger.js";
import { buildClaudeHookScript, withClaudeHook } from "./hook-script.js";

/**
 * Puts the hook where Claude will find it: a script in this host's state dir, named in the
 * operator's global `~/.claude/settings.json`.
 *
 * Idempotent, and re-run on every start on purpose — that is how a fix to the script body ships
 * without the operator doing anything, and how a settings file somebody else edited gets the
 * entry back.
 */

/** Filename in the state dir. The name is shared between profiles; the path is not. */
export const HOOK_SCRIPT_NAME = "claude-agent-hook.sh";

export interface InstallHookOptions {
  /** This host's state dir — `~/.lotus`, or `~/.lotus-dev` for a dev profile. */
  stateDir: string;
  /** Where this host advertises its port and secret. */
  discoveryPath: string;
  /** Defaults to `~/.claude/settings.json`; injected by tests. */
  settingsPath?: string;
  logger?: Logger;
}

export interface InstalledHook {
  scriptPath: string;
  settingsPath: string;
}

/**
 * Writes the script and registers it. Returns what it wrote, or undefined when it could not.
 *
 * Failure is never fatal: hooks are one capability, and a host that refuses to boot because it
 * could not write a settings file is worse than one that starts without TUI permission and says
 * so through `hostCaps`.
 */
export function installClaudeHook(opts: InstallHookOptions): InstalledHook | undefined {
  const scriptPath = join(opts.stateDir, HOOK_SCRIPT_NAME);
  const settingsPath = opts.settingsPath ?? join(homedir(), ".claude", "settings.json");

  try {
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, buildClaudeHookScript({ discoveryPath: opts.discoveryPath }));
    // 0755: Claude executes it directly, not through an interpreter it chooses.
    chmodSync(scriptPath, 0o755);
  } catch (error) {
    opts.logger?.warn("hooks.script_unwritable", { path: scriptPath, error: String(error) });
    return undefined;
  }

  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (typeof settings !== "object" || settings === null || Array.isArray(settings)) settings = {};
  } catch {
    // No file, or one that is not JSON. An absent file is the normal first-run case; a corrupt
    // one is NOT overwritten silently — see below.
    if (!isMissing(settingsPath)) {
      opts.logger?.warn("hooks.settings_unreadable", {
        path: settingsPath,
        detail: "left untouched — the file is the operator's, and rewriting one this host cannot read would destroy hooks it cannot see",
      });
      return undefined;
    }
  }

  try {
    mkdirSync(dirname(settingsPath), { recursive: true });
    atomicWriteSync(settingsPath, withClaudeHook(settings, scriptPath));
  } catch (error) {
    opts.logger?.warn("hooks.settings_unwritable", { path: settingsPath, error: String(error) });
    return undefined;
  }

  return { scriptPath, settingsPath };
}

/** Whether the file simply is not there, as opposed to being there and unreadable. */
function isMissing(path: string): boolean {
  try {
    readFileSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
