use serde_json::Value;

use super::SlackApi;
use crate::github::Severity;
use crate::model::Draft;
use crate::pr_review::brief::{Verdict, MAX_LEAD_CHARS, MAX_POINTS, MAX_POINT_CHARS};

/// The thread reply posted (as the user) after a review is sent, from the sent draft's
/// `content`:
///
/// ```text
/// <@requester> 🔧 Changes needed on <review|repo#n> · 2 should-fix, 1 question
/// • point one
/// • point two
/// ```
///
/// The verdict and points are the draft's `reply` (the agent's, as the reviewer left it), the
/// counts are the findings' severities — inline and moved off the diff — and the verdict is never
/// kinder than they are. The summary is for GitHub and never reaches the thread. Every text is
/// escaped, so a point can never ping `@channel`, a user or a group. `style`: the owner's shape
/// from the review instructions ([`crate::pr_review::reply_style`]); the default is shown above.
pub fn thread_reply_text(
    subject: &str,
    review_url: &str,
    content: &Value,
    requester: Option<&str>,
    style: &crate::pr_review::reply_style::ReplyStyle,
) -> String {
    reply_text(subject, review_url, content, requester, style, false)
}

/// One PR's part of a thread's group message (ADR-0052 §8): shaped by the owner's
/// `slack-reply-group-item` blocks, never the one-PR greeting; the group says the mention.
pub fn group_item_text(subject: &str, review_url: &str, content: &Value, style: &crate::pr_review::reply_style::ReplyStyle) -> String {
    reply_text(subject, review_url, content, None, style, true)
}

fn reply_text(
    subject: &str,
    review_url: &str,
    content: &Value,
    requester: Option<&str>,
    style: &crate::pr_review::reply_style::ReplyStyle,
    item: bool,
) -> String {
    let (brief, severities) = crate::pr_review::brief::of_draft(content);
    let mention = requester
        .filter(|u| !u.is_empty() && u.chars().all(|c| c.is_ascii_alphanumeric()))
        .map(|u| format!("<@{u}>"))
        .unwrap_or_default();
    let short = subject.split_once('/').map_or(subject, |(_, name)| name);
    let pr = format!("<{review_url}|{}>", escape(short));
    let points: Vec<String> =
        brief.points.iter().map(|p| one_line(p)).filter(|p| !p.is_empty()).take(MAX_POINTS).map(|p| format!("• {}", escape(&p))).collect();
    // Approved by the reviewer, or looks good however it was sent (as a comment, or to Slack
    // only): LGTM. The verdict picks the template, never the Approve button alone (ADR-0042).
    let lgtm = content["approved"].as_bool() == Some(true) || brief.verdict == Verdict::LooksGood;
    let again = crate::pr_review::rereview::progress(content).is_some();
    let lead = brief.lead.as_deref().map(one_lead).filter(|l| !l.is_empty()).map(|l| escape(&l)).unwrap_or_default();
    let values = crate::pr_review::reply_style::Values {
        mention: &mention,
        verdict: headline(brief.verdict, &severities),
        pr: &pr,
        counts: &match crate::pr_review::rereview::progress(content) {
            // An LGTM names its suggestions, and says nothing when there are none.
            None if lgtm && severities.is_empty() => String::new(),
            None => counts(&severities, ""),
            Some((resolved, total)) => {
                let mut parts = vec![format!("{resolved}/{total} resolved")];
                if resolved < total {
                    parts.push(format!("{} still open", total - resolved));
                }
                let new = crate::pr_review::brief::new_severities(content);
                if !new.is_empty() {
                    parts.push(counts(&new, "new "));
                }
                parts.join(" · ")
            }
        },
        points: &points.join("\n"),
        title: &escape(&one_line(content["title"].as_str().unwrap_or_default())),
        author: &escape(content["author"].as_str().unwrap_or_default()),
        lead: &lead,
    };
    if item { style.render_item(lgtm, &values) } else { style.render(lgtm, again, &values) }
}

