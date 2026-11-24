import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Spies shared across all fake controller instances so we can assert spawn vs reattach vs kill.
const connectPreferCommand = vi.fn((..._args: unknown[]) => Promise.resolve("command" as const));
const connect = vi.fn((..._args: unknown[]) => Promise.resolve());
const writeConfirmed = vi.fn(() => Promise.resolve());
const abort = vi.fn();

vi.mock("@/lib/pty-session-controller", () => ({
  PtySessionController: class {
    async connect(...args: unknown[]) {
      return connect(...args);
    }
    async connectPreferCommand(...args: unknown[]) {
      return connectPreferCommand(...args);
    }
    write = vi.fn();
    writeConfirmed = writeConfirmed;
    resize = vi.fn();
    abort() {
      abort();
    }
    getSessionId() {
      return "sess-x";
    }
    isAborted() {
      return false;
    }
  },
}));

import { usePtySession } from "../usePtySession";
import { clearPersistentPtyPoolForTests, destroyPersistentPty, hasPersistentPty } from "@/lib/pty-session-pool";

const baseOpts = { cwd: "/repo", command: ["claude"] as string[] };

afterEach(() => {
  clearPersistentPtyPoolForTests();
  connect.mockClear();
  connectPreferCommand.mockClear();
  writeConfirmed.mockClear();
  abort.mockClear();
});

describe("usePtySession persistence", () => {
  it("a persistKey session survives unmount and reattaches on remount WITHOUT respawning", async () => {
    const key = "canvas:projX:agent-1";

    // First mount = project A: spawns the PTY once.
    const first = renderHook(() =>
      usePtySession({ ...baseOpts, persistKey: key, persistScope: "canvas:projX", onOutput: vi.fn() }),
    );
    await act(async () => {});
    expect(connectPreferCommand).toHaveBeenCalledTimes(1);
    expect(first.result.current.status).toBe("connected");
    expect(first.result.current.reattached).toBe(false);

    // Switch to project B → node unmounts. The PTY must NOT be killed.
    first.unmount();
    expect(abort).not.toHaveBeenCalled();
    expect(hasPersistentPty(key)).toBe(true);

    // Switch back to A → node remounts. It reattaches to the live session, no second spawn.
    const second = renderHook(() =>
      usePtySession({ ...baseOpts, persistKey: key, persistScope: "canvas:projX", onOutput: vi.fn() }),
    );
    await act(async () => {});
    expect(connectPreferCommand).toHaveBeenCalledTimes(1); // still one spawn total
    expect(second.result.current.reattached).toBe(true);
    expect(second.result.current.status).toBe("connected");

    second.unmount();
    expect(abort).not.toHaveBeenCalled(); // still alive after another switch-away
  });

  it("retries a failed persistent spawn on remount", async () => {
    connectPreferCommand.mockRejectedValueOnce(new Error("spawn unavailable"));
    const opts = { ...baseOpts, persistKey: "retry", onOutput: vi.fn() };
    const first = renderHook(() => usePtySession(opts));
    await act(async () => {});
    expect(first.result.current.status).toBe("error");
    first.unmount();

    const second = renderHook(() => usePtySession(opts));
    await act(async () => {});
    expect(connectPreferCommand).toHaveBeenCalledTimes(2);
    expect(second.result.current.status).toBe("connected");
    expect(second.result.current.reattached).toBe(false);
    second.unmount();
  });

  it.each([undefined, "literal-persistent"])("keeps literal markers as output (persistKey=%s)", async (persistKey) => {
    const onOutput = vi.fn();
    const onExit = vi.fn();
    const h = renderHook(() => usePtySession({ ...baseOpts, persistKey, onOutput, onExit }));
    await act(async () => {});
    const output = connectPreferCommand.mock.calls[0][4] as (data: string) => void;
    const data = "example [Session ended:0]\r\nmore output";
    act(() => output(data));
    expect(onExit).not.toHaveBeenCalled();
    expect(onOutput).toHaveBeenCalledWith(data);
    expect(h.result.current.status).toBe("connected");
    act(() => output("[Session ended:-1]\r\n"));
    expect(onExit).toHaveBeenCalledWith(-1);
    expect(h.result.current.status).toBe("ended");
    h.unmount();
  });

  it("an explicit destroy kills the persistent PTY", async () => {
    const key = "canvas:projX:agent-1";
    const h = renderHook(() =>
      usePtySession({ ...baseOpts, persistKey: key, persistScope: "canvas:projX", onOutput: vi.fn() }),
    );
    await act(async () => {});
    h.unmount();
    expect(hasPersistentPty(key)).toBe(true);

    destroyPersistentPty(key);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(hasPersistentPty(key)).toBe(false);
  });

  it("forwards confirmed writes to the active PTY controller", async () => {
    const h = renderHook(() => usePtySession({ ...baseOpts, onOutput: vi.fn() }));
    await act(async () => {});

    const handle = h.result.current as typeof h.result.current & {
      writeConfirmed?: (data: string) => Promise<void>;
    };
    expect(handle.writeConfirmed).toBeTypeOf("function");
    await handle.writeConfirmed?.("prompt\r");
    expect(writeConfirmed).toHaveBeenCalledWith("prompt\r");
    h.unmount();
  });

  it("without persistKey the session keeps the ephemeral abort-on-unmount behaviour", async () => {
    const h = renderHook(() => usePtySession({ ...baseOpts, onOutput: vi.fn() }));
    await act(async () => {});
    expect(connectPreferCommand).toHaveBeenCalledTimes(1);
    h.unmount();
    expect(abort).toHaveBeenCalledTimes(1);
  });
});
