import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Whether a binary can be spawned.
 *
 * In `core/` because both layers need it and neither may import the other: the mobile
 * adapter asks it to decide which bridges to offer, and the standalone server asks it to
 * decide which runners to advertise. It was in `adapters/mobile/structured/bridges/` until
 * the server needed it too, and importing that from `server/` would have inverted the
 * dependency this package is arranged around (`adapters` → `core` → `types`).
 */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exe = process.platform === "win32" ? `${command}.exe` : command;
  return (env["PATH"] ?? "").split(delimiter).some((dir) => dir !== "" && existsSync(join(dir, exe)));
}
