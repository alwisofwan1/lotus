//! Slack wire text (mrkdwn, as [`super::outgoing`] and the reply builders write it) → one Block
//! Kit `rich_text` block: the shape Slack's own composer sends.
//!
//! Why: a `• ` typed into mrkdwn is only a character, so a long bullet wraps back to the left
//! margin and a report reads as one wall of text. A `rich_text_list` is a real list — hanging
//! indent, nested levels — and the message looks like one the user typed.
//!
//! Input is the *wire* text, already made safe: every `<…>` still in it is markup Lotus chose (a
//! trusted mention, a review link), and everything the agent wrote is `&lt;`-escaped. So this
//! only changes the shape, never what pings or where a link goes.
//!
//! A rich_text `text` element is literal: Slack neither parses `<!here>` in it nor decodes
//! `&lt;` (seen live 2026-10-14: `R&amp;D` arrived as those six characters). So the wire escapes
//! are decoded here, and only a `user`/`broadcast` element can ping — made from the `<…>` tokens
//! [`super::outgoing`] let through, never from text. The same wire text is still
//! posted as `text`, the fallback for notifications and for a Slack that refuses the blocks.

use serde_json::{json, Map, Value};

/// The deepest list level sent; deeper lines are flattened to it.
const MAX_INDENT: usize = 4;

/// The `blocks` JSON for `wire`: one `rich_text` block, or `None` when there is nothing to show.
pub fn rich_text_blocks(wire: &str) -> Option<Value> {
    let elements = Builder::default().build(wire);
    (!elements.is_empty()).then(|| json!([{ "type": "rich_text", "elements": elements }]))
}

#[derive(Default)]
struct Builder {
    out: Vec<Value>,
    /// Lines of the open paragraph, already turned into inline elements, `\n`-joined.
    para: Vec<Value>,
    /// The open list: its indent and items.
    list: Option<(usize, Vec<Value>)>,
    /// The open quote's elements.
    quote: Vec<Value>,
    /// Blank lines seen since the last content line.
    blanks: usize,
    /// What the last flushed element was, for where a blank line goes.
    last: Last,
}

#[derive(Default, PartialEq, Clone, Copy)]
enum Last {
    #[default]
    Nothing,
    Para,
    Other,
}

impl Builder {
    fn build(mut self, wire: &str) -> Vec<Value> {
        let lines: Vec<&str> = wire.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            let trimmed = line.trim_start();
            if let Some(first) = trimmed.strip_prefix("```") {
                // A fence: everything up to the closing ``` is code, taken literally.
                let mut code: Vec<&str> = Vec::new();
                if !first.trim().is_empty() {
                    code.push(first.trim_end_matches("```"));
                }
                let closed_inline = first.trim_end().ends_with("```") && !first.trim().is_empty();
                i += 1;
                if !closed_inline {
                    while i < lines.len() && !lines[i].trim_start().starts_with("```") {
                        code.push(lines[i]);
                        i += 1;
                    }
                    i += 1;
                }
                self.block(json!({
                    "type": "rich_text_preformatted",
                    "elements": [{ "type": "text", "text": decode(&code.join("\n")) }],
                }));
                continue;
            }
            i += 1;
            if trimmed.is_empty() {
                self.blanks += 1;
                continue;
            }
            if let Some(quote) = line.strip_prefix("&gt; ").or_else(|| line.strip_prefix("> ")) {
                self.close_para();
                self.close_list();
                if !self.quote.is_empty() && self.blanks == 0 {
                    push_text(&mut self.quote, "\n", None);
                } else {
                    self.close_quote();
                    self.gap_before_block();
                }
                extend(&mut self.quote, inline(quote));
                continue;
            }
            self.close_quote();
            if let Some((indent, item)) = list_item(line) {
                self.close_para();
                match &mut self.list {
                    Some((open, items)) if *open == indent && self.blanks == 0 => {
                        items.push(json!({ "type": "rich_text_section", "elements": inline(item) }));
                    }
                    _ => {
                        self.close_list();
                        self.gap_before_block();
                        self.list = Some((indent, vec![json!({ "type": "rich_text_section", "elements": inline(item) })]));
                    }
                }
                continue;
            }
            self.close_list();
            if self.para.is_empty() {
                self.open_para();
            } else {
                push_text(&mut self.para, &"\n".repeat(1 + self.blanks), None);
                self.blanks = 0;
            }
            extend(&mut self.para, inline(trimmed));
        }
        self.close_quote();
        self.close_list();
        self.close_para();
        self.out
    }

    /// A paragraph after a list, quote or code starts with its blank lines, as the composer
    /// writes it.
    fn open_para(&mut self) {
        if self.last == Last::Other && self.blanks > 0 {
            push_text(&mut self.para, &"\n".repeat(self.blanks), None);
        }
        self.blanks = 0;
    }

    /// A list, quote or code after a paragraph: the blank lines end that paragraph.
    fn gap_before_block(&mut self) {
        if self.last == Last::Para && self.blanks > 0 {
            if let Some(section) = self.out.last_mut() {
                if let Some(elements) = section["elements"].as_array_mut() {
                    push_text(elements, &"\n".repeat(self.blanks), None);
                }
            }
        }
        self.blanks = 0;
    }

    fn block(&mut self, element: Value) {
        self.close_quote();
        self.close_list();
        self.close_para();
        self.gap_before_block();
        self.out.push(element);
        self.last = Last::Other;
    }

    fn close_para(&mut self) {
        if !self.para.is_empty() {
            let elements = std::mem::take(&mut self.para);
            self.out.push(json!({ "type": "rich_text_section", "elements": elements }));
            self.last = Last::Para;
        }
    }

    fn close_list(&mut self) {
        if let Some((indent, items)) = self.list.take() {
            let mut list = json!({ "type": "rich_text_list", "style": "bullet", "elements": items });
            if indent > 0 {
                list["indent"] = json!(indent);
            }
            self.out.push(list);
            self.last = Last::Other;
        }
    }

    fn close_quote(&mut self) {
        if !self.quote.is_empty() {
            let elements = std::mem::take(&mut self.quote);
            self.out.push(json!({ "type": "rich_text_quote", "elements": elements }));
            self.last = Last::Other;
        }
    }
}

