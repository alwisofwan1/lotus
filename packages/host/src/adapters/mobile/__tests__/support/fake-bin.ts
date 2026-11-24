import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A directory holding stub executables, for a `PATH` a test controls.
 *
 * Which runners a host offers is read from the real filesystem (`bridges/on-path.ts`), which
 * is right in production and machine-dependent in a test: a suite that asks "does this host
 * offer Codex?" would answer differently on a laptop with `codex` installed and on CI without
 * it. Handing the registry a `PATH` of our own keeps the probe real and the answer fixed.
 */
export function fakeBinDir(parent: string, commands: readonly string[]): string {
  const bin = join(parent, "bin");
  mkdirSync(bin, { recursive: true });
  for (const command of commands) {
    const path = join(bin, command);
    writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(path, 0o755);
  }
  return bin;
}
