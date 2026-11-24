import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitHubIssuePanel, type GitHubIssueDelegation } from "@/modules/tasks/components/GitHubIssuePanel";
import type { GitHubIssue, GitHubIssueComment, GitHubIssueDetail } from "@/modules/tasks/services/github-issues-source";

const issue: GitHubIssue = {
  number: 42,
  title: "Run Node loses its gate",
  state: "closed",
  state_reason: "not_planned",
  labels: [{ name: "bug", color: "d73a4a" }, { name: "canvas", color: "000000" }],
  assignees: ["alwi", "doni"],
  author: "teammate",
  url: "https://github.com/initech/lotus/issues/42",
  body: "Steps:\n\n- open a **run**\n- wait",
  comments: 1,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  closed_at: "2026-10-01T10:00:00Z",
};
const comment: GitHubIssueComment = {
  id: 9,
  author: "reviewer",
  body: "Seen it **twice**.",
  created_at: "2026-09-03T10:00:00Z",
  url: "https://github.com/initech/lotus/issues/42#issuecomment-9",
};

function renderPanel(readIssue: (sourceId: string, number: number) => Promise<GitHubIssueDetail>, shown = issue) {
  const client = { readIssue: vi.fn(readIssue) };
  render(
    <GitHubIssuePanel
      issue={shown}
      sourceId="github-initech-lotus"
      client={client}
      projectName="initech/lotus"
      position={null}
      onBack={vi.fn()}
    />,
  );
  return client;
}

