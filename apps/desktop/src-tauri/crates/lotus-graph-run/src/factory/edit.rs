//! The Agents tab (FI5): reads a repo's factory definition twice, as a run sees it
//! (`origin/<base>`) and as the user's checkout holds it, and writes the checkout's files.
//!
//! Writes go to the checkout only: no commit, no push. A run keeps reading `origin/<base>`
//! ([`super::read_definition`]), so a saved change counts once the user pushes it, and an agent
//! still cannot change its own rules. Every write is parsed with the rest of the checkout's files
//! first; one that would break the definition is refused and nothing is written.
//!
//! A repo with no factory of its own, at origin or in the checkout, gets a private one instead
//! (#169): kept by Lotus outside the repo (`KitSources::private_dir`), never committed, edited
//! here like a checkout. A run uses it only when `origin/<base>` has no `.lotus/factory.toml`.

use crate::no_window::NoWindow;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::definition::{built_in, parse_definition, FactoryDefinition, Role, AGENTS_DIR, FACTORY_FILE};
use super::runner::{origin_head, origin_ref, resolve_base_detail};

/// How long the tab waits for `git fetch` before it shows the last fetched `origin/<base>`.
pub const VIEW_FETCH_TIMEOUT: Duration = Duration::from_secs(15);

/// How a definition file in the checkout differs from `origin/<base>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileState {
    /// Edited here; origin has another version.
    Changed,
    /// Only here.
    Added,
    /// Only at origin: deleted here (Use built-in).
    Removed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnpushedFile {
    pub path: String,
    pub state: FileState,
}

/// One side of the view: the definition, or why it does not parse.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionSide {
    pub definition: Option<FactoryDefinition>,
    pub error: Option<String>,
}

