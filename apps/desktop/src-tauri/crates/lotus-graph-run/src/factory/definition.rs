//! The factory definition of a repo (ADR-0051 §2, FI1): `.lotus/factory.toml` plus one
//! `.lotus/factory/agents/<role>.md` per role whose defaults the repo changes.
//!
//! Read from `origin/<base>`, never from a worktree, so an agent cannot change its own rules. A role
//! without a file gets [`built_in`]. Anything the parser does not understand refuses the run, with
//! the file and line: a typo must not silently fall back to a default.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// The repo's factory file, relative to the repo root.
pub const FACTORY_FILE: &str = ".lotus/factory.toml";
/// The folder of the per-role agent files, relative to the repo root.
pub const AGENTS_DIR: &str = ".lotus/factory/agents";
/// The largest definition file read; a prompt is a page, never a book.
const FILE_LIMIT: usize = 64 * 1024;
/// The highest per-round question cap a repo may set. Lotus sets none itself (decided 2026-10-08):
/// the spec agent asks until it could build the ticket without guessing; the budget cap bounds it.
pub(crate) const MAX_QUESTIONS: u32 = 50;
/// The longest an agent of any role may run.
const MAX_TIMEOUT_MINUTES: u32 = 240;
/// A run with no new stage or agent step for this long is stalled, unless the repo says otherwise.
pub const DEFAULT_STALL_MINUTES: u32 = 20;
/// How often the Chief of Staff looks at a Factory PR when the repo does not say (`poll_minutes`).
pub const DEFAULT_POLL_MINUTES: u32 = 5;
/// Revision Runs a Factory PR may have when the repo does not say (`max_rounds`, ADR-0057).
pub const DEFAULT_MAX_ROUNDS: u32 = 3;
/// The most `max_rounds` a repo may set.
const MAX_ROUNDS: u32 = 10;
/// Whether a feedback batch may start a Revision Run by itself (`revise`, CoS 7).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Revise {
    /// A batch that passes the routing rule starts its round with no click.
    #[default]
    Auto,
    /// Every batch waits for the user's Start round.
    Confirm,
}

/// What Lotus may post on a Factory PR without a click (`replies`, ADR-0058, CoS 9).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Replies {
    /// Every reply and round summary waits for Send.
    #[default]
    Draft,
    /// Replies to addressed items and the round summary go out when the round ends, with the
    /// re-request. Question answers and declines still wait for Send.
    AutoAddressed,
}

/// The longest `reply_footer`.
const MAX_FOOTER: usize = 200;

/// The longest `poll_minutes`: a day.
const MAX_POLL_MINUTES: u32 = 24 * 60;

/// Whether a Factory PR may open ready (`[workflow].pr`, ADR-0063 §6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrMode {
    /// Open when review accepted and the gate is green (ADR-0055); otherwise Draft.
    #[default]
    Auto,
    /// Always Draft.
    Draft,
}

/// `[workflow]`: the shape of what a run produces. Templates hold `{type}`, `{ticket}`, `{slug}`,
/// `{title}`, `{summary}` (expanded by FM3, only checked here). `None` = today's built-in format.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub branch: Option<String>,
    pub commit: Option<String>,
    pub pr_title: Option<String>,
    pub pr: PrMode,
    pub base: Option<String>,
}

/// `[repos.<name>]`: what one sub-repo (a folder of the meta-repo) overrides.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoConfig {
    /// A file in the meta-repo, read at origin's default branch (`acme-api/CLAUDE.md`).
    pub rules: Option<String>,
    pub base: Option<String>,
    pub gate: Option<String>,
}

/// A [`Workflow`] seen from one sub-repo: `[repos.<name>].base` over `[workflow].base` over the
/// top-level `base`. The same shape, so the same type.
pub type ResolvedWorkflow = Workflow;

const TEMPLATE_VARS: [&str; 5] = ["type", "ticket", "slug", "title", "summary"];

/// The five roles of a Factory Run, in the order they work (ADR-0051 §1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Triage,
    Spec,
    Implement,
    Review,
    Handoff,
}

impl Role {
    pub const ALL: [Role; 5] = [Role::Triage, Role::Spec, Role::Implement, Role::Review, Role::Handoff];

    pub fn name(self) -> &'static str {
        match self {
            Role::Triage => "triage",
            Role::Spec => "spec",
            Role::Implement => "implement",
            Role::Review => "review",
            Role::Handoff => "handoff",
        }
    }

    fn parse(name: &str) -> Option<Role> {
        Role::ALL.into_iter().find(|r| r.name() == name)
    }

    /// Only Implement edits the worktree; every other role reads (ADR-0051 §6).
    fn access(self) -> Access {
        if self == Role::Implement {
            Access::Full
        } else {
            Access::ReadOnly
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Access {
    ReadOnly,
    Full,
}

impl Access {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Access::ReadOnly => "read-only",
            Access::Full => "full",
        }
    }
}

/// One role's agent: its frontmatter, and the file body as its prompt.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub role: Role,
    /// A delegation preset id (CLI + model). `None` = the run's own choice (the ticket's implementer).
    pub preset: Option<String>,
    /// The model the agent runs (`--model`); `None` = the preset's own.
    pub model: Option<String>,
    /// Review only: may run on the same preset and model as implement (FI7). Off = a review set
    /// up the same as implement does not run.
    pub same_model: bool,
    pub skills: Vec<String>,
    pub mcp: Vec<String>,
    pub access: Access,
    pub timeout_minutes: Option<u32>,
    /// Spec only: the most questions one brainstorm round asks.
    pub max_questions: Option<u32>,
    pub prompt: String,
    /// The file it came from; `None` = built in.
    pub source: Option<String>,
}