/// `• item`, `- item` or `◦ item`, with its level from the leading spaces (two per level, a tab
/// is one level).
fn list_item(line: &str) -> Option<(usize, &str)> {
    let body = line.trim_start();
    let lead = &line[..line.len() - body.len()];
    let item = ["• ", "- ", "◦ ", "▪ "].iter().find_map(|m| body.strip_prefix(m))?;
    if item.trim().is_empty() {
        return None;
    }
    let width: usize = lead.chars().map(|c| if c == '\t' { 2 } else { 1 }).sum();
    Some((width.div_ceil(2).min(MAX_INDENT), item))
}

/// One line's inline elements: code spans, `<…>` tokens, `*bold*` / `_italic_` / `~strike~`,
/// bare URLs and `:emoji:`.
fn inline(line: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut parts = line.split('`').peekable();
    let mut code = false;
    let mut first = true;
    while let Some(part) = parts.next() {
        if !first {
            code = !code;
        }
        first = false;
        // An unclosed backtick is a literal one.
        if code && parts.peek().is_none() {
            push_text(&mut out, "`", None);
            styled(part, &Style::default(), &mut out);
            continue;
        }
        if code {
            if !part.is_empty() {
                push_text(&mut out, &decode(part), Some(&json!({ "code": true })));
            } else {
                push_text(&mut out, "``", None);
            }
        } else {
            styled(part, &Style::default(), &mut out);
        }
    }
    out
}

#[derive(Default, Clone, Copy, PartialEq)]
struct Style {
    bold: bool,
    italic: bool,
    strike: bool,
}

impl Style {
    fn json(&self) -> Option<Value> {
        let mut map = Map::new();
        for (on, key) in [(self.bold, "bold"), (self.italic, "italic"), (self.strike, "strike")] {
            if on {
                map.insert(key.into(), Value::Bool(true));
            }
        }
        (!map.is_empty()).then_some(Value::Object(map))
    }

    fn with(mut self, marker: char) -> Self {
        match marker {
            '*' => self.bold = true,
            '_' => self.italic = true,
            _ => self.strike = true,
        }
        self
    }
}

/// Text with Slack's style markers, which open after the line start, a space or `(` and close
/// before the end, a space or punctuation — so `ai_call` and `5 * 3` stay as written.
fn styled(text: &str, style: &Style, out: &mut Vec<Value>) {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut plain_from = 0;
    let mut k = 0;
    while k < chars.len() {
        let (at, c) = chars[k];
        let opens = matches!(c, '*' | '_' | '~')
            && (k == 0 || matches!(chars[k - 1].1, ' ' | '\t' | '('))
            && chars.get(k + 1).is_some_and(|(_, n)| !n.is_whitespace() && *n != c);
        if opens {
            let close = (k + 2..chars.len()).find(|&j| {
                chars[j].1 == c
                    && !chars[j - 1].1.is_whitespace()
                    && chars.get(j + 1).is_none_or(|(_, n)| n.is_whitespace() || ".,;:!?)'\"".contains(*n))
            });
            if let Some(j) = close {
                tokens(&text[plain_from..at], style, out);
                styled(&text[at + c.len_utf8()..chars[j].0], &style.with(c), out);
                k = j + 1;
                plain_from = chars.get(k).map_or(text.len(), |(i, _)| *i);
                continue;
            }
        }
        k += 1;
    }
    tokens(&text[plain_from..], style, out);
}

/// `<…>` tokens Lotus left in the wire text, between plain runs.
fn tokens(text: &str, style: &Style, out: &mut Vec<Value>) {
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('>') else { break };
        plain(&rest[..open], style, out);
        token(&after[..close], style, out);
        rest = &after[close + 1..];
    }
    plain(rest, style, out);
}

