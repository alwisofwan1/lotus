import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  getSleepHold: vi.fn(),
};

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
  getSleepHold: () => api.getSleepHold(),
}));

const { MobileTab } = await import("@/modules/codecanvas/components/settings/tabs/MobileTab");

const health = (over: Partial<{ bound: boolean; reachableByPhone: boolean; host: string }> = {}) => ({
  bound: over.bound ?? false,
  reachableByPhone: over.reachableByPhone ?? false,
  address: over.bound === true ? { host: over.host ?? "127.0.0.1", port: 8787 } : null,
  deviceCount: 0,
});

const enabled = () => ({ enabled: true, default_provider: null, bind_address: null });
const disabled = () => ({ enabled: false, default_provider: null, bind_address: null });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getHostRuntimeStatus.mockResolvedValue({ kind: "idle" });
  api.getHostRuntimeConfig.mockResolvedValue(disabled());
  api.saveHostRuntimeConfig.mockResolvedValue(undefined);
  api.applyHostRuntime.mockResolvedValue({ kind: "running", pid: 1 });
  api.listBindCandidates.mockResolvedValue([]);
  api.listMobileDevices.mockResolvedValue([]);
  api.getMobileReachability.mockResolvedValue(health());
  api.getSleepHold.mockResolvedValue({ kind: "released" });
});

const toggle = () => screen.findByRole("switch", { name: /enable mobile access/i });

/**
 * A sleeping laptop and a dead tailnet look identical from the phone, so this tab is
 * where the difference has to be visible — before it is needed, not after.
 */
describe("whether the machine will still be awake", () => {
  it("says the hold is on, and that the lid still overrides it", async () => {
    api.getSleepHold.mockResolvedValue({ kind: "holding" });

    render(<MobileTab />);

    expect(await screen.findByText("This machine will not fall asleep")).toBeInTheDocument();
    // The half an operator acts on: without it they close the lid and trust the hold.
    expect(screen.getByText(/closing the lid still sleeps it/i)).toBeInTheDocument();
  });

  it("says so when the platform has no hold to give", async () => {
    api.getSleepHold.mockResolvedValue({ kind: "unsupported" });

    render(<MobileTab />);

    expect(await screen.findByText("This machine can still fall asleep")).toBeInTheDocument();
  });

  it("carries the reason a hold failed rather than a generic line", async () => {
    api.getSleepHold.mockResolvedValue({ kind: "failed", reason: "caffeinate not found" });

    render(<MobileTab />);

    expect(await screen.findByText(/caffeinate not found/)).toBeInTheDocument();
  });

  /// Nothing is being held and nothing claims to be — the row stays out of the way.
  it("says nothing at all while released", async () => {
    render(<MobileTab />);

    await screen.findByText("Not running");
    expect(screen.queryByText(/fall asleep/i)).not.toBeInTheDocument();
  });
});

describe("reachability leads", () => {
  it("says not running", async () => {
    render(<MobileTab />);
    expect(await screen.findByText("Not running")).toBeInTheDocument();
  });

  // The failure this tab exists to make visible: healthy-looking, and unreachable.
  it("names the loopback-only case instead of calling it running", async () => {
    api.getMobileReachability.mockResolvedValue(health({ bound: true, reachableByPhone: false }));

    render(<MobileTab />);

    expect(
      await screen.findByText("Running, but only this machine can reach it"),
    ).toBeInTheDocument();
  });

  it("shows the bound address so the claim is checkable", async () => {
    api.getMobileReachability.mockResolvedValue(
      health({ bound: true, reachableByPhone: true, host: "100.64.0.2" }),
    );

    render(<MobileTab />);

    expect(await screen.findByText(/100\.64\.0\.2:8787/)).toBeInTheDocument();
  });
});

