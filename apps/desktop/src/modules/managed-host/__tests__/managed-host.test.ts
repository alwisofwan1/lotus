import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  status: vi.fn(),
  step: vi.fn(),
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("@/lib/tauri/managed-host", () => ({ managedHostStatus: io.status, managedHostStep: io.step }));
vi.mock("@/lib/tauri-api", () => ({ getSettings: io.getSettings, saveSettings: io.saveSettings }));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true }));
vi.mock("@/modules/settings/services/settings-events", () => ({ emitLotusSettingsChanged: vi.fn() }));

import {
  compareVersions,
  hostKey,
  installHost,
  managedHostsSnapshot,
  offerFor,
  probeHost,
  resetManagedHostsForTest,
  type ManagedHostStatus,
} from "../managed-host";

const vps = { host: "devbox-vps" };
const st = (over: Partial<ManagedHostStatus> = {}): ManagedHostStatus => ({ os: "Linux", arch: "x64", kind: "none", version: null, running: false, ...over });
const entry = () => managedHostsSnapshot().hosts[hostKey(vps)]!;

describe("managed host offer", () => {
  it("compares release versions", () => {
    expect(compareVersions("0.15.0", "0.16.0")).toBe(-1);
    expect(compareVersions("0.16.0", "0.16.0")).toBe(0);
    expect(compareVersions("0.16.10", "0.16.9")).toBe(1);
  });

  it("offers install on a bare Linux machine, update when older, never a downgrade or a manual host", () => {
    expect(offerFor(st(), "0.16.0")).toBe("install");
    expect(offerFor(st({ kind: "managed", version: "0.15.0" }), "0.16.0")).toBe("update");
    expect(offerFor(st({ kind: "managed", version: "0.16.0" }), "0.16.0")).toBeNull();
    expect(offerFor(st({ kind: "managed", version: "0.17.0" }), "0.16.0")).toBeNull();
    expect(offerFor(st({ kind: "manual", version: "abc" }), "0.16.0")).toBeNull();
    expect(offerFor(st({ arch: null, os: "Darwin" }), "0.16.0")).toBeNull();
    expect(offerFor(st(), null)).toBeNull();
  });
});

describe("managed host steps", () => {
  beforeEach(() => {
    resetManagedHostsForTest();
    localStorage.setItem("lotus:managed-host-dev-version", "0.16.0");
    io.status.mockReset();
    io.step.mockReset().mockResolvedValue(undefined);
    io.getSettings.mockReset().mockResolvedValue({});
    io.saveSettings.mockReset().mockResolvedValue(undefined);
  });

  it("starts a Managed Host that is installed but stopped, and remembers the machine", async () => {
    io.status.mockResolvedValue(st({ kind: "managed", version: "0.16.0", running: false }));
    await probeHost(vps);
    expect(io.step).toHaveBeenCalledWith(vps, "start", "0.16.0");
    expect(entry().status?.running).toBe(true);
    expect(io.saveSettings.mock.calls[0]![0]).toEqual({ codespace: { managedHosts: { "devbox-vps": { host: "devbox-vps" } } } });
  });

  it("runs every step in order and refreshes the status", async () => {
    io.status.mockResolvedValueOnce(st()).mockResolvedValue(st({ kind: "managed", version: "0.16.0", running: true }));
    await probeHost(vps);
    await installHost(vps);
    expect(io.step.mock.calls.map((c) => c[1])).toEqual(["download", "check", "install", "start", "health"]);
    expect(entry().failure).toBeNull();
    expect(entry().status?.version).toBe("0.16.0");
  });

  it("rolls back when the health check fails, and keeps the machine's log", async () => {
    io.status.mockResolvedValueOnce(st({ kind: "managed", version: "0.15.0", running: true })).mockResolvedValue(st({ kind: "managed", version: "0.15.0", running: true }));
    io.step.mockImplementation(async (_t: unknown, step: string) => {
      if (step === "health") throw new Error("The host did not answer within 15 s.");
    });
    await probeHost(vps);
    await installHost(vps);
    expect(io.step.mock.calls.map((c) => c[1])).toEqual(["download", "check", "install", "start", "health", "restore"]);
    expect(entry().failure).toBe("Health failed. The host did not answer within 15 s.");
    expect(entry().done).toEqual(["download", "check", "install", "start"]);
  });

  it("does not roll back a failed download: nothing was replaced", async () => {
    io.status.mockResolvedValue(st());
    io.step.mockImplementation(async (_t: unknown, step: string) => {
      if (step === "download") throw new Error("no network");
    });
    await probeHost(vps);
    await installHost(vps);
    expect(io.step.mock.calls.map((c) => c[1])).toEqual(["download"]);
  });
});
