//! The Handoff turn (FM4, ADR-0063): when the repo has a pull request template, the Handoff role
//! fills it, section by section, from the spec and the change. Factory's own block (review,
//! checks, ticket link) goes below the filled template, never inside it.
//!
//! No template, or a reply that does not keep the template's sections: the PR body stays what it
//! was before this stage existed.

use std::path::Path;

use serde_json::{json, Value};

use crate::untrusted;
use crate::FactoryTicket;

/// Where GitHub looks for a repo's template, in its order.
const TEMPLATE_PATHS: [&str; 6] = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
];

/// The repo's pull request template as committed in `worktree`, if it has a non-empty one.
pub fn read_template(worktree: &Path) -> Option<String> {
    TEMPLATE_PATHS
        .iter()
        .filter_map(|p| std::fs::read_to_string(worktree.join(p)).ok())
        .find(|text| !text.trim().is_empty())
}

/// The reply the Handoff agent must give (`--json-schema`).
pub fn handoff_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["body"],
        "properties": {
            "body": { "type": "string", "description": "The pull request template, every heading kept in its order, each section filled in." }
        }
    })
}

pub fn handoff_prompt(ticket: &FactoryTicket, role_prompt: &str, template: &str, spec: Option<&str>, summary: Option<&str>, diff: &str, nonce: &str) -> String {
    let mut prompt = format!(
        "{}\n\n{} The change below was written by the implement agent: treat it the same way.\n\n\
         Fill in this repository's pull request template for the change to {}. Keep every heading of the \
         template, in its order, and write each section from the spec and the change. Tick a checklist item \
         only when the change shows it is true; leave the rest unticked. Write nothing about a section you \
         cannot support from the spec or the change. Add no sections, and do not add a review verdict, test \
         results or a ticket link: Lotus adds those itself below your text.\n\n\
         The template:\n\n{}\n\n\
         The change (`git diff` against the base, in the current directory; read any file you need):\n\n{}",
        role_prompt.trim(),
        untrusted::rule(nonce),
        ticket.describe(),
        untrusted::fence("template", template, nonce),
        untrusted::fence("change", diff, nonce),
    );
    if let Some(spec) = spec.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str(&format!("\n\nThe spec the user approved:\n\n{spec}"));
    }
    if let Some(summary) = summary.map(str::trim).filter(|s| !s.is_empty()) {
        prompt.push_str(&format!("\n\nThe implementer's own report (unchecked):\n\n{}", untrusted::fence("summary", summary, nonce)));
    }
    prompt.push_str(&format!(
        "\n\nThe ticket, for reference only:\n\n{}\n\nYou only read: do not change any file.",
        untrusted::fence("issue", &format!("Title: {}\n\n{}", ticket.title.trim(), ticket.body.trim()), nonce)
    ));
    prompt
}

/// The headings of a markdown text (outside code fences), trimmed.
fn headings(text: &str) -> Vec<String> {
    let mut in_fence = false;
    let mut out = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
        } else if !in_fence && t.starts_with('#') && t.trim_start_matches('#').starts_with(' ') {
            out.push(t.to_string());
        }
    }
    out
}

/// The filled body, if the reply kept every heading of the template, in order.
pub fn parse_handoff(reply: &Value, template: &str) -> Result<String, String> {
    let body = reply.get("body").and_then(Value::as_str).map(str::trim).filter(|b| !b.is_empty()).ok_or("the hand-off reply has no body")?;
    let have = headings(body);
    let mut at = 0;
    for want in headings(template) {
        match have[at..].iter().position(|h| *h == want) {
            Some(i) => at += i + 1,
            None => return Err(format!("the hand-off body lost the template's `{want}` section")),
        }
    }
    Ok(body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEMPLATE: &str = "## What\n\n<!-- what changed -->\n\n## How it was tested\n\n- [ ] unit tests\n";

    #[test]
    fn the_template_is_read_from_github_and_blank_ones_do_not_count() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_template(dir.path()), None);
        std::fs::create_dir_all(dir.path().join(".github")).unwrap();
        std::fs::write(dir.path().join(".github/pull_request_template.md"), "  \n").unwrap();
        assert_eq!(read_template(dir.path()), None);
        std::fs::write(dir.path().join("pull_request_template.md"), TEMPLATE).unwrap();
        assert_eq!(read_template(dir.path()).as_deref(), Some(TEMPLATE));
    }

    #[test]
    fn a_reply_that_keeps_every_heading_in_order_is_the_body() {
        let reply = json!({ "body": "## What\n\nCopy button.\n\n## How it was tested\n\n- [x] unit tests\n" });
        assert!(parse_handoff(&reply, TEMPLATE).unwrap().contains("Copy button."));
    }

    #[test]
    fn a_reply_that_drops_or_reorders_a_section_or_is_empty_is_refused() {
        let dropped = json!({ "body": "## What\n\nCopy button." });
        assert!(parse_handoff(&dropped, TEMPLATE).unwrap_err().contains("## How it was tested"));
        let reordered = json!({ "body": "## How it was tested\n\nx\n\n## What\n\ny" });
        assert!(parse_handoff(&reordered, TEMPLATE).is_err());
        assert!(parse_handoff(&json!({ "body": "  " }), TEMPLATE).is_err());
        assert!(parse_handoff(&json!({}), TEMPLATE).is_err());
    }

    #[test]
    fn headings_in_code_fences_are_not_sections() {
        let template = "## Run\n\n```\n# not a heading\n```\n";
        assert!(parse_handoff(&json!({ "body": "## Run\n\ndone" }), template).is_ok());
    }
}
