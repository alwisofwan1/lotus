//! Moving off ccs (PLAN step 9, issues/08): ccs's shared context is merged into `~/.claude` and each
//! instance's links are re-pointed there. Instances are never moved: the keychain item is named after the path.

use crate::account_context::{link, merge_dir, merge_file, DIRS, FILES};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Merge {
    pub from: PathBuf,
    pub to: PathBuf,
    /// Files present on both sides: the older one ends up as `<name>.lotus-recovered`.
    pub collisions: usize,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Relink {
    pub link: PathBuf,
    /// `None`: nothing outside `~/.ccs` to point at, so it is left as it is.
    pub to: Option<PathBuf>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub backup: PathBuf,
    pub merges: Vec<Merge>,
    pub relinks: Vec<Relink>,
    /// ccs's default, adopted only when Lotus has no chosen account (G6).
    pub default_account: Option<String>,
    /// ccs's own MCP servers; removed only by `remove_mcp_entries`, on the operator's confirm.
    pub mcp_entries: Vec<McpEntry>,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub file: PathBuf,
    pub name: String,
}

/// This machine's plan, or `None` when there is no `~/.ccs` to move off.
pub fn plan() -> Option<Plan> {
    let home = crate::paths::home_dir();
    home.join(".ccs").is_dir().then(|| plan_in(&home, &crate::paths::lotus_state_dir(), &today()))
}

pub fn run() -> io::Result<Plan> {
    run_in(&crate::paths::home_dir(), &crate::paths::lotus_state_dir(), &today())
}

pub fn remove_mcp() -> io::Result<Vec<McpEntry>> {
    remove_mcp_entries(&crate::paths::home_dir())
}

/// `YYYY-MM-DD` from `date`; the epoch seconds where there is none — it only names the backup.
fn today() -> String {
    std::process::Command::new("date")
        .arg("+%Y-%m-%d")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|d| d.trim().to_string())
        .filter(|d| d.len() == 10)
        .unwrap_or_else(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs().to_string())
}

/// What `run_in` would do; writes nothing.
pub fn plan_in(home: &Path, state_dir: &Path, date: &str) -> Plan {
    let ccs = home.join(".ccs");
    let merges = merge_pairs(home)
        .into_iter()
        .map(|(from, to)| Merge { collisions: collisions(&from, &to), from, to })
        .collect();
    let relinks = instances(&ccs)
        .iter()
        .flat_map(|dir| ccs_links(&ccs, dir))
        .map(|(link, name)| Relink { to: relink_target(home, &ccs, &link, &name), link })
        .collect();
    let default_account = if state_dir.join("claude-account.json").exists() {
        None
    } else {
        ccs_default(&ccs).filter(|name| ccs.join("instances").join(name).join(".claude.json").is_file())
    };
    Plan { backup: backup_path(state_dir, date), merges, relinks, default_account, mcp_entries: mcp_entries(home) }
}

/// Backs `~/.ccs` up, then merges and re-points as planned. Stops at the first error; every step is
/// a move or a link, so a second run picks up where the first stopped.
pub fn run_in(home: &Path, state_dir: &Path, date: &str) -> io::Result<Plan> {
    let plan = plan_in(home, state_dir, date);
    backup(home, &plan.backup)?;
    for m in &plan.merges {
        if fs::symlink_metadata(&m.from)?.is_dir() {
            merge_dir(&m.from, &m.to)?;
        } else {
            merge_file(&m.from, &m.to)?;
        }
    }
    union_memory_indexes(&home.join(".claude/projects"))?;
    for r in &plan.relinks {
        let Some(to) = &r.to else { continue };
        let is_dir = DIRS.iter().any(|d| r.link.ends_with(d)) || to.is_dir();
        if is_dir {
            fs::create_dir_all(to)?;
        }
        fs::remove_file(&r.link)?;
        link(to, &r.link, is_dir)?;
    }
    if let Some(id) = &plan.default_account {
        crate::json::write_json(&state_dir.join("claude-account.json"), &serde_json::json!({ "account": id }))
            .map_err(|e| io::Error::other(e.to_string()))?;
    }
    Ok(plan)
}

