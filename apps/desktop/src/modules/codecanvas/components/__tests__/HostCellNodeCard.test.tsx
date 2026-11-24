import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HostCellNodeCard } from "../nodes/HostCellNodeCard";
import { readConversationPage, type HostConversationPage } from "../../services/host-conversation";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), "../../contract/fixtures", name), "utf8"));
}

function draw(page: HostConversationPage | null, over: Partial<Parameters<typeof HostCellNodeCard>[0]> = {}) {
  return render(
    <HostCellNodeCard
      label="Rowan"
      cwd="/home/alwi/workspace"
      provider="claude"
      page={page}
      error={null}
      loading={false}
      sending={false}
      onSend={vi.fn()}
      onClose={vi.fn()}
      {...over}
    />,
  );
}

function pageOf(parts: Array<Record<string, unknown>>): HostConversationPage {
  return readConversationPage({
    paneId: "ss-1", runner: "claude", source: "ring", hasMore: false,
    turns: [{ turnId: "t1", startedAt: 1, endedAt: 2, stopReason: "end_turn", parts }],
  })!;
}

describe("a headless cell drawn as its conversation", () => {
  /**
   * Criterion 3 of ticket 12, and the claim this whole node is built around. The kinds listed in
   * that ticket came off one short conversation and the ticket says so; a part the desktop has no
   * component for must reach the screen anyway, under its real name, because a conversation that
   * quietly omits a step is a conversation that lies about what the agent did.
   */
  it("shows a part kind it has never heard of, and names it", () => {
    draw(pageOf([
      { id: "a", ts: 1, seq: 0, type: "assistant_text", text: "on it", state: "done", truncated: false },
      { id: "b", ts: 2, seq: 1, type: "subagent_spawned", text: "delegating to reviewer" },
    ]));

    const fallback = document.querySelector('[data-part-type="subagent_spawned"]');
    expect(fallback).not.toBeNull();
    expect(fallback).toHaveAttribute("data-fallback", "true");
    expect(screen.getByText("subagent_spawned")).toBeInTheDocument();
    expect(screen.getByText("delegating to reviewer")).toBeInTheDocument();
  });

  /**
   * The host's own `unknown` part carries the real event name in `rawType`. Printing "unknown"
   * there would throw away the one thing an operator could report.
   */
  it("prints the host's rawType rather than the word unknown", () => {
    draw(pageOf([{ id: "u", ts: 1, seq: 0, type: "unknown", rawType: "session/mcp_server_status", summary: "two servers up" }]));
    expect(screen.getByText("session/mcp_server_status")).toBeInTheDocument();
    expect(screen.queryByText("unknown")).toBeNull();
  });

  /**
   * The strongest version of the same claim: the payload `packages/host` and `apps/pocket` both
   * test against, rendered here, with a count rather than a spot check. If the host grows a part
   * kind and the fixture gains it, this fails until the canvas draws it — as a fallback at worst.
   */
  it("renders every part of the contract fixture, none dropped", () => {
    const page = readConversationPage(fixture("rest-conversation.json"))!;
    const expected = page.turns.reduce((total, turn) => total + turn.parts.length, 0);
    draw(page);
    expect(document.querySelectorAll("[data-part-type]")).toHaveLength(expected);
  });

  it("renders the native fixture whole too — the shape a headless cell actually serves", () => {
    const page = readConversationPage(fixture("rest-conversation-native.json"))!;
    const expected = page.turns.reduce((total, turn) => total + turn.parts.length, 0);
    draw(page);
    expect(document.querySelectorAll("[data-part-type]")).toHaveLength(expected);
  });

  /**
   * A reply the host cut at its 8000-byte cap is not a short reply. Saying nothing turns a
   * truncation into an agent that appears to have stopped mid-sentence.
   */
  it("says when the host cut a reply short", () => {
    draw(pageOf([{ id: "a", ts: 1, seq: 0, type: "assistant_text", text: "I removed the shim and", state: "done", truncated: true }]));
    expect(screen.getByText(/cut off by the host/i)).toBeInTheDocument();
  });

  /**
   * `/v1` carries dispatch and nothing else — the route that answers a permission wants the
   * pairing credential a phone holds. A button here would fail; saying where it CAN be answered
   * is the honest thing, and it is the difference between a stuck cell and a stuck operator.
   */
  it("says a permission has to be answered from the phone, instead of offering a button that cannot work", () => {
    draw(pageOf([{ id: "p", ts: 1, seq: 0, type: "permission", text: "Allow Bash(rm -rf build)?" }]));
    expect(screen.getByText(/Lotus Pocket/)).toBeInTheDocument();
  });

  /**
   * A host restarting, or one ssh hiccup, must not blank a conversation somebody is reading. The
   * error goes beside the turns, never instead of them.
   */
  it("keeps the last good conversation on screen while reporting an error over it", () => {
    draw(pageOf([{ id: "a", ts: 1, seq: 0, type: "assistant_text", text: "the answer", state: "done", truncated: false }]), {
      error: "Could not reach devbox-vps's Lotus Host",
    });
    expect(screen.getByText("the answer")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("devbox-vps");
  });

  it("sends what was typed, and clears the box only once it has", () => {
    const onSend = vi.fn();
    draw(pageOf([]), { onSend });
    const box = screen.getByLabelText("Prompt for this cell");

    fireEvent.change(box, { target: { value: "  status?  " } });
    fireEvent.keyDown(box, { key: "Enter" });

    expect(onSend).toHaveBeenCalledWith("status?");
    expect(box).toHaveValue("");
  });

  /** Shift+Enter is a newline in a prose box. Sending on it would truncate multi-line prompts. */
  it("does not send on shift+enter", () => {
    const onSend = vi.fn();
    draw(pageOf([]), { onSend });
    const box = screen.getByLabelText("Prompt for this cell");
    fireEvent.change(box, { target: { value: "line one" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  /**
   * An empty page and "this cell has never been spoken to" look identical unless one of them
   * says so — and this node's whole job is to not be an empty box beside a working agent.
   */
  it("distinguishes a cell with no turns from one it has not read yet", () => {
    const { unmount } = draw(null, { loading: true });
    expect(screen.getByText(/Reading the conversation/)).toBeInTheDocument();
    unmount();

    draw(readConversationPage({ paneId: "ss-1", runner: "claude", source: "ring", hasMore: false, turns: [] }));
    expect(screen.getByText(/No turns yet/)).toBeInTheDocument();
  });
});
