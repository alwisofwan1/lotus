import { describe, it, expect, vi } from "vitest";
import type { Node } from "@xyflow/react";
import { buildCommandSheetItems, filterCommandSheetItems, SHEET_BROWSE_GROUP_LIMIT } from "../command-sheet-items";
import type { RemoteHostCell } from "../../remote-host";

function cell(over: Partial<RemoteHostCell> = {}): RemoteHostCell {
  return {
    paneId: "p1",
    workspaceId: "/srv/api",
    cwd: "/srv/devbox/api",
    provider: "claude",
    status: "running",
    isAlive: true,
    displayName: "Rowan",
    ...over,
  };
}

const adoptRows = (items: ReturnType<typeof buildCommandSheetItems>) =>
  items.filter((item) => item.id.startsWith("adopt-"));

describe("adopting a host cell from ⌘K", () => {
  /**
   * Criterion 2 of the ticket, and the reason the rows are built from the list rather than shown
   * with an empty state: a machine that runs no host produces nothing to look at, nothing to read,
   * and nothing to be disappointed by.
   */
  it("shows no trace at all when the machine runs no host", () => {
    expect(adoptRows(buildCommandSheetItems({ nodes: [], clis: [] }))).toHaveLength(0);
    expect(adoptRows(buildCommandSheetItems({ nodes: [], clis: [], hostCells: [] }))).toHaveLength(0);
  });

  it("offers a cell the host is running, saying what it is and where", () => {
    const items = buildCommandSheetItems({ nodes: [], clis: [], hostCells: [cell()] });
    const [row] = adoptRows(items);

    expect(row.title).toBe("Adopt Rowan");
    expect(row.detail).toContain("claude");
    expect(row.detail).toContain("/srv/devbox/api");
    expect(row.keywords).toContain("adopsi");
  });

  it("says so when a cell has stopped, rather than offering it as if it were live", () => {
    const items = buildCommandSheetItems({
      nodes: [],
      clis: [],
      hostCells: [cell({ isAlive: false, status: "exited" })],
    });
    expect(adoptRows(items)[0].detail).toContain("berhenti");
  });

  /**
   * Ticket 12's branch, said out loud in the palette. Both rows read "Adopt", and pressing one
   * gets a terminal while pressing the other gets a chat box — an operator who learns that
   * difference by pressing it learns it at the worst possible moment.
   */
  it("says which shape an adoption will take, because the two are not the same thing", () => {
    const headless = buildCommandSheetItems({ nodes: [], clis: [], hostCells: [cell({ tui: false })] });
    expect(adoptRows(headless)[0].detail).toContain("chat");
    expect(adoptRows(headless)[0].keywords).toContain("percakapan");

    const terminal = buildCommandSheetItems({ nodes: [], clis: [], hostCells: [cell({ tui: true })] });
    expect(adoptRows(terminal)[0].detail).toContain("terminal");
  });

  /**
   * A host older than the `tui` field omits it, and every cell such a host can report came from
   * its PTY manager. Absent has to mean terminal; the other guess offers a chat node for a cell
   * whose conversation route will answer an error.
   */
  it("treats a cell from a host too old to say as a terminal", () => {
    const items = buildCommandSheetItems({ nodes: [], clis: [], hostCells: [cell()] });
    expect(adoptRows(items)[0].detail).toContain("terminal");
    expect(adoptRows(items)[0].detail).not.toContain("chat");
  });

  /**
   * The guard against adopting twice reads `adoptedPaneId` off any node, and the Chat node is
   * deliberately spelled the same way so the two adoption shapes share one guard. Without that
   * a headless cell could be adopted as a chat node and then again as a second one.
   */
  it("does not offer a cell that is already on this board as a chat node", () => {
    const nodes = [
      { id: "n1", type: "host-cell", position: { x: 0, y: 0 }, data: { adoptedPaneId: "p1" } },
    ] as unknown as Node[];
    const items = buildCommandSheetItems({ nodes, clis: [], hostCells: [cell({ tui: false })] });
    expect(adoptRows(items)).toHaveLength(0);
  });

  /**
   * Two nodes on one tmux session is not a duplicate row, it is a resize fight: tmux sizes a
   * session to its smallest client, so the second node would shrink the first.
   */
  it("does not offer a cell that is already on this board", () => {
    const nodes = [
      { id: "n1", type: "terminal", position: { x: 0, y: 0 }, data: { adoptedPaneId: "p1" } },
    ] as unknown as Node[];
    const items = buildCommandSheetItems({ nodes, clis: [], hostCells: [cell(), cell({ paneId: "p2", displayName: "Kestrel" })] });

    const rows = adoptRows(items);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Adopt Kestrel");
  });

  it("hands the cell back untouched when the row is pressed", () => {
    const onAdoptCell = vi.fn();
    const subject = cell();
    const items = buildCommandSheetItems({ nodes: [], clis: [], hostCells: [subject], onAdoptCell });

    const [row] = adoptRows(items);
    expect(row.action.kind).toBe("custom");
    if (row.action.kind === "custom") row.action.run();
    expect(onAdoptCell).toHaveBeenCalledWith(subject);
  });

  /**
   * Spawning works on every machine; adoption only where a host happens to be running. The thing
   * that always works must not be pushed below the thing that usually is not there.
   */
  it("lists adoption after launch, never before it", () => {
    const items = buildCommandSheetItems({
      nodes: [],
      clis: [{ id: "claude", name: "Claude Code", command: "claude", installed: true } as never],
      hostCells: [cell()],
    });
    const launchAt = items.findIndex((item) => item.id.startsWith("launch-"));
    const adoptAt = items.findIndex((item) => item.id.startsWith("adopt-"));
    expect(launchAt).toBeGreaterThanOrEqual(0);
    expect(adoptAt).toBeGreaterThan(launchAt);
  });

  /**
   * The regression the group split was made for.
   *
   * While adoption sat in the `launch` group it spent the same per-group browse budget, so a busy
   * host quietly ate the runners: six cells and the Launch rows fell off the browse list entirely.
   * Nothing would have looked broken — the sheet would just have stopped offering `claude`, on the
   * one machine where most cells are running.
   */
  it("does not spend the Launch budget, however many cells the host is running", () => {
    const clis = ["claude", "codex", "cursor-agent"].map(
      (id) => ({ id, name: id, command: id, installed: true }) as never,
    );
    const hostCells = Array.from({ length: SHEET_BROWSE_GROUP_LIMIT + 3 }, (_, i) =>
      cell({ paneId: `p${i}`, displayName: `cell-${i}` }),
    );

    const browsed = filterCommandSheetItems(buildCommandSheetItems({ nodes: [], clis, hostCells }), "");

    expect(browsed.filter((item) => item.id.startsWith("launch-"))).toHaveLength(clis.length);
    expect(browsed.filter((item) => item.id.startsWith("adopt-"))).toHaveLength(SHEET_BROWSE_GROUP_LIMIT);
  });

  /** The section header answers where these came from; the rows already carry the verb. */
  it("gives adoption its own section rather than filing it under Launch", () => {
    const items = buildCommandSheetItems({ nodes: [], clis: [], hostCells: [cell()] });
    expect(adoptRows(items)[0].group).toBe("adopt");
  });
});
