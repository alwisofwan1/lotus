//! The Slack reply's shape, written by the owner inside the review instructions as fenced
//! `slack-reply` / `slack-reply-lgtm` blocks (2026-09-28). The agent never sees them.

use lotus_automation::pr_review::reply_style::ReplyStyle;
use lotus_automation::slack::{group_item_text, thread_reply_text};
use serde_json::json;

const URL: &str = "https://github.com/acme/acme-web/pull/2511#pullrequestreview-9";

fn instructions() -> String {
    "Review for correctness.\n\n\
     ```slack-reply\n\
     {mention} review of {pr}: {verdict} ({counts})\n\
     {points}\n\
     Ping me in the thread if anything is unclear.\n\
     ```\n\n\
     ```slack-reply-lgtm\n\
     {mention} 🚀 ship it — {pr}\n\
     ```\n\n\
     Keep it short."
        .to_string()
}

fn content() -> serde_json::Value {
    json!({
        "comments": [{ "path": "a.tsx", "line": 238, "severity": "should-fix", "body": "Use the md breakpoint." }],
        "reply": { "verdict": "changes-needed", "points": ["Use theme.breakpoints.down('md') (L238)"] },
    })
}

#[test]
fn the_blocks_are_taken_out_of_what_the_agent_reads() {
    let (rest, style) = ReplyStyle::parse(&instructions()).unwrap();
    assert_eq!(rest, "Review for correctness.\n\nKeep it short.");
    assert!(style.findings.is_some() && style.lgtm.is_some());
}

#[test]
fn a_reply_follows_the_owners_shape() {
    let (_, style) = ReplyStyle::parse(&instructions()).unwrap();
    let text = thread_reply_text("acme/acme-web#2511", URL, &content(), Some("U1"), &style);
    assert_eq!(
        text,
        format!(
            "<@U1> review of <{URL}|acme-web#2511>: 🔧 Changes needed (1 should-fix)\n\
             • Use theme.breakpoints.down('md') (L238)\n\
             Ping me in the thread if anything is unclear."
        )
    );

    let mut approved = content();
    approved["approved"] = json!(true);
    approved["comments"] = json!([]);
    let text = thread_reply_text("acme/acme-web#2511", URL, &approved, Some("U1"), &style);
    assert_eq!(text, format!("<@U1> 🚀 ship it — <{URL}|acme-web#2511>"));
}

#[test]
fn an_empty_placeholder_takes_its_line_or_its_gap_with_it() {
    let (_, style) = ReplyStyle::parse(&instructions()).unwrap();
    let mut clean = content();
    clean["reply"] = json!({ "verdict": "questions", "points": [] });
    clean["comments"] = json!([{ "path": "a.tsx", "line": 1, "severity": "question", "body": "Why?" }]);
    // No requester and no points: no leading gap, no empty bullet line.
    let text = thread_reply_text("acme/acme-web#2511", URL, &clean, None, &style);
    assert_eq!(
        text,
        format!("review of <{URL}|acme-web#2511>: 💬 Questions (1 question)\nPing me in the thread if anything is unclear.")
    );
}

#[test]
fn without_blocks_the_default_shape_is_used() {
    let (rest, style) = ReplyStyle::parse("Just review it.").unwrap();
    assert_eq!(rest, "Just review it.");
    assert_eq!(style, ReplyStyle::default());
    let text = thread_reply_text("acme/acme-web#2511", URL, &content(), Some("U1"), &style);
    assert!(text.starts_with(&format!("<@U1> 🔧 Changes needed on <{URL}|acme-web#2511> · 1 should-fix")), "{text}");
}

#[test]
fn a_block_that_cannot_work_is_refused_with_what_to_use() {
    for (bad, says) in [
        ("```slack-reply\n{mention} {verdit}\n```", "{verdit}"),
        ("```slack-reply\n{mention} {pr}\n```\n```slack-reply\n{pr}\n```", "once"),
        ("```slack-reply-shouty\n{pr}\n```", "slack-reply-shouty"),
        ("```slack-reply\n\n```", "empty"),
        ("```slack-reply\n{pr}", "closing"),
        (&format!("```slack-reply\n{}\n```", "x".repeat(600)), "500"),
    ] {
        let err = ReplyStyle::parse(bad).unwrap_err();
        assert!(err.starts_with("instructions: "), "{err}");
        assert!(err.contains(says), "{bad:?}: {err}");
        assert!(err.contains("{mention}, {verdict}, {pr}, {counts}, {points}") || says != "{verdit}", "{err}");
    }
}