describe("turning it on", () => {
  it("saves and applies", async () => {
    render(<MobileTab />);

    await userEvent.click(await toggle());

    await waitFor(() =>
      expect(api.saveHostRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
    expect(api.applyHostRuntime).toHaveBeenCalled();
  });

  it("reflects a config that is already on", async () => {
    api.getHostRuntimeConfig.mockResolvedValue(enabled());

    render(<MobileTab />);

    await waitFor(async () => expect(await toggle()).toHaveAttribute("aria-checked", "true"));
  });

  // A refused bind address answers `misconfigured` instead of throwing. Silence
  // would leave the operator staring at a switch that flipped and did nothing.
  it("shows why the runtime refused to start", async () => {
    api.applyHostRuntime.mockResolvedValue({
      kind: "misconfigured",
      reasons: ["Bind address `0.0.0.0:8787` is not allowed"],
    });

    render(<MobileTab />);
    await userEvent.click(await toggle());

    expect(await screen.findByText(/is not allowed/)).toBeInTheDocument();
  });
});

/**
 * 2026-10-04: macOS SIGKILLed the host on exec (invalid code signature), and the
 * tab said "Not running" — exactly what it says before anything started.
 */
describe("a runtime that died", () => {
  it("names macOS killing it on launch, distinct from never starting", async () => {
    api.getHostRuntimeConfig.mockResolvedValue(enabled());
    api.getHostRuntimeStatus.mockResolvedValue({ kind: "crashed", code: 137, last_lifetime_ms: 40 });

    render(<MobileTab />);

    expect(await screen.findByText("macOS stopped the runtime as it launched")).toBeInTheDocument();
    expect(screen.getByTestId("runtime-crashed").textContent).toMatch(/code signature/);
  });

  it("gives the exit code and lifetime for any other crash", async () => {
    api.getHostRuntimeConfig.mockResolvedValue(enabled());
    api.getHostRuntimeStatus.mockResolvedValue({ kind: "crashed", code: 1, last_lifetime_ms: 90_000 });

    render(<MobileTab />);

    expect(await screen.findByText("The runtime stopped")).toBeInTheDocument();
    expect(screen.getByTestId("runtime-crashed").textContent).toMatch(/code 1 after 2 min/);
  });

  // Turned off on purpose, a leftover crash record is history, not news.
  it("says nothing about a crash while mobile access is off", async () => {
    api.getHostRuntimeStatus.mockResolvedValue({ kind: "crashed", code: 137, last_lifetime_ms: 40 });

    render(<MobileTab />);
    await screen.findByText("Not running");

    expect(screen.queryByTestId("runtime-crashed")).not.toBeInTheDocument();
  });
});

describe("pairing", () => {
  // Gated behind the switch: offering an action that can only fail is worse than
  // pointing at the switch that fixes it.
  it("offers nothing to pair while the runtime is off", async () => {
    render(<MobileTab />);
    await toggle();

    expect(screen.queryByRole("button", { name: /pair a phone/i })).not.toBeInTheDocument();
  });

  // The category alone hid a three-week-stale port behind "could not reach".
  it("shows the backend's own words when a pairing call fails", async () => {
    const { AdminCallError } = await import("@/lib/tauri/host-runtime");
    api.getHostRuntimeConfig.mockResolvedValue(enabled());
    api.createPairingCode.mockRejectedValue(
      new AdminCallError("unknown", "admin channel is unreachable: Connection refused"),
    );

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: /pair a phone/i }));

    expect((await screen.findByTestId("pairing-error-detail")).textContent).toBe(
      "admin channel is unreachable: Connection refused",
    );
  });

  it("shows the code grouped in fours with a countdown", async () => {
    api.getHostRuntimeConfig.mockResolvedValue(enabled());
    api.createPairingCode.mockResolvedValue({ code: "12345678", expiresAt: Date.now() + 300_000 });

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: /pair a phone/i }));

    expect(await screen.findByText("1234 5678")).toBeInTheDocument();
    expect(screen.getByTestId("pairing-countdown").textContent).toMatch(/Expires in \d+m/);
  });

  // A code minted while bound to loopback is useless, and saying so on the code
  // beats letting the operator discover it on the phone.
  it("warns on the code itself when nothing can reach the runtime", async () => {
    api.getHostRuntimeConfig.mockResolvedValue(enabled());
    api.getMobileReachability.mockResolvedValue(health({ bound: true, reachableByPhone: false }));
    api.createPairingCode.mockResolvedValue({ code: "11112222", expiresAt: Date.now() + 60_000 });

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: /pair a phone/i }));

    expect(await screen.findByText(/will not help yet/i)).toBeInTheDocument();
  });

  it("publishes the code as a QR carrying the bound address", async () => {
    api.getHostRuntimeConfig.mockResolvedValue(enabled());
    api.getMobileReachability.mockResolvedValue(
      health({ bound: true, reachableByPhone: true, host: "192.168.1.11" }),
    );
    api.createPairingCode.mockResolvedValue({ code: "75447516", expiresAt: Date.now() + 300_000 });

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: /pair a phone/i }));

    // The payload itself, not just "a QR appeared": the phone reads this string, and
    // an address that disagreed with the one printed above would be a pairing that
    // fails with a diagnosis pointing at the network.
    const qr = await screen.findByTestId("pairing-qr");
    expect(qr.querySelector("svg")).not.toBeNull();
    expect(qr.textContent).toContain("Lotus pairing code");
  });

  // Loopback would encode `127.0.0.1`, and a phone dialling its own loopback fails in
  // a way that reads as a broken app rather than a wrong bind.
  it("shows no QR while nothing outside this machine can route to the bind", async () => {
    api.getHostRuntimeConfig.mockResolvedValue(enabled());
    api.getMobileReachability.mockResolvedValue(health({ bound: true, reachableByPhone: false }));
    api.createPairingCode.mockResolvedValue({ code: "11112222", expiresAt: Date.now() + 60_000 });

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: /pair a phone/i }));

    // The digits stay — the operator loses the shortcut, not the way in.
    expect(await screen.findByText("1111 2222")).toBeInTheDocument();
    expect(screen.queryByTestId("pairing-qr")).not.toBeInTheDocument();
  });
});

