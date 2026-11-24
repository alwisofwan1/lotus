import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const isTauri = vi.fn(() => true);

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: () => isTauri(),
  tauriInvoke: (...args: unknown[]) => invoke(...args),
}));

const api = await import("@/lib/tauri/host-runtime");

beforeEach(() => {
  invoke.mockReset();
  isTauri.mockReturnValue(true);
});

describe("outside Tauri", () => {
  // The settings page renders in `next dev` too, where there is no backend. It
  // must show "not running" rather than throw on mount.
  beforeEach(() => isTauri.mockReturnValue(false));

  it("reports idle instead of throwing", async () => {
    await expect(api.getHostRuntimeStatus()).resolves.toEqual({ kind: "idle" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("offers no bind candidates", async () => {
    await expect(api.listBindCandidates()).resolves.toEqual([]);
  });

  it("reports no devices", async () => {
    await expect(api.listMobileDevices()).resolves.toEqual([]);
  });
});

describe("status", () => {
  // `#[serde(rename_all)]` renames variants, not the fields inside them, so this
  // field is snake_case while the tag is too. Pinned in Rust as well; a
  // camelCase guess here would read `undefined` and never say why.
  it("passes through the crashed shape verbatim, snake_case field included", async () => {
    invoke.mockResolvedValue({ kind: "crashed", code: 1, last_lifetime_ms: 900 });

    const status = await api.getHostRuntimeStatus();

    expect(status).toEqual({ kind: "crashed", code: 1, last_lifetime_ms: 900 });
  });
});

describe("pairing code", () => {
  it("returns the code and its expiry", async () => {
    invoke.mockResolvedValue({ code: "12345678", expiresAt: 1_800_000_000_000 });

    await expect(api.createPairingCode()).resolves.toEqual({
      code: "12345678",
      expiresAt: 1_800_000_000_000,
    });
    expect(invoke).toHaveBeenCalledWith("host_runtime_create_pairing_code");
  });

  // The host is not running at app start, and that is normal. The UI needs to
  // tell it apart from a real fault so it can say "turn it on" instead of "error".
  it("maps the not-advertised error to a typed reason", async () => {
    invoke.mockRejectedValue("host runtime has not advertised an admin channel yet");

    await expect(api.createPairingCode()).rejects.toMatchObject({
      reason: "not-running",
    });
  });

  it("keeps other failures as unknown rather than mislabelling them", async () => {
    invoke.mockRejectedValue("admin channel rejected the request with status 500");

    await expect(api.createPairingCode()).rejects.toMatchObject({ reason: "unknown" });
  });
});

describe("devices", () => {
  it("unwraps the items array the host returns", async () => {
    invoke.mockResolvedValue({
      items: [
        {
          deviceId: "d-1",
          name: "iPhone",
          pairedAt: 1,
          expiresAt: 2,
          hardExpiresAt: 3,
        },
      ],
    });

    const devices = await api.listMobileDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0]?.name).toBe("iPhone");
  });

  // A host that is off has no device list, and that is not an error the operator
  // needs to see: the section already says the runtime is off.
  it("returns an empty list when the host is not running", async () => {
    invoke.mockRejectedValue("host runtime has not advertised an admin channel yet");

    await expect(api.listMobileDevices()).resolves.toEqual([]);
  });

  it("still surfaces real failures when listing", async () => {
    invoke.mockRejectedValue("admin channel is unreachable: connection refused");

    await expect(api.listMobileDevices()).rejects.toMatchObject({ reason: "unknown" });
  });

  it("passes the device id as deviceId, the casing the command expects", async () => {
    invoke.mockResolvedValue({ ok: true, revoked: "d-1" });

    await api.revokeMobileDevice("d-1");

    expect(invoke).toHaveBeenCalledWith("host_runtime_revoke_device", { deviceId: "d-1" });
  });
});

describe("reachability", () => {
  // Bound to loopback the host looks healthy and no phone can reach it. That is
  // the failure this whole section exists to make visible, so it gets a name.
  it("calls a loopback bind not reachable", async () => {
    invoke.mockResolvedValue({
      ok: true,
      hostId: "mac",
      mode: "client",
      mobile: { host: "127.0.0.1", port: 8787 },
      deviceCount: 0,
    });

    const health = await api.getMobileReachability();

    expect(health).toMatchObject({ bound: true, reachableByPhone: false });
  });

  it("calls a tailnet bind reachable", async () => {
    invoke.mockResolvedValue({
      ok: true,
      hostId: "mac",
      mode: "client",
      mobile: { host: "100.64.0.2", port: 8787 },
      deviceCount: 1,
    });

    await expect(api.getMobileReachability()).resolves.toMatchObject({
      bound: true,
      reachableByPhone: true,
    });
  });

  it("reports not bound when the façade never came up", async () => {
    invoke.mockResolvedValue({ ok: true, hostId: "mac", mode: "client", mobile: null });

    await expect(api.getMobileReachability()).resolves.toMatchObject({
      bound: false,
      reachableByPhone: false,
    });
  });

  it("reports not bound when the host is off, without raising", async () => {
    invoke.mockRejectedValue("host runtime has not advertised an admin channel yet");

    await expect(api.getMobileReachability()).resolves.toMatchObject({ bound: false });
  });
});

describe("config", () => {
  // snake_case, matching Rust: `HostRuntimeConfig` has no `rename_all`, unlike the
  // tagged status enum next to it. Pinned on the Rust side too.
  it("passes the snake_case config through untouched", async () => {
    invoke.mockResolvedValue({
      enabled: true,
      default_provider: null,
      bind_address: "100.64.0.2:8787",
    });

    await expect(api.getHostRuntimeConfig()).resolves.toEqual({
      enabled: true,
      default_provider: null,
      bind_address: "100.64.0.2:8787",
    });
  });

  it("reports a disabled config outside Tauri instead of throwing", async () => {
    isTauri.mockReturnValue(false);

    await expect(api.getHostRuntimeConfig()).resolves.toMatchObject({ enabled: false });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("sends the config under the key the command expects", async () => {
    invoke.mockResolvedValue(undefined);
    const config = { enabled: true, default_provider: null, bind_address: null };

    await api.saveHostRuntimeConfig(config);

    expect(invoke).toHaveBeenCalledWith("host_runtime_save_config", { config });
  });

  // Saving alone does nothing visible — the supervisor only reconciles on apply.
  // A UI that saved without applying would look broken while being "correct".
  it("applies and returns the resolved status", async () => {
    invoke.mockResolvedValue({ kind: "running", pid: 42 });

    await expect(api.applyHostRuntime()).resolves.toEqual({ kind: "running", pid: 42 });
    expect(invoke).toHaveBeenCalledWith("host_runtime_apply");
  });

  // A rejected bind address comes back as `misconfigured` with reasons, not as a
  // thrown error, so the UI must be able to render them.
  it("surfaces a misconfigured result rather than treating it as success", async () => {
    invoke.mockResolvedValue({
      kind: "misconfigured",
      reasons: ["Bind address `0.0.0.0:1` is not allowed"],
    });

    const status = await api.applyHostRuntime();

    expect(status.kind).toBe("misconfigured");
    expect(status.kind === "misconfigured" && status.reasons[0]).toMatch(/not allowed/);
  });

  it("refuses to pretend it applied outside Tauri", async () => {
    isTauri.mockReturnValue(false);

    await expect(api.applyHostRuntime()).rejects.toThrow(/Lotus/);
  });
});

describe("bindAddressFor", () => {
  // Candidates carry a bare address; the config demands `host:port` and validates
  // it, so the port has to come from somewhere. 8787 is the host's own fallback
  // (`packages/host/src/core/config.ts`), not a number picked here.
  it("appends the host's default port", () => {
    expect(api.bindAddressFor("100.64.0.2")).toBe("100.64.0.2:8787");
  });

  it("leaves an address that already carries a port alone", () => {
    expect(api.bindAddressFor("100.64.0.2:9999")).toBe("100.64.0.2:9999");
  });

  // IPv6 has colons of its own, so a naive "contains a colon" check would refuse
  // to add the port and hand Rust something its validator rejects.
  it("brackets an IPv6 address before adding the port", () => {
    expect(api.bindAddressFor("fd7a:115c::1")).toBe("[fd7a:115c::1]:8787");
  });

  it("leaves an already-bracketed IPv6 address with a port alone", () => {
    expect(api.bindAddressFor("[fd7a:115c::1]:8787")).toBe("[fd7a:115c::1]:8787");
  });
});
