import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Node } from "@xyflow/react";

vi.mock("@/lib/tauri-api", () => ({
  detectInstalledClis: vi.fn(async () => [
    { id: "claude", name: "Claude Code", command: "claude", installed: true },
  ]),
  listRunners: vi.fn(async () => ({ runners: [] })),
  listAccounts: vi.fn(async () => []),
}));

import { useCanvasCommandSheet } from "../useCanvasCommandSheet";
import { CanvasCommandSheet } from "../../components/CanvasCommandSheet";
import type { CanvasCommand } from "../../services/commands/canvas-command";

/**
 * A stand-in for the NL command bar: it owns the text, the sheet reads it. That split is the whole
 * point of the merge, so the harness mirrors it rather than letting the hook hold a query.
 */
function Harness(props: {
  runCommand?: (c: CanvasCommand) => void;
  onSend?: () => void;
  enabled?: boolean;
  nodes?: Node[];
  onInvoke?: () => void;
  onPlaceTask?: (task: unknown, options?: { openInDock?: boolean }) => void;
  onOpenFile?: (path: string) => void;
}) {
  const [text, setText] = useState("");
  const sheet = useCanvasCommandSheet({
    query: text,
    nodes: props.nodes ?? [],
    nav: {
      onOpenSettings: vi.fn(),
      onOpenCanvases: vi.fn(),
      trackerTasks: [{ id: "t1", workspaceId: "ws", title: "Rilis dua", key: "FT-1", workspaceName: "Flow", statusLabel: "Todo", nodeId: null }],
      onPlaceTask: props.onPlaceTask,
      onOpenFile: props.onOpenFile,
      loadProjectFiles: props.onOpenFile ? async () => ["/repo/src/a.ts"] : undefined,
      rootDir: "/repo",
    },
    runCommand: props.runCommand ?? vi.fn(),
    onSend: props.onSend ?? vi.fn(),
    onClearQuery: () => setText(""),
    enabled: props.enabled ?? true,
    onInvoke: props.onInvoke,
  });
  return (
    <div>
      {sheet.open && (
        <CanvasCommandSheet
          items={sheet.items}
          activeIndex={sheet.activeIndex}
          query={text}
          grouped={sheet.grouped}
          onHover={sheet.setActiveIndex}
          onRun={(i) => sheet.run(i)}
        />
      )}
      <textarea
        aria-label="bar"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (sheet.handleKeyDown(e)) return; }}
      />
      <span data-testid="open">{String(sheet.open)}</span>
    </div>
  );
}

const bar = () => screen.getByLabelText("bar");
const isOpen = () => screen.getByTestId("open").textContent === "true";
const rows = () => screen.queryAllByRole("option");
const activeRow = () => rows().find((r) => r.getAttribute("aria-selected") === "true");
const type = (value: string) => fireEvent.change(bar(), { target: { value } });
const cmdK = () => act(() => { fireEvent.keyDown(window, { key: "k", metaKey: true }); });

beforeEach(() => vi.clearAllMocks());

describe("command sheet — opening", () => {
  it("opens on ⌘K with an empty query and keeps it open", () => {
    // The regression this guards: an "is it open" boolean would be set by the shortcut and cleared
    // by the auto-open rule on the very next render, because an empty query matches nothing.
    render(<Harness />);
    expect(isOpen()).toBe(false);
    cmdK();
    expect(isOpen()).toBe(true);
    expect(rows().length).toBeGreaterThan(0);
  });

  it("calls onInvoke before opening, so the bar can take focus", () => {
    const onInvoke = vi.fn();
    render(<Harness onInvoke={onInvoke} />);
    cmdK();
    expect(onInvoke).toHaveBeenCalledOnce();
  });

  it("opens itself once the query is a plausible command", () => {
    render(<Harness />);
    type("n");
    expect(isOpen()).toBe(false); // below the character floor
    type("no");
    expect(isOpen()).toBe(true);
  });

  it("closes itself again when the query stops matching anything", () => {
    render(<Harness />);
    type("note");
    expect(isOpen()).toBe(true);
    type("tolong rapikan node yang berantakan");
    expect(isOpen()).toBe(false);
  });

  it("never opens while disabled, and closes if it becomes disabled", () => {
    const { rerender } = render(<Harness enabled />);
    type("note");
    expect(isOpen()).toBe(true);
    // A live voice session replaces the input the sheet belongs to.
    rerender(<Harness enabled={false} />);
    expect(isOpen()).toBe(false);
  });
});

