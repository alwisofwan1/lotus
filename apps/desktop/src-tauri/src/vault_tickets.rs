//! Reading the tickets of an Obsidian vault.
//!
//! Read-only, deliberately and permanently at this layer: the vault is the human's working copy
//! and Notion is the team's source of truth. The one way Lotus writes a ticket is
//! `vault_ticket_edit`, which keeps its writes surgical and refuses stale ones — and which reuses
//! `section_spans` from here, so what is edited is exactly what was read.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::skills::{frontmatter_value, parse_frontmatter};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTicket {
    /// The file name, which is the identity here — `ticket:` is NOT unique (two files carry
    /// `ticket: DRAFT`), so keying on it would silently collapse two tickets into one.
    pub file: String,
    pub ticket: String,
    pub title: String,
    /// Raw, never translated into Lotus's own vocabulary. The vault has seven statuses and can
    /// grow an eighth without a Lotus release; an enum here would repeat the exact failure of
    /// `tasks-tracker/issues/01` on a different wire.
    pub status: String,
    pub tags: Vec<String>,
    pub parent: Option<String>,
    pub notion: Option<String>,
    /// When the `From Notion` section was last pulled — the Notion page's `last_edited_time` at
    /// that pull, as an ISO timestamp. Absent until the first pull.
    pub notion_pulled: Option<String>,
    /// `YYYY-MM-DD`, kept as written. Never a timestamp: the vault writes a date, and widening it
    /// to an instant would invent a time of day nobody chose.
    pub created: Option<String>,
    pub updated: Option<String>,
    /// Milliseconds since the epoch, from the file itself.
    pub modified_at: u64,
}

/// One file, read as a ticket — or `None` when it is not one.
pub fn parse_ticket(raw: &str, file: &str, modified_at: u64) -> Option<VaultTicket> {
    let front = frontmatter_block(raw)?;
    let entries = parse_frontmatter(front);

    Some(VaultTicket {
        file: file.to_string(),
        ticket: frontmatter_value(&entries, "ticket")?,
        title: frontmatter_value(&entries, "title").unwrap_or_default(),
        status: frontmatter_value(&entries, "status").unwrap_or_default(),
        tags: frontmatter_value(&entries, "tags")
            .map(|raw| parse_inline_list(&raw))
            .unwrap_or_default(),
        parent: frontmatter_value(&entries, "parent"),
        notion: frontmatter_value(&entries, "notion"),
        notion_pulled: frontmatter_value(&entries, "notion_pulled"),
        created: frontmatter_value(&entries, "created"),
        updated: frontmatter_value(&entries, "updated"),
        modified_at,
    })
}

/// One run of prose under a `##` heading — or, with no heading, the pasted Notion description
/// that sits between the title and the first `##`.
///
/// `##` is the section level because that is what the tickets do: 53 of them open with
/// `## Summary` against 6 with `### Summary`, and the `###` runs are the Notion paste, which
/// arrives as one block under no heading of its own. Treating `###` as a section too would make
/// `## Implementation` a sibling of `### Implementation Notes` — two different things wearing
/// nearly the same name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketSection {
    /// `None` for the preamble. Three real tickets have nothing else.
    pub heading: Option<String>,
    pub body: String,
}

/// A ticket's prose, cut into sections, in file order.
///
/// File order rather than a map, because a ticket is read top to bottom and its headings are not
/// a fixed set: beyond the template's seven, the real tickets carry `## Description` (25 of them),
/// `## **Acceptance Criteria**` (13, bold markers and all) and `## Out of Scope`. Dropping what
/// the template did not predict would hide someone's writing.
pub fn ticket_sections(raw: &str) -> Vec<TicketSection> {
    section_spans(raw)
        .into_iter()
        .map(|span| TicketSection {
            body: span.text(raw).trim().to_string(),
            heading: span.heading,
        })
        .collect()
}

/// Where one section's prose sits in the raw file — the reader and the editor cut a ticket with
/// this ONE function, so "section 3" can never mean two different runs of text to them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SectionSpan {
    pub heading: Option<String>,
    /// Byte range of the body: from just after the heading line (or the frontmatter, or the
    /// skipped title line) up to the next `## ` line or the end of the file.
    pub body: std::ops::Range<usize>,
    /// The preamble skipped a `# ` title line INSIDE its range, after some prose. Its text is
    /// then not one contiguous run, and replacing it as one would delete the title line.
    pub split_by_title: bool,
}

