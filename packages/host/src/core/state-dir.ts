import { isAbsolute, join } from "node:path";

/** Where the desktop keeps its state when the parent did not say. */
const DEFAULT_DIR_NAME = ".lotus";

/** Env var Rust sets at spawn so the child inherits the parent's profile choice. */
export const STATE_DIR_ENV = "LOTUS_STATE_DIR";

/** Prefers Rust's dir: it knows dev (`~/.lotus-dev`) from release, this process cannot. */
export function resolveStateDir(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const raw = env[STATE_DIR_ENV]?.trim();
  // Relative is rejected, not resolved: a spawned child's cwd is whatever the
  // parent happened to have, and credentials must not land somewhere that moves.
  if (raw !== undefined && raw.length > 0 && isAbsolute(raw)) return raw;
  return join(home, DEFAULT_DIR_NAME);
}
