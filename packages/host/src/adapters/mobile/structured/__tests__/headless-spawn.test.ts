import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../../../../core/api-client.js";
import { spawnHeadlessCell, type HeadlessSpawnDeps } from "../headless-spawn.js";
import type { StructuredSessions } from "../structured-sessions.js";

function setup(hostDefault: string | undefined) {
  const spawn = vi.fn().mockResolvedValue({ paneId: "ss-1", sessionId: "s" });
  const structured = { canRun: () => true, headlessRunners: () => ["claude"], spawn } as unknown as StructuredSessions;
  const out: { status?: number } = {};
  const res = { writeHead: (s: number) => { out.status = s; }, end: () => undefined } as unknown as ServerResponse;
  const deps: HeadlessSpawnDeps = {
    structured,
    api: { listProjects: async () => ({ items: [{ workspaceId: "w", name: "W", path: "/w", lastOpenedAt: 1 }] }) } as unknown as Pick<ApiClient, "listProjects">,
    profiles: () => [{ id: "default" }, { id: "work" }, { id: "other" }],
    hostDefault: () => hostDefault,
  };
  const run = (provider: string, profileId?: string) =>
    spawnHeadlessCell(res, { provider, workspaceId: "w", ...(profileId === undefined ? {} : { profileId }) }, deps);
  return { spawn, out, run };
}

describe("spawnHeadlessCell host default account", () => {
  it("runs a Claude cell as the host default when the request names none", async () => {
    const t = setup("work");
    await t.run("claude");
    expect(t.spawn.mock.calls[0]?.[0]).toMatchObject({ profileId: "work" });
  });

  it("lets the request's own profileId win", async () => {
    const t = setup("work");
    await t.run("claude", "other");
    expect(t.spawn.mock.calls[0]?.[0]).toMatchObject({ profileId: "other" });
  });

  it("runs an explicit default with no config dir, over the host's choice (issues/07)", async () => {
    const t = setup("work");
    await t.run("claude", "default");
    expect(t.spawn.mock.calls[0]?.[0]).not.toHaveProperty("profileId");
  });

  it("applies nothing for a non-Claude runner, nor when none or `default` is chosen", async () => {
    for (const [chosen, provider] of [["work", "codex"], [undefined, "claude"], ["default", "claude"]] as const) {
      const t = setup(chosen);
      await t.run(provider);
      expect(t.spawn.mock.calls[0]?.[0]).not.toHaveProperty("profileId");
    }
  });
});
