import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasProjectMemoryPanel, type CanvasProjectMemoryPanelProps } from "./CanvasProjectMemoryPanel";
import type { CodeCanvasMemoryItem } from "@/lib/tauri/codecanvas";

const NOW = 30 * 86_400_000;

function memItem(overrides: Partial<CodeCanvasMemoryItem> = {}): CodeCanvasMemoryItem {
  return {
    id: "mem-1",
    projectId: "p1",
    scopeKind: "project",
    kind: "decision",
    title: "Use SQLite memory",
    body: "Store project memory as append-only SQLite rows.",
    importance: 5,
    tags: ["architecture"],
    metadata: {},
    source: "human",
    actorKind: "human",
    createdAt: NOW - 3_600_000,
    updatedAt: NOW - 3_600_000,
    ...overrides,
  };
}

function baseProps(overrides: Partial<CanvasProjectMemoryPanelProps> = {}): CanvasProjectMemoryPanelProps {
  return {
    open: true,
    items: [],
    loading: false,
    error: null,
    includeArchived: false,
    now: NOW,
    onSearch: vi.fn(),
    onWrite: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onSetPinned: vi.fn(),
    onIncludeArchivedChange: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

function panel() {
  return screen.getByRole("complementary", { name: /project memory/i });
}

describe("CanvasProjectMemoryPanel", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<CanvasProjectMemoryPanel {...baseProps({ open: false, items: [memItem()] })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders items with their human kind label and body", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem()] })} />);
    expect(panel()).toHaveTextContent("Store project memory as append-only SQLite rows.");
    expect(panel()).toHaveTextContent(/decision/i);
  });

  it("shows constraints as rules, grouped ahead of decisions", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({
      items: [memItem({ id: "d", kind: "decision" }), memItem({ id: "c", kind: "constraint", title: "No bare stash pop" })],
    })} />);
    const text = panel().textContent ?? "";
    expect(text).toContain("Rules");
    expect(text).toContain("Decisions");
    expect(text.indexOf("Rules")).toBeLessThan(text.indexOf("Decisions"));
  });

  it("says which rows reach agents and which do not", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({
      items: [memItem({ id: "c", kind: "constraint" }), memItem({ id: "n", kind: "note", title: undefined })],
    })} />);
    expect(screen.getByText(/read by agents/i)).toBeInTheDocument();
    expect(screen.getByText(/yours only/i)).toBeInTheDocument();
  });

  it("states kind and reach once per group, not once per card", () => {
    // Reach is a pure function of kind, and a row only ever renders inside a group whose heading
    // already names both — so four rules used to print the same two labels four times, in two
    // different wordings ("agents read this" on the card, "read by agents" on the heading).
    render(<CanvasProjectMemoryPanel {...baseProps({
      items: [
        memItem({ id: "c1", kind: "constraint", body: "One." }),
        memItem({ id: "c2", kind: "constraint", body: "Two." }),
        memItem({ id: "c3", kind: "constraint", body: "Three." }),
      ],
    })} />);
    expect(screen.getAllByText(/read by agents/i)).toHaveLength(1);
    // And the old per-card wording is gone rather than merely hidden.
    expect(screen.queryByText(/agents read this/i)).not.toBeInTheDocument();
  });

  it("renders provenance: author, age, scope and tags", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({
      items: [memItem({ tags: ["git"], updatedAt: NOW - 2 * 3_600_000, source: "agent", actorKind: "agent", actorId: "Rowan", runId: "run-1234" })],
    })} />);
    const meta = panel().textContent ?? "";
    expect(meta).toContain("Rowan");
    expect(meta).toContain("2h");
    expect(meta).toContain("run · run-123");
    expect(meta).toContain("#git");
  });

  it("surfaces an error message", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ error: "store offline" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("store offline");
  });

  it("shows a busy indicator while loading", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ loading: true })} />);
    expect(panel()).toHaveAttribute("aria-busy", "true");
  });
});

describe("CanvasProjectMemoryPanel search", () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });

  it("searches as you type, debounced, without needing a submit", () => {
    const onSearch = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ onSearch })} />);
    fireEvent.change(screen.getByRole("searchbox", { name: /search memory/i }), { target: { value: "stash" } });
    expect(onSearch).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onSearch).toHaveBeenCalledWith("stash");
  });

  it("reports the hit count so a filtered list never poses as the whole memory", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem(), memItem({ id: "m2" })] })} />);
    fireEvent.change(screen.getByRole("searchbox", { name: /search memory/i }), { target: { value: "sqlite" } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(panel()).toHaveTextContent(/2 hits/i);
  });

  it("clears back to the full list", () => {
    const onSearch = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem()], onSearch })} />);
    fireEvent.change(screen.getByRole("searchbox", { name: /search memory/i }), { target: { value: "sqlite" } });
    act(() => { vi.advanceTimersByTime(200); });
    fireEvent.click(screen.getByRole("button", { name: /clear search/i }));
    act(() => { vi.advanceTimersByTime(200); });
    expect(onSearch).toHaveBeenLastCalledWith("");
    expect(screen.getByRole("searchbox", { name: /search memory/i })).toHaveValue("");
  });
});

