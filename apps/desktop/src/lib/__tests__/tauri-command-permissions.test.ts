import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../../..");

function listSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["__tests__", "node_modules"].includes(entry.name)) return [];
      return listSourceFiles(fullPath);
    }
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) return [];
    if (/\.test\.(ts|tsx)$/.test(entry.name)) return [];
    return [fullPath];
  });
}

function readAllowedCommands(): Set<string> {
  const source = fs.readFileSync(
    path.join(repoRoot, "src-tauri/permissions/main-app-commands.toml"),
    "utf8",
  );
  const allowBlock = source.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  return new Set([...allowBlock.matchAll(/"([A-Za-z0-9_]+)"/g)].map((match) => match[1]));
}

function readInvokedCommands(): string[] {
  const commands = new Set<string>();
  const invokePattern = /\b(?:tauriInvoke|invoke)(?:<[^>]+>)?\(\s*["']([A-Za-z0-9_]+)["']/g;

  for (const file of listSourceFiles(path.join(repoRoot, "src"))) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(invokePattern)) {
      commands.add(match[1]);
    }
  }

  return [...commands].sort();
}

describe("Tauri command permissions", () => {
  it("allowlists every first-party command invoked by the frontend", () => {
    const allowed = readAllowedCommands();
    const invoked = readInvokedCommands();

    expect(invoked.filter((command) => !allowed.has(command))).toEqual([]);
  });
});
