import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_INSTALL, installCommand } from "../services/cli-install";

describe("installCommand", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("gives PowerShell on Windows and the shell command elsewhere", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect(installCommand(CLI_INSTALL.claude)).toBe("irm https://claude.ai/install.ps1 | iex");
    expect(installCommand(CLI_INSTALL.codex)).toBe("npm install -g @openai/codex");
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(installCommand(CLI_INSTALL.claude)).toBe("curl -fsSL https://claude.ai/install.sh | bash");
  });
});
