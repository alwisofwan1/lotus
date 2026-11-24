import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClosedWorkspaceTasks } from "@/modules/tasks/components/ClosedWorkspaceTasks";
import type {
  ClosedWorkspaceTaskClient,
  OrphanTaskFile,
} from "@/modules/tasks/services/closed-workspace-tasks";

/**
 * Tasks written under a workspace id that is no longer open are still on disk; this section is
 * how they come back — listed with what is open in them, and moved into a workspace the user picks.
 */

const oldFile: OrphanTaskFile = {
  workspaceId: "12589d98-78ef-45ff-9d27-4a92571715d1",
  taskCount: 24,
  openCount: 10,
  lastUpdatedAt: 2,
  sampleTitles: ["Needs you 5/7: PR reviews can ask", "Energy: stop orphaned PTY"],
  ignored: false,
};

const projects = [
  { id: "ws-lotus", name: "Lotus" },
  { id: "ws-hr", name: "HR Portal" },
];

function fakeClient(files: OrphanTaskFile[] = [oldFile]): ClosedWorkspaceTaskClient {
  let current = files;
  return {
    list: vi.fn(async () => current),
    move: vi.fn(async (from: string) => {
      current = current.filter((f) => f.workspaceId !== from);
      return { moved: 8, skippedDuplicates: 16 };
    }),
    setIgnored: vi.fn(async (id: string, ignored: boolean) => {
      current = current.map((f) => (f.workspaceId === id ? { ...f, ignored } : f));
    }),
    remove: vi.fn(async (id: string) => {
      current = current.filter((f) => f.workspaceId !== id);
    }),
  };
}

