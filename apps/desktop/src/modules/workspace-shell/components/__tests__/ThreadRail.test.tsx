import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { holdOrder, ThreadRail, type ThreadGroup } from "../ThreadRail";
import { kawungCells } from "../KawungLoader";
import { LotusSettingsProvider } from "@/modules/lotus-settings/lotus-settings-context";
import { settingsSectionStub } from "@/modules/lotus-settings/testing/settings-section-stub";

describe("ThreadRail", () => {
  it("opens Lotus Settings on Chat › CodeChat from its gear", () => {
    render(
      <LotusSettingsProvider sections={[settingsSectionStub("lotus", "editor"), settingsSectionStub("chat", "codechat")]}>
        <ThreadRail groups={[]} activeThreadId={null} onSelectThread={vi.fn()} />
      </LotusSettingsProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("tab", { name: "codechat" })).toHaveAttribute("aria-selected", "true");
  });
});

const row = (id: string, state?: "ready" | "waiting" | "running") => ({ id, title: `Thread ${id}`, folder: id === "x" ? "lotus" : "web", state, time: "3d" });

function renderRail(groups: ThreadGroup[]) {
  return render(
    <LotusSettingsProvider sections={[settingsSectionStub("chat", "codechat")]}>
      <ThreadRail groups={groups} activeThreadId={null} onSelectThread={vi.fn()} />
    </LotusSettingsProvider>,
  );
}

