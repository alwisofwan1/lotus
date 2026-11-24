import { describe, expect, it } from "vitest";

import type { ChatThread } from "@/modules/chat/runtime/chat-runtime-client";
import type { Workspace } from "@/modules/codespace/components/types";
import { codeChatPaneKey, importedChatPanes } from "../imported-chat-panes";

const thread = (id: string, importedFrom: string | null, title: string | null = null) =>
  ({ id, importedFrom, title }) as ChatThread;

const workspaces = [
  {
    id: "w",
    cells: [
      { id: "old", cwd: "/w", type: "chat", sessionId: "s1" },
      { id: "fresh", cwd: "/w", type: "chat", sessionId: "s2" },
      { id: "new", cwd: "/w", type: "chat", sessionId: "", thread: { id: "t9" } },
      { id: "term", cwd: "/w", type: "terminal" },
    ],
  },
] as Workspace[];

describe("imported chat panes (07f)", () => {
  it("moves a CodeChat pane to the thread its session was imported into, and leaves the rest", () => {
    const threads = [thread("t1", "s1", "Old chat"), thread("t9", null)];
    expect(importedChatPanes(workspaces, threads)).toEqual([
      { workspaceId: "w", cellId: "old", thread: { id: "t1", title: "Old chat" } },
    ]);
  });

  it("keys the CodeChat panes by whether they show a thread, so a move changes the key", () => {
    expect(codeChatPaneKey(workspaces)).toBe("w/old\nw/fresh");
  });

});
