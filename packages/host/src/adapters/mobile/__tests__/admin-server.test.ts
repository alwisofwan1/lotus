import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Router } from "../../../server/router.js";
import { AdminServer } from "../admin-server.js";

const SECRET = "a".repeat(64);

function router(): Router {
  const r = new Router();
  r.add("GET", "/admin/health", (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return r;
}

describe("AdminServer", () => {
  let dir: string;
  let advertPath: string;
  let server: AdminServer | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-admin-srv-"));
    advertPath = join(dir, "mobile-admin.json");
    server = null;
  });

  afterEach(async () => {
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  // Without a secret there is no authentication, so a listener would be an open
  // control channel for every local process. Refusing to start is the only safe
  // answer; the host still runs, it just has no admin surface.
  it("refuses to start without a secret", async () => {
    server = new AdminServer({ router: router(), secret: "", advertPath });

    await expect(server.start()).rejects.toThrow(/secret/i);
    expect(() => statSync(advertPath)).toThrow();
  });

  it("refuses a secret that is only whitespace", async () => {
    server = new AdminServer({ router: router(), secret: "   ", advertPath });
    await expect(server.start()).rejects.toThrow(/secret/i);
  });

  it("binds loopback and advertises the port it actually got", async () => {
    server = new AdminServer({ router: router(), secret: SECRET, advertPath });

    await server.start();

    const advert = JSON.parse(readFileSync(advertPath, "utf8")) as {
      port: number;
      pid: number;
    };
    // Port 0 means the OS chooses, so the advert has to carry the resolved value
    // or Rust has nothing to connect to.
    expect(advert.port).toBeGreaterThan(0);
    expect(advert.port).toBe(server.address()?.port);
    expect(advert.pid).toBe(process.pid);
  });

  it("advertises on loopback, never a routable address", async () => {
    server = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await server.start();

    expect(server.address()?.host).toBe("127.0.0.1");
  });

  // The advert holds no secret, but the port is still a hint worth not handing
  // to other local accounts, and this mirrors the MCP discovery file.
  it("writes the advert readable only by the owner", async () => {
    server = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await server.start();

    expect(statSync(advertPath).mode & 0o777).toBe(0o600);
  });

  it("serves the router it was given", async () => {
    server = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await server.start();
    const { port } = server.address()!;

    const res = await fetch(`http://127.0.0.1:${port}/admin/health`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers 404 for a path the router does not claim", async () => {
    server = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await server.start();
    const { port } = server.address()!;

    const res = await fetch(`http://127.0.0.1:${port}/nope`);

    expect(res.status).toBe(404);
  });

  // A stale advert points Rust at a port that is either dead or, worse, now
  // belongs to something else.
  it("removes the advert on stop", async () => {
    server = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await server.start();
    expect(() => statSync(advertPath)).not.toThrow();

    await server.stop();

    expect(() => statSync(advertPath)).toThrow();
  });

  it("overwrites an advert left behind by a previous run", async () => {
    const stale = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await stale.start();
    const stalePort = stale.address()!.port;
    // Close the socket but leave the file, imitating a crash rather than a stop.
    await stale.stopWithoutCleanup();

    server = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await server.start();

    const advert = JSON.parse(readFileSync(advertPath, "utf8")) as { port: number };
    expect(advert.port).toBe(server.address()!.port);
    expect(advert.port).not.toBe(stalePort);
  });

  it("stop is idempotent", async () => {
    server = new AdminServer({ router: router(), secret: SECRET, advertPath });
    await server.start();

    await server.stop();
    await expect(server.stop()).resolves.toBeUndefined();
  });
});
