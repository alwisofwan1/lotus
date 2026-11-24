import { describe, it, expect, afterEach } from "vitest";
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
import { SessionNotFoundError } from "../../pty/errors.js";
import type { PtyManager } from "../../pty/manager.js";

const API_KEY = "wait-idle-key";

/** PtyManager double whose sessions return a fixed buffer tail. */
function makePty(buffers: Record<string, string>): PtyManager {
  return {
    getSession: (id: string) => {
      if (!(id in buffers)) throw new SessionNotFoundError(id);
      return { state: { id, provider: "claude" }, getBufferTail: () => buffers[id]! };
    },
    list: () => [],
  } as unknown as PtyManager;
}

let server: Server;
async function start(pty: PtyManager): Promise<string> {
  server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: pty,
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry: new ProjectRegistry([]),
    notificationBus: new NotificationBus(),
    taskStore: new SwarmTaskStore({ baseDir: mkdtempSync(join(tmpdir(), "wait-idle-")) }),
    apiKey: API_KEY,
    port,
  }));
  return `http://127.0.0.1:${port}`;
}

function call(url: string, body: unknown, auth = true): Promise<Response> {
  return fetch(`${url}/v1/wait-cell-idle`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe("/v1/wait-cell-idle", () => {
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it("requires Bearer auth", async () => {
    const url = await start(makePty({ p: "$ " }));
    expect((await call(url, { pane_id: "p" }, false)).status).toBe(401);
  });

  it("400s without pane_id and 404s for an unknown cell", async () => {
    const url = await start(makePty({}));
    expect((await call(url, {})).status).toBe(400);
    expect((await call(url, { pane_id: "ghost" })).status).toBe(404);
  });

  it("returns idle=true immediately when the cell is already at a prompt", async () => {
    const url = await start(makePty({ p: "all done\n$ " }));
    const json = await (await call(url, { pane_id: "p" })).json() as { idle: boolean; readiness: string; state: string };
    expect(json.idle).toBe(true);
    expect(json.readiness).toBe("ready_shell");
    expect(json.state).toBe("ready");
  });

  it("returns idle=false busy when the deadline expires with no prompt", async () => {
    const url = await start(makePty({ p: "still working on it" }));
    const json = await (await call(url, { pane_id: "p", timeout_ms: 0 })).json() as { idle: boolean; readiness: string };
    expect(json.idle).toBe(false);
    expect(json.readiness).toBe("busy");
  });

  it("honours a custom ready signature", async () => {
    const url = await start(makePty({ p: "...TASK-COMPLETE..." }));
    const json = await (await call(url, { pane_id: "p", signatures: ["task-complete"] })).json() as { idle: boolean; matched: string };
    expect(json.idle).toBe(true);
    expect(json.matched).toBe("task-complete");
  });

  it("reports a dialog with its suggested auto-dismiss input", async () => {
    const url = await start(makePty({ p: "Proceed?\npress enter to continue" }));
    const json = await (await call(url, { pane_id: "p" })).json() as { idle: boolean; state: string; suggestedInput: string };
    expect(json.idle).toBe(true);
    expect(json.state).toBe("dialog");
    expect(json.suggestedInput).toBe("\r");
  });
});
