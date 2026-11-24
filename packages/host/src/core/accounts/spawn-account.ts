import { DEFAULT_ACCOUNT, type Account } from "./types.js";

/** A Claude cell's `CLAUDE_CONFIG_DIR`: a dir to set, `null` to unset (`default`), `undefined` to leave alone. */
export type SpawnConfigDir = string | null | undefined;

export class UnknownSpawnAccountError extends Error {}

/**
 * The account a spawn names, else the host's chosen one. Unknown is refused, never run on the
 * ambient account: a cell on the wrong account works, as somebody else, and reads as an expired session.
 */
export function spawnConfigDir(named: string | undefined, accounts: readonly Account[], hostDefault: string | undefined): SpawnConfigDir {
  const id = named ?? hostDefault;
  if (id === undefined) return undefined;
  if (id === DEFAULT_ACCOUNT) return null;
  const account = accounts.find((a) => a.id === id);
  if (account === undefined) {
    throw new UnknownSpawnAccountError(`no account named "${id}" — this host has ${accounts.map((a) => a.id).join(", ")}`);
  }
  return account.dir;
}