describe("command sheet — dismissal latch", () => {
  it("stays closed after Escape even though the query still matches", () => {
    // Without the latch, Escape closes the sheet and the auto-open rule immediately re-opens it:
    // the query that triggered it is still sitting in the bar.
    render(<Harness />);
    type("note");
    expect(isOpen()).toBe(true);
    fireEvent.keyDown(bar(), { key: "Escape" });
    expect(isOpen()).toBe(false);
  });

  it("re-opens once the user types something different", () => {
    render(<Harness />);
    type("note");
    fireEvent.keyDown(bar(), { key: "Escape" });
    expect(isOpen()).toBe(false);
    type("note ");
    expect(isOpen()).toBe(true);
  });

  it("⌘K overrides a standing dismissal — an explicit ask is never ignored", () => {
    render(<Harness />);
    type("note");
    fireEvent.keyDown(bar(), { key: "Escape" });
    cmdK();
    expect(isOpen()).toBe(true);
  });

  it("reports Escape as consumed so the canvas behind does not also act on it", () => {
    render(<Harness />);
    type("note");
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    const stop = vi.spyOn(event, "stopPropagation");
    act(() => { bar().dispatchEvent(event); });
    expect(stop).toHaveBeenCalled();
  });
});

describe("command sheet — running a row", () => {
  it("runs a task row's second action on ⌘↵, and names it on the active row (board 18)", () => {
    const onPlaceTask = vi.fn();
    render(<Harness onPlaceTask={onPlaceTask} />);
    cmdK();
    type("rilis dua");
    expect(activeRow()).toHaveTextContent("⌘↵ open in Tasks");
    fireEvent.keyDown(bar(), { key: "Enter", metaKey: true });
    expect(onPlaceTask).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }), { openInDock: true });
  });

  it("runs the selected row on Enter and clears the query it consumed", () => {
    const runCommand = vi.fn();
    render(<Harness runCommand={runCommand} />);
    type("create note");
    fireEvent.keyDown(bar(), { key: "ArrowDown" }); // adopt the list
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "note" });
    // Leaving "create note" in the bar would re-open the sheet on the next render.
    expect((bar() as HTMLTextAreaElement).value).toBe("");
    expect(isOpen()).toBe(false);
  });

  it("walks rows with the arrow keys", () => {
    render(<Harness />);
    cmdK();
    const first = activeRow()?.textContent;
    expect(first).toBeTruthy(); // ⌘K selects its first row immediately
    fireEvent.keyDown(bar(), { key: "ArrowDown" });
    expect(activeRow()?.textContent).not.toBe(first);
    fireEvent.keyDown(bar(), { key: "ArrowUp" });
    expect(activeRow()?.textContent).toBe(first);
  });

  it("does not walk past either end of the list", () => {
    render(<Harness />);
    cmdK();
    fireEvent.keyDown(bar(), { key: "ArrowUp" });
    expect(rows().indexOf(activeRow()!)).toBe(0);
    for (let i = 0; i < rows().length + 3; i++) fireEvent.keyDown(bar(), { key: "ArrowDown" });
    expect(rows().indexOf(activeRow()!)).toBe(rows().length - 1);
  });

  it("sends the raw text through the pipeline from the send row, without clearing it", () => {
    // The bar's own submit clears the text as part of submitting; the sheet must not do it twice
    // (and must not clear text that a failed submit still needs).
    const onSend = vi.fn();
    const runCommand = vi.fn();
    render(<Harness onSend={onSend} runCommand={runCommand} />);
    type("tolong rapikan node itu");
    cmdK();
    // Only the send row survives such a query, so ⌘K selects it.
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
    expect(runCommand).not.toHaveBeenCalled();
    expect((bar() as HTMLTextAreaElement).value).toBe("tolong rapikan node itu");
  });

  it("reports Enter as consumed, so the bar does not also submit the prose behind the row", () => {
    // The single most important contract of the merge: one Enter, one action.
    const runCommand = vi.fn();
    let barSubmitted = false;
    function Bar() {
      const [text, setText] = useState("");
      const sheet = useCanvasCommandSheet({
        query: text, nodes: [], runCommand, onSend: vi.fn(), onClearQuery: () => setText(""),
        enabled: true,
      });
      return (
        <textarea
          aria-label="bar"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (sheet.handleKeyDown(e)) return;
            if (e.key === "Enter" && !e.shiftKey) barSubmitted = true;
          }}
        />
      );
    }
    render(<Bar />);
    type("create note");
    fireEvent.keyDown(bar(), { key: "ArrowDown" });
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(runCommand).toHaveBeenCalledOnce();
    expect(barSubmitted).toBe(false);
  });

  it("leaves Enter to the bar when the sheet is closed", () => {
    let barSubmitted = false;
    function Bar() {
      const [text, setText] = useState("");
      const sheet = useCanvasCommandSheet({
        query: text, nodes: [], runCommand: vi.fn(), onSend: vi.fn(), onClearQuery: () => setText(""),
        enabled: true,
      });
      return (
        <textarea
          aria-label="bar"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (sheet.handleKeyDown(e)) return;
            if (e.key === "Enter") barSubmitted = true;
          }}
        />
      );
    }
    render(<Bar />);
    type("tolong rapikan node yang berantakan");
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(barSubmitted).toBe(true);
  });

  it("runs a row on pointer-down without stealing focus from the bar", () => {
    const runCommand = vi.fn();
    render(<Harness runCommand={runCommand} />);
    type("create task");
    const row = rows().find((r) => /Create Task/.test(r.textContent ?? ""))!;
    fireEvent.pointerDown(row);
    expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "task" });
  });
});

