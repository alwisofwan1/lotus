import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shell's chrome against the shell's own state.
 *
 * Both modes are mocked: what is under test is the wiring between the one title bar and the
 * layout both modes read, not what a pane draws. Mocking also keeps the PTY runtime and the
 * session store out of a test about a button.
 */

const codeModeProps = vi.fn();
const chatModeProps = vi.fn();
const chatModeMounts = vi.fn();

type StatusReporter = { onStatusChange?: (status: { label: string } | null) => void };
/** The real modes render this into their rail; the mocks must too, or the row is untestable. */
type NavHost = {
  navSlot?: React.ReactNode;
  sectionSlot?: React.ReactNode;
  columnOverlay?: React.ReactNode;
  onRevealWork?: () => void;
};

/** Stands in for everything in a mode's rail that means "show me this": a pane, a folder, a thread. */
function RevealButton({ onRevealWork }: NavHost) {
  return (
    <button type="button" onClick={() => onRevealWork?.()}>
      reveal work
    </button>
  );
}

vi.mock("@/modules/workspace-shell/containers/CodeMode", () => ({
  CodeMode: (props: { railVisible: boolean } & StatusReporter & NavHost) => {
    codeModeProps(props);
    // Depends on the callback alone, exactly as the real mode does: keying the effect on the
    // whole props object would re-report on every render and loop through the parent's state.
    const report = props.onStatusChange;
    React.useEffect(() => {
      report?.({ label: "2 live sessions" });
    }, [report]);
    return (
      <div data-testid="code-mode" data-rail={String(props.railVisible)}>
        {props.navSlot}
        {props.sectionSlot}
        <RevealButton onRevealWork={props.onRevealWork} />
        {props.columnOverlay}
      </div>
    );
  },
}));

vi.mock("@/modules/workspace-shell/containers/ChatMode", () => ({
  ChatMode: (props: { railVisible: boolean } & StatusReporter & NavHost) => {
    chatModeProps(props);
    React.useEffect(() => {
      chatModeMounts();
    }, []);
    const report = props.onStatusChange;
    React.useEffect(() => {
      report?.({ label: "7 thread" });
    }, [report]);
    return (
      <div data-testid="chat-mode" data-rail={String(props.railVisible)}>
        {props.navSlot}
        {props.sectionSlot}
        {props.columnOverlay}
      </div>
    );
  },
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// The shell still mounts ChatPage's thread loader; the global invoke mock answers undefined, and
// `list.map` threw 19 unhandled rejections that turned CI red with every test passing.
vi.mock("@/modules/chat/runtime/chat-runtime-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/chat/runtime/chat-runtime-client")>()),
  listChatThreads: vi.fn(async () => []),
}));

vi.mock("@/modules/tasks/containers/TasksSurface", () => ({
  TasksSurface: (props: { onClose: () => void }) => (
    <div data-testid="tasks-surface">
      <button type="button" onClick={props.onClose}>close tasks</button>
    </div>
  ),
}));

vi.mock("@/modules/automation/components/AutomationSurface", () => ({
  AutomationSurface: (props: { onClose: () => void; navTarget?: HTMLElement | null }) => (
    <div
      data-testid="automation-surface"
      data-nav={props.navTarget === undefined ? "own" : props.navTarget ? "rail" : "waiting"}
    >
      <button type="button" onClick={props.onClose}>close automation</button>
    </div>
  ),
}));

import { WorkspaceShellPage } from "../WorkspaceShellPage";

function renderShell() {
  return render(<WorkspaceShellPage />);
}

describe("WorkspaceShellPage — one rail toggle for both modes", () => {
  beforeEach(() => {
    window.localStorage.clear();
    codeModeProps.mockClear();
    chatModeProps.mockClear();
  });

  it("collapses the rail of whichever mode is showing", () => {
    renderShell();
    expect(screen.getByTestId("code-mode").dataset.rail).toBe("true");

    fireEvent.click(screen.getByLabelText("Toggle rail"));

    expect(screen.getByTestId("code-mode").dataset.rail).toBe("false");
  });

  it("answers the shortcut the rest of the app already uses for a sidebar", () => {
    // The modifier is platform-dependent and read from `navigator.platform`, which jsdom leaves
    // empty — so the target platform has to be stated for the assertion to mean Cmd+B.
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    renderShell();

    fireEvent.keyDown(window, { key: "b", metaKey: true });

    expect(screen.getByTestId("code-mode").dataset.rail).toBe("false");
  });

  it("remembers the choice, because a collapsed rail is a layout decision", () => {
    const { unmount } = renderShell();
    fireEvent.click(screen.getByLabelText("Toggle rail"));
    unmount();

    renderShell();
    expect(screen.getByTestId("code-mode").dataset.rail).toBe("false");
  });
});

describe("WorkspaceShellPage — the status pill", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("says what the showing mode actually reports, not a number written into the chrome", () => {
    renderShell();
    expect(screen.getByText("2 live sessions")).toBeTruthy();
  });

  it("follows the mode switch", () => {
    renderShell();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByText("7 thread")).toBeTruthy();
    expect(screen.queryByText("2 live sessions")).toBeNull();
  });
});

