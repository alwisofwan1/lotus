import { readFileSync } from "node:fs";

/** Extracts account names from a `~/.ccs/config.yaml` file without a YAML parser. */
export function discoverCcsAccounts(configPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return [];
  }

  const accounts: string[] = [];
  let inAccounts = false;

  for (const line of raw.split("\n")) {
    // Detect start of the accounts block
    if (/^accounts:\s*$/.test(line)) {
      inAccounts = true;
      continue;
    }
    if (!inAccounts) continue;

    // Non-indented non-empty non-comment line — left the accounts block
    if (line.length > 0 && !/^\s/.test(line) && !line.startsWith("#")) break;

    // 2-space-indented key: account name
    const m = line.match(/^  ([a-zA-Z0-9_-]+):\s*$/);
    if (m?.[1]) accounts.push(m[1]);
  }

  return accounts;
}
