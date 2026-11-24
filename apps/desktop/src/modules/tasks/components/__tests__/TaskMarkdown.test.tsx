import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskMarkdown } from "@/modules/tasks/components/TaskMarkdown";

describe("TaskMarkdown", () => {
  it("marks GFM task lists with the classes the stylesheet hangs the checkbox layout on", () => {
    const { container } = render(<TaskMarkdown>{"- [ ] open\n- [x] done"}</TaskMarkdown>);
    expect(container.querySelector("ul.contains-task-list")).not.toBeNull();
    expect(container.querySelectorAll("li.task-list-item")).toHaveLength(2);
  });

  it("opens a [[reference]] the tracker holds, in place", () => {
    const open = vi.fn();
    render(
      <TaskMarkdown onOpenReference={open} canOpenReference={(ref) => ref === "TKT-836"}>
        {"QA revision of [[TKT-836]]."}
      </TaskMarkdown>,
    );
    fireEvent.click(screen.getByRole("button", { name: "TKT-836" }));
    expect(open).toHaveBeenCalledWith("TKT-836");
  });

  it("draws a reference it cannot open as a plain chip, not a dead button", () => {
    render(
      <TaskMarkdown onOpenReference={vi.fn()} canOpenReference={() => false}>
        {"see [[TKT-1]]"}
      </TaskMarkdown>,
    );
    expect(screen.queryByRole("button", { name: "TKT-1" })).toBeNull();
    expect(screen.getByText("TKT-1").className).toContain("tk-md-ref");
  });

  it("hides HTML comments, as GitHub and Obsidian do, and keeps the rest of the raw HTML visible as text", () => {
    // A real cli/cli bot comment ends in two of these (cli/cli#14558, 2026-10-05).
    const { container } = render(
      <TaskMarkdown>
        {"Thanks.\n\n<!-- gh-aw-agentic-workflow: Issue Triage -->\n<!-- gh-aw-workflow-call-id: cli/cli/issue-triage -->\n\nInline <!-- gone --> here.\n\n<b>bold</b>\n\n`<!-- in code -->`"}
      </TaskMarkdown>,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("gh-aw");
    expect(text).not.toContain("gone");
    expect(text).toContain("Inline");
    expect(text).toContain("here.");
    // Not a comment: still escaped, never markup.
    expect(text).toContain("<b>bold</b>");
    // In code it is what the code says.
    expect(text).toContain("<!-- in code -->");
  });
});

describe("TaskMarkdown with GitHub's HTML (LOT2-107)", () => {
  const GH = [
    "<details>",
    "<summary>Logs</summary>",
    "",
    "Line **one**",
    "",
    "</details>",
    "",
    'Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup><br>next line',
    "",
    '<img src="https://github.com/user-attachments/assets/abc" alt="screenshot" width="400">',
    "",
    "<!-- gh-aw-workflow-call-id: 123 -->",
  ].join("\n");

  it("draws the safe tags as GitHub does", () => {
    const { container } = render(<TaskMarkdown html="github">{GH}</TaskMarkdown>);
    expect(container.querySelector("details > summary")?.textContent).toBe("Logs");
    expect(container.querySelector("details strong")?.textContent).toBe("one");
    expect(container.querySelectorAll("kbd")).toHaveLength(2);
    expect(container.querySelector("sub")?.textContent).toBe("2");
    expect(container.querySelector("sup")?.textContent).toBe("2");
    expect(container.querySelector("br")).not.toBeNull();
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://github.com/user-attachments/assets/abc");
    expect(img?.getAttribute("alt")).toBe("screenshot");
    expect(container.textContent).not.toContain("<details>");
    expect(container.textContent).not.toContain("gh-aw-workflow-call-id");
  });

  it("never draws anything that could run or restyle the page", () => {
    const evil = [
      '<script>window.__pwned = 1</script>',
      '<style>body { display: none }</style>',
      '<iframe src="https://evil.example"></iframe>',
      '<img src="x" onerror="window.__pwned = 1">',
      '<a href="javascript:alert(1)">click</a>',
      '<p style="position:fixed;inset:0" onclick="x()">cover</p>',
      '<form action="https://evil.example"><input name="t"></form>',
    ].join("\n\n");
    const { container } = render(<TaskMarkdown html="github">{evil}</TaskMarkdown>);
    expect(container.querySelector("script, style, iframe, form")).toBeNull();
    // GitHub keeps <input> only as a disabled checkbox (task lists): it can hold nothing typed.
    for (const input of container.querySelectorAll("input")) {
      expect(input.getAttribute("type")).toBe("checkbox");
      expect(input.hasAttribute("disabled")).toBe(true);
    }
    expect(container.querySelector("[onerror], [onclick], [style]")).toBeNull();
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
    expect(container.innerHTML).not.toContain("__pwned");
  });

  it("a link written as HTML still opens outside the app", () => {
    render(<TaskMarkdown html="github">{'<a href="https://github.com/cli/cli">repo</a>'}</TaskMarkdown>);
    const link = screen.getByRole("link", { name: "repo" });
    expect(link.getAttribute("href")).toBe("https://github.com/cli/cli");
    expect(fireEvent.click(link)).toBe(false); // default prevented: the webview never navigates away
  });

  it("without it, HTML stays text as before (Notion, Obsidian and task briefs)", () => {
    const { container } = render(<TaskMarkdown>{"<details><summary>x</summary></details>"}</TaskMarkdown>);
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("<details>");
  });
});
