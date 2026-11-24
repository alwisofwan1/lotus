import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVICE_TOKEN_TTL_MS } from "../constants.js";
import { DeviceStore } from "../device-store.js";
import { MAX_PAIRING_ATTEMPTS, PairingService } from "../pairing.js";
import { buildMobileRouter, INTERRUPT_SEQUENCE, PAIR_RATE_CAPACITY } from "../http-routes.js";
import { MAX_INPUT_CHARS } from "../cell-routes.js";
import type { MobileRouterDeps } from "../http-routes.js";
import { ApiError } from "../../../core/api-error.js";
import { call } from "./support/call.js";

function fakeApi(): MobileRouterDeps["api"] {
  return {
    listFleet: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
    listWorkspaces: vi.fn().mockResolvedValue({ items: [] }),
    // A desktop's shape: `{ items }` with the same `workspaceId` key its cells
    // carry. The dormant project here has no cell in `listFleet` above, which is
    // the case the whole route exists for (ADR-14).
    listProjects: vi.fn().mockResolvedValue({
      items: [
        { workspaceId: "canvas:cp_1", name: "codespace-demo", path: "/Users/op/code/demo", lastOpenedAt: 20 },
        { workspaceId: "canvas:cp_2", name: "terax-ai", path: "/Users/op/code/terax-ai", lastOpenedAt: 10 },
      ],
    }),
    listRunners: vi.fn().mockResolvedValue({ items: [] }),
    listTasks: vi.fn().mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 }),
    createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
    updateTask: vi.fn().mockResolvedValue({ id: "task-1" }),
    dispatchToCell: vi.fn().mockResolvedValue({ paneId: "p-1", bytesWritten: 4, tailPreview: "" }),
    writeToSession: vi.fn().mockResolvedValue(undefined),
    closeCell: vi.fn().mockResolvedValue(undefined),
    spawnCell: vi.fn().mockResolvedValue({ paneId: "p-new", provider: "claude" }),
    transcribeAudio: vi
      .fn()
      .mockResolvedValue({ text: "delete the legacy shim", provider: "openai" }),
    readCellPermission: vi.fn().mockResolvedValue({
      paneId: "p-1",
      awaiting: true,
      prompt: {
        question: "Do you want to create approved.txt?",
        options: [
          { key: "1", label: "Yes", selected: true },
          { key: "2", label: "Yes, allow all edits during this session (shift+tab)", selected: false },
          { key: "3", label: "No", selected: false },
        ],
      },
      readback:
        "Do you want to create approved.txt? Option 1: Yes. " +
        "Option 2: Yes, allow all edits during this session. Option 3: No.",
    }),
    readCellTranscript: vi.fn().mockResolvedValue({
      paneId: "p-1",
      total: 1,
      entries: [
        {
          event: "tool-pre",
          status: "running",
          title: "Bash",
          body: "",
          userPrompt: "clean up the legacy files",
          toolTarget: "src/legacy/shim.ts",
          linesAdded: 0,
          linesRemoved: 34,
          timestamp: 1785664800000,
        },
      ],
    }),
  } as unknown as MobileRouterDeps["api"];
}