describe("CanvasProjectMemoryPanel filters", () => {
  const items = [
    memItem({ id: "c", kind: "constraint", title: "No bare stash pop", body: "Apply an explicit ref." }),
    memItem({ id: "n", kind: "note", title: undefined, body: "Scratch thought." }),
  ];

  it("narrows the list to one kind and back", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items })} />);
    fireEvent.click(screen.getByRole("button", { name: /filter rules/i }));
    expect(panel()).toHaveTextContent("Apply an explicit ref.");
    expect(panel()).not.toHaveTextContent("Scratch thought.");
    fireEvent.click(screen.getByRole("button", { name: /filter all/i }));
    expect(panel()).toHaveTextContent("Scratch thought.");
  });

  it("counts each kind on its chip", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items })} />);
    expect(screen.getByRole("button", { name: /filter rules/i })).toHaveTextContent("1");
  });

  it("asks the store for archived rows instead of filtering locally", () => {
    const onIncludeArchivedChange = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ items, onIncludeArchivedChange })} />);
    // A switch, not a button, and not a member of the kind rail. Archived answers "how far back
    // does this list reach", which is a different question from "which kind am I reading" — and
    // the two are not exclusive, so presenting them as siblings made the panel ask one question
    // in two voices. The role change is the semantic half of that fix.
    fireEvent.click(screen.getByRole("switch", { name: /archived/i }));
    expect(onIncludeArchivedChange).toHaveBeenCalledWith(true);
  });

  it("keeps scope out of the kind rail, so the rail is only ever about kinds", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items })} />);
    const kindFilters = screen
      .getAllByRole("button", { name: /^filter /i })
      .map((el) => el.textContent ?? "");
    expect(kindFilters.some((label) => /archived/i.test(label))).toBe(false);
  });

  it("filters by a tag from inside the row that carries it", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({
      items: [
        memItem({ id: "a", body: "Tagged one.", tags: ["verification"] }),
        memItem({ id: "b", body: "Untagged one.", tags: [] }),
      ],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /filter by tag verification/i }));
    expect(panel()).toHaveTextContent("Tagged one.");
    expect(panel()).not.toHaveTextContent("Untagged one.");
  });

  it("shows the tag filter outside the row, because that is where it can be undone", () => {
    // The filter is set from inside an item that the filter itself may scroll out of view. If the
    // only way back were the tag that started it, the list would just be short for no visible
    // reason.
    render(<CanvasProjectMemoryPanel {...baseProps({
      items: [memItem({ id: "a", body: "Tagged one.", tags: ["verification"] })],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /filter by tag verification/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove tag filter verification/i }));
    expect(panel()).toHaveTextContent("Tagged one.");
  });

  it("clears a tag filter by clicking the same tag again", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({
      items: [
        memItem({ id: "a", body: "Tagged one.", tags: ["verification"] }),
        memItem({ id: "b", body: "Untagged one.", tags: [] }),
      ],
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /filter by tag verification/i }));
    // The same tag again, from the row — the toggle everyone tries before hunting for a pill.
    fireEvent.click(screen.getByRole("button", { name: /clear tag filter verification/i }));
    expect(panel()).toHaveTextContent("Untagged one.");
  });
});