fn claude_configs(home: &Path) -> Vec<PathBuf> {
    let mut out = vec![home.join(".claude.json")];
    out.extend(instances(&home.join(".ccs")).into_iter().map(|d| d.join(".claude.json")));
    out.retain(|f| f.is_file());
    out
}

fn ccs_servers(config: &serde_json::Value) -> Vec<String> {
    config["mcpServers"].as_object().into_iter().flat_map(|m| m.keys()).filter(|k| k.starts_with("ccs-")).cloned().collect()
}

fn mcp_entries(home: &Path) -> Vec<McpEntry> {
    claude_configs(home)
        .into_iter()
        .flat_map(|file| {
            let config: serde_json::Value = crate::json::read_json(&file).unwrap_or_default();
            ccs_servers(&config).into_iter().map(move |name| McpEntry { file: file.clone(), name })
        })
        .collect()
}

/// Drops every `ccs-*` MCP server from `~/.claude.json` and each instance's; other keys are kept.
pub fn remove_mcp_entries(home: &Path) -> io::Result<Vec<McpEntry>> {
    let removed = mcp_entries(home);
    for file in claude_configs(home) {
        let mut config: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file)?)?;
        let names = ccs_servers(&config);
        if names.is_empty() {
            continue;
        }
        if let Some(servers) = config["mcpServers"].as_object_mut() {
            names.iter().for_each(|n| drop(servers.remove(n)));
        }
        // Claude rewrites this file too: keep the original beside it, and swap the new one in whole.
        fs::copy(&file, sibling(&file, ".before-ccs-mcp-removal"))?;
        let tmp = sibling(&file, ".lotus-tmp");
        fs::write(&tmp, serde_json::to_string_pretty(&config)?)?;
        fs::rename(&tmp, &file)?;
    }
    Ok(removed)
}

fn sibling(file: &Path, suffix: &str) -> PathBuf {
    let mut name = file.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    file.with_file_name(name)
}

/// Never the name of an earlier backup: a second run must not overwrite the one taken before the first.
fn backup_path(state_dir: &Path, date: &str) -> PathBuf {
    let dir = state_dir.join("backups");
    (1..).map(|n| dir.join(if n == 1 { format!("ccs-{date}.tar.gz") } else { format!("ccs-{date}-{n}.tar.gz") })).find(|p| !p.exists()).unwrap_or_default()
}

/// Only what the migration changes: `shared/` (merged out of), `config.yaml`, and each instance's top-level
/// links (re-pointed). An instance's own data is never touched, and on the VPS it is 11 GB of `jobs/`.
fn backup(home: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to.parent().unwrap_or(home))?;
    let ccs = home.join(".ccs");
    let mut paths: Vec<PathBuf> = [ccs.join("shared"), ccs.join("config.yaml")].into_iter().filter(|p| p.exists()).collect();
    for dir in instances(&ccs) {
        paths.extend(children(&dir).into_iter().filter(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink())));
    }
    let relative = paths.iter().filter_map(|p| p.strip_prefix(home).ok());
    // No `-h`: links are stored as links, so the archive is ccs's own data, not what it points at.
    let out = std::process::Command::new("tar").arg("-czf").arg(to).arg("-C").arg(home).args(relative).output()?;
    if out.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("backup failed: {}", String::from_utf8_lossy(&out.stderr))))
    }
}

/// Real (not linked) context ccs holds, and where it belongs under `~/.claude`.
fn merge_pairs(home: &Path) -> Vec<(PathBuf, PathBuf)> {
    let (shared, claude) = (home.join(".ccs/shared"), home.join(".claude"));
    let mut out = Vec::new();
    for group in children(&shared.join("context-groups")) {
        out.push((group.join("projects"), claude.join("projects")));
        for entry in children(&group.join("continuity")) {
            let name = entry.file_name().unwrap_or_default().to_owned();
            out.push((entry, claude.join(name)));
        }
    }
    for slug in children(&shared.join("memory")) {
        let name = slug.file_name().unwrap_or_default().to_owned();
        out.push((slug, claude.join("projects").join(name).join("memory")));
    }
    for name in DIRS.iter().chain(FILES.iter()) {
        out.push((shared.join(name), claude.join(name)));
    }
    out.retain(|(from, _)| fs::symlink_metadata(from).is_ok_and(|m| !m.file_type().is_symlink()));
    out
}

