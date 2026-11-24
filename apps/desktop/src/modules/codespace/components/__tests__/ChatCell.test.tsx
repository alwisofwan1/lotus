import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatCellData } from "@/modules/codespace/components/types";

const chatPageProps = vi.fn();
const chatRail = vi.fn();
vi.mock("@/modules/chat/ui/ChatPage", () => ({
  ChatPage: (props: Record<string, unknown>) => {
    chatPageProps(props);
    return <div data-testid="chat-page" />;
  },
  useChatRail: () => chatRail(),
}));

const { ChatCell } = await import("@/modules/codespace/components/ChatCell");

describe("ChatCell on the new chat (07d)", () => {
  const thread = (id: string, title: string | null) => ({ id, title, cwd: "/tmp/project", archived: false });
  const pane: ChatCellData = { id: "pane-new", cwd: "/tmp/project", type: "chat", sessionId: "", thread: { id: null } };
  const rail = (threads: unknown[], loaded = true) =>
    chatRail.mockReturnValue({ threads, setThreads: vi.fn(), activeId: null, setActiveId: vi.fn(), now: 0, error: null, loaded });

  beforeEach(() => {
    chatPageProps.mockReset();
    chatRail.mockReset();
  });

  it("opens a pane from before 07d, still on its CodeChat session, as a new chat (07o)", () => {
    rail([]);
    render(<ChatCell cell={{ id: "pane-old", cwd: "/tmp/project", type: "chat", sessionId: "session-7" }} />);
    expect(screen.getByTestId("chat-page")).toBeTruthy();
    expect(chatPageProps.mock.calls.at(-1)?.[0]).toMatchObject({ rail: { activeId: null } });
  });

  it("opens the chat in the pane's folder and records the thread its first message makes", () => {
    rail([]);
    const onThreadChange = vi.fn();
    render(<ChatCell cell={pane} workspaceId="w1" onThreadChange={onThreadChange} />);
    const props = chatPageProps.mock.calls.at(-1)![0] as { pane: { cwd: string }; rail: { activeId: string | null; setActiveId: (id: string) => void } };
    expect(props.pane.cwd).toBe("/tmp/project");
    expect(props.rail.activeId).toBeNull();
    props.rail.setActiveId("t1");
    expect(onThreadChange).toHaveBeenCalledWith({ id: "t1" });
  });

  it("gives the chat the pane header's slot and focus, for its Done", () => {
    rail([]);
    const slot = document.createElement("span");
    render(<ChatCell cell={pane} headerSlot={slot} focused />);
    expect(chatPageProps.mock.calls.at(-1)?.[0]).toMatchObject({ pane: { headerSlot: slot, focused: true } });
  });

  it("hands ⌘L drafts addressed to the pane to the chat, including one waiting before it mounted", async () => {
    const { requestThreadDraft } = await import("@/modules/codespace/state/thread-draft-inbox");
    rail([]);
    requestThreadDraft("pane-new", "early");
    render(<ChatCell cell={pane} />);
    const take = vi.fn();
    const props = chatPageProps.mock.calls.at(-1)![0] as { pane: { onDraft: (take: (t: string) => void) => () => void } };
    const off = props.pane.onDraft(take);
    requestThreadDraft("pane-new", "later");
    off();
    expect(take.mock.calls).toEqual([["early"], ["later"]]);
  });

  it("keeps the thread's title on the pane for the rail", () => {
    rail([thread("t1", "Fix the login test")]);
    const onThreadChange = vi.fn();
    render(<ChatCell cell={{ ...pane, thread: { id: "t1" } }} onThreadChange={onThreadChange} />);
    expect(onThreadChange).toHaveBeenCalledWith({ id: "t1", title: "Fix the login test" });
  });

  it("says a thread deleted elsewhere is gone, and offers a new chat in its place", () => {
    rail([thread("other", null)]);
    const onThreadChange = vi.fn();
    const onClose = vi.fn();
    render(<ChatCell cell={{ ...pane, thread: { id: "t1" } }} onThreadChange={onThreadChange} onClose={onClose} />);
    expect(screen.getByText("This chat was deleted")).toBeTruthy();
    screen.getByRole("button", { name: "New chat here" }).click();
    expect(onThreadChange).toHaveBeenCalledWith({ id: null });
    screen.getByRole("button", { name: "Close pane" }).click();
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call a thread gone before the first listing arrives", () => {
    rail([], false);
    render(<ChatCell cell={{ ...pane, thread: { id: "t1" } }} />);
    expect(screen.queryByText("This chat was deleted")).toBeNull();
  });
});
