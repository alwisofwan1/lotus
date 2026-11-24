//! Factory Workflow templates (ADR-0063, FM3): the branch, commit and PR title a `[workflow]`
//! table in `factory.toml` describes, with `{type} {ticket} {slug} {title} {summary}`. The keys
//! were validated when the definition was read; this only fills them in. No key, or a template
//! that fills to nothing usable, means the format Factory always had.

use crate::FactoryTicket;

/// What a template can name. `kind` is `feat` until triage picks one (FM8).
pub struct Vars<'a> {
    pub kind: &'a str,
    pub ticket: &'a FactoryTicket,
    /// The agent's report; known only once the agent has worked, so empty for a branch.
    pub summary: &'a str,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Style {
    Branch,
    Text,
}

const SLUG_MAX: usize = 40;
const FALLBACK_KIND: &str = "feat";

/// `add a dark mode!` -> `add-a-dark-mode`, at most [`SLUG_MAX`] characters.
pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.truncate(SLUG_MAX);
    out.trim_end_matches('-').to_string()
}

fn first_line(text: &str) -> &str {
    text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("")
}

fn fill(template: &str, vars: &Vars, style: Style) -> String {
    let kind = if vars.kind.is_empty() { FALLBACK_KIND } else { vars.kind };
    let branch = style == Style::Branch;
    let ticket = match (&vars.ticket.notion, branch) {
        (Some(n), _) => n.key.clone(),
        (None, true) => vars.ticket.issue.to_string(),
        (None, false) => vars.ticket.label(),
    };
    let title = if branch { slugify(&vars.ticket.title) } else { vars.ticket.title.trim().to_string() };
    let summary = if branch { slugify(first_line(vars.summary)) } else { first_line(vars.summary).to_string() };
    template
        .replace("{type}", kind)
        .replace("{ticket}", &ticket)
        .replace("{slug}", &slugify(&vars.ticket.title))
        .replace("{title}", &title)
        .replace("{summary}", &summary)
}

/// The branch the template names, or `None` (no key, or it fills to something git refuses).
pub fn branch(template: Option<&str>, vars: &Vars) -> Option<String> {
    let name = fill(template?, vars, Style::Branch).trim_matches('-').to_string();
    super::definition::is_branch_name(&name).then_some(name)
}

/// The commit message or PR title the template names, or `None` when it fills to nothing.
pub fn text(template: Option<&str>, vars: &Vars) -> Option<String> {
    let line = fill(template?, vars, Style::Text).trim().to_string();
    (!line.is_empty()).then_some(line)
}

/// `name`, else `name-2`, `name-3` ... the first one `taken` does not know.
pub fn unique(name: &str, mut taken: impl FnMut(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    (2..1000).map(|n| format!("{name}-{n}")).find(|c| !taken(c)).unwrap_or_else(|| format!("{name}-x"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NotionTicket;

    fn notion() -> FactoryTicket {
        FactoryTicket {
            repo: "o/r".into(),
            issue: 0,
            title: "Add dark mode!".into(),
            body: String::new(),
            account: "a".into(),
            checkout: "/x".into(),
            base: "main".into(),
            implementer: String::new(),
            previous_failure: None,
            notion: Some(NotionTicket { key: "TKT-123".into(), page_id: "p".into(), url: "https://n".into() }),
            revision: None,
            workspace: None,
            repo_accounts: Default::default(),
        }
    }

    fn vars<'a>(t: &'a FactoryTicket, kind: &'a str, summary: &'a str) -> Vars<'a> {
        Vars { kind, ticket: t, summary }
    }

    #[test]
    fn a_branch_template_fills_every_variable() {
        let t = notion();
        let got = branch(Some("{type}/{ticket}-{slug}"), &vars(&t, "fix", ""));
        assert_eq!(got.as_deref(), Some("fix/TKT-123-add-dark-mode"));
    }

    #[test]
    fn type_falls_back_to_feat() {
        let t = notion();
        assert_eq!(branch(Some("{type}/{slug}"), &vars(&t, "", "")).as_deref(), Some("feat/add-dark-mode"));
    }

    #[test]
    fn no_key_means_no_template() {
        let t = notion();
        assert_eq!(branch(None, &vars(&t, "", "")), None);
        assert_eq!(text(None, &vars(&t, "", "")), None);
    }

    #[test]
    fn a_branch_that_git_refuses_is_dropped() {
        let t = notion();
        assert_eq!(branch(Some("{summary}"), &vars(&t, "", "")), None);
        assert_eq!(branch(Some("{type}//x"), &vars(&t, "", "")), None);
    }

    #[test]
    fn a_github_issue_is_its_number_in_a_branch_and_hash_number_in_text() {
        let mut t = notion();
        t.notion = None;
        t.issue = 12;
        assert_eq!(branch(Some("{ticket}-{slug}"), &vars(&t, "", "")).as_deref(), Some("12-add-dark-mode"));
        assert_eq!(text(Some("{ticket}: {title}"), &vars(&t, "", "")).as_deref(), Some("#12: Add dark mode!"));
    }

    #[test]
    fn text_keeps_the_title_and_takes_the_first_line_of_the_summary() {
        let t = notion();
        let got = text(Some("{type}({ticket}): {summary}"), &vars(&t, "feat", "\n  Adds a toggle.\nMore"));
        assert_eq!(got.as_deref(), Some("feat(TKT-123): Adds a toggle."));
    }

    #[test]
    fn a_taken_branch_gets_two_then_three() {
        let taken = ["b", "b-2"];
        assert_eq!(unique("b", |n| taken.contains(&n)), "b-3");
        assert_eq!(unique("c", |n| taken.contains(&n)), "c");
    }

    #[test]
    fn slugify_caps_the_length_without_a_trailing_dash() {
        let s = slugify("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbb");
        assert!(s.len() <= SLUG_MAX && !s.ends_with('-'), "{s}");
    }
}