/// A repo's whole factory: the gate, defaults for every agent, and the five roles.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactoryDefinition {
    /// `base`: the branch Factory PRs go into. `None` = origin's default branch (origin/HEAD).
    /// Found by [`super::resolve_base`] in the default branch's copy of this file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Empty = the repo has no gate. A program path in the repo (`tools/gates.sh`); in a private factory, a shell command line
    /// (`npm test`), since a private factory cannot put a script in the repo (#169).
    pub gate: String,
    /// Lotus's private factory for the repo, kept outside it (#169); not the repo's own.
    pub private: bool,
    /// The cap a new run of this repo starts with, in USD.
    pub cap_usd: Option<f64>,
    /// Skills every agent gets, and MCP servers every agent but triage gets, before its own.
    pub skills: Vec<String>,
    pub mcp: Vec<String>,
    /// Ticket sizes whose spec is written without questions when triage says go and every
    /// readiness category is clear (`skip_brainstorm = ["XS"]`). Approval stays. Empty = never.
    pub skip_brainstorm: Vec<crate::triage::Size>,
    /// Minutes a running run may go without a new stage or agent step before the Chief of Staff
    /// calls it stalled (`stall_minutes`). `None` = [`DEFAULT_STALL_MINUTES`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stall_minutes: Option<u32>,
    /// Minutes between two looks at the run's PR (`poll_minutes`). `None` = [`DEFAULT_POLL_MINUTES`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll_minutes: Option<u32>,
    /// Revision Runs one Factory PR may have (`max_rounds`). `None` = [`DEFAULT_MAX_ROUNDS`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    /// `revise`: `"auto"` (the default) or `"confirm"`.
    #[serde(default)]
    pub revise: Revise,
    /// `replies`: `"draft"` (the default) or `"auto-addressed"`.
    #[serde(default)]
    pub replies: Replies,
    /// `reply_footer`: a line added under every reply and summary Lotus posts. `None` = no footer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_footer: Option<String>,
    /// `[workflow]` (defaults when absent).
    #[serde(skip_serializing_if = "workflow_is_default")]
    pub workflow: Workflow,
    /// `[repos.<name>]`, by sub-repo folder name.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub repos: BTreeMap<String, RepoConfig>,
    /// Always all five, in [`Role::ALL`] order.
    pub agents: Vec<AgentDefinition>,
    /// The Chief of Staff's Judge (CoS 5): not a stage role, so not in `agents`.
    pub chief: ChiefAgent,
}

/// The Chief of Staff's agent, from `chief-of-staff.md` ([`super::judge::CHIEF_OF_STAFF_FILE`]).
/// It runs one-shot and read-only, with no skills and no MCP, so only these keys apply.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChiefAgent {
    /// `None` = the ticket's implementer.
    pub preset: Option<String>,
    /// `None` = a cheap model ([`CHEAP_MODEL`] on a Claude preset), not the preset's own.
    pub model: Option<String>,
    pub prompt: String,
    /// The file it came from; `None` = built in.
    pub source: Option<String>,
}

impl Default for ChiefAgent {
    fn default() -> Self {
        Self { preset: None, model: None, prompt: super::judge::BUILT_IN_PROMPT.to_string(), source: None }
    }
}

/// The Judge's model when the file names none: labelling is a small task.
pub const CHEAP_MODEL: &str = "haiku";

fn workflow_is_default(w: &Workflow) -> bool {
    *w == Workflow::default()
}

/// The meta-repo's rules for one sub-repo (FM6): `[repos.<name>].rules`, else the meta-repo's
/// `CLAUDE.md`, as committed on origin's default branch.
#[derive(Debug, Clone, PartialEq)]
pub struct ParentRules {
    /// The path in the meta-repo the text came from.
    pub source: String,
    pub text: String,
}

impl ParentRules {
    /// The block put in front of a role's prompt.
    fn block(&self) -> String {
        format!(
            "The rules of the parent meta-repo for this work (`{}`). Follow them; they apply to everything you do here:\n\n{}",
            self.source,
            self.text.trim()
        )
    }
}

impl FactoryDefinition {
    /// This definition with `rules` in front of the prompt of every role (triage, spec, implement,
    /// review, handoff). Only the prompt text changes: no file is written, and each role's access
    /// (and so the CLAUDE.md isolation of the read-only ones) is untouched. `None` changes nothing.
    pub fn with_parent_rules(mut self, rules: Option<&ParentRules>) -> Self {
        if let Some(rules) = rules {
            let block = rules.block();
            for agent in &mut self.agents {
                agent.prompt = format!("{block}\n\n{}", agent.prompt.trim());
            }
        }
        self
    }

    /// The workflow for `repo` (a sub-repo folder name; `None` = the repo itself).
    pub fn workflow_for(&self, repo: Option<&str>) -> ResolvedWorkflow {
        let w = &self.workflow;
        let base = repo
            .and_then(|r| self.repos.get(r))
            .and_then(|r| r.base.clone())
            .or_else(|| w.base.clone())
            .or_else(|| self.base.clone());
        ResolvedWorkflow { branch: w.branch.clone(), commit: w.commit.clone(), pr_title: w.pr_title.clone(), pr: w.pr, base }
    }

    /// The gate for `repo`: `[repos.<repo>].gate`, else the top-level `gate`.
    pub fn gate_for(&self, repo: Option<&str>) -> &str {
        repo.and_then(|r| self.repos.get(r)).and_then(|r| r.gate.as_deref()).unwrap_or(&self.gate)
    }

    /// The rules file of sub-repo `repo` (`[repos.<repo>].rules`); `None` = fall back to the
    /// meta-repo's `CLAUDE.md`.
    pub fn rules_path_for(&self, repo: &str) -> Option<&str> {
        self.repos.get(repo).and_then(|r| r.rules.as_deref())
    }

    pub fn agent(&self, role: Role) -> &AgentDefinition {
        self.agents.iter().find(|a| a.role == role).expect("a definition holds all five roles")
    }
}

/// `.lotus/factory.toml`. Unknown keys are refused: a misspelt key would otherwise do nothing.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FactoryToml {
    /// Read by [`base_key`]; here so the key is known.
    #[allow(dead_code)]
    base: Option<toml::Value>,
    gate: Option<String>,
    cap_usd: Option<f64>,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    mcp: Vec<String>,
    #[serde(default)]
    skip_brainstorm: Vec<String>,
    stall_minutes: Option<u32>,
    poll_minutes: Option<u32>,
    max_rounds: Option<u32>,
    revise: Option<String>,
    replies: Option<String>,
    reply_footer: Option<String>,
    workflow: Option<WorkflowToml>,
    #[serde(default)]
    repos: BTreeMap<String, RepoToml>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkflowToml {
    branch: Option<String>,
    commit: Option<String>,
    pr_title: Option<String>,
    pr: Option<String>,
    base: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RepoToml {
    rules: Option<String>,
    base: Option<String>,
    gate: Option<String>,
}

/// The `base` key of a `.lotus/factory.toml` and its line, read alone: the default branch's copy
/// says where the definition is read from, before the rest of it is checked there. `[workflow].base`
/// wins over the top-level `base`. `Ok(None)` when no key is set, and when the file does not parse
/// (the full read reports that, with its line).
pub(crate) fn base_key(factory_toml: &str) -> Result<Option<(String, usize)>, String> {
    base_key_for(factory_toml, None)
}

/// [`base_key`] for sub-repo `repo`: `[repos.<repo>].base`, then `[workflow].base`, then `base`.
pub(crate) fn base_key_for(factory_toml: &str, repo: Option<&str>) -> Result<Option<(String, usize)>, String> {
    let Ok(table) = factory_toml.parse::<toml::Table>() else { return Ok(None) };
    let section = |name: &str| table.get(name).and_then(toml::Value::as_table);
    let repo_table = repo.and_then(|r| section("repos")?.get(r)?.as_table());
    let candidates = [
        repo.zip(repo_table).map(|(r, t)| (t, format!("repos.{r}"))),
        section("workflow").map(|t| (t, "workflow".to_string())),
        Some((&table, String::new())),
    ];
    for (t, name) in candidates.into_iter().flatten() {
        let Some(value) = t.get("base") else { continue };
        let line = section_key_line(factory_toml, &name, "base");
        return match value.as_str().map(str::trim) {
            Some(b) if is_branch_name(b) => Ok(Some((b.to_string(), line))),
            _ => Err(format!("{FACTORY_FILE}:{line}: base {value} is not a branch name")),
        };
    }
    Ok(None)
}

/// Line of `key =` inside `[section]` (`""` = before any header, `repos.a` = `[repos.a]`); falls
/// back to the section header's line, then 1. An empty `key` finds the header.
fn section_key_line(text: &str, section: &str, key: &str) -> usize {
    let mut current = String::new();
    let mut header_line = None;
    for (i, raw) in text.lines().enumerate() {
        let l = raw.trim();
        if let Some(h) = l.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
            current = h.replace(['"', '\''], "").trim().to_string();
            if current == section {
                header_line = Some(i + 1);
            }
            continue;
        }
        if current == section && !key.is_empty() && l.strip_prefix(key).is_some_and(|rest| rest.trim_start().starts_with('=')) {
            return i + 1;
        }
    }
    header_line.unwrap_or(1)
}