describe("tasks from closed workspaces", () => {
  it("lists a closed workspace's task file with its open count and a hint of what is in it", async () => {
    const client = fakeClient();
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={vi.fn()} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    expect(section.textContent).toContain("12589d98");
    expect(section.textContent).toContain("10 open of 24");
    expect(section.textContent).toContain("Needs you 5/7: PR reviews can ask");
    // Asked with what IS open, so a workspace open in the rail never shows up as closed.
    expect(client.list).toHaveBeenCalledWith(["ws-lotus", "ws-hr"]);
  });

  it("moves them into the chosen workspace with one click, then says what happened", async () => {
    const client = fakeClient();
    const onMoved = vi.fn();
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={onMoved} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    fireEvent.change(within(section).getByRole("combobox", { name: /Move tasks from 12589d98 into/ }), {
      target: { value: "ws-hr" },
    });
    fireEvent.click(within(section).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(client.move).toHaveBeenCalledWith(oldFile.workspaceId, "ws-hr"));
    expect(await screen.findByText(/Moved 8 into HR Portal · 16 already there/)).toBeTruthy();
    // The board re-reads, so the moved tasks appear under their new keys.
    expect(onMoved).toHaveBeenCalledTimes(1);
    // And the file is gone from the list, so it cannot be moved twice.
    expect(screen.queryByText(/10 open of 24/)).toBeNull();
  });

  it("defaults the target to the first open workspace", async () => {
    const client = fakeClient();
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={vi.fn()} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    fireEvent.click(within(section).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(client.move).toHaveBeenCalledWith(oldFile.workspaceId, "ws-lotus"));
  });

  it("shows nothing when there is nothing to recover, or the files cannot be read", async () => {
    const empty = fakeClient([]);
    const { unmount } = render(
      <ClosedWorkspaceTasks projects={projects} client={empty} onMoved={vi.fn()} />,
    );
    await waitFor(() => expect(empty.list).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "From closed workspaces" })).toBeNull();
    unmount();

    const broken: ClosedWorkspaceTaskClient = {
      list: vi.fn(async () => {
        throw new Error("not in Tauri");
      }),
      move: vi.fn(),
      setIgnored: vi.fn(),
      remove: vi.fn(),
    };
    render(<ClosedWorkspaceTasks projects={projects} client={broken} onMoved={vi.fn()} />);
    await waitFor(() => expect(broken.list).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "From closed workspaces" })).toBeNull();
  });

  it("keeps the row and says why when a move fails", async () => {
    const client = fakeClient();
    client.move = vi.fn(async () => {
      throw new Error("disk full");
    });
    const onMoved = vi.fn();
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={onMoved} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    fireEvent.click(within(section).getByRole("button", { name: "Move" }));

    expect(await screen.findByText(/disk full/)).toBeTruthy();
    expect(screen.getByText(/10 open of 24/)).toBeTruthy();
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("ignores a workspace's tasks: hidden from the list, kept on disk, and can be shown again", async () => {
    const client = fakeClient();
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={vi.fn()} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    fireEvent.click(within(section).getByRole("button", { name: "Ignore" }));

    await waitFor(() => expect(client.setIgnored).toHaveBeenCalledWith(oldFile.workspaceId, true));
    await waitFor(() => expect(screen.queryByText(/10 open of 24/)).toBeNull());
    expect(client.remove).not.toHaveBeenCalled();
    // Still findable, since a closed workspace may be reopened one day.
    fireEvent.click(screen.getByRole("button", { name: "Show ignored (1)" }));
    expect(await screen.findByText(/10 open of 24/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unignore" }));
    await waitFor(() => expect(client.setIgnored).toHaveBeenCalledWith(oldFile.workspaceId, false));
    expect(await screen.findByRole("button", { name: "Ignore" })).toBeTruthy();
  });

  it("deletes a workspace's tasks only after confirming, and never an open workspace's", async () => {
    const client = fakeClient();
    const onMoved = vi.fn();
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={onMoved} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    fireEvent.click(within(section).getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete all 24 tasks from 12589d98?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(client.remove).not.toHaveBeenCalled();
    expect(screen.queryByText(/Delete all 24 tasks/)).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 24 tasks" }));

    // The open ids go along, so Rust can refuse a workspace that is on the board right now.
    await waitFor(() => expect(client.remove).toHaveBeenCalledWith(oldFile.workspaceId, ["ws-lotus", "ws-hr"]));
    expect(await screen.findByText("Deleted 24 tasks from 12589d98")).toBeTruthy();
    expect(screen.queryByText(/10 open of 24/)).toBeNull();
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("keeps a way back to ignored workspaces when every one is ignored", async () => {
    const client = fakeClient([{ ...oldFile, ignored: true }]);
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={vi.fn()} />);

    expect(await screen.findByRole("button", { name: "Show ignored (1)" })).toBeTruthy();
    expect(screen.queryByText(/10 open of 24/)).toBeNull();
  });

  it("puts the keyboard on the confirm, and Escape backs out of it", async () => {
    const client = fakeClient();
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={vi.fn()} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    fireEvent.click(within(section).getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("button", { name: "Delete 24 tasks" });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Delete 24 tasks" })).toBeNull();
    expect(document.activeElement).toBe(within(section).getByRole("button", { name: "Delete" }));
    expect(client.remove).not.toHaveBeenCalled();
  });

  it("says what Ignore does to someone who cannot hover", async () => {
    render(<ClosedWorkspaceTasks projects={projects} client={fakeClient()} onMoved={vi.fn()} />);
    const ignore = await screen.findByRole("button", { name: "Ignore" });
    expect(ignore).toHaveAccessibleDescription(/stay on disk/);
  });

  it("re-reads the list even when a change fails, so the rows show what is really on disk", async () => {
    const client = fakeClient();
    client.remove = vi.fn(async () => {
      throw new Error("permission denied");
    });
    render(<ClosedWorkspaceTasks projects={projects} client={client} onMoved={vi.fn()} />);

    const section = await screen.findByRole("region", { name: "From closed workspaces" });
    fireEvent.click(within(section).getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 24 tasks" }));

    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    expect(client.list).toHaveBeenCalledTimes(2);
  });
});
