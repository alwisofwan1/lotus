import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@/lib/safe-html";
import { markdownToHtml } from "@/modules/tasks/editor/ticket-markdown";

describe("sanitizeHtml", () => {
  it("drops script elements, event handlers and script URLs", () => {
    const html = sanitizeHtml(
      '<p onclick="x()">a</p><img src="x" onerror="alert(1)"><script>alert(2)</script>' +
        '<a href=" java\tscript:alert(3)">b</a><iframe src="https://e.com"></iframe>' +
        '<a href="data:text/html,<script>alert(4)</script>">c</a>',
    );
    expect(html).not.toMatch(/onerror|onclick|<script|javascript|<iframe|data:text/i);
    expect(html).toContain("<p>a</p>");
    expect(html).toContain('<img src="x">');
  });

  it("keeps ordinary links, inline images and data attributes", () => {
    const html = sanitizeHtml(
      '<a href="https://e.com">x</a><img src="data:image/png;base64,AA=="><span data-wiki="TKT-1">TKT-1</span>',
    );
    expect(html).toContain('href="https://e.com"');
    expect(html).toContain('src="data:image/png;base64,AA=="');
    expect(html).toContain('data-wiki="TKT-1"');
  });

  it("does not load or run anything while parsing", () => {
    (window as unknown as { __ran?: boolean }).__ran = false;
    sanitizeHtml('<img src="x" onerror="window.__ran = true">');
    expect((window as unknown as { __ran?: boolean }).__ran).toBe(false);
  });
});

describe("ticket markdownToHtml", () => {
  it("cleans raw HTML in a note but keeps wiki links and task items", () => {
    const html = markdownToHtml('[[TKT-7|ticket]]\n\n- [ ] todo\n\n<img src=x onerror="alert(1)">');
    expect(html).not.toContain("onerror");
    expect(html).toContain('data-wiki="TKT-7"');
    expect(html).toContain('data-type="taskItem"');
  });
});