fn headline(verdict: Verdict, severities: &[Severity]) -> &'static str {
    match verdict {
        Verdict::ChangesNeeded if severities.contains(&Severity::Blocker) => "⛔ Changes needed",
        Verdict::ChangesNeeded => "🔧 Changes needed",
        Verdict::Questions => "💬 Questions",
        Verdict::LooksGood => "✅ Looks good",
    }
}

/// `1 blocker, 2 should-fix, 1 question`, worst first, each after `prefix` (`new `); `no findings`
/// when there are none.
fn counts(severities: &[Severity], prefix: &str) -> String {
    let parts: Vec<String> = Severity::ALL
        .iter()
        .map(|s| (s, severities.iter().filter(|x| *x == s).count()))
        .filter(|(_, n)| *n > 0)
        .map(|(s, n)| match s {
            Severity::Question if n > 1 => format!("{n} {prefix}questions"),
            Severity::Suggestion if n > 1 => format!("{n} {prefix}suggestions"),
            s => format!("{n} {prefix}{}", s.as_str()),
        })
        .collect();
    if parts.is_empty() { "no findings".into() } else { parts.join(", ") }
}

/// The lead on one line, at most [`MAX_LEAD_CHARS`].
fn one_lead(lead: &str) -> String {
    let line = lead.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_LEAD_CHARS { line } else { line.chars().take(MAX_LEAD_CHARS - 1).collect::<String>() + "…" }
}

/// One line of at most [`MAX_POINT_CHARS`], cut at a word.
fn one_line(point: &str) -> String {
    let line = point.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_POINT_CHARS {
        return line;
    }
    let mut out = String::new();
    for word in line.split(' ') {
        if out.chars().count() + word.chars().count() + 2 > MAX_POINT_CHARS {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out + "…"
}

/// Slack's three control characters, so text is shown, never interpreted.
/// Not idempotent: escape each text once, where it enters Slack.
pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Replies in the Slack thread the draft's request came from, and in each of `others`: threads
/// that asked for the same review while it was under way, each reply tagging its own requester.
/// Returns how many threads were replied in; 0 when the draft did not come from Slack. A thread
/// that fails does not stop the others; the error is returned when none got the reply.
pub async fn reply_in_threads(
    slack: &dyn SlackApi,
    draft: &Draft,
    review_url: &str,
    style: &crate::pr_review::reply_style::ReplyStyle,
    others: &[Value],
) -> Result<usize, String> {
    let mut seen = std::collections::BTreeSet::new();
    let (mut replied, mut failed) = (0, None);
    for context in std::iter::once(&draft.content["slack"]).chain(others) {
        let (Some(channel), Some(thread)) = (context["channel"].as_str(), context["thread_ts"].as_str()) else { continue };
        if !seen.insert((channel.to_string(), thread.to_string())) {
            continue;
        }
        let text = thread_reply_text(&draft.subject, review_url, &draft.content, context["requester"].as_str(), style);
        match slack.post_reply(channel, thread, &text).await {
            Ok(_) => replied += 1,
            Err(e) => failed = Some(e),
        }
    }
    match failed {
        Some(e) if replied == 0 => Err(e),
        _ => Ok(replied),
    }
}

/// Replies in the Slack thread the draft's request came from. `Ok(false)`
/// when the draft did not come from Slack. Only ever called after the
/// reviewer pressed Send with "reply in thread" ticked. `style`: the automation's, from its
/// review instructions.
pub async fn reply_in_thread(
    slack: &dyn SlackApi,
    draft: &Draft,
    review_url: &str,
    style: &crate::pr_review::reply_style::ReplyStyle,
) -> Result<bool, String> {
    let context = &draft.content["slack"];
    let (Some(channel), Some(thread)) = (context["channel"].as_str(), context["thread_ts"].as_str()) else {
        return Ok(false);
    };
    let text = thread_reply_text(&draft.subject, review_url, &draft.content, context["requester"].as_str(), style);
    slack.post_reply(channel, thread, &text).await?;
    Ok(true)
}
