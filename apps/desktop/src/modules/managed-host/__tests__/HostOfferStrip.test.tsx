import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markPlainSshSession, resetPlainSshSessionsForTest } from "@/lib/plain-ssh-sessions";
import type { HostEntry, ManagedHostStatus } from "../managed-host";

const hosts: { appVersion: string | null; hosts: Record<string, HostEntry> } = { appVersion: "1.4.0", hosts: {} };
const installHost = vi.fn();
const probeHost = vi.fn();

vi.mock("../managed-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../managed-host")>();
  return {
    ...actual,
    managedHostEnabled: () => true,
    useManagedHosts: () => hosts,
    installHost: (...args: unknown[]) => installHost(...args),
    probeHost: (...args: unknown[]) => probeHost(...args),
  };
});

import { HostOfferStrip, hostOfferFor } from "../HostOfferStrip";

const NONE: ManagedHostStatus = { os: "linux", arch: "x64", kind: "none", version: null, running: false };
const RUNNING: ManagedHostStatus = { os: "linux", arch: "x64", kind: "managed", version: "1.4.0", running: true };

function entry(change: Partial<HostEntry> = {}): HostEntry {
  return {
    target: { host: "devbox-vps", user: "dev" },
    status: NONE,
    probing: false,
    step: null,
    done: [],
    failure: null,
    notNow: false,
    dontAsk: false,
    ...change,
  };
}

describe("hostOfferFor", () => {
  it("offers the install on Canvas only: Code has its banner", () => {
    expect(hostOfferFor(entry(), "1.4.0", true)).toBe("install");
    expect(hostOfferFor(entry(), "1.4.0", false)).toBe("none");
  });

  it("'Not now' and 'Don't ask again' also quiet the Canvas offer", () => {
    expect(hostOfferFor(entry({ notNow: true }), "1.4.0", true)).toBe("none");
    expect(hostOfferFor(entry({ dontAsk: true }), "1.4.0", true)).toBe("none");
  });

  it("a running host offers to open the pane again, on both surfaces", () => {
    expect(hostOfferFor(entry({ status: RUNNING }), "1.4.0", false)).toBe("reopen");
    expect(hostOfferFor(entry({ status: RUNNING }), "1.4.0", true)).toBe("reopen");
    expect(hostOfferFor(entry({ status: { ...RUNNING, running: false } }), "1.4.0", false)).toBe("none");
  });

  it("Canvas carries the install's progress and failure", () => {
    expect(hostOfferFor(entry({ step: "install" }), "1.4.0", true)).toBe("installing");
    expect(hostOfferFor(entry({ step: "install" }), "1.4.0", false)).toBe("none");
    expect(hostOfferFor(entry({ failure: "Install failed." }), "1.4.0", true)).toBe("failed");
  });

  it("an unknown machine offers nothing", () => {
    expect(hostOfferFor(undefined, "1.4.0", true)).toBe("none");
    expect(hostOfferFor(entry({ status: null }), "1.4.0", true)).toBe("none");
  });
});

describe("HostOfferStrip", () => {
  beforeEach(() => {
    resetPlainSshSessionsForTest();
    installHost.mockReset();
    probeHost.mockReset();
    hosts.hosts = {};
  });

  it("says nothing on a pane that is not a plain ssh session", () => {
    hosts.hosts["dev@devbox-vps"] = entry({ status: RUNNING });
    render(<HostOfferStrip sessionId="daemon-1" onRelaunch={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a Canvas terminal asks its machine and offers the install", () => {
    markPlainSshSession("pty-1", { host: "devbox-vps", user: "dev" });
    hosts.hosts["dev@devbox-vps"] = entry();
    render(<HostOfferStrip sessionId="pty-1" canvas />);
    expect(probeHost).toHaveBeenCalledWith({ host: "devbox-vps", user: "dev", port: undefined });
    act(() => screen.getByRole("button", { name: "Pasang host" }).click());
    expect(installHost).toHaveBeenCalledWith({ host: "devbox-vps", user: "dev", port: undefined });
  });

  it("after the install, 'Buka lagi' opens the pane again, once", () => {
    markPlainSshSession("pty-2", { host: "devbox-vps", user: "dev" });
    hosts.hosts["dev@devbox-vps"] = entry({ status: RUNNING });
    const onRelaunch = vi.fn();
    render(<HostOfferStrip sessionId="pty-2" onRelaunch={onRelaunch} />);
    expect(screen.getByText(/agar pane ini tahan putus/)).toBeTruthy();
    const reopen = screen.getByRole("button", { name: "Buka lagi" });
    act(() => reopen.click());
    act(() => reopen.click());
    expect(onRelaunch).toHaveBeenCalledTimes(1);
  });

  it("a busy pane says its process will stop", () => {
    markPlainSshSession("pty-3", { host: "devbox-vps", user: "dev" });
    hosts.hosts["dev@devbox-vps"] = entry({ status: RUNNING });
    render(<HostOfferStrip sessionId="pty-3" busy onRelaunch={vi.fn()} />);
    expect(screen.getByText(/akan berhenti/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hentikan & buka lagi" })).toBeTruthy();
  });

  it("× closes the strip for that pane, and it stays closed", () => {
    markPlainSshSession("pty-4", { host: "devbox-vps", user: "dev" });
    hosts.hosts["dev@devbox-vps"] = entry({ status: RUNNING });
    const { unmount } = render(<HostOfferStrip sessionId="pty-4" onRelaunch={vi.fn()} />);
    act(() => screen.getByRole("button", { name: "Tutup" }).click());
    expect(screen.queryByRole("status")).toBeNull();
    unmount();
    render(<HostOfferStrip sessionId="pty-4" onRelaunch={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
