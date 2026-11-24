import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accountPaths, createAccountServices } from "../../../core/accounts/index.js";
import { createApp } from "../../app.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SwarmTaskStore } from "../../tasks/store.js";
import type { PtyManager } from "../../pty/manager.js";

const API_KEY = "usage-key";
let home: string;
let server: Server;
let url: string;

async function start(withAccounts: boolean): Promise<void> {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: { list: () => [] } as unknown as PtyManager,
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry: new ProjectRegistry([]),
    notificationBus: new NotificationBus(),
    taskStore: new SwarmTaskStore({ baseDir: join(home, "tasks") }),
    apiKey: API_KEY, port,
    ...(withAccounts ? { accounts: { machine: "test-box", ...createAccountServices(accountPaths({}, home), { platform: "linux" }) } } : {}),
  }));
  url = `http://127.0.0.1:${port}`;
}

const post = (path: string, body: unknown, auth = true): Promise<Response> =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(body),
  });

beforeEach(() => { home = mkdtempSync(join(tmpdir(), "lotus-usage-route-")); });
afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(home, { recursive: true, force: true });
});

describe("POST /v1/usage", () => {
  it("requires the bearer", async () => {
    await start(true);
    expect((await post("/v1/usage", {}, false)).status).toBe(401);
  });

  it("answers machine and accounts", async () => {
    await start(true);
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "t", expiresAt: 1 } }));
    const res = await post("/v1/usage", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { machine: string; accounts: { account: string; inUse: boolean; error: string }[] };
    expect(body.machine).toBe("test-box");
    expect(body.accounts).toMatchObject([{ account: "default", inUse: true }]);
    expect(body.accounts[0]?.error).toContain("idle");
  });

  it("is 503 when the host has no account services", async () => {
    await start(false);
    expect((await post("/v1/usage", {})).status).toBe(503);
  });
});

describe("POST /v1/accounts/default", () => {
  it("requires the bearer", async () => {
    await start(true);
    expect((await post("/v1/accounts/default", { provider: "claude", id: null }, false)).status).toBe(401);
  });

  it("sets and clears a known account, and usage follows", async () => {
    await start(true);
    mkdirSync(join(home, ".ccs/instances/work"), { recursive: true });
    writeFileSync(join(home, ".ccs/instances/work/.claude.json"), "{}");
    expect(await (await post("/v1/accounts/default", { provider: "claude", id: "work" })).json()).toEqual({ ok: true });
    const usage = (await (await post("/v1/usage", {})).json()) as { accounts: { account: string; inUse: boolean }[] };
    expect(usage.accounts.find((a) => a.account === "work")?.inUse).toBe(true);
    expect((await post("/v1/accounts/default", { provider: "claude", id: null })).status).toBe(200);
  });

  it("is 400 for an unknown id, another provider, or a bad body", async () => {
    await start(true);
    expect((await post("/v1/accounts/default", { provider: "claude", id: "nope" })).status).toBe(400);
    expect((await post("/v1/accounts/default", { provider: "codex", id: "default" })).status).toBe(400);
    expect((await post("/v1/accounts/default", { provider: "claude", id: 3 })).status).toBe(400);
    expect((await post("/v1/accounts/default", { provider: "claude" })).status).toBe(400);
  });
});

describe("POST /v1/accounts/list and /v1/accounts/create", () => {
  it("require the bearer", async () => {
    await start(true);
    expect((await post("/v1/accounts/list", {}, false)).status).toBe(401);
    expect((await post("/v1/accounts/create", { name: "x" }, false)).status).toBe(401);
  });

  it("create a folder that the list then shows, with its login command", async () => {
    await start(true);
    const made = (await (await post("/v1/accounts/create", { name: "vps-2" })).json()) as { id: string; loginCommand: string };
    expect(made.id).toBe("vps-2");
    expect(made.loginCommand).toContain("accounts/claude/vps-2' claude auth login");
    const list = (await (await post("/v1/accounts/list", {})).json()) as { machine: string; accounts: { id: string }[] };
    expect(list.machine).toBe("test-box");
    expect(list.accounts.map((a) => a.id)).toEqual(["default", "vps-2"]);
    const solo = (await (await post("/v1/accounts/create", { name: "solo", isolated: true })).json()) as { context: string };
    expect(solo.context).toBe("isolated");
  });

  it("is 400 for a bad or taken name, 503 without account services", async () => {
    await start(true);
    expect((await post("/v1/accounts/create", { name: "Bad Name" })).status).toBe(400);
    expect((await post("/v1/accounts/create", {})).status).toBe(400);
    await post("/v1/accounts/create", { name: "a" });
    expect((await post("/v1/accounts/create", { name: "a" })).status).toBe(400);
    await new Promise<void>((r) => server.close(() => r()));
    await start(false);
    expect((await post("/v1/accounts/list", {})).status).toBe(503);
  });
});

describe("POST /v1/accounts/remove", () => {
  it("removes a Lotus account; 400 for any other or a missing id; requires the bearer", async () => {
    await start(true);
    await post("/v1/accounts/create", { name: "gone" });
    expect((await post("/v1/accounts/remove", { id: "gone" }, false)).status).toBe(401);
    expect(await (await post("/v1/accounts/remove", { id: "gone" })).json()).toEqual({ removed: "gone" });
    const list = (await (await post("/v1/accounts/list", {})).json()) as { accounts: { id: string }[] };
    expect(list.accounts.map((a) => a.id)).toEqual(["default"]);
    expect((await post("/v1/accounts/remove", { id: "default" })).status).toBe(400);
    expect((await post("/v1/accounts/remove", {})).status).toBe(400);
  });
});

describe("POST /v1/accounts/migrate-ccs", () => {
  it("plans null without ccs, refuses a run there and an unknown action", async () => {
    await start(true);
    expect(await (await post("/v1/accounts/migrate-ccs", { action: "plan" })).json()).toBeNull();
    expect((await post("/v1/accounts/migrate-ccs", { action: "run" })).status).toBe(400);
    expect((await post("/v1/accounts/migrate-ccs", { action: "nuke" })).status).toBe(400);
  });

  it("re-points an instance's links into ~/.claude on run", async () => {
    await start(true);
    const inst = join(home, ".ccs/instances/hss");
    mkdirSync(inst, { recursive: true });
    mkdirSync(join(home, ".ccs/shared"), { recursive: true });
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    symlinkSync(join(home, ".claude/skills"), join(home, ".ccs/shared/skills"));
    symlinkSync(join(home, ".ccs/shared/skills"), join(inst, "skills"));
    const plan = (await (await post("/v1/accounts/migrate-ccs", { action: "plan" })).json()) as { relinks: unknown[] };
    expect(plan.relinks).toEqual([{ link: join(inst, "skills"), to: join(home, ".claude/skills") }]);
    expect((await post("/v1/accounts/migrate-ccs", { action: "run" })).status).toBe(200);
    expect(readlinkSync(join(inst, "skills"))).toBe(join(home, ".claude/skills"));
  });
});