describe("command sheet — an auto-opened sheet is advisory", () => {
  it("selects no row when it opens itself", () => {
    // The contract that lets the sheet open on its own without changing what the bar does.
    render(<Harness />);
    type("create note");
    expect(isOpen()).toBe(true);
    expect(activeRow()).toBeUndefined();
  });

  it("leaves Enter to the bar while no row is selected, even with the sheet open", () => {
    // The regression this locks down was caught by the NL bar's own suite: the first build made the
    // sheet own Enter the moment it appeared, so "add a terminal" + Enter stopped reaching the NL
    // pipeline and silently ran a catalog row instead.
    const runCommand = vi.fn();
    let barSubmitted = false;
    function Bar() {
      const [text, setText] = useState("");
      const sheet = useCanvasCommandSheet({
        query: text, nodes: [], runCommand, onSend: vi.fn(), onClearQuery: () => setText(""),
        enabled: true,
      });
      return (
        <div>
          <textarea
            aria-label="bar"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (sheet.handleKeyDown(e)) return;
              if (e.key === "Enter") barSubmitted = true;
            }}
          />
          <span data-testid="open">{String(sheet.open)}</span>
        </div>
      );
    }
    render(<Bar />);
    type("add a terminal");
    expect(isOpen()).toBe(true); // the sheet IS showing…
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(barSubmitted).toBe(true); // …and Enter still went to the bar
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("adopts the list on the first ArrowDown, and from then on Enter runs the row", () => {
    const runCommand = vi.fn();
    render(<Harness runCommand={runCommand} />);
    type("create note");
    expect(activeRow()).toBeUndefined();
    fireEvent.keyDown(bar(), { key: "ArrowDown" });
    expect(activeRow()).toBeDefined();
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(runCommand).toHaveBeenCalledWith({ kind: "create-node", nodeType: "note" });
  });

  it("jumps ArrowUp straight to the last row, which is always the send row", () => {
    // One keystroke to the escape hatch, the way a URL bar reaches its last suggestion.
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    type("create note");
    fireEvent.keyDown(bar(), { key: "ArrowUp" });
    expect(activeRow()?.getAttribute("data-group")).toBe("send");
    fireEvent.keyDown(bar(), { key: "Enter" });
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("selects the first row immediately when ⌘K asked for the list", () => {
    render(<Harness />);
    type("create note");
    expect(activeRow()).toBeUndefined();
    cmdK();
    expect(activeRow()).toBeDefined();
  });
});

describe("command sheet — presentation", () => {
  it("tags every row and keeps the send row last", () => {
    render(<Harness />);
    type("note");
    const all = rows();
    const send = all[all.length - 1];
    expect(send.getAttribute("data-group")).toBe("send");
    expect(send).toHaveTextContent("SEND");
  });

  it("shows section headings while browsing, and drops them once ranked", () => {
    // Searching sorts by relevance, so the groups are no longer contiguous — a heading there would
    // label rows that do not belong to it. The tag column carries the classification instead.
    render(<Harness />);
    cmdK();
    expect(document.querySelector(".canvas-sheet")).toHaveAttribute("data-mode", "browse");
    expect(document.querySelector(".canvas-sheet-section")).not.toBeNull();

    type("note");
    expect(document.querySelector(".canvas-sheet")).toHaveAttribute("data-mode", "search");
    expect(document.querySelector(".canvas-sheet-section")).toBeNull();
  });

  it("highlights the matched run inside a row title", () => {
    render(<Harness />);
    type("terminal");
    const marks = Array.from(document.querySelectorAll(".canvas-sheet-row-title mark"));
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.some((m) => /terminal/i.test(m.textContent ?? ""))).toBe(true);
  });

  it("is a listbox beside the bar, never a modal dialog", () => {
    // The old palette was role=dialog aria-modal with a scrim because it owned an input and trapped
    // focus. This one must not be: focus stays in the bar, so a dialog role would lie to a screen
    // reader about where the user is.
    render(<Harness />);
    cmdK();
    expect(screen.getByRole("listbox", { name: "Canvas commands" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("command sheet — Open file…", () => {
  it("⌘K shows an Open file… row before anything is typed", () => {
    render(<Harness onOpenFile={vi.fn()} />);
    cmdK();
    expect(rows().some((r) => /Search project files/.test(r.textContent ?? ""))).toBe(true);
  });

  it("running that row hands the bar back for typing: the sheet stays open and no file opens", () => {
    const onOpenFile = vi.fn();
    const onInvoke = vi.fn();
    render(<Harness onOpenFile={onOpenFile} onInvoke={onInvoke} />);
    cmdK();
    const row = rows().find((r) => /Search project files/.test(r.textContent ?? ""))!;
    onInvoke.mockClear();
    fireEvent.pointerDown(row);
    expect(isOpen()).toBe(true);
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(onInvoke).toHaveBeenCalledOnce();
  });

  it("has no such row on a board that cannot open files", () => {
    render(<Harness />);
    cmdK();
    expect(rows().some((r) => /Search project files/.test(r.textContent ?? ""))).toBe(false);
  });
});
