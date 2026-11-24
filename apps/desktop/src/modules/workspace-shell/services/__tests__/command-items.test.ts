import { describe, expect, it, vi } from "vitest";
import {
  BROWSE_GROUP_LIMIT,
  buildCommandItems,
  isBrowseQuery,
  rankCommandItems,
  scoreCommandMatch,
  type CommandItem,
} from "../command-items";
import type { ShellAgent } from "../agent-catalog";
import type { RailWorkspace } from "@/modules/workspace-shell/types";

const agent = (id: string, command: string, installed = true): ShellAgent => ({
  id,
  name: id === "claude" ? "Claude Code" : id,
  command,
  installed,
  path: installed ? `/bin/${id}` : null,
});

const WORKSPACES: RailWorkspace[] = [
  {
    id: "lotus",
    name: "lotus",
    panes: [{ id: "p1", kind: "terminal", title: "Claude Code", meta: "apps/desktop" }],
  },
  { id: "pocket", name: "pocket", panes: [] },
];

function sources(overrides: Partial<Parameters<typeof buildCommandItems>[0]> = {}) {
  return {
    agents: [agent("claude", "claude --dangerously-skip-permissions"), agent("codex", "codex --yolo")],
    workspaces: WORKSPACES,
    activeWorkspaceName: "lotus",
    onLaunchAgent: vi.fn(),
    onCreatePane: vi.fn(),
    onOpenWorkspace: vi.fn(),
    onOpenPane: vi.fn(),
    onOpenFrame: vi.fn(),
    paneCount: 3,
    onTidyPanes: vi.fn(),
    ...overrides,
  };
}

describe("buildCommandItems", () => {
  it("shows the command on a launch row, not a sentence repeated per agent", () => {
    const items = buildCommandItems(sources());
    const claude = items.find((item) => item.id === "launch-claude")!;
    expect(claude.detail).toBe("claude --dangerously-skip-permissions");
    expect(claude.tag).toBe("AGENT");
  });

  it("lists a CLI the machine does not have, and says so instead of hiding it", () => {
    const items = buildCommandItems(sources({ agents: [agent("grok", "grok", false)] }));
    const grok = items.find((item) => item.id === "launch-grok")!;
    expect(grok.disabled).toBe(true);
    expect(grok.detail).toContain("not found");
  });

  it("offers every pane kind the menu offers — one source for both", () => {
    const items = buildCommandItems(sources()).filter((item) => item.group === "create");
    expect(items.map((item) => item.title)).toEqual(["Terminal", "Thread", "Browser", "Editor"]);
  });

  it("does not offer to go to the folder already on screen", () => {
    const items = buildCommandItems(sources());
    expect(items.some((item) => item.id === "goto-workspace-lotus")).toBe(false);
    expect(items.some((item) => item.id === "goto-workspace-pocket")).toBe(true);
  });

  it("can reach a pane inside any workspace, saying which folder it is in", () => {
    const items = buildCommandItems(sources());
    const pane = items.find((item) => item.id === "goto-pane-p1")!;
    expect(pane.detail).toContain("lotus");
    pane.run();
  });
});

