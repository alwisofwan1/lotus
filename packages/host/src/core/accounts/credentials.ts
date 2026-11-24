import { createHash } from "node:crypto";
import { join } from "node:path";

/** A reason a usage row has no fresh numbers; the message is shown to the operator as-is. */
export class UsageError extends Error {}

export const NOT_SIGNED_IN = "not signed in";

export interface CredentialDeps {
  platform: string;
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  readFile: (path: string) => Promise<string>;
}

/**
 * Claude Code keeps one keychain item per config dir: `Claude Code-credentials-<sha256(dir)[..8]>`,
 * and the unsuffixed one when `CLAUDE_CONFIG_DIR` is unset. Only `default` may use the unsuffixed
 * item, or another account would show the default login's numbers under its own name.
 */
export function keychainServices(dir: string, isDefault: boolean): string[] {
  const suffixed = `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
  return isDefault ? ["Claude Code-credentials", suffixed] : [suffixed];
}

/**
 * The account's OAuth blob. darwin reads the keychain through `/usr/bin/security` (already on the
 * item's access list, so no prompt); every platform falls back to `<dir>/.credentials.json`.
 */
export async function readCredentials(dir: string, isDefault: boolean, deps: CredentialDeps): Promise<unknown> {
  if (deps.platform === "darwin") {
    for (const service of keychainServices(dir, isDefault)) {
      const out = await deps.exec("/usr/bin/security", ["find-generic-password", "-s", service, "-w"]);
      if (out.code === 0) return parseJson(out.stdout, "keychain item is not JSON");
    }
  }
  let raw: string;
  try {
    raw = await deps.readFile(join(dir, ".credentials.json"));
  } catch {
    throw new UsageError(NOT_SIGNED_IN);
  }
  return parseJson(raw, "credentials file is not JSON");
}

function parseJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError(message);
  }
}