/// Two `MEMORY.md` indexes for one project: newer-wins would orphan the memories only the other lists,
/// so the loser's missing lines are appended to the winner instead of being kept aside.
fn union_memory_indexes(projects: &Path) -> io::Result<()> {
    for project in children(projects) {
        let (index, loser) = (project.join("memory/MEMORY.md"), project.join("memory/MEMORY.md.lotus-recovered"));
        let (Ok(mut text), Ok(other)) = (fs::read_to_string(&index), fs::read_to_string(&loser)) else { continue };
        let missing: Vec<&str> = other.lines().filter(|l| !l.trim().is_empty() && !text.lines().any(|t| t == *l)).collect();
        if !missing.is_empty() {
            if !text.ends_with('\n') {
                text.push('\n');
            }
            missing.iter().for_each(|l| text.push_str(&format!("{l}\n")));
            fs::write(&index, text)?;
        }
        fs::remove_file(&loser)?;
    }
    Ok(())
}

/// Entries of `dir`, without Finder's `.DS_Store`-style dotfiles.
fn children(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name() != ".DS_Store")
        .map(|e| e.path())
        .collect();
    out.sort();
    out
}

fn instances(ccs: &Path) -> Vec<PathBuf> {
    children(&ccs.join("instances")).into_iter().filter(|p| p.is_dir()).collect()
}

/// Links in `dir` whose own target is under `~/.ccs`, with their entry name.
fn ccs_links(ccs: &Path, dir: &Path) -> Vec<(PathBuf, String)> {
    children(dir)
        .into_iter()
        .filter_map(|path| {
            let raw = fs::read_link(&path).ok()?;
            let target = if raw.is_absolute() { raw } else { dir.join(raw) };
            let name = path.file_name()?.to_string_lossy().into_owned();
            target.starts_with(ccs).then_some((path, name))
        })
        .collect()
}

/// A step 8 entry goes to `~/.claude/<entry>`; any other goes to where its chain ends, if outside `~/.ccs`.
fn relink_target(home: &Path, ccs: &Path, link: &Path, name: &str) -> Option<PathBuf> {
    if DIRS.contains(&name) || FILES.contains(&name) {
        return Some(home.join(".claude").join(name));
    }
    let end = fs::canonicalize(link).ok()?;
    let ccs = fs::canonicalize(ccs).ok()?;
    (!end.starts_with(ccs)).then_some(end)
}

fn collisions(from: &Path, to: &Path) -> usize {
    if !from.is_dir() {
        return usize::from(to.exists());
    }
    children(from).iter().map(|entry| collisions(entry, &to.join(entry.file_name().unwrap_or_default()))).sum()
}