/// A template: one line, only the known `{vars}`.
fn check_template(value: &str, single_token: bool) -> Result<(), String> {
    if value.trim().is_empty() || value.contains('\n') {
        return Err("must be one non-empty line".into());
    }
    if single_token && value.trim().contains(char::is_whitespace) {
        return Err("must not contain spaces".into());
    }
    let mut rest = value;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}') else { return Err("has an unclosed `{`".into()) };
        let name = &rest[open + 1..open + close];
        if !TEMPLATE_VARS.contains(&name) {
            return Err(format!("{{{name}}} is not a template variable (use {})", TEMPLATE_VARS.map(|v| format!("{{{v}}}")).join(", ")));
        }
        rest = &rest[open + close + 1..];
    }
    Ok(())
}

fn parse_workflow(text: &str, file: Option<WorkflowToml>) -> Result<Workflow, String> {
    let Some(f) = file else { return Ok(Workflow::default()) };
    let at = |key: &str| format!("{FACTORY_FILE}:{}", section_key_line(text, "workflow", key));
    let tmpl = |key: &str, v: Option<String>, one_token: bool| -> Result<Option<String>, String> {
        match v {
            None => Ok(None),
            Some(v) => check_template(&v, one_token).map(|()| Some(v.trim().to_string())).map_err(|why| format!("{}: {key} {why}", at(key))),
        }
    };
    let pr = match f.pr.as_deref() {
        None | Some("auto") => PrMode::Auto,
        Some("draft") => PrMode::Draft,
        Some(other) => return Err(format!("{}: pr must be \"auto\" or \"draft\", not \"{other}\"", at("pr"))),
    };
    let base = checked_base(f.base, || at("base"))?;
    Ok(Workflow {
        branch: tmpl("branch", f.branch, true)?,
        commit: tmpl("commit", f.commit, false)?,
        pr_title: tmpl("pr_title", f.pr_title, false)?,
        pr,
        base,
    })
}

/// A `base` key, trimmed; `where_` says `<file>:<line>` for the error when it is not a branch name.
fn checked_base(raw: Option<String>, where_: impl Fn() -> String) -> Result<Option<String>, String> {
    let base = raw.map(|b| b.trim().to_string());
    if base.as_deref().is_some_and(|b| !is_branch_name(b)) {
        return Err(format!("{}: base is not a branch name", where_()));
    }
    Ok(base)
}

fn parse_repos(text: &str, file: BTreeMap<String, RepoToml>) -> Result<BTreeMap<String, RepoConfig>, String> {
    let mut out = BTreeMap::new();
    for (name, r) in file {
        let section = format!("repos.{name}");
        let ok = !name.is_empty() && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        if !ok {
            let header = section_key_line(text, &section, "");
            return Err(format!("{FACTORY_FILE}:{header}: repos \"{name}\" is not a folder name (letters, digits and - _ . only)"));
        }
        let at = |key: &str| format!("{FACTORY_FILE}:{}", section_key_line(text, &section, key));
        let base = checked_base(r.base, || at("base"))?;
        let gate = r.gate.map(|g| g.trim().to_string());
        if gate.as_deref() == Some("") {
            return Err(format!("{}: gate is empty", at("gate")));
        }
        let rules = r.rules.map(|p| p.trim().to_string());
        if let Some(p) = &rules {
            if p.starts_with('/') || p.split('/').any(|seg| seg == ".." || seg.is_empty()) {
                return Err(format!("{}: rules must be a path inside the meta-repo (no leading /, no ..)", at("rules")));
            }
        }
        out.insert(name, RepoConfig { rules, base, gate });
    }
    Ok(out)
}

/// The built-in agent of `role`, used when the repo has no file for it.
pub fn built_in(role: Role) -> AgentDefinition {
    AgentDefinition {
        role,
        preset: None,
        model: None,
        same_model: false,
        skills: Vec::new(),
        mcp: Vec::new(),
        access: role.access(),
        timeout_minutes: None,
        max_questions: None,
        prompt: built_in_prompt(role).to_string(),
        source: None,
    }
}

fn built_in_prompt(role: Role) -> &'static str {
    match role {
        Role::Triage => {
            "You are the triage agent of a Lotus factory. Read the ticket and the code it touches. Report its size \
             (XS-XL), how ready it is to build, the files involved, and whether it should go ahead, be clarified \
             first, or be refused. You do not change any file."
        }
        Role::Spec => {
            "You are the spec agent of a Lotus factory. Find what the ticket leaves open. Look in the code before \
             you ask. Ask only questions whose answer changes what gets built, each with a recommended answer. Then \
             write the spec: goal, numbered acceptance criteria, out of scope, assumptions, test plan. You do not \
             change any file."
        }
        Role::Implement => {
            "You are the implement agent of a Lotus factory. Build what the ticket asks, with a test for each \
             acceptance criterion, in the current directory only."
        }
        Role::Review => {
            "You are the review agent of a Lotus factory. Review the change as if a person you do not trust wrote \
             it. Check it against the approved spec, one acceptance criterion at a time. Report what is missing or \
             wrong, with file and line. You do not change any file, and you never call a change ready."
        }
        Role::Handoff => {
            "You are the hand-off agent of a Lotus factory. Write the pull request description: what changed, \
             why, how it was checked, and what a reviewer must look at. You do not change any file."
        }
    }
}

