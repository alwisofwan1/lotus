import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { resolveFile } from "../../../domain/files";
import { FileLinksContext } from "../../ChatFiles";
import { ChatMarkdown, tableTsv } from "../ChatMarkdown";

describe("ChatMarkdown", () => {
  it("turns a GitHub alert into a titled card", () => {
    const { container } = render(<ChatMarkdown text={"> [!WARNING]\n> Run the migration first."} streaming={false} />);
    const alert = container.querySelector(".chat-md-alert");
    expect(alert?.getAttribute("data-kind")).toBe("warning");
    expect(alert?.textContent?.replace(/\s+/g, " ").trim()).toBe("Warning Run the migration first.");
  });

  it("puts code in a card with its language, folded when long", () => {
    const long = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const { container } = render(<ChatMarkdown text={"```php\n" + long + "\n```"} streaming={false} />);
    expect(container.querySelector(".chat-md-code-lang")?.textContent).toBe("php");
    expect(container.querySelector(".chat-md-code")?.hasAttribute("data-long")).toBe(true);
    expect(container.querySelector(".chat-md-code-more")?.textContent).toBe("Show all 20 lines");
  });

  it("splits only the streaming tail into words, with the caret on its last block", () => {
    const { container } = render(<ChatMarkdown text={"Done part.\n\nNew **bold** words"} streaming />);
    const [settled, tail] = container.querySelectorAll(".chat-md > p");
    expect(settled.querySelector(".chat-w")).toBeNull();
    expect([...tail.querySelectorAll(".chat-w")].map((w) => w.textContent)).toEqual(["New", "bold", "words"]);
    expect(tail.classList.contains("chat-caret")).toBe(true);
  });

  it("keeps the caret out of a code block", () => {
    const { container } = render(<ChatMarkdown text={"```\nx = 1"} streaming />);
    expect(container.querySelector(".chat-caret")).toBeNull();
    expect(container.querySelector("pre .chat-w")).toBeNull();
  });

  it("reveals a burst of text at a steady pace, never a half word", async () => {
    const { container, rerender } = render(<ChatMarkdown text="Hi" streaming />);
    const burst = "Hi " + Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    rerender(<ChatMarkdown text={burst} streaming />);
    const first = container.textContent ?? "";
    expect(first.length).toBeLessThan(burst.length);
    expect(burst.startsWith(first) && (first === "Hi" || burst[first.length] === " ")).toBe(true);
    await waitFor(() => expect(container.textContent).toBe(burst));
  });

  it("gives each `open page.html` in a shell block a button that opens it in Lotus", () => {
    const browse = vi.fn();
    const files = new Set(["mockups/a.html"]);
    render(
      <FileLinksContext.Provider value={{ cwd: "/repo", resolve: (p) => (files.has(p.replace("/repo/", "")) ? p.replace("/repo/", "") : null), open: vi.fn(), browse }}>
        <ChatMarkdown text={"```bash\nopen /repo/mockups/a.html\nopen /elsewhere/b.html\n```"} streaming={false} />
      </FileLinksContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "a.html" }));
    expect(browse).toHaveBeenCalledWith("file:///repo/mockups/a.html");
    expect(screen.queryByRole("button", { name: "b.html" })).toBeNull();
  });

  it("opens a file:// link to the chat's folder: a page in Lotus, a file in the Files pane", () => {
    const browse = vi.fn();
    const open = vi.fn();
    const files = new Set(["mockups/a.html", "plans/x/PLAN.md"]);
    render(
      <FileLinksContext.Provider value={{ cwd: "/repo", resolve: (p) => resolveFile(files, p, "/repo"), open, browse }}>
        <ChatMarkdown text={"[a.html](file:///repo/mockups/a.html) [PLAN.md](file:///repo/plans/x/PLAN.md#L3)"} streaming={false} />
      </FileLinksContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "a.html" }));
    expect(browse).toHaveBeenCalledWith("file:///repo/mockups/a.html");
    fireEvent.click(screen.getByRole("button", { name: "PLAN.md" }));
    expect(open).toHaveBeenCalledWith({ path: "plans/x/PLAN.md", line: 3 });
  });

  it("fades only the table edge that has more columns past it", () => {
    const { container } = render(<ChatMarkdown text={"| a | b |\n|---|---|\n| 1 | 2 |"} streaming={false} />);
    const box = container.querySelector<HTMLElement>(".chat-md-table")!;
    Object.defineProperties(box, { scrollWidth: { value: 900 }, clientWidth: { value: 600 } });
    fireEvent.scroll(box);
    expect([box.hasAttribute("data-more-left"), box.hasAttribute("data-more-right")]).toEqual([false, true]);
    box.scrollLeft = 300;
    fireEvent.scroll(box);
    expect([box.hasAttribute("data-more-left"), box.hasAttribute("data-more-right")]).toEqual([true, false]);
  });

  it("copies a table as tab-separated rows", () => {
    const { container } = render(<ChatMarkdown text={"| File | Baris |\n|---|---:|\n| `chat.css` | 52 |\n| a  b | 1 |"} streaming={false} />);
    expect(tableTsv(container.querySelector("table")!)).toBe("File\tBaris\nchat.css\t52\na b\t1");
    expect(screen.getByRole("button", { name: "Copy table" })).toBeTruthy();
  });
});
