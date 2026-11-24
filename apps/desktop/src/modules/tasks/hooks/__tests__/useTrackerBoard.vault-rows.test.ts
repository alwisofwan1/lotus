import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useTrackerBoard, type UseTrackerBoardInput } from "@/modules/tasks/hooks/useTrackerBoard";

/**
 * A vault ticket's status and title, changed from the LIST — through the same surgical edit its
 * own page uses (`vault_ticket_edit.rs`), against the revision the file is at right now.
 *
 * The list holds no revision (rows are summaries), so the board reads the ticket first. Obsidian
 * or a `git pull` can change it between that read and the write; then the store refuses with a
 * conflict, nothing is written, and the row goes back to what the file says.
 */

const ticket = {
  file: "TKT-874.md",
  ticket: "TKT-874",
  title: "Remove legacy /plan module",
  status: "in-review",
  tags: [],
  modifiedAt: 1,
};

const vault = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  edit: vi.fn(),
}));

vi.mock("@/modules/tasks/services/vault-api", () => ({ createTauriVaultClient: () => vault }));
vi.mock("@/modules/codespace/services/bridge/task-api", () => ({
  createTauriTaskClient: () => ({ list: vi.fn(async () => []), update: vi.fn(), appendEvent: vi.fn() }),
}));
vi.mock("@/lib/tauri/runtime", () => ({ isTauri: () => true, tauriInvoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const input: UseTrackerBoardInput = {
  projects: [],
  storedPrefixes: {},
  onPrefixesChange: () => {},
  vaultPath: "/vault",
};

const detailAt = (revision: string, status = ticket.status) => ({
  ticket: { ...ticket, status },
  sections: [],
  revision,
});

beforeEach(() => {
  vault.list.mockReset().mockResolvedValue([ticket]);
  vault.get.mockReset().mockResolvedValue(detailAt("r7"));
  vault.edit.mockReset();
});

async function board() {
  const hook = renderHook(() => useTrackerBoard(input));
  await waitFor(() => expect(hook.result.current.tasks).toHaveLength(1));
  return hook;
}

describe("changing a vault row from the list", () => {
  it("writes the status against the revision the file is at now, in the vault's own word", async () => {
    vault.edit.mockResolvedValue({ kind: "saved", detail: detailAt("r8", "qa-revision") });
    const { result } = await board();

    let refusal: string | null = "unset";
    await act(async () => {
      refusal = await result.current.editTask("TKT-874.md", { status: "qa-revision" as never });
    });

    expect(refusal).toBeNull();
    expect(vault.get).toHaveBeenCalledWith("/vault", "TKT-874.md");
    expect(vault.edit).toHaveBeenCalledWith("/vault", "TKT-874.md", "r7", { status: "qa-revision" });
    expect(result.current.tasks[0].status).toBe("qa-revision");
  });

  it("renames it the same way", async () => {
    vault.edit.mockResolvedValue({ kind: "saved", detail: { ...detailAt("r8"), ticket: { ...ticket, title: "Renamed" } } });
    const { result } = await board();

    await act(async () => {
      await result.current.editTask("TKT-874.md", { title: "Renamed" });
    });

    expect(vault.edit).toHaveBeenCalledWith("/vault", "TKT-874.md", "r7", { title: "Renamed" });
    expect(result.current.tasks[0].title).toBe("Renamed");
  });

  it("puts the row back and says why when the file changed underneath", async () => {
    vault.edit.mockResolvedValue({ kind: "conflict", detail: detailAt("r9", "released") });
    const { result } = await board();

    let refusal: string | null = null;
    await act(async () => {
      refusal = await result.current.editTask("TKT-874.md", { status: "qa-revision" as never });
    });

    // What the file says NOW, not what was there before the click.
    expect(result.current.tasks[0].status).toBe("released");
    expect(refusal).toMatch(/changed/i);
  });

  it("refuses a priority — a ticket has none to set", async () => {
    const { result } = await board();

    await act(async () => {
      await result.current.editTask("TKT-874.md", { priority: "high" });
    });

    expect(vault.edit).not.toHaveBeenCalled();
    expect(result.current.tasks[0].priority).toBe("none");
  });
});
