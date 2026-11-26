import { describe, expect, it } from "vitest";
import {
  REMOTE_LOGIN_SHELL,
  buildSshCommand,
  formatSshTarget,
  quoteRemoteShellArg,
  validateRemoteCwd,
} from "@/modules/codespace/services/ssh-command";

/** What an agent launch hands the remote shell: the agent, the done mark, then the login shell. */
const agentThenShell = (command: string) =>
  `exec \${SHELL:-bash} -lic ${quoteRemoteShellArg(`${command}; printf "\\033]133;D\\007"; ${REMOTE_LOGIN_SHELL}`)}`;

describe("ssh-command", () => {
  it("builds an SSH command for a config alias", () => {
    expect(buildSshCommand({ target: { host: "devbox-vps", port: null } })).toEqual([
      "ssh",
      "-t",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "devbox-vps",
      REMOTE_LOGIN_SHELL,
    ]);
  });

  it("builds an SSH command for a user host and port", () => {
    expect(buildSshCommand({ target: { host: "server.example.com", user: "alwi", port: 2222 } })).toEqual([
      "ssh",
      "-t",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "-p",
      "2222",
      "alwi@server.example.com",
      REMOTE_LOGIN_SHELL,
    ]);
  });

  it("starts a login shell in a remote cwd", () => {
    expect(buildSshCommand({
      target: { host: "devbox-vps" },
      remoteCwd: "/home/alwi/workspace/acme-main",
    })).toEqual([
      "ssh",
      "-t",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "devbox-vps",
      `cd '/home/alwi/workspace/acme-main' && ${REMOTE_LOGIN_SHELL}`,
    ]);
  });

  it("runs an initial command in a remote cwd", () => {
    expect(buildSshCommand({
      target: { host: "devbox-vps" },
      remoteCwd: "/home/alwi/workspace/acme main",
      initialCommand: "claude",
    })).toEqual([
      "ssh",
      "-t",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "devbox-vps",
      `cd '/home/alwi/workspace/acme main' && ${agentThenShell("claude")}`,
    ]);
  });

  it("runs remote tools through the remote login shell so profile PATH is loaded", () => {
    expect(buildSshCommand({
      target: { host: "devbox-vps" },
      remoteCwd: "/home/alwi/workspace/acme-main",
      initialCommand: "lazydocker",
    })).toEqual([
      "ssh",
      "-t",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      "devbox-vps",
      `cd '/home/alwi/workspace/acme-main' && ${agentThenShell("lazydocker")}`,
    ]);
  });

  it("escapes single quotes in remote shell args", () => {
    expect(quoteRemoteShellArg("/home/alwi/it's ok")).toBe("'/home/alwi/it'\\''s ok'");
  });

  it("rejects unsafe host targets and ports", () => {
    expect(() => formatSshTarget({ host: "host; rm -rf /" })).toThrow(/host/i);
    expect(() => formatSshTarget({ host: "example.com", user: "bad user" })).toThrow(/user/i);
    expect(() => formatSshTarget({ host: "example.com", port: 70000 })).toThrow(/port/i);
  });

  it("rejects unsafe remote folders", () => {
    expect(() => validateRemoteCwd("relative/path")).toThrow(/absolute/i);
    expect(() => validateRemoteCwd("/home/alwi/workspace; rm -rf /")).toThrow(/unsupported/i);
    expect(() => validateRemoteCwd("/home/alwi/$(whoami)")).toThrow(/unsupported/i);
  });
});
