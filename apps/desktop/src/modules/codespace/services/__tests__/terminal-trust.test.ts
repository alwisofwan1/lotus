import { beforeEach, describe, expect, it } from "vitest";
import { getTrustedTerminalDirs, rememberTrustedTerminalDir } from "@/modules/codespace/services/terminal-trust";

describe("terminal-trust", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty set when trust storage is empty", () => {
    expect(getTrustedTerminalDirs()).toEqual(new Set());
  });

  it("stores trusted directories without duplicating entries", () => {
    rememberTrustedTerminalDir("/tmp/project-a");
    rememberTrustedTerminalDir("/tmp/project-a");
    rememberTrustedTerminalDir("/tmp/project-b");

    expect(getTrustedTerminalDirs()).toEqual(new Set(["/tmp/project-a", "/tmp/project-b"]));
  });
});