impl SectionSpan {
    /// The body as the reader sees it: its lines minus a title line it skipped.
    fn text<'a>(&self, raw: &'a str) -> String {
        let mut out: Vec<&'a str> = Vec::new();
        let mut title_skipped = false;
        for line in raw[self.body.clone()].lines() {
            if self.split_by_title && !title_skipped && line.starts_with("# ") {
                title_skipped = true;
                continue;
            }
            out.push(line);
        }
        out.join("\n")
    }
}

/// Byte offset where the prose starts — just past the frontmatter's closing `---` line.
pub(crate) fn body_offset(raw: &str) -> usize {
    match frontmatter_block(raw) {
        // 4 = the closing "\n---", whose length the block itself does not include.
        Some(front) => (front.len() + "---".len() + 4).min(raw.len()),
        None => 0,
    }
}

pub(crate) fn section_spans(raw: &str) -> Vec<SectionSpan> {
    let start = body_offset(raw);

    let mut spans: Vec<SectionSpan> = Vec::new();
    let mut heading: Option<String> = None;
    let mut body_start = start;
    let mut prose_before_title = false;
    let mut split_by_title = false;
    let mut title_seen = false;
    let mut has_text = false;

    let flush = |spans: &mut Vec<SectionSpan>,
                     heading: Option<String>,
                     range: std::ops::Range<usize>,
                     split: bool,
                     has_text: bool| {
        // An empty preamble is nothing to show; an empty NAMED section is a heading the writer
        // put there on purpose and has not filled in yet, and it is kept so they can see that.
        if heading.is_some() || has_text {
            spans.push(SectionSpan { heading, body: range, split_by_title: split });
        }
    };

    let mut offset = start;
    for piece in raw[start..].split_inclusive('\n') {
        let line_start = offset;
        offset += piece.len();
        let line = piece.trim_end_matches(['\n', '\r']);

        if let Some(name) = line.strip_prefix("## ") {
            flush(&mut spans, heading.take(), body_start..line_start, split_by_title, has_text);
            heading = Some(name.trim().to_string());
            body_start = offset;
            split_by_title = false;
            has_text = false;
            continue;
        }
        // The first `# ` before any section is the title, which the frontmatter already carries.
        // A later one is content: one ticket pastes nine of them.
        if !title_seen && heading.is_none() && line.starts_with("# ") {
            title_seen = true;
            if prose_before_title {
                split_by_title = true;
            } else {
                // Nothing but blank lines before it: the preamble simply starts after the title.
                body_start = offset;
            }
            continue;
        }
        if !line.trim().is_empty() {
            has_text = true;
            if heading.is_none() && !title_seen {
                prose_before_title = true;
            }
        }
    }
    flush(&mut spans, heading, body_start..raw.len(), split_by_title, has_text);

    spans
}

/// A fingerprint of the file's exact bytes, handed out with every read and demanded back with
/// every edit. Obsidian and `obsidian-git` write these files with nobody at the keyboard; an edit
/// made against an older read must be REFUSED, not laid over whatever they wrote.
pub(crate) fn revision_of(raw: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    raw.hash(&mut hasher);
    format!("{:016x}-{}", hasher.finish(), raw.len())
}

/// One ticket with its prose, for the detail panel.
///
/// Separate from the list read on purpose: 78 tickets' worth of body is a large read, it is only
/// wanted for the one row somebody opened, and paying it for every row is paying it for rows
/// nobody looks at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultTicketDetail {
    pub ticket: VaultTicket,
    pub sections: Vec<TicketSection>,
    /// See `revision_of`. The editor sends it back so a stale edit is refused.
    pub revision: String,
}

/// Why a vault could not be read.
///
/// Three variants rather than one, because the three are three different things for the person to
/// do: fix the path, point at a folder instead of a file, or look at whether this is a vault at
/// all. One message covering all three sends someone hunting inside a directory that is not there.
#[derive(Debug, thiserror::Error)]
pub enum VaultTicketError {
    #[error("no such directory: {0}")]
    NoSuchDir(PathBuf),
    #[error("not a directory: {0}")]
    NotADir(PathBuf),
    #[error("vault has no tickets directory: {0}")]
    NoTicketsDir(PathBuf),
}