describe("bind picker", () => {
  const candidates = [
    { interface: "lo0", address: "127.0.0.1", reach: "loopback", recommended: false },
    { interface: "utun4", address: "100.64.0.2", reach: "tailnet", recommended: true },
  ];

  it("labels each candidate by who can reach it, not by interface alone", async () => {
    api.listBindCandidates.mockResolvedValue(candidates);

    render(<MobileTab />);

    expect(await screen.findByText(/this machine only/)).toBeInTheDocument();
    expect(screen.getByText(/your devices, over the tailnet/)).toBeInTheDocument();
    expect(screen.getByText("recommended")).toBeInTheDocument();
  });

  it("lets the operator pick an address, not just read it", async () => {
    api.listBindCandidates.mockResolvedValue(candidates);

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("radio", { name: /100\.64\.0\.2/ }));

    await waitFor(() =>
      expect(api.saveHostRuntimeConfig).toHaveBeenCalledWith(
        expect.objectContaining({ bind_address: "100.64.0.2:8787", enabled: true }),
      ),
    );
  });

  it("marks the address in use as selected", async () => {
    api.listBindCandidates.mockResolvedValue(candidates);
    api.getHostRuntimeConfig.mockResolvedValue({
      enabled: true,
      default_provider: null,
      bind_address: "100.64.0.2:8787",
    });

    render(<MobileTab />);

    const chosen = await screen.findByRole("radio", { name: /100\.64\.0\.2/ });
    await waitFor(() => expect(chosen).toHaveAttribute("aria-checked", "true"));
  });

  it("says when no tailnet exists, so the absence is not silent", async () => {
    api.listBindCandidates.mockResolvedValue([candidates[0]]);

    render(<MobileTab />);

    expect(await screen.findByText(/No tailnet interface found/)).toBeInTheDocument();
  });
});

describe("devices", () => {
  const device = (over: Partial<{ expiresAt: number }> = {}) => ({
    deviceId: "d-1",
    name: "iPhone",
    pairedAt: Date.now() - 1000,
    expiresAt: over.expiresAt ?? Date.now() + 3_600_000,
    hardExpiresAt: Date.now() + 30 * 86_400_000,
  });

  it("shows both expiries because only one of them is renewable", async () => {
    api.listMobileDevices.mockResolvedValue([device()]);

    render(<MobileTab />);

    expect(await screen.findByText(/session .* hard limit/)).toBeInTheDocument();
  });

  it("marks an expired session as needing refresh, not as revoked", async () => {
    api.listMobileDevices.mockResolvedValue([device({ expiresAt: Date.now() - 1000 })]);

    render(<MobileTab />);

    expect(await screen.findByText("needs refresh")).toBeInTheDocument();
  });

  // Two clicks, no dialog, and the confirm button names the device so the second
  // click cannot land on the wrong row.
  it("arms inline and names the device in the confirm button", async () => {
    api.listMobileDevices.mockResolvedValue([device()]);

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    expect(screen.getByRole("button", { name: "Revoke iPhone" })).toBeInTheDocument();
    expect(api.revokeMobileDevice).not.toHaveBeenCalled();
  });

  it("revokes only after the second, named click", async () => {
    api.listMobileDevices.mockResolvedValueOnce([device()]);
    api.revokeMobileDevice.mockResolvedValue(undefined);
    api.listMobileDevices.mockResolvedValue([]);

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Revoke iPhone" }));

    await waitFor(() => expect(api.revokeMobileDevice).toHaveBeenCalledWith("d-1"));
  });

  it("can be cancelled without revoking", async () => {
    api.listMobileDevices.mockResolvedValue([device()]);

    render(<MobileTab />);
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Revoke" })).toBeInTheDocument();
    expect(api.revokeMobileDevice).not.toHaveBeenCalled();
  });
});
