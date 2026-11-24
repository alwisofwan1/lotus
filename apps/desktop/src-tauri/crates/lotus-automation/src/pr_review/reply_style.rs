//! The Slack reply's shape, as the automation's owner writes it inside the review instructions:
//!
//! ````text
//! ```slack-reply
//! {mention} {verdict} on {pr} · {counts}
//! {points}
//! ```
//! ```slack-reply-lgtm
//! {mention} LGTM ✅ {pr}
//! ```
//! ```slack-reply-group
//! {mention} Review selesai untuk {count} PR:
//!
//! {reviews}
//! ```
//! ````
//!
//! The group block shapes the one message a thread gets for several PRs (ADR-0052 §8): `{reviews}`
//! is each PR's part, a blank line between. A part is shaped by `slack-reply-group-item` (or
//! `slack-reply-group-item-lgtm` for one that looks good), not by the one-PR blocks, so the
//! greeting is said once, in the group block (2026-10-14):
//!
//! ````text
//! ```slack-reply-group-item
//! {pr} — {verdict}
//! {points}
//! ```
//! ```slack-reply-group-item-lgtm
//! {pr} — LGTM ✅
//! Optional: {counts}
//! ```
//! ````
//!
//! A re-review (the PR was reviewed before, and is asked again) may have its own words: the
//! `slack-reply-rereview`, `slack-reply-rereview-lgtm` and `slack-reply-group-rereview` blocks, each
//! falling back to its first-round twin. `{lead}` is the agent's one opening sentence for this round
//! ("Thanks for adding the uninstall test, that covers it."), so the same thread never reads the
//! same twice (2026-10-14).
//!
//! Lotus fills the placeholders; the owner's own text (Slack markup included) is kept as written,
//! and whatever came from the agent is escaped. The blocks are taken out of the instructions
//! before the agent reads them: the agent writes the review, never the reply's shape.

/// What a one-PR block (`slack-reply`, `slack-reply-lgtm`, and a group's items) may hold.
pub const PLACEHOLDERS: [&str; 8] = ["mention", "verdict", "pr", "counts", "points", "title", "author", "lead"];
/// What the `slack-reply-group` block may hold.
pub const GROUP_PLACEHOLDERS: [&str; 3] = ["mention", "count", "reviews"];
const FINDINGS: &str = "{mention} {verdict} on {pr} · {counts}\n{points}";
const LGTM: &str = "{mention} LGTM ✅ {pr}";
const GROUP: &str = "{mention} Review selesai untuk {count} PR:\n\n{reviews}";
const ITEM: &str = "{pr} — {verdict}\n{points}";
const ITEM_LGTM: &str = "{pr} — LGTM ✅\nOptional: {counts}";
const MAX_TEMPLATE_CHARS: usize = 500;
const FENCE: &str = "```";
const BLOCK: &str = "slack-reply";
const LGTM_BLOCK: &str = "slack-reply-lgtm";
const GROUP_BLOCK: &str = "slack-reply-group";
const ITEM_BLOCK: &str = "slack-reply-group-item";
const ITEM_LGTM_BLOCK: &str = "slack-reply-group-item-lgtm";
const REREVIEW_BLOCK: &str = "slack-reply-rereview";
const REREVIEW_LGTM_BLOCK: &str = "slack-reply-rereview-lgtm";
const GROUP_REREVIEW_BLOCK: &str = "slack-reply-group-rereview";
/// Every block, as the parse error lists them.
const BLOCKS: [&str; 8] =
    [BLOCK, LGTM_BLOCK, GROUP_BLOCK, ITEM_BLOCK, ITEM_LGTM_BLOCK, REREVIEW_BLOCK, REREVIEW_LGTM_BLOCK, GROUP_REREVIEW_BLOCK];

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplyStyle {
    /// For a review with findings or questions.
    pub findings: Option<String>,
    /// For a looks-good review — approved, sent as a comment, or Slack only (ADR-0042). Its
    /// `{counts}` names the suggestions, if any.
    pub lgtm: Option<String>,
    /// For the one message of a thread that asked for several PRs.
    pub group: Option<String>,
    /// One PR's part inside the group message, with findings or questions.
    pub group_item: Option<String>,
    /// One PR's part inside the group message, when it looks good.
    pub group_item_lgtm: Option<String>,
    /// A re-review with findings or questions; else `findings`.
    pub rereview: Option<String>,
    /// A re-review that looks good; else `lgtm`.
    pub rereview_lgtm: Option<String>,
    /// The one message for several PRs that were all reviewed before; else `group`.
    pub group_rereview: Option<String>,
}