describe("a GitHub issue's panel (LOT2-100, PLAN G9 + G18)", () => {
  it("shows title, state with why it was closed, labels and assignees", async () => {
    renderPanel(async () => ({ issue, comments: [] }));
    expect(screen.getByRole("heading", { name: "Run Node loses its gate" })).toBeTruthy();
    const props = screen.getByRole("complementary", { name: "Properties" });
    expect(within(props).getByText("Closed · not planned")).toBeTruthy();
    expect(within(props).getByText("bug, canvas")).toBeTruthy();
    expect(within(props).getByText("alwi, doni")).toBeTruthy();
    expect(within(props).getByText("teammate")).toBeTruthy();
    await screen.findByText("No comments yet.");
  });

  it("draws the body as markdown", async () => {
    renderPanel(async () => ({ issue, comments: [] }));
    expect(screen.getByText("run").tagName).toBe("STRONG");
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    await screen.findByText("No comments yet.");
  });

  it("says so when the issue has no description", async () => {
    renderPanel(async () => ({ issue: { ...issue, body: "" }, comments: [] }), { ...issue, body: "  " });
    expect(screen.getByText("This issue has no description.")).toBeTruthy();
    await screen.findByText("No comments yet.");
  });

  it("reads the comments when it opens, for this source and number, and draws them as markdown", async () => {
    const client = renderPanel(async () => ({ issue, comments: [comment] }));
    expect(client.readIssue).toHaveBeenCalledWith("github-initech-lotus", 42);
    expect(screen.getByText("Reading the comments…")).toBeTruthy();
    const section = await screen.findByRole("region", { name: "Comments" });
    expect(within(section).getByText("reviewer")).toBeTruthy();
    expect(within(section).getByText("twice").tagName).toBe("STRONG");
    expect(screen.queryByText("Reading the comments…")).toBeNull();
  });

  it("shows the issue as GitHub answers it, not the older synced copy", async () => {
    renderPanel(async () => ({ issue: { ...issue, title: "Renamed on GitHub", state: "open", state_reason: null }, comments: [] }));
    expect(await screen.findByRole("heading", { name: "Renamed on GitHub" })).toBeTruthy();
    expect(within(screen.getByRole("complementary", { name: "Properties" })).getByText("Open")).toBeTruthy();
  });

  it("keeps the synced issue on screen and says why when GitHub cannot be read", async () => {
    renderPanel(async () => {
      throw "gh is not logged in to account alwi";
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The comments could not be read: gh is not logged in to account alwi");
    expect(screen.getByRole("heading", { name: "Run Node loses its gate" })).toBeTruthy();
  });

  it("says so when the issue is gone from GitHub", async () => {
    renderPanel(async () => ({ issue: null, comments: [] }));
    expect(await screen.findByText(/no longer on GitHub/)).toBeTruthy();
  });

  it("draws the HTML GitHub allows in the body and the comments, and nothing unsafe (LOT2-107)", async () => {
    const html = "<details><summary>Logs</summary>\n\nfailed\n\n</details>\n\n<script>window.__x = 1</script>";
    const { container } = render(
      <GitHubIssuePanel
        issue={{ ...issue, body: html }}
        sourceId="github-initech-lotus"
        client={{ readIssue: vi.fn(async () => ({ issue: { ...issue, body: html }, comments: [{ ...comment, body: "Press <kbd>Enter</kbd>" }] })) }}
        projectName="initech/lotus"
        position={null}
        onBack={vi.fn()}
      />,
    );
    const section = await screen.findByRole("region", { name: "Comments" });
    expect(container.querySelector("details > summary")?.textContent).toBe("Logs");
    expect(within(section).getByText("Enter").tagName).toBe("KBD");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("<details>");
  });

  it("is read only: one way out to GitHub, nothing to edit", async () => {
    renderPanel(async () => ({ issue, comments: [comment] }));
    await screen.findByRole("region", { name: "Comments" });
    expect(screen.getByRole("button", { name: /Open on GitHub/ })).toBeTruthy();
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(screen.queryAllByRole("combobox")).toHaveLength(0);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? b.getAttribute("aria-label") ?? "");
    expect(buttons.filter((name) => /edit|save|delete|close issue|comment/i.test(name))).toEqual([]);
  });
});

describe("delegating a GitHub issue from its panel (LOT2-101, PLAN G7)", () => {
  const claude = { id: "c", name: "Alwi", agent: "claude", args: "--model opus", instructions: "" };
  const codex = { id: "x", name: "Codex", agent: "codex", args: "", instructions: "" };

  function renderWithDelegation(overrides: Partial<GitHubIssueDelegation> = {}) {
    const delegation: GitHubIssueDelegation = {
      presets: [claude, codex],
      ready: true,
      busy: false,
      targets: [{ id: "w1", name: "Lotus" }],
      targetId: "w1",
      onTargetChange: vi.fn(),
      onDelegate: vi.fn(),
      onNewPreset: vi.fn(),
      onEditPreset: vi.fn(),
      ...overrides,
    };
    render(
      <GitHubIssuePanel
        issue={issue}
        sourceId="github-initech-lotus"
        client={{ readIssue: vi.fn(async () => ({ issue: { ...issue, title: "Fresh title" }, comments: [comment] })) }}
        projectName="initech/lotus"
        position={null}
        onBack={vi.fn()}
        delegation={delegation}
      />,
    );
    return delegation;
  }

  it("offers only Claude presets, and says why", async () => {
    renderWithDelegation();
    await screen.findByRole("region", { name: "Comments" });
    expect(screen.getByRole("button", { name: /^Alwi/, hidden: true })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Codex/, hidden: true })).toBeNull();
    expect(screen.getByText(/cannot write to the issue/)).toBeTruthy();
  });

  it("hands on the issue and its comments as GitHub answered them", async () => {
    const delegation = renderWithDelegation();
    await screen.findByRole("region", { name: "Comments" });
    fireEvent.click(screen.getByRole("button", { name: /^Alwi/, hidden: true }));
    await waitFor(() => expect(delegation.onDelegate).toHaveBeenCalled());
    const [preset, read] = (delegation.onDelegate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(preset).toBe(claude);
    expect(read.issue.title).toBe("Fresh title");
    expect(read.comments).toEqual([comment]);
  });
});
