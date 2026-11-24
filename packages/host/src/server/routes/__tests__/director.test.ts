import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SwarmTaskStore } from "../../tasks/store.js";
import type { PtyManager } from "../../pty/manager.js";
import type { DirectorSupervisor } from "../../director/supervisor.js";

const API_KEY = "director-key";
let server: Server;

async function start(director?: DirectorSupervisor): Promise<string> {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: { list: () => [] } as unknown as PtyManager,
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry: new ProjectRegistry([]),
    notificationBus: new NotificationBus(),
    taskStore: new SwarmTaskStore({ baseDir: mkdtempSync(join(tmpdir(), "director-")) }),
    apiKey: API_KEY,
    port,
    ...(director ? { director } : {}),
  }));
  return `http://127.0.0.1:${port}`;
}

function post(url: string, body: unknown, auth = true): Promise<Response> {
  return fetch(`${url}/api/director/goal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(body),
  });
}

function fakeDirector(): DirectorSupervisor {
  return { submitGoal: vi.fn(async (text: string) => ({ sessionId: "s1", text: `ack:${text}`, isError: false })) } as unknown as DirectorSupervisor;
}

describe("POST /api/director/goal", () => {
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("requires Bearer auth", async () => {
    const url = await start(fakeDirector());
    expect((await post(url, { text: "go" }, false)).status).toBe(401);
  });

  it("503s when no Director is enabled on the host", async () => {
    const url = await start(undefined);
    expect((await post(url, { text: "go" })).status).toBe(503);
  });

  it("400s when text is missing or blank", async () => {
    const url = await start(fakeDirector());
    expect((await post(url, {})).status).toBe(400);
    expect((await post(url, { text: "  " })).status).toBe(400);
  });

  it("accepts the goal fire-and-forget with 202 (reply arrives via notifications)", async () => {
    const director = fakeDirector();
    const url = await start(director);
    const res = await post(url, { text: "ship the feature" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, accepted: true });
    expect(director.submitGoal).toHaveBeenCalledWith("ship the feature");
  });
});
