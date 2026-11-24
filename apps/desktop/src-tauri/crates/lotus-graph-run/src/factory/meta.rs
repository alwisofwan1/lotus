//! Meta-repo routing (ADR-0063): a Workspace folder of git sub-repos, the rules it gives them, and
//! where a routed run's sub-repo, GitHub repo and base come from. Everything here is read with
//! git at origin's default branch, never from a worktree.

use crate::no_window::NoWindow;
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;

use super::runner::{default_branch, definition_at, fetch_base, origin_ref, resolve_base, show_at, FETCH_TIMEOUT};
use super::{FactoryDefinition, ParentRules, GATE_FILE};
use crate::FactoryTicket;

/// Origin's default branch of `repo`, fetched first: what a meta-repo's own files are read from.
pub(super) fn meta_default_base(repo: &Path, env: &HashMap<String, String>) -> Result<String, String> {
    fetch_base(repo, "", env, FETCH_TIMEOUT)?;
    default_branch(repo, env)
}

/// [`meta_default_base`] as a ref: `origin/<default>`.
pub(super) fn fetch_default_ref(repo: &Path, env: &HashMap<String, String>) -> Result<String, String> {
    Ok(origin_ref(&meta_default_base(repo, env)?))
}

/// The rules of the meta-repo at `meta_repo` for its sub-repo `sub_repo` (FM6): the file
/// `[repos.<sub_repo>].rules` names in the meta-repo's `.lotus/factory.toml`, else its `CLAUDE.md`.
/// Read with `git show` at origin's default branch (fetched first), never from the filesystem, so
/// an agent cannot rewrite the rules it is given and nothing is written to any worktree.
/// `Ok(None)` when there is no `[repos]` entry and no `CLAUDE.md`; `Err(why)` when the fetch
/// fails, the factory file is broken, or the file the entry names is not there.
/// Feed the result to [`FactoryDefinition::with_parent_rules`].
pub fn parent_rules(meta_repo: &Path, sub_repo: &str, env: &HashMap<String, String>) -> Result<Option<ParentRules>, String> {
    let from = fetch_default_ref(meta_repo, env)?;
    parent_rules_at(meta_repo, &from, sub_repo, env)
}

/// [`parent_rules`] at `from` (`origin/<default>`), with no fetch.
fn parent_rules_at(meta_repo: &Path, from: &str, sub_repo: &str, env: &HashMap<String, String>) -> Result<Option<ParentRules>, String> {
    // A meta-repo with no factory file just has no `[repos]` entries; a broken one is an error.
    let named = match definition_at(meta_repo, from, env) {
        Ok(def) => def.rules_path_for(sub_repo).map(str::to_string),
        Err(why) if why.starts_with(&format!("{GATE_FILE} not found")) => None,
        Err(why) => return Err(why),
    };
    let from = from.to_string();
    match named {
        Some(path) => match show_at(meta_repo, &from, &path, env) {
            Some(text) => Ok(Some(ParentRules { source: path, text })),
            None => Err(format!("[repos.{sub_repo}].rules names {path}, which is not at {from}")),
        },
        None => Ok(show_at(meta_repo, &from, "CLAUDE.md", env).map(|text| ParentRules { source: "CLAUDE.md".to_string(), text })),
    }
}

/// The sub-repos of a Workspace (AC-2): the git folders one level down, by name, sorted; no
/// dot-folders and no `node_modules`.
pub fn sub_repos(workspace: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(workspace) else { return Vec::new() };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir() && e.path().join(".git").exists())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !n.starts_with('.') && n != "node_modules")
        .collect();
    names.sort();
    names
}

/// `owner/name` of a GitHub remote URL (`https://github.com/o/r.git`, `git@github.com:o/r`).
pub fn parse_github_repo(url: &str) -> Option<String> {
    let rest = url.trim().split_once("github.com").map(|(_, rest)| rest)?;
    let path = rest.trim_start_matches([':', '/']).trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/')).then(|| format!("{owner}/{name}"))
}