/// `default: "<name>"` from `config.yaml`; a line read, not a YAML parse, since that is all it needs.
fn ccs_default(ccs: &Path) -> Option<String> {
    let text = fs::read_to_string(ccs.join("config.yaml")).ok()?;
    let line = text.lines().find(|l| l.starts_with("default:"))?;
    let value = line["default:".len()..].trim().trim_matches(|c| c == '"' || c == '\'');
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    /// ccs's real layout in miniature: instance → shared → context group, and shared → `~/.claude`.
    fn ccs_home() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let (ccs, claude) = (home.join(".ccs"), home.join(".claude"));
        let group = ccs.join("shared/context-groups/default");
        let inst = ccs.join("instances/work");
        for d in [claude.join("projects/p"), claude.join("plugins"), group.join("projects/p/memory"), group.join("continuity/todos"), inst.clone()] {
            fs::create_dir_all(d).unwrap();
        }
        fs::write(claude.join("settings.json"), "{}").unwrap();
        fs::write(claude.join("projects/p/a.jsonl"), "mine").unwrap();
        fs::write(group.join("projects/p/a.jsonl"), "theirs").unwrap();
        fs::write(group.join("projects/p/memory/MEMORY.md"), "- [A](a.md)\n- [B](b.md)\n").unwrap();
        fs::create_dir_all(claude.join("projects/p/memory")).unwrap();
        fs::write(claude.join("projects/p/memory/MEMORY.md"), "- [A](a.md)\n- [C](c.md)").unwrap();
        fs::write(group.join("continuity/.DS_Store"), "").unwrap();
        fs::write(group.join("continuity/todos/t.json"), "[]").unwrap();
        fs::create_dir_all(ccs.join("shared/memory/q")).unwrap();
        fs::write(ccs.join("shared/memory/q/m.md"), "q").unwrap();
        symlink(claude.join("settings.json"), ccs.join("shared/settings.json")).unwrap();
        symlink(claude.join("plugins"), ccs.join("shared/plugins")).unwrap();
        symlink(ccs.join("shared/settings.json"), inst.join("settings.json")).unwrap();
        symlink(ccs.join("shared/plugins"), inst.join("plugins")).unwrap();
        symlink(group.join("projects"), inst.join("projects")).unwrap();
        symlink(group.join("continuity/todos"), inst.join("todos")).unwrap();
        symlink(ccs.join("shared/nowhere"), inst.join("odd")).unwrap();
        fs::write(inst.join(".claude.json"), r#"{"mcpServers":{"ccs-websearch":{},"mine":{}},"userID":"u"}"#).unwrap();
        fs::write(ccs.join("config.yaml"), "version: 8\ndefault: \"work\"\naccounts:\n").unwrap();
        (tmp, home, claude)
    }

    #[test]
    fn the_plan_lists_merges_relinks_and_the_default_and_writes_nothing() {
        let (_tmp, home, claude) = ccs_home();
        let state = home.join("state");
        let plan = plan_in(&home, &state, "2026-11-13");
        let projects = plan.merges.iter().find(|m| m.to == claude.join("projects")).unwrap();
        assert_eq!(projects.collisions, 2);
        assert!(plan.merges.iter().any(|m| m.to == claude.join("projects/q/memory")));
        let inst = home.join(".ccs/instances/work");
        let to = |n: &str| plan.relinks.iter().find(|r| r.link == inst.join(n)).unwrap().to.clone();
        assert_eq!(to("projects"), Some(claude.join("projects")));
        assert_eq!(to("plugins"), Some(fs::canonicalize(claude.join("plugins")).unwrap()));
        assert_eq!(to("odd"), None);
        assert_eq!(plan.default_account.as_deref(), Some("work"));
        assert!(!state.exists());
        assert_eq!(fs::read_link(inst.join("projects")).unwrap(), home.join(".ccs/shared/context-groups/default/projects"));
    }

    #[test]
    fn run_merges_into_claude_repoints_the_instance_and_adopts_the_default() {
        let (_tmp, home, claude) = ccs_home();
        let state = home.join("state");
        run_in(&home, &state, "2026-11-13").unwrap();
        let inst = home.join(".ccs/instances/work");

        let listed = std::process::Command::new("tar").arg("-tzf").arg(state.join("backups/ccs-2026-11-13.tar.gz")).output().unwrap();
        let listed = String::from_utf8(listed.stdout).unwrap();
        for entry in [".ccs/config.yaml", ".ccs/instances/work/projects", ".ccs/shared/context-groups/default/projects/p/a.jsonl"] {
            assert!(listed.lines().any(|l| l == entry), "{entry} not in backup:\n{listed}");
        }
        assert!(!listed.contains(".claude.json"), "an instance's own files are not ccs's to back up");
        let a = fs::read_to_string(claude.join("projects/p/a.jsonl")).unwrap();
        let other = fs::read_to_string(claude.join("projects/p/a.jsonl.lotus-recovered")).unwrap();
        assert_eq!([a.as_str(), other.as_str()].iter().filter(|s| ["mine", "theirs"].contains(s)).count(), 2);
        let index = fs::read_to_string(claude.join("projects/p/memory/MEMORY.md")).unwrap();
        for entry in ["- [A](a.md)", "- [B](b.md)", "- [C](c.md)"] {
            assert_eq!(index.lines().filter(|l| *l == entry).count(), 1, "{entry} in {index}");
        }
        assert!(!claude.join("projects/p/memory/MEMORY.md.lotus-recovered").exists());
        assert!(!claude.join(".DS_Store").exists());
        assert_eq!(fs::read_to_string(claude.join("projects/q/memory/m.md")).unwrap(), "q");
        assert_eq!(fs::read_to_string(claude.join("todos/t.json")).unwrap(), "[]");

        assert_eq!(fs::read_link(inst.join("projects")).unwrap(), claude.join("projects"));
        assert_eq!(fs::read_link(inst.join("todos")).unwrap(), claude.join("todos"));
        assert_eq!(fs::read_link(inst.join("settings.json")).unwrap(), claude.join("settings.json"));
        assert_eq!(fs::read_link(inst.join("plugins")).unwrap(), fs::canonicalize(claude.join("plugins")).unwrap());
        assert_eq!(fs::read_link(inst.join("odd")).unwrap(), home.join(".ccs/shared/nowhere"));
        assert!(inst.join(".claude.json").is_file());
        assert!(fs::read_to_string(state.join("claude-account.json")).unwrap().contains("\"work\""));

        // Run again: nothing left to merge or re-point, and no error.
        let again = run_in(&home, &state, "2026-11-13").unwrap();
        assert!(again.relinks.iter().all(|r| r.to.is_none()));
        assert_eq!(again.default_account, None);
        assert!(state.join("backups/ccs-2026-11-13-2.tar.gz").is_file());
    }

    #[test]
    fn ccs_mcp_servers_are_listed_then_removed_and_nothing_else_is() {
        let (_tmp, home, _) = ccs_home();
        let file = home.join(".ccs/instances/work/.claude.json");
        let listed = plan_in(&home, &home.join("state"), "d").mcp_entries;
        assert_eq!(listed, vec![McpEntry { file: file.clone(), name: "ccs-websearch".into() }]);
        assert_eq!(remove_mcp_entries(&home).unwrap(), listed);
        let config: serde_json::Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(config["mcpServers"], serde_json::json!({ "mine": {} }));
        assert_eq!(config["userID"], "u");
        let before = fs::read_to_string(home.join(".ccs/instances/work/.claude.json.before-ccs-mcp-removal")).unwrap();
        assert!(before.contains("ccs-websearch"));
    }

    #[test]
    fn a_chosen_account_or_a_missing_instance_keeps_the_default_alone() {
        let (_tmp, home, _) = ccs_home();
        let state = home.join("state");
        fs::write(home.join(".ccs/config.yaml"), "default: gone\n").unwrap();
        assert_eq!(plan_in(&home, &state, "d").default_account, None);
        fs::write(home.join(".ccs/config.yaml"), "default: work\n").unwrap();
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("claude-account.json"), "{\"account\":\"default\"}").unwrap();
        assert_eq!(plan_in(&home, &state, "d").default_account, None);
    }

    /// Runs the migration on `LOTUS_CCS_HOME` with state in `LOTUS_CCS_STATE` (default `<home>/state`): the dry
    /// run on a clone, and the operator's one-off live run before the Settings button ships (issues/08).
    #[test]
    #[ignore]
    fn migrate_a_home() {
        let home = PathBuf::from(std::env::var("LOTUS_CCS_HOME").unwrap());
        let state = std::env::var("LOTUS_CCS_STATE").map(PathBuf::from).unwrap_or_else(|_| home.join("state"));
        let plan = run_in(&home, &state, &today()).unwrap();
        fs::write(state.join("ccs-migration-plan.json"), serde_json::to_string_pretty(&plan).unwrap()).unwrap();
    }

    /// Removes the `ccs-*` MCP servers under `LOTUS_CCS_HOME`: the operator's one-off run (issues/08).
    #[test]
    #[ignore]
    fn remove_mcp_of_a_home() {
        let home = PathBuf::from(std::env::var("LOTUS_CCS_HOME").unwrap());
        println!("{:?}", remove_mcp_entries(&home).unwrap());
    }
}
