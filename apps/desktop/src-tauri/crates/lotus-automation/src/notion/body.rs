//! Editing a ticket's page body (PLAN S43–S44, task "Ticket Sources 13").
//!
//! The person edits Notion's own markdown — the same text `GET /v1/pages/{id}/markdown` returns —
//! and Lotus sends only what changed, as `update_content` search-and-replace pieces
//! (reference/update-page-markdown). Never `replace_content`: a page's `<unknown …/>` blocks, which
//! Lotus cannot show, would be lost. A page that has any, or that Notion cut short, is not edited
//! here at all.
//!
//! Before writing, the page is read again, and the write goes ahead only when its markdown is still
//! exactly what the person opened — Notion has no version to check against (S32). Each request is
//! sent once: a 5xx may be saved, so the page is read to see.

use serde::Serialize;
use serde_json::json;

use super::api::{notion_message, NotionApi};
use super::sync::SourceHealth;
use super::write::Permission;
use super::NotionError;
use crate::secrets::redact;

/// Notion takes at most this many `content_updates` per request.
pub const MAX_UPDATES: usize = 100;

/// The largest line diff done cell by cell (≈8 MB of table).
const MAX_DIFF_CELLS: usize = 2_000_000;

pub struct BodyRequest<'a> {
    pub page_id: &'a str,
    pub permission: Permission,
    pub health: &'a SourceHealth,
    /// The page's markdown as the person opened it.
    pub seen: &'a str,
    /// The markdown they saved.
    pub markdown: &'a str,
}

/// Why a body write was not sent. At most the page was read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "why", rename_all = "snake_case")]
pub enum BodyBlocked {
    ReadOnly,
    FieldsChanged,
    /// The page has blocks Lotus cannot show, or Notion cut it short (S44): edit it in Notion.
    NotEditable,
    /// Nothing to search in: `update_content` needs an existing piece to replace.
    Empty,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum BodyOutcome {
    /// Notion has it; `markdown` is the page as Notion now has it.
    Saved { markdown: String },
    /// The page changed since it was opened. Nothing was sent; `fresh` is Notion's version.
    Conflict { fresh: String },
    Refused { message: String },
    /// A request failed after an earlier one, or a 5xx did not land: `fresh` is what Notion has.
    NotSaved { fresh: String, message: String },
    /// A request went out and its fate could not be learned. Not repeated.
    Unknown { message: String },
}

pub async fn write_body(api: &NotionApi, request: BodyRequest<'_>) -> Result<BodyOutcome, BodyBlocked> {
    let BodyRequest { page_id, permission, health, seen, markdown } = request;
    if permission != Permission::Manage {
        return Err(BodyBlocked::ReadOnly);
    }
    if health.writes_paused() {
        return Err(BodyBlocked::FieldsChanged);
    }
    let now = match api.page_markdown(page_id).await {
        Ok(now) => now,
        Err(error) => return Ok(BodyOutcome::Refused { message: redact(&error.to_string()) }),
    };
    if now.truncated || !now.unknown_block_ids.is_empty() || has_unknown_blocks(&now.markdown) {
        return Err(BodyBlocked::NotEditable);
    }
    if now.markdown != seen {
        return Ok(BodyOutcome::Conflict { fresh: now.markdown });
    }
    if seen.trim().is_empty() {
        return Err(BodyBlocked::Empty);
    }
    let updates = match content_updates(seen, markdown) {
        Ok(updates) => updates,
        Err(why) => return Ok(BodyOutcome::Refused { message: why }),
    };
    if updates.is_empty() {
        return Ok(BodyOutcome::Saved { markdown: seen.to_string() });
    }

    let mut last = seen.to_string();
    for (sent, chunk) in updates.chunks(MAX_UPDATES).enumerate() {
        let body = json!({
            "type": "update_content",
            "update_content": {
                "content_updates": chunk.iter().map(|(old, new)| json!({ "old_str": old, "new_str": new })).collect::<Vec<_>>()
            }
        });
        let (status, answer) = match api.patch_markdown(page_id, body).await {
            Ok(answer) => answer,
            // Notion said no before doing anything.
            Err(error @ (NotionError::RateLimited { .. } | NotionError::Reconnect(_))) if sent == 0 => {
                return Ok(BodyOutcome::Refused { message: redact(&error.to_string()) })
            }
            Err(error) => return Ok(after_failure(api, page_id, markdown, redact(&error.to_string())).await),
        };
        match status {
            200..=299 => last = answer["markdown"].as_str().map(str::to_string).unwrap_or(last),
            500..=599 => {
                let said = notion_message(&answer.to_string()).unwrap_or_else(|| format!("HTTP {status}"));
                return Ok(after_failure(api, page_id, markdown, said).await);
            }
            _ => {
                let said = notion_message(&answer.to_string()).unwrap_or_else(|| format!("HTTP {status}"));
                let message = format!("Notion refused the change: {said}");
                return Ok(if sent == 0 {
                    BodyOutcome::Refused { message }
                } else {
                    after_failure(api, page_id, markdown, message).await
                });
            }
        }
    }
    Ok(BodyOutcome::Saved { markdown: last })
}

/// A request failed or went unanswered: never repeated. The page is read to say what Notion has.
async fn after_failure(api: &NotionApi, page_id: &str, wanted: &str, why: String) -> BodyOutcome {
    match api.page_markdown(page_id).await {
        Ok(now) if now.markdown == wanted => BodyOutcome::Saved { markdown: now.markdown },
        Ok(now) => BodyOutcome::NotSaved { fresh: now.markdown, message: why },
        Err(error) => BodyOutcome::Unknown {
            message: format!(
                "Notion may have saved part or all of the change ({why}); Lotus could not read the page to see ({}). Open it again.",
                redact(&error.to_string())
            ),
        },
    }
}

/// Whether the page's markdown carries a block Notion could not express — `<unknown …/>`, which
/// is how a bookmark, an embed or a link preview comes back, WITHOUT `truncated` or
/// `unknown_block_ids` being set (task "Ticket Sources 16"). A tag written inside code is
/// somebody's text, not a block, and does not count.
///
/// "Inside code" follows the frontend cleaner's rules exactly (`cleanNotionMarkdown` in
/// `notion-markdown.ts`), so the page never offers an edit that this then refuses, or the reverse:
/// a fence opens and closes at column 0 with the same marker (an unclosed one is not code), and an
/// inline span is a run of backticks up to the next run of the same length, across lines.
pub fn has_unknown_blocks(markdown: &str) -> bool {
    let prose = without_inline_code(&without_fences(markdown));
    let mut rest = prose.as_str();
    while let Some(at) = rest.find("<unknown") {
        let after = &rest[at + "<unknown".len()..];
        // `\b` in the cleaner's pattern: `<unknownish` is not the tag.
        if !after.chars().next().is_some_and(|c| c.is_alphanumeric() || c == '_') {
            return true;
        }
        rest = after;
    }
    false
}

/// The text with every fenced block removed — `^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$`, multiline.
fn without_fences(text: &str) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let marker = ["```", "~~~"].into_iter().find(|m| lines[i].starts_with(m));
        // An opening line needs a line after it for the pattern's `\n`.
        let close = marker.and_then(|m| (i + 1..lines.len()).find(|&j| lines[j].starts_with(m)));
        match close {
            Some(j) => {
                out.push("");
                i = j + 1;
            }
            None => {
                out.push(lines[i]);
                i += 1;
            }
        }
    }
    out.join("\n")
}

