import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { DEFAULT_ACCOUNT, type Account, type AccountSource, type Identity } from "./types.js";

const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

const real = (p: string): string => {
  try { return realpathSync(p); } catch { return p; }
};

/** Adds `dir` under its folder name, or `<prefix>-<name>` on a clash; a dir already listed adds nothing. */
function push(out: Account[], source: AccountSource, prefix: string, dir: string, configFile: string): void {
  if (out.some((a) => a.dir === dir || real(a.dir) === real(dir))) return;
  const name = basename(dir);
  out.push({ id: out.some((a) => a.id === name) ? `${prefix}-${name}` : name, source, dir, configFile });
}

/** `default` first, the rest by id. */
function sorted(accounts: Account[]): Account[] {
  return accounts.sort((a, b) => {
    if ((a.id === DEFAULT_ACCOUNT) !== (b.id === DEFAULT_ACCOUNT)) return a.id === DEFAULT_ACCOUNT ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function subdirs(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => join(root, e.name))
      .sort();
  } catch {
    return [];
  }
}

/** Every Claude login on this machine; reads directory shape only, never a secret. */
export function claudeAccountsIn(home: string, stateDir: string, envDirs: readonly string[]): Account[] {
  const out: Account[] = [
    { id: DEFAULT_ACCOUNT, source: "default", dir: join(home, ".claude"), configFile: join(home, ".claude.json") },
  ];
  const roots: [AccountSource, string, string][] = [
    ["ccs", "ccs", join(home, ".ccs", "instances")],
    ["lotus", "lotus", join(stateDir, "accounts", "claude")],
  ];
  for (const [source, prefix, root] of roots) {
    for (const dir of subdirs(root)) {
      // A Lotus folder is an account from the moment it is made, so it can show "Sign in".
      if (existsSync(join(dir, ".claude.json")) || (source === "lotus" && isDir(dir))) {
        push(out, source, prefix, dir, join(dir, ".claude.json"));
      }
    }
  }
  for (const dir of envDirs.filter(isDir)) push(out, "env", "env", dir, join(dir, ".claude.json"));
  return sorted(out);
}

/** Every Codex login: `~/.codex` plus a `CODEX_HOME` elsewhere. */
export function codexAccountsIn(home: string, envDirs: readonly string[]): Account[] {
  const out: Account[] = [
    { id: DEFAULT_ACCOUNT, source: "default", dir: join(home, ".codex"), configFile: join(home, ".codex", "config.toml") },
  ];
  for (const dir of envDirs.filter(isDir)) push(out, "env", "env", dir, join(dir, "config.toml"));
  return sorted(out);
}

/** Who a Claude account is signed in as, from its state file's `oauthAccount`; null = not signed in. */
export function identityOf(account: Account): Identity | null {
  try {
    const json: unknown = JSON.parse(readFileSync(account.configFile, "utf8"));
    const oauth = (json as { oauthAccount?: { emailAddress?: unknown; organizationName?: unknown } }).oauthAccount;
    if (typeof oauth?.emailAddress !== "string") return null;
    return { email: oauth.emailAddress, org: typeof oauth.organizationName === "string" ? oauth.organizationName : null };
  } catch {
    return null;
  }
}
