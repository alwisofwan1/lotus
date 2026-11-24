import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { isIsolated, keepLinks, markIsolated } from "./context-links.js";
import { readCredentials, type CredentialDeps } from "./credentials.js";
import { identityOf } from "./discovery.js";
import { DEFAULT_ACCOUNT, type Account, type AccountSource, type Identity } from "./types.js";

/** A name or request the operator can fix; the message is shown as-is. */
export class InvalidAccountError extends Error {}

/** One row of an account list, exactly as the desktop's `AccountView` serialises. */
export interface AccountView {
  id: string;
  source: AccountSource;
  dir: string;
  /** Who it is signed in as; null when the dir holds no Claude login (a leftover state file counts as none). */
  identity: Identity | null;
  inUse: boolean;
  loginCommand: string;
  /** `shared` or `isolated` for a Lotus-made account; the others are not Lotus's to link. */
  context: "shared" | "isolated" | null;
}

export interface AccountBookDeps {
  stateDir: string;
  /** `~/.claude`: what a Shared account's config and context link to. */
  sharedDir: string;
  /** A link that could not be kept costs only that account's shared context. */
  warn: (message: string) => void;
  claudeAccounts: () => Account[];
  chosen: () => string | undefined;
  creds: CredentialDeps;
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** What a terminal runs to sign `account` in; mirrors `accounts::login_command` in the desktop. */
export function loginCommand(account: Account): string {
  if (account.id === DEFAULT_ACCOUNT) return "env -u CLAUDE_CONFIG_DIR claude auth login";
  return `CLAUDE_CONFIG_DIR='${account.dir.replaceAll("'", `'\\''`)}' claude auth login`;
}

/** This machine's Claude accounts for an operator elsewhere: list them, and make a new one. */
export class AccountBook {
  constructor(private readonly deps: AccountBookDeps) {}

  async list(): Promise<AccountView[]> {
    const accounts = this.deps.claudeAccounts();
    for (const a of accounts.filter((x) => x.source === "lotus")) {
      try {
        keepLinks(this.deps.sharedDir, a.dir);
      } catch (err) {
        this.deps.warn(`could not link ${a.dir} to ${this.deps.sharedDir}: ${String(err)}`);
      }
    }
    return Promise.all(accounts.map((a) => this.view(a)));
  }

  /** A new, empty folder under `<stateDir>/accounts/claude/<name>`; signing in is the CLI's own. */
  async create(name: string, isolated = false): Promise<AccountView> {
    if (!NAME.test(name) || name === DEFAULT_ACCOUNT) {
      throw new InvalidAccountError("use lowercase letters, digits, - or _ (up to 32), starting with a letter or digit");
    }
    // A taken name would be listed as `lotus-<name>`, which reads as a different account.
    if (this.deps.claudeAccounts().some((a) => a.id === name)) throw new InvalidAccountError(`an account named ${name} already exists`);
    const dir = join(this.deps.stateDir, "accounts", "claude", name);
    mkdirSync(dir, { recursive: true });
    if (isolated) markIsolated(dir);
    else keepLinks(this.deps.sharedDir, dir);
    const made = this.deps.claudeAccounts().find((a) => a.dir === dir);
    if (made === undefined) throw new Error(`created ${dir}, but it is not listed`);
    return this.view(made);
  }

  /** Deletes a Lotus-made account's folder, and its login with it; links inside go, their targets stay. */
  remove(id: string): string {
    const account = this.deps.claudeAccounts().find((a) => a.id === id);
    if (account === undefined) throw new InvalidAccountError(`no account named ${id}`);
    if (account.source !== "lotus") throw new InvalidAccountError(`${id} was not made by Lotus; it stays`);
    // shortcut: a macOS host keeps the keychain item (Linux keeps the login in the folder); delete it there if hosts run on macOS.
    rmSync(account.dir, { recursive: true, force: true });
    return id;
  }

  private async view(account: Account): Promise<AccountView> {
    const chosen = this.deps.chosen() ?? DEFAULT_ACCOUNT;
    return {
      id: account.id,
      source: account.source,
      dir: account.dir,
      identity: (await this.hasLogin(account)) ? identityOf(account) : null,
      inUse: account.id === chosen,
      loginCommand: loginCommand(account),
      context: account.source === "lotus" ? (isIsolated(account.dir) ? "isolated" : "shared") : null,
    };
  }

  /** An expired login still counts: the CLI refreshes it on next use. */
  private async hasLogin(account: Account): Promise<boolean> {
    try {
      const creds = await readCredentials(account.dir, account.id === DEFAULT_ACCOUNT, this.deps.creds);
      return typeof creds === "object" && creds !== null && "claudeAiOauth" in creds;
    } catch {
      return false;
    }
  }
}
