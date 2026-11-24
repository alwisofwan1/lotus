import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatThread } from "../../runtime/chat-runtime-client";
import { useThreadActions } from "../ThreadActions";

const client = vi.hoisted(() => ({
  renameChatThread: vi.fn(),
  regenerateChatTitle: vi.fn(),
  archiveChatThread: vi.fn(),
  pinChatThread: vi.fn(),
  deleteChatThread: vi.fn(),
  listChatThreads: vi.fn(),
}));
vi.mock("../../runtime/chat-runtime-client", () => client);

const thread = (id: string, title: string): ChatThread => ({
  id,
  cwd: "/w/lotus",
  model: null,
  permissionMode: "default",
  runner: "claude",
  provider: null,
  effort: null,
  providerSessionId: null,
  account: null,
  createdAt: 0,
  updatedAt: 0,
  title,
  importedFrom: null,
  archived: false,
  pinnedAt: null,
  lastTurnEndedAt: null,
  lastReadAt: null,
  turnStartedAt: null,
  status: null,
  parentId: null,
});

function Rail({ initial }: { initial: ChatThread[] }) {
  const [threads, setThreads] = useState(initial);
  const [activeId, setActiveId] = useState<string | null>(initial[0]?.id ?? null);
  const actions = useThreadActions({ threads, setThreads, activeId, setActiveId, now: 0, error: null });
  return (
    <>
      <p data-testid="active">{activeId ?? "none"}</p>
      {threads.map((t) =>
        actions.renaming === t.id ? (
          <div key={t.id}>{actions.renameField(t.id)}</div>
        ) : (
          <div key={t.id} data-thread-row="">
            <span>{t.archived ? `${t.title} (archived)` : t.pinnedAt ? `${t.title} (pinned)` : t.title}</span>
            <button type="button" aria-label={`More ${t.title}`} onClick={(e) => actions.openMenu(t.id, e.currentTarget)} />
          </div>
        ),
      )}
      {actions.layer}
    </>
  );
}

describe("thread actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.renameChatThread.mockResolvedValue(undefined);
    client.archiveChatThread.mockResolvedValue(undefined);
    client.pinChatThread.mockResolvedValue(undefined);
    client.deleteChatThread.mockResolvedValue(undefined);
    client.listChatThreads.mockReturnValue(new Promise(() => {}));
  });

  it("Regenerate title asks the runtime, says it is working meanwhile, and shows the new title", async () => {
    let finish!: (title: string) => void;
    client.regenerateChatTitle.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));
    render(<Rail initial={[thread("a", "Explain this branch")]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Explain this branch" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "t" });
    expect(client.regenerateChatTitle).toHaveBeenCalledWith("a");

    fireEvent.click(screen.getByRole("button", { name: "More Explain this branch" }));
    expect(screen.getByRole("menuitem", { name: /Regenerating title…/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "t" });
    expect(client.regenerateChatTitle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    client.listChatThreads.mockResolvedValue([thread("a", "Stream the CSV export")]);
    await act(async () => finish("Stream the CSV export"));
    expect(await screen.findByText("Stream the CSV export")).toBeInTheDocument();
  });

  it("a failed regeneration keeps the title and says why", async () => {
    client.regenerateChatTitle.mockRejectedValue("Could not regenerate the title, so it was kept: timed out");
    render(<Rail initial={[thread("a", "Explain this branch")]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Explain this branch" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Regenerate title/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("so it was kept: timed out");
    expect(screen.getByText("Explain this branch")).toBeInTheDocument();
  });

  it("an API chat has no Regenerate title", () => {
    render(<Rail initial={[{ ...thread("a", "Notes"), runner: "api" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Notes" }));
    expect(screen.queryByRole("menuitem", { name: /Regenerate title/ })).not.toBeInTheDocument();
  });

  it("names its thread and acts on single keys: R renames in place, Enter saves", async () => {
    render(<Rail initial={[thread("a", "Release notes")]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Release notes" }));
    const menu = screen.getByRole("menu", { name: "Actions for Release notes" });
    expect(menu.textContent).toContain("lotus · Claude");
    fireEvent.keyDown(menu, { key: "r" });
    const input = screen.getByLabelText("Thread name");
    fireEvent.change(input, { target: { value: "Release notes v0.9" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(client.renameChatThread).toHaveBeenCalledWith("a", "Release notes v0.9");
    expect(screen.getByText("Release notes v0.9")).toBeTruthy();
  });

  it("cancels a rename on Esc without calling the runtime", () => {
    render(<Rail initial={[thread("a", "Release notes")]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Release notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    fireEvent.keyDown(screen.getByLabelText("Thread name"), { key: "Escape" });
    expect(client.renameChatThread).not.toHaveBeenCalled();
    expect(screen.getByText("Release notes")).toBeTruthy();
  });

  it("pins on P and offers Unpin once pinned", () => {
    render(<Rail initial={[thread("a", "Release notes")]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Release notes" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "p" });
    expect(client.pinChatThread).toHaveBeenCalledWith("a", true);
    expect(screen.getByText("Release notes (pinned)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More Release notes" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Unpin/ }));
    expect(client.pinChatThread).toHaveBeenLastCalledWith("a", false);
    expect(screen.getByText("Release notes")).toBeTruthy();
  });

  it("archives on E and offers Unarchive once archived", () => {
    render(<Rail initial={[thread("a", "Release notes")]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Release notes" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "e" });
    expect(client.archiveChatThread).toHaveBeenCalledWith("a", true);
    expect(screen.getByText("Release notes (archived)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More Release notes" }));
    expect(screen.getByRole("menuitem", { name: /Unarchive/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Rename/ })).toBeNull();
  });

  it("deletes only after a named confirm with Cancel focused, and closes the open thread", async () => {
    localStorage.setItem("lotus.chat.draft.a", JSON.stringify({ doc: null, attachments: [], skill: { name: "tdd" } }));
    render(<Rail initial={[thread("a", "Release notes"), thread("b", "Sign-in page")]} />);
    fireEvent.click(screen.getByRole("button", { name: "More Release notes" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Backspace" });
    const dialog = screen.getByRole("alertdialog", { name: "Delete “Release notes”?" });
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(dialog.textContent).toContain("Files in lotus aren’t touched.");
    expect(client.deleteChatThread).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Delete" })));
    expect(client.deleteChatThread).toHaveBeenCalledWith("a");
    // Its unsent draft goes with it.
    expect(localStorage.getItem("lotus.chat.draft.a")).toBeNull();
    expect(screen.queryByText("Release notes")).toBeNull();
    expect(screen.getByTestId("active").textContent).toBe("none");
  });
});
