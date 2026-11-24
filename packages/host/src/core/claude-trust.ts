import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteSync } from "./atomic-write.js";

/**
 * Grants Claude Code's workspace trust for a folder Lotus is about to start an agent in.
 *
 * **Why this is needed at all.** `claude` asks *"Is this a project you created or one you
 * trust?"* the first time it runs interactively in a folder, and the CLI's own help says the
 * dialog is *skipped* in non-interactive mode (`-p`). So a headless cell runs and a **terminal**
 * cell stops dead — and it stops in a way the phone cannot see or answer:
 *
 * - The permission route only reports a question once a **hook** said `needs-input`
 *   (`hooks/turns.ts`), and the trust gate fires no hook: it predates the pipeline.
 * - Even with that gate lifted, the dialog is an **arrow-selected list** (`❯ No, exit` /
 *   `Yes, I trust this folder`), while the prompt reader requires a numbered run answered by
 *   digit (ADR-8). Its default is *No, exit*, so a blind Enter from a phone kills the agent.
 *
 * On a VPS, where the phone is the only surface, that is a dead end. Measured 2026-09-07 on a
 * real device: the cell sat at the trust prompt and Chat said "steps land here as they happen".
 *
 * **Why it is defensible.** The folder is one the operator registered with Lotus as a project;
 * this records the decision they already made where the CLI looks for it. It is deliberately
 * the *only* thing written, and only for the path the caller names — the standalone spawn route
 * resolves that path from the project registry, never from client input.
 *
 * **The residual risk, stated.** `.claude.json` is the CLI's own live config and it rewrites it
 * constantly, so a read-modify-write can lose a concurrent change. Two things narrow the window
 * to near nothing: nothing is written when trust is already granted (the common case after the
 * first spawn), and the write goes through {@link atomicWriteSync} so the file is never torn.
 * A profile with no config yet is left alone entirely rather than invented.
 */
export type TrustOutcome =
  /** Trust was already recorded. Nothing was written. */
  | "already-trusted"
  /** This call recorded it. */
  | "granted"
  /** The profile has no `.claude.json` yet; the CLI will make one and ask once. */
  | "no-config"
  /** Unreadable or unwritable. The cell still starts, and the operator answers in the terminal. */
  | "failed";

/** The one key that decides the dialog. Verified against the binary: no other trust key exists. */
const TRUST_KEY = "hasTrustDialogAccepted";

export interface TrustRequest {
  /** The profile's config dir — `~/.claude`, or a ccs account's instance directory. */
  configDir: string;
  /** Where the agent will run. */
  cwd: string;
}

export function trustProjectFolder(req: TrustRequest): TrustOutcome {
  const configPath = join(req.configDir, ".claude.json");
  if (!existsSync(configPath)) return "no-config";
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "failed";
    const config = parsed as Record<string, unknown>;
    const projects = isRecord(config["projects"]) ? config["projects"] : {};
    const key = projectKey(req.cwd);
    const entry = isRecord(projects[key]) ? projects[key] : {};

    if (entry[TRUST_KEY] === true) return "already-trusted";

    config["projects"] = { ...projects, [key]: { ...entry, [TRUST_KEY]: true } };
    atomicWriteSync(configPath, config);
    return "granted";
  } catch {
    return "failed";
  }
}

/**
 * The config dir an agent started from this environment will read.
 *
 * Empty reads as unset, which is the same guard `shell_env.rs` needs and for the same reason: a
 * shell that exports the variable blank would otherwise hand every spawn a directory with no
 * credentials in it, and that reads as an expired session rather than as a mistake.
 */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env["CLAUDE_CONFIG_DIR"]?.trim();
  return explicit === undefined || explicit === "" ? join(home, ".claude") : explicit;
}

/**
 * The path the CLI keys a project by.
 *
 * Resolved through symlinks, because that is what the CLI records: on macOS a folder under
 * `/tmp` is stored as `/private/tmp/…`, and an entry written under the unresolved path is one
 * the CLI never reads — the dialog would appear anyway, with nothing to show why.
 */
function projectKey(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