describe("Frames", () => {
  const p1 = WORKSPACES[0].panes[0];
  const framed: RailWorkspace[] = [
    {
      id: "lotus",
      name: "lotus",
      panes: [p1, { id: "p2", kind: "terminal", title: "Shell", meta: "" }],
      frames: [{ id: "f1", name: "Rail Frames", color: "violet", initial: "R", paneCount: 1, paneIds: ["p1"], status: "idle", marks: [p1], moreCount: 0, split: false, panes: [p1] }],
      loosePanes: [{ id: "p2", kind: "terminal", title: "Shell", meta: "" }],
    },
  ];

  it("lists each Frame as its own group, and picking one opens it", () => {
    const onOpenFrame = vi.fn();
    const items = buildCommandItems(sources({ workspaces: framed, onOpenFrame }));
    const row = items.find((item) => item.id === "frame-f1")!;
    expect(row).toMatchObject({ title: "Rail Frames", group: "frame", detail: "lotus · 1 pane" });
    row.run();
    expect(onOpenFrame).toHaveBeenCalledWith("lotus", "f1");
    expect(rankCommandItems(items, "").sections.map((s) => s.label)).toContain("Groups");
  });

  it("finds a Frame by its own name or by its workspace's name", () => {
    const items = buildCommandItems(sources({ workspaces: framed, activeWorkspaceName: null }));
    expect(rankCommandItems(items, "rail fr").items.map((i) => i.id)).toContain("frame-f1");
    expect(rankCommandItems(items, "lotus").items.map((i) => i.id)).toContain("frame-f1");
  });

  it("says workspace / Frame on a framed pane, just the workspace on a loose one", () => {
    const items = buildCommandItems(sources({ workspaces: framed }));
    expect(items.find((i) => i.id === "goto-pane-p1")!.detail).toBe("lotus / Rail Frames · apps/desktop");
    expect(items.find((i) => i.id === "goto-pane-p2")!.detail).toBe("lotus · terminal");
  });

  it("lists no row for a split (it has no name), and its panes say workspace / Split", () => {
    const split = { ...framed[0].frames![0], id: "s1", name: "", split: true };
    const items = buildCommandItems(sources({ workspaces: [{ ...framed[0], frames: [split] }] }));
    expect(items.some((i) => i.id === "frame-s1")).toBe(false);
    expect(items.find((i) => i.id === "goto-pane-p1")!.detail).toBe("lotus / Split · apps/desktop");
  });
});

describe("arranging", () => {
  it("offers to tidy once there is more than one pane, and says how many", () => {
    const items = buildCommandItems(sources({ paneCount: 4 }));
    const tidy = items.find((item) => item.id === "layout-tidy")!;
    expect(tidy.detail).toContain("4 pane");
    expect(tidy.group).toBe("layout");
  });

  it("does not offer it for a single pane, where it would do nothing", () => {
    const items = buildCommandItems(sources({ paneCount: 1 }));
    expect(items.some((item) => item.id === "layout-tidy")).toBe(false);
  });

  it("answers to the words someone would actually type for it", () => {
    const items = buildCommandItems(sources());
    const tidy = items.find((item) => item.id === "layout-tidy")!;
    for (const word of ["tidy", "arrange", "grid", "layout"]) {
      expect(scoreCommandMatch(tidy, word), word).not.toBeNull();
    }
  });
});

describe("ranking", () => {
  const items = buildCommandItems(sources());

  it("browses in sections, capped so no group pushes another off screen", () => {
    const ranked = rankCommandItems(items, "");
    expect(isBrowseQuery("")).toBe(true);
    expect(ranked.sections.map((section) => section.label)).toEqual([
      "Launch agent",
      "New pane",
      "Layout",
      "Go to",
    ]);
    for (const group of ["launch", "create", "layout", "goto"] as const) {
      expect(ranked.items.filter((item) => item.group === group).length).toBeLessThanOrEqual(BROWSE_GROUP_LIMIT);
    }
  });

  it("drops the headings once the rows are ranked, because they would no longer be true", () => {
    const ranked = rankCommandItems(items, "code");
    expect(ranked.sections).toEqual([]);
    expect(ranked.items.length).toBeGreaterThan(0);
  });

  it("matches word by word, so 'cl code' still finds Claude Code", () => {
    const claude = items.find((item) => item.id === "launch-claude")!;
    expect(scoreCommandMatch(claude, "cl code")).not.toBeNull();
    expect(scoreCommandMatch(claude, "cl zzz")).toBeNull();
  });

  it("ranks a title hit above a hit that is only in the detail", () => {
    const claude = items.find((item) => item.id === "launch-claude")!;
    const terminal = items.find((item) => item.id === "create-terminal")!;
    expect(scoreCommandMatch(claude, "claude")!).toBeGreaterThan(scoreCommandMatch(terminal, "shell")!);
  });

  it("lets an uninstalled CLI match but never win", () => {
    const [installed, missing] = [
      buildCommandItems(sources({ agents: [agent("codex", "codex")] }))[0],
      buildCommandItems(sources({ agents: [agent("codex", "codex", false)] }))[0],
    ] as CommandItem[];
    expect(scoreCommandMatch(missing, "codex")!).toBeLessThan(scoreCommandMatch(installed, "codex")!);
  });
});
