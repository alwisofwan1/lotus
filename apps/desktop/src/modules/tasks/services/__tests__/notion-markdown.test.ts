import { describe, expect, it } from "vitest";
import { cleanNotionMarkdown } from "@/modules/tasks/services/notion-markdown";
import unknownBlockCases from "../../../../../src-tauri/crates/lotus-automation/tests/fixtures/notion-unknown-blocks.json";

const clean = (text: string) => cleanNotionMarkdown(text).markdown;

describe("Notion's page markdown as plain markdown", () => {
  it("leaves ordinary markdown as it is", () => {
    const text = "## Description\n\nTag every event.\n\n- [ ] one\n- [x] two";
    expect(clean(text)).toBe(text);
  });

  it("turns a callout into a quote, marked as a callout with its icon", () => {
    expect(clean('<callout icon="💡" color="blue_bg">Staging and production\nshare one endpoint.</callout>')).toBe(
      "> [!callout] 💡 blue_bg\n>\n> Staging and production\n>\n> share one endpoint.",
    );
  });

  it("turns a toggle into its summary in bold, then its body", () => {
    expect(clean("<details><summary>Why</summary>\nBecause.\n</details>")).toBe("**Why**\n\nBecause.");
  });

  it("turns a table into a GFM table, the first row as its header", () => {
    expect(clean("<table><tr><td>Env</td><td>Endpoint</td></tr><tr><td>staging</td><td>a|b</td></tr></table>")).toBe(
      "| Env | Endpoint |\n| --- | --- |\n| staging | a\\|b |",
    );
  });

  it("turns child pages, databases and files into links", () => {
    expect(clean('<page url="https://www.notion.so/p">Spec</page>')).toBe("[Spec](https://www.notion.so/p)");
    expect(clean('<file src="https://f.example/x.pdf">Invoice</file>')).toBe("[Invoice](https://f.example/x.pdf)");
    expect(clean('<video src="https://v.example/a.mp4"></video>')).toBe("[video](https://v.example/a.mp4)");
  });

  it("links a block Notion could not express, and counts it", () => {
    const cleaned = cleanNotionMarkdown('Intro\n<unknown url="https://www.notion.so/x#b1" alt="bookmark"/>');
    // Two blocks in Notion, so two paragraphs here.
    expect(cleaned.markdown).toBe("Intro\n\n[bookmark — open in Notion](https://www.notion.so/x#b1)");
    expect(cleaned.unknownBlocks).toBe(1);
  });

  it("drops colour annotations and layout wrappers, keeping their text", () => {
    expect(clean('<columns><column>Left</column><column>Right {color="red"}</column></columns>')).toBe("LeftRight");
    expect(clean("Line one<br>Line two")).toBe("Line one\\\nLine two");
    expect(clean("<table_of_contents/>\n\n## A")).toBe("## A");
  });

  it("keeps the text of any tag it does not know, and never its markup", () => {
    expect(clean('Ask <mention-user url="user://u1">Alwi</mention-user> first')).toBe("Ask Alwi first");
    expect(clean('<script>alert(1)</script><img src=x onerror="alert(2)">')).toBe("alert(1)");
  });

  it("never touches code, fenced or inline", () => {
    const text = "Use `<div class=\"x\">` here.\n\n```html\n<callout>not a callout</callout>\n<br>\n```";
    expect(clean(text)).toBe(text);
  });
});

/*
  The page that showed the problems (TKT-996, pasted from "Copy Notion markdown"), drawn by the
  tracker's own reader — what matters is what a person sees, not the text in between.
*/
import { render } from "@testing-library/react";
import { createElement } from "react";
import { TaskMarkdown } from "@/modules/tasks/components/TaskMarkdown";

const RCB_996 = [
  "## Description",
  "Provide an overview of the task and related details.",
  "## **Acceptance Criteria**",
  "- [ ]",
  "- [ ]",
  "## Supporting files",
  '<pdf src=""></pdf>',
  "<details>",
  '<summary>QA **Checklist — 1 ****` ? - QA`**** **<span color="blue">`dd/mm/year 00:00`</span><span color="blue"> </span></summary>',
  "    - [ ]",
  "    - [ ]",
  "</details>",
  "<details>",
  "<summary>**Defect Report — 1  ****`TO DO “DEV`**</summary>",
  "    - [ ] ..<br>**Note:**<br>**Link:**<br>**Account:<br>- email: <br>- Password: **",
  "</details>",
  "<details>",
  "<summary>QA **Checklist — 2 ****` ? - QA`**** **<span color=\"blue\">`dd/mm/year 00:00`</span><span color=\"blue\"> </span></summary>",
  "    - [ ]",
  "    <empty-block/>",
  "</details>",
].join("\n");

function drawn(markdown: string) {
  return render(createElement(TaskMarkdown, null, cleanNotionMarkdown(markdown).markdown)).container;
}