impl DefinitionSide {
    fn of(result: Result<FactoryDefinition, String>) -> Self {
        match result {
            Ok(definition) => DefinitionSide { definition: Some(definition), error: None },
            Err(error) => DefinitionSide { definition: None, error: Some(error) },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinitionView {
    /// The branch runs start from; `None` when origin's default branch is unknown.
    pub base: Option<String>,
    /// `base` came from `.lotus/factory.toml` on origin's default branch (LOT2-192).
    pub base_from_file: bool,
    /// What the next run uses.
    pub origin: DefinitionSide,
    /// What the tab edits.
    pub local: DefinitionSide,
    /// The checkout's definition files that differ from `origin/<base>`, in path order.
    pub unpushed: Vec<UnpushedFile>,
    /// The built-in prompt of each role, so the pane can tell an own prompt from the default.
    pub built_in_prompts: BTreeMap<Role, String>,
    /// Problems that did not stop the read (a failed fetch).
    pub notes: Vec<String>,
    /// Set when the repo has no factory of its own: then `local` is Lotus's private factory in
    /// this folder, the tab saves there, and nothing is ever pushed (#169).
    pub private: Option<PrivateFactory>,
}

/// Lotus's own factory for a repo, outside the repo (#169).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivateFactory {
    /// The folder the tab saves to, in place of the checkout.
    pub dir: String,
}

/// What the pane saves for one role. Its access is not here: it is fixed by the role.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEdit {
    pub preset: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Review only (FI7).
    #[serde(default)]
    pub same_model: bool,
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp: Vec<String>,
    pub timeout_minutes: Option<u32>,
    pub max_questions: Option<u32>,
    #[serde(default)]
    pub prompt: String,
}

/// Definition files by path (`.lotus/factory.toml`, `.lotus/factory/agents/<role>.md`).
type Files = BTreeMap<String, String>;

/// Reads the view for `checkout`. `base` empty = origin's default branch. A failed fetch is a
/// note, not an error: the tab then shows the last fetched `origin/<base>`. `private` is where
/// Lotus would keep this repo's private factory; it is used when origin and the checkout both
/// have no `.lotus/factory.toml`.
pub fn read_view(
    checkout: &Path,
    base: &str,
    private: Option<&Path>,
    env: &HashMap<String, String>,
    fetch_timeout: Duration,
) -> DefinitionView {
    let mut notes = Vec::new();
    let mut base_from_file = false;
    let base = match resolve_base_detail(checkout, base, env, fetch_timeout) {
        Ok(resolved) => {
            base_from_file = resolved.from_file;
            notes.extend(resolved.warning);
            Some(resolved.name)
        }
        Err(why) => {
            notes.push(why);
            let base = base.trim();
            if base.is_empty() { origin_head(checkout, env) } else { Some(base.to_string()) }
        }
    };
    let origin_files = base.as_deref().map(|b| origin_files(checkout, &origin_ref(b), env));
    let origin = match (&base, &origin_files) {
        (Some(b), Some(Ok(files))) => DefinitionSide::of(parse_files(files).map_err(|why| format!("{why} (at origin/{b})"))),
        (_, Some(Err(why))) => DefinitionSide::of(Err(why.clone())),
        _ => DefinitionSide::of(Err("origin's default branch is not known: set the base branch".to_string())),
    };
    let local_files = local_files(checkout);
    // Private only when the repo surely has none: origin was read and lacks it, and so does the checkout.
    let none_in_repo = matches!(&origin_files, Some(Ok(files)) if !files.contains_key(FACTORY_FILE))
        && matches!(&local_files, Ok(files) if !files.contains_key(FACTORY_FILE));
    if let Some(dir) = private.filter(|_| none_in_repo) {
        return DefinitionView {
            base,
            base_from_file,
            origin,
            local: DefinitionSide::of(read_private_definition(dir)),
            unpushed: Vec::new(),
            built_in_prompts: Role::ALL.into_iter().map(|role| (role, built_in(role).prompt)).collect(),
            notes,
            private: Some(PrivateFactory { dir: dir.display().to_string() }),
        };
    }
    let local = match &local_files {
        Ok(files) => DefinitionSide::of(parse_files(files)),
        Err(why) => DefinitionSide::of(Err(why.clone())),
    };
    let unpushed = match (&local_files, &origin_files) {
        (Ok(here), Some(Ok(there))) => compare(here, there),
        _ => Vec::new(),
    };
    DefinitionView {
        base,
        base_from_file,
        origin,
        local,
        unpushed,
        built_in_prompts: Role::ALL.into_iter().map(|role| (role, built_in(role).prompt)).collect(),
        notes,
        private: None,
    }
}

/// The definition held in `dir`'s files on disk: a checkout, or a private factory's folder.
pub fn read_dir_definition(dir: &Path) -> Result<FactoryDefinition, String> {
    if !dir.is_dir() {
        return Err(format!("no {FACTORY_FILE}: a Factory Run needs the repo to declare its gate"));
    }
    parse_files(&local_files(dir)?)
}

/// Lotus's private factory in `dir` (#169): its gate is a shell command line.
/// `base` is refused: a run finds its base before it knows it will use a private factory, so only
/// the repo's own file can set it (LOT2-192).
pub fn read_private_definition(dir: &Path) -> Result<FactoryDefinition, String> {
    let definition = read_dir_definition(dir)?;
    if definition.base.is_some() {
        return Err(format!("{FACTORY_FILE}: base is not read from a private factory: commit it to the repo's own {FACTORY_FILE}"));
    }
    Ok(FactoryDefinition { private: true, ..definition })
}

/// Starts a private factory in `dir` (#169): a `.lotus/factory.toml` holding only the gate.
/// Refused when one is there already, or the gate is empty.
pub fn create_private(dir: &Path, gate: &str) -> Result<FactoryDefinition, String> {
    let gate = super::settings::validate_gate(gate)?;
    if dir.join(FACTORY_FILE).exists() {
        return Err(format!("{} already has a factory", dir.display()));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let quoted = serde_json::to_string(gate).map_err(|e| e.to_string())?;
    let text = format!(
        "# Lotus's private factory for this repo: kept on this Mac only, never in the repo.\n\
         # The command that must pass before a draft PR opens: a shell command line, run in the\n\
         # run's worktree.\n\
         gate = {quoted}\n"
    );
    write_checked(dir, FACTORY_FILE, Some(text)).map(|definition| FactoryDefinition { private: true, ..definition })
}

/// Writes `.lotus/factory/agents/<role>.md` in the checkout. Refused, with nothing written,
/// when the checkout's definition would not parse with it.
pub fn save_agent(checkout: &Path, role: Role, edit: &AgentEdit) -> Result<FactoryDefinition, String> {
    let path = agent_path(role);
    write_checked(checkout, &path, Some(render_agent(role, edit)))
}

/// Deletes the role's file, so the role is built in again.
pub fn reset_agent(checkout: &Path, role: Role) -> Result<FactoryDefinition, String> {
    write_checked(checkout, &agent_path(role), None)
}

/// Sets the skills and MCP servers every agent gets in `.lotus/factory.toml`, keeping the rest of
/// the file (gate, comments) as it is.
pub fn save_shared(checkout: &Path, skills: &[String], mcp: &[String]) -> Result<FactoryDefinition, String> {
    let files = local_files(checkout)?;
    let Some(text) = files.get(FACTORY_FILE) else {
        return Err(format!("no {FACTORY_FILE} in {}: add `gate = \"...\"` first", checkout.display()));
    };
    let text = set_toml_list(&set_toml_list(text, "skills", skills), "mcp", mcp);
    write_checked(checkout, FACTORY_FILE, Some(text))
}

/// The agent file for `edit`: frontmatter, then the prompt. A prompt equal to the built-in one is
/// left out, so the role keeps getting the default as it improves.
pub fn render_agent(role: Role, edit: &AgentEdit) -> String {
    let mut out = format!("---\nrole: {}\n", role.name());
    if let Some(preset) = edit.preset.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        out.push_str(&format!("preset: {preset}\n"));
    }
    if let Some(model) = edit.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
        out.push_str(&format!("model: {model}\n"));
    }
    if edit.same_model && role == Role::Review {
        out.push_str("same_model: true\n");
    }
    if !edit.skills.is_empty() {
        out.push_str(&format!("skills: [{}]\n", edit.skills.join(", ")));
    }
    if !edit.mcp.is_empty() {
        out.push_str(&format!("mcp: [{}]\n", edit.mcp.join(", ")));
    }
    out.push_str(&format!("access: {}\n", built_in(role).access.name()));
    if let Some(minutes) = edit.timeout_minutes {
        out.push_str(&format!("timeout_minutes: {minutes}\n"));
    }
    if let Some(questions) = edit.max_questions.filter(|_| role == Role::Spec) {
        out.push_str(&format!("max_questions: {questions}\n"));
    }
    out.push_str("---\n");
    let prompt = edit.prompt.trim();
    if !prompt.is_empty() && prompt != built_in(role).prompt.trim() {
        out.push_str(prompt);
        out.push('\n');
    }
    out
}

