import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteSync } from "./atomic-write.js";

/** Grant trust only for registered projects because remote permission handling cannot answer the CLI trust prompt (ADR-8). */
// Atomic replacement prevents torn config but can still race a concurrent CLI write.
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

/** Treat an empty config override as unset so the CLI can still find its credentials. */
export function resolveClaudeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const explicit = env["CLAUDE_CONFIG_DIR"]?.trim();
  return explicit === undefined || explicit === "" ? join(home, ".claude") : explicit;
}

/** Resolve symlinks to match the path the CLI uses for workspace trust. */
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