/// Parses a definition from the text of `.lotus/factory.toml` and of the files in
/// `.lotus/factory/agents/` (`(path, text)`). Every error starts with `<file>:<line>:`.
pub fn parse_definition(factory_toml: &str, agent_files: &[(String, String)]) -> Result<FactoryDefinition, String> {
    let file: FactoryToml = toml::from_str(factory_toml).map_err(|e| {
        let line = e.span().map_or(1, |span| line_of(factory_toml, span.start));
        format!("{FACTORY_FILE}:{line}: {}", e.message().trim())
    })?;
    let at = |key: &str| format!("{FACTORY_FILE}:{}", key_line(factory_toml, key));
    // No gate is allowed (ADR-0063 §7): the review alone guards the change; "" = none.
    let gate = file.gate.map(|g| g.trim().to_string()).unwrap_or_default();
    if let Some(cap) = file.cap_usd {
        if !cap.is_finite() || cap < 0.01 {
            return Err(format!("{}: cap_usd must be at least 0.01", at("cap_usd")));
        }
    }
    check_names(&file.skills).map_err(|why| format!("{}: skills: {why}", at("skills")))?;
    check_names(&file.mcp).map_err(|why| format!("{}: mcp: {why}", at("mcp")))?;
    if file.stall_minutes.is_some_and(|m| m == 0 || m > MAX_TIMEOUT_MINUTES) {
        return Err(format!("{}: stall_minutes must be 1 to {MAX_TIMEOUT_MINUTES}", at("stall_minutes")));
    }
    if file.poll_minutes.is_some_and(|m| m == 0 || m > MAX_POLL_MINUTES) {
        return Err(format!("{}: poll_minutes must be 1 to {MAX_POLL_MINUTES}", at("poll_minutes")));
    }
    if file.max_rounds.is_some_and(|m| m == 0 || m > MAX_ROUNDS) {
        return Err(format!("{}: max_rounds must be 1 to {MAX_ROUNDS}", at("max_rounds")));
    }
    let revise = match file.revise.as_deref() {
        None | Some("auto") => Revise::Auto,
        Some("confirm") => Revise::Confirm,
        Some(other) => return Err(format!("{}: revise must be \"auto\" or \"confirm\", not \"{other}\"", at("revise"))),
    };
    let replies = match file.replies.as_deref() {
        None | Some("draft") => Replies::Draft,
        Some("auto-addressed") => Replies::AutoAddressed,
        Some(other) => return Err(format!("{}: replies must be \"draft\" or \"auto-addressed\", not \"{other}\"", at("replies"))),
    };
    let base = base_key_for(factory_toml, None)?.map(|(name, _)| name);
    let workflow = parse_workflow(factory_toml, file.workflow)?;
    let repos = parse_repos(factory_toml, file.repos)?;
    let reply_footer = file.reply_footer.as_deref().map(str::trim).filter(|f| !f.is_empty()).map(str::to_string);
    if reply_footer.as_ref().is_some_and(|f| f.len() > MAX_FOOTER || f.contains('\n')) {
        return Err(format!("{}: reply_footer must be one line of at most {MAX_FOOTER} characters", at("reply_footer")));
    }
    let mut skip_brainstorm = Vec::new();
    for name in &file.skip_brainstorm {
        let Some(size) = crate::triage::Size::parse(name) else {
            return Err(format!("{}: skip_brainstorm: \"{name}\" is not a size (XS, S, M, L, XL)", at("skip_brainstorm")));
        };
        if !skip_brainstorm.contains(&size) {
            skip_brainstorm.push(size);
        }
    }

    let mut agents: BTreeMap<Role, AgentDefinition> = BTreeMap::new();
    let mut chief = ChiefAgent::default();
    for (path, text) in agent_files {
        let name = path.rsplit('/').next().unwrap_or(path);
        let Some(stem) = name.strip_suffix(".md") else { continue };
        if name == super::judge::CHIEF_OF_STAFF_FILE {
            chief = parse_chief(path, text)?;
            continue;
        }
        let Some(role) = Role::parse(stem) else {
            let known: Vec<&str> = Role::ALL.iter().map(|r| r.name()).collect();
            return Err(format!("{path}:1: no role called \"{stem}\" (the roles are {})", known.join(", ")));
        };
        agents.insert(role, parse_agent(path, role, text)?);
    }
    Ok(FactoryDefinition {
        base,
        gate,
        private: false,
        cap_usd: file.cap_usd,
        skills: file.skills,
        mcp: file.mcp,
        skip_brainstorm,
        stall_minutes: file.stall_minutes,
        poll_minutes: file.poll_minutes,
        max_rounds: file.max_rounds,
        revise,
        replies,
        reply_footer,
        workflow,
        repos,
        agents: Role::ALL.into_iter().map(|role| agents.remove(&role).unwrap_or_else(|| built_in(role))).collect(),
        chief,
    })
}

/// `chief-of-staff.md`: `preset`, `model` and the body as its prompt. `role` and `access` may
/// say what it is; skills, MCP and the stage keys are refused.
fn parse_chief(path: &str, text: &str) -> Result<ChiefAgent, String> {
    const NAME: &str = "chief-of-staff";
    if text.len() > FILE_LIMIT {
        return Err(format!("{path}:1: the file is larger than {} KB", FILE_LIMIT / 1024));
    }
    let (front, body) = split_frontmatter(path, text)?;
    let mut chief = ChiefAgent { source: Some(path.to_string()), ..ChiefAgent::default() };
    if !body.trim().is_empty() {
        chief.prompt = body.trim().to_string();
    }
    for (key, (line, value)) in parse_frontmatter(path, &front)? {
        let at = format!("{path}:{line}");
        let one = match value {
            Value::Text(t) => t,
            Value::List(_) if key == "skills" || key == "mcp" => String::new(),
            Value::List(_) => return Err(format!("{at}: {key} takes one value, not a list")),
        };
        match key.as_str() {
            "role" if one != NAME => return Err(format!("{at}: role is \"{one}\" but the file is {NAME}.md")),
            "access" if one != Access::ReadOnly.name() => {
                return Err(format!("{at}: access \"{one}\" is not allowed: the Chief of Staff only reads, so it is \"read-only\""))
            }
            "role" | "access" => {}
            "preset" if one.is_empty() => return Err(format!("{at}: preset is empty")),
            "preset" => chief.preset = Some(one),
            "model" if !is_model_name(&one) => {
                return Err(format!("{at}: model \"{one}\" is not a model name (letters, digits and - _ . : [ ] only)"))
            }
            "model" => chief.model = Some(one),
            "skills" | "mcp" => return Err(format!("{at}: {key} is not allowed: the Chief of Staff runs with no skills and no MCP")),
            other => return Err(format!("{at}: {other} is for the stage roles, not the Chief of Staff")),
        }
    }
    Ok(chief)
}

