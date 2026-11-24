//! The thread reply after Send (2026-09-28): the verdict, the counts and at
//! most two points, built by Lotus from the draft — never cut out of the
//! review's summary, which is for GitHub.

use lotus_automation::pr_review::reply_style::ReplyStyle;
use lotus_automation::slack::thread_reply_text;
use serde_json::{json, Value};

const URL: &str = "https://github.com/acme/acme-docs/pull/362#pullrequestreview-1";
const SUBJECT: &str = "acme/acme-docs#362";

fn comment(severity: &str, line: u64, body: &str) -> Value {
    json!({ "path": "architecture/knowledge-base-rag.md", "line": line, "severity": severity, "body": body })
}

/// acme-docs#362 as it was drafted, with the agent's reply.
fn reviewed() -> Value {
    json!({
        "summary": "Spec: 1 finding. Standards: 2 findings.\n\n## Spec\nAll four corrections…\n\nSlack reply:\nThanks @AliInitech…",
        "comments": [
            comment("should-fix", 314, "\"0.30 cuts correct answers, and no single value would not\" is a double negative."),
            comment("question", 481, "Where does the 270–740 ms warm end-to-end figure come from?"),
        ],
        "off_diff_severities": ["should-fix"],
        "reply": {
            "verdict": "changes-needed",
            "points": [
                "The new floor heading is a double negative and reads backwards (L314)",
                "The #2801 row still says \"design posted\" — #2842 has shipped (L647)",
            ],
        },
    })
}

#[test]
fn the_reply_is_the_verdict_the_counts_and_two_points_with_the_requester_first() {
    let text = thread_reply_text(SUBJECT, URL, &reviewed(), Some("U0PEERUSER3"), &ReplyStyle::default());
    assert_eq!(
        text,
        "<@U0PEERUSER3> 🔧 Changes needed on <https://github.com/acme/acme-docs/pull/362#pullrequestreview-1|acme-docs#362> · 2 should-fix, 1 question\n\
         • The new floor heading is a double negative and reads backwards (L314)\n\
         • The #2801 row still says \"design posted\" — #2842 has shipped (L647)"
    );
}

#[test]
fn the_summary_meant_for_github_never_reaches_the_thread() {
    let text = thread_reply_text(SUBJECT, URL, &reviewed(), None, &ReplyStyle::default());
    assert!(!text.contains("Spec") && !text.contains("Slack reply") && !text.contains("@AliInitech"), "{text}");
    assert!(text.starts_with("🔧 Changes needed"), "no requester, no mention: {text}");
}

#[test]
fn the_verdict_is_never_kinder_than_the_findings() {
    let mut content = reviewed();
    content["reply"]["verdict"] = json!("looks-good");
    content["comments"] = json!([comment("blocker", 10, "Crashes on null.")]);
    content["off_diff_severities"] = json!([]);
    assert!(thread_reply_text(SUBJECT, URL, &content, None, &ReplyStyle::default()).starts_with("⛔ Changes needed on"));

    content["comments"] = json!([comment("question", 10, "Why 0.30?")]);
    let text = thread_reply_text(SUBJECT, URL, &content, None, &ReplyStyle::default());
    assert!(text.starts_with("💬 Questions on") && text.contains("· 1 question"), "{text}");

    // Stricter than the inline findings is the agent's call: a finding may sit on no line at all.
    content["reply"]["verdict"] = json!("changes-needed");
    assert!(thread_reply_text(SUBJECT, URL, &content, None, &ReplyStyle::default()).starts_with("🔧 Changes needed"));
}

#[test]
fn a_clean_review_is_one_line() {
    let content = json!({ "summary": "Fine.", "comments": [], "reply": { "verdict": "looks-good", "points": [] } });
    let text = thread_reply_text(SUBJECT, URL, &content, Some("U1"), &ReplyStyle::default());
    assert_eq!(text, format!("<@U1> LGTM ✅ <{URL}|acme-docs#362>"));
}