describe("CanvasProjectMemoryPanel keyboard", () => {
  // Two kinds populated, six empty — the shape the rail actually has, and the reason the empty
  // ones needed quieting in the first place.
  const items = [
    memItem({ id: "c", kind: "constraint", title: "No bare stash pop", body: "Apply an explicit ref." }),
    memItem({ id: "n", kind: "note", title: undefined, body: "Scratch thought." }),
  ];

  const expandedPanel = (extra = {}) => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items, ...extra })} />);
    fireEvent.click(screen.getByRole("button", { name: /expand project memory/i }));
  };

  it("makes the kind rail one tab stop, not nine", () => {
    // Nine controls for a single decision. As plain tab stops, reaching anything past the rail
    // costs nine presses — the roving tabindex is what turns it into a group you step INTO.
    expandedPanel();
    const rail = screen.getByRole("toolbar", { name: /filter by kind/i });
    const reachable = Array.from(rail.querySelectorAll("button")).filter(
      (b) => b.tabIndex === 0,
    );
    expect(reachable).toHaveLength(1);
  });

  it("moves through the rail with the arrows, and wraps", () => {
    expandedPanel();
    const rail = screen.getByRole("toolbar", { name: /filter by kind/i });
    const buttons = Array.from(rail.querySelectorAll("button"));
    buttons[0].focus();
    fireEvent.keyDown(rail, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(rail, { key: "ArrowUp" });
    expect(document.activeElement).toBe(buttons[0]);
    // Up from the first reaches the last rather than dead-ending.
    fireEvent.keyDown(rail, { key: "ArrowUp" });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
  });

  it("jumps to the ends with Home and End", () => {
    expandedPanel();
    const rail = screen.getByRole("toolbar", { name: /filter by kind/i });
    const buttons = Array.from(rail.querySelectorAll("button"));
    buttons[0].focus();
    fireEvent.keyDown(rail, { key: "End" });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fireEvent.keyDown(rail, { key: "Home" });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it("focuses search on /", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items })} />);
    fireEvent.keyDown(panel(), { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: /search memory/i }));
  });

  it("does not steal a slash someone is typing", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items })} />);
    const search = screen.getByRole("searchbox", { name: /search memory/i });
    fireEvent.change(search, { target: { value: "a/b" } });
    fireEvent.keyDown(search, { key: "/" });
    expect((search as HTMLInputElement).value).toBe("a/b");
  });

  it("clears the query on Escape instead of taking the panel with it", () => {
    const onClose = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ items, onClose })} />);
    const search = screen.getByRole("searchbox", { name: /search memory/i });
    fireEvent.change(search, { target: { value: "ref" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect((search as HTMLInputElement).value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marks kinds with nothing in them, so the populated ones lead the eye", () => {
    // The CSS that quiets these keys off `data-empty`. The attribute was added to the stylesheet
    // before it was added to the markup, and a rule nothing emits is indistinguishable from a
    // rule that works — this is the assertion that tells the two apart.
    expandedPanel();
    const rail = screen.getByRole("toolbar", { name: /filter by kind/i });
    const empty = rail.querySelectorAll("button[data-empty]");
    expect(empty.length).toBeGreaterThan(0);
    for (const button of empty) {
      expect(button.textContent).toMatch(/0\s*$/);
    }
  });
});

describe("CanvasProjectMemoryPanel composer", () => {
  it("stays collapsed until asked, so the list is what the panel shows first", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem()] })} />);
    expect(screen.queryByRole("textbox", { name: /memory body/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add memory/i }));
    expect(screen.getByRole("textbox", { name: /memory body/i })).toBeInTheDocument();
  });

  it("writes the chosen kind with title, body and tags, then collapses", () => {
    const onWrite = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ onWrite })} />);
    fireEvent.click(screen.getByRole("button", { name: /add memory/i }));
    fireEvent.click(screen.getByRole("button", { name: /^rule$/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /memory title/i }), { target: { value: "No bare stash pop" } });
    fireEvent.change(screen.getByRole("textbox", { name: /memory body/i }), { target: { value: "Apply an explicit ref." } });
    fireEvent.change(screen.getByRole("textbox", { name: /tags/i }), { target: { value: "git, worktree" } });
    fireEvent.click(screen.getByRole("button", { name: /save memory/i }));

    expect(onWrite).toHaveBeenCalledWith({
      kind: "constraint",
      title: "No bare stash pop",
      body: "Apply an explicit ref.",
      tags: ["git", "worktree"],
    });
    expect(screen.queryByRole("textbox", { name: /memory body/i })).not.toBeInTheDocument();
  });

  it("tells the truth about notes never reaching agents", () => {
    render(<CanvasProjectMemoryPanel {...baseProps()} />);
    fireEvent.click(screen.getByRole("button", { name: /add memory/i }));
    fireEvent.click(screen.getByRole("button", { name: /^note$/i }));
    expect(screen.getByTestId("canvas-memory-compose-hint")).toHaveTextContent(/agents never receive/i);
    fireEvent.click(screen.getByRole("button", { name: /^rule$/i }));
    expect(screen.getByTestId("canvas-memory-compose-hint")).toHaveTextContent(/every agent/i);
  });

  it("refuses a blank body", () => {
    const onWrite = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ onWrite })} />);
    fireEvent.click(screen.getByRole("button", { name: /add memory/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /memory body/i }), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /save memory/i }));
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("saves on Cmd+Enter from the body", () => {
    const onWrite = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ onWrite })} />);
    fireEvent.click(screen.getByRole("button", { name: /add memory/i }));
    const body = screen.getByRole("textbox", { name: /memory body/i });
    fireEvent.change(body, { target: { value: "Sidecar re-reads config." } });
    fireEvent.keyDown(body, { key: "Enter", metaKey: true });
    expect(onWrite).toHaveBeenCalledWith(expect.objectContaining({ body: "Sidecar re-reads config." }));
  });
});