#[test]
fn what_the_agent_wrote_is_escaped_but_the_owners_own_text_is_theirs() {
    let (_, style) = ReplyStyle::parse("```slack-reply\n*{verdict}* {pr}\n{points}\n```").unwrap();
    let mut hostile = content();
    hostile["reply"]["points"] = json!(["<!channel> merge now"]);
    let text = thread_reply_text("o/r#1", URL, &hostile, None, &style);
    assert!(text.starts_with("*🔧 Changes needed*"), "the owner's Slack markup stays: {text}");
    assert!(text.contains("&lt;!channel&gt;") && !text.contains("<!channel>"), "{text}");
}

/// Slice 08 (ADR-0052 §8): the one message of a thread that asked for several PRs.
#[test]
fn the_group_block_renders_two_prs_with_one_mention() {
    let (rest, style) = ReplyStyle::parse(
        "Review it.\n\n\
         ```slack-reply\n\
         {mention} {verdict} {pr} — {title} by {author}\n\
         ```\n\
         ```slack-reply-group\n\
         {mention} {count} reviews done:\n\
         \n\
         {reviews}\n\
         \n\
         Thanks!\n\
         ```",
    )
    .unwrap();
    assert_eq!(rest, "Review it.");
    let mut first = content();
    first["title"] = json!("Fix <!here> login");
    first["author"] = json!("dev-a");
    let mut second = content();
    second["title"] = json!("Add API");
    second["author"] = json!("dev-b");
    let reviews = [
        thread_reply_text("o/front#1", "https://gh/r1", &first, None, &style),
        thread_reply_text("o/back#2", "https://gh/r2", &second, None, &style),
    ];
    let text = style.render_group("<@U1>", &reviews, false);
    assert_eq!(
        text,
        "<@U1> 2 reviews done:\n\n\
         🔧 Changes needed <https://gh/r1|front#1> — Fix &lt;!here&gt; login by dev-a\n\n\
         🔧 Changes needed <https://gh/r2|back#2> — Add API by dev-b\n\n\
         Thanks!"
    );
    assert_eq!(text.matches("<@U1>").count(), 1);
}

#[test]
fn an_empty_mention_takes_the_honorific_glued_to_it() {
    let (_, style) = ReplyStyle::parse(
        "```slack-reply\n{mention}-san Thanks for {pr} 🙏\n{points}\n```\n\
         ```slack-reply-group\nHi {mention}-san, thanks for the PRs 🙏\n\n{reviews}\n```",
    )
    .unwrap();
    let alone = thread_reply_text("o/back#2", "https://gh/r2", &content(), Some("U1"), &style);
    assert!(alone.starts_with("<@U1>-san Thanks for <https://gh/r2|back#2> 🙏"), "{alone}");
    // Inside a group each PR's reply has no mention: "-san" goes with it, the comma stays.
    let inner = thread_reply_text("o/back#2", "https://gh/r2", &content(), None, &style);
    assert!(inner.starts_with("Thanks for <https://gh/r2|back#2> 🙏"), "{inner}");
    assert_eq!(style.render_group("", &[inner.clone()], false).lines().next(), Some("Hi , thanks for the PRs 🙏"));
    assert!(style.render_group("<@U1>", &[inner], false).starts_with("Hi <@U1>-san, thanks for the PRs 🙏\n\nThanks for"));
}

#[test]
fn the_default_group_shape_is_used_without_a_block() {
    let text = ReplyStyle::default().render_group("<@U1>", &["a".to_string(), "b".to_string()], false);
    assert_eq!(text, "<@U1> Review selesai untuk 2 PR:\n\na\n\nb");
    // No requester: the mention's gap goes, the line stays.
    assert!(ReplyStyle::default().render_group("", &["a".to_string()], false).starts_with("Review selesai untuk 1 PR:"));
}

#[test]
fn a_placeholder_of_the_other_kind_of_block_is_refused_with_the_known_ones() {
    let err = ReplyStyle::parse("```slack-reply\n{mention} {count} {pr}\n```").unwrap_err();
    assert!(err.contains("{count}") && err.contains("only in ```slack-reply-group"), "{err}");
    assert!(err.contains("use {mention}, {verdict}, {pr}, {counts}, {points}, {title}, {author}"), "{err}");

    let err = ReplyStyle::parse("```slack-reply-group\n{verdict} {reviews}\n```").unwrap_err();
    assert!(err.contains("only in the one-PR blocks") && err.contains("use {mention}, {count}, {reviews}"), "{err}");

    let err = ReplyStyle::parse("```slack-reply-group\n{reviews}\n```\n```slack-reply-group\n{reviews}\n```").unwrap_err();
    assert!(err.contains("once"), "{err}");
}