/// The GitHub repo `origin` of `checkout` points at.
pub(super) fn github_repo_of(checkout: &Path, env: &HashMap<String, String>) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .no_window()
        .arg("-C")
        .arg(checkout)
        // The URL as written in the config: `remote get-url` would show it after `insteadOf` rewrites.
        .args(["config", "--get", "remote.origin.url"])
        .envs(env)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("cannot run git: {e}"))?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() {
        return Err(format!("{} has no origin remote", checkout.display()));
    }
    parse_github_repo(&url).ok_or_else(|| format!("origin of {} is not a GitHub repo: {url}", checkout.display()))
}

/// The sub-repo folder name of a meta-repo run once triage routed it; `None` for a plain repo and
/// for a run not routed yet.
pub(super) fn routed_sub(ticket: &FactoryTicket) -> Option<String> {
    let workspace = ticket.workspace.as_deref()?;
    if ticket.checkout == workspace {
        return None;
    }
    ticket.checkout.file_name()?.to_str().map(str::to_string)
}

/// The rules triage gets, before a sub-repo is chosen (FM6 handoff): each candidate's rules, one
/// copy of each source, named by the sub-repos it is for. `None` when no candidate has any.
fn triage_rules(meta_repo: &Path, from: &str, subs: &[String], env: &HashMap<String, String>) -> Result<Option<ParentRules>, String> {
    let mut found: Vec<(ParentRules, Vec<&str>)> = Vec::new();
    for sub in subs {
        let Some(rules) = parent_rules_at(meta_repo, from, sub, env)? else { continue };
        match found.iter_mut().find(|(r, _)| r.source == rules.source) {
            Some((_, names)) => names.push(sub),
            None => found.push((rules, vec![sub])),
        }
    }
    Ok(match found.len() {
        0 => None,
        1 => found.pop().map(|(rules, _)| rules),
        _ => Some(ParentRules {
            source: found.iter().map(|(r, _)| r.source.as_str()).collect::<Vec<_>>().join(", "),
            text: found
                .iter()
                .map(|(r, names)| format!("### `{}` (for {})\n\n{}", r.source, names.join(", "), r.text.trim()))
                .collect::<Vec<_>>()
                .join("\n\n"),
        }),
    })
}

/// A meta-repo run's [`FactoryDefinition`] (FM8): the meta-repo's own `.lotus/factory.toml` at
/// origin's default branch (fetched first), with the parent rules in every role's prompt: the
/// chosen `sub`'s once triage routed the run, else every candidate's (triage runs first).
/// Replaces FM6's guess from the checkout's parent folder: the Workspace is now explicit.
pub fn read_meta_definition(workspace: &Path, sub: Option<&str>, env: &HashMap<String, String>) -> Result<FactoryDefinition, String> {
    let from = fetch_default_ref(workspace, env)?;
    let definition = definition_at(workspace, &from, env)?;
    let rules = match sub {
        Some(sub) => parent_rules_at(workspace, &from, sub, env),
        None => triage_rules(workspace, &from, &sub_repos(workspace), env),
    }
    .map_err(|why| format!("the parent meta-repo's rules: {why}"))?;
    Ok(definition.with_parent_rules(rules.as_ref()))
}

/// The base of sub-repo `sub` of a meta-repo: `[repos.<sub>].base`, else `[workflow].base`, from
/// the meta-repo's factory file at origin's default branch; else the sub-repo's own base rules.
/// The sub-repo's `origin/<base>` is fetched.
pub(super) fn meta_sub_base(workspace: &Path, sub: &str, env: &HashMap<String, String>) -> Result<String, String> {
    let from = fetch_default_ref(workspace, env)?;
    let wanted = definition_at(workspace, &from, env)?.workflow_for(Some(sub)).base.unwrap_or_default();
    resolve_base(&workspace.join(sub), &wanted, env)
}
