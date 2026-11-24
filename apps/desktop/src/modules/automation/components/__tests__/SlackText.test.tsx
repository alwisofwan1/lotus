import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({ openExternalLink: vi.fn() }));

import { SlackText } from "../SlackText";

describe("SlackText", () => {
  it("shows a live mention as a chip and an escaped one as the words Slack will show", () => {
    const { container } = render(<SlackText>{"<@U0OWNERUSR1> -san &lt;@U0BOSS&gt; &amp; co"}</SlackText>);
    expect(screen.getByTitle("Pings Slack user U0OWNERUSR1")).toHaveTextContent("@U0OWNERUSR1");
    expect(container).toHaveTextContent("<@U0BOSS> & co");
    expect(container.querySelectorAll(".au-slack-mention")).toHaveLength(1);
  });

  it("renders Slack mrkdwn, not markdown: *one star* is bold", () => {
    const { container } = render(<SlackText>{"*Daily Report* _soon_ ~old~ `a *b*` :pray:"}</SlackText>);
    expect(container.querySelector("strong")).toHaveTextContent("Daily Report");
    expect(container.querySelector("em")).toHaveTextContent("soon");
    expect(container.querySelector("del")).toHaveTextContent("old");
    expect(container.querySelector("code")).toHaveTextContent("a *b*");
    expect(container).toHaveTextContent("🙏");
  });

  it("keeps identifiers with underscores and times as plain text", () => {
    const { container } = render(<SlackText>{"snake_case_name at 17:05 and foo_bar_"}</SlackText>);
    expect(container.querySelector("em")).toBeNull();
    expect(container).toHaveTextContent("snake_case_name at 17:05 and foo_bar_");
  });

  it("links bare URLs and shows code blocks as written", () => {
    const { container } = render(<SlackText>{"see https://github.com/o/r/pull/1.\n```\n*not bold*\n```"}</SlackText>);
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://github.com/o/r/pull/1");
    expect(container.querySelector("pre")).toHaveTextContent("*not bold*");
  });

  it("shows bullet lines as list items, nested by indent, as Slack's rich_text list will", () => {
    const { container } = render(<SlackText>{"*a. Review (~4h)*\n• Sam-san, *3 rounds*:\n  • no test\n  • deploy first\nAll fixed."}</SlackText>);
    const items = container.querySelectorAll(".au-slack-item");
    expect([...items].map((i) => [i.getAttribute("data-level"), i.textContent])).toEqual([
      ["0", "Sam-san, 3 rounds:"],
      ["1", "no test"],
      ["1", "deploy first"],
    ]);
    expect(items[0].querySelector("strong")).toHaveTextContent("3 rounds");
    expect(container.querySelector(".au-slack-line:last-child")).toHaveTextContent("All fixed.");
  });
});
