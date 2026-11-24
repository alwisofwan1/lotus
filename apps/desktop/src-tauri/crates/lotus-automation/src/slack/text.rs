use crate::pr_review::{parse_pr_url, PrRef};

/// What a Slack message's `text` refers to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MessageText {
    /// GitHub pull requests, each once, in the order they appear.
    pub pull_requests: Vec<PrRef>,
    /// Mentioned user ids (`<@U…>`).
    pub users: Vec<String>,
    /// Mentioned user-group ids (`<!subteam^S…>`).
    pub teams: Vec<String>,
}

/// Reads Slack's message markup: `<@U…|label>`, `<!subteam^S…|label>`,
/// `<https://…|label>`, plus bare URLs and `&amp;`-style escapes in plain text.
/// Every token may carry an optional `|label` (see research/slack-socket-mode.md §3).
pub fn read_message_text(text: &str) -> MessageText {
    let mut out = MessageText::default();
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        read_plain(&rest[..open], &mut out);
        let after = &rest[open + 1..];
        let Some(close) = after.find('>') else {
            read_plain(after, &mut out);
            return out;
        };
        read_token(&after[..close], &mut out);
        rest = &after[close + 1..];
    }
    read_plain(rest, &mut out);
    out
}

fn read_token(token: &str, out: &mut MessageText) {
    let target = token.split('|').next().unwrap_or_default();
    if let Some(user) = target.strip_prefix('@') {
        push_unique(&mut out.users, user.to_string());
    } else if let Some(team) = target.strip_prefix("!subteam^") {
        push_unique(&mut out.teams, team.to_string());
    } else if target.starts_with("https://") {
        add_pr(&unescape(target), out);
    }
}

fn read_plain(text: &str, out: &mut MessageText) {
    for word in unescape(text).split_whitespace() {
        if word.starts_with("https://github.com/") {
            add_pr(word.trim_end_matches(['.', ',', ')', ';', ':', '!']), out);
        }
    }
}

fn add_pr(url: &str, out: &mut MessageText) {
    if let Some(pr) = parse_pr_url(url) {
        if !out.pull_requests.contains(&pr) {
            out.pull_requests.push(pr);
        }
    }
}

fn push_unique(list: &mut Vec<String>, value: String) {
    if !value.is_empty() && !list.contains(&value) {
        list.push(value);
    }
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}