/// The verdict picks the shape, not the Approve button: a looks-good review sent as a comment,
/// or to Slack only, says LGTM too, and its `{counts}` names the suggestions.
#[test]
fn a_review_with_only_suggestions_takes_the_lgtm_shape_and_counts_them() {
    let (_, style) = ReplyStyle::parse("```slack-reply-lgtm\n{mention} LGTM ✅ {pr} ({counts})\n```").unwrap();
    let content = json!({
        "comments": [comment("suggestion", 10, "Could be a const."), comment("suggestion", 12, "Name it clearer.")],
        "reply": { "verdict": "looks-good", "points": [] },
    });
    let text = thread_reply_text(SUBJECT, URL, &content, Some("U1"), &style);
    assert_eq!(text, format!("<@U1> LGTM ✅ <{URL}|acme-docs#362> (2 suggestions)"));

    // A should-fix next to them lifts the verdict, and the findings shape is used.
    let mut worse = content.clone();
    worse["comments"].as_array_mut().unwrap().push(comment("should-fix", 14, "Fix it."));
    let text = thread_reply_text(SUBJECT, URL, &worse, Some("U1"), &style);
    assert!(text.starts_with("<@U1> 🔧 Changes needed") && text.contains("1 should-fix, 2 suggestions"), "{text}");
}

#[test]
fn a_draft_without_a_reply_takes_its_points_from_the_worst_comments() {
    // Drafts from before `reply`, or an agent that left it out.
    let content = json!({
        "summary": "Long summary.\nSecond line.",
        "comments": [
            comment("question", 481, "Where does the figure come from? Which issue?"),
            comment("should-fix", 314, "A double negative. It reads backwards."),
            comment("blocker", 12, "The mapping crashes on null. See the trace."),
        ],
    });
    let text = thread_reply_text(SUBJECT, URL, &content, None, &ReplyStyle::default());
    assert_eq!(
        text,
        format!(
            "⛔ Changes needed on <{URL}|acme-docs#362> · 1 blocker, 1 should-fix, 1 question\n\
             • The mapping crashes on null. (L12)\n\
             • A double negative. (L314)"
        )
    );
}

#[test]
fn points_stay_short_single_line_at_most_two_and_cannot_ping_anyone() {
    let long = "word ".repeat(60);
    let content = json!({
        "comments": [],
        "reply": { "verdict": "changes-needed", "points": [long, "two\nlines <!channel> <@U999>", "a third point"] },
    });
    let text = thread_reply_text(SUBJECT, URL, &content, None, &ReplyStyle::default());
    let points: Vec<&str> = text.lines().skip(1).collect();
    assert_eq!(points.len(), 2, "{text}");
    assert!(points[0].chars().count() <= 2 + 120 && points[0].ends_with("word…"), "{:?}", points[0]);
    assert_eq!(points[1], "• two lines &lt;!channel&gt; &lt;@U999&gt;");
}

#[test]
fn a_requester_id_that_is_not_a_slack_id_is_not_mentioned() {
    let text = thread_reply_text(SUBJECT, URL, &reviewed(), Some("<!channel>"), &ReplyStyle::default());
    assert!(text.starts_with("🔧"), "{text}");
}

#[test]
fn an_approved_review_says_lgtm_and_nothing_else() {
    let content = json!({
        "summary": "Fine.",
        "comments": [],
        "approved": true,
        "reply": { "verdict": "looks-good", "points": ["this point is not shown"] },
    });
    assert_eq!(thread_reply_text(SUBJECT, URL, &content, Some("U1"), &ReplyStyle::default()), format!("<@U1> LGTM ✅ <{URL}|acme-docs#362>"));
    assert_eq!(thread_reply_text(SUBJECT, URL, &content, None, &ReplyStyle::default()), format!("LGTM ✅ <{URL}|acme-docs#362>"));
}