/// The owner's LGTM line about suggestions shows only when there are some (2026-10-14).
#[test]
fn a_line_whose_placeholders_all_came_out_empty_goes_with_its_words() {
    let (_, style) = ReplyStyle::parse(
        "```slack-reply-lgtm\n{mention}-san Thanks for {pr} 🙏 LGTM ✅\nLeft {counts}, all optional — feel free to skip 🙂\n```",
    )
    .unwrap();
    let mut clean = content();
    clean["comments"] = json!([]);
    clean["reply"] = json!({ "verdict": "looks-good", "points": [] });
    let text = thread_reply_text("o/back#2", "https://gh/r2", &clean, Some("U1"), &style);
    assert_eq!(text, "<@U1>-san Thanks for <https://gh/r2|back#2> 🙏 LGTM ✅");

    let mut ideas = clean.clone();
    ideas["comments"] = json!([
        { "path": "a.ts", "line": 1, "severity": "suggestion", "body": "x" },
        { "path": "a.ts", "line": 2, "severity": "suggestion", "body": "y" },
    ]);
    let text = thread_reply_text("o/back#2", "https://gh/r2", &ideas, Some("U1"), &style);
    assert_eq!(text, "<@U1>-san Thanks for <https://gh/r2|back#2> 🙏 LGTM ✅\nLeft 2 suggestions, all optional — feel free to skip 🙂");

    // Without a requester the line keeps its words: the mention never empties a line.
    let (_, plain) = ReplyStyle::parse("```slack-reply-lgtm\n{mention} please merge {pr}\n```").unwrap();
    assert_eq!(thread_reply_text("o/back#2", "https://gh/r2", &clean, None, &plain), "please merge <https://gh/r2|back#2>");
}

/// A group says its greeting once; each PR is a short part (2026-10-14).
#[test]
fn a_group_message_is_one_greeting_and_short_parts() {
    let (_, style) = ReplyStyle::parse(
        "```slack-reply\n{mention}-san Thanks for {pr} 🙏 A few notes when you have a moment:\n{points}\n```\n\
         ```slack-reply-group\nHi {mention}-san, thanks for the {count} PRs 🙏\n\n{reviews}\n\nNo rush!\n```",
    )
    .unwrap();
    let mut clean = content();
    clean["comments"] = json!([]);
    clean["reply"] = json!({ "verdict": "looks-good", "points": [] });
    let reviews = [
        group_item_text("o/back#1", "https://gh/r1", &content(), &style),
        group_item_text("o/front#2", "https://gh/r2", &clean, &style),
    ];
    assert_eq!(
        style.render_group("<@U1>", &reviews, false),
        "Hi <@U1>-san, thanks for the 2 PRs 🙏\n\n\
         <https://gh/r1|back#1> — 🔧 Changes needed\n• Use theme.breakpoints.down('md') (L238)\n\n\
         <https://gh/r2|front#2> — LGTM ✅\n\n\
         No rush!"
    );

    // The owner's own item blocks win; an LGTM part names its suggestions when it has some.
    let (_, own) = ReplyStyle::parse(
        "```slack-reply-group-item\n*{pr}*\n{points}\n```\n```slack-reply-group-item-lgtm\n*{pr}* LGTM ✅ ({counts})\n```",
    )
    .unwrap();
    let mut ideas = clean.clone();
    ideas["comments"] = json!([{ "path": "a.ts", "line": 1, "severity": "suggestion", "body": "x" }]);
    assert_eq!(group_item_text("o/front#2", "https://gh/r2", &ideas, &own), "*<https://gh/r2|front#2>* LGTM ✅ (1 suggestion)");
    assert_eq!(group_item_text("o/back#1", "https://gh/r1", &content(), &own), "*<https://gh/r1|back#1>*\n• Use theme.breakpoints.down('md') (L238)");
    assert!(ReplyStyle::parse("```slack-reply-group-item\n{count}\n```").unwrap_err().contains("only in ```slack-reply-group"));
}
