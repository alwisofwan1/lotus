import type {
  ProviderBridgeFactory,
  ProviderBridgeSession,
  ProviderBridgeSpawn,
} from "../../../../../types/provider-bridge.js";
import { onPath } from "../on-path.js";
import { claudeConfigDir, claudeProfiles, type ClaudeProfile } from "./profiles.js";
import { ClaudeStreamSession, type ClaudeSessionOptions } from "./session.js";

export { claudeProfiles, type ClaudeProfile };

/** Swappable so a test never spawns a binary. */
export type CreateClaudeSession = (opts: ClaudeSessionOptions) => ProviderBridgeSession;

/**
 * Claude's own scale, as `--permission-mode` takes it, mapped from the stop the phone sends.
 *
 * The two legacy words keep the meaning they had before the scale existed. An unrecognised
 * mode lands on `manual` rather than being refused — the safe reading of an unknown posture
 * is *ask*, the same rule `codexPosture` follows.
 */
export function claudePermissionMode(mode: string | undefined): string {
  switch (mode) {
    case "plan":
    case "read-only":
      return "plan";
    case "acceptEdits":
      return "acceptEdits";
    case "bypassPermissions":
    case "full-access":
    case "yolo":
      return "bypassPermissions";
    default:
      return "manual";
  }
}

/**
 * Claude as a [`ProviderBridgeFactory`] — the runner where a terminal is the product, so
 * this is the **second** mode rather than a replacement for the cell TUI.
 *
 * `gating` follows the mode, because since Fase 3b there is a real control behind it: the
 * session starts an MCP approval tool beside the runner, and `--permission-prompt-tool`
 * makes the runner **wait** for the operator. `bypassPermissions` is the one stop that can
 * never ask, so it alone reports `skipped`.
 */
export function claudeBridge(createSession?: CreateClaudeSession, readableDir?: string): ProviderBridgeFactory {
  const create = createSession ?? ((o: ClaudeSessionOptions) => new ClaudeStreamSession(o));
  return {
    agentType: "claude",
    runnerLabel: "Claude Code",
    available: (env) => onPath("claude", env),
    gating: (mode) => (claudePermissionMode(mode) === "bypassPermissions" ? "skipped" : "asks"),
    posture: claudePermissionMode,
    create: (spawn: ProviderBridgeSpawn) =>
      create({
        paneId: spawn.paneId,
        cwd: spawn.cwd,
        permissionMode: claudePermissionMode(spawn.permissionMode),
        ...(spawn.model === undefined ? {} : { model: spawn.model }),
        ...(spawn.effort === undefined ? {} : { effort: spawn.effort }),
        ...(spawn.profileId === undefined ? {} : { configDir: resolveProfile(spawn.profileId) }),
        ...(spawn.resume === undefined ? {} : { resumeSessionId: spawn.resume }),
        ...(readableDir === undefined ? {} : { readableDir }),
      }),
  };
}

/**
 * The config dir for a named profile, or a refusal.
 *
 * Refusing rather than falling back to the ambient account is the whole point: a cell started
 * on the wrong profile does not fail, it works — as somebody else, against another keychain
 * entry, and the operator reads the mismatch as an expired session. The route validates the
 * id against the advertised list first, so a client that read `bootstrap` never lands here.
 */
function resolveProfile(profileId: string): string {
  const configDir = claudeConfigDir(profileId);
  if (configDir === undefined) {
    const known = claudeProfiles().map((p) => p.id);
    throw new Error(
      known.length === 0
        ? `no Claude profile named "${profileId}" on this machine, and none were found`
        : `no Claude profile named "${profileId}" — this machine has ${known.join(", ")}`,
    );
  }
  return configDir;
}