/// 1-based line of byte `offset` in `text`.
fn line_of(text: &str, offset: usize) -> usize {
    text[..offset.min(text.len())].matches('\n').count() + 1
}

/// The line of a top-level `key =` in a TOML file, for errors found after parsing; 1 if not found.
fn key_line(text: &str, key: &str) -> usize {
    text.lines()
        .position(|l| l.trim_start().strip_prefix(key).is_some_and(|rest| rest.trim_start().starts_with('=')))
        .map_or(1, |i| i + 1)
}

/// A skill or MCP server name: `mattpocock-skills:tdd`, `context7`, `my_skill.v2`.
fn check_names(names: &[String]) -> Result<(), String> {
    for name in names {
        let ok = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/@".contains(c));
        if !ok {
            return Err(format!("\"{name}\" is not a valid name (letters, digits and - _ . : / @ only)"));
        }
    }
    Ok(())
}

/// A branch on origin: `develop`, `release/2.x`. Never a flag, a range or a revision expression.
pub(crate) fn is_branch_name(name: &str) -> bool {
    !name.is_empty()
        && name != "HEAD"
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
}

/// A `--model` value: `opus`, `claude-sonnet-5-5`, `sonnet[1m]`. Never a flag or a space.
pub(crate) fn is_model_name(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('-') && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:[]".contains(c))
}

/// One frontmatter value.
#[derive(Debug)]
enum Value {
    Text(String),
    List(Vec<String>),
}

/// Frontmatter lines, each with its 1-based file line.
type FrontLines<'a> = Vec<(usize, &'a str)>;
/// `(key, (line, value))`, in file order.
type Entries = Vec<(String, (usize, Value))>;

const AGENT_KEYS: [&str; 9] = ["role", "preset", "model", "same_model", "skills", "mcp", "access", "timeout_minutes", "max_questions"];

fn parse_agent(path: &str, role: Role, text: &str) -> Result<AgentDefinition, String> {
    if text.len() > FILE_LIMIT {
        return Err(format!("{path}:1: the file is larger than {} KB", FILE_LIMIT / 1024));
    }
    let (front, body) = split_frontmatter(path, text)?;
    let mut agent = built_in(role);
    agent.source = Some(path.to_string());
    let body = body.trim();
    if !body.is_empty() {
        agent.prompt = body.to_string();
    }
    for (key, (line, value)) in parse_frontmatter(path, &front)? {
        let at = format!("{path}:{line}");
        let text = |value: Value| match value {
            Value::Text(t) => Ok(t),
            Value::List(_) => Err(format!("{at}: {key} takes one value, not a list")),
        };
        let number = |value: Value, max: u32| -> Result<u32, String> {
            let raw = text(value)?;
            match raw.parse::<u32>() {
                Ok(n) if (1..=max).contains(&n) => Ok(n),
                _ => Err(format!("{at}: {key} must be a whole number from 1 to {max}, not \"{raw}\"")),
            }
        };
        match key.as_str() {
            "role" => {
                let named = text(value)?;
                if named != role.name() {
                    return Err(format!("{at}: role is \"{named}\" but the file is {}.md", role.name()));
                }
            }
            "preset" => {
                let preset = text(value)?;
                if preset.is_empty() {
                    return Err(format!("{at}: preset is empty"));
                }
                agent.preset = Some(preset);
            }
            "model" => {
                let model = text(value)?;
                if !is_model_name(&model) {
                    return Err(format!("{at}: model \"{model}\" is not a model name (letters, digits and - _ . : [ ] only)"));
                }
                agent.model = Some(model);
            }
            "same_model" => {
                if role != Role::Review {
                    return Err(format!("{at}: same_model is for the review role only"));
                }
                agent.same_model = match text(value)?.as_str() {
                    "true" => true,
                    "false" => false,
                    other => return Err(format!("{at}: same_model must be true or false, not \"{other}\"")),
                };
            }
            "skills" | "mcp" => {
                let names = match value {
                    Value::List(items) => items,
                    Value::Text(one) if one.is_empty() => Vec::new(),
                    Value::Text(one) => vec![one],
                };
                check_names(&names).map_err(|why| format!("{at}: {key}: {why}"))?;
                if key == "mcp" && role == Role::Triage && !names.is_empty() {
                    return Err(format!("{at}: mcp is not allowed: triage reads only the ticket and the code (no MCP server)"));
                }
                if key == "skills" {
                    agent.skills = names;
                } else {
                    agent.mcp = names;
                }
            }
            "access" => {
                let named = text(value)?;
                let wanted = role.access();
                if named != wanted.name() {
                    let why = if wanted == Access::Full {
                        "implement edits the worktree, so its access is \"full\""
                    } else {
                        "only implement may change files, so this role is \"read-only\""
                    };
                    return Err(format!("{at}: access \"{named}\" is not allowed: {why}"));
                }
            }
            "timeout_minutes" => agent.timeout_minutes = Some(number(value, MAX_TIMEOUT_MINUTES)?),
            "max_questions" => {
                if role != Role::Spec {
                    return Err(format!("{at}: max_questions is for the spec role only"));
                }
                agent.max_questions = Some(number(value, MAX_QUESTIONS)?);
            }
            _ => unreachable!("parse_frontmatter keeps known keys only"),
        }
    }
    Ok(agent)
}

/// `(frontmatter lines with their 1-based file line, body)`. No `---` first line = no frontmatter.
fn split_frontmatter<'a>(path: &str, text: &'a str) -> Result<(FrontLines<'a>, &'a str), String> {
    let mut lines = text.split_inclusive('\n');
    if lines.next().map(str::trim_end) != Some("---") {
        return Ok((Vec::new(), text));
    }
    let mut front = Vec::new();
    let mut offset = text.find('\n').map_or(text.len(), |i| i + 1);
    for (i, line) in lines.enumerate() {
        offset += line.len();
        if line.trim_end() == "---" {
            return Ok((front, &text[offset..]));
        }
        front.push((i + 2, line.trim_end_matches(['\n', '\r'])));
    }
    Err(format!("{path}:1: the frontmatter opened with --- is never closed"))
}

