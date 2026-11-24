import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertFixture } from "../../../adapters/mobile/__tests__/support/fixtures.js";
import { LastKnownStore, RATE_LIMITED, type FetchLike } from "../claude-usage.js";
import { claudeAccountsIn, codexAccountsIn } from "../discovery.js";
import { UsageService } from "../usage-service.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const HOUR = 3_600_000;

let home: string;
let clock: number;
let calls: string[];
let fetchImpl: FetchLike;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lotus-us-"));
  clock = NOW;
  calls = [];
  fetchImpl = async (_u, init) => {
    calls.push(init.headers["Authorization"] ?? "");
    return { status: 200, json: async () => BODY };
  };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const BODY = {
  limits: [
    { kind: "session", group: "session", percent: 25, resets_at: "2026-11-01T15:00:00+00:00", scope: null },
    { kind: "weekly_all", group: "weekly", percent: 40.5, resets_at: "2026-11-06T00:00:00+00:00", scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 10, resets_at: "2026-11-06T00:00:00+00:00", scope: { model: { display_name: "Fable" } } },
  ],
};

function signIn(dir: string, oauth: object | null, state: string, identity?: { email: string; org: string }): void {
  mkdirSync(dir, { recursive: true });
  if (oauth !== null) writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
  writeFileSync(state, JSON.stringify(identity === undefined ? {} : { oauthAccount: { emailAddress: identity.email, organizationName: identity.org } }));
}

function service(chosen?: string): UsageService {
  const paths = { stateDir: join(home, "state") };
  return new UsageService({
    claudeAccounts: () => claudeAccountsIn(home, paths.stateDir, []),
    codexAccounts: () => codexAccountsIn(home, []),
    chosen: () => chosen,
    claude: {
      creds: { platform: "linux", exec: () => Promise.reject(new Error("no")), readFile: (p) => import("node:fs/promises").then((fs) => fs.readFile(p, "utf8")) },
      fetch: (u, i) => fetchImpl(u, i),
      now: () => clock,
      lastKnown: new LastKnownStore(join(paths.stateDir, "last.json")),
    },
  });
}

function twoAccounts(): void {
  signIn(join(home, ".claude"), { subscriptionType: "team", accessToken: "tok-default", expiresAt: NOW + HOUR }, join(home, ".claude.json"), { email: "me@example.com", org: "Acme" });
  signIn(join(home, ".ccs/instances/work"), { subscriptionType: "max", accessToken: "tok-work", expiresAt: NOW - HOUR }, join(home, ".ccs/instances/work/.claude.json"), { email: "work@example.com", org: "Acme" });
}

describe("UsageService", () => {
  it("matches the contract fixture: fresh, idle with last known, and a Codex row", async () => {
    twoAccounts();
    mkdirSync(join(home, "state"), { recursive: true });
    new LastKnownStore(join(home, "state/last.json")).save("work", [
      { kind: "session", group: "session", usedPercent: 55, resetsAtMs: NOW - 1, windowMinutes: 300 },
      { kind: "weekly_all", group: "weekly", usedPercent: 12, resetsAtMs: NOW + 5 * HOUR, windowMinutes: 10080 },
    ], NOW - 2 * HOUR);
    const sessions = join(home, ".codex/sessions/2026/11");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "a.jsonl"), JSON.stringify({ payload: { rate_limits: {
      plan_type: "plus",
      primary: { used_percent: 8, window_minutes: 300, resets_at: (NOW + 2 * HOUR) / 1000 },
      secondary: { used_percent: 21, window_minutes: 10080, resets_at: (NOW + 48 * HOUR) / 1000 },
    } } }));

    assertFixture("usage-snapshot", { machine: "vps-1", accounts: await service().snapshot() });
  });

  it("marks the chosen account in use, else default", async () => {
    twoAccounts();
    expect((await service().snapshot()).map((a) => [a.account, a.inUse])).toEqual([["default", true], ["work", false]]);
    expect((await service("work").snapshot()).map((a) => [a.account, a.inUse])).toEqual([["default", false], ["work", true]]);
  });

  it("hides an unsigned default that is not in use, but not one that is", async () => {
    signIn(join(home, ".ccs/instances/work"), { accessToken: "t" }, join(home, ".ccs/instances/work/.claude.json"));
    expect((await service().snapshot()).map((a) => a.account)).toEqual(["default", "work"]);
    expect((await service("work").snapshot()).map((a) => a.account)).toEqual(["work"]);
  });

  it("caches 5 minutes, errors 1 minute", async () => {
    twoAccounts();
    const s = service();
    await s.snapshot();
    clock += 4 * 60_000;
    await s.snapshot();
    expect(calls).toHaveLength(1);
    clock += 2 * 60_000;
    await s.snapshot();
    expect(calls).toHaveLength(2);

    fetchImpl = async (_u, init) => { calls.push(init.headers["Authorization"] ?? ""); return { status: 500, json: async () => ({}) }; };
    clock += 6 * 60_000;
    await s.snapshot();
    const afterError = calls.length;
    clock += 30_000;
    await s.snapshot();
    expect(calls).toHaveLength(afterError);
    clock += 31_000;
    await s.snapshot();
    expect(calls).toHaveLength(afterError + 1);
  });

  it("shares one run between concurrent snapshots", async () => {
    twoAccounts();
    const s = service();
    const [a, b] = await Promise.all([s.snapshot(), s.snapshot()]);
    expect(a).toBe(b);
    expect(calls).toHaveLength(1);
  });

  it("keeps the last good numbers when the next check is rate limited", async () => {
    twoAccounts();
    const s = service();
    await s.snapshot();
    fetchImpl = async () => ({ status: 429, json: async () => ({}) });
    clock += 6 * 60_000;
    const row = (await s.snapshot())[0];
    expect(row?.error).toBe(RATE_LIMITED);
    expect(row?.windows).toHaveLength(3);
  });
});
