import { describe, expect, it } from "vitest";
import type { GridCell } from "@/modules/codespace/components/types";
import {
  ptyWritesForHeldPrompt,
  ptyWritesForMessage,
  ptyWritesToClearHeldPrompt,
  routeComposerMessage,
} from "@/modules/workspace-shell/services/composer-routing";

const liveTerminal: GridCell = {
  id: "t1",
  cwd: "/tmp",
  type: "terminal",
  runtimeSessionId: "sess-1",
  runtimeStatus: "live",
};

describe("routeComposerMessage", () => {
  it("sends to the focused terminal's live session", () => {
    expect(routeComposerMessage(liveTerminal)).toEqual({
      kind: "terminal",
      paneId: "t1",
      runtimeSessionId: "sess-1",
    });
  });

  it("refuses a terminal with no session rather than swallowing the message", () => {
    const route = routeComposerMessage({ ...liveTerminal, runtimeSessionId: null } as GridCell);
    expect(route).toMatchObject({ kind: "blocked" });
    expect(route.kind === "blocked" && route.reason).toMatch(/no live session/);
  });

  it("sends to the focused thread — one command bar, whatever kind of pane is focused (M3)", () => {
    const route = routeComposerMessage({ id: "c1", cwd: "/tmp", type: "chat", sessionId: "s1" });
    expect(route).toMatchObject({ kind: "thread", paneId: "c1", sessionId: "s1" });
  });

  it("refuses a thread pane whose session id is empty rather than typing into nothing", () => {
    // The type says `string`, but a snapshot written by an older build can carry an empty one —
    // the Rust field is optional. An empty id addresses no conversation.
    const route = routeComposerMessage({ id: "c1", cwd: "/tmp", type: "chat", sessionId: "" });
    expect(route).toMatchObject({ kind: "blocked" });
    expect(route.kind === "blocked" && route.reason).toMatch(/no conversation/i);
  });

  it("sends to a new-chat pane by the pane's id, before its first message made a thread (07d)", () => {
    const route = routeComposerMessage({ id: "c1", cwd: "/tmp", type: "chat", sessionId: "", thread: { id: null } });
    expect(route).toMatchObject({ kind: "thread", paneId: "c1", sessionId: "c1" });
  });

  it("says there is no target when nothing is focused", () => {
    expect(routeComposerMessage(null)).toMatchObject({ kind: "blocked" });
  });

  it("blocks kinds that cannot take text at all", () => {
    const browser: GridCell = { id: "b1", cwd: "/tmp", type: "browser", url: "", zoom: 1, loading: false };
    expect(routeComposerMessage(browser)).toMatchObject({ kind: "blocked" });
  });
});

describe("ptyWritesForMessage", () => {
  it("splits the newline from the text, because a TUI treats them together as a paste", () => {
    expect(ptyWritesForMessage("bun run test")).toEqual(["bun run test", "\r"]);
  });

  it("does not double the newline the user already typed", () => {
    expect(ptyWritesForMessage("ls\n")).toEqual(["ls", "\r"]);
  });

  it("sends nothing for an empty message", () => {
    expect(ptyWritesForMessage("   \n")).toEqual(["   ", "\r"]);
    expect(ptyWritesForMessage("")).toEqual([]);
  });
});

describe("Held Prompt writes", () => {
  it("writes the text without its carriage return, so it waits unsent", () => {
    expect(ptyWritesForHeldPrompt(" fix the failing test \n")).toEqual(["fix the failing test"]);
  });

  it("puts a space before text that continues a Held Prompt", () => {
    expect(ptyWritesForHeldPrompt("and the lint", true)).toEqual([" and the lint"]);
  });

  it("never writes a line break, which could submit the line", () => {
    expect(ptyWritesForHeldPrompt("fix it:\n- the test\r\n- the lint")).toEqual(["fix it: - the test - the lint"]);
  });

  it("writes nothing for empty text", () => {
    expect(ptyWritesForHeldPrompt("   ")).toEqual([]);
  });

  it("clears with Ctrl+U once per line the prompt may wrap to, plus one", () => {
    expect(ptyWritesToClearHeldPrompt("short")).toEqual(["\u0015\u0015"]);
    expect(ptyWritesToClearHeldPrompt("x".repeat(100))).toEqual(["\u0015".repeat(6)]);
    // Typed into the pane by hand, too.
    expect(ptyWritesToClearHeldPrompt("x".repeat(100), 40)).toEqual(["\u0015".repeat(8)]);
  });
});
