import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  getHostRuntimeConfig: vi.fn(),
  saveHostRuntimeConfig: vi.fn(),
  applyHostRuntime: vi.fn(),
  getHostRuntimeStatus: vi.fn(),
  listBindCandidates: vi.fn(),
  listMobileDevices: vi.fn(),
  revokeMobileDevice: vi.fn(),
  createPairingCode: vi.fn(),
  getMobileReachability: vi.fn(),
};

// `importOriginal` keeps the real `AdminCallError`: the hook narrows on
// `instanceof`, so a stubbed class would make that branch untestable.
vi.mock("@/lib/tauri/host-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauri/host-runtime")>()),
  getHostRuntimeConfig: () => api.getHostRuntimeConfig(),
  saveHostRuntimeConfig: (c: unknown) => api.saveHostRuntimeConfig(c),
  applyHostRuntime: () => api.applyHostRuntime(),
  getHostRuntimeStatus: () => api.getHostRuntimeStatus(),
  listBindCandidates: () => api.listBindCandidates(),
  listMobileDevices: () => api.listMobileDevices(),
  revokeMobileDevice: (id: string) => api.revokeMobileDevice(id),
  createPairingCode: () => api.createPairingCode(),
  getMobileReachability: () => api.getMobileReachability(),
}));

const { useMobileAccess } = await import("@/modules/codecanvas/hooks/useMobileAccess");

const device = (deviceId: string, name: string) => ({
  deviceId,
  name,
  pairedAt: 0,
  expiresAt: 0,
  hardExpiresAt: 0,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  for (const fn of Object.values(api)) fn.mockReset();
  api.getHostRuntimeStatus.mockResolvedValue({ kind: "idle" });
  api.getHostRuntimeConfig.mockResolvedValue({
    enabled: false,
    default_provider: null,
    bind_address: null,
  });
  api.saveHostRuntimeConfig.mockResolvedValue(undefined);
  api.applyHostRuntime.mockResolvedValue({ kind: "running", pid: 1 });
  api.listBindCandidates.mockResolvedValue([]);
  api.listMobileDevices.mockResolvedValue([]);
  api.getMobileReachability.mockResolvedValue({
    bound: false,
    reachableByPhone: false,
    address: null,
    deviceCount: 0,
  });
});

afterEach(() => vi.useRealTimers());

describe("useMobileAccess", () => {
  it("loads status, candidates, devices and reachability on mount", async () => {
    api.listMobileDevices.mockResolvedValue([device("d-1", "iPhone")]);

    const { result } = renderHook(() => useMobileAccess());

    await waitFor(() => expect(result.current.devices).toHaveLength(1));
    expect(api.getHostRuntimeStatus).toHaveBeenCalled();
    expect(api.listBindCandidates).toHaveBeenCalled();
    expect(api.getMobileReachability).toHaveBeenCalled();
  });

  // A pairing code lives 5 minutes and the mockup shows the remaining time as a
  // line of text rather than a spinner, so the hook has to expose seconds.
  it("counts the pairing code down and drops it at zero", async () => {
    const now = Date.now();
    api.createPairingCode.mockResolvedValue({ code: "12345678", expiresAt: now + 3_000 });

    const { result } = renderHook(() => useMobileAccess());
    await act(async () => {
      await result.current.requestPairingCode();
    });

    expect(result.current.pairing?.code).toBe("12345678");
    expect(result.current.pairing?.secondsLeft).toBeGreaterThan(0);

    await act(async () => {
      vi.advanceTimersByTime(3_500);
    });

    // Gone, not frozen at zero: an expired code on screen is an invitation to
    // type something that will be rejected.
    expect(result.current.pairing).toBeNull();
  });

  it("surfaces a not-running host as a reason the UI can act on", async () => {
    const { AdminCallError } = await import("@/lib/tauri/host-runtime");
    api.createPairingCode.mockRejectedValue(new AdminCallError("not-running", "off"));

    const { result } = renderHook(() => useMobileAccess());
    await act(async () => {
      await result.current.requestPairingCode();
    });

    expect(result.current.pairingError).toBe("not-running");
    expect(result.current.pairing).toBeNull();
  });

  // Arming is per-device: arming one row must not arm the others, or the second
  // click lands on whichever row the operator happens to be over.
  it("arms revoke for one device at a time", async () => {
    api.listMobileDevices.mockResolvedValue([device("d-1", "A"), device("d-2", "B")]);

    const { result } = renderHook(() => useMobileAccess());
    await waitFor(() => expect(result.current.devices).toHaveLength(2));

    act(() => result.current.armRevoke("d-1"));
    expect(result.current.armedDeviceId).toBe("d-1");

    act(() => result.current.armRevoke("d-2"));
    expect(result.current.armedDeviceId).toBe("d-2");
  });

  it("disarms without revoking", async () => {
    api.listMobileDevices.mockResolvedValue([device("d-1", "A")]);
    const { result } = renderHook(() => useMobileAccess());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    act(() => result.current.armRevoke("d-1"));
    act(() => result.current.armRevoke(null));

    expect(result.current.armedDeviceId).toBeNull();
    expect(api.revokeMobileDevice).not.toHaveBeenCalled();
  });

  it("revokes, then re-reads the list rather than trusting local state", async () => {
    api.listMobileDevices.mockResolvedValueOnce([device("d-1", "A")]);
    api.revokeMobileDevice.mockResolvedValue(undefined);
    api.listMobileDevices.mockResolvedValueOnce([]);

    const { result } = renderHook(() => useMobileAccess());
    await waitFor(() => expect(result.current.devices).toHaveLength(1));

    await act(async () => {
      await result.current.revoke("d-1");
    });

    expect(api.revokeMobileDevice).toHaveBeenCalledWith("d-1");
    expect(result.current.devices).toEqual([]);
    expect(result.current.armedDeviceId).toBeNull();
  });

  // Reachability is the headline of the section, so the hook names the three
  // states rather than leaving the component to infer them from two booleans.
  it.each([
    [{ bound: false, reachableByPhone: false }, "not-running"],
    [{ bound: true, reachableByPhone: false }, "local-only"],
    [{ bound: true, reachableByPhone: true }, "reachable"],
  ])("derives %j into %s", async (health, expected) => {
    api.getMobileReachability.mockResolvedValue({
      ...health,
      address: health.bound ? { host: "x", port: 1 } : null,
      deviceCount: 0,
    });

    const { result } = renderHook(() => useMobileAccess());

    await waitFor(() => expect(result.current.reach).toBe(expected));
  });
});