describe("a real Notion page, drawn", () => {
  it("never shows markdown's own stars, or an empty to-do as text", () => {
    const page = drawn(RCB_996);
    expect(page.textContent).not.toContain("**");
    expect(page.textContent).not.toContain("[ ]");
  });

  it("draws empty to-dos as unchecked boxes, not nested one level too deep", () => {
    const page = drawn(RCB_996);
    const boxes = page.querySelectorAll('input[type="checkbox"]');
    expect(boxes.length).toBe(6);
    // No to-do sits inside another list: Notion's four-space indent is the toggle's, not a nesting.
    expect(page.querySelectorAll("li li").length).toBe(0);
  });

  it("draws a toggle's title as one bold line, keeping Notion's code", () => {
    const page = drawn(RCB_996);
    const titles = [...page.querySelectorAll("p > strong")].map((node) => node.textContent?.replace(/\s+/g, " ").trim());
    expect(titles).toContain("QA Checklist — 1 ? - QA dd/mm/year 00:00");
    expect(titles).toContain("Defect Report — 1 TO DO “DEV");
    expect(page.querySelectorAll("strong code").length).toBeGreaterThan(0);
  });

  it("keeps a line break inside one to-do, instead of turning its lines into bullets", () => {
    const page = drawn(RCB_996);
    const item = [...page.querySelectorAll("li")].find((li) => li.textContent?.includes("Note:"));
    expect(item?.textContent).toContain("- email:");
    expect(item?.textContent).toContain("- Password:");
    expect(item?.querySelectorAll("br").length).toBeGreaterThan(0);
  });

  it("says a file block is empty instead of printing its kind alone", () => {
    expect(drawn(RCB_996).textContent).toContain("(empty pdf block)");
  });
});

/*
  TKT-996 again, as Notion sent it on 2026-09-29 (pasted by Alwi from "Copy Notion markdown"): a heading,
  two paragraphs one newline apart, two empty blocks, a callout. Notion's markdown puts every block on
  its own line with ONE newline between blocks; plain markdown reads one newline as the same paragraph.
*/
const PAGE_2026_09_29 = [
  "## Ini judul testing",
  "Lorem ipsum dolor sit amet diauuw ",
  "Tambahan paragraf 2. doawihdoawdaw",
  "<empty-block/>",
  "<empty-block/>",
  '<callout icon="💡" color="gray_bg">',
  "    Ini Callouts testing 2",
  "</callout>",
  "## Description",
  "Provide an overview of the task and related details.",
  "## **Acceptance Criteria**",
  "- [ ]",
  "- [ ]",
  "## Supporting files",
  '<pdf src=""></pdf>',
].join("\n");

describe("Notion's blocks, each drawn as its own block (2026-09-29)", () => {
  it("two paragraphs one newline apart stay two paragraphs", () => {
    const paragraphs = [...drawn(PAGE_2026_09_29).querySelectorAll("p")].map((p) => p.textContent?.trim());
    expect(paragraphs).toContain("Lorem ipsum dolor sit amet diauuw");
    expect(paragraphs).toContain("Tambahan paragraf 2. doawihdoawdaw");
  });

  it("a paragraph right after a list is not swallowed into its last item", () => {
    const page = drawn("- [ ] one\nA paragraph after the list");
    expect(page.querySelector("li")?.textContent).not.toContain("A paragraph");
  });

  it("a callout is a callout box with Notion's icon and colour, not a quote", () => {
    const callout = drawn(PAGE_2026_09_29).querySelector(".tk-md-callout");
    expect(callout).toBeTruthy();
    expect(callout?.getAttribute("data-color")).toBe("gray_bg");
    expect(callout?.querySelector(".tk-md-callout-icon")?.textContent).toBe("💡");
    expect(callout?.textContent).toContain("Ini Callouts testing 2");
    expect(callout?.textContent).not.toContain("[!callout");
    expect(drawn(PAGE_2026_09_29).querySelector("blockquote")).toBeNull();
  });

  it("an empty to-do reads as Notion's grey placeholder, not a bare box", () => {
    const items = [...drawn(PAGE_2026_09_29).querySelectorAll("li")];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.querySelector(".tk-md-todo-empty")?.textContent).toBe("To-do");
    }
  });

  it("empty blocks keep their space, as Notion shows them", () => {
    expect(drawn(PAGE_2026_09_29).querySelectorAll(".tk-md-gap").length).toBe(2);
  });

  it("a real quote stays a quote", () => {
    const page = drawn("> Someone said this");
    expect(page.querySelector("blockquote")?.textContent).toContain("Someone said this");
    expect(page.querySelector(".tk-md-callout")).toBeNull();
  });
});

/**
 * One table for both sides (task "Ticket Sources 16"): the panel hides Edit body when this count is
 * above zero, and Rust's `has_unknown_blocks` refuses the write on the same cases — so the page never
 * offers an edit that is then refused.
 */
describe("an unknown block counts only outside code, as Rust counts it", () => {
  it.each(unknownBlockCases.map((c) => [c.name, c.markdown, c.unknown] as const))("%s", (_name, markdown, unknown) => {
    expect(cleanNotionMarkdown(markdown).unknownBlocks > 0).toBe(unknown);
  });
});