/// The small YAML subset a frontmatter uses: `key: value`, `key: [a, b]`, `key:` followed by
/// `- item` lines, quotes, and `#` comments. Anything else is an error with its line.
fn parse_frontmatter(path: &str, front: &[(usize, &str)]) -> Result<Entries, String> {
    let mut out: Entries = Vec::new();
    // The key whose `- item` lines are being read.
    let mut open_list: Option<usize> = None;
    for &(line, raw) in front {
        let at = format!("{path}:{line}");
        let content = strip_comment(raw);
        if content.trim().is_empty() {
            continue;
        }
        if let Some(item) = content.trim_start().strip_prefix("- ").or_else(|| (content.trim() == "-").then_some("")) {
            let Some(index) = open_list else {
                return Err(format!("{at}: a list item without a key above it"));
            };
            let item = unquote(item.trim()).map_err(|why| format!("{at}: {why}"))?;
            if let (_, (_, Value::List(items))) = &mut out[index] {
                items.push(item);
            }
            continue;
        }
        if content.starts_with([' ', '\t']) {
            return Err(format!("{at}: unexpected indentation"));
        }
        open_list = None;
        let Some((key, rest)) = content.split_once(':') else {
            return Err(format!("{at}: expected `key: value`"));
        };
        let key = key.trim();
        if !AGENT_KEYS.contains(&key) {
            return Err(format!("{at}: unknown key \"{key}\" (known: {})", AGENT_KEYS.join(", ")));
        }
        if out.iter().any(|(k, _)| k == key) {
            return Err(format!("{at}: {key} is set twice"));
        }
        let rest = rest.trim();
        let value = if rest.is_empty() {
            open_list = Some(out.len());
            Value::List(Vec::new())
        } else if let Some(inner) = rest.strip_prefix('[') {
            let Some(inner) = inner.strip_suffix(']') else {
                return Err(format!("{at}: a [ list must close with ] on the same line"));
            };
            let items = split_items(inner).map_err(|why| format!("{at}: {why}"))?;
            Value::List(items)
        } else {
            Value::Text(unquote(rest).map_err(|why| format!("{at}: {why}"))?)
        };
        out.push((key.to_string(), (line, value)));
    }
    Ok(out)
}

/// Cuts a `#` comment that is outside quotes and at the line start or after a space.
fn strip_comment(line: &str) -> &str {
    let mut quote: Option<char> = None;
    let mut prev_space = true;
    for (i, c) in line.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' && prev_space => return &line[..i],
            None => {}
        }
        prev_space = c.is_whitespace();
    }
    line
}

/// `"a"`, `'a'` or `a`; an unclosed quote is an error.
fn unquote(value: &str) -> Result<String, String> {
    for q in ['"', '\''] {
        if let Some(rest) = value.strip_prefix(q) {
            return match rest.strip_suffix(q) {
                Some(inner) if !inner.contains(q) => Ok(inner.to_string()),
                _ => Err(format!("unclosed or extra {q} in {value}")),
            };
        }
    }
    Ok(value.to_string())
}

