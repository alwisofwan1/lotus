import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RemoteHostCell } from "../remote-host";

const machineHostFleet = vi.fn();
const machineHostDispatch = vi.fn();
const machineHostConversation = vi.fn();

vi.mock("@/lib/tauri-api", () => ({
  machineHostFleet: (...a: unknown[]) => machineHostFleet(...a),
  machineHostDispatch: (...a: unknown[]) => machineHostDispatch(...a),
  machineHostConversation: (...a: unknown[]) => machineHostConversation(...a),
}));

const host = await import("../remote-host");
const SSH = { kind: "ssh" as const, host: "devbox-vps", user: "root" };
const TARGET = { host: "devbox-vps", user: "root", port: null };

function cell(over: Partial<RemoteHostCell> = {}): RemoteHostCell {
  return {
    paneId: "p1",
    workspaceId: "/srv/api",
    cwd: "/srv/api",
    provider: "claude",
    status: "running",
    isAlive: true,
    ...over,
  };
}

describe("a Lotus Host that happens to be on the machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    machineHostFleet.mockResolvedValue({ available: true, cells: [cell()] });
  });

  /// The whole promise of "optional": a local board must not even ask.
  it("asks nothing for a project on this machine", async () => {
    expect(await host.hostFleetFor(null)).toEqual({ available: false, cells: [] });
    expect(machineHostFleet).not.toHaveBeenCalled();
  });

  it("asks the project's machine, without the label we gave it", async () => {
    const fleet = await host.hostFleetFor({ ...SSH, label: "VPS" });
    expect(machineHostFleet).toHaveBeenCalledWith(TARGET);
    expect(fleet.cells).toHaveLength(1);
  });

  /**
   * This feeds an optional section of the command palette. A machine having a bad day — a stale
   * key, a host that stopped — must cost that section, never the palette.
   */
  it("answers 'none' rather than throwing when the machine cannot say", async () => {
    machineHostFleet.mockRejectedValue(new Error("ssh: connect timed out"));
    await expect(host.hostFleetFor(SSH)).resolves.toEqual({ available: false, cells: [] });
  });

  /// Dispatch is different: the operator typed this on purpose and has to learn it did not land.
  it("lets a failed dispatch through to the caller", async () => {
    machineHostDispatch.mockRejectedValue(new Error("no live session for paneId"));
    await expect(host.hostDispatchFor(SSH, "p1", "go")).rejects.toThrow("no live session");
    expect(machineHostDispatch).toHaveBeenCalledWith(TARGET, "p1", "go");
  });

  /**
   * `packages/host`'s own `sessionName`, character scrub included. This is how an adopted node
   * finds the bytes; a name that disagrees by one character attaches to nothing.
   */
  it("names the tmux session the way the host does", () => {
    expect(host.tmuxSessionFor("abc123")).toBe("lotus-abc123");
    expect(host.tmuxSessionFor("canvas:p1/node-9")).toBe("lotus-canvas_p1_node-9");
    expect(host.tmuxSessionFor("a_b-c")).toBe("lotus-a_b-c");
  });

  /**
   * The one branch ticket 12 turns on, and the default is the point of testing it.
   *
   * A host older than the field omits `tui` entirely, and everything such a host could report on
   * `/v1/list-fleet` came from its PTY manager — so absent means terminal. Reading it the other
   * way sends the canvas looking for a conversation on a cell that has none, which is exactly the
   * failure ticket 11 shipped: an empty xterm beside a working agent.
   */
  it("adopts a headless cell as chat and everything else as a terminal", () => {
    expect(host.adoptionShapeFor(cell({ tui: false }))).toBe("chat");
    expect(host.adoptionShapeFor(cell({ tui: true }))).toBe("terminal");
    expect(host.adoptionShapeFor(cell())).toBe("terminal");
  });

  /**
   * Unlike the fleet, a conversation is asked for on purpose, for one named cell. A node that
   * silently shows nothing is indistinguishable from a cell nobody has spoken to yet — and the
   * Rust side fails rather than answering an empty page for the same reason.
   */
  it("lets a conversation that could not be read through to the caller", async () => {
    machineHostConversation.mockRejectedValue(new Error("that cell has no conversation on this host"));
    await expect(host.hostConversationFor(SSH, "ss-9f3a")).rejects.toThrow("no conversation");
    expect(machineHostConversation).toHaveBeenCalledWith(TARGET, "ss-9f3a");
  });

  /** Passed through unreshaped — the page is the host's format, and a copy here is a second one. */
  it("hands the host's page back untouched", async () => {
    const wire = { ok: true, paneId: "ss-9f3a", turns: [] };
    machineHostConversation.mockResolvedValue(wire);
    await expect(host.hostConversationFor(SSH, "ss-9f3a")).resolves.toBe(wire);
  });

  it("falls back to the directory when the host gave a cell no name", () => {
    expect(host.cellLabel(cell({ displayName: "Rowan" }))).toBe("Rowan");
    expect(host.cellLabel(cell({ cwd: "/srv/devbox/api" }))).toBe("api");
    expect(host.cellLabel(cell({ cwd: "", displayName: "  " }))).toBe("p1");
  });
});
