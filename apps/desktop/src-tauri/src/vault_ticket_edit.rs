//! Editing one vault ticket — the only place Lotus writes to a vault.
//!
//! The vault's own rules (`CONVENTIONS.md`) set the terms: never overwrite the human's prose,
//! edit surgically, keep `status:` and `updated:` current. So an edit here is a set of NAMED
//! changes, never a whole file sent back from the webview:
//!
//! - `status` and `title` replace one frontmatter line each; every other line of the frontmatter
//!   is left byte for byte.
//! - a section edit replaces the body of that one `##` section, located with the reader's own
//!   `section_spans`, so "section 3" means the same run of text to both.
//! - an OWNED section (`## From Notion`) is one Lotus writes whole: replaced when the ticket has
//!   it, inserted just before the first `##` section when it does not — so the title, the preamble
//!   and every section a person wrote keep their bytes. It never rides along with section edits.
//! - `notion_pulled:` replaces one frontmatter line, like `status:`.
//! - `updated:` is set to the day the edit was made.
//!
//! And an edit is made against a REVISION. Obsidian and `obsidian-git` write these files with
//! nobody at the keyboard; an edit based on an older read is refused and the current ticket is
//! handed back, rather than laid over whatever they wrote.
//!
//! The write itself goes to a sibling temporary file that is then renamed over the ticket, so a
//! crash mid-write leaves the old file, never half of a new one.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::vault_tickets::{
    body_offset, get_ticket, is_plain_file_name, revision_of, section_spans, VaultTicketDetail,
};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketEdits {
    pub status: Option<String>,
    pub title: Option<String>,
    #[serde(default)]
    pub sections: Vec<SectionEdit>,
    /// A section Lotus owns and writes whole — today only `From Notion` (a pull, PLAN S38).
    #[serde(default)]
    pub owned_section: Option<OwnedSection>,
    /// When the pulled content was last edited at its source, as an ISO timestamp.
    #[serde(default)]
    pub notion_pulled: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedSection {
    pub heading: String,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionEdit {
    /// Position in the list the reader returned.
    pub index: usize,
    /// The heading that list had at that position — checked, so an index that now points at a
    /// different section is refused instead of overwriting it.
    pub heading: Option<String>,
    pub body: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum EditOutcome {
    Saved { detail: VaultTicketDetail },
    /// The file changed since `base_revision` was read. Nothing was written; `detail` is the
    /// ticket as it is now.
    Conflict { detail: VaultTicketDetail },
}

#[derive(Debug, thiserror::Error)]
pub enum EditError {
    #[error("not a ticket file: {0}")]
    NotATicket(String),
    #[error("{0}")]
    Refused(String),
    #[error("could not write the ticket: {0}")]
    Io(#[from] std::io::Error),
}

/// Apply `edits` to one ticket, if it is still the revision they were made against.
pub fn edit_ticket(
    vault: &Path,
    file: &str,
    base_revision: &str,
    today: &str,
    edits: &TicketEdits,
) -> Result<EditOutcome, EditError> {
    if !is_plain_file_name(file) {
        return Err(EditError::NotATicket(file.to_string()));
    }
    validate(today, edits)?;

    let path = vault.join("tickets").join(file);
    let raw = std::fs::read_to_string(&path).map_err(|_| EditError::NotATicket(file.to_string()))?;

    if revision_of(&raw) != base_revision {
        return Ok(EditOutcome::Conflict { detail: reread(vault, file)? });
    }

    let next = apply(&raw, today, edits)?;
    if next != raw {
        write_atomically(&path, &next)?;
    }
    Ok(EditOutcome::Saved { detail: reread(vault, file)? })
}

fn reread(vault: &Path, file: &str) -> Result<VaultTicketDetail, EditError> {
    get_ticket(vault, file)
        .ok()
        .flatten()
        .ok_or_else(|| EditError::NotATicket(file.to_string()))
}

fn validate(today: &str, edits: &TicketEdits) -> Result<(), EditError> {
    let is_date = today.len() == 10
        && today.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    if !is_date {
        return Err(EditError::Refused(format!("`today` must be YYYY-MM-DD, got {today:?}")));
    }
    if let Some(status) = &edits.status {
        // The vault's statuses are kebab-case words. Anything else would break its Dataview board.
        if status.is_empty() || !status.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err(EditError::Refused(format!("not a vault status: {status:?}")));
        }
    }
    for section in &edits.sections {
        // A `## ` line inside a body would be read back as a NEW section: the ticket's structure
        // would change under an edit that only meant to change prose. Refused, not escaped.
        if section.body.lines().any(|line| line.starts_with("## ")) {
            return Err(EditError::Refused(
                "a `## ` line would start a new section; use a smaller heading inside a section".to_string(),
            ));
        }
    }
    if let Some(owned) = &edits.owned_section {
        if !edits.sections.is_empty() {
            return Err(EditError::Refused(
                "an owned section is written on its own, never together with section edits".to_string(),
            ));
        }
        let heading = owned.heading.trim();
        if heading.is_empty() || heading.contains('\n') || heading.starts_with('#') {
            return Err(EditError::Refused(format!("not a section heading: {:?}", owned.heading)));
        }
        if owned.body.lines().any(|line| line.starts_with("## ")) {
            return Err(EditError::Refused(
                "a `## ` line would start a new section; use a smaller heading inside a section".to_string(),
            ));
        }
    }
    if let Some(pulled) = &edits.notion_pulled {
        // An ISO timestamp and nothing else: it lands unquoted in YAML, so a `: ` or `#` in it
        // would change what the frontmatter says.
        let looks_iso = pulled.len() >= 10
            && pulled.as_bytes()[4] == b'-'
            && pulled.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'-' | b':' | b'.' | b'T' | b'Z' | b'+'));
        if !looks_iso {
            return Err(EditError::Refused(format!("not an ISO timestamp: {pulled:?}")));
        }
    }
    if let Some(title) = &edits.title {
        if title.trim().is_empty() {
            return Err(EditError::Refused("a ticket needs a title".to_string()));
        }
        if title.contains('\n') {
            return Err(EditError::Refused("a title is one line".to_string()));
        }
    }
    Ok(())
}

/// The new file text. Pure, so every rule above is tested without a disk.
pub(crate) fn apply(raw: &str, today: &str, edits: &TicketEdits) -> Result<String, EditError> {
    // Sections first, highest index first: each replacement only moves the bytes AFTER it, so
    // working backwards keeps every earlier span valid. The frontmatter is before all of them.
    let spans = section_spans(raw);
    let mut sections: Vec<&SectionEdit> = edits.sections.iter().collect();
    sections.sort_by(|a, b| b.index.cmp(&a.index));

    let mut text = raw.to_string();
    for edit in sections {
        let span = spans
            .get(edit.index)
            .ok_or_else(|| EditError::Refused(format!("no section {} in this ticket", edit.index)))?;
        if span.heading != edit.heading {
            return Err(EditError::Refused(format!(
                "section {} is {:?} now, not {:?} — reload the ticket",
                edit.index, span.heading, edit.heading
            )));
        }
        if span.split_by_title {
            return Err(EditError::Refused(
                "this part of the ticket has its title line in the middle of it; edit it in Obsidian".to_string(),
            ));
        }
        let last = span.body.end == raw.len();
        text.replace_range(span.body.clone(), &section_text(&edit.body, last));
    }

    if let Some(owned) = &edits.owned_section {
        text = put_owned_section(&text, owned.heading.trim(), &owned.body);
    }

    let mut changed = !edits.sections.is_empty() || edits.owned_section.is_some();
    if let Some(pulled) = &edits.notion_pulled {
        text = set_front_value(&text, "notion_pulled", pulled);
        changed = true;
    }
    if let Some(status) = &edits.status {
        text = set_front_value(&text, "status", status);
        changed = true;
    }
    if let Some(title) = &edits.title {
        text = set_front_value(&text, "title", &yaml_scalar(title.trim()));
        changed = true;
    }
    if changed && text != raw {
        text = set_front_value(&text, "updated", today);
    }
    Ok(text)
}

/// The ticket with the owned section `heading` holding `body`: its body replaced when the ticket
/// has that section, otherwise the whole section inserted before the first `##` heading — or at
/// the end when there is none. Nothing else moves.
fn put_owned_section(raw: &str, heading: &str, body: &str) -> String {
    let spans = section_spans(raw);
    if let Some(span) = spans.iter().find(|span| span.heading.as_deref() == Some(heading)) {
        let last = span.body.end == raw.len();
        let mut text = raw.to_string();
        text.replace_range(span.body.clone(), &section_text(body, last));
        return text;
    }
    let first_heading = spans
        .iter()
        .find(|span| span.heading.is_some())
        .map(|span| heading_line_start(raw, span.body.start));
    match first_heading {
        Some(at) => format!("{}## {heading}\n{}{}", &raw[..at], section_text(body, false), &raw[at..]),
        None => {
            let sep = if raw.ends_with("\n\n") || raw.is_empty() {
                ""
            } else if raw.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{raw}{sep}## {heading}\n{}", section_text(body, true))
        }
    }
}

/// Where the `## ` line that a section body starts after begins.
fn heading_line_start(raw: &str, body_start: usize) -> usize {
    // The body starts just past its heading's newline; step back over it to the line's start.
    let before = &raw[..body_start.saturating_sub(1)];
    before.rfind('\n').map(|i| i + 1).unwrap_or(0)
}

/// A section body as it is written back: one blank line after the heading, the prose, and one
/// blank line before the next heading — the shape every template-made ticket already has.
fn section_text(body: &str, last: bool) -> String {
    let body = body.trim();
    match (body.is_empty(), last) {
        (true, _) => "\n".to_string(),
        (false, true) => format!("\n{body}\n"),
        (false, false) => format!("\n{body}\n\n"),
    }
}

/// Replace the value of one top-level frontmatter key, or add the key when it is absent.
///
/// Only that line changes. A trailing `# comment` on it is kept, because the schema example in `CONVENTIONS.md`
/// carries them and they are the human's.
fn set_front_value(raw: &str, key: &str, value: &str) -> String {
    let front_end = body_offset(raw);
    if front_end == 0 {
        return raw.to_string();
    }
    // The block without its closing "---\n", so an added key lands above the fence.
    let fence = raw[..front_end].rfind("\n---").map(|i| i + 1).unwrap_or(front_end);

    let mut offset = 0;
    for piece in raw[..fence].split_inclusive('\n') {
        let line_start = offset;
        offset += piece.len();
        let line = piece.trim_end_matches(['\n', '\r']);
        let Some(colon) = line.find(':') else { continue };
        if line.starts_with([' ', '\t']) || !line[..colon].trim().eq_ignore_ascii_case(key) {
            continue;
        }
        let comment = trailing_comment(&line[colon + 1..]);
        let eol = &piece[line.len()..];
        let rewritten = format!("{}: {value}{comment}{eol}", &line[..colon]);
        return format!("{}{}{}", &raw[..line_start], rewritten, &raw[offset..]);
    }

    format!("{}{key}: {value}\n{}", &raw[..fence], &raw[fence..])
}

/// ` # note` after an unquoted value, with the spacing that was there.
fn trailing_comment(rest: &str) -> &str {
    let trimmed = rest.trim_start();
    if trimmed.starts_with(['"', '\'']) {
        return "";
    }
    match rest.find(" #") {
        Some(at) => {
            // Keep the run of spaces in front of the `#` as it was aligned.
            let spaces = rest[..at].len() - rest[..at].trim_end().len();
            &rest[at - spaces..]
        }
        None => "",
    }
}

/// A title as YAML: plain when it is safe, double-quoted when a plain scalar would be misread.
fn yaml_scalar(value: &str) -> String {
    let risky_start = value.starts_with([
        '[', ']', '{', '}', '>', '|', '*', '&', '!', '%', '@', '`', '\'', '"', '#', '-', '?', ',',
    ]);
    if risky_start || value.contains(": ") || value.contains(" #") || value.ends_with(':') {
        format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn write_atomically(path: &Path, text: &str) -> Result<(), EditError> {
    let dir = path.parent().ok_or_else(|| EditError::Refused("ticket has no directory".into()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("ticket.md");
    // Dot-prefixed and not `.md`, so neither the reader nor Obsidian's indexer mistakes it for a note.
    let tmp = dir.join(format!(".{name}.lotus-edit"));
    std::fs::write(&tmp, text)?;
    if let Err(error) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_tickets::ticket_sections;

    const TICKET: &str = "---\nticket: TKT-1\ntitle: Old title\nstatus: todo      # required\ncreated: 2026-07-01\n---\n\n# TKT-1 — Old title\n\n## Summary\n\nFirst **bold** line.\n\n## Plan\n\n- [ ] one\n- [ ] two\n\n## Notes\n\nkeep me exactly   \n";

    fn edits() -> TicketEdits {
        TicketEdits::default()
    }

    #[test]
    fn a_status_change_rewrites_that_line_and_keeps_its_comment() {
        let out = apply(TICKET, "2026-09-24", &TicketEdits { status: Some("in-progress".into()), ..edits() }).unwrap();
        assert!(out.contains("status: in-progress      # required\n"), "{out}");
        assert!(out.contains("updated: 2026-09-24\n---"), "updated is added above the fence: {out}");
        // Everything below the frontmatter is untouched, byte for byte.
        assert_eq!(&out[out.find("\n---\n").unwrap()..], &TICKET[TICKET.find("\n---\n").unwrap()..]);
    }

    #[test]
    fn an_existing_updated_line_is_replaced_not_duplicated() {
        let raw = TICKET.replace("created: 2026-07-01\n", "created: 2026-07-01\nupdated: 2026-07-02\n");
        let out = apply(&raw, "2026-09-24", &TicketEdits { status: Some("released".into()), ..edits() }).unwrap();
        assert_eq!(out.matches("updated:").count(), 1);
        assert!(out.contains("updated: 2026-09-24\n"));
    }

    #[test]
    fn a_section_edit_replaces_only_that_section() {
        let out = apply(
            TICKET,
            "2026-09-24",
            &TicketEdits {
                sections: vec![SectionEdit { index: 1, heading: Some("Plan".into()), body: "- [x] one\n- [ ] two".into() }],
                ..edits()
            },
        )
        .unwrap();
        let sections = ticket_sections(&out);
        assert_eq!(sections[1].body, "- [x] one\n- [ ] two");
        assert_eq!(sections[0].body, "First **bold** line.");
        // The untouched LAST section keeps even its trailing spaces.
        assert!(out.ends_with("## Notes\n\nkeep me exactly   \n"), "{out}");
        assert!(out.contains("# TKT-1 — Old title\n"), "the title line survives");
    }

    #[test]
    fn a_section_whose_heading_moved_is_refused() {
        let result = apply(
            TICKET,
            "2026-09-24",
            &TicketEdits { sections: vec![SectionEdit { index: 1, heading: Some("Summary".into()), body: "x".into() }], ..edits() },
        );
        assert!(matches!(result, Err(EditError::Refused(_))));
    }

    #[test]
    fn several_sections_in_one_edit_all_land() {
        let out = apply(
            TICKET,
            "2026-09-24",
            &TicketEdits {
                sections: vec![
                    SectionEdit { index: 0, heading: Some("Summary".into()), body: "New summary".into() },
                    SectionEdit { index: 2, heading: Some("Notes".into()), body: "New notes".into() },
                ],
                ..edits()
            },
        )
        .unwrap();
        let bodies: Vec<String> = ticket_sections(&out).into_iter().map(|s| s.body).collect();
        assert_eq!(bodies, ["New summary", "- [ ] one\n- [ ] two", "New notes"]);
    }

    #[test]
    fn writing_back_every_section_unchanged_reads_back_the_same_ticket() {
        let sections = ticket_sections(TICKET);
        let out = apply(
            TICKET,
            "2026-09-24",
            &TicketEdits {
                sections: sections
                    .iter()
                    .enumerate()
                    .map(|(index, s)| SectionEdit { index, heading: s.heading.clone(), body: s.body.clone() })
                    .collect(),
                ..edits()
            },
        )
        .unwrap();
        assert_eq!(ticket_sections(&out), sections);
    }

    #[test]
    fn a_title_that_would_break_yaml_is_quoted_and_reads_back_whole() {
        let out = apply(TICKET, "2026-09-24", &TicketEdits { title: Some("MDM: fix \"500\"".into()), ..edits() }).unwrap();
        assert!(out.contains("title: \"MDM: fix \\\"500\\\"\"\n"), "{out}");
        let ticket = crate::vault_tickets::parse_ticket(&out, "TKT-1.md", 0).unwrap();
        assert_eq!(ticket.title, "MDM: fix \"500\"");
    }

    #[test]
    fn nothing_asked_means_nothing_written() {
        assert_eq!(apply(TICKET, "2026-09-24", &edits()).unwrap(), TICKET);
    }

    #[test]
    fn a_body_that_would_start_a_new_section_is_refused() {
        let result = validate(
            "2026-09-24",
            &TicketEdits { sections: vec![SectionEdit { index: 0, heading: None, body: "text\n## Sneaky".into() }], ..edits() },
        );
        assert!(matches!(result, Err(EditError::Refused(_))));
    }

    #[test]
    fn a_status_that_is_not_a_vault_word_is_refused() {
        let result = validate("2026-09-24", &TicketEdits { status: Some("In Progress".into()), ..edits() });
        assert!(matches!(result, Err(EditError::Refused(_))));
    }

    #[test]
    fn a_stale_revision_writes_nothing_and_hands_back_the_current_ticket() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("tickets")).unwrap();
        let path = dir.path().join("tickets/TKT-1.md");
        std::fs::write(&path, TICKET).unwrap();
        let stale = revision_of(TICKET);
        // Obsidian writes while the ticket is open in Lotus.
        let theirs = TICKET.replace("keep me exactly", "Obsidian wrote this");
        std::fs::write(&path, &theirs).unwrap();

        let outcome = edit_ticket(dir.path(), "TKT-1.md", &stale, "2026-09-24", &TicketEdits { status: Some("released".into()), ..edits() }).unwrap();

        assert!(matches!(outcome, EditOutcome::Conflict { .. }));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), theirs);
    }

    #[test]
    fn a_current_revision_saves_and_leaves_no_temporary_file() {
        // No inline comment here: the shared frontmatter reader keeps one as part of the value,
        // and no real ticket carries one (checked against the vault and its template).
        let ticket = TICKET.replace("      # required", "");
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("tickets")).unwrap();
        let path = dir.path().join("tickets/TKT-1.md");
        std::fs::write(&path, &ticket).unwrap();

        let outcome = edit_ticket(dir.path(), "TKT-1.md", &revision_of(&ticket), "2026-09-24", &TicketEdits { status: Some("released".into()), ..edits() }).unwrap();

        let EditOutcome::Saved { detail } = outcome else { panic!("expected a save") };
        assert_eq!(detail.ticket.status, "released");
        assert_eq!(detail.revision, revision_of(&std::fs::read_to_string(&path).unwrap()));
        let leftovers: Vec<_> = std::fs::read_dir(dir.path().join("tickets")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "{leftovers:?}");
    }

    #[test]
    fn refuses_a_file_name_that_climbs_out_of_the_tickets_directory() {
        let dir = tempfile::tempdir().unwrap();
        let result = edit_ticket(dir.path(), "../secret.md", "x", "2026-09-24", &edits());
        assert!(matches!(result, Err(EditError::NotATicket(_))));
    }

    fn pull(body: &str) -> TicketEdits {
        TicketEdits {
            owned_section: Some(OwnedSection { heading: "From Notion".into(), body: body.into() }),
            notion_pulled: Some("2026-09-28T13:12:00.000Z".into()),
            ..edits()
        }
    }

    /// Everything after the frontmatter, which is the part a pull must leave alone except for its one section.
    fn prose(raw: &str) -> &str {
        &raw[body_offset(raw)..]
    }

    #[test]
    fn a_first_pull_inserts_its_section_before_the_first_heading_and_moves_no_other_byte() {
        let out = apply(TICKET, "2026-09-28", &pull("From **Notion**.\n\n- AC1")).unwrap();
        let at = prose(TICKET).find("## Summary").unwrap();
        let expected = format!(
            "{}## From Notion\n\nFrom **Notion**.\n\n- AC1\n\n{}",
            &prose(TICKET)[..at],
            &prose(TICKET)[at..]
        );
        assert_eq!(prose(&out), expected);
        assert!(out.contains("notion_pulled: 2026-09-28T13:12:00.000Z\n"), "{out}");
        assert!(out.contains("updated: 2026-09-28\n"), "{out}");
        assert!(out.contains("status: todo      # required\n"), "other frontmatter lines untouched: {out}");
    }

    #[test]
    fn a_second_pull_replaces_only_its_own_section() {
        let first = apply(TICKET, "2026-09-28", &pull("old text")).unwrap();
        let second = apply(&first, "2026-09-29", &pull("new text\n- AC4")).unwrap();
        let once = apply(TICKET, "2026-09-29", &pull("new text\n- AC4")).unwrap();
        assert_eq!(second, once, "pulling twice reads the same as pulling the newer text once");
        assert_eq!(second.matches("## From Notion").count(), 1);
        let sections = ticket_sections(&second);
        assert_eq!(sections[0].heading.as_deref(), Some("From Notion"));
        assert_eq!(sections[0].body, "new text\n- AC4");
        assert!(second.ends_with("## Notes\n\nkeep me exactly   \n"), "{second}");
    }

    #[test]
    fn a_pull_into_a_ticket_with_no_sections_goes_at_the_end() {
        let raw = "---\nticket: TKT-2\ntitle: T\nstatus: todo\n---\n\n# TKT-2 — T\n\nPasted from Notion.\n";
        let out = apply(raw, "2026-09-28", &pull("fresh")).unwrap();
        assert_eq!(prose(&out), format!("{}\n## From Notion\n\nfresh\n", prose(raw)));
        let sections = ticket_sections(&out);
        assert_eq!(sections.last().unwrap().body, "fresh");
        assert_eq!(sections[0].body, "Pasted from Notion.");
    }

    #[test]
    fn a_pull_is_refused_when_its_text_would_start_a_new_section() {
        assert!(matches!(validate("2026-09-28", &pull("text\n## Sneaky")), Err(EditError::Refused(_))));
    }

    #[test]
    fn a_pull_cannot_ride_along_with_section_edits() {
        let mixed = TicketEdits {
            sections: vec![SectionEdit { index: 0, heading: Some("Summary".into()), body: "x".into() }],
            ..pull("y")
        };
        assert!(matches!(validate("2026-09-28", &mixed), Err(EditError::Refused(_))));
    }

    #[test]
    fn a_pulled_time_that_is_not_a_timestamp_is_refused() {
        let bad = TicketEdits { notion_pulled: Some("yesterday: 3pm".into()), ..pull("x") };
        assert!(matches!(validate("2026-09-28", &bad), Err(EditError::Refused(_))));
    }

    #[test]
    fn a_pull_against_a_stale_revision_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("tickets")).unwrap();
        let path = dir.path().join("tickets/TKT-1.md");
        std::fs::write(&path, TICKET).unwrap();
        let stale = revision_of(TICKET);
        let theirs = TICKET.replace("First **bold** line.", "Edited in Obsidian.");
        std::fs::write(&path, &theirs).unwrap();

        let outcome = edit_ticket(dir.path(), "TKT-1.md", &stale, "2026-09-28", &pull("from Notion")).unwrap();

        assert!(matches!(outcome, EditOutcome::Conflict { .. }));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), theirs);
    }

    #[test]
    fn a_pull_with_no_new_text_moves_only_the_pulled_time() {
        let first = apply(TICKET, "2026-09-28", &pull("same")).unwrap();
        let stamp = TicketEdits { notion_pulled: Some("2026-09-29T01:00:00.000Z".into()), ..edits() };
        let out = apply(&first, "2026-09-29", &stamp).unwrap();
        assert_eq!(prose(&out), prose(&first));
        assert!(out.contains("notion_pulled: 2026-09-29T01:00:00.000Z\n"), "{out}");
        assert_eq!(out.matches("notion_pulled:").count(), 1);
    }

    #[test]
    fn the_pulled_time_reads_back_from_the_ticket() {
        let out = apply(TICKET, "2026-09-28", &pull("x")).unwrap();
        let ticket = crate::vault_tickets::parse_ticket(&out, "TKT-1.md", 0).unwrap();
        assert_eq!(ticket.notion_pulled.as_deref(), Some("2026-09-28T13:12:00.000Z"));
    }

    /// Against the REAL vault, in memory only — nothing is written. For every ticket, writing each
    /// section back unchanged must read back as the same ticket. This is the check that the
    /// editor's cut and the reader's cut agree on files nobody wrote for a test.
    #[test]
    #[ignore = "reads ~/workspace/orbit-vault; run with --ignored"]
    fn round_trips_every_section_of_the_real_vault() {
        let home = std::env::var("HOME").unwrap();
        let dir = Path::new(&home).join("workspace/orbit-vault/tickets");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") { continue; }
            let raw = std::fs::read_to_string(&path).unwrap();
            let sections = ticket_sections(&raw);
            let spans = section_spans(&raw);
            let edits = TicketEdits {
                sections: sections
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| !spans[*i].split_by_title)
                    .map(|(index, s)| SectionEdit { index, heading: s.heading.clone(), body: s.body.clone() })
                    .collect(),
                ..TicketEdits::default()
            };
            let out = apply(&raw, "2026-09-24", &edits).unwrap();
            assert_eq!(ticket_sections(&out), sections, "{}", path.display());
            checked += 1;
        }
        assert!(checked > 0);
        eprintln!("round-tripped {checked} real tickets");
    }

    /// Against the REAL vault, in memory only: a pull into each ticket leaves every section a
    /// person wrote exactly as it was read, and adds exactly one `From Notion`.
    #[test]
    #[ignore = "reads ~/workspace/orbit-vault; run with --ignored"]
    fn a_pull_into_every_real_ticket_keeps_every_other_section() {
        let home = std::env::var("HOME").unwrap();
        let dir = Path::new(&home).join("workspace/orbit-vault/tickets");
        let mut checked = 0;
        for entry in std::fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") { continue; }
            let raw = std::fs::read_to_string(&path).unwrap();
            if raw.contains("\n## From Notion") { continue; }
            let before = ticket_sections(&raw);
            let out = apply(&raw, "2026-09-28", &pull("pulled text")).unwrap();
            let after: Vec<_> = ticket_sections(&out).into_iter().filter(|s| s.heading.as_deref() != Some("From Notion")).collect();
            assert_eq!(after, before, "{}", path.display());
            assert_eq!(out.matches("## From Notion").count(), 1, "{}", path.display());
            checked += 1;
        }
        assert!(checked > 0);
        eprintln!("pulled into {checked} real tickets");
    }
}
