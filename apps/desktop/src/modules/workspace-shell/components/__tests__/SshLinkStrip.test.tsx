import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchPtyLink } from "@/lib/tauri/pty-link";

vi.mock("@/lib/tauri/runtime", () => ({
  isTauri: () => false,
  tauriInvoke: vi.fn(() => Promise.resolve(true)),
}));

import {
  BACK_NOTICE_MS,
  SshLinkDot,
  SshLinkStrip,
  holdsInput,
  linkStripReducer,
  useLinkStrip,
  type LinkStrip,
} from "../SshLinkStrip";

const none: LinkStrip = { kind: "none" };

function Harness({
  sessionId,
  plainSsh = false,
  exitCode,
  onRelaunch,
  slot = null,
}: {
  sessionId: string;
  plainSsh?: boolean;
  exitCode?: number;
  onRelaunch?: () => void;
  slot?: Element | null;
}) {
  const link = useLinkStrip(sessionId, plainSsh);
  return (
    <>
      <SshLinkStrip state={link.state} sessionId={sessionId} onRelaunch={onRelaunch} />
      <SshLinkDot state={link.state} slot={slot} />
      <button type="button" onClick={() => link.onExit(exitCode ?? 0)}>exit</button>
    </>
  );
}

describe("linkStripReducer", () => {
  it("a drop shows the retry countdown and holds input", () => {
    const state = linkStripReducer(none, {
      type: "link",
      event: { sessionIds: ["s"], state: "reconnecting", attempt: 2, nextInMs: 8000 },
      now: 1000,
    });
    expect(state).toEqual({ kind: "reconnecting", attempt: 2, retryAt: 9000 });
    expect(holdsInput(state)).toBe(true);
  });

  it("connected after a drop is a recovery; connected from nothing says nothing", () => {
    const connected = { type: "link" as const, event: { sessionIds: ["s"], state: "connected" as const }, now: 0 };
    expect(linkStripReducer({ kind: "needs-sign-in" }, connected)).toEqual({ kind: "back" });
    expect(linkStripReducer(none, connected)).toEqual(none);
    expect(holdsInput({ kind: "back" })).toBe(false);
  });

  it("only a plain ssh pane that exits 255 shows the dropped strip", () => {
    expect(linkStripReducer(none, { type: "exit", code: 255, plainSsh: true })).toEqual({ kind: "dropped" });
    expect(linkStripReducer(none, { type: "exit", code: 255, plainSsh: false })).toEqual(none);
    expect(linkStripReducer(none, { type: "exit", code: 0, plainSsh: true })).toEqual(none);
  });
});

describe("SshLinkStrip", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows the drop, then 'Tersambung lagi' for three seconds after the link is back", () => {
    render(<Harness sessionId="pty-1" />);
    act(() => dispatchPtyLink({ sessionIds: ["pty-1"], state: "reconnecting", attempt: 1, nextInMs: 4000 }));
    expect(screen.getByText(/Koneksi putus. Agent masih jalan di VPS · coba ke-2 dalam 4 dtk/)).toBeTruthy();

    act(() => dispatchPtyLink({ sessionIds: ["pty-1"], state: "connected" }));
    expect(screen.getByText(/Tersambung lagi/)).toBeTruthy();

    act(() => vi.advanceTimersByTime(BACK_NOTICE_MS));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores events for another pane's session", () => {
    render(<Harness sessionId="pty-1" />);
    act(() => dispatchPtyLink({ sessionIds: ["pty-2"], state: "needs-sign-in" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("an expired sign-in offers the Sign in button", () => {
    render(<Harness sessionId="pty-1" />);
    act(() => dispatchPtyLink({ sessionIds: ["pty-1"], state: "needs-sign-in" }));
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  it("a plain ssh pane whose link drops says the process ended with it", () => {
    render(<Harness sessionId="pty-1" plainSsh exitCode={255} />);
    act(() => screen.getByRole("button", { name: "exit" }).click());
    expect(screen.getByText(/proses ikut berhenti/)).toBeTruthy();
  });

  it("'Buka lagi' on a dropped plain ssh pane starts it again, once", () => {
    const onRelaunch = vi.fn();
    render(<Harness sessionId="pty-1" plainSsh exitCode={255} onRelaunch={onRelaunch} />);
    act(() => screen.getByRole("button", { name: "exit" }).click());
    const reopen = screen.getByRole("button", { name: "Buka lagi" });
    act(() => reopen.click());
    act(() => reopen.click());
    expect(onRelaunch).toHaveBeenCalledTimes(1);
  });

  it("puts a dot in the pane header while the link is down", () => {
    const slot = document.createElement("span");
    document.body.appendChild(slot);
    render(<Harness sessionId="pty-1" slot={slot} />);
    expect(slot.querySelector(".ws-link-dot")).toBeNull();
    act(() => dispatchPtyLink({ sessionIds: ["pty-1"], state: "reconnecting", attempt: 0, nextInMs: 0 }));
    expect(slot.querySelector(".ws-link-dot")?.getAttribute("data-kind")).toBe("reconnecting");
    slot.remove();
  });
});