/// What Lotus fills in, each already escaped where it came from the agent.
pub struct Values<'a> {
    pub mention: &'a str,
    pub verdict: &'a str,
    pub pr: &'a str,
    pub counts: &'a str,
    /// One `• point` per line.
    pub points: &'a str,
    /// The PR's title and author's login, escaped.
    pub title: &'a str,
    pub author: &'a str,
    /// The agent's opening sentence, escaped; empty: none.
    pub lead: &'a str,
}

impl ReplyStyle {
    /// Splits `instructions` into what the agent reads and the reply's shape. Errors name the
    /// block at fault and start with `instructions:`, like any form field's.
    pub fn parse(instructions: &str) -> Result<(String, ReplyStyle), String> {
        let mut style = ReplyStyle::default();
        let mut rest: Vec<&str> = Vec::new();
        let mut lines = instructions.lines();
        while let Some(line) = lines.next() {
            let Some(info) = line.trim().strip_prefix(FENCE).map(str::trim).filter(|i| i.starts_with(BLOCK)) else {
                rest.push(line);
                continue;
            };
            let slot = match info {
                BLOCK => &mut style.findings,
                LGTM_BLOCK => &mut style.lgtm,
                GROUP_BLOCK => &mut style.group,
                ITEM_BLOCK => &mut style.group_item,
                ITEM_LGTM_BLOCK => &mut style.group_item_lgtm,
                REREVIEW_BLOCK => &mut style.rereview,
                REREVIEW_LGTM_BLOCK => &mut style.rereview_lgtm,
                GROUP_REREVIEW_BLOCK => &mut style.group_rereview,
                other => {
                    let list = BLOCKS.iter().map(|b| format!("```{b}")).collect::<Vec<_>>().join(", ");
                    return Err(format!("instructions: ```{other} is not a reply block; use one of {list}"));
                }
            };
            if slot.is_some() {
                return Err(format!("instructions: write the ```{info} block once"));
            }
            let mut body = Vec::new();
            let mut closed = false;
            for inner in lines.by_ref() {
                if inner.trim() == FENCE {
                    closed = true;
                    break;
                }
                body.push(inner);
            }
            if !closed {
                return Err(format!("instructions: the ```{info} block has no closing ```"));
            }
            *slot = Some(check(info, body.join("\n").trim())?);
        }
        Ok((tidy(&rest), style))
    }

    /// The shape `automation`'s review instructions give, or the default. Instructions are checked
    /// when saved, so one that no longer parses (saved by an older Lotus) falls back quietly.
    pub fn of(automation: &crate::model::Automation) -> ReplyStyle {
        let instructions = automation.action.config["instructions"].as_str().unwrap_or_default();
        Self::parse(instructions).map(|(_, style)| style).unwrap_or_default()
    }

    /// The reply for a review; `lgtm`: it looks good (approved or not); `again`: a re-review.
    pub fn render(&self, lgtm: bool, again: bool, v: &Values) -> String {
        let first = if lgtm { &self.lgtm } else { &self.findings };
        let later = if lgtm { &self.rereview_lgtm } else { &self.rereview };
        let template = again.then_some(later).and_then(|t| t.as_deref()).or(first.as_deref()).unwrap_or(if lgtm { LGTM } else { FINDINGS });
        fill(template, v)
    }

    /// One PR's part of a group message; `lgtm`: it looks good. The mention is the group's.
    pub fn render_item(&self, lgtm: bool, v: &Values) -> String {
        let template =
            if lgtm { self.group_item_lgtm.as_deref().unwrap_or(ITEM_LGTM) } else { self.group_item.as_deref().unwrap_or(ITEM) };
        fill(template, v)
    }

