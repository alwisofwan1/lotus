import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { keychainServices, NOT_SIGNED_IN, readCredentials, type CredentialDeps } from "../credentials.js";

const suffix = (dir: string): string => createHash("sha256").update(dir).digest("hex").slice(0, 8);

function deps(over: Partial<CredentialDeps>): CredentialDeps {
  return {
    platform: "linux",
    exec: () => Promise.reject(new Error("exec must not run")),
    readFile: () => Promise.reject(new Error("ENOENT")),
    ...over,
  };
}

describe("keychainServices", () => {
  it("suffixes with sha256(dir)[0:8]; only default tries the plain item first", () => {
    expect(keychainServices("/h/a", false)).toEqual([`Claude Code-credentials-${suffix("/h/a")}`]);
    expect(keychainServices("/h/.claude", true)).toEqual(["Claude Code-credentials", `Claude Code-credentials-${suffix("/h/.claude")}`]);
  });
});

describe("readCredentials", () => {
  it("reads .credentials.json on linux", async () => {
    const read = await readCredentials("/d", false, deps({ readFile: async (p) => (p === "/d/.credentials.json" ? `{"a":1}` : "") }));
    expect(read).toEqual({ a: 1 });
  });

  it("says not signed in when the file is missing, and refuses a bad file", async () => {
    await expect(readCredentials("/d", false, deps({}))).rejects.toThrow(NOT_SIGNED_IN);
    await expect(readCredentials("/d", false, deps({ readFile: async () => "x" }))).rejects.toThrow("not JSON");
  });

  it("asks the keychain on darwin, plain item first for default", async () => {
    const asked: string[] = [];
    const exec: CredentialDeps["exec"] = async (file, args) => {
      expect(file).toBe("/usr/bin/security");
      asked.push(args[2] ?? "");
      return args[2] === `Claude Code-credentials-${suffix("/h/.claude")}` ? { code: 0, stdout: `{"k":2}` } : { code: 44, stdout: "" };
    };
    expect(await readCredentials("/h/.claude", true, deps({ platform: "darwin", exec }))).toEqual({ k: 2 });
    expect(asked).toEqual(["Claude Code-credentials", `Claude Code-credentials-${suffix("/h/.claude")}`]);
  });

  it("falls back to the file on darwin when the keychain has no item", async () => {
    const out = await readCredentials("/d", false, deps({
      platform: "darwin",
      exec: async () => ({ code: 44, stdout: "" }),
      readFile: async () => `{"f":3}`,
    }));
    expect(out).toEqual({ f: 3 });
  });
});