describe("mobile HTTP routes", () => {
  let dir: string;
  let devices: DeviceStore;
  let pairing: PairingService;
  let api: MobileRouterDeps["api"];
  let audit: string[];
  let quickened: string[];
  let asked: string[];
  let router: ReturnType<typeof buildMobileRouter>;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lotus-routes-"));
    now = Date.parse("2026-08-02T10:00:00Z");
    devices = new DeviceStore(join(dir, "devices.json"), () => now);
    pairing = new PairingService(devices, () => now);
    api = fakeApi();
    audit = [];
    quickened = [];
    asked = [];
    router = buildMobileRouter({
      api,
      devices,
      pairing,
      host: { hostId: "mac", hostLabel: "MacBook", mode: "client" },
      audit: (event, fields) => audit.push(`${event}:${JSON.stringify(fields ?? {})}`),
      fleetSnapshot: async () => [
        { paneId: "p-1", workspaceId: "ws", agentType: "claude", title: "Chase", status: "live", isAlive: true, sessionId: "sess-1" },
      ],
      onInput: (paneId) => quickened.push(paneId),
      onAsk: (paneId) => asked.push(paneId),
    });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function pairedToken(): Promise<string> {
    const { code } = pairing.create();
    const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
    return (res.json as { deviceToken: string }).deviceToken;
  }

  describe("POST /m/pair", () => {
    it("exchanges a code for a token and reports the host identity", async () => {
      const { code } = pairing.create();

      const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ hostId: "mac", hostLabel: "MacBook", mode: "client" });
      expect((res.json as { deviceToken: string }).deviceToken).toBeDefined();
    });

    it("rejects a bad code with 401 and no token", async () => {
      const res = await call(router, "POST", "/m/pair", { pairingCode: "00000000", deviceName: "x" });

      expect(res.status).toBe(401);
      expect(devices.list()).toEqual([]);
    });

    /**
     * `issues/09`. Since `issues/07` chose a route with no Cloudflare Access in front
     * of it, `/m/pair` is the one unauthenticated door on the internet.
     */
    describe("throttling", () => {
      const from = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });

      async function guess(ip: string): Promise<number> {
        const res = await call(
          router, "POST", "/m/pair",
          { pairingCode: "00000000", deviceName: "x" }, undefined, from(ip),
        );
        return res.status;
      }

      it("answers 429 once one source has burned its budget", async () => {
        for (let i = 0; i < PAIR_RATE_CAPACITY; i += 1) {
          expect(await guess("203.0.113.9")).toBe(401);
        }

        expect(await guess("203.0.113.9")).toBe(429);
      });

      it("throttles per source, so one guesser does not lock out another", async () => {
        for (let i = 0; i < PAIR_RATE_CAPACITY + 3; i += 1) await guess("203.0.113.9");

        expect(await guess("198.51.100.1")).toBe(401);
      });

      it("does not spend the pairing attempt budget on a throttled request", async () => {
        // Would otherwise be a cheaper denial of service than the one being fixed: a
        // guesser throttled at the door could still drive the host into lockout.
        for (let i = 0; i < PAIR_RATE_CAPACITY + 20; i += 1) await guess("203.0.113.9");

        const { code } = pairing.create();
        const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });
        expect(res.status).toBe(200);
      });

      /**
       * The reason `PAIR_RATE_CAPACITY` sits below `MAX_PAIRING_ATTEMPTS`. Equal, this
       * would fail: the source would spend the last of the global budget on the same
       * request that throttles it, and every other caller would meet a lockout it caused
       * single-handedly.
       */
      it("does not let one source reach the global lockout by itself", async () => {
        expect(PAIR_RATE_CAPACITY).toBeLessThan(MAX_PAIRING_ATTEMPTS);
        const { code } = pairing.create();

        for (let i = 0; i < PAIR_RATE_CAPACITY + 10; i += 1) await guess("203.0.113.9");

        const res = await call(
          router, "POST", "/m/pair",
          { pairingCode: code, deviceName: "iPhone" }, undefined, from("198.51.100.1"),
        );
        expect(res.status).toBe(200);
      });

      it("says the lockout is a lockout rather than a wrong code", async () => {
        pairing.create();
        for (let i = 0; i < MAX_PAIRING_ATTEMPTS; i += 1) await guess(`203.0.113.${i}`);

        const res = await call(
          router, "POST", "/m/pair",
          { pairingCode: "00000000", deviceName: "x" }, undefined, from("198.51.100.7"),
        );

        expect(res.status).toBe(429);
        expect(audit.join("\n")).toMatch(/auth\.rejected.*locked/);
      });

      it("audits a refusal with the reason, not just the route", async () => {
        await guess("203.0.113.9");

        expect(audit.join("\n")).toMatch(/auth\.rejected.*\/m\/pair/);
      });
    });

    it("rejects a body without a pairing code", async () => {
      expect((await call(router, "POST", "/m/pair", { deviceName: "x" })).status).toBe(400);
    });

    it("is the one route reachable without a bearer", async () => {
      const { code } = pairing.create();

      const res = await call(router, "POST", "/m/pair", { pairingCode: code, deviceName: "iPhone" });

      expect(res.status).toBe(200);
    });
  });

  describe("authentication", () => {
    it.each([
      ["GET", "/m/bootstrap"],
      ["POST", "/m/cell/p-1/dispatch"],
      ["POST", "/m/cell/p-1/stop"],
      ["POST", "/m/cell/p-1/input"],
      ["DELETE", "/m/cell/p-1"],
      ["POST", "/m/cells"],
      ["GET", "/m/tasks?workspaceId=ws"],
      ["GET", "/m/devices"],
    ])("refuses %s %s without a bearer", async (method, path) => {
      expect((await call(router, method, path, {})).status).toBe(401);
    });

    it("refuses an expired bearer", async () => {
      const token = await pairedToken();

      now += DEVICE_TOKEN_TTL_MS + 60 * 60 * 1000;

      expect((await call(router, "GET", "/m/bootstrap", {}, token)).status).toBe(401);
    });

    it("records a rejected auth attempt in the audit trail", async () => {
      await call(router, "GET", "/m/bootstrap", {}, "bogus-token");

      expect(audit.some((line) => line.startsWith("auth.rejected"))).toBe(true);
    });
  });

  describe("GET /m/bootstrap", () => {
    it("returns fleet, workspaces, tasks and hostCaps in one round-trip", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/bootstrap?workspaceId=ws", {}, token);

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        cells: [],
        workspaces: [],
        activeTasks: [],
        hostCaps: { protocol: 1 },
      });
    });

    it("carries projects that have no cell at all", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/bootstrap", {}, token);

      // The fleet is empty here, so every one of these rows would be missing from
      // a list derived from cells — which is exactly how a project became
      // unreachable from the phone once its last agent ended.
      expect((res.json as { projects: unknown[] }).projects).toEqual([
        { workspaceId: "canvas:cp_1", name: "codespace-demo", path: "/Users/op/code/demo", lastOpenedAt: 20 },
        { workspaceId: "canvas:cp_2", name: "terax-ai", path: "/Users/op/code/terax-ai", lastOpenedAt: 10 },
      ]);
    });

    it("accepts a Standalone Host's bare array, and says it has no open times", async () => {
      const token = await pairedToken();
      // `PROJECTS_ROOT` scanning yields `HostedProject[]` — no envelope, no
      // `lastOpenedAt`, and `id` where a desktop sends `workspaceId`.
      (api.listProjects as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "api-service", name: "api-service", path: "/srv/api-service" },
      ]);

      const res = await call(router, "GET", "/m/bootstrap", {}, token);

      expect((res.json as { projects: unknown[] }).projects).toEqual([
        { workspaceId: "api-service", name: "api-service", path: "/srv/api-service", lastOpenedAt: 0 },
      ]);
    });

    it("treats a desktop without the route as one with no project registry", async () => {
      const token = await pairedToken();
      // 404 is "this desktop predates /api/projects", not "this desktop is broken":
      // the phone falls back to the pre-ADR-14 behaviour instead of failing to start.
      (api.listProjects as ReturnType<typeof vi.fn>).mockRejectedValue(new ApiError(404, "Not Found"));

      const res = await call(router, "GET", "/m/bootstrap", {}, token);

      expect(res.status).toBe(200);
      expect((res.json as { projects: unknown[] }).projects).toEqual([]);
    });
  });

  describe("POST /m/cell/:paneId/dispatch", () => {
    it("forwards the text and audits the mutation with the device id", async () => {
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/cell/p-1/dispatch", { text: "go on" }, token);

      expect(res.status).toBe(200);
      expect(api.dispatchToCell).toHaveBeenCalledWith({ paneId: "p-1", command: "go on" });
      expect(audit.some((l) => l.startsWith("dispatch.executed") && l.includes("dev_"))).toBe(true);
    });

    it("tells the push policy this pane was asked from a phone", async () => {
      const token = await pairedToken();

      await call(router, "POST", "/m/cell/p-1/dispatch", { text: "go on" }, token);

      expect(asked).toEqual(["p-1"]);
    });

    it("rejects an empty text rather than writing a bare newline to the PTY", async () => {
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/cell/p-1/dispatch", { text: "   " }, token);

      expect(res.status).toBe(400);
      expect(api.dispatchToCell).not.toHaveBeenCalled();
    });
  });

  describe("POST /m/cell/:paneId/input", () => {
    /**
     * The whole reason this route exists beside `/dispatch`: dispatch is a sentence for
     * the agent and appends a submit key, this is a key press and must not.
     */
    it("writes the bytes exactly as given, with nothing appended", async () => {
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/cell/p-1/input", { data: "\u0014" }, token);

      expect(res.status).toBe(200);
      expect(api.writeToSession).toHaveBeenCalledWith("sess-1", "\u0014");
    });

    it("carries a multi-byte key as one write", async () => {
      const token = await pairedToken();

      // What an emulator emits for the up arrow — three bytes that are one key, and
      // splitting them would be three keys the TUI cannot read.
      await call(router, "POST", "/m/cell/p-1/input", { data: "\u001b[A" }, token);

      expect(api.writeToSession).toHaveBeenCalledWith("sess-1", "\u001b[A");
    });

    it("refuses an empty body rather than writing nothing", async () => {
      const token = await pairedToken();

      expect((await call(router, "POST", "/m/cell/p-1/input", { data: "" }, token)).status)
        .toBe(400);
    });

    it("refuses a body past the cap, which is a key press and not a paste", async () => {
      const token = await pairedToken();
      const huge = "x".repeat(MAX_INPUT_CHARS + 1);

      expect((await call(router, "POST", "/m/cell/p-1/input", { data: huge }, token)).status)
        .toBe(400);
      expect(api.writeToSession).not.toHaveBeenCalled();
    });

    it("404s for a pane with no live session", async () => {
      const token = await pairedToken();

      expect((await call(router, "POST", "/m/cell/nope/input", { data: "a" }, token)).status)
        .toBe(404);
    });

    it("tells the output tail to come back for the echo", async () => {
      const token = await pairedToken();

      await call(router, "POST", "/m/cell/p-1/input", { data: "l" }, token);

      // The echo is the whole felt latency of a keystroke: without this the tail waits
      // out its quiet 400ms before it even looks, and typing arrives in clumps.
      expect(quickened).toEqual(["p-1"]);
    });

    it("records the byte count and never the bytes", async () => {
      const token = await pairedToken();

      await call(router, "POST", "/m/cell/p-1/input", { data: "sudo rm" }, token);

      const entry = audit.find((line) => line.startsWith("cell.input"));
      expect(entry).toBeDefined();
      expect(entry).toContain('"bytes":7');
      // An audit trail that recorded keystrokes would be a keylogger with a good excuse.
      expect(entry).not.toContain("sudo");
    });
  });

  describe("POST /m/cell/:paneId/stop", () => {
    /**
     * Stop interrupts the current turn; it must not kill the session. ADR-8 made
     * this the least-gated mutation precisely because it is recoverable — killing
     * the PTY would not be.
     */
    it("sends an interrupt to the cell's session instead of killing it", async () => {
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/cell/p-1/stop", {}, token);

      expect(res.status).toBe(200);
      expect(api.writeToSession).toHaveBeenCalledWith("sess-1", INTERRUPT_SEQUENCE);
    });

    it("404s for a pane that is not in the fleet", async () => {
      const token = await pairedToken();

      expect((await call(router, "POST", "/m/cell/nope/stop", {}, token)).status).toBe(404);
    });
  });

  describe("POST /m/cells", () => {
    it("counts a spawn with a brief as an ask from the phone, and a bare spawn as none", async () => {
      const token = await pairedToken();

      await call(router, "POST", "/m/cells", { provider: "claude", initialPrompt: "tidy up" }, token);
      await call(router, "POST", "/m/cells", { provider: "claude" }, token);

      expect(asked).toEqual(["p-new"]);
    });

    it("forwards the runner, the brief and the posture the phone chose", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/cells",
        { provider: "claude", initialPrompt: "run the suite", permissionMode: "safe" },
        token,
      );

      expect(res.status).toBe(200);
      expect(api.spawnCell).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "claude",
          initialPrompt: "run the suite",
          permissionMode: "safe",
        }),
      );
    });

    it("forwards the model and effort the phone chose, and drops an empty choice", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/cells",
        { provider: "codex", model: "gpt-5.4-codex", effort: "  " },
        token,
      );

      expect(res.status).toBe(200);
      const sent = (api.spawnCell as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(sent["model"]).toBe("gpt-5.4-codex");
      // Nothing chosen is absent, not `""` — a flag with no value is what the CLI would refuse.
      expect(sent).not.toHaveProperty("effort");
    });

    it("forwards the chosen account to a terminal cell too (issues/07)", async () => {
      const token = await pairedToken();
      const res = await call(router, "POST", "/m/cells", { provider: "claude", profileId: "hss" }, token);
      expect(res.status).toBe(200);
      const sent = (api.spawnCell as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
      expect(sent["profileId"]).toBe("hss");
    });

    /**
     * The posture cannot be changed after the cell is born (ADR-8), so a value this
     * host does not understand must not become "whatever the runner defaults to" —
     * that is the one outcome the operator was never offered.
     */
    it("refuses a permission mode it does not understand instead of guessing", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/cells",
        { provider: "claude", permissionMode: "maybe" },
        token,
      );

      expect(res.status).toBe(400);
      expect(api.spawnCell).not.toHaveBeenCalled();
    });

    /**
     * The point of advertising a scale: a stop the phone read out of `bootstrap.runners[]`
     * has to survive the round trip. Before 2026-08-27 this answered 400 to every value but
     * `safe`/`yolo`, so the sheet could only ever have offered two.
     */
    it("forwards a stop from the runner's own advertised scale", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/cells",
        { provider: "claude", permissionMode: "acceptEdits" },
        token,
      );

      expect(res.status).toBe(200);
      expect(api.spawnCell).toHaveBeenCalledWith(
        expect.objectContaining({ permissionMode: "acceptEdits" }),
      );
    });

    /**
     * The pair predates the scale and is still the whole vocabulary of the MCP spawn tool and
     * of every phone built before it, so widening the set must not have narrowed it.
     */
    it("still takes the legacy pair", async () => {
      const token = await pairedToken();

      for (const mode of ["safe", "yolo"]) {
        const res = await call(router, "POST", "/m/cells", { provider: "claude", permissionMode: mode }, token);
        expect(res.status, mode).toBe(200);
      }
    });

    it("needs a runner named", async () => {
      const token = await pairedToken();

      expect((await call(router, "POST", "/m/cells", { provider: "  " }, token)).status).toBe(400);
    });
  });

  describe("DELETE /m/cell/:paneId", () => {
    it("asks the desktop to end the cell and audits who did it", async () => {
      const token = await pairedToken();

      const res = await call(router, "DELETE", "/m/cell/p-1", undefined, token);

      expect(res.status).toBe(200);
      expect(api.closeCell).toHaveBeenCalledWith("p-1");
      expect(audit.some((line) => line.startsWith("cell.closed") && line.includes("p-1"))).toBe(true);
    });

    /**
     * The desktop answers 503 when its window is not sitting on a workspace, which is
     * the one refusal the operator can act on. Turning it into a 500 here would send
     * them looking for a broken machine instead of an unopened window.
     */
    it("passes the desktop's 503 through instead of dressing it as a fault", async () => {
      const token = await pairedToken();
      (api.closeCell as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new ApiError(503, "no active Lotus workspace UI — open the Lotus window on a workspace"),
      );

      const res = await call(router, "DELETE", "/m/cell/p-1", undefined, token);

      expect(res.status).toBe(503);
      expect(String((res.json as { error: string }).error)).toContain("workspace");
    });

    /**
     * The bug this pair of tests exists for, measured on a phone 2026-08-27.
     *
     * The desktop refused a spawn with a 400 that named the field and the value. Only 503 was
     * forwarded, so it was rethrown, the router's catch-all swallowed it, and the operator
     * read `Internal Server Error` — for a message that told them exactly what was wrong.
     */
    it("passes the desktop's own refusal through, message and all", async () => {
      const token = await pairedToken();
      (api.spawnCell as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new ApiError(400, 'permissionMode must be "safe" or "yolo"'),
      );

      const res = await call(router, "POST", "/m/cells", { provider: "claude" }, token);

      expect(res.status).toBe(400);
      expect(String((res.json as { error: string }).error)).toContain("permissionMode");
    });

    /**
     * And the other half: the window's *own* trouble is not the phone's to read. A 500 there
     * says nothing a phone can act on, and forwarding whatever string it carried would leak
     * the machine's internals to a device that is not sitting in front of it.
     */
    it("keeps the desktop's 500 opaque rather than relaying it", async () => {
      const token = await pairedToken();
      (api.spawnCell as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new ApiError(500, "panicked at src/pty.rs:88"),
      );

      const res = await call(router, "POST", "/m/cells", { provider: "claude" }, token);

      expect(res.status).toBe(500);
      expect(String((res.json as { error?: string }).error ?? "")).not.toContain("pty.rs");
    });
  });

  describe("devices", () => {
    it("lists paired devices without token material", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/devices", {}, token);

      expect(res.status).toBe(200);
      expect(JSON.stringify(res.json)).not.toContain(token);
    });

    it("refreshes a bearer and invalidates the old one", async () => {
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/devices/refresh", {}, token);
      const next = (res.json as { deviceToken: string }).deviceToken;

      expect(res.status).toBe(200);
      expect(next).not.toBe(token);
      // The old bearer lives until the new one is presented — see `previousTokenHash`.
      expect((await call(router, "GET", "/m/bootstrap", {}, next)).status).toBe(200);
      expect((await call(router, "GET", "/m/bootstrap", {}, token)).status).toBe(401);
    });

    it("revokes another device and audits it", async () => {
      const token = await pairedToken();
      const other = devices.issue("iPad");

      const res = await call(router, "DELETE", `/m/devices/${other.deviceId}`, {}, token);

      expect(res.status).toBe(200);
      expect(devices.verify(other.token)).toBeNull();
      expect(audit.some((l) => l.startsWith("device.revoked"))).toBe(true);
    });
  });

  describe("push registration", () => {
    it("records where to wake the calling device", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/devices/push-token",
        { token: "fcm-registration-token", platform: "fcm" },
        token,
      );

      expect(res.status).toBe(200);
      expect(devices.withPushToken()).toEqual([
        { deviceId: devices.list()[0]!.deviceId, pushToken: "fcm-registration-token" },
      ]);
    });

    it("registers against the bearer, so one phone cannot claim another's wake-ups", async () => {
      const mine = await pairedToken();
      const other = devices.issue("iPad");

      await call(router, "POST", "/m/devices/push-token", { token: "tok-mine" }, mine);

      // The body carries no deviceId at all, and this is why: with one, a paired phone
      // could point another device's notifications at itself.
      const targets = devices.withPushToken();
      expect(targets).toHaveLength(1);
      expect(targets[0]!.deviceId).not.toBe(other.deviceId);
    });

    it("never writes the registration token into the audit trail", async () => {
      const token = await pairedToken();

      await call(router, "POST", "/m/devices/push-token", { token: "tok-capability" }, token);

      expect(audit.some((l) => l.startsWith("device.push_registered"))).toBe(true);
      expect(audit.join(" ")).not.toContain("tok-capability");
    });

    it("refuses a platform this host cannot send to, rather than accepting it quietly", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/devices/push-token",
        { token: "tok", platform: "apns" },
        token,
      );

      // ADR-9 defers iOS. Accepting `apns` would leave an operator with a phone that
      // registered successfully and never rings.
      expect(res.status).toBe(400);
      expect(devices.withPushToken()).toEqual([]);
    });

    it("requires a token, and bounds how long it may be", async () => {
      const token = await pairedToken();

      expect((await call(router, "POST", "/m/devices/push-token", {}, token)).status).toBe(400);
      expect(
        (await call(router, "POST", "/m/devices/push-token", { token: "" }, token)).status,
      ).toBe(400);
      expect(
        (
          await call(
            router,
            "POST",
            "/m/devices/push-token",
            { token: "x".repeat(5000) },
            token,
          )
        ).status,
      ).toBe(400);
    });

    it("lets a device opt out again", async () => {
      const token = await pairedToken();
      await call(router, "POST", "/m/devices/push-token", { token: "tok" }, token);

      const res = await call(router, "DELETE", "/m/devices/push-token", {}, token);

      expect(res.status).toBe(200);
      expect(devices.withPushToken()).toEqual([]);
    });

    it("needs a bearer, like every route but pairing", async () => {
      expect((await call(router, "POST", "/m/devices/push-token", { token: "x" })).status).toBe(401);
      expect((await call(router, "DELETE", "/m/devices/push-token", {})).status).toBe(401);
    });
  });

  describe("hostCaps advertises push only when the host can send", () => {
    it("omits it when no FCM credentials loaded", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/bootstrap", {}, token);

      // The silent failure this prevents: an app that registers a token with a host
      // that cannot send, then waits for wake-ups that can never arrive.
      expect((res.json as { hostCaps: { features: string[] } }).hostCaps.features).not.toContain(
        "push",
      );
    });
  });

  describe("tasks", () => {
    it("requires workspaceId on list rather than guessing one", async () => {
      const token = await pairedToken();

      expect((await call(router, "GET", "/m/tasks", {}, token)).status).toBe(400);
    });

    it("creates a task and audits the mutation", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/tasks",
        { workspaceId: "ws", title: "t", goal: "g" },
        token,
      );

      expect(res.status).toBe(200);
      expect(audit.some((l) => l.startsWith("task.mutated"))).toBe(true);
    });
  });

  describe("POST /m/stt", () => {
    it("requires a device token", async () => {
      const res = await call(router, "POST", "/m/stt", { audioBase64: "AAA", mime: "audio/webm" });
      expect(res.status).toBe(401);
    });

    it("returns the transcript and which provider produced it", async () => {
      const token = await pairedToken();

      const res = await call(
        router,
        "POST",
        "/m/stt",
        { audioBase64: "AAAA", mime: "audio/webm", prompt: "tailnet rmeta" },
        token,
      );

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ text: "delete the legacy shim", provider: "openai" });
    });

    it("rejects a request with no audio rather than paying a provider for silence", async () => {
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/stt", { mime: "audio/webm" }, token);

      expect(res.status).toBe(400);
      expect(api.transcribeAudio).not.toHaveBeenCalled();
    });

    // The audio itself must never reach the log — it is the operator's voice, and
    // the byte count is all a trail needs to be useful.
    it("audits the request by size, not by content", async () => {
      const token = await pairedToken();

      await call(router, "POST", "/m/stt", { audioBase64: "AAAA", mime: "audio/webm" }, token);

      const line = audit.find((l) => l.startsWith("dictation.requested"));
      expect(line).toBeDefined();
      expect(line).not.toContain("AAAA");
      expect(line).toContain("bytes");
    });

    /**
     * A host set to transcribe on the device answers 503 (`ApiError::unavailable`),
     * and that is a fork rather than a fault: the phone records again with its own
     * recognizer. Same discipline as `transcript` and `permission` — "cannot" and
     * "broken" must not look the same.
     */
    it("turns a device-only host into an answer the phone can act on", async () => {
      (api.transcribeAudio as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiError(503, "no server-side STT provider active"),
      );
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/stt", { audioBase64: "AAAA", mime: "audio/webm" }, token);

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ text: null, hostSupports: false });
    });

    /**
     * Found by the first smoke run against a live host, and it is the same gap the
     * `transcript` route already handles: a desktop older than `/api/stt/transcribe`
     * answers 404, and forwarding that as 500 tells the phone "broken" when the truth
     * is "not here". ADR-10 says the app must survive a host that is older, so this
     * degrades exactly like `hostSupports: false` does elsewhere.
     */
    it("an older desktop with no STT route forks to the device, not to a 500", async () => {
      (api.transcribeAudio as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiError(404, "Not Found"),
      );
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/stt", { audioBase64: "AAAA", mime: "audio/webm" }, token);

      expect(res.status).toBe(200);
      expect(res.json).toEqual({ text: null, hostSupports: false });
    });

    it("still fails loudly when the provider itself breaks", async () => {
      (api.transcribeAudio as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiError(500, "openai failed (HTTP 401): bad key"),
      );
      const token = await pairedToken();

      const res = await call(router, "POST", "/m/stt", { audioBase64: "AAAA", mime: "audio/webm" }, token);

      expect(res.status).toBe(500);
    });
  });

  describe("permission", () => {
    it("requires a device token", async () => {
      const res = await call(router, "GET", "/m/cell/p-1/permission");
      expect(res.status).toBe(401);
    });

    // The labels are the safety property: the operator reads Claude's own words,
    // so a paraphrase we invented can never stand between them and the action.
    it("passes the options through verbatim, digits included", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/cell/p-1/permission", undefined, token);

      expect(res.status).toBe(200);
      const body = res.json as {
        awaiting: boolean;
        prompt: { options: Array<{ key: string; label: string }> };
      };
      expect(body.awaiting).toBe(true);
      expect(body.prompt.options.map((o) => o.key)).toEqual(["1", "2", "3"]);
      expect(body.prompt.options[2]?.label).toBe("No");
    });

    // The property that makes hands-free safe: what the operator HEARS contains
    // the same words as what they would PRESS. If the read-back paraphrased, a
    // walking operator would be agreeing to a summary of the decision.
    it("speaks the same words the buttons carry", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/cell/p-1/permission", undefined, token);

      const body = res.json as {
        readback: string;
        prompt: { question: string; options: Array<{ label: string }> };
      };
      expect(body.readback).toContain(body.prompt.question);
      for (const option of body.prompt.options) {
        // The ONE allowed difference: a parenthesised keyboard chord is dropped,
        // because "(shift+tab)" is noise aloud and changes nothing about the
        // choice. Everything else must survive word for word.
        const spoken = option.label.replace(/\s*\((?:shift|ctrl|cmd|alt|opt|tab|esc|enter|return|space)(?:[+-](?:shift|ctrl|cmd|alt|opt|tab|esc|enter|return|space))*\)/gi, "");
        expect(body.readback).toContain(spoken);
      }
    });
  });

  // Reproduced live: a desktop whose API predates these routes (and every
  // Standalone Host, which has no hook pipeline) answered 404, the ApiError
  // propagated, and the Router turned it into a 500. The phone saw a fault where
  // the truth was "this host cannot do that".
  describe("a host whose API lacks the route", () => {
    beforeEach(() => {
      const notFound = new ApiError(404, "Not Found");
      (api.readCellTranscript as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
      (api.readCellPermission as ReturnType<typeof vi.fn>).mockRejectedValue(notFound);
    });

    it("answers an empty transcript, not a 500", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/cell/p-1/transcript", undefined, token);

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ total: 0, entries: [], hostSupports: false });
    });

    it("answers not-awaiting with hostSupports false, not a 500", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/cell/p-1/permission", undefined, token);

      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ awaiting: false, prompt: null, hostSupports: false });
    });

    // "Cannot" and "broken" must not look the same, or a real outage reads as an
    // unsupported host and nobody investigates.
    it("still fails loudly for any status other than 404", async () => {
      (api.readCellTranscript as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ApiError(503, "Service Unavailable"),
      );
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/cell/p-1/transcript", undefined, token);

      expect(res.status).toBe(500);
    });
  });

  describe("transcript", () => {
    it("requires a device token like every other guarded route", async () => {
      const res = await call(router, "GET", "/m/cell/p-1/transcript");
      expect(res.status).toBe(401);
    });

    // Chat mode has to render something for an agent that is blocked and therefore
    // emitting nothing new; the transcript is where that something comes from.
    it("returns the recorded hook events for a pane", async () => {
      const token = await pairedToken();

      const res = await call(router, "GET", "/m/cell/p-1/transcript", undefined, token);

      expect(res.status).toBe(200);
      const body = res.json as {
        total: number;
        entries: Array<{ toolTarget: string; linesRemoved?: number }>;
      };
      expect(body.total).toBe(1);
      expect(body.entries[0]?.toolTarget).toBe("src/legacy/shim.ts");
      // The counts the capture spike unlocked: real data now, not a mockup label.
      expect(body.entries[0]?.linesRemoved).toBe(34);
    });

    it("passes the pane id through to the desktop API", async () => {
      const token = await pairedToken();

      await call(router, "GET", "/m/cell/node%2Fatlas/transcript", undefined, token);

      // No page asked for, so none is invented: the desktop then serves its own default.
      expect(api.readCellTranscript).toHaveBeenCalledWith("node/atlas", {});
    });

    it("forwards the page cursor rather than re-deriving one", async () => {
      const token = await pairedToken();

      await call(router, "GET", "/m/cell/p-1/transcript?before=60&limit=20", undefined, token);

      // This route is a façade. A cursor it computed itself would be a second opinion
      // about a file only the desktop reads.
      expect(api.readCellTranscript).toHaveBeenCalledWith("p-1", { before: 60, limit: 20 });
    });

    it("drops a cursor that is not a number instead of passing nonsense on", async () => {
      const token = await pairedToken();

      await call(router, "GET", "/m/cell/p-1/transcript?before=abc&limit=-5", undefined, token);

      expect(api.readCellTranscript).toHaveBeenCalledWith("p-1", {});
    });
  });
});
