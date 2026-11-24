// A Tauri GUI app starts with a minimal PATH, so `claude` (and `codex`) is looked up in its usual install
// locations too. LOTUS_CLAUDE_PATH wins when set.

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

export interface ResolveClaudeArgs {
  env: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  isExecutable?: (path: string) => boolean;
}

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function claudeCandidatePaths(
  env: Record<string, string | undefined>,
  home: string,
  name = "claude",
  platform: NodeJS.Platform = process.platform,
): string[] {
  const windows = platform === "win32";
  const { delimiter, join } = windows ? win32 : posix;
  // Windows has no exec bit: the native installer ships claude.exe, npm ships a .cmd shim.
  const names = windows ? [name + ".exe", name + ".cmd"] : [name];
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    ...(windows ? [join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm")] : ["/opt/homebrew/bin", "/usr/local/bin"]),
    join(home, ".bun", "bin"),
    join(home, ".npm-global", "bin"),
  ];
  return dirs.flatMap((dir) => names.map((n) => join(dir, n)));
}

export function resolveClaudeExecutable(args: ResolveClaudeArgs): string | null {
  const isExecutable = args.isExecutable ?? defaultIsExecutable;
  const override = args.env.LOTUS_CLAUDE_PATH?.trim();
  if (override) return isExecutable(override) ? override : null;
  const home = args.home ?? homedir();
  return claudeCandidatePaths(args.env, home, "claude", args.platform).find(isExecutable) ?? null;
}

/** `codex` the same way; LOTUS_CODEX_PATH wins when set (#286). */
export function resolveCodexExecutable(args: ResolveClaudeArgs): string | null {
  const isExecutable = args.isExecutable ?? defaultIsExecutable;
  const override = args.env.LOTUS_CODEX_PATH?.trim();
  if (override) return isExecutable(override) ? override : null;
  return claudeCandidatePaths(args.env, args.home ?? homedir(), "codex", args.platform).find(isExecutable) ?? null;
}

/** An ACP agent's binary the same way; `LOTUS_<BINARY>_PATH` wins when set (`agy` → LOTUS_AGY_PATH). */
export function resolveAgentExecutable(binary: string, args: ResolveClaudeArgs): string | null {
  const isExecutable = args.isExecutable ?? defaultIsExecutable;
  const override = args.env[`LOTUS_${binary.toUpperCase().replace(/-/g, "_")}_PATH`]?.trim();
  if (override) return isExecutable(override) ? override : null;
  return claudeCandidatePaths(args.env, args.home ?? homedir(), binary, args.platform).find(isExecutable) ?? null;
}
