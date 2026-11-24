import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const listSshHosts = vi.fn();
const machineAccessLogin = vi.fn();
vi.mock("@/lib/tauri-api", () => ({
  listSshHosts: (...args: unknown[]) => listSshHosts(...args),
  machineAccessLogin: (...args: unknown[]) => machineAccessLogin(...args),
}));

const { CanvasMachineStatus } = await import("../CanvasMachineStatus");

const OPEN = { state: "open" as const, ports: [9877] };

function setup(overrides: Partial<Parameters<typeof CanvasMachineStatus>[0]> = {}) {
  const props = {
    label: "devbox-vps",
    host: "devbox-vps",
    tunnel: OPEN,
    hooks: { state: "ready" as const },
    onRetry: vi.fn(),
    onRecheck: vi.fn(() => Promise.resolve()),
    onDisconnect: vi.fn(),
    placement: "up" as const,
    ...overrides,
  };
  render(<CanvasMachineStatus {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /devbox-vps/ }));
  return props;
}

describe("the machine popover (board 22)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listSshHosts.mockResolvedValue([]);
    machineAccessLogin.mockResolvedValue(null);
  });

  it("shows both promises and lets the operator recheck or let go of a healthy machine", async () => {
    const props = setup();
    const pop = screen.getByRole("dialog", { name: "Mesin devbox-vps" });
    expect(pop.textContent).toMatch(/Sambungan.*Terhubung/);
    expect(pop.textContent).toMatch(/Jalan pulang.*Terbuka/);

    fireEvent.click(screen.getByRole("button", { name: "Cek ulang mesin" }));
    expect(props.onRecheck).toHaveBeenCalledOnce();
    await screen.findByRole("button", { name: "Cek ulang mesin · selesai" });

    fireEvent.click(screen.getByRole("button", { name: "Putuskan" }));
    expect(props.onDisconnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a retry, not a disconnect, when the way home dropped", () => {
    const props = setup({ tunnel: { state: "failed", ports: [], detail: "remote port forwarding failed for listen port 9877" } });
    expect(screen.queryByRole("button", { name: "Putuskan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Coba lagi" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  /// Login lagi is only real for a machine behind Cloudflare Access; elsewhere it would do nothing.
  it("offers Login lagi on a failed connection only when the host has an Access sign-in", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps", accessHostname: "ssh.example.dev" }]);
    setup({ tunnel: { state: "failed", ports: [], detail: "SSH connection timed out after 35 s" } });
    expect(screen.getByRole("dialog").textContent).toMatch(/did not answer in time/);
    expect(screen.queryByRole("button", { name: "Cek ulang mesin" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Login lagi" }));
    expect(machineAccessLogin).toHaveBeenCalledWith("ssh.example.dev");
  });

  it("has no Login lagi for a plain ssh host", async () => {
    listSshHosts.mockResolvedValue([{ alias: "devbox-vps" }]);
    setup({ tunnel: { state: "failed", ports: [], detail: "Permission denied (publickey)." } });
    await waitFor(() => expect(listSshHosts).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Login lagi" })).toBeNull();
    expect(screen.getByRole("button", { name: "Coba lagi" })).toBeTruthy();
  });

  it("reconnects a machine the operator let go of", () => {
    const props = setup({ disconnected: true });
    fireEvent.click(screen.getByRole("button", { name: "Sambung lagi" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });
});
