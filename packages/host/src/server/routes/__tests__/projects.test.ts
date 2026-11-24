import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApp } from "../../app.js";
import { makeTestTaskStore } from "../../__tests__/task-store-fixture.js";
import { AgentRunnerRegistry } from "../../agent/registry.js";
import { ProjectRegistry } from "../../projects/registry.js";
import { NotificationBus } from "../../notifications/bus.js";
import { SessionNotFoundError } from "../../pty/errors.js";
import type { PtyManager } from "../../pty/manager.js";
import type { HostedProject } from "../../../types/index.js";
import { ProjectCloner } from "../../projects/clone.js";
import { BrowseRoots } from "../../projects/browse.js";
import { ExtraProjects } from "../../projects/extra-store.js";
import { ProjectRegistrar } from "../../projects/registrar.js";
import type { Git } from "../../../core/git.js";
import { mkdtempSync, mkdirSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-key-projects";

const PROJECTS: HostedProject[] = [
  { id: "api", name: "API Service", path: "/srv/api" },
  { id: "web", name: "Web Frontend", path: "/srv/web" },
];

function makeMockManager(): PtyManager {
  return {
    create: () => { throw new SessionNotFoundError("mock"); },
    list: () => [],
    getSession: (id: string) => { throw new SessionNotFoundError(id); },
    write: (id: string) => { throw new SessionNotFoundError(id); },
    resize: (id: string) => { throw new SessionNotFoundError(id); },
    kill: (id: string) => { throw new SessionNotFoundError(id); },
    stop: () => undefined,
  } as unknown as PtyManager;
}

async function startServer(
  projectRegistry: ProjectRegistry,
  projectCloner?: ProjectCloner,
  browseRoots?: BrowseRoots,
  projectRegistrar?: ProjectRegistrar,
): Promise<{ url: string; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const handler = createApp({
    ptyManager: makeMockManager(),
    agentRunners: new AgentRunnerRegistry(),
    projectRegistry,
    notificationBus: new NotificationBus(),
    taskStore: makeTestTaskStore(), apiKey: API_KEY,
    port,
    ...(projectCloner === undefined ? {} : { projectCloner }),
    ...(browseRoots === undefined ? {} : { browseRoots }),
    ...(projectRegistrar === undefined ? {} : { projectRegistrar }),
  });
  server.on("request", handler);
  return { url: `http://127.0.0.1:${port}`, server };
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}

describe("GET /api/projects", () => {
  let url: string;
  let server: Server;

  beforeEach(async () => {
    ({ url, server } = await startServer(new ProjectRegistry(PROJECTS)));
  });

  afterEach(async () => {
    await stopServer(server);
  });

  it("returns 401 without Authorization header", async () => {
    const res = await fetch(`${url}/api/projects`);
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong bearer token", async () => {
    const res = await fetch(`${url}/api/projects`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with project array for valid bearer", async () => {
    const res = await fetch(`${url}/api/projects`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(PROJECTS);
  });

  it("returns empty array when registry has no projects", async () => {
    const { url: emptyUrl, server: emptyServer } = await startServer(new ProjectRegistry([]));
    try {
      const res = await fetch(`${emptyUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    } finally {
      await stopServer(emptyServer);
    }
  });

  it("response Content-Type is application/json", async () => {
    const res = await fetch(`${url}/api/projects`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

/// Cloning a repository into the workspace root the registry already scans.
///
/// `plans/pocket-vps-project-checkout/issues/02`. The job outlives the request on purpose:
/// a repo on a VPS link can take minutes, and the phone is allowed to leave the screen.
describe("POST /api/projects/clone", () => {
  let url: string;
  let server: Server;
  let root: string;

  const fakeGit: Git = async (cwd, args) => {
    if (args[0] === "clone") mkdirSync(join(cwd, args[args.length - 1]!), { recursive: true });
    return { code: 0, stdout: "", stderr: "" };
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "clone-route-"));
    ({ url, server } = await startServer(
      new ProjectRegistry(PROJECTS),
      new ProjectCloner({ git: fakeGit, root }),
    ));
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(root, { recursive: true, force: true });
  });

  const post = (body: unknown): Promise<Response> =>
    fetch(`${url}/api/projects/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });

  it("answers with a task id the caller can come back to", async () => {
    const started = await post({ url: "https://github.com/alwi/tkt-worker.git" });
    expect(started.status).toBe(200);
    const { taskId } = (await started.json()) as { taskId: string };
    expect(taskId).toBeTruthy();

    // Poll the way a phone does, rather than reaching into the cloner.
    let job = { state: "running" } as { state: string; name?: string };
    for (let i = 0; i < 50 && job.state === "running"; i++) {
      const res = await fetch(`${url}/api/projects/clone/${taskId}`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      expect(res.status).toBe(200);
      job = (await res.json()) as typeof job;
    }

    expect(job).toMatchObject({ state: "done", name: "tkt-worker" });
  });

  it("answers 404 for a task id it never issued", async () => {
    const res = await fetch(`${url}/api/projects/clone/clone_nope`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(404);
  });

  it("tells a bad name apart from a name already taken", async () => {
    const bad = await post({ url: "https://github.com/alwi/x.git", name: ".hidden" });
    expect(bad.status).toBe(400);

    mkdirSync(join(root, "taken"));
    const clash = await post({ url: "https://github.com/alwi/taken.git" });
    expect(clash.status).toBe(409);
  });

  it("refuses without a url rather than deriving a name from nothing", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ url: "   " })).status).toBe(400);
  });
});

describe("POST /api/projects/clone — a host with no workspace root", () => {
  let url: string;
  let server: Server;

  beforeEach(async () => { ({ url, server } = await startServer(new ProjectRegistry(PROJECTS))); });
  afterEach(() => stopServer(server));

  it("answers 503, so a client reads it as not here rather than as a failure", async () => {
    const res = await fetch(`${url}/api/projects/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ url: "https://github.com/alwi/x.git" }),
    });
    expect(res.status).toBe(503);
  });
});

/// `GET /api/fs` — the jail, as a route. `BrowseRoots` owns the rule; this owns the statuses.
describe("GET /api/fs", () => {
  let url: string;
  let server: Server;
  let dir: string;
  let allowed: string;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "fs-route-")));
    allowed = join(dir, "workspaces");
    mkdirSync(join(allowed, "a-repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "secrets"), { recursive: true });
    ({ url, server } = await startServer(
      new ProjectRegistry(PROJECTS),
      undefined,
      new BrowseRoots([allowed]),
    ));
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (query: string): Promise<Response> =>
    fetch(`${url}/api/fs${query}`, { headers: { Authorization: `Bearer ${API_KEY}` } });

  it("answers with the roots alone when nothing was asked for", async () => {
    const res = await get("");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      roots: [{ name: "workspaces", path: allowed }],
      page: null,
    });
  });

  it("lists one level, and carries the roots with it", async () => {
    const res = await get(`?path=${encodeURIComponent(allowed)}`);
    const body = (await res.json()) as { roots: unknown[]; page: { entries: unknown[] } };

    expect(res.status).toBe(200);
    expect(body.roots).toHaveLength(1);
    expect(body.page.entries).toMatchObject([{ name: "a-repo", isRepo: true }]);
  });

  it("answers 403 outside the roots, which is a wall rather than a wrong turn", async () => {
    const res = await get(`?path=${encodeURIComponent(join(dir, "secrets"))}`);
    expect(res.status).toBe(403);
  });

  it("answers 404 for a directory that is not there", async () => {
    const res = await get(`?path=${encodeURIComponent(join(allowed, "never-made"))}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/fs — a host that opens nothing", () => {
  let url: string;
  let server: Server;

  beforeEach(async () => { ({ url, server } = await startServer(new ProjectRegistry(PROJECTS))); });
  afterEach(() => stopServer(server));

  it("answers 503, so a client reads it as not here rather than as a refusal", async () => {
    const res = await fetch(`${url}/api/fs`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(res.status).toBe(503);
  });
});

/// `POST /api/projects` and `DELETE /api/projects/:id` — taking a folder, and letting it go.
describe("registering a folder as a project", () => {
  let url: string;
  let server: Server;
  let dir: string;
  let kerja: string;

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "registrar-route-")));
    kerja = join(dir, "kerja");
    mkdirSync(join(kerja, "tkt-backend"), { recursive: true });
    mkdirSync(join(dir, "secrets"), { recursive: true });
    const file = join(dir, "projects.json");
    const extra = new ExtraProjects(file);
    const registry = ProjectRegistry.fromConfig({ extraProjects: file });
    ({ url, server } = await startServer(
      registry,
      undefined,
      new BrowseRoots([kerja]),
      new ProjectRegistrar({ extra, registry, browse: new BrowseRoots([kerja]) }),
    ));
  });
  afterEach(async () => {
    await stopServer(server);
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body: unknown): Promise<Response> =>
    fetch(`${url}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(body),
    });

  it("answers with the project, which the listing then holds", async () => {
    const res = await post({ path: join(kerja, "tkt-backend") });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: "tkt-backend", path: join(kerja, "tkt-backend") });

    const listed = await fetch(`${url}/api/projects`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect((await listed.json() as Array<{ id: string }>).map((p) => p.id)).toEqual(["tkt-backend"]);
  });

  it("tells a wall apart from a folder already taken", async () => {
    expect((await post({ path: join(dir, "secrets") })).status).toBe(403);

    await post({ path: join(kerja, "tkt-backend") });
    expect((await post({ path: join(kerja, "tkt-backend") })).status).toBe(409);
  });

  it("refuses without a path, and 404s one that is not there", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ path: join(kerja, "never-made") })).status).toBe(404);
  });

  it("lets go without touching the directory", async () => {
    const target = join(kerja, "tkt-backend");
    await post({ path: target });

    const res = await fetch(`${url}/api/projects/tkt-backend`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });

    expect(res.status).toBe(200);
    expect(existsSync(target)).toBe(true);
  });
});