/// Replaces the top-level `key = ...` of a TOML file (one line or a multi-line array) with
/// `key = [..]`, or removes it when `names` is empty. Other lines are kept byte for byte.
fn set_toml_list(text: &str, key: &str, names: &[String]) -> String {
    let line = (!names.is_empty())
        .then(|| format!("{key} = [{}]", names.iter().map(|n| format!("\"{n}\"")).collect::<Vec<_>>().join(", ")));
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let is_key = |l: &str| l.trim_start().strip_prefix(key).is_some_and(|rest| rest.trim_start().starts_with('='));
    let Some(start) = lines.iter().position(|l| is_key(l)) else {
        let Some(line) = line else { return text.to_string() };
        let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
        return format!("{text}{sep}{line}\n");
    };
    let mut depth = 0i32;
    let mut end = start;
    for (i, l) in lines.iter().enumerate().skip(start) {
        depth += bracket_change(l);
        end = i;
        if depth <= 0 {
            break;
        }
    }
    let mut out: String = lines[..start].concat();
    if let Some(line) = line {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(&lines[end + 1..].concat());
    out
}

/// `[` minus `]` outside strings and comments.
fn bracket_change(line: &str) -> i32 {
    let (mut change, mut quote) = (0, None);
    for c in line.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '#' => break,
            None if c == '[' => change += 1,
            None if c == ']' => change -= 1,
            None => {}
        }
    }
    change
}

fn agent_path(role: Role) -> String {
    format!("{AGENTS_DIR}/{}.md", role.name())
}