describe("WorkspaceShellPage — keep-alive per mode", () => {
  beforeEach(() => {
    window.localStorage.clear();
    chatModeMounts.mockClear();
  });

  it("does not build Chat until someone asks for it", () => {
    renderShell();
    expect(screen.queryByTestId("chat-mode")).toBeNull();
    expect(chatModeMounts).not.toHaveBeenCalled();
  });

  it("keeps Chat alive once it has been shown, so a reply in flight survives a look at Code", () => {
    renderShell();

    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(chatModeMounts).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("tab", { name: "Code" }));
    // Still in the tree, just not shown — the same trade Code already gets, for the same reason.
    expect(screen.getByTestId("chat-mode")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(chatModeMounts).toHaveBeenCalledTimes(1);
  });

  it("hides the mode that is not showing rather than leaving both visible", () => {
    renderShell();
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));

    const chatSurface = screen.getByTestId("chat-mode").closest(".ws-surface");
    const codeSurface = screen.getByTestId("code-mode").closest(".ws-surface");
    expect(chatSurface?.getAttribute("data-active")).toBe("true");
    expect(codeSurface?.getAttribute("aria-hidden")).toBe("true");
  });
});

/**
 * Tasks is reached from the sidebar, the way `bb` reaches it — not from the mode switcher.
 *
 * The distinction is behavioural, not decorative: a mode REPLACES what the window is doing, and a
 * panel covers it while everything underneath keeps running. These tests pin both halves.
 */
describe("the tracker panel", () => {
  // The layout is persisted, so earlier tests in this file leave a mode and an open panel behind.
  beforeEach(() => localStorage.clear());

  it("is offered in the rail, and is not a fourth segment in the switcher", () => {
    render(<WorkspaceShellPage />);

    const segments = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(segments).toEqual(["Canvas", "Code", "Chat"]);
    expect(screen.getByRole("button", { name: /Tasks/ })).toBeTruthy();
  });

  it("opens over the mode, and leaves it mounted underneath", () => {
    render(<WorkspaceShellPage />);
    expect(screen.queryByTestId("tasks-surface")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));

    expect(screen.getByTestId("tasks-surface")).toBeTruthy();
    // Still there — stepping into the tracker must not cost a terminal.
    expect(screen.getByTestId("code-mode")).toBeTruthy();
  });

  it("leaves the rail it was opened from alive, which is the way back out", () => {
    render(<WorkspaceShellPage />);
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));

    // The mode surface stays reachable: only its working area is covered, by the panel the mode
    // itself renders. Covering the whole surface would take the Tasks row with it.
    const codeSurface = screen.getByTestId("code-mode").closest(".ws-surface");
    expect(codeSurface).toHaveAttribute("data-active", "true");
    expect(codeSurface).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /Tasks/ })).toBeTruthy();
    // `shown` is the mode's keyboard gate: ⌘T must not open a pane behind the tracker.
    expect(codeModeProps).toHaveBeenLastCalledWith(expect.objectContaining({ shown: false }));
  });

  /*
    The reported bug: with Tasks open, clicking a pane in the rail moved the highlight and focused
    the pane — and the window went on drawing the tracker, so from the outside nothing happened.
    The rail is deliberately alive under the panel, so every one of its actions can be taken from
    here, and each of them means "show me the work".
  */
  it("steps aside when the rail is asked to show a pane", () => {
    render(<WorkspaceShellPage />);
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.getByTestId("tasks-surface")).toBeTruthy();

    fireEvent.click(screen.getByText("reveal work"));

    expect(screen.queryByTestId("tasks-surface")).toBeNull();
    // And the mode gets its keyboard back in the same motion, not one click later.
    expect(codeModeProps).toHaveBeenLastCalledWith(expect.objectContaining({ shown: true }));
  });

  it("gives the panel back on close", () => {
    render(<WorkspaceShellPage />);
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    fireEvent.click(screen.getByText("close tasks"));

    expect(screen.queryByTestId("tasks-surface")).toBeNull();
    expect(screen.getByTestId("code-mode").closest(".ws-surface")).toHaveAttribute("data-active", "true");
  });
});

/**
 * Automation sits in the same sidebar, directly above Tasks: another panel you step into, and
 * only one panel covers the working area at a time.
 */
describe("the automation panel", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("is reached from a sidebar row directly above Tasks", () => {
    renderShell();
    const rows = screen.getAllByRole("button", { name: /^(Automation|Tasks)/ }).map((b) => b.textContent);
    expect(rows[0]).toMatch(/^Automation/);
    expect(rows[1]).toMatch(/^Tasks/);
  });

  it("opens over the working area and takes the place of Tasks", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.getByTestId("tasks-surface")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Automation/ }));

    expect(screen.getByTestId("automation-surface")).toBeTruthy();
    expect(screen.queryByTestId("tasks-surface")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Tasks/ }));
    expect(screen.queryByTestId("automation-surface")).toBeNull();
    expect(screen.getByTestId("tasks-surface")).toBeTruthy();
  });

  it("closes from its own close button", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /^Automation/ }));
    fireEvent.click(screen.getByText("close automation"));
    expect(screen.queryByTestId("automation-surface")).toBeNull();
  });
});

/** Automations draws its sidebar in the window's rail, so the window has one sidebar, not two. */
describe("the automation sidebar in the rail", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("takes the rail's place, with a way back to the workspaces", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /^Automation/ }));
    expect(screen.getByTestId("automation-surface")).toHaveAttribute("data-nav", "rail");
    fireEvent.click(screen.getByRole("button", { name: "Back to Workspaces" }));
    expect(screen.queryByTestId("automation-surface")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to Workspaces" })).toBeNull();
  });

  it("follows the showing mode, and says Threads in Chat", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /^Automation/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByRole("button", { name: "Back to Threads" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Back to Workspaces" })).toBeNull();
    expect(screen.getByTestId("automation-surface")).toHaveAttribute("data-nav", "rail");
  });

  it("draws its own sidebar again while the rail is hidden", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /^Automation/ }));
    fireEvent.click(screen.getByLabelText("Toggle rail"));
    expect(screen.getByTestId("automation-surface")).toHaveAttribute("data-nav", "own");
    expect(screen.queryByRole("button", { name: "Back to Workspaces" })).toBeNull();
  });
});
