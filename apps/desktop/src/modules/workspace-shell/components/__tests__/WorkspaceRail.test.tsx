import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceRail } from "../WorkspaceRail";
import type { RailWorkspace } from "@/modules/workspace-shell/types";
import { LotusSettingsProvider } from "@/modules/lotus-settings/lotus-settings-context";
import { settingsSectionStub } from "@/modules/lotus-settings/testing/settings-section-stub";

const WORKSPACES: RailWorkspace[] = [
  {
    id: "lotus",
    name: "lotus",
    liveCount: 2,
    active: true,
    panes: [
      { id: "claude", kind: "terminal", title: "Claude Code", meta: "apps/desktop", activity: "working" },
      { id: "thread", kind: "thread", title: "Kenapa drag salah?", meta: "thread · claude", activity: "needs-you" },
    ],
  },
  { id: "pocket", name: "pocket", panes: [] },
];

function renderRail(overrides: Partial<React.ComponentProps<typeof WorkspaceRail>> = {}) {
  const props = {
    workspaces: WORKSPACES,
    openWorkspaceIds: ["lotus"],
    activePaneId: "thread",
    onToggleWorkspace: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onSelectPane: vi.fn(),
    onAddPane: vi.fn(),
    onTogglePin: vi.fn(),
    onRenameWorkspace: vi.fn(),
    ...overrides,
  };
  render(
    <LotusSettingsProvider sections={[settingsSectionStub("lotus", "editor"), settingsSectionStub("code", "codespace")]}>
      <WorkspaceRail {...props} />
    </LotusSettingsProvider>,
  );
  return props;
}

/** The folder's own row, which is what the expanded/collapsed state is written on. */
function folderOf(name: string): HTMLElement {
  const row = screen.getByRole("button", { name }).closest(".ws-rail-folder");
  if (!row) throw new Error(`no folder row for ${name}`);
  return row as HTMLElement;
}