describe("CanvasProjectMemoryPanel row actions", () => {
  it("archives an item by id and offers a real undo", () => {
    const onArchive = vi.fn();
    const onRestore = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem({ id: "mem-42" })], onArchive, onRestore })} />);
    fireEvent.click(screen.getByRole("button", { name: /archive memory/i }));
    expect(onArchive).toHaveBeenCalledWith("mem-42");
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    expect(onRestore).toHaveBeenCalledWith("mem-42");
  });

  it("lets the undo offer expire instead of sitting there forever", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem({ id: "mem-42" })] })} />);
    fireEvent.click(screen.getByRole("button", { name: /archive memory/i }));
    expect(screen.getByRole("button", { name: /undo/i })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(7_000); });
    expect(screen.queryByRole("button", { name: /undo/i })).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("pins and unpins through the store's pinned tag", () => {
    const onSetPinned = vi.fn();
    const { rerender } = render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem({ id: "mem-7" })], onSetPinned })} />);
    fireEvent.click(screen.getByRole("button", { name: /^pin memory/i }));
    expect(onSetPinned).toHaveBeenCalledWith("mem-7", true);

    rerender(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem({ id: "mem-7", tags: ["pinned"] })], onSetPinned })} />);
    expect(panel()).toHaveTextContent(/pinned/i);
    fireEvent.click(screen.getByRole("button", { name: /unpin memory/i }));
    expect(onSetPinned).toHaveBeenLastCalledWith("mem-7", false);
  });

  it("marks an archived row in text, not by dimming alone", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({
      includeArchived: true,
      items: [memItem({ id: "old", archivedAt: NOW - 86_400_000 })],
    })} />);
    // `selector` keeps this off the "Archived" filter chip, which is a button.
    expect(screen.getByText(/^archived$/i, { selector: "span" })).toBeInTheDocument();
  });

  it("restores directly from an archived row", () => {
    const onRestore = vi.fn();
    render(<CanvasProjectMemoryPanel {...baseProps({
      includeArchived: true,
      items: [memItem({ id: "old", archivedAt: NOW - 86_400_000 })],
      onRestore,
    })} />);
    fireEvent.click(screen.getByRole("button", { name: /restore memory/i }));
    expect(onRestore).toHaveBeenCalledWith("old");
  });

  it("expands a long body on demand instead of silently clipping it", () => {
    const long = `${"Long rule text. ".repeat(40)}tail-marker`;
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [memItem({ body: long })] })} />);
    const body = screen.getByTestId("canvas-memory-body-mem-1");
    expect(body).toHaveAttribute("data-clamped", "true");
    fireEvent.click(screen.getByRole("button", { name: /show full memory/i }));
    expect(screen.getByTestId("canvas-memory-body-mem-1")).toHaveAttribute("data-clamped", "false");
  });
});

describe("CanvasProjectMemoryPanel empty state", () => {
  it("explains what project memory is instead of saying nothing", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [] })} />);
    const region = panel();
    expect(region).toHaveTextContent(/shared/i);
    expect(region).toHaveTextContent(/every agent/i);
    expect(within(region).getAllByRole("listitem").length).toBeGreaterThanOrEqual(3);
  });

  it("seeds the first write from the empty state", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [] })} />);
    fireEvent.click(screen.getByRole("button", { name: /write the first rule/i }));
    expect(screen.getByRole("textbox", { name: /memory body/i })).toBeInTheDocument();
  });

  it("drops the seed button once the composer is open, so the call to action is not doubled", () => {
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [] })} />);
    fireEvent.click(screen.getByRole("button", { name: /write the first rule/i }));
    expect(screen.queryByRole("button", { name: /write the first rule/i })).not.toBeInTheDocument();
  });

  it("does not claim the project is empty when a search simply found nothing", () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<CanvasProjectMemoryPanel {...baseProps({ items: [] })} />);
    fireEvent.change(screen.getByRole("searchbox", { name: /search memory/i }), { target: { value: "zzz" } });
    act(() => { vi.advanceTimersByTime(200); });
    expect(panel()).toHaveTextContent(/no memory matches/i);
    expect(panel()).not.toHaveTextContent(/write the first rule/i);
    vi.useRealTimers();
  });
});