describe("Command Rail", () => {
  it("says Draft where a read row's time was, but never over a state or on the open thread", () => {
    render(
      <LotusSettingsProvider sections={[settingsSectionStub("chat", "codechat")]}>
        <ThreadRail
          activeThreadId="o"
          onSelectThread={vi.fn()}
          groups={[{ id: "earlier", label: "Earlier", threads: [
            { ...row("d"), draft: "fix the drawer · 1 file" },
            { ...row("w", "waiting"), draft: "later" },
            { ...row("o"), draft: "open one" },
          ] }]}
        />
      </LotusSettingsProvider>,
    );
    const drafted = screen.getByRole("button", { name: "Thread d, web, draft" });
    expect(drafted).toHaveTextContent("Draft");
    expect(drafted).not.toHaveTextContent("3d");
    expect(drafted.getAttribute("title")).toBe("Thread d · web · Draft: fix the drawer · 1 file");
    expect(screen.getByRole("button", { name: "Thread w, web, Waiting for you" })).toHaveTextContent("Approve");
    const open = screen.getByRole("button", { name: "Thread o, web" });
    expect(open).toHaveTextContent("3d");
    expect(open.hasAttribute("data-draft")).toBe(false);
  });

  it("draws each group without a count when all its rows show, a waiting row's Approve, and the folder", () => {
    renderRail([
      { id: "ready", label: "Ready", threads: [row("w", "waiting"), row("r", "ready")] },
      { id: "earlier", label: "Earlier", threads: [row("x")] },
    ]);
    expect(screen.getByRole("region", { name: "Ready" })).toHaveTextContent(/^Ready(?!\d)/);
    expect(screen.getByRole("button", { name: "Thread w, web, Waiting for you" })).toHaveTextContent("Approve");
    expect(screen.getByRole("button", { name: "Thread x, lotus" })).toBeTruthy();
  });

  it("hangs delegated chats under their lead, and search keeps the branch that matches", () => {
    const lead = { ...row("lead"), children: [{ ...row("a"), title: "Audit API", children: [row("a1")] }, { ...row("b"), title: "Write docs" }] };
    renderRail([{ id: "earlier", label: "Earlier", threads: [lead] }]);
    expect(screen.getByRole("region", { name: "Earlier" })).toHaveTextContent(/^Earlier(?!\d)/);
    const branch = screen.getByRole("group", { name: "Delegated by Thread lead" });
    expect(branch).toHaveTextContent("Audit API");
    expect(screen.getByRole("group", { name: "Delegated by Audit API" })).toHaveTextContent("Thread a1");

    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads" }), { target: { value: "docs" } });
    expect(screen.getByText("Thread lead")).toBeTruthy();
    expect(screen.getByText("Write docs")).toBeTruthy();
    expect(screen.queryByText("Audit API")).toBeNull();
  });

  it("draws a sub-agent as a read-only branch with no menu", () => {
    const onSelect = vi.fn();
    const native = { id: "toolu_1", title: "Map the rail", folder: "Explore", time: "", native: true, state: "running" as const };
    const actions = { openMenu: vi.fn(), menuOpenFor: null, renaming: null, rowProps: () => ({}), renameField: () => null, layer: null };
    render(
      <LotusSettingsProvider sections={[settingsSectionStub("chat", "codechat")]}>
        <ThreadRail groups={[{ id: "earlier", label: "Earlier", threads: [{ ...row("lead"), children: [native] }] }]} activeThreadId="lead" onSelectThread={onSelect} threadActions={actions} />
      </LotusSettingsProvider>,
    );
    const item = screen.getByRole("button", { name: "Sub-agent, Map the rail, Explore, Running" });
    expect(item).toHaveTextContent(/^Map the rail/);
    expect(screen.getAllByRole("button", { name: "Thread actions" })).toHaveLength(1);
    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledWith("toolu_1");
  });

  it("folds finished sub-agents into one row, keeping running ones and delegated chats", () => {
    const sub = (id: string, running = false) => ({ id, title: `Sub ${id}`, folder: "Explore", time: "", native: true, state: running ? ("running" as const) : undefined });
    const lead = { ...row("lead"), children: [sub("s1"), sub("s2"), sub("s3", true), { ...row("chat"), title: "Delegated chat" }] };
    renderRail([{ id: "running", label: "Running", threads: [lead] }]);
    expect(screen.queryByText("Sub s1")).toBeNull();
    expect(screen.getByText("Sub s3")).toBeTruthy();
    expect(screen.getByText("Delegated chat")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 finished sub-agents" }));
    expect(screen.getByText("Sub s1")).toBeTruthy();
    const hide = screen.getByRole("button", { name: "Hide 2 finished sub-agents" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(hide);
    expect(screen.queryByText("Sub s1")).toBeNull();
    expect(screen.getByRole("button", { name: "Show 2 finished sub-agents" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the open finished sub-agent shown while the rest fold", () => {
    const sub = (id: string) => ({ id, title: `Sub ${id}`, folder: "Explore", time: "", native: true });
    const lead = { ...row("lead"), children: [sub("s1"), sub("s2")] };
    render(
      <LotusSettingsProvider sections={[settingsSectionStub("chat", "codechat")]}>
        <ThreadRail groups={[{ id: "earlier", label: "Earlier", threads: [lead] }]} activeThreadId="s1" onSelectThread={vi.fn()} />
      </LotusSettingsProvider>,
    );
    expect(screen.getByText("Sub s1")).toBeTruthy();
    expect(screen.queryByText("Sub s2")).toBeNull();
    expect(screen.getByRole("button", { name: "Show 1 finished sub-agent" })).toBeTruthy();
  });

  it("shows the stored title in the tooltip when the row shows a tidied one", () => {
    renderRail([{ id: "earlier", label: "Earlier", threads: [{ ...row("t"), title: "Fix it", fullTitle: "fix it https://x.dev/1" }] }]);
    expect(screen.getByRole("button", { name: "Fix it, web" }).getAttribute("title")).toBe("fix it https://x.dev/1 · web");
  });

  it("draws no empty time on a running sub-agent, so its folder has no trailing dot", () => {
    const native = { id: "toolu_2", title: "Build it", folder: "implementation-worker", time: "", state: "running" as const, native: true };
    const { container } = render(
      <LotusSettingsProvider sections={[settingsSectionStub("chat", "codechat")]}>
        <ThreadRail groups={[{ id: "running", label: "Running", threads: [{ ...row("lead"), children: [native] }] }]} activeThreadId="lead" onSelectThread={() => {}} />
      </LotusSettingsProvider>,
    );
    const item = container.querySelector('[data-row-id="toolu_2"]');
    expect(item?.querySelector(".ws-cmd-time")).toBeNull();
  });

  it("runs the elapsed clock past an hour as h:mm:ss", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 6, 12, 0, 0));
    const since = Date.now() - (71 * 60 + 11) * 1000;
    render(
      <LotusSettingsProvider sections={[settingsSectionStub("chat", "codechat")]}>
        <ThreadRail groups={[{ id: "running", label: "Running", threads: [{ ...row("long"), state: "running", runningSince: since }] }]} activeThreadId={null} onSelectThread={() => {}} />
      </LotusSettingsProvider>,
    );
    expect(screen.getByText("1:11:11")).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("caps a long group behind Show N more", () => {
    renderRail([{ id: "earlier", label: "Earlier", limit: 1, threads: [row("a"), row("b"), row("c")] }]);
    expect(screen.queryByText("Thread b")).toBeNull();
    // Only a capped group counts its rows: the count is what the eye cannot see.
    expect(screen.getByRole("region", { name: "Earlier" })).toHaveTextContent(/^Earlier3/);
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more" }));
    expect(screen.getByText("Thread c")).toBeTruthy();
  });

  it("filters by title or folder from the search field", () => {
    renderRail([{ id: "earlier", label: "Earlier", threads: [row("a"), row("x")] }]);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads" }), { target: { value: "lotus" } });
    expect(screen.queryByText("Thread a")).toBeNull();
    expect(screen.getByText("Thread x")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search threads" }), { target: { value: "zzz" } });
    expect(screen.getByText(/No thread matches/)).toBeTruthy();
  });

  it("keeps rows where they were while held, and puts arrivals at the end of their group", () => {
    const held = new Map([["ready", ["a"]], ["running", ["b", "c"]]]);
    const now: ThreadGroup[] = [
      { id: "ready", label: "Ready", threads: [row("b", "ready"), row("a", "ready"), row("n", "ready")] },
      { id: "running", label: "Running", threads: [row("c", "running")] },
    ];
    expect(holdOrder(now, held).map((g) => [g.id, g.threads.map((t) => t.id)])).toEqual([
      ["ready", ["a", "n"]],
      ["running", ["b", "c"]],
    ]);
    expect(holdOrder(now, held)[1].threads[0].state).toBe("ready");
  });

  it("draws kawung: the centre always lit, and the lit petal turning", () => {
    const centre = 5 * 11 + 5;
    const a = kawungCells(11, 0);
    const b = kawungCells(11, Math.PI);
    expect(a[centre] && b[centre]).toBe(true);
    expect(a).not.toEqual(b);
  });
});

describe("Command Rail keyboard", () => {
  it("walks rows with ↓ ↑ from the search field and comes back to it", () => {
    renderRail([{ id: "earlier", label: "Earlier", threads: [row("a"), row("x")] }]);
    const search = screen.getByRole("searchbox", { name: "Search threads" });
    const a = screen.getByRole("button", { name: "Thread a, web" });
    const x = screen.getByRole("button", { name: "Thread x, lotus" });
    search.focus();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(a);
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(document.activeElement).toBe(x);
    fireEvent.keyDown(x, { key: "ArrowDown" });
    expect(document.activeElement).toBe(x);
    fireEvent.keyDown(x, { key: "ArrowUp" });
    fireEvent.keyDown(a, { key: "ArrowUp" });
    expect(document.activeElement).toBe(search);
  });

  it("clears the search on Esc before leaving it", () => {
    renderRail([{ id: "earlier", label: "Earlier", threads: [row("a")] }]);
    const search = screen.getByRole("searchbox", { name: "Search threads" }) as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzz" } });
    fireEvent.keyDown(search, { key: "Escape" });
    expect(search.value).toBe("");
  });
});
