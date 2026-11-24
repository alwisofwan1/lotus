import { describe, expect, it } from "vitest";

import { parseReplyStyle, renderGroup, renderReply, type ReplyValues } from "../reply-style";

// Cases mirror crate lotus-automation › pr_review/reply_style.rs.
const values: ReplyValues = { mention: "@a", verdict: "🔧 Changes needed", pr: "api#1", counts: "1 should-fix", points: "• one\n• two", title: "Add login", author: "dev", lead: "" };

const style = (text: string) => {
  const parsed = parseReplyStyle(text);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed.style;
};

describe("parseReplyStyle", () => {
  it("reads both blocks and leaves the default when there are none", () => {
    expect(style("Focus on SQL.")).toEqual({ findings: null, lgtm: null, group: null, groupItem: null, groupItemLgtm: null, rereview: null, rereviewLgtm: null, groupRereview: null });
    const s = style(
      "Focus.\n```slack-reply\n{pr}: {verdict}\n```\n```slack-reply-lgtm\nLGTM {pr}\n```\n```slack-reply-group\n{count}:\n{reviews}\n```\n" +
        "```slack-reply-group-item\n{pr}\n{points}\n```\n```slack-reply-group-item-lgtm\n{pr} ✅\n```",
    );
    expect(s).toEqual({
      findings: "{pr}: {verdict}", lgtm: "LGTM {pr}", group: "{count}:\n{reviews}", groupItem: "{pr}\n{points}", groupItemLgtm: "{pr} ✅",
      rereview: null, rereviewLgtm: null, groupRereview: null,
    });
  });

  it("gives the save errors Rust gives", () => {
    const err = (text: string) => ("error" in parseReplyStyle(text) ? (parseReplyStyle(text) as { error: string }).error : null);
    expect(err("```slack-replyx\nx\n```")).toBe("instructions: ```slack-replyx is not a reply block; use one of ```slack-reply, ```slack-reply-lgtm, ```slack-reply-group, ```slack-reply-group-item, ```slack-reply-group-item-lgtm, ```slack-reply-rereview, ```slack-reply-rereview-lgtm, ```slack-reply-group-rereview");
    expect(err("```slack-reply\na\n```\n```slack-reply\nb\n```")).toBe("instructions: write the ```slack-reply block once");
    expect(err("```slack-reply\n{pr}")).toBe("instructions: the ```slack-reply block has no closing ```");
    expect(err("```slack-reply\n\n```")).toBe("instructions: the ```slack-reply block is empty");
    expect(err("```slack-reply\n{who}\n```")).toBe(
      "instructions: ```slack-reply has {who}, which Lotus does not fill; use {mention}, {verdict}, {pr}, {counts}, {points}, {title}, {author}, {lead}",
    );
    expect(err("```slack-reply\n{count} {pr}\n```")).toBe(
      "instructions: ```slack-reply has {count}, which Lotus does not fill here, only in ```slack-reply-group; use {mention}, {verdict}, {pr}, {counts}, {points}, {title}, {author}, {lead}",
    );
    expect(err("```slack-reply-group\n{verdict} {reviews}\n```")).toBe(
      "instructions: ```slack-reply-group has {verdict}, which Lotus does not fill here, only in the one-PR blocks (```slack-reply, ```slack-reply-lgtm, …); use {mention}, {count}, {reviews}",
    );
    expect(err(`\`\`\`slack-reply\n${"x".repeat(501)}\n\`\`\``)).toBe("instructions: the ```slack-reply block is longer than 500 characters");
  });
});

describe("renderReply", () => {
  it("fills the default shapes", () => {
    const none = { findings: null, lgtm: null, group: null };
    expect(renderReply(none, false, values)).toBe("@a 🔧 Changes needed on api#1 · 1 should-fix\n• one\n• two");
    expect(renderReply(none, true, values)).toBe("@a LGTM ✅ api#1");
  });

  it("drops the gap or line an empty value leaves", () => {
    expect(renderReply({ findings: null, lgtm: null, group: null }, false, { ...values, mention: "", points: "" })).toBe(
      "🔧 Changes needed on api#1 · 1 should-fix",
    );
  });

  it("drops a line, words and all, when its placeholders all came out empty, as Rust does", () => {
    const own = style("```slack-reply-lgtm\n{mention}-san LGTM ✅ {pr}\nLeft {counts}, all optional\n```");
    expect(renderReply(own, true, { ...values, counts: "" })).toBe("@a-san LGTM ✅ api#1");
    expect(renderReply(own, true, { ...values, counts: "2 suggestions" })).toBe("@a-san LGTM ✅ api#1\nLeft 2 suggestions, all optional");
  });
});

describe("renderGroup", () => {
  it("puts one mention on top and a blank line between reviews, as Rust does", () => {
    const none = { findings: null, lgtm: null, group: null };
    expect(renderGroup(none, "<@U1>", ["a", "b"])).toBe("<@U1> Review selesai untuk 2 PR:\n\na\n\nb");
    const own = style("```slack-reply-group\n{mention} {count} done:\n\n{reviews}\n\nThanks!\n```");
    expect(renderGroup(own, "", ["a\n• x", "b"])).toBe("2 done:\n\na\n• x\n\nb\n\nThanks!");
  });

  it("fills {title} and {author} in a one-PR block", () => {
    expect(renderReply(style("```slack-reply\n{pr} — {title} by {author}\n```"), false, values)).toBe("api#1 — Add login by dev");
  });
});

describe("re-review", () => {
  it("uses the re-review blocks on a later round and falls back to the first-round ones", () => {
    const s = style(
      "```slack-reply\nfirst {pr}\n```\n```slack-reply-rereview\n{lead}\n{points}\n```\n```slack-reply-group-rereview\nagain {count}\n{reviews}\n```",
    );
    expect(renderReply(s, false, { ...values, lead: "Thanks for the fix." }, true)).toBe("Thanks for the fix.\n• one\n• two");
    expect(renderReply(s, false, values, false)).toBe("first api#1");
    expect(renderReply(s, true, values, true)).toBe("@a LGTM ✅ api#1");
    expect(renderGroup(s, "@a", ["x"], true)).toBe("again 1\nx");
  });

  it("drops a {lead} line when the agent wrote none, the mention with it, as Rust does", () => {
    const s = style("```slack-reply\n{mention} {lead}\n{points}\n```");
    expect(renderReply(s, false, values)).toBe("• one\n• two");
    expect(renderReply(s, false, { ...values, lead: "Two things:" })).toBe("@a Two things:\n• one\n• two");
  });

  it("lets the group re-review block hold only the group placeholders", () => {
    expect(parseReplyStyle("```slack-reply-group-rereview\n{lead}\n```")).toEqual({
      error: "instructions: ```slack-reply-group-rereview has {lead}, which Lotus does not fill here, only in the one-PR blocks (```slack-reply, ```slack-reply-lgtm, …); use {mention}, {count}, {reviews}",
    });
  });
});
