import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMobileRouter, type MobileRouterDeps } from "../http-routes.js";
import { DeviceStore } from "../device-store.js";
import { PairingService } from "../pairing.js";
import { ApiError } from "../../../core/api-error.js";
import { call } from "./support/call.js";
import type { CloneJob } from "../../../types/index.js";

const JOB: CloneJob = {
  taskId: "clone_1", state: "running", step: "cloning", name: "tkt-worker",
  path: "/home/op/lotus-workspaces/tkt-worker",
};

/**
 * The façade owns no filesystem — `adapters` never reaches into `server`, so every clone
 * route here is a forward to the machine that owns the workspace root.
 */
describe("mobile clone routes", () => {
  let dir: string;
  let router: ReturnType<typeof buildMobileRouter>;
  let pairing: PairingService;
  let seen: unknown[];

  function build(api: Partial<MobileRouterDeps["api"]>): void {
    const devices = new DeviceStore(join(dir, "devices.json"), () => Date.now());
    pairing = new PairingService(devices, () => Date.now());
    router = buildMobileRouter({
      api: api as MobileRouterDeps["api"],
      devices,
      pairing,
      host: { hostId: "vps", hostLabel: "VPS", mode: "standalone" },
      audit: () => undefined,
      fleetSnapshot: async () => [],
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-clone-routes-"));
    seen = [];
    build({
      cloneProject: async (req) => { seen.push(req); return JOB; },
      cloneStatus: async (id) => { seen.push(id); return { ...JOB, state: "done" }; },
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function token(): Promise<string> {
    const { code } = pairing.create();
    const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
    return (res.json as { deviceToken: string }).deviceToken;
  }

  it("hands the ask to the machine that owns the workspace root, and answers with the job", async () => {
    const bearer = await token();

    const started = await call(
      router, "POST", "/m/projects/clone",
      { url: "https://github.com/alwi/tkt-worker.git", branch: "main" }, bearer,
    );
    expect(started.status).toBe(200);
    expect(started.json).toMatchObject({ taskId: "clone_1", name: "tkt-worker" });
    expect(seen[0]).toEqual({ url: "https://github.com/alwi/tkt-worker.git", branch: "main" });

    const polled = await call(router, "GET", "/m/projects/clone/clone_1", undefined, bearer);
    expect(polled.status).toBe(200);
    expect(polled.json).toMatchObject({ state: "done" });
    expect(seen[1]).toBe("clone_1");
  });

  it("refuses without a bearer, like every route but /m/pair", async () => {
    const res = await call(router, "POST", "/m/projects/clone", { url: "x" });
    expect(res.status).toBe(401);
  });

  it("passes a host that has no such route through as 404, not as a 500", async () => {
    // A desktop predates these routes entirely. The phone must read that as *not here*.
    build({ cloneProject: async () => { throw new ApiError(404, "Not Found"); } });
    const bearer = await token();

    const res = await call(router, "POST", "/m/projects/clone", { url: "x" }, bearer);
    expect(res.status).toBe(404);
  });

  it("forwards a browse, and passes the jail's refusal through as 403", async () => {
    const seenPaths: Array<string | undefined> = [];
    build({
      browse: async (path?: string) => {
        seenPaths.push(path);
        return { roots: [{ name: "workspaces", path: "/home/op/lotus-workspaces" }], page: null };
      },
    });
    const bearer = await token();

    const roots = await call(router, "GET", "/m/fs", undefined, bearer);
    expect(roots.status).toBe(200);
    expect(seenPaths).toEqual([undefined]);

    await call(router, "GET", "/m/fs?path=%2Fhome%2Fop", undefined, bearer);
    expect(seenPaths[1]).toBe("/home/op");

    build({ browse: async () => { throw new ApiError(403, "not inside an allowed root"); } });
    const second = await token();
    const walled = await call(router, "GET", "/m/fs?path=%2Fetc", undefined, second);
    expect(walled.status).toBe(403);
  });
});
