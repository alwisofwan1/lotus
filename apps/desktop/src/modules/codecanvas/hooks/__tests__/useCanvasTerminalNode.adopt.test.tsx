import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const runtimeOptions = vi.fn();
const getActiveProjectLocation = vi.fn();

vi.mock("@/modules/codespace/hooks/useLegacyTerminalRuntime", () => ({
  useLegacyTerminalRuntime: (opts: unknown) => {
    runtimeOptions(opts);
    return { containerRef: { current: null }, helperTextareaRef: { current: null } };
  },
}));
vi.mock("@/modules/codecanvas/services/canvas-active-project", () => ({
  getActiveProjectLocation: () => getActiveProjectLocation(),
}));
vi.mock("@/modules/codecanvas/services/terminal-activity-registry", () => ({
  subscribeTerminalActivity: () => () => {},
}));
vi.mock("@/modules/codespace/services/terminal-activity-registry", () => ({
  subscribeTerminalActivity: () => () => {},
}));

const { useCanvasTerminalNode } = await import("../useCanvasTerminalNode");

const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root" };

function command(): string[] | undefined {
  const opts = runtimeOptions.mock.calls.at(-1)?.[0] as { terminalCommand?: string[] };
  return opts?.terminalCommand;
}

describe("a canvas terminal that adopted a host cell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getActiveProjectLocation.mockReturnValue(SSH);
  });

  /**
   * The cell is already running, in a tmux session the host started. Opening a shell would leave
   * the cell exactly where it was and draw an empty prompt beside it — the node would look adopted
   * and be nothing of the kind.
   */
  it("attaches to the cell's tmux session instead of starting anything", () => {
    renderHook(() =>
      useCanvasTerminalNode({ id: "n1", cwd: "/srv/api", adoptedPaneId: "canvas:p1/node-9" }),
    );

    const argv = command();
    expect(argv?.slice(0, 3)).toEqual(["ssh", "-t", "root@devbox-vps"]);
    // Each argv element arrives shell-quoted, which is the point: a pane id is host-supplied data
    // and must not be able to become shell syntax on its way to `tmux`.
    const remote = argv?.at(-1) ?? "";
    expect(remote).toContain("'tmux'");
    expect(remote).toContain("'attach'");
    expect(remote).toContain("'lotus-canvas_p1_node-9'");
    expect(remote).toContain("-lic", );
  });

  it("opens an ordinary remote shell when nothing was adopted", () => {
    renderHook(() => useCanvasTerminalNode({ id: "n2", cwd: "/srv/api" }));

    const remote = command()?.at(-1) ?? "";
    expect(remote).not.toContain("tmux attach");
    expect(remote).toContain("/srv/api");
  });

  /// Adoption only exists for a project on another machine; there is no host to adopt from here.
  it("leaves a local terminal alone entirely", () => {
    getActiveProjectLocation.mockReturnValue(null);
    renderHook(() => useCanvasTerminalNode({ id: "n3", cwd: "/repo", adoptedPaneId: "p1" }));

    expect(command()).toBeUndefined();
    const opts = runtimeOptions.mock.calls.at(-1)?.[0] as { cwd: string };
    expect(opts.cwd).toBe("/repo");
  });
});

describe("a canvas terminal opened for a delegated task (S4b)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs the agent as the PTY's own process on this machine", () => {
    getActiveProjectLocation.mockReturnValue(null);
    renderHook(() => useCanvasTerminalNode({ id: "n4", cwd: "/repo", launchCommand: ["claude", "--session-id", "s1"] }));

    expect(command()).toEqual(["claude", "--session-id", "s1"]);
  });

  /// The spawner refuses a remote board first; the hook still never runs it outside ssh.
  it("never runs it in place of the ssh command on a remote board", () => {
    getActiveProjectLocation.mockReturnValue(SSH);
    renderHook(() => useCanvasTerminalNode({ id: "n5", cwd: "/srv/api", launchCommand: ["claude"] }));

    expect(command()?.slice(0, 2)).toEqual(["ssh", "-t"]);
  });
});
