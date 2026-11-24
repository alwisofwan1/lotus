import { homedir } from "node:os";

import { accountPaths, claudeAccountsIn } from "../../../../../core/accounts/index.js";

/**
 * Which Claude accounts this machine can run a cell under, as directories the CLI accepts
 * through `CLAUDE_CONFIG_DIR`. A thin view over `core/accounts` discovery, so the phone's picker
 * and `/v1/usage` list the same accounts.
 *
 * **Account selection, not pooling:** one cell runs under one profile, chosen deliberately.
 * Getting it wrong reads as an expired session, not an error, because Claude's OAuth is keyed
 * per config dir in the keychain. Discovery is by directory shape; no credential is opened.
 */
export interface ClaudeProfile {
  /** What a spawn names. `default` is the CLI's own `~/.claude`. */
  id: string;
  /** What the operator reads; the same as `id`. */
  label: string;
  /** What `CLAUDE_CONFIG_DIR` is set to for a cell on this profile. */
  configDir: string;
}

export const DEFAULT_PROFILE_ID = "default";

export interface ProfileLookupOptions {
  home?: string;
  /** Lotus state dir (`accounts/claude/*`); defaults to the host's own. */
  stateDir?: string;
  /** Extra config dirs, as `CLAUDE_CONFIG_DIR` would name them; defaults to the host's own env. */
  envDirs?: string[];
}

/** Every profile a cell may be started under, `default` first and the rest by id (a stable picker order). */
export function claudeProfiles(opts: ProfileLookupOptions = {}): ClaudeProfile[] {
  // An explicit home is a test (or a tool) naming a whole machine: the real env must not leak in.
  const paths = accountPaths(opts.home === undefined ? process.env : {}, opts.home ?? homedir());
  return claudeAccountsIn(paths.home, opts.stateDir ?? paths.stateDir, opts.envDirs ?? paths.claudeEnvDirs)
    .map((a) => ({ id: a.id, label: a.id, configDir: a.dir }));
}

/** The config dir for one profile id, or `undefined` when this machine has no such profile. */
export function claudeConfigDir(
  profileId: string,
  opts: ProfileLookupOptions = {},
): string | undefined {
  return claudeProfiles(opts).find((p) => p.id === profileId)?.configDir;
}
