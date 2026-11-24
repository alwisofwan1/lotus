//! A scheduled prompt's result → the Slack message Lotus posts (as the user).
//!
//! Two jobs, in one pass:
//!
//! 1. **Safety.** The agent read other people's text, so its markup is shown, never obeyed: no
//!    `<!channel>`, no `<@user>` ping and no disguised `<url|label>` link it chose by itself.
//!    The one exception is a mention the user wrote in the automation's own instructions
//!    (`trusted`): "start with <@U0OWNERUSR1> -san" there means that ping is the user's, so it
//!    reaches Slack as a real mention. Every other `<`, `>` and `&` is escaped.
//! 2. **Format.** Agents drift into GitHub markdown. Slack's mrkdwn has no headings, no `**`, no
//!    `[label](url)` and no `- ` lists, so those are rewritten to what Slack shows the same way:
//!    `*heading*`, `*bold*`, `label (url)` and `• item`. Code (``` fences and `spans`) is kept
//!    as written, escaped only.

/// The Slack text for `text`, allowing only the mentions found in `trusted` (the user's own
/// instructions). Pure; escape-once: call it where the text enters Slack, never on stored text.
pub fn outgoing(text: &str, trusted: &str) -> String {
    let allowed = trusted_targets(trusted);
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.push(escape(line));
            continue;
        }
        out.push(if in_fence { escape(line) } else { format_line(line, &allowed) });
    }
    let mut joined = out.join("\n");
    if text.ends_with('\n') {
        joined.push('\n');
    }
    joined
}

/// The mention targets the user wrote themself: `@U…`, `@W…`, `!subteam^S…`, `#C…`, `!here`,
/// `!channel`, `!everyone` — each exactly as inside `<…>`, without its `|label`.
pub fn trusted_targets(trusted: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = trusted;
    while let Some(open) = rest.find('<') {
        let after = &rest[open + 1..];
        let Some(close) = after.find(['>', '<']) else { break };
        if after.as_bytes()[close] == b'>' {
            let target = after[..close].split('|').next().unwrap_or_default();
            if is_mention(target) && !found.iter().any(|t| t == target) {
                found.push(target.to_string());
            }
        }
        rest = &after[close..];
    }
    found
}

fn is_mention(target: &str) -> bool {
    let id = |s: &str, first: &[char]| {
        s.len() >= 3 && s.starts_with(first) && s.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    };
    if let Some(user) = target.strip_prefix('@') {
        return id(user, &['U', 'W']);
    }
    if let Some(team) = target.strip_prefix("!subteam^") {
        return id(team, &['S']);
    }
    if let Some(channel) = target.strip_prefix('#') {
        return id(channel, &['C', 'G']);
    }
    matches!(target, "!here" | "!channel" | "!everyone")
}

fn format_line(line: &str, allowed: &[String]) -> String {
    let indent_len = line.len() - line.trim_start().len();
    let (indent, body) = line.split_at(indent_len);
    // `# Heading` → `*Heading*`.
    let hashes = body.chars().take_while(|c| *c == '#').count();
    if (1..=6).contains(&hashes) && body[hashes..].starts_with(' ') {
        let title = body[hashes..].trim().trim_matches('*').trim();
        return format!("{indent}*{}*", inline(title, allowed));
    }
    // `> quote` is Slack's quote too; only its marker may stay unescaped.
    if let Some(quote) = body.strip_prefix("> ") {
        return format!("{indent}> {}", inline(quote, allowed));
    }
    // `- item`, `* item`, `+ item` → `• item`.
    for marker in ["- ", "* ", "+ "] {
        if let Some(item) = body.strip_prefix(marker) {
            return format!("{indent}• {}", inline(item, allowed));
        }
    }
    format!("{indent}{}", inline(body, allowed))
}

/// Inline text: code spans kept (escaped), everything else rewritten and escaped.
fn inline(text: &str, allowed: &[String]) -> String {
    let mut out = String::new();
    let mut parts = text.split('`');
    let mut code = false;
    let mut first = true;
    for part in parts.by_ref() {
        if !first {
            out.push('`');
        }
        first = false;
        out.push_str(&if code { escape(part) } else { prose(part, allowed) });
        code = !code;
    }
    out
}

fn prose(text: &str, allowed: &[String]) -> String {
    let text = links(&text.replace("**", "*").replace("~~", "~"));
    let mut out = String::new();
    let mut rest = text.as_str();
    while let Some(open) = rest.find('<') {
        out.push_str(&escape(&rest[..open]));
        let after = &rest[open + 1..];
        match after.find(['>', '<']) {
            Some(close) if after.as_bytes()[close] == b'>' => {
                out.push_str(&token(&after[..close], allowed));
                rest = &after[close + 1..];
            }
            _ => {
                out.push_str("&lt;");
                rest = after;
            }
        }
    }
    out.push_str(&escape(rest));
    out
}

/// One `<…>`: a trusted mention stays live; a link shows where it goes; anything else is text.
fn token(inner: &str, allowed: &[String]) -> String {
    let (target, label) = inner.split_once('|').map_or((inner, None), |(t, l)| (t, Some(l)));
    if allowed.iter().any(|a| a == target) {
        return format!("<{target}>");
    }
    if target.starts_with("https://") || target.starts_with("http://") {
        return match label.map(str::trim).filter(|l| !l.is_empty() && *l != target) {
            Some(label) => format!("{} ({})", escape(label), escape(target)),
            None => escape(target),
        };
    }
    format!("&lt;{}&gt;", escape(inner))
}

/// `[label](https://…)` → `label (https://…)`: Slack links a bare URL by itself, and a label can
/// never hide where it goes.
fn links(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        let parsed = after.find("](").and_then(|mid| {
            let url_part = &after[mid + 2..];
            let end = url_part.find(')')?;
            let url = &url_part[..end];
            (url.starts_with("https://") || url.starts_with("http://")).then(|| (&after[..mid], url, mid + 2 + end + 1))
        });
        match parsed {
            Some((label, url, used)) => {
                out.push_str(&rest[..open]);
                if label.trim().is_empty() || label == url {
                    out.push_str(url);
                } else {
                    out.push_str(&format!("{label} ({url})"));
                }
                rest = &after[used..];
            }
            None => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn escape(text: &str) -> String {
    super::reply::escape(text)
}