describe("enabling the runtime", () => {
  // Saving alone changes nothing the operator can see: the supervisor only
  // reconciles on apply. A toggle that saved without applying would look broken
  // while being technically correct, so the two travel together.
  it("saves then applies, in that order", async () => {
    const order: string[] = [];
    api.saveHostRuntimeConfig.mockImplementation(() => {
      order.push("save");
      return Promise.resolve();
    });
    api.applyHostRuntime.mockImplementation(() => {
      order.push("apply");
      return Promise.resolve({ kind: "running", pid: 1 });
    });

    const { result } = renderHook(() => useMobileAccess());
    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(order).toEqual(["save", "apply"]);
    expect(api.saveHostRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  // A rejected bind address returns `misconfigured` instead of throwing, so a hook
  // that only awaited would report success and leave the operator guessing.
  it("surfaces misconfigured reasons rather than reporting success", async () => {
    api.applyHostRuntime.mockResolvedValue({
      kind: "misconfigured",
      reasons: ["Bind address `0.0.0.0:1` is not allowed"],
    });

    const { result } = renderHook(() => useMobileAccess());
    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(result.current.configErrors).toEqual(["Bind address `0.0.0.0:1` is not allowed"]);
  });

  it("clears earlier reasons once a later apply succeeds", async () => {
    api.applyHostRuntime.mockResolvedValueOnce({ kind: "misconfigured", reasons: ["bad"] });
    const { result } = renderHook(() => useMobileAccess());
    await act(async () => {
      await result.current.setEnabled(true);
    });
    expect(result.current.configErrors).toHaveLength(1);

    api.applyHostRuntime.mockResolvedValue({ kind: "running", pid: 1 });
    await act(async () => {
      await result.current.setEnabled(true);
    });

    expect(result.current.configErrors).toEqual([]);
  });

  it("keeps the runtime off when the operator turns it off", async () => {
    const { result } = renderHook(() => useMobileAccess());
    await act(async () => {
      await result.current.setEnabled(false);
    });

    expect(api.saveHostRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });
});

describe("choosing a bind address", () => {
  // The candidate carries a bare address and the config demands host:port, so the
  // hook must not hand Rust something its validator rejects.
  it("writes the candidate with a port and applies", async () => {
    const { result } = renderHook(() => useMobileAccess());

    await act(async () => {
      await result.current.selectBindAddress("100.64.0.2");
    });

    expect(api.saveHostRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ bind_address: "100.64.0.2:8787" }),
    );
    expect(api.applyHostRuntime).toHaveBeenCalled();
  });

  // Choosing an address is also how an operator turns it on: picking the tailnet
  // then having to find a separate switch would be two steps for one intent.
  it("enables the runtime as part of choosing an address", async () => {
    const { result } = renderHook(() => useMobileAccess());

    await act(async () => {
      await result.current.selectBindAddress("100.64.0.2");
    });

    expect(api.saveHostRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("preserves the provider override it did not set", async () => {
    api.getHostRuntimeConfig.mockResolvedValue({
      enabled: true,
      default_provider: "codex",
      bind_address: null,
    });
    const { result } = renderHook(() => useMobileAccess());
    await waitFor(() => expect(result.current.config.default_provider).toBe("codex"));

    await act(async () => {
      await result.current.selectBindAddress("100.64.0.2");
    });

    expect(api.saveHostRuntimeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ default_provider: "codex" }),
    );
  });
});