/// Every ticket in a vault's `tickets/` directory.
///
/// Sorted by file name so two reads of an unchanged vault produce the same list: the OS hands
/// back directory entries in whatever order it likes, and a list that reshuffles between reads
/// is a list you cannot point at.
pub fn list_tickets(vault: &Path) -> Result<Vec<VaultTicket>, VaultTicketError> {
    // Asked of the vault itself before its `tickets/`, so the answer names the thing that is
    // actually wrong.
    match std::fs::metadata(vault) {
        Err(_) => return Err(VaultTicketError::NoSuchDir(vault.to_path_buf())),
        Ok(meta) if !meta.is_dir() => return Err(VaultTicketError::NotADir(vault.to_path_buf())),
        Ok(_) => {}
    }

    let dir = vault.join("tickets");
    let entries =
        std::fs::read_dir(&dir).map_err(|_| VaultTicketError::NoTicketsDir(dir.clone()))?;

    let mut tickets: Vec<VaultTicket> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension()? != "md" {
                return None;
            }
            let file = path.file_name()?.to_str()?.to_string();
            // A file that cannot be read is skipped, not fatal: one unreadable note must not
            // empty a board of 78 that are perfectly readable.
            let raw = std::fs::read_to_string(&path).ok()?;
            parse_ticket(&raw, &file, modified_at_ms(&path))
        })
        .collect();

    tickets.sort_by(|left, right| left.file.cmp(&right.file));
    Ok(tickets)
}

/// One ticket, with its prose — or `None` when that file is not a ticket.
pub fn get_ticket(vault: &Path, file: &str) -> Result<Option<VaultTicketDetail>, VaultTicketError> {
    if !is_plain_file_name(file) {
        return Ok(None);
    }
    let path = vault.join("tickets").join(file);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };

    Ok(
        parse_ticket(&raw, file, modified_at_ms(&path)).map(|ticket| VaultTicketDetail {
            sections: ticket_sections(&raw),
            revision: revision_of(&raw),
            ticket,
        }),
    )
}

/// Is this a bare file name, and nothing else?
///
/// `file` reaches here from the webview, and a raw join would happily follow `../secret.md` out
/// of the vault — proven by a test that read a decoy outside `tickets/`. Checked as "exactly one
/// ordinary component" rather than by hunting for `..`, because a denylist has to anticipate every
/// spelling (`..`, a leading `/`, a Windows `C:`) and this has to anticipate none.
pub(crate) fn is_plain_file_name(file: &str) -> bool {
    let mut components = Path::new(file).components();
    matches!(components.next(), Some(std::path::Component::Normal(_))) && components.next().is_none()
}

/// A file's modification time in milliseconds, or 0 when the platform will not say.
///
/// 0 rather than "now": an unknown time that claims to be this instant would sort a file nobody
/// has touched to the top of a list ordered by recency.
pub(crate) fn modified_at_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as u64)
        .unwrap_or(0)
}

