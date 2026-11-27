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
 * The phone's stop mapped to `--permission-mode`. Legacy words keep their old meaning; an
 * unknown mode lands on `manual` (*ask*), as in `codexPosture`.
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
 * Claude as a [`ProviderBridgeFactory`], the **second** mode beside the cell TUI. `gating`
 * follows the mode: the runner **waits** for the operator; only `bypassPermissions` never
 * asks, so it alone is `skipped`.
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
 * The config dir for a named profile, or a refusal: never fall back to the ambient account, as
 * a wrong profile works as somebody else and reads as an expired session.
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
