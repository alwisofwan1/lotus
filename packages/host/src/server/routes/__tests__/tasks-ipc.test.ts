import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../app.js";
import { PtyManager } from "../../pty/manager.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SwarmTaskStore } from "../../tasks/store.js";

const API_KEY = "tasks-test-key";
const WS = "/srv/api";

interface Harness { url: string; server: Server; dir: string }

async function start(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "tasks-ipc-"));
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  server.on("request", createApp({
    ptyManager: { list: () => [] } as unknown as PtyManager,
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry: new ProjectRegistry([]),
    notificationBus: new NotificationBus(),
    taskStore: new SwarmTaskStore({ baseDir: dir }),
    apiKey: API_KEY,
    port,
  }));
  return { url: `http://127.0.0.1:${port}`, server, dir };
}

function call(h: Harness, path: string, body: unknown, auth = true): Promise<Response> {
  return fetch(`${h.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${API_KEY}` } : {}) },
    body: JSON.stringify(body),
  });
}

async function createTask(h: Harness, over: Record<string, unknown> = {}): Promise<{ id: string }> {
  const res = await call(h, "/v1/tasks/create", { workspace_id: WS, title: "T", goal: "G", ...over });
  const json = await res.json() as { task: { id: string } };
  return json.task;
}

describe("/v1/tasks/* MCP-IPC surface", () => {
  let h: Harness;
  beforeEach(async () => { h = await start(); });
  afterEach(async () => {
    await new Promise<void>((r) => h.server.close(() => r()));
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("requires Bearer auth (the /v1 surface is not public)", async () => {
    const res = await call(h, "/v1/tasks/list", { workspace_id: WS }, false);
    expect(res.status).toBe(401);
  });

  // ─── create ──────────────────────────────────────────────────────────────

  it("creates a task from snake_case body and returns the { ok, task } envelope", async () => {
    const res = await call(h, "/v1/tasks/create", { workspace_id: WS, title: "Ship", goal: "Do it" });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; task: { id: string; workspaceId: string; status: string } };
    expect(json.ok).toBe(true);
    expect(json.task.workspaceId).toBe(WS);     // response task is camelCase (BridgeTask parity)
    expect(json.task.status).toBe("todo");
    expect(json.task.id).toBeTruthy();
  });

  it("rejects create without workspace_id/title/goal (400)", async () => {
    const res = await call(h, "/v1/tasks/create", { workspace_id: WS, title: "x" });
    expect(res.status).toBe(400);
  });

  // ─── get / list ────────────────────────────────────────────────────────────

  it("gets a task scoped to its workspace and 404s on a workspace mismatch", async () => {
    const task = await createTask(h);
    const okRes = await call(h, "/v1/tasks/get", { workspace_id: WS, task_id: task.id });
    expect(okRes.status).toBe(200);
    const wrong = await call(h, "/v1/tasks/get", { workspace_id: "/other", task_id: task.id });
    expect(wrong.status).toBe(404);
  });

  it("lists tasks for a workspace and filters by status", async () => {
    await createTask(h, { status: "todo" });
    await createTask(h, { status: "in-progress" });
    const all = await (await call(h, "/v1/tasks/list", { workspace_id: WS })).json() as { tasks: unknown[] };
    expect(all.tasks).toHaveLength(2);
    const todo = await (await call(h, "/v1/tasks/list", { workspace_id: WS, status: "todo" })).json() as { tasks: unknown[] };
    expect(todo.tasks).toHaveLength(1);
  });

  // ─── update / append-feedback-event ─────────────────────────────────────────

  it("applies a camelCase patch via update", async () => {
    const task = await createTask(h);
    const res = await call(h, "/v1/tasks/update", { workspace_id: WS, task_id: task.id, patch: { status: "complete" } });
    expect(res.status).toBe(200);
    const json = await res.json() as { task: { status: string } };
    expect(json.task.status).toBe("complete");
  });

  it("404s when updating a task in the wrong workspace", async () => {
    const task = await createTask(h);
    const res = await call(h, "/v1/tasks/update", { workspace_id: "/nope", task_id: task.id, patch: { status: "complete" } });
    expect(res.status).toBe(404);
  });

  it("appends a feedback event", async () => {
    const task = await createTask(h);
    const event = { id: "e1", at: 1, actor: "director", kind: "intake-created", summary: "brief" };
    const res = await call(h, "/v1/tasks/append-feedback-event", { workspace_id: WS, task_id: task.id, event });
    expect(res.status).toBe(200);
    const json = await res.json() as { task: { feedbackEvents: { id: string }[] } };
    expect(json.task.feedbackEvents.map((e) => e.id)).toEqual(["e1"]);
  });
});
