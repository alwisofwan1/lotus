import { describe, expect, it } from "vitest";
import {
  normalizeSshConfigHosts,
  parseManualSshTarget,
} from "@/modules/codespace/services/ssh-targets";

describe("ssh-targets", () => {
  it("normalizes SSH config hosts and ignores wildcards", () => {
    expect(normalizeSshConfigHosts([
      { alias: "orb" },
      { alias: "*" },
      { alias: "devbox-vps", hostname: "10.0.0.12", user: "alwi", port: 2222 },
      { alias: "devbox-vps" },
      { alias: "github-work", hostname: null, user: null, port: null },
      { alias: "github-personal", hostname: "github.com", user: "git", port: null },
    ])).toEqual([
      {
        id: "config:orb",
        label: "orb",
        source: "config",
        alias: "orb",
        host: "orb",
        hostname: undefined,
        user: undefined,
        port: undefined,
        capability: "shell",
      },
      {
        id: "config:devbox-vps",
        label: "devbox-vps",
        source: "config",
        alias: "devbox-vps",
        host: "devbox-vps",
        hostname: "10.0.0.12",
        user: "alwi",
        port: 2222,
        capability: "shell",
      },
      {
        id: "config:github-work",
        label: "github-work",
        source: "config",
        alias: "github-work",
        host: "github-work",
        hostname: undefined,
        user: undefined,
        port: undefined,
        capability: "shell",
      },
      {
        id: "config:github-personal",
        label: "github-personal",
        source: "config",
        alias: "github-personal",
        host: "github-personal",
        hostname: "github.com",
        user: "git",
        port: undefined,
        capability: "git",
        disabledReason: "This SSH alias is for Git authentication and does not provide an interactive shell.",
      },
    ]);
  });

  it("parses a structured manual target", () => {
    expect(parseManualSshTarget({
      host: "server.example.com",
      user: "alwi",
      port: "2222",
      label: "Prod",
    })).toEqual({
      id: "manual:alwi@server.example.com:2222",
      label: "Prod",
      source: "manual",
      host: "server.example.com",
      user: "alwi",
      port: 2222,
      capability: "shell",
    });
  });

  it("rejects unsupported manual target values", () => {
    expect(() => parseManualSshTarget({ host: "ssh host" })).toThrow(/hostname/i);
    expect(() => parseManualSshTarget({ host: "host", user: "bad user" })).toThrow(/user/i);
    expect(() => parseManualSshTarget({ host: "host", port: "0" })).toThrow(/port/i);
  });
});