/// Parses the checkout's files with `path` set to `text` (`None` = deleted), then writes it.
pub(super) fn write_checked(checkout: &Path, path: &str, text: Option<String>) -> Result<FactoryDefinition, String> {
    let mut files = local_files(checkout)?;
    match &text {
        Some(text) => files.insert(path.to_string(), text.clone()),
        None => files.remove(path),
    };
    let definition = parse_files(&files)?;
    let target = inside(checkout, path)?;
    match text {
        Some(text) => {
            let dir = target.parent().expect("a definition file has a folder");
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
            let tmp = target.with_extension("lotus-tmp");
            std::fs::write(&tmp, text).map_err(|e| format!("cannot write {path}: {e}"))?;
            std::fs::rename(&tmp, &target).map_err(|e| format!("cannot write {path}: {e}"))?;
        }
        None => match std::fs::remove_file(&target) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(format!("cannot delete {path}: {e}")),
            _ => {}
        },
    }
    Ok(definition)
}

/// `checkout/path`, refused when a symlink would take it outside the checkout.
fn inside(checkout: &Path, path: &str) -> Result<PathBuf, String> {
    let root = checkout.canonicalize().map_err(|e| format!("cannot open {}: {e}", checkout.display()))?;
    let target = root.join(path);
    let mut existing = target.parent().map(Path::to_path_buf);
    while let Some(dir) = existing {
        if let Ok(real) = dir.canonicalize() {
            if !real.starts_with(&root) {
                return Err(format!("{path} is outside {} (a symlink?)", checkout.display()));
            }
            break;
        }
        existing = dir.parent().map(Path::to_path_buf);
    }
    Ok(target)
}

fn parse_files(files: &Files) -> Result<FactoryDefinition, String> {
    let Some(toml) = files.get(FACTORY_FILE) else {
        return Err(format!("no {FACTORY_FILE}: a Factory Run needs the repo to declare its gate"));
    };
    let agents: Vec<(String, String)> =
        files.iter().filter(|(p, _)| p.as_str() != FACTORY_FILE).map(|(p, t)| (p.clone(), t.clone())).collect();
    parse_definition(toml, &agents)
}

/// The checkout's definition files, as they are on disk.
fn local_files(checkout: &Path) -> Result<Files, String> {
    if !checkout.is_dir() {
        return Err(format!("{} is not a folder", checkout.display()));
    }
    let mut files = Files::new();
    if let Ok(text) = std::fs::read_to_string(checkout.join(FACTORY_FILE)) {
        files.insert(FACTORY_FILE.to_string(), text);
    }
    if let Ok(entries) = std::fs::read_dir(checkout.join(AGENTS_DIR)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".md") && entry.path().is_file() {
                let text = std::fs::read_to_string(entry.path()).map_err(|e| format!("cannot read {AGENTS_DIR}/{name}: {e}"))?;
                files.insert(format!("{AGENTS_DIR}/{name}"), text);
            }
        }
    }
    Ok(files)
}

/// The definition files at `from`, with no fetch.
fn origin_files(checkout: &Path, from: &str, env: &HashMap<String, String>) -> Result<Files, String> {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .no_window()
            .arg("-C")
            .arg(checkout)
            .args(args)
            .envs(env)
            .stdin(Stdio::null())
            .output()
            .map_err(|e| format!("cannot run git: {e}"))
    };
    let listed = git(&["ls-tree", "-r", "--name-only", from, "--", FACTORY_FILE, &format!("{AGENTS_DIR}/")])?;
    if !listed.status.success() {
        return Err(format!("cannot read {from}: {}", String::from_utf8_lossy(&listed.stderr).trim()));
    }
    let mut files = Files::new();
    for path in String::from_utf8_lossy(&listed.stdout).lines() {
        let wanted = path == FACTORY_FILE || (path.ends_with(".md") && path.rsplit_once('/').is_some_and(|(dir, _)| dir == AGENTS_DIR));
        if !wanted {
            continue;
        }
        let out = git(&["show", &format!("{from}:{path}")])?;
        if out.status.success() {
            files.insert(path.to_string(), String::from_utf8_lossy(&out.stdout).into_owned());
        }
    }
    Ok(files)
}

