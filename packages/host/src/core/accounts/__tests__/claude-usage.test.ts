import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeUsage, IDLE, LastKnownStore, parseClaudeLimits, RATE_LIMITED, type ClaudeUsageDeps, type FetchLike } from "../claude-usage.js";
import type { Account } from "../types.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const FIXTURE = join(__dirname, "fixtures/claude-oauth-usage.json");

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lotus-cu-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const account = (id = "work"): Account => ({ id, source: "ccs", dir: `/h/${id}`, configFile: `/h/${id}/.claude.json` });

function deps(oauth: unknown, fetch: FetchLike): ClaudeUsageDeps {
  return {
    creds: { platform: "linux", exec: () => Promise.reject(new Error("no")), readFile: async () => JSON.stringify(oauth === null ? {} : { claudeAiOauth: oauth }) },
    fetch, now: () => NOW, lastKnown: new LastKnownStore(join(dir, "last.json")),
  };
}
const ok = (body: unknown): FetchLike => async () => ({ status: 200, json: async () => body });
const status = (code: number): FetchLike => async () => ({ status: code, json: async () => ({}) });

describe("parseClaudeLimits", () => {
  it("turns the recorded oauth body into windows", () => {
    const body: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
    expect(parseClaudeLimits(body)).toEqual([
      { kind: "session", group: "session", usedPercent: 0, resetsAtMs: Date.parse("2026-11-01T20:49:59.659Z"), windowMinutes: 300 },
      { kind: "weekly_all", group: "weekly", usedPercent: 0, resetsAtMs: Date.parse("2026-11-06T23:59:59.659Z"), windowMinutes: 10080 },
    ]);
  });

  it("carries a model scope and skips malformed entries", () => {
    const out = parseClaudeLimits({ limits: [
      { kind: "weekly_scoped", group: "weekly", percent: 12, resets_at: null, scope: { model: { display_name: "Fable" } } },
      { kind: "x" },
    ] });
    expect(out).toEqual([{ kind: "weekly_scoped", group: "weekly", usedPercent: 12, resetsAtMs: null, windowMinutes: 10080, scope: "Fable" }]);
    expect(parseClaudeLimits({})).toEqual([]);
  });
});

describe("claudeUsage", () => {
  it("reads plan and windows, and sends the bearer token", async () => {
    let seen: Record<string, string> = {};
    const fetch: FetchLike = async (_u, init) => { seen = init.headers; return { status: 200, json: async () => JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown }; };
    const row = await claudeUsage(account(), deps({ subscriptionType: "team", accessToken: "tok", expiresAt: NOW + 1 }, fetch));
    expect(row).toMatchObject({ provider: "claude", account: "work", plan: "team", error: null });
    expect(row.windows).toHaveLength(2);
    expect(seen["Authorization"]).toBe("Bearer tok");
  });

  it("is not signed in without credentials", async () => {
    expect((await claudeUsage(account(), deps(null, ok({})))).error).toBe("not signed in");
  });

  it("is idle past expiresAt without a request, showing last known numbers", async () => {
    const d = deps({ subscriptionType: "max", accessToken: "t", expiresAt: NOW - 1 }, () => Promise.reject(new Error("no request")));
    d.lastKnown.save("work", [{ kind: "session", group: "session", usedPercent: 40, resetsAtMs: NOW - 5, windowMinutes: 300 }, { kind: "weekly_all", group: "weekly", usedPercent: 9, resetsAtMs: NOW + 9, windowMinutes: 10080 }], NOW - 1000);
    const row = await claudeUsage(account(), d);
    expect(row.error).toBe(IDLE);
    expect(row.asOfMs).toBe(NOW - 1000);
    // The session window reset since the save, so it reads empty now.
    expect(row.windows.map((w) => w.usedPercent)).toEqual([0, 9]);
    expect(row.windows[0]?.resetsAtMs).toBeNull();
  });

  it("maps 401, 403, 429 and other statuses", async () => {
    const oauth = { accessToken: "t" };
    expect((await claudeUsage(account(), deps(oauth, status(401)))).error).toContain("sign-in expired");
    expect((await claudeUsage(account(), deps(oauth, status(403)))).error).toContain("sign-in expired");
    expect((await claudeUsage(account(), deps(oauth, status(429)))).error).toBe(RATE_LIMITED);
    expect((await claudeUsage(account(), deps(oauth, status(500)))).error).toBe("usage API: HTTP 500");
  });

  it("reports a network failure", async () => {
    const row = await claudeUsage(account(), deps({ accessToken: "t" }, () => Promise.reject(new Error("boom"))));
    expect(row.error).toBe("network: boom");
  });
});
