import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

import { createLogger } from "../logger.js";
import { resolveStateDir } from "../state-dir.js";
import { AccountBook } from "./account-book.js";
import { CcsMigration } from "./ccs-migration.js";
import { LastKnownStore, type FetchLike } from "./claude-usage.js";
import { DefaultAccountStore } from "./default-account.js";
import { claudeAccountsIn, codexAccountsIn } from "./discovery.js";
import type { CredentialDeps } from "./credentials.js";
import type { Account } from "./types.js";
import { UsageService } from "./usage-service.js";

export { CcsMigration, type CcsPlan, type McpEntry } from "./ccs-migration.js";
export { AccountBook, InvalidAccountError, type AccountView } from "./account-book.js";
export { DefaultAccountStore, UnknownAccountError } from "./default-account.js";
export { claudeAccountsIn, codexAccountsIn, identityOf } from "./discovery.js";
export { UsageService } from "./usage-service.js";
export { spawnConfigDir, UnknownSpawnAccountError, type SpawnConfigDir } from "./spawn-account.js";
export * from "./types.js";

/** Where this host looks for accounts; read from the environment once, at the boundary. */
export interface AccountPaths {
  home: string;
  stateDir: string;
  claudeEnvDirs: string[];
  codexEnvDirs: string[];
}

const log = createLogger();

const nonEmpty = (v: string | undefined): string[] => (v !== undefined && v.trim() !== "" ? [v] : []);

export function accountPaths(env: Record<string, string | undefined>, home: string): AccountPaths {
  return {
    home,
    stateDir: resolveStateDir(env, home),
    claudeEnvDirs: nonEmpty(env["CLAUDE_CONFIG_DIR"]),
    codexEnvDirs: nonEmpty(env["CODEX_HOME"]),
  };
}

export const processAccountPaths = (): AccountPaths => accountPaths(process.env, homedir());

export const claudeAccountsOf = (p: AccountPaths): Account[] => claudeAccountsIn(p.home, p.stateDir, p.claudeEnvDirs);

const realExec: CredentialDeps["exec"] = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, (err, stdout) => {
      resolve({ code: err === null ? 0 : typeof err.code === "number" ? err.code : 1, stdout });
    });
  });

const realFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, json: () => res.json() };
};

export interface AccountServices {
  /** Every Claude account this host has, discovered afresh per call. */
  claudeAccounts: () => Account[];
  book: AccountBook;
  defaults: DefaultAccountStore;
  usage: UsageService;
  /** Moving this host off ccs (plans/portable-accounts/issues/08). */
  ccs: CcsMigration;
}

/** The host's real accounts, default choice and usage, wired from `paths`. */
export function createAccountServices(paths: AccountPaths, os: { platform?: string } = {}): AccountServices {
  const claudeAccounts = (): Account[] => claudeAccountsOf(paths);
  const defaults = new DefaultAccountStore(join(paths.stateDir, "accounts.json"), claudeAccounts);
  const creds = { platform: os.platform ?? platform(), exec: realExec, readFile: (p: string) => readFile(p, "utf8") };
  const book = new AccountBook({
    stateDir: paths.stateDir,
    sharedDir: join(paths.home, ".claude"),
    warn: (message) => log.warn("accounts.link_failed", { message }),
    claudeAccounts, chosen: () => defaults.get(), creds });
  const usage = new UsageService({
    claudeAccounts,
    codexAccounts: () => codexAccountsIn(paths.home, paths.codexEnvDirs),
    chosen: () => defaults.get(),
    claude: {
      creds,
      fetch: realFetch,
      now: () => Date.now(),
      lastKnown: new LastKnownStore(join(paths.stateDir, "claude-usage-last.json")),
    },
  });
  const ccs = new CcsMigration({
    home: paths.home,
    stateDir: paths.stateDir,
    today: () => new Date().toISOString().slice(0, 10),
    hasDefault: () => defaults.get() !== undefined,
    setDefault: (id) => defaults.set(id),
  });
  return { claudeAccounts, book, defaults, usage, ccs };
}

/** The host's chosen Claude account id, or undefined; for spawns that name no account. */
export function hostDefaultAccount(): string | undefined {
  return createAccountServices(processAccountPaths()).defaults.get();
}
