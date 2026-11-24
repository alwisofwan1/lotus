import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const machineTunnelOpen = vi.fn();
const machineTunnelStatus = vi.fn();
const machineTunnelClose = vi.fn();
const machineInstallHooks = vi.fn();
const machineDisconnect = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  machineTunnelOpen: (...args: unknown[]) => machineTunnelOpen(...args),
  machineTunnelStatus: (...args: unknown[]) => machineTunnelStatus(...args),
  machineTunnelClose: (...args: unknown[]) => machineTunnelClose(...args),
  machineInstallHooks: (...args: unknown[]) => machineInstallHooks(...args),
  machineDisconnect: (...args: unknown[]) => machineDisconnect(...args),
}));

const { useMachineTunnel } = await import("../useMachineTunnel");

const OPEN = { state: "open" as const, ports: [9877], detail: null };
const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root" };

describe("the way home", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    machineTunnelOpen.mockResolvedValue(OPEN);
    machineTunnelStatus.mockResolvedValue(OPEN);
    machineTunnelClose.mockResolvedValue({ state: "closed", ports: [], detail: null });
    machineDisconnect.mockResolvedValue({ state: "closed", ports: [], detail: null });
    machineInstallHooks.mockResolvedValue({ scriptPath: "/home/alwi/.lotus-remote-hook.sh", changed: true, events: 4 });
  });
  afterEach(() => vi.useRealTimers());

  /// Screen 09: Putuskan is the operator's choice, so the poll must not quietly undo it.
  it("stays let go of after Putuskan, until the operator asks to reconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useMachineTunnel(SSH));
    await waitFor(() => expect(result.current.status?.state).toBe("open"));

    act(() => result.current.disconnect());
    await waitFor(() => expect(machineDisconnect).toHaveBeenCalledWith({ host: "devbox-vps", user: "root" }));
    expect(result.current.disconnected).toBe(true);
    const opens = machineTunnelOpen.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(machineTunnelOpen.mock.calls.length).toBe(opens);
    expect(machineTunnelStatus).not.toHaveBeenCalled();

    act(() => result.current.refresh());
    expect(result.current.disconnected).toBe(false);
    await waitFor(() => expect(machineTunnelOpen.mock.calls.length).toBe(opens + 1));
  });

  it("opens nothing for a project on this machine", async () => {
    const { result } = renderHook(() => useMachineTunnel(null));
    expect(machineTunnelOpen).not.toHaveBeenCalled();
    expect(result.current.status).toBeNull();
  });

  it("opens the tunnel when a remote project becomes the active one", async () => {
    const { result } = renderHook(() => useMachineTunnel(SSH));
    await waitFor(() => expect(result.current.status?.state).toBe("open"));
    expect(machineTunnelOpen).toHaveBeenCalledWith({ host: "devbox-vps", user: "root" });
  });

  it("closes it on the way out, so no ssh -R outlives the board", async () => {
    const { result, unmount } = renderHook(() => useMachineTunnel(SSH));
    await waitFor(() => expect(result.current.status?.state).toBe("open"));

    unmount();
    expect(machineTunnelClose).toHaveBeenCalledWith({ host: "devbox-vps", user: "root" });
  });

  it("does not tear down and rebuild for a location that only looks new", async () => {
    const { rerender, result } = renderHook(({ loc }) => useMachineTunnel(loc), {
      initialProps: { loc: { ...SSH } },
    });
    await waitFor(() => expect(result.current.status?.state).toBe("open"));
    const opens = machineTunnelOpen.mock.calls.length;

    // A fresh object with identical values — what the board hands us on every render.
    rerender({ loc: { ...SSH } });
    expect(machineTunnelOpen.mock.calls.length).toBe(opens);
    expect(machineTunnelClose).not.toHaveBeenCalled();
  });

  it("reports a refusal instead of leaving the chip on its last good state", async () => {
    machineTunnelOpen.mockRejectedValue(new Error("No local service ports to forward"));
    const { result } = renderHook(() => useMachineTunnel(SSH));

    await waitFor(() => expect(result.current.status?.state).toBe("failed"));
    expect(result.current.status?.detail).toMatch(/No local service ports/);
  });

  it("reopens a tunnel that died rather than only reporting it", async () => {
    vi.useFakeTimers();
    machineTunnelStatus.mockResolvedValue({
      state: "failed",
      ports: [],
      detail: "ssh exited: signal 9",
    });
    renderHook(() => useMachineTunnel(SSH));

    await vi.advanceTimersByTimeAsync(9_000);
    // Once on mount, once after the poll found it dead.
    expect(machineTunnelOpen.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("teaching the machine to report back", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    machineTunnelOpen.mockResolvedValue(OPEN);
    machineTunnelStatus.mockResolvedValue(OPEN);
    machineTunnelClose.mockResolvedValue({ state: "closed", ports: [], detail: null });
    machineInstallHooks.mockResolvedValue({ scriptPath: "/home/alwi/.lotus-remote-hook.sh", changed: true, events: 4 });
  });
  afterEach(() => vi.useRealTimers());

  it("installs the hook once the way home is open, and not before", async () => {
    const { result } = renderHook(() => useMachineTunnel(SSH));
    await waitFor(() => expect(result.current.hooks?.state).toBe("ready"));
    expect(machineInstallHooks).toHaveBeenCalledWith({ host: "devbox-vps", user: "root" });
  });

  it("does not install on a tunnel that failed to open — there is nothing to report through", async () => {
    machineTunnelOpen.mockResolvedValue({ state: "failed", ports: [], detail: "ssh exited: 255" });
    machineTunnelStatus.mockResolvedValue({ state: "failed", ports: [], detail: "ssh exited: 255" });
    const { result } = renderHook(() => useMachineTunnel(SSH));
    await waitFor(() => expect(result.current.status?.state).toBe("failed"));
    expect(machineInstallHooks).not.toHaveBeenCalled();
    expect(result.current.hooks).toBeNull();
  });

  /// Installing is idempotent in Rust, but it is still an ssh round trip, and the poll runs every
  /// eight seconds for as long as the board is open.
  it("installs once per machine, not once per poll", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMachineTunnel(SSH));
    await vi.waitFor(() => expect(result.current.hooks?.state).toBe("ready"));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(machineInstallHooks).toHaveBeenCalledTimes(1);
  });

  /// A machine whose settings.json could not be read is the case this must not hide: ssh is fine,
  /// the terminal works, and every agent on it would silently stay "idle" forever.
  it("reports a failed install in its own terms, without blaming the tunnel", async () => {
    machineInstallHooks.mockRejectedValue(new Error("~/.claude/settings.json is not valid JSON"));
    const { result } = renderHook(() => useMachineTunnel(SSH));
    await waitFor(() => expect(result.current.hooks?.state).toBe("failed"));

    expect(result.current.status?.state).toBe("open");
    expect(result.current.hooks?.detail).toContain("not valid JSON");
  });

  it("tries again on the next poll after a failure", async () => {
    vi.useFakeTimers();
    machineInstallHooks.mockRejectedValueOnce(new Error("Connection closed"));
    const { result } = renderHook(() => useMachineTunnel(SSH));
    await vi.waitFor(() => expect(result.current.hooks?.state).toBe("failed"));

    await vi.advanceTimersByTimeAsync(POLL_MS_FOR_TEST);
    await vi.waitFor(() => expect(result.current.hooks?.state).toBe("ready"));
  });

  it("forgets a machine's hook state when the board moves to a local project", async () => {
    const { result, rerender } = renderHook(
      ({ location }: { location: typeof SSH | null }) => useMachineTunnel(location),
      { initialProps: { location: SSH as typeof SSH | null } },
    );
    await waitFor(() => expect(result.current.hooks?.state).toBe("ready"));

    rerender({ location: null });
    await waitFor(() => expect(result.current.hooks).toBeNull());
  });
});

/** The hook's own poll interval, duplicated here so the test says what it is waiting for. */
const POLL_MS_FOR_TEST = 8_000;