fn token(inner: &str, style: &Style, out: &mut Vec<Value>) {
    let (target, label) = inner.split_once('|').map_or((inner, None), |(t, l)| (t, Some(l)));
    let element = if let Some(user) = target.strip_prefix('@') {
        json!({ "type": "user", "user_id": user })
    } else if let Some(group) = target.strip_prefix("!subteam^") {
        json!({ "type": "usergroup", "usergroup_id": group })
    } else if let Some(channel) = target.strip_prefix('#') {
        json!({ "type": "channel", "channel_id": channel })
    } else if let Some(range) = target.strip_prefix('!').filter(|r| matches!(*r, "here" | "channel" | "everyone")) {
        json!({ "type": "broadcast", "range": range })
    } else if target.starts_with("https://") || target.starts_with("http://") || target.starts_with("mailto:") {
        let mut link = json!({ "type": "link", "url": decode(target) });
        if let Some(label) = label.filter(|l| !l.is_empty()) {
            link["text"] = json!(decode(label));
        }
        if let Some(s) = style.json() {
            link["style"] = s;
        }
        link
    } else {
        // Not markup Slack knows: shown as typed.
        push_text(out, &format!("<{}>", decode(inner)), style.json().as_ref());
        return;
    };
    out.push(element);
}

/// Plain text: bare URLs become links, `:name:` becomes an emoji, the rest is literal.
fn plain(text: &str, style: &Style, out: &mut Vec<Value>) {
    let text = decode(text);
    let mut rest = text.as_str();
    while !rest.is_empty() {
        let url = find_url(rest);
        let emoji = find_emoji(rest);
        match (url, emoji) {
            (Some((s, e)), em) if em.is_none_or(|(es, _)| s <= es) => {
                push_text(out, &rest[..s], style.json().as_ref());
                let mut link = json!({ "type": "link", "url": &rest[s..e] });
                if let Some(st) = style.json() {
                    link["style"] = st;
                }
                out.push(link);
                rest = &rest[e..];
            }
            (_, Some((s, e))) => {
                push_text(out, &rest[..s], style.json().as_ref());
                out.push(json!({ "type": "emoji", "name": &rest[s + 1..e - 1] }));
                rest = &rest[e..];
            }
            _ => {
                push_text(out, rest, style.json().as_ref());
                break;
            }
        }
    }
}

/// A bare `http(s)://` URL, trailing sentence punctuation left out.
fn find_url(text: &str) -> Option<(usize, usize)> {
    let start = [text.find("https://"), text.find("http://")].into_iter().flatten().min()?;
    if start > 0 && text[..start].chars().next_back().is_some_and(|c| c.is_alphanumeric()) {
        let next = find_url(&text[start + 4..])?;
        return Some((start + 4 + next.0, start + 4 + next.1));
    }
    let tail = &text[start..];
    let mut end = tail.find(|c: char| c.is_whitespace()).unwrap_or(tail.len());
    while end > 0 && tail[..end].ends_with(['.', ',', ';', ':', '!', '?', ')', '"', '\'']) {
        // Keep a `)` that closes one opened inside the URL.
        if tail[..end].ends_with(')') && tail[..end].matches('(').count() >= tail[..end].matches(')').count() {
            break;
        }
        end -= 1;
    }
    let scheme = tail.find("://").map_or(0, |i| i + 3);
    (end > scheme).then_some((start, start + end))
}

/// `:name:` — lowercase letters, digits, `_`, `+`, `-`, with at least one letter, not glued to
/// a word before it (so `10:30:45` stays a time).
fn find_emoji(text: &str) -> Option<(usize, usize)> {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(rel) = text[from..].find(':') {
        let s = from + rel;
        let glued = s > 0 && (bytes[s - 1] as char).is_ascii_alphanumeric();
        let name_len = text[s + 1..]
            .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '+' | '-')))
            .unwrap_or(text.len() - s - 1);
        let name = &text[s + 1..s + 1 + name_len];
        let closes = text[s + 1 + name_len..].starts_with(':');
        if !glued && closes && name.chars().any(|c| c.is_ascii_lowercase()) {
            return Some((s, s + name_len + 2));
        }
        from = s + 1;
    }
    None
}

/// Appends `elements`, a text merged into the previous one when the styles match.
fn extend(out: &mut Vec<Value>, elements: Vec<Value>) {
    for element in elements {
        match (element["type"] == "text", element["text"].as_str()) {
            (true, Some(text)) => push_text(out, text, element.get("style")),
            _ => out.push(element),
        }
    }
}

/// Appends `text`, merged into the previous text element when it has the same style.
fn push_text(out: &mut Vec<Value>, text: &str, style: Option<&Value>) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = out.last_mut() {
        if last["type"] == "text" && last.get("style") == style {
            let joined = format!("{}{text}", last["text"].as_str().unwrap_or_default());
            last["text"] = Value::String(joined);
            return;
        }
    }
    let mut element = json!({ "type": "text", "text": text });
    if let Some(style) = style {
        element["style"] = style.clone();
    }
    out.push(element);
}

fn decode(text: &str) -> String {
    text.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")
}
