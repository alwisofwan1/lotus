import { describe, expect, it } from "vitest";

import { commandDestroys, itemDestroys } from "../destructive";

describe("commandDestroys", () => {
  it("flags commands that delete or force-overwrite", () => {
    for (const c of [
      "rm -rf dist",
      "cd x && sudo rm a.txt",
      "bb thread delete 01HX",
      "gh repo delete me/x --yes",
      "docker rm -f web",
      "git reset --hard HEAD~1",
      "git clean -fdx",
      "git push origin main --force",
      "git branch -D old",
      "find . -name '*.tmp' -delete",
      "ls | xargs rm",
    ]) {
      expect(commandDestroys(c), c).toBe(true);
    }
  });

  it("leaves reads and look-alikes alone", () => {
    for (const c of [
      "grep -rn delete src",
      "bun test --grep delete",
      "git log --oneline",
      "git push origin main",
      "find . -name '*.ts'",
      "echo 'rm -rf /'",
      "cat remove.md",
      "bb thread list",
    ]) {
      expect(commandDestroys(c), c).toBe(false);
    }
  });
});

describe("itemDestroys", () => {
  const tool = (name: string, input: unknown) => ({ id: "t", status: "completed" as const, kind: "tool" as const, name, input, output: null });

  it("reads tool names and an action field", () => {
    expect(itemDestroys(tool("mcp__fs__delete_file", {}))).toBe(true);
    expect(itemDestroys(tool("mcp__lotus__lotus_chat_manage", { action: "delete", chatId: "x" }))).toBe(true);
    expect(itemDestroys(tool("mcp__lotus__lotus_chat_manage", { action: "archive" }))).toBe(false);
    expect(itemDestroys(tool("WebFetch", { url: "https://x/delete" }))).toBe(false);
  });
});