    /// The one message for several PRs: `reviews` are their replies, each rendered without a
    /// mention. Blank lines the owner wrote stay; a line a placeholder emptied goes.
    /// `again`: every PR of it was reviewed before.
    pub fn render_group(&self, mention: &str, reviews: &[String], again: bool) -> String {
        let template = again.then_some(&self.group_rereview).and_then(|t| t.as_deref()).or(self.group.as_deref()).unwrap_or(GROUP);
        let mut out: Vec<String> = Vec::new();
        for line in template.lines() {
            if line.trim().is_empty() {
                if out.last().is_some_and(|l| !l.is_empty()) {
                    out.push(String::new());
                }
                continue;
            }
            let filled = fill_mention(line, mention)
                .replace("{count}", &reviews.len().to_string())
                .replace("{reviews}", "\u{0}");
            let filled = filled.split_whitespace().collect::<Vec<_>>().join(" ");
            if filled.is_empty() {
                continue;
            }
            // `{reviews}` keeps its own lines and blank lines.
            out.push(filled.replace('\u{0}', &reviews.join("\n\n")));
        }
        while out.last().is_some_and(|l| l.is_empty()) {
            out.pop();
        }
        out.join("\n")
    }
}

/// Fills a one-PR template. A line whose placeholders (the mention aside) all came out empty
/// goes, words and all: "Left {counts}, all optional" says nothing when there is nothing to count.
fn fill(template: &str, v: &Values) -> String {
    let values = [
        ("{verdict}", v.verdict),
        ("{pr}", v.pr),
        ("{counts}", v.counts),
        ("{points}", v.points),
        ("{title}", v.title),
        ("{author}", v.author),
        ("{lead}", v.lead),
    ];
    let mut out = Vec::new();
    for line in template.lines() {
        // A line whose placeholders (the mention aside) all came out empty goes, words and all:
        // "Left {counts}, all optional" says nothing when there is nothing to count.
        let used: Vec<&str> = values.iter().filter(|(k, _)| line.contains(k)).map(|(_, v)| *v).collect();
        if !used.is_empty() && used.iter().all(|v| v.trim().is_empty()) {
            continue;
        }
        let filled = values.iter().fold(fill_mention(line, v.mention), |l, (k, val)| l.replace(k, val));
        // An empty placeholder takes its gap with it.
        for l in filled.lines() {
            let l = l.split_whitespace().collect::<Vec<_>>().join(" ");
            if !l.is_empty() {
                out.push(l);
            }
        }
    }
    out.join("\n")
}

/// Fills `{mention}`. An empty mention also takes the word glued to it, so `{mention}-san` leaves
/// no stray "-san" in a group's per-PR replies; punctuation after it stays.
fn fill_mention(template: &str, mention: &str) -> String {
    if !mention.is_empty() {
        return template.replace("{mention}", mention);
    }
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(at) = rest.find("{mention}") {
        out.push_str(&rest[..at]);
        rest = &rest[at + "{mention}".len()..];
        rest = rest.trim_start_matches(|c: char| c.is_alphanumeric() || c == '-');
    }
    out.push_str(rest);
    out
}

fn check(block: &str, template: &str) -> Result<String, String> {
    if template.is_empty() {
        return Err(format!("instructions: the ```{block} block is empty"));
    }
    if template.chars().count() > MAX_TEMPLATE_CHARS {
        return Err(format!("instructions: the ```{block} block is longer than {MAX_TEMPLATE_CHARS} characters"));
    }
    let group = block == GROUP_BLOCK || block == GROUP_REREVIEW_BLOCK;
    let (known, other): (&[&str], &[&str]) = if group { (&GROUP_PLACEHOLDERS, &PLACEHOLDERS) } else { (&PLACEHOLDERS, &GROUP_PLACEHOLDERS) };
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        let after = &rest[start + 1..];
        let Some(end) = after.find('}') else { break };
        let name = &after[..end];
        if !known.contains(&name) {
            let list = known.iter().map(|p| format!("{{{p}}}")).collect::<Vec<_>>().join(", ");
            let elsewhere = if other.contains(&name) {
                if group { " here, only in the one-PR blocks (```slack-reply, ```slack-reply-lgtm, …)" } else { " here, only in ```slack-reply-group" }
            } else {
                ""
            };
            return Err(format!("instructions: ```{block} has {{{name}}}, which Lotus does not fill{elsewhere}; use {list}"));
        }
        rest = &after[end + 1..];
    }
    Ok(template.to_string())
}

/// The instructions without the blocks: no run of blank lines where a block was.
fn tidy(lines: &[&str]) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in lines {
        if line.trim().is_empty() && out.last().is_some_and(|l: &&str| l.trim().is_empty()) {
            continue;
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}