/// The items of `a, "b", c`; commas inside quotes stay in their item.
fn split_items(inner: &str) -> Result<Vec<String>, String> {
    let mut items = Vec::new();
    let (mut start, mut quote) = (0, None);
    for (i, c) in inner.char_indices() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == ',' => {
                items.push(&inner[start..i]);
                start = i + 1;
            }
            None => {}
        }
    }
    items.push(&inner[start..]);
    let items: Vec<&str> = items.into_iter().map(str::trim).collect();
    if items.len() == 1 && items[0].is_empty() {
        return Ok(Vec::new());
    }
    items
        .into_iter()
        .map(|item| if item.is_empty() { Err("an empty item in a [ ] list".to_string()) } else { unquote(item) })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter().map(|(p, t)| (format!("{AGENTS_DIR}/{p}"), t.to_string())).collect()
    }

    #[test]
    fn the_old_one_line_file_still_works_and_every_role_gets_its_built_in_agent() {
        let def = parse_definition("# gate\ngate = \"tools/gates.sh\"\n", &[]).unwrap();
        assert_eq!(def.gate, "tools/gates.sh");
        assert_eq!(def.agents.iter().map(|a| a.role).collect::<Vec<_>>(), Role::ALL);
        assert!(def.agents.iter().all(|a| a.source.is_none() && !a.prompt.is_empty()));
        assert_eq!(def.agent(Role::Implement).access, Access::Full);
        assert_eq!(def.agent(Role::Review).access, Access::ReadOnly);
        assert_eq!(def.agent(Role::Spec).max_questions, None, "Lotus does not cap the questions");
    }

    #[test]
    fn the_factory_file_is_real_toml() {
        let def = parse_definition(
            "gate = 'tools/gates.sh'   # comment\ncap_usd = 3.5\nskills = [\"grilling\"]\nmcp = [\n  \"context7\",\n]\nskip_brainstorm = [\"XS\", \"s\", \"XS\"]\n",
            &[],
        )
        .unwrap();
        assert_eq!((def.cap_usd, def.skills, def.mcp), (Some(3.5), vec!["grilling".to_string()], vec!["context7".to_string()]));
        assert_eq!(def.skip_brainstorm, vec![crate::triage::Size::XS, crate::triage::Size::S]);
        assert!(parse_definition("gate = \"g\"\n", &[]).unwrap().skip_brainstorm.is_empty(), "no skip unless the repo says so");
        assert_eq!(parse_definition("gate = \"g\"\nstall_minutes = 45\n", &[]).unwrap().stall_minutes, Some(45));
        assert_eq!(parse_definition("gate = \"g\"\npoll_minutes = 15\n", &[]).unwrap().poll_minutes, Some(15));
        assert_eq!(parse_definition("gate = \"g\"\nmax_rounds = 5\n", &[]).unwrap().max_rounds, Some(5));
        assert_eq!(parse_definition("gate = \"g\"\n", &[]).unwrap().revise, Revise::Auto);
        assert_eq!(parse_definition("gate = \"g\"\nrevise = \"confirm\"\n", &[]).unwrap().revise, Revise::Confirm);
        let plain = parse_definition("gate = \"g\"\n", &[]).unwrap();
        assert_eq!((plain.replies, plain.reply_footer), (Replies::Draft, None));
        let auto = parse_definition("gate = \"g\"\nreplies = \"auto-addressed\"\nreply_footer = \" Drafted with Lotus \"\n", &[]).unwrap();
        assert_eq!((auto.replies, auto.reply_footer.as_deref()), (Replies::AutoAddressed, Some("Drafted with Lotus")));
        assert_eq!(plain.base, None, "no key: the default branch");
        assert_eq!(parse_definition("gate = \"g\"\nbase = \" release/2.x \"\n", &[]).unwrap().base.as_deref(), Some("release/2.x"));
    }

    #[test]
    fn a_base_that_is_not_a_branch_name_names_its_line() {
        for bad in ["\"\"", "\"-x\"", "\"has space\"", "\"a..b\"", "\"HEAD\"", "\"origin/main~1\""] {
            let err = parse_definition(&format!("gate = \"g\"\n\nbase = {bad}\n"), &[]).unwrap_err();
            assert!(err.starts_with(".lotus/factory.toml:3: base"), "{bad} gave {err}");
        }
    }

    const WORKFLOW_FILE: &str = "gate = \"g\"\nbase = \"main\"\n\n[workflow]\nbranch = \"{type}/{ticket}-{slug}\"\ncommit = \"{type}: {title}\"\npr_title = \"{ticket} - {title}\"\npr = \"draft\"\nbase = \"develop\"\n\n[repos.acme-api]\nrules = \"acme-api/CLAUDE.md\"\nbase = \"release\"\ngate = \"make test\"\n\n[repos.acme-web]\nrules = \"acme-web/CLAUDE.md\"\n";

    #[test]
    fn workflow_and_repos_are_read_and_repos_override_workflow() {
        let def = parse_definition(WORKFLOW_FILE, &[]).unwrap();
        let wf = def.workflow_for(None);
        assert_eq!(wf.branch.as_deref(), Some("{type}/{ticket}-{slug}"));
        assert_eq!(wf.commit.as_deref(), Some("{type}: {title}"));
        assert_eq!(wf.pr_title.as_deref(), Some("{ticket} - {title}"));
        assert_eq!(wf.pr, PrMode::Draft);
        assert_eq!(wf.base.as_deref(), Some("develop"), "[workflow].base beats the top-level base");
        assert_eq!(def.workflow_for(Some("acme-web")).base.as_deref(), Some("develop"));
        assert_eq!(def.workflow_for(Some("acme-api")).base.as_deref(), Some("release"), "[repos] beats [workflow]");
        assert_eq!(def.gate_for(Some("acme-api")), "make test");
        assert_eq!(def.gate_for(Some("acme-web")), "g");
        assert_eq!(def.gate_for(Some("unknown")), "g");
        assert_eq!(def.rules_path_for("acme-api"), Some("acme-api/CLAUDE.md"));
        assert_eq!(def.rules_path_for("other"), None);
    }

    #[test]
    fn a_file_without_workflow_keeps_today_s_defaults() {
        let def = parse_definition("gate = \"g\"\nbase = \"main\"\n", &[]).unwrap();
        let wf = def.workflow_for(None);
        assert_eq!((wf.branch, wf.commit, wf.pr_title, wf.pr), (None, None, None, PrMode::Auto));
        assert_eq!(wf.base.as_deref(), Some("main"));
        assert!(def.repos.is_empty());
    }

    #[test]
    fn base_key_for_follows_repos_then_workflow_then_top_level() {
        assert_eq!(base_key_for(WORKFLOW_FILE, Some("acme-api")).unwrap().unwrap().0, "release");
        assert_eq!(base_key_for(WORKFLOW_FILE, None).unwrap().unwrap(), ("develop".to_string(), 9));
        assert_eq!(base_key(WORKFLOW_FILE).unwrap().unwrap().0, "develop");
        assert_eq!(base_key("gate = \"g\"\nbase = \"main\"\n").unwrap().unwrap(), ("main".to_string(), 2));
    }

    #[test]
    fn unknown_and_bad_workflow_keys_name_their_line() {
        let cases = [
            ("gate = \"g\"\n[workflow]\nbranh = \"x\"\n", ".lotus/factory.toml:3:"),
            ("gate = \"g\"\n[repos.a]\nrule = \"x\"\n", ".lotus/factory.toml:3:"),
            ("gate = \"g\"\n[repos.a]\npr = \"draft\"\n", ".lotus/factory.toml:3:"),
            ("gate = \"g\"\n\n[workflow]\npr = \"yes\"\n", ".lotus/factory.toml:4: pr"),
            ("gate = \"g\"\n[workflow]\nbranch = \"{nope}/x\"\n", ".lotus/factory.toml:3: branch"),
            ("gate = \"g\"\n[workflow]\nbranch = \"a b\"\n", ".lotus/factory.toml:3: branch"),
            ("gate = \"g\"\n[workflow]\ncommit = \"\"\n", ".lotus/factory.toml:3: commit"),
            ("gate = \"g\"\n[workflow]\nbase = \"-x\"\n", ".lotus/factory.toml:3: base"),
            ("gate = \"g\"\n[repos.a]\nbase = \"a..b\"\n", ".lotus/factory.toml:3: base"),
            ("gate = \"g\"\n[repos.a]\nrules = \"../x\"\n", ".lotus/factory.toml:3: rules"),
            ("gate = \"g\"\n[repos.a]\nrules = \"/etc/x\"\n", ".lotus/factory.toml:3: rules"),
            ("gate = \"g\"\n[repos.a]\ngate = \" \"\n", ".lotus/factory.toml:3: gate"),
            ("gate = \"g\"\n[repos.\"a/b\"]\nbase = \"x\"\n", ".lotus/factory.toml:2: repos"),
        ];
        for (text, expected) in cases {
            let err = parse_definition(text, &[]).unwrap_err();
            assert!(err.contains(expected), "{text:?} gave {err:?}");
        }
    }

    #[test]
    fn a_repo_without_a_gate_is_allowed_and_its_gate_is_empty() {
        assert_eq!(parse_definition("# none\n", &[]).unwrap().gate, "");
        assert_eq!(parse_definition("gate = \"  \"\n", &[]).unwrap().gate, "");
        let def = parse_definition("[repos.a]\ngate = \"make test\"\n", &[]).unwrap();
        assert_eq!((def.gate_for(Some("a")), def.gate_for(None)), ("make test", ""));
    }

    #[test]
    fn a_broken_factory_file_names_its_line() {
        let cases = [
            ("gate = \"a\"\ngate = \"b\"\n", ".lotus/factory.toml:2:"),
            ("gate = \"a\"\n\ngaet = \"b\"\n", ".lotus/factory.toml:3:"),
            ("gate = tools/gates.sh\n", ".lotus/factory.toml:1:"),
            ("gate = \"a\"\ncap_usd = 0\n", ".lotus/factory.toml:2: cap_usd"),
            ("gate = \"a\"\n\nmcp = [\"has space\"]\n", ".lotus/factory.toml:3: mcp"),
            ("gate = \"a\"\nskip_brainstorm = [\"XXL\"]\n", ".lotus/factory.toml:2: skip_brainstorm: \"XXL\" is not a size"),
            ("gate = \"a\"\nstall_minutes = 0\n", ".lotus/factory.toml:2: stall_minutes"),
            ("gate = \"a\"\npoll_minutes = 0\n", ".lotus/factory.toml:2: poll_minutes"),
            ("gate = \"a\"\nmax_rounds = 0\n", ".lotus/factory.toml:2: max_rounds"),
            ("gate = \"a\"\nmax_rounds = 11\n", ".lotus/factory.toml:2: max_rounds"),
            ("gate = \"a\"\nrevise = \"yes\"\n", ".lotus/factory.toml:2: revise"),
            ("gate = \"a\"\nreplies = \"auto\"\n", ".lotus/factory.toml:2: replies"),
            ("gate = \"a\"\npoll_minutes = 1441\n", ".lotus/factory.toml:2: poll_minutes"),
            ("gate = \"a\"\nskip_brainstorm = \"XS\"\n", ".lotus/factory.toml:2:"),
        ];
        for (text, expected) in cases {
            let err = parse_definition(text, &[]).unwrap_err();
            assert!(err.contains(expected), "{text:?} gave {err:?}");
        }
    }

    #[test]
    fn an_agent_file_sets_its_frontmatter_and_its_body_is_the_prompt() {
        let spec = "---\nrole: spec\npreset: claude-opus          # CLI + model\nskills: [grilling, \"mattpocock-skills:grill-with-docs\"]\n\
                    mcp:\n  - context7\n  - 'github'\naccess: read-only\nmax_questions: 3\ntimeout_minutes: 20\n---\n\nYou are the spec agent.\n";
        let def = parse_definition("gate = \"g\"\n", &files(&[("spec.md", spec), ("README.txt", "ignored")])).unwrap();
        let agent = def.agent(Role::Spec);
        assert_eq!(agent.preset.as_deref(), Some("claude-opus"));
        assert_eq!(agent.skills, ["grilling", "mattpocock-skills:grill-with-docs"]);
        assert_eq!(agent.mcp, ["context7", "github"]);
        assert_eq!((agent.max_questions, agent.timeout_minutes), (Some(3), Some(20)));
        assert_eq!(agent.prompt, "You are the spec agent.");
        assert_eq!(agent.source.as_deref(), Some(".lotus/factory/agents/spec.md"));
        assert!(def.agent(Role::Triage).source.is_none());
    }

    #[test]
    fn an_agent_file_without_frontmatter_or_body_keeps_the_built_in_parts() {
        let def = parse_definition("gate = \"g\"\n", &files(&[("review.md", "Check the tests first.\n"), ("triage.md", "---\nskills: [x]\n---\n")]))
            .unwrap();
        assert_eq!(def.agent(Role::Review).prompt, "Check the tests first.");
        assert_eq!(def.agent(Role::Triage).prompt, built_in(Role::Triage).prompt);
        assert_eq!(def.agent(Role::Triage).skills, ["x"]);
    }

    #[test]
    fn chief_of_staff_md_sets_the_judge_and_is_no_stage_role() {
        let def = parse_definition("gate = \"g\"\n", &[]).unwrap();
        assert_eq!(def.chief, ChiefAgent::default(), "no file: built in, cheap model chosen by the adapter");
        let file = "---\nrole: chief-of-staff\npreset: claude-sonnet\nmodel: haiku\naccess: read-only\n---\nLabel strictly.\n";
        let def = parse_definition("gate = \"g\"\n", &files(&[("chief-of-staff.md", file)])).unwrap();
        assert_eq!(def.chief.preset.as_deref(), Some("claude-sonnet"));
        assert_eq!(def.chief.model.as_deref(), Some("haiku"));
        assert_eq!(def.chief.prompt, "Label strictly.");
        assert_eq!(def.chief.source.as_deref(), Some(".lotus/factory/agents/chief-of-staff.md"));
        assert_eq!(def.agents.iter().map(|a| a.role).collect::<Vec<_>>(), Role::ALL, "still the five stage roles");
        for (text, why) in [
            ("---\nmcp: [github]\n---\n", "chief-of-staff.md:2: mcp is not allowed"),
            ("---\nskills: [x]\n---\n", "skills is not allowed"),
            ("---\naccess: full\n---\n", "access \"full\" is not allowed"),
            ("---\nrole: review\n---\n", "role is \"review\""),
            ("---\nmax_questions: 2\n---\n", "max_questions is for the stage roles"),
            ("---\nmodel: \"-x\"\n---\n", "is not a model name"),
        ] {
            let err = parse_definition("gate = \"g\"\n", &files(&[("chief-of-staff.md", text)])).unwrap_err();
            assert!(err.contains(why), "{err}");
        }
    }

    #[test]
    fn a_broken_agent_file_names_its_file_and_line() {
        let cases = [
            ("foreman.md", "x", "agents/foreman.md:1: no role called \"foreman\""),
            ("spec.md", "---\nrole: spec\n", "agents/spec.md:1: the frontmatter opened with --- is never closed"),
            ("spec.md", "---\nrole: spec\nacess: read-only\n---\n", "agents/spec.md:3: unknown key \"acess\""),
            ("spec.md", "---\nrole: review\n---\n", "agents/spec.md:2: role is \"review\""),
            ("review.md", "---\naccess: full\n---\n", "agents/review.md:2: access \"full\" is not allowed"),
            ("implement.md", "---\naccess: read-only\n---\n", "agents/implement.md:2: access \"read-only\""),
            ("review.md", "---\nmax_questions: 2\n---\n", "agents/review.md:2: max_questions is for the spec role only"),
            ("spec.md", "---\nmax_questions: 99\n---\n", "agents/spec.md:2: max_questions must be a whole number from 1 to 50"),
            ("spec.md", "---\ntimeout_minutes: soon\n---\n", "agents/spec.md:2: timeout_minutes"),
            ("spec.md", "---\nskills: [a,\n---\n", "agents/spec.md:2: a [ list must close"),
            ("spec.md", "---\nskills: [a, , b]\n---\n", "agents/spec.md:2: an empty item"),
            ("spec.md", "---\nskills: [\"a b\"]\n---\n", "agents/spec.md:2: skills"),
            ("spec.md", "---\npreset: a\npreset: b\n---\n", "agents/spec.md:3: preset is set twice"),
            ("spec.md", "---\n  - stray\n---\n", "agents/spec.md:2: a list item without a key"),
            ("spec.md", "---\nskills: [x]\n  nested: y\n---\n", "agents/spec.md:3: unexpected indentation"),
            ("spec.md", "---\npreset: \"open\n---\n", "agents/spec.md:2: unclosed"),
            ("spec.md", "---\nrole: [spec]\n---\n", "agents/spec.md:2: role takes one value"),
            ("review.md", "---\nmodel: --dangerously-skip-permissions\n---\n", "agents/review.md:2: model \"--dangerously"),
            ("review.md", "---\nmodel: opus fast\n---\n", "agents/review.md:2: model \"opus fast\" is not a model name"),
            ("spec.md", "---\nsame_model: true\n---\n", "agents/spec.md:2: same_model is for the review role only"),
            ("review.md", "---\nsame_model: yes\n---\n", "agents/review.md:2: same_model must be true or false"),
        ];
        for (name, text, expected) in cases {
            let err = parse_definition("gate = \"g\"\n", &files(&[(name, text)])).unwrap_err();
            assert!(err.contains(expected), "{name} {text:?} gave {err:?}");
        }
    }

    #[test]
    fn a_hash_inside_quotes_is_not_a_comment() {
        let def = parse_definition("gate = \"g\"\n", &files(&[("spec.md", "---\npreset: \"a#b\" # real comment\n---\n")])).unwrap();
        assert_eq!(def.agent(Role::Spec).preset.as_deref(), Some("a#b"));
    }
}