fn compare(here: &Files, there: &Files) -> Vec<UnpushedFile> {
    let paths: std::collections::BTreeSet<&String> = here.keys().chain(there.keys()).collect();
    paths
        .into_iter()
        .filter_map(|path| {
            let state = match (here.get(path), there.get(path)) {
                (Some(a), Some(b)) if a == b => return None,
                (Some(_), Some(_)) => FileState::Changed,
                (Some(_), None) => FileState::Added,
                (None, _) => FileState::Removed,
            };
            Some(UnpushedFile { path: path.clone(), state })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn git(at: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").arg("-C").arg(at).args(args).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    /// `<dir>/checkout` with a bare `origin` holding `files` on `main`.
    fn repo(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let checkout = dir.path().join("checkout");
        let origin = dir.path().join("origin.git");
        std::fs::create_dir_all(&checkout).unwrap();
        git(dir.path(), &["init", "--bare", "-b", "main", origin.to_str().unwrap()]);
        git(&checkout, &["init", "-b", "main"]);
        git(&checkout, &["config", "user.name", "Dev"]);
        git(&checkout, &["config", "user.email", "dev@example.com"]);
        std::fs::write(checkout.join("README.md"), "x").unwrap();
        for (path, text) in files {
            std::fs::create_dir_all(checkout.join(path).parent().unwrap()).unwrap();
            std::fs::write(checkout.join(path), text).unwrap();
        }
        git(&checkout, &["add", "-A"]);
        git(&checkout, &["commit", "-m", "init"]);
        git(&checkout, &["remote", "add", "origin", origin.to_str().unwrap()]);
        git(&checkout, &["push", "origin", "main"]);
        (dir, checkout)
    }

    #[test]
    fn a_rendered_agent_file_parses_back_to_what_was_saved() {
        let edit = AgentEdit {
            preset: Some("claude-opus".into()),
            model: Some("sonnet".into()),
            skills: names(&["grill-with-docs", "mattpocock-skills:tdd"]),
            mcp: names(&["context7"]),
            timeout_minutes: Some(20),
            max_questions: Some(3),
            prompt: "Ask about the data model first.".into(),
            ..Default::default()
        };
        let text = render_agent(Role::Spec, &edit);
        let def = parse_definition("gate = \"g\"\n", &[(agent_path(Role::Spec), text)]).unwrap();
        let spec = def.agent(Role::Spec);
        assert_eq!((spec.preset.as_deref(), spec.model.as_deref()), (Some("claude-opus"), Some("sonnet")));
        assert_eq!((spec.skills.clone(), spec.mcp.clone()), (edit.skills.clone(), edit.mcp.clone()));
        assert_eq!((spec.timeout_minutes, spec.max_questions), (Some(20), Some(3)));
        assert_eq!(spec.prompt, "Ask about the data model first.");
    }

    #[test]
    fn the_built_in_prompt_is_not_copied_into_the_file() {
        let edit = AgentEdit { prompt: built_in(Role::Implement).prompt, skills: names(&["tdd"]), ..Default::default() };
        let text = render_agent(Role::Implement, &edit);
        assert!(text.ends_with("---\n"), "{text}");
        assert!(text.contains("access: full\n"));
        let review = render_agent(Role::Review, &AgentEdit { max_questions: Some(2), ..Default::default() });
        assert!(!review.contains("max_questions"), "max_questions is for spec only: {review}");
    }

    #[test]
    fn same_model_is_saved_for_review_only() {
        let edit = AgentEdit { model: Some("opus".into()), same_model: true, ..Default::default() };
        let review = render_agent(Role::Review, &edit);
        let def = parse_definition("gate = \"g\"\n", &[(agent_path(Role::Review), review)]).unwrap();
        assert!(def.agent(Role::Review).same_model && def.agent(Role::Review).model.as_deref() == Some("opus"));
        assert!(!render_agent(Role::Spec, &edit).contains("same_model"));
    }

    #[test]
    fn set_toml_list_replaces_one_line_and_multi_line_arrays_and_keeps_the_rest() {
        let text = "# Factory gate\ngate = \"tools/gates.sh\"  # comment\nskills = [\n  \"a\", # first\n  \"b\",\n]\ncap_usd = 2.0\n";
        let out = set_toml_list(text, "skills", &names(&["house-style"]));
        assert_eq!(out, "# Factory gate\ngate = \"tools/gates.sh\"  # comment\nskills = [\"house-style\"]\ncap_usd = 2.0\n");
        let out = set_toml_list(&out, "mcp", &names(&["context7"]));
        assert!(out.ends_with("cap_usd = 2.0\nmcp = [\"context7\"]\n"), "{out}");
        let out = set_toml_list(&set_toml_list(&out, "skills", &[]), "mcp", &[]);
        assert_eq!(out, "# Factory gate\ngate = \"tools/gates.sh\"  # comment\ncap_usd = 2.0\n");
        assert_eq!(set_toml_list("gate = \"g\"", "mcp", &names(&["x"])), "gate = \"g\"\nmcp = [\"x\"]\n");
    }

    #[test]
    fn the_view_shows_origin_and_the_checkout_and_which_files_are_not_pushed() {
        let (_dir, checkout) = repo(&[
            (FACTORY_FILE, "gate = \"tools/gates.sh\"\n"),
            (".lotus/factory/agents/review.md", "---\nskills: [old]\n---\n"),
        ]);
        save_agent(&checkout, Role::Spec, &AgentEdit { skills: names(&["grilling"]), ..Default::default() }).unwrap();
        reset_agent(&checkout, Role::Review).unwrap();
        save_shared(&checkout, &names(&["house-style"]), &[]).unwrap();
        let view = read_view(&checkout, "", None, &Default::default(), VIEW_FETCH_TIMEOUT);
        assert_eq!(view.base.as_deref(), Some("main"));
        assert!(view.notes.is_empty(), "{:?}", view.notes);
        let origin = view.origin.definition.expect("origin parses");
        assert_eq!(origin.agent(Role::Review).skills, names(&["old"]));
        assert!(origin.agent(Role::Spec).skills.is_empty(), "the run still sees origin, not the unpushed file");
        let local = view.local.definition.expect("checkout parses");
        assert_eq!(local.agent(Role::Spec).skills, names(&["grilling"]));
        assert!(local.agent(Role::Review).source.is_none(), "review is built in again");
        assert_eq!(local.skills, names(&["house-style"]));
        let unpushed: Vec<(&str, FileState)> = view.unpushed.iter().map(|f| (f.path.as_str(), f.state)).collect();
        assert_eq!(
            unpushed,
            vec![
                (FACTORY_FILE, FileState::Changed),
                (".lotus/factory/agents/review.md", FileState::Removed),
                (".lotus/factory/agents/spec.md", FileState::Added),
            ]
        );
        assert_eq!(view.built_in_prompts.len(), 5);
    }

    #[test]
    fn the_view_says_the_base_came_from_the_file_and_warns_when_the_base_branch_disagrees() {
        let (_dir, checkout) = repo(&[(FACTORY_FILE, "gate = \"g\"\nbase = \"develop\"\n")]);
        let plain = read_view(&checkout, "main", None, &Default::default(), VIEW_FETCH_TIMEOUT);
        assert!(!plain.base_from_file, "a base the ticket names is not from the file");
        git(&checkout, &["checkout", "-b", "develop"]);
        std::fs::write(checkout.join(FACTORY_FILE), "gate = \"g\"\n").unwrap();
        git(&checkout, &["commit", "-am", "develop"]);
        git(&checkout, &["push", "origin", "develop"]);
        let view = read_view(&checkout, "", None, &Default::default(), VIEW_FETCH_TIMEOUT);
        assert_eq!(view.base.as_deref(), Some("develop"));
        assert!(view.base_from_file);
        assert_eq!(view.origin.definition.expect("origin/develop parses").base, None);
        assert_eq!(view.notes.len(), 1, "{:?}", view.notes);
        assert!(view.notes[0].contains("origin/develop has no base key"), "{}", view.notes[0]);
        assert!(view.notes[0].contains("from origin/main"), "{}", view.notes[0]);
    }

    #[test]
    fn a_private_factory_refuses_base_since_only_the_repo_file_sets_it() {
        let dir = tempfile::tempdir().unwrap();
        create_private(dir.path(), "npm test").unwrap();
        let file = dir.path().join(FACTORY_FILE);
        let text = std::fs::read_to_string(&file).unwrap();
        std::fs::write(&file, format!("{text}base = \"develop\"\n")).unwrap();
        let err = read_private_definition(dir.path()).unwrap_err();
        assert!(err.contains("base") && err.contains("private"), "{err}");
    }

    #[test]
    fn a_save_that_would_break_the_definition_writes_nothing() {
        let (_dir, checkout) = repo(&[(FACTORY_FILE, "gate = \"g\"\n")]);
        let err = save_agent(&checkout, Role::Triage, &AgentEdit { mcp: names(&["context7"]), ..Default::default() }).unwrap_err();
        assert!(err.contains("mcp is not allowed"), "{err}");
        assert!(!checkout.join(agent_path(Role::Triage)).exists());
        let err = save_agent(&checkout, Role::Spec, &AgentEdit { skills: names(&["has space"]), ..Default::default() }).unwrap_err();
        assert!(err.contains("not a valid name"), "{err}");
        assert!(!checkout.join(agent_path(Role::Spec)).exists());
        let before = std::fs::read_to_string(checkout.join(FACTORY_FILE)).unwrap();
        assert!(save_shared(&checkout, &names(&["bad\"name"]), &[]).is_err());
        assert_eq!(std::fs::read_to_string(checkout.join(FACTORY_FILE)).unwrap(), before);
    }

    #[test]
    fn a_checkout_without_a_factory_file_is_told_to_add_its_gate() {
        let (_dir, checkout) = repo(&[]);
        let view = read_view(&checkout, "main", None, &Default::default(), VIEW_FETCH_TIMEOUT);
        assert!(view.local.error.as_deref().is_some_and(|e| e.contains("gate")), "{:?}", view.local);
        assert!(view.origin.error.as_deref().is_some_and(|e| e.contains("gate")), "{:?}", view.origin);
        assert!(save_agent(&checkout, Role::Spec, &AgentEdit::default()).unwrap_err().contains("gate"));
    }

    #[test]
    fn a_repo_with_no_factory_gets_a_private_one_outside_it_that_is_never_in_the_repo() {
        let (dir, checkout) = repo(&[]);
        let private = dir.path().join("factory-private/acme/widgets");
        let view = read_view(&checkout, "main", Some(&private), &Default::default(), VIEW_FETCH_TIMEOUT);
        assert_eq!(view.private, Some(PrivateFactory { dir: private.display().to_string() }));
        assert!(view.local.error.as_deref().is_some_and(|e| e.contains("gate")), "not set up yet: {:?}", view.local);

        assert!(create_private(&private, "  ").is_err());
        let def = create_private(&private, "npm test -- --run \"unit\"").unwrap();
        assert_eq!(def.gate, "npm test -- --run \"unit\"");
        assert!(create_private(&private, "npm test").unwrap_err().contains("already"));
        save_agent(&private, Role::Spec, &AgentEdit { skills: names(&["grilling"]), ..Default::default() }).unwrap();
        let view = read_view(&checkout, "main", Some(&private), &Default::default(), VIEW_FETCH_TIMEOUT);
        let local = view.local.definition.expect("the private factory parses");
        assert_eq!(local.agent(Role::Spec).skills, names(&["grilling"]));
        assert!(view.unpushed.is_empty());
        assert!(!checkout.join(".lotus").exists(), "nothing is written in the repo");
    }

    #[test]
    fn a_repo_with_its_own_factory_at_origin_or_in_the_checkout_is_not_private() {
        let (dir, checkout) = repo(&[(FACTORY_FILE, "gate = \"g\"\n")]);
        let private = dir.path().join("factory-private/acme/widgets");
        assert_eq!(read_view(&checkout, "main", Some(&private), &Default::default(), VIEW_FETCH_TIMEOUT).private, None);
        let (dir, checkout) = repo(&[]);
        std::fs::create_dir_all(checkout.join(".lotus")).unwrap();
        std::fs::write(checkout.join(FACTORY_FILE), "gate = \"g\"\n").unwrap();
        let private = dir.path().join("factory-private/acme/widgets");
        let view = read_view(&checkout, "main", Some(&private), &Default::default(), VIEW_FETCH_TIMEOUT);
        assert_eq!(view.private, None, "being made in the checkout: the repo's own, not pushed yet");
        assert_eq!(view.unpushed.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_agents_folder_outside_the_checkout_is_refused() {
        let (dir, checkout) = repo(&[(FACTORY_FILE, "gate = \"g\"\n")]);
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(checkout.join(".lotus/factory")).unwrap();
        std::os::unix::fs::symlink(&outside, checkout.join(AGENTS_DIR)).unwrap();
        let err = save_agent(&checkout, Role::Spec, &AgentEdit::default()).unwrap_err();
        assert!(err.contains("outside"), "{err}");
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
    }
}
