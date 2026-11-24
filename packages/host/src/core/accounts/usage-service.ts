import { claudeUsage, RATE_LIMITED, type ClaudeUsageDeps } from "./claude-usage.js";
import { codexUsage } from "./codex-usage.js";
import { identityOf } from "./discovery.js";
import { NOT_SIGNED_IN } from "./credentials.js";
import { DEFAULT_ACCOUNT, type Account, type UsageAccount } from "./types.js";

const CACHE_MS = 5 * 60_000;
/** An error is retried sooner: a re-login or a passing 429 should not stick for 5 min. */
const ERROR_CACHE_MS = 60_000;

export interface UsageServiceDeps {
  claudeAccounts: () => Account[];
  codexAccounts: () => Account[];
  /** The chosen Claude account id, if any. */
  chosen: () => string | undefined;
  claude: ClaudeUsageDeps;
}

/** Every account's subscription limits on this machine, cached and asked one snapshot at a time. */
export class UsageService {
  private readonly cache = new Map<string, { at: number; row: UsageAccount }>();
  private inflight: Promise<UsageAccount[]> | undefined;

  constructor(private readonly deps: UsageServiceDeps) {}

  /** Concurrent callers share one run: parallel requests per account come back 429. */
  snapshot(): Promise<UsageAccount[]> {
    this.inflight ??= this.build().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }

  private async build(): Promise<UsageAccount[]> {
    const inUse = this.deps.chosen() ?? DEFAULT_ACCOUNT;
    const out: UsageAccount[] = [];
    for (const account of this.deps.claudeAccounts()) {
      const row = { ...(await this.claudeRow(account)), inUse: account.id === inUse };
      // A `default` login that was never signed in is noise on a machine that only uses ccs.
      if (row.account === DEFAULT_ACCOUNT && !row.inUse && row.error === NOT_SIGNED_IN) continue;
      out.push(row);
    }
    for (const account of this.deps.codexAccounts()) {
      const row = codexUsage(account, this.deps.claude.now());
      if (row !== null) out.push(row);
    }
    return out;
  }

  private async claudeRow(account: Account): Promise<UsageAccount> {
    const now = this.deps.claude.now();
    const cached = this.cache.get(account.id);
    if (cached !== undefined && now - cached.at < (cached.row.error === null ? CACHE_MS : ERROR_CACHE_MS)) {
      return cached.row;
    }
    let row = await claudeUsage(account, this.deps.claude);
    const identity = identityOf(account);
    if (identity !== null) row = { ...row, identity };
    // A 429 keeps showing the last good numbers.
    if (row.error === RATE_LIMITED && cached !== undefined && cached.row.error === null) {
      row = { ...cached.row, error: row.error };
    }
    this.cache.set(account.id, { at: now, row });
    return row;
  }
}