/// A YAML flow sequence written on one line — `[billing, dunning]` — as its items.
///
/// The shared frontmatter reader deliberately hands back scalars and skips sequences, and it is
/// left that way: reading the brackets HERE means `tags` is a list because this caller says so,
/// not because the parser grew a second mode that every other caller now has to think about.
/// Anything that is not a flow sequence yields nothing rather than one item named `[oops`.
fn parse_inline_list(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    let Some(inner) = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
    else {
        return Vec::new();
    };

    inner
        .split(',')
        .map(|item| item.trim().trim_matches(['"', '\'']).trim())
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

/// The text between the opening `---` and the closing one, or `None` when there is no
/// frontmatter block at all.
fn frontmatter_block(raw: &str) -> Option<&str> {
    let after = raw.strip_prefix("---")?;
    let end = after.find("\n---")?;
    Some(&after[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `file` arrives from the webview, so it is untrusted input into a path join. A decoy that
    /// IS a well-formed ticket proves the escape rather than the parser's refusal.
    #[test]
    fn refuses_a_file_name_that_climbs_out_of_the_tickets_directory() {
        let vault = vault_with(&[]);
        std::fs::write(
            vault.path().join("secret.md"),
            "---\nticket: TKT-9\ntitle: secret\nstatus: todo\n---\nnot yours\n",
        )
        .expect("write decoy");

        let escaped = get_ticket(vault.path(), "../secret.md").expect("a readable vault");

        assert_eq!(escaped, None);
    }

    #[test]
    fn reads_one_ticket_with_its_prose() {
        let vault = vault_with(&[(
            "TKT-1.md",
            "---\nticket: TKT-1\ntitle: t\nstatus: todo\n---\n\n# TKT-1 — t\n\n## Plan\n\nDo it.\n",
        )]);

        let detail = get_ticket(vault.path(), "TKT-1.md")
            .expect("a readable vault")
            .expect("a ticket");

        assert_eq!(
            (detail.ticket.ticket.as_str(), detail.sections.as_slice()),
            (
                "TKT-1",
                [TicketSection {
                    heading: Some("Plan".to_string()),
                    body: "Do it.".to_string()
                }]
                .as_slice()
            )
        );
    }

    /// TKT-573, TKT-596 and TKT-711 are pure Notion paste with no `##` anywhere. Under the
    /// "only `##` counts" reading they would have come back empty.
    #[test]
    fn a_ticket_with_no_section_headings_is_all_preamble() {
        let raw = concat!(
            "---\nticket: TKT-573\ntitle: t\nstatus: released\n---\n\n",
            "# TKT-573 — t\n\n### Background\n\nAll of it.\n",
        );

        let sections = ticket_sections(raw);

        assert_eq!(
            sections,
            vec![TicketSection {
                heading: None,
                body: "### Background\n\nAll of it.".to_string()
            }]
        );
    }

    /// Beyond the template's seven, the real tickets carry `## Description` (25 of them) and
    /// `## **Acceptance Criteria**` (13, bold markers included). Keeping only known headings
    /// would delete a quarter of the writing.
    #[test]
    fn a_heading_the_template_never_named_is_kept() {
        let raw = concat!(
            "---\nticket: TKT-1\ntitle: t\nstatus: todo\n---\n\n",
            "## Description\n\nWhat Notion said.\n\n",
            "## **Acceptance Criteria**\n\nIt works.\n",
        );

        let headings: Vec<String> = ticket_sections(raw)
            .into_iter()
            .filter_map(|section| section.heading)
            .collect();

        assert_eq!(headings, vec!["Description", "**Acceptance Criteria**"]);
    }

    #[test]
    fn a_title_quoted_because_it_holds_a_colon_keeps_neither_quote() {
        let raw = concat!(
            "---\nticket: DRAFT\n",
            "title: \"MDM: authenticate device callback router\"\n",
            "status: backlog\n---\nbody\n",
        );

        let ticket = parse_ticket(raw, "DRAFT-mdm-callback-auth.md", 0).expect("a ticket");

        assert_eq!(ticket.title, "MDM: authenticate device callback router");
    }

    /// One unreadable note must not empty a board of 78 readable ones — the same rule
    /// `useTrackerBoard` already holds for a workspace whose task file will not load.
    #[test]
    fn one_unreadable_file_does_not_empty_the_list() {
        let vault = vault_with(&[
            ("TKT-1.md", "---\nticket: TKT-1\ntitle: t\nstatus: todo\n---\nbody\n"),
            ("TKT-2.md", "---\nticket: TKT-2\ntitle: unclosed frontmatter\nstatus: todo\n"),
            ("TKT-3.md", "---\nticket: TKT-3\ntitle: t\nstatus: todo\n---\nbody\n"),
        ]);

        let tickets = list_tickets(vault.path()).expect("a readable vault");

        assert_eq!(
            tickets.iter().map(|t| t.ticket.as_str()).collect::<Vec<_>>(),
            vec!["TKT-1", "TKT-3"]
        );
    }

    /// Three situations, three sentences. A path someone typo'd is not "this vault has no tickets
    /// directory" — that sentence sends them looking inside a folder that is not there.
    #[test]
    fn a_path_that_does_not_exist_says_so_rather_than_blaming_the_tickets_directory() {
        let missing = std::path::Path::new("/definitely/not/here");

        let error = list_tickets(missing).expect_err("nothing at that path");

        assert_eq!(error.to_string(), "no such directory: /definitely/not/here");
    }

    #[test]
    fn a_file_where_a_vault_should_be_says_it_is_not_a_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("notes.md");
        std::fs::write(&file, "hello").expect("write file");

        let error = list_tickets(&file).expect_err("not a directory");

        assert_eq!(error.to_string(), format!("not a directory: {}", file.display()));
    }

    #[test]
    fn a_directory_that_is_not_a_vault_names_the_path_it_looked_for() {
        let dir = tempfile::tempdir().expect("tempdir");

        let error = list_tickets(dir.path()).expect_err("no tickets directory");

        assert_eq!(
            error.to_string(),
            format!(
                "vault has no tickets directory: {}",
                dir.path().join("tickets").display()
            )
        );
    }

    /// The module is read-only by design, not by habit. This fails the moment somebody adds the
    /// first write, which is exactly when the decision should be made again rather than drifted
    /// past.
    #[test]
    fn the_module_never_writes() {
        let source = include_str!("vault_tickets.rs");
        let outside_tests = source.split("#[cfg(test)]").next().expect("module body");

        assert!(
            !outside_tests.contains("fs::write") && !outside_tests.contains("fs::remove"),
            "vault_tickets is a reader; the vault is the human's copy and Notion is the team's"
        );
    }

    /// `updated:` is a date with no clock, is not required, and lags reality — 37 tickets sit in
    /// `released` with an `updated` from whenever someone last remembered. mtime is the only
    /// field that can answer "what was touched last".
    #[test]
    fn carries_the_files_modification_time() {
        let vault = vault_with(&[(
            "TKT-1.md",
            "---\nticket: TKT-1\ntitle: t\nstatus: todo\nupdated: 2026-01-01\n---\nbody\n",
        )]);

        let tickets = list_tickets(vault.path()).expect("a readable vault");

        assert!(
            tickets[0].modified_at > 0,
            "a file just written has a modification time"
        );
    }

    /// The shape TKT-987 really has: a title, a Notion paste written in `###`, then the
    /// template's own `##` sections underneath it.
    #[test]
    fn cuts_the_notion_paste_into_a_preamble_and_the_rest_into_named_sections() {
        let raw = concat!(
            "---\nticket: TKT-987\ntitle: t\nstatus: todo\n---\n\n",
            "# TKT-987 — Regional Pricing\n\n",
            "### Summary\n\nTwo related rules.\n\n",
            "### Currency Rule\n\nJapan bills in JPY.\n\n",
            "## Related\n\n[[TKT-598]]\n\n",
            "## Implementation\n\nback#2691.\n",
        );

        let sections = ticket_sections(raw);

        assert_eq!(
            sections,
            vec![
                TicketSection {
                    heading: None,
                    body: "### Summary\n\nTwo related rules.\n\n### Currency Rule\n\nJapan bills in JPY."
                        .to_string()
                },
                TicketSection {
                    heading: Some("Related".to_string()),
                    body: "[[TKT-598]]".to_string()
                },
                TicketSection {
                    heading: Some("Implementation".to_string()),
                    body: "back#2691.".to_string()
                },
            ]
        );
    }

    /// A vault whose `tickets/` directory holds the given files.
    fn vault_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let tickets = dir.path().join("tickets");
        std::fs::create_dir_all(&tickets).expect("tickets dir");
        for (name, body) in files {
            std::fs::write(tickets.join(name), body).expect("write ticket");
        }
        dir
    }

    /// The rule is the human's own Dataview board: `WHERE status = "..." AND ticket`. A file is a
    /// ticket when its frontmatter carries a non-empty `ticket:`, so the reader and the board can
    /// never disagree about what is on the list.
    #[test]
    fn lists_only_files_carrying_a_ticket_key() {
        let vault = vault_with(&[
            ("TKT-987.md", "---\nticket: TKT-987\ntitle: t\nstatus: todo\n---\nbody\n"),
            ("DRAFT-mdm-callback-auth.md", "---\nticket: DRAFT\ntitle: d\nstatus: backlog\n---\nbody\n"),
            ("_board.md", "---\ntitle: Ticket Board\n---\n\n# Board\n"),
            ("Untitled.md", ""),
        ]);

        let tickets = list_tickets(vault.path()).expect("a readable vault");

        assert_eq!(
            tickets.iter().map(|t| t.file.as_str()).collect::<Vec<_>>(),
            vec!["DRAFT-mdm-callback-auth.md", "TKT-987.md"]
        );
    }

    /// Against a REAL vault, not a fixture — the only way to learn that the inclusion rule agrees
    /// with a directory nobody wrote for this test. Ignored by default because it needs a machine
    /// that has one:
    ///
    /// ```sh
    /// LOTUS_VAULT_PATH=~/workspace/orbit-vault cargo test --lib -- --ignored reads_a_real_vault
    /// ```
    #[test]
    #[ignore]
    fn reads_a_real_vault() {
        let Ok(path) = std::env::var("LOTUS_VAULT_PATH") else {
            panic!("set LOTUS_VAULT_PATH to a vault directory");
        };

        let tickets = list_tickets(Path::new(&path)).expect("a readable vault");

        let files: Vec<&str> = tickets.iter().map(|t| t.file.as_str()).collect();
        assert!(!files.contains(&"_board.md"), "_board.md is not a ticket");
        assert!(!files.contains(&"Untitled.md"), "Untitled.md is not a ticket");
        eprintln!("read {} tickets", tickets.len());

        // The section model against prose nobody wrote for a test: a Notion paste in `###` under
        // the title, then the template's `##` sections beneath it.
        for ticket in tickets.iter().filter(|t| t.ticket == "TKT-987") {
            let detail = get_ticket(Path::new(&path), &ticket.file)
                .expect("a readable vault")
                .expect("a ticket");
            for section in &detail.sections {
                eprintln!(
                    "  {:<28} {} chars",
                    section.heading.as_deref().unwrap_or("<preamble>"),
                    section.body.len()
                );
            }
        }
    }

    /// Frontmatter with the given extra lines, around a minimal valid ticket.
    fn ticket_with(extra: &str) -> String {
        format!("---\nticket: TKT-1\ntitle: t\nstatus: todo\n{extra}---\n\nbody\n")
    }

    #[test]
    fn reads_the_optional_fields_when_they_carry_a_value() {
        let raw = ticket_with(concat!(
            "parent: TKT-598\n",
            "notion: https://app.notion.com/p/acme/TKT-987\n",
            "created: 2026-09-21\n",
            "updated: 2026-09-22\n",
        ));

        let ticket = parse_ticket(&raw, "TKT-1.md", 0).expect("a ticket");

        assert_eq!(
            (
                ticket.parent.as_deref(),
                ticket.notion.as_deref(),
                ticket.created.as_deref(),
                ticket.updated.as_deref()
            ),
            (
                Some("TKT-598"),
                Some("https://app.notion.com/p/acme/TKT-987"),
                Some("2026-09-21"),
                Some("2026-09-22")
            )
        );
    }

    /// 52 of 76 tickets carry a `notion:` line and only 9 carry a URL, so "the key is present"
    /// and "the key has a value" are different facts and only the second one may be shown.
    #[test]
    fn reads_a_bare_optional_key_as_absent() {
        let raw = ticket_with("parent:\nnotion:\n");

        let ticket = parse_ticket(&raw, "TKT-1.md", 0).expect("a ticket");

        assert_eq!((ticket.parent, ticket.notion), (None, None));
    }

    #[test]
    fn reads_inline_tags() {
        let raw = ticket_with("tags: [billing, dunning, edge-cases]\n");

        let ticket = parse_ticket(&raw, "TKT-1.md", 0).expect("a ticket");

        assert_eq!(ticket.tags, vec!["billing", "dunning", "edge-cases"]);
    }

    #[test]
    fn reads_an_empty_tag_list_as_no_tags() {
        let raw = ticket_with("tags: []\n");

        let ticket = parse_ticket(&raw, "TKT-1.md", 0).expect("a ticket");

        assert!(ticket.tags.is_empty());
    }

    #[test]
    fn reads_a_bare_tags_key_as_no_tags() {
        let raw = ticket_with("tags:\n");

        let ticket = parse_ticket(&raw, "TKT-1.md", 0).expect("a ticket");

        assert!(ticket.tags.is_empty());
    }

    #[test]
    fn reads_a_well_formed_ticket() {
        let raw = concat!(
            "---\n",
            "ticket: TKT-987\n",
            "title: Regional Pricing and Region-Only Plans\n",
            "status: in-review\n",
            "---\n",
            "\n",
            "# TKT-987 — Regional Pricing\n",
        );

        let ticket = parse_ticket(raw, "TKT-987.md", 0).expect("a file with a ticket: field is a ticket");

        assert_eq!(
            ticket,
            VaultTicket {
                file: "TKT-987.md".to_string(),
                ticket: "TKT-987".to_string(),
                title: "Regional Pricing and Region-Only Plans".to_string(),
                status: "in-review".to_string(),
                tags: Vec::new(),
                parent: None,
                notion: None,
                notion_pulled: None,
                created: None,
                updated: None,
                modified_at: 0,
            }
        );
    }
}