describe("WorkspaceRail", () => {
  it("opens Lotus Settings on Code › CodeSpace from its gear", () => {
    renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "codespace" })).toHaveAttribute("aria-selected", "true");
  });

  it("lists every workspace, expanded or not", () => {
    renderRail();
    expect(screen.getByRole("button", { name: "lotus" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "pocket" })).toBeTruthy();
  });

  it("gives each workspace its own add trigger, as a sibling of the disclosure", () => {
    const props = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Add pane in lotus" }));
    expect(props.onAddPane).toHaveBeenCalledWith(
      expect.objectContaining({ id: "lotus" }),
      expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    );
    // Opening the menu must not also collapse the folder under it.
    expect(props.onToggleWorkspace).not.toHaveBeenCalled();
  });

  it("shows panes of an open workspace and folds a closed one", () => {
    renderRail({ openWorkspaceIds: ["lotus"] });
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // The rows of a closed folder stay mounted so the fold can animate, so what makes them
    // "hidden" has to be the state a screen reader and the tab order read.
    const closed = folderOf("pocket").querySelector(".ws-rail-panes");
    expect(closed?.getAttribute("aria-hidden")).toBe("true");
    expect(folderOf("lotus").getAttribute("data-open")).toBe("true");
  });

  it("marks the active pane for assistive tech, not just visually", () => {
    renderRail();
    const active = screen.getByText("Kenapa drag salah?").closest("button");
    expect(active?.getAttribute("aria-current")).toBe("true");
  });

  it("reports the expanded state of a group on its disclosure", () => {
    renderRail({ openWorkspaceIds: [] });
    expect(screen.getByRole("button", { name: "Expand lotus" }).getAttribute("aria-expanded")).toBe("false");
    expect(folderOf("lotus").getAttribute("data-open")).toBe(null);
  });

  it("says which folder is the one on screen, separately from which are expanded", () => {
    renderRail({ openWorkspaceIds: ["lotus", "pocket"] });
    const lotus = screen.getByRole("button", { name: "lotus" }).closest(".ws-rail-group");
    const pocket = screen.getByRole("button", { name: "pocket" }).closest(".ws-rail-group");
    expect(lotus?.getAttribute("data-active")).toBe("true");
    expect(pocket?.getAttribute("data-active")).toBe(null);
  });

  it("offers to open a pane in an expanded workspace with nothing running", () => {
    const props = renderRail({ openWorkspaceIds: ["pocket"] });
    const row = screen.getByRole("button", { name: "Open a pane" });
    expect(row.getAttribute("title")).toBe("Nothing is running in this folder");
    fireEvent.click(row);
    expect(props.onAddPane).toHaveBeenCalled();
  });

  it("separates expanding a folder from showing it", () => {
    const props = renderRail();
    // The chevron folds and nothing else: another folder must be able to stay open.
    fireEvent.click(screen.getByRole("button", { name: "Expand pocket" }));
    expect(props.onToggleWorkspace).toHaveBeenCalledWith("pocket");
    expect(props.onOpenWorkspace).not.toHaveBeenCalled();

    // The row itself is what brings a folder to the screen.
    fireEvent.click(screen.getByRole("button", { name: "pocket" }));
    expect(props.onOpenWorkspace).toHaveBeenCalledWith("pocket");
  });

  it("selects a pane through the callback, with the workspace that holds it", () => {
    const props = renderRail();
    fireEvent.click(screen.getByText("Claude Code"));
    expect(props.onSelectPane).toHaveBeenCalledWith(
      expect.objectContaining({ id: "claude" }),
      expect.objectContaining({ id: "lotus" }),
    );
  });

  it("pins and unpins a workspace, and says which state the trigger is in", () => {
    const props = renderRail({
      workspaces: [{ ...WORKSPACES[0], pinned: true }, WORKSPACES[1]],
    });
    const unpin = screen.getByRole("button", { name: "Unpin lotus" });
    expect(unpin.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(unpin);
    expect(props.onTogglePin).toHaveBeenCalledWith("lotus");

    fireEvent.click(screen.getByRole("button", { name: "Pin pocket" }));
    expect(props.onTogglePin).toHaveBeenCalledWith("pocket");
  });

  it("renames in place, committing on Enter", () => {
    const props = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Rename lotus" }));
    const field = screen.getByLabelText("Workspace name lotus") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "  Lotus Desktop  " } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onRenameWorkspace).toHaveBeenCalledWith("lotus", "Lotus Desktop");
  });

  it("treats Escape, and an empty name, as no rename at all", () => {
    const props = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Rename lotus" }));
    const field = screen.getByLabelText("Workspace name lotus") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "sesuatu" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(props.onRenameWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rename lotus" }));
    const again = screen.getByLabelText("Workspace name lotus") as HTMLInputElement;
    fireEvent.change(again, { target: { value: "   " } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(props.onRenameWorkspace).not.toHaveBeenCalled();
  });

  it("renames on a double click of the name, which is where a rename is reached for", () => {
    const props = renderRail();
    fireEvent.doubleClick(screen.getByRole("button", { name: "lotus" }));
    const field = screen.getByLabelText("Workspace name lotus") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "lotus-2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(props.onRenameWorkspace).toHaveBeenCalledWith("lotus", "lotus-2");
  });
});

describe("the rail's headings", () => {
  it("shows none while nothing is pinned", () => {
    renderRail();
    expect(screen.queryByText("Pinned")).toBeNull();
    expect(document.querySelector(".ws-rail-section")).toBeNull();
  });

  it("separates pinned folders from the rest, in order", () => {
    renderRail({ workspaces: [{ ...WORKSPACES[1], pinned: true }, WORKSPACES[0]] });
    expect(screen.getByText("Pinned")).toBeTruthy();
    const headings = [...document.querySelectorAll(".ws-rail-section, .ws-rail-group-name")].map(
      (node) => node.textContent,
    );
    expect(headings).toEqual(["Pinned", "pocket", "Workspaces", "lotus"]);
  });
});

/**
 * The rail is where an ask is found. A colour alone would leave it findable only by whoever can
 * separate the hues, and a fold would hide it entirely.
 */
describe("the rail says who is waiting", () => {
  it("names the ask on the row, in words, without a dot on the mark", () => {
    renderRail();
    const row = screen.getByText("Kenapa drag salah?").closest(".ws-rail-item");
    expect(row?.querySelector(".ws-rail-item-meta")?.textContent).toContain("needs you");
    // Chat's rule: one mark per row. The state is words on the second line, not a corner dot.
    expect(row?.querySelector(".ws-rail-item-mark .ws-activity")).toBeNull();
  });

  it("marks the row so the dot can state it too", () => {
    renderRail();
    const rows = [...document.querySelectorAll(".ws-rail-item")].map((row) =>
      row.getAttribute("data-activity"),
    );
    expect(rows).toContain("needs-you");
    expect(rows).toContain("working");
  });

  it("flags a turn that just ended for ~600ms, so the halo can close and release", () => {
    vi.useFakeTimers();
    try {
      const rail = (workspaces: RailWorkspace[]) => (
        <LotusSettingsProvider sections={[settingsSectionStub("lotus", "editor")]}>
          <WorkspaceRail
            workspaces={workspaces}
            openWorkspaceIds={["lotus"]}
            activePaneId={null}
            onToggleWorkspace={vi.fn()}
            onOpenWorkspace={vi.fn()}
            onSelectPane={vi.fn()}
          />
        </LotusSettingsProvider>
      );
      const ended = WORKSPACES.map((w) => ({
        ...w,
        panes: w.panes.map((p) => (p.id === "claude" ? { ...p, activity: "idle" as const } : p)),
      }));
      const { rerender } = render(rail(WORKSPACES));
      const row = () => screen.getByText("Claude Code").closest(".ws-rail-item");
      expect(row()?.getAttribute("data-done")).toBeNull();
      rerender(rail(ended));
      expect(row()?.getAttribute("data-done")).toBe("true");
      // needs-you never had the flag: only working → idle/done earns it.
      expect(screen.getByText("Kenapa drag salah?").closest(".ws-rail-item")?.getAttribute("data-done")).toBeNull();
      act(() => vi.advanceTimersByTime(600));
      expect(row()?.getAttribute("data-done")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts asks on the FOLDER, so a collapsed folder can still say it", () => {
    renderRail({ workspaces: [{ ...WORKSPACES[0], needsYouCount: 1 }] });
    const count = document.querySelector('.ws-rail-count[data-tone="ask"]');
    expect(count?.textContent).toBe("1");
    expect(count?.getAttribute("title")).toContain("waiting");
  });

  it("a folded folder draws a ring while one of its agents works; an open one leaves it to the rows", () => {
    renderRail({ workspaces: [{ ...WORKSPACES[0], workingCount: 2 }], openWorkspaceIds: [] });
    expect(document.querySelector(".ws-rail-group-working")?.getAttribute("aria-label")).toBe("2 working");
  });

  it("an open folder draws no folder ring", () => {
    renderRail({ workspaces: [{ ...WORKSPACES[0], workingCount: 2 }], openWorkspaceIds: [WORKSPACES[0].id] });
    expect(document.querySelector(".ws-rail-group-working")).toBeNull();
  });

  it("shows no ask count for a folder where nobody is waiting", () => {
    renderRail({ workspaces: [{ ...WORKSPACES[0], needsYouCount: 0 }] });
    expect(document.querySelector('.ws-rail-count[data-tone="ask"]')).toBeNull();
  });
});

describe("WorkspaceRail unread results", () => {
  it("marks a row whose finished turn nobody has opened", () => {
    renderRail({
      workspaces: [
        {
          id: "lotus",
          name: "lotus",
          active: true,
          panes: [
            { id: "done", kind: "terminal", title: "Claude Code", meta: "", activity: "idle", unread: true },
            { id: "read", kind: "terminal", title: "Codex", meta: "", activity: "idle" },
          ],
        },
      ],
    });

    const unreadRow = screen.getByText("Claude Code").closest(".ws-rail-item");
    const readRow = screen.getByText("Codex").closest(".ws-rail-item");
    expect(unreadRow?.getAttribute("data-unread")).toBe("true");
    expect(unreadRow?.textContent).toContain("done");
    // The result sits in the status slot, where the working ring was.
    expect(unreadRow?.querySelector(".ws-rail-item-status .ws-rail-dither")?.getAttribute("data-state")).toBe("done");
    expect(readRow?.querySelector(".ws-rail-item-status")).toBeNull();
    expect(readRow?.hasAttribute("data-unread")).toBe(false);
  });
});

/** A section (Automations) takes the whole rail but its footer: one context at a time. */
describe("WorkspaceRail — a section in the rail's place", () => {
  const base = {
    workspaces: WORKSPACES,
    openWorkspaceIds: ["lotus"],
    activePaneId: null,
    onToggleWorkspace: vi.fn(),
    onSelectPane: vi.fn(),
    navSlot: <button type="button">Tasks</button>,
  };

  it("hides the nav rows and the list while a section shows, and slides the list back after", () => {
    const { rerender, container } = render(<WorkspaceRail {...base} sectionSlot={<p>automation channels</p>} />);
    expect(screen.getByText("automation channels")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Tasks" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Workspaces" })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Sidebar" })).toBeTruthy();

    rerender(<WorkspaceRail {...base} />);
    expect(screen.getByRole("button", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Workspaces" })).toBeTruthy();
    expect(container.querySelector(".ws-rail-main")?.getAttribute("data-enter")).toBe("back");
  });

  it("keeps the same list rows across a section, so going back rebuilds nothing", () => {
    const { rerender } = render(<WorkspaceRail {...base} />);
    const row = screen.getByRole("button", { name: "lotus" });
    rerender(<WorkspaceRail {...base} sectionSlot={<p>automation channels</p>} />);
    rerender(<WorkspaceRail {...base} />);
    expect(screen.getByRole("button", { name: "lotus" })).toBe(row);
  });

  it("does not animate the list on the first paint", () => {
    const { container } = render(<WorkspaceRail {...base} />);
    expect(container.querySelector(".ws-rail-main")?.hasAttribute("data-enter")).toBe(false);
  });
});

describe("WorkspaceRail — agent mark and search", () => {
  const withRunner: RailWorkspace[] = [
    {
      ...WORKSPACES[0],
      panes: [
        {
          id: "claude",
          kind: "terminal",
          title: "Fix the rail",
          meta: "apps/desktop",
          activity: "working",
          runner: { provider: "claude", label: "Claude", mark: { kind: "logo", src: "/assets/ai-logo/Claude.svg" } },
        },
        { id: "shell", kind: "terminal", title: "zsh", meta: "lotus", activity: "idle" },
      ],
    },
    WORKSPACES[1],
  ];

  it("draws the agent's logo for an agent pane and the kind glyph for a plain shell", () => {
    renderRail({ workspaces: withRunner });
    const agent = screen.getByText("Fix the rail").closest(".ws-rail-item");
    expect(agent?.querySelector('.ws-pane-runner-mark[data-runner="claude"]')).toBeTruthy();
    expect(agent?.querySelector(".ws-rail-item-meta")?.textContent).toContain("Claude");
    // Working is said in words too, as Chat does (2026-11-22), not only by the ring on the mark.
    expect(agent?.querySelector(".ws-rail-item-meta .ws-activity-label")?.textContent).toBe("working");
    expect(agent?.querySelector(".ws-rail-item-status .ws-rail-dither")?.getAttribute("data-state")).toBe("working");
    const shell = screen.getByText("zsh").closest(".ws-rail-item");
    expect(shell?.querySelector(".ws-pane-runner-mark")).toBeNull();
    expect(shell?.querySelector(".ws-rail-item-icon")).toBeTruthy();
  });

  it("filters to matching panes, opening their folder, and says when nothing matches", () => {
    renderRail({ workspaces: withRunner, openWorkspaceIds: [] });
    const search = screen.getByRole("searchbox", { name: "Search panes" });
    fireEvent.change(search, { target: { value: "rail" } });
    expect(screen.getByText("Fix the rail")).toBeTruthy();
    expect(screen.queryByText("zsh")).toBeNull();
    expect(screen.queryByRole("button", { name: "pocket" })).toBeNull();
    expect(folderOf("lotus").getAttribute("data-open")).toBe("true");

    fireEvent.change(search, { target: { value: "nothing-here" } });
    expect(screen.getByText(/No pane matches/)).toBeTruthy();

    fireEvent.keyDown(search, { key: "Escape" });
    expect(screen.getByRole("button", { name: "pocket" })).toBeTruthy();
  });

  it("counts running panes only on a folded folder, where the rows cannot say it", () => {
    renderRail({ openWorkspaceIds: ["lotus"] });
    expect(folderOf("lotus").querySelector(".ws-rail-group .ws-rail-count")).toBeNull();
    cleanup();
    renderRail({ openWorkspaceIds: [] });
    expect(folderOf("lotus").querySelector(".ws-rail-group .ws-rail-count")?.textContent).toBe("2");
  });

  it("offers an agent pane's actions from its ••• and closes it from there", () => {
    const { onPaneAction } = renderRail({ workspaces: withRunner, onPaneAction: vi.fn() });
    fireEvent.click(screen.getByRole("button", { name: "Actions for Fix the rail" }));
    const menu = screen.getByRole("menu", { name: "Actions for Fix the rail" });
    expect([...menu.querySelectorAll("[role=menuitem]")].map((item) => item.firstChild?.textContent)).toEqual([
      "Rename title…",
      "Regenerate title",
      "Maximize",
      "Close pane",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: /Close pane/ }));
    expect(onPaneAction).toHaveBeenCalledWith("close", withRunner[0].panes[0], withRunner[0]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("gives a shell no model title, and renames a pane in its row", () => {
    const { onPaneAction } = renderRail({ workspaces: withRunner, onPaneAction: vi.fn() });
    fireEvent.contextMenu(screen.getByText("zsh"));
    expect(screen.queryByRole("menuitem", { name: /Regenerate title/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "r" });
    const field = screen.getByRole("textbox", { name: "Pane name zsh" });
    fireEvent.change(field, { target: { value: "Dev server" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onPaneAction).toHaveBeenCalledWith("rename", withRunner[0].panes[1], withRunner[0], "Dev server");
  });
});

describe("WorkspaceRail — groups and splits", () => {
  const A = { id: "a", kind: "terminal" as const, title: "Claude Code", meta: "", activity: "working" as const };
  const B = { id: "b", kind: "terminal" as const, title: "Codex", meta: "" };
  const C = { id: "c", kind: "terminal" as const, title: "Shell", meta: "" };
  const DOCS = {
    id: "docs", name: "docs", color: "teal" as const, initial: "D", paneCount: 2, paneIds: ["a", "b"], status: "working" as const,
    marks: [A, B], moreCount: 0, split: false, panes: [A, B],
  };
  const EMPTY = { id: "empty", name: "empty", color: "rose" as const, initial: "E", paneCount: 0, paneIds: [], status: "idle" as const, marks: [], moreCount: 0, split: false, panes: [] };
  const FRAMED: RailWorkspace[] = [{ id: "lotus", name: "lotus", panes: [A, B, C], frames: [DOCS, EMPTY], loosePanes: [C] }];
  const SPLIT: RailWorkspace[] = [{ ...FRAMED[0], frames: [{ ...DOCS, id: "s", name: "", initial: "", split: true }], loosePanes: [C] }];

  it("draws a named group as a card holding its panes as rows, then the loose panes", () => {
    renderRail({ workspaces: FRAMED, activePaneId: "c" });
    const card = screen.getByRole("button", { name: /^docs/ }).closest(".ws-rail-card")!;
    expect(card.textContent).toContain("Claude Code");
    expect(card.textContent).toContain("Codex");
    expect(screen.getByRole("button", { name: /^Shell/ }).closest(".ws-rail-card")).toBeNull();
  });

  it("folds and unfolds a group from anywhere on its head, keeping the rows mounted for the animation", () => {
    renderRail({ workspaces: FRAMED, activePaneId: "c" });
    const head = screen.getByRole("button", { name: /^docs/ });
    expect(head).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    const body = head.closest(".ws-rail-card")!.querySelector(".ws-rail-card-body")!;
    expect(body).toHaveAttribute("aria-hidden", "true");
    expect(body.textContent).toContain("Codex");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a pane inside a card or loose through the pane callback", () => {
    const props = renderRail({ workspaces: FRAMED, activePaneId: "a" });
    fireEvent.click(screen.getByRole("button", { name: /^Shell/ }));
    expect(props.onSelectPane).toHaveBeenCalledWith(C, FRAMED[0]);
    fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
    expect(props.onSelectPane).toHaveBeenCalledWith(B, FRAMED[0]);
  });

  it("adds a pane from the workspace's +, never a group", () => {
    const props = renderRail({ workspaces: FRAMED, activePaneId: "c" });
    fireEvent.click(screen.getByRole("button", { name: "Add pane in lotus" }));
    expect(props.onAddPane).toHaveBeenCalledWith(FRAMED[0], expect.any(Object));
  });

  it("renames a group on a double click of its name; Escape keeps the old name", () => {
    const onRenameFrame = vi.fn();
    renderRail({ workspaces: FRAMED, activePaneId: "c", onRenameFrame });
    fireEvent.doubleClick(screen.getByText("docs"));
    const field = screen.getByRole("textbox", { name: "Group name docs" });
    fireEvent.change(field, { target: { value: "Docs v2" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onRenameFrame).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("folds a card: its rows go, and its head shows who is inside, halo and +N", () => {
    renderRail({ workspaces: [{ ...FRAMED[0], frames: [{ ...DOCS, moreCount: 3 }] }], activePaneId: "c" });
    fireEvent.click(screen.getByRole("button", { name: /^docs/ }));
    expect(screen.queryByRole("button", { name: /^Codex/ })).toBeNull();
    const head = screen.getByRole("button", { name: /^docs/ });
    const marks = head.querySelectorAll(".ws-rail-frame-logos .ws-rail-item-mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveAttribute("data-activity", "working");
    expect(head.querySelector(".ws-rail-frame-more")?.textContent).toBe("+3");
    fireEvent.click(screen.getByRole("button", { name: /^docs/ }));
    expect(screen.getByRole("button", { name: /^Codex/ })).toBeTruthy();
  });

  describe("a split (an unnamed Frame)", () => {
    it("lists its panes as ordinary rows, no card; each row opens its pane", () => {
      const props = renderRail({ workspaces: SPLIT, activePaneId: "c" });
      const split = screen.getByRole("group", { name: "Split: Claude Code, Codex" });
      expect(split.closest(".ws-rail-card")).toBeNull();
      expect(split.querySelectorAll(".ws-rail-row > .ws-rail-item")).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: /^Codex/ }));
      expect(props.onSelectPane).toHaveBeenCalledWith(B, SPLIT[0]);
    });
  });

  describe("the group menu", () => {
    const openMenu = (props: Parameters<typeof renderRail>[0] = {}) => {
      const rendered = renderRail({ workspaces: FRAMED, activePaneId: "c", onRenameFrame: vi.fn(), onRecolorFrame: vi.fn(), onDeleteFrame: vi.fn(), ...props });
      fireEvent.click(screen.getByRole("button", { name: "Actions for docs" }));
      return rendered;
    };

    it("offers Rename, the colour swatches with the current one marked, and Ungroup", () => {
      openMenu();
      expect(screen.getByRole("menu", { name: "Actions for docs" })).toBeTruthy();
      expect(screen.getByRole("menuitem", { name: /Rename/ })).toBeTruthy();
      expect(screen.getByRole("menuitemradio", { name: "teal" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByRole("menuitemradio", { name: "rose" })).toHaveAttribute("aria-checked", "false");
      expect(screen.getByRole("menuitem", { name: /Ungroup \(keeps panes\)/ })).toBeTruthy();
      // Ungrouping never closes panes, so no such action is on offer.
      expect(screen.queryByRole("menuitem", { name: /close/i })).toBeNull();
    });

    it("recolours and ungroups through the callbacks", () => {
      const props = openMenu();
      fireEvent.click(screen.getByRole("menuitemradio", { name: "rose" }));
      expect(props.onRecolorFrame).toHaveBeenCalledWith("lotus", "docs", "rose");
      fireEvent.click(screen.getByRole("button", { name: "Actions for docs" }));
      fireEvent.click(screen.getByRole("menuitem", { name: /Ungroup/ }));
      expect(props.onDeleteFrame).toHaveBeenCalledWith(DOCS, FRAMED[0]);
    });

    it("opens the name field from Rename", () => {
      openMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
      expect(screen.getByRole("textbox", { name: "Group name docs" })).toBeTruthy();
    });

    it("opens from the keyboard's menu key on the group head", () => {
      renderRail({ workspaces: FRAMED, activePaneId: "c", onDeleteFrame: vi.fn() });
      fireEvent.keyDown(screen.getByRole("button", { name: /^docs/ }), { key: "ContextMenu" });
      expect(screen.getByRole("menu", { name: "Actions for docs" })).toBeTruthy();
    });
  });

  it("says what waits inside a folded group: its unread results", () => {
    const unreadB = { ...B, unread: true };
    const docs = { ...DOCS, marks: [A, unreadB], panes: [A, unreadB] };
    renderRail({ workspaces: [{ ...FRAMED[0], panes: [A, unreadB, C], frames: [docs, EMPTY] }], activePaneId: "c" });
    expect(screen.queryByLabelText("1 finished, not opened")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^docs/ }));
    expect(screen.getByLabelText("1 finished, not opened")).toBeTruthy();
  });

  describe("regrouping from a pane's menu", () => {
    it("offers a loose pane a new group and the workspace's groups, not Take out", () => {
      const onRegroupPane = vi.fn(() => null);
      renderRail({ workspaces: FRAMED, activePaneId: "c", onPaneAction: vi.fn(), onRegroupPane });
      fireEvent.contextMenu(screen.getByRole("button", { name: /^Shell/ }));
      expect(screen.getByRole("menuitem", { name: /New group with pane/ })).toBeTruthy();
      expect(screen.queryByRole("menuitem", { name: /Take out/ })).toBeNull();
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to group" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "docs" }));
      expect(onRegroupPane).toHaveBeenCalledWith({ kind: "move", frameId: "docs" }, C, FRAMED[0]);
    });

    it("offers a member Take out, and the other groups only", () => {
      const onRegroupPane = vi.fn(() => null);
      renderRail({ workspaces: FRAMED, activePaneId: "c", onPaneAction: vi.fn(), onRegroupPane });
      fireEvent.contextMenu(screen.getByRole("button", { name: /^Codex/ }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Move to group" }));
      const groups = screen.getByRole("menu", { name: "Move to group" });
      expect([...groups.querySelectorAll("[role=menuitem]")].map((item) => item.textContent)).toEqual(["empty"]);
      fireEvent.click(screen.getByRole("menuitem", { name: /Take out of group/ }));
      expect(onRegroupPane).toHaveBeenCalledWith({ kind: "out" }, B, FRAMED[0]);
    });

    it("walks into the group submenu and back with the arrow keys", () => {
      renderRail({ workspaces: FRAMED, activePaneId: "c", onPaneAction: vi.fn(), onRegroupPane: vi.fn(() => null) });
      fireEvent.contextMenu(screen.getByRole("button", { name: /^Shell/ }));
      const trigger = screen.getByRole("menuitem", { name: "Move to group" });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowRight" });
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "docs" }));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
      expect(screen.queryByRole("menu", { name: "Move to group" })).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });

    it("opens the new group's name for typing", () => {
      renderRail({ workspaces: FRAMED, activePaneId: "c", onPaneAction: vi.fn(), onRegroupPane: vi.fn(() => "empty"), onRenameFrame: vi.fn() });
      fireEvent.contextMenu(screen.getByRole("button", { name: /^Shell/ }));
      fireEvent.click(screen.getByRole("menuitem", { name: /New group with pane/ }));
      expect(screen.getByRole("textbox", { name: "Group name empty" })).toBeTruthy();
    });
  });

  it("names a group head by its name, status and pane count", () => {
    renderRail({ workspaces: FRAMED, activePaneId: "c" });
    expect(screen.getByRole("button", { name: "docs, Working, 2 panes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "empty, 0 panes" })).toBeTruthy();
  });

  it("keeps group heads and loose rows in the tab order as buttons, so Enter opens them", () => {
    renderRail({ workspaces: FRAMED, activePaneId: "c" });
    for (const name of [/^docs/, /^Shell/]) {
      const row = screen.getByRole("button", { name });
      expect(row.tagName).toBe("BUTTON");
      expect(row).not.toHaveAttribute("tabindex", "-1");
    }
  });

  it("opens the pane menu from the keyboard on a loose row (⇧F10)", () => {
    renderRail({ workspaces: FRAMED, activePaneId: "c", onPaneAction: vi.fn() });
    fireEvent.keyDown(screen.getByRole("button", { name: /^Shell/ }), { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Actions for Shell" })).toBeTruthy();
  });

  it("searches groups: a group matches by its name or a member's, a loose row by its own", () => {
    renderRail({ workspaces: FRAMED, activePaneId: "c" });
    const search = screen.getByRole("searchbox", { name: "Search panes" });
    fireEvent.change(search, { target: { value: "codex" } });
    expect(screen.getByRole("button", { name: /^docs/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^empty/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Shell/ })).toBeNull();
    fireEvent.change(search, { target: { value: "empt" } });
    expect(screen.getByRole("button", { name: /^empty/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^docs/ })).toBeNull();
  });

  it("marks the group on screen as current", () => {
    renderRail({ workspaces: FRAMED, activePaneId: "a", activeFrameId: "docs" });
    expect(screen.getByRole("button", { name: /^docs/ })).toHaveAttribute("aria-current", "true");
  });

  describe("drag a pane", () => {
    const card = (name: RegExp) => screen.getByRole("button", { name }).closest(".ws-rail-card") as HTMLElement;
    /** Press on `from`, move over `to` (what the hit test finds), release. */
    const drag = (from: HTMLElement, to: Element | null) => {
      const hit = vi.spyOn(document, "elementFromPoint").mockReturnValue(to);
      fireEvent.pointerDown(from, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
      const lit = to?.closest("[data-pane-drop]")?.getAttribute("data-drop") ?? null;
      fireEvent.pointerUp(window, { clientX: 40, clientY: 40 });
      hit.mockRestore();
      return lit;
    };

    it("moves a loose pane into the group it is dropped on", () => {
      const onRegroupPane = vi.fn(() => null);
      renderRail({ workspaces: FRAMED, activePaneId: "c", onRegroupPane });
      expect(drag(screen.getByRole("button", { name: /^Shell/ }), card(/^empty/))).toBe("true");
      expect(onRegroupPane).toHaveBeenCalledWith({ kind: "move", frameId: "empty" }, C, FRAMED[0]);
      expect(card(/^empty/)).not.toHaveAttribute("data-drop");
    });

    it("takes a member out on the loose rows, and ignores its own card", () => {
      const onRegroupPane = vi.fn(() => null);
      renderRail({ workspaces: FRAMED, activePaneId: "c", onRegroupPane });
      drag(screen.getByRole("button", { name: /^Codex/ }), screen.getByRole("button", { name: /^Codex/ }));
      expect(onRegroupPane).not.toHaveBeenCalled();
      drag(screen.getByRole("button", { name: /^Codex/ }), screen.getByRole("button", { name: /^Shell/ }));
      expect(onRegroupPane).toHaveBeenCalledWith({ kind: "out" }, B, FRAMED[0]);
    });

    it("is a click, not a drag, when the pointer barely moves", () => {
      const onRegroupPane = vi.fn(() => null);
      renderRail({ workspaces: FRAMED, activePaneId: "c", onRegroupPane });
      const row = screen.getByRole("button", { name: /^Shell/ });
      fireEvent.pointerDown(row, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(window, { clientX: 2, clientY: 1 });
      fireEvent.pointerUp(window);
      expect(row).not.toHaveAttribute("data-dragging");
      expect(onRegroupPane).not.toHaveBeenCalled();
    });

    it("is off in a workspace without groups", () => {
      const onRegroupPane = vi.fn(() => null);
      renderRail({ onRegroupPane });
      expect(document.querySelector("[data-pane-drop]")).toBeNull();
    });
  });
});
