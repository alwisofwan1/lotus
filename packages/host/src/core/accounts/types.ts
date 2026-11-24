/** Where discovery found an account; mirrors `accounts.rs` in the desktop. */
export type AccountSource = "default" | "env" | "ccs" | "lotus";

export interface Account {
  /** `default`, else the folder name; a clash becomes `ccs-` / `lotus-` / `env-<name>`. */
  id: string;
  source: AccountSource;
  dir: string;
  /** `~/.claude.json` for the default Claude account, `<dir>/.claude.json` otherwise. */
  configFile: string;
}

export interface Identity {
  email: string;
  org: string | null;
}

/** One limit window, exactly as the desktop's `UsageWindow` serialises. */
export interface UsageWindow {
  kind: string;
  group: "session" | "weekly";
  usedPercent: number;
  resetsAtMs: number | null;
  windowMinutes: number;
  scope?: string;
}

/** One row of `/v1/usage`, exactly as the desktop's `UsageAccount` serialises. */
export interface UsageAccount {
  provider: "claude" | "codex";
  account: string;
  plan: string | null;
  inUse: boolean;
  windows: UsageWindow[];
  error: string | null;
  asOfMs: number | null;
  identity?: Identity;
}

export const DEFAULT_ACCOUNT = "default";
