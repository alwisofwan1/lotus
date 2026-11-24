import { existsSync, mkdirSync, readlinkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AccountBook, InvalidAccountError, loginCommand } from "../account-book.js";
import { claudeAccountsIn } from "../discovery.js";

let home: string;
let state: string;
let chosen: string | undefined;
const linux = { platform: "linux", exec: async () => ({ code: 1, stdout: "" }), readFile: (p: string) => import("node:fs/promises").then((f) => f.readFile(p, "utf8")) };
const book = (): AccountBook => new AccountBook({ stateDir: state, sharedDir: join(home, ".claude"), warn: () => {}, claudeAccounts: () => claudeAccountsIn(home, state, []), chosen: () => chosen, creds: linux });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lotus-book-"));
  state = join(home, "state");
  chosen = undefined;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("AccountBook", () => {
  it("lists every Claude account; identity only where a login is held", async () => {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "left@over.io" } }));
    const work = join(home, ".ccs/instances/work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "w@x.io", organizationName: "X" } }));
    writeFileSync(join(work, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t" } }));
    chosen = "work";
    const rows = await book().list();
    expect(rows.map((r) => [r.id, r.source, r.inUse, r.identity])).toEqual([
      ["default", "default", false, null],
      ["work", "ccs", true, { email: "w@x.io", org: "X" }],
    ]);
    expect(rows[1]?.loginCommand).toBe(`CLAUDE_CONFIG_DIR='${work}' claude auth login`);
  });

  it("marks default in use when nothing is chosen", async () => {
    expect((await book().list())[0]).toMatchObject({ id: "default", inUse: true, loginCommand: "env -u CLAUDE_CONFIG_DIR claude auth login" });
  });

  it("creates a Lotus account folder and refuses bad or taken names", async () => {
    const made = await book().create("vps-2");
    expect(made).toMatchObject({ id: "vps-2", source: "lotus", identity: null, inUse: false, context: "shared" });
    expect(readlinkSync(join(state, "accounts/claude/vps-2/projects"))).toBe(join(home, ".claude/projects"));
    expect(await book().create("solo", true)).toMatchObject({ context: "isolated" });
    expect(existsSync(join(state, "accounts/claude/solo/projects"))).toBe(false);
    expect(existsSync(join(state, "accounts/claude/vps-2"))).toBe(true);
    await expect(book().create("vps-2")).rejects.toBeInstanceOf(InvalidAccountError);
    for (const bad of ["", "default", "Has Space", "../up", "-dash", "x".repeat(33)]) {
      await expect(book().create(bad)).rejects.toBeInstanceOf(InvalidAccountError);
    }
  });

  it("removes a Lotus account and its login, keeps what it linked to, refuses any other", async () => {
    await book().create("gone");
    mkdirSync(join(home, ".claude/projects/p"), { recursive: true });
    writeFileSync(join(home, ".claude/projects/p/chat.jsonl"), "keep");
    writeFileSync(join(state, "accounts/claude/gone/.credentials.json"), "{}");
    expect(book().remove("gone")).toBe("gone");
    expect(existsSync(join(state, "accounts/claude/gone"))).toBe(false);
    expect(existsSync(join(home, ".claude/projects/p/chat.jsonl"))).toBe(true);
    expect(() => book().remove("default")).toThrow(InvalidAccountError);
    expect(() => book().remove("nope")).toThrow(InvalidAccountError);
  });

  it("quotes a dir with a single quote", () => {
    expect(loginCommand({ id: "a", source: "lotus", dir: "/h/it's", configFile: "" })).toBe(`CLAUDE_CONFIG_DIR='/h/it'\\''s' claude auth login`);
  });
});
