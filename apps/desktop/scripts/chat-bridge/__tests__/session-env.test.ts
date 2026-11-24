import { describe, expect, it } from "vitest";

import { sessionEnv } from "../claude-session";

describe("sessionEnv", () => {
  const shell = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-from-shell", CLAUDECODE: "1" };

  it("drops a key inherited from the shell for the login, and hands over the saved one for API key mode", () => {
    expect(sessionEnv(shell, { mode: "login" })).toEqual({ PATH: "/bin" });
    expect(sessionEnv(shell, { mode: "apiKey", apiKey: "sk-ant-saved" })).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-saved" });
    expect(sessionEnv(shell, undefined)).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-from-shell" });
  });

  it("runs the login on the account Lotus picked", () => {
    expect(sessionEnv(shell, { mode: "login", configDir: "/h/.ccs/instances/acme" })).toEqual({
      PATH: "/bin",
      CLAUDE_CONFIG_DIR: "/h/.ccs/instances/acme",
    });
  });
});