/// The text with every inline code span removed — `` (`+)[^`\n][\s\S]*?\1 ``, as the regex
/// engine finds them: leftmost first, the whole run of backticks, a first character that is neither
/// a backtick nor a newline, then the nearest later run of the same length.
fn without_inline_code(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let run = bytes[i..].iter().take_while(|&&b| b == b'`').count();
        let first = i + run;
        let fence = "`".repeat(run);
        // The span's first character, whole (it may be several bytes).
        let close = match text[first..].chars().next() {
            Some(c) if c != '\n' => {
                let from = first + c.len_utf8();
                text[from..].find(&fence).map(|at| from + at)
            }
            _ => None,
        };
        match close {
            Some(end) => {
                out.push_str(&text[copied..i]);
                i = end + run;
                copied = i;
            }
            // No span starts here; the engine tries again one character later.
            None => i += 1,
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// The smallest search-and-replace pieces that turn `seen` into `new`, by line. Each `old_str` is
/// grown with the lines around it until it matches exactly once in the page, and is never empty.
/// The pieces are checked by applying them the way Notion does before they are returned; when that
/// fails, one piece spanning every change is tried; when that fails too, it is refused.
pub fn content_updates(seen: &str, new: &str) -> Result<Vec<(String, String)>, String> {
    if seen == new {
        return Ok(vec![]);
    }
    let a: Vec<&str> = seen.split_inclusive('\n').collect();
    let b: Vec<&str> = new.split_inclusive('\n').collect();
    let hunks = diff_hunks(&a, &b);
    if let Some(updates) = pieces(seen, &a, &b, &hunks).filter(|u| applies(seen, u, new)) {
        return Ok(updates);
    }
    let (first, last) = (hunks[0], hunks[hunks.len() - 1]);
    let span = [Hunk { a0: first.a0, a1: last.a1, b0: first.b0, b1: last.b1 }];
    match pieces(seen, &a, &b, &span).filter(|u| applies(seen, u, new)) {
        Some(updates) => Ok(updates),
        None => Err("This change could not be sent as small edits. Make it in Notion.".into()),
    }
}

/// Lines `a0..a1` of the old text become lines `b0..b1` of the new.
#[derive(Debug, Clone, Copy)]
struct Hunk {
    a0: usize,
    a1: usize,
    b0: usize,
    b1: usize,
}

/// The changed runs between two line lists: common head and tail trimmed, then an LCS of the middle.
fn diff_hunks(a: &[&str], b: &[&str]) -> Vec<Hunk> {
    let head = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let tail = a[head..].iter().rev().zip(b[head..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (am, bm) = (&a[head..a.len() - tail], &b[head..b.len() - tail]);
    let (n, m) = (am.len(), bm.len());
    // The table is n×m: past this, the middle is sent as one piece rather than diffed line by line
    // (a whole long page rewritten would need hundreds of MB here).
    if n * m > MAX_DIFF_CELLS {
        return vec![Hunk { a0: head, a1: head + n, b0: head, b1: head + m }];
    }
    // lcs[i][j]: the longest common run of am[i..] and bm[j..].
    let mut lcs = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if am[i] == bm[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut hunks: Vec<Hunk> = vec![];
    let mut open: Option<Hunk> = None;
    while i < n || j < m {
        if i < n && j < m && am[i] == bm[j] {
            if let Some(h) = open.take() {
                hunks.push(h);
            }
            i += 1;
            j += 1;
            continue;
        }
        let h = open.get_or_insert(Hunk { a0: head + i, a1: head + i, b0: head + j, b1: head + j });
        if j < m && (i == n || lcs[i][j + 1] >= lcs[i + 1][j]) {
            j += 1;
            h.b1 = head + j;
        } else {
            i += 1;
            h.a1 = head + i;
        }
    }
    hunks.extend(open);
    hunks
}

/// Each hunk as a piece, grown with neighbouring old lines until its `old_str` is non-empty and
/// unique in `seen`. Hunks whose grown ranges would touch are merged first. `None` when a piece
/// cannot be made unique even as the whole page.
fn pieces(seen: &str, a: &[&str], b: &[&str], hunks: &[Hunk]) -> Option<Vec<(String, String)>> {
    let mut hunks = hunks.to_vec();
    'again: loop {
        let mut ranges = Vec::with_capacity(hunks.len());
        for h in &hunks {
            let (mut s, mut e) = (h.a0, h.a1);
            let mut before = true;
            loop {
                let old: String = a[s..e].concat();
                if !old.is_empty() && occurrences(seen, &old) == 1 {
                    break;
                }
                if s == 0 && e == a.len() {
                    return None;
                }
                if (before && s > 0) || e == a.len() {
                    s -= 1;
                } else {
                    e += 1;
                }
                before = !before;
            }
            ranges.push((s, e));
        }
        for k in 1..ranges.len() {
            if ranges[k].0 < ranges[k - 1].1 {
                let merged = Hunk { a0: hunks[k - 1].a0, a1: hunks[k].a1, b0: hunks[k - 1].b0, b1: hunks[k].b1 };
                hunks.splice(k - 1..=k, [merged]);
                continue 'again;
            }
        }
        return Some(
            hunks
                .iter()
                .zip(&ranges)
                .map(|(h, &(s, e))| (a[s..e].concat(), [a[s..h.a0].concat(), b[h.b0..h.b1].concat(), a[h.a1..e].concat()].concat()))
                .collect(),
        );
    }
}

/// Applies the pieces the way Notion does — each `old_str` must match exactly once — and checks the
/// result is `new`.
fn applies(seen: &str, updates: &[(String, String)], new: &str) -> bool {
    let mut text = seen.to_string();
    for (old, replacement) in updates {
        if old.is_empty() || occurrences(&text, old) != 1 {
            return false;
        }
        text = text.replacen(old.as_str(), replacement, 1);
    }
    text == new
}


/// How many times `needle` occurs in `hay`, overlapping ones included — the way Notion would find
/// it — counting no further than 2. `str::matches` skips overlaps: "x\nx\n" is once in
/// "x\nx\nx\n" by it, and twice to Notion.
fn occurrences(hay: &str, needle: &str) -> usize {
    let (mut found, mut from) = (0, 0);
    while let Some(at) = hay[from..].find(needle) {
        found += 1;
        if found > 1 {
            break;
        }
        from += at + hay[from + at..].chars().next().map_or(1, char::len_utf8);
    }
    found
}
