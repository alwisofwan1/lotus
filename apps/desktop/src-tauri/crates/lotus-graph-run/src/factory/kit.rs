//! The skills and MCP servers a Factory agent gets (FI4, ADR-0051 §5).
//!
//! The [`Catalog`] is what this Mac has: skills in the repo (`.lotus/factory/skills`,
//! `.agents/skills`, read at `origin/<base>` like the rest of the definition; a sub-repo also gets
//! its meta-repo's `.agents/skills` at the meta-repo's `origin/<default>`), in `~/.claude/skills`,
//! and in installed plugins (`<plugin>:<skill>`, manifest paths included); MCP servers in
//! `~/.claude.json`, the repo's `.mcp.json` at `origin/<base>`, and plugin files/manifests.
//! A nonempty `CLAUDE_CONFIG_DIR` selects that profile's skills/plugins and `.claude.json`.
//! Plugin scope, explicit disablement and marketplace collisions are resolved before discovery.
//!
//! For one agent turn, [`materialize`] writes a folder holding exactly what its role names:
//! - `mcp.json`, owner-only, for `--mcp-config` with `--strict-mcp-config`: no other server starts.
//! - `plugin/`, for `--plugin-dir`: the chosen skills copied into one plugin, [`KIT_PLUGIN`]. The CLI
//!   names each `lotus-factory:<folder>`. Verified live on 2.1.294 (2026-10-08): the folder name,
//!   not the SKILL.md `name:`, is the skill's name; strict MCP drops plugin and user servers in full
//!   and read-only runs alike; a chosen server connects inside the read-only fence.
//!
//! Server definitions can hold keys (env, headers, args): they reach only that file, never a log,
//! the UI or a run record. The catalog shows a server's name, scope, transport and host or program.

use crate::no_window::NoWindow;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use serde_json::Value;

use super::{FactoryDefinition, Role};

#[path = "kit_plugins.rs"]
mod plugins;

/// The plugin a run's chosen skills are copied into.
pub const KIT_PLUGIN: &str = "lotus-factory";
/// Repo skill folders, the first wins a name clash.
pub const REPO_SKILL_DIRS: [&str; 2] = [".lotus/factory/skills", ".agents/skills"];
/// The repo's MCP servers.
pub const PROJECT_MCP_FILE: &str = ".mcp.json";
/// The meta-repo's skill folder.
const META_SKILL_DIR: &str = ".agents/skills";
/// The most one skill may hold: a skill is instructions and a few scripts, not a repo.
const MAX_SKILL_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SKILL_FILES: usize = 300;

/// Where the user's own skills and servers are. `None` = that place is not read (tests).
#[derive(Debug, Clone, Default)]
pub struct KitSources {
    /// Default Claude directory: its `skills/` and `plugins/installed_plugins.json`.
    /// Overridden by the agent environment's nonempty `CLAUDE_CONFIG_DIR`.
    pub claude_dir: Option<PathBuf>,
    /// `~/.claude.json`: user MCP servers, and each project's local ones.
    pub claude_json: Option<PathBuf>,
    /// `<Lotus state dir>/factory-private`: the factories Lotus keeps on this Mac for repos that
    /// have none of their own (#169), one folder per repo, laid out like a repo (`.lotus/…`).
    pub private_root: Option<PathBuf>,
}

impl KitSources {
    /// `<private_root>/<owner>/<name>` for the repo `owner/name`: where Lotus keeps its private
    /// factory. `None` with no root, or a name that is not a plain `owner/name`.
    pub fn private_dir(&self, repo: &str) -> Option<PathBuf> {
        let (owner, name) = repo.trim().split_once('/')?;
        let plain = |part: &str| {
            !part.is_empty() && part != "." && part != ".." && part.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        };
        (plain(owner) && plain(name)).then(|| self.private_root.as_ref().map(|root| root.join(owner).join(name)))?
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillSource {
    /// `.lotus/factory/skills` at `origin/<base>`.
    Factory,
    /// `.agents/skills` at `origin/<base>`.
    Repo,
    /// `.agents/skills` of the meta-repo that holds the checkout, at its `origin/<default>`.
    Meta,
    /// `~/.claude/skills`.
    User,
    /// An installed plugin; the id is `<plugin>:<skill>`.
    Plugin,
}

#[derive(Debug, Clone, PartialEq)]
enum SkillFrom {
    Dir(PathBuf),
    /// Plugin resource symlinks must remain within this installation.
    PluginDir { dir: PathBuf, root: PathBuf },
    /// A folder at a git ref of the checkout.
    AtRef { reference: String, path: String },
    /// A folder at a git ref of another repo (the meta-repo above the checkout).
    AtRefIn { root: PathBuf, reference: String, path: String },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillEntry {
    /// What a definition names: `grilling`, `mattpocock-skills:tdd`.
    pub id: String,
    pub source: SkillSource,
    /// Exact validated registry identity, even when the skill ID uses a short plugin name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// The SKILL.md `description:`, when it has one.
    pub description: Option<String>,
    #[serde(skip)]
    from: SkillFrom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpScope {
    /// `~/.claude.json`, under this checkout's project.
    Local,
    /// The repo's `.mcp.json` at `origin/<base>`.
    Project,
    /// `~/.claude.json`, for every project.
    User,
    /// An installed plugin, under an isolated `plugin-<id>--<server>` name.
    Plugin,
}

#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEntry {
    pub name: String,
    pub scope: McpScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    /// `stdio`, `http` or `sse`.
    pub transport: String,
    /// The program's file name (`npx`) or the URL's host: never its args, env or headers.
    pub target: String,
    #[serde(skip)]
    config: Value,
}

/// Never prints the server's definition: it may hold a key.
impl std::fmt::Debug for McpEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpEntry").field("name", &self.name).field("scope", &self.scope).field("target", &self.target).finish_non_exhaustive()
    }
}

/// What this Mac has for a repo, each name once (the first source wins).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub skills: Vec<SkillEntry>,
    pub mcp: Vec<McpEntry>,
    /// Actionable partial-discovery warnings; the rest still lists.
    pub notes: Vec<String>,
    /// Intentional disablement and capability boundaries, not discovery failures.
    pub notices: Vec<String>,
}

/// Reads the catalog for `checkout`. `at` is the git ref the repo's own skills and `.mcp.json` are
/// read from (`origin/<base>`); `None` reads only the user's.
pub fn read_catalog(sources: &KitSources, checkout: &Path, at: Option<&str>, env: &HashMap<String, String>) -> Catalog {
    read_catalog_with(sources, checkout, at, None, None, env)
}

/// [`read_catalog`], with the skills of Lotus's private factory for the repo (`private`, #169)
/// listed as [`SkillSource::Factory`], after the repo's own: they stand in for its
/// `.lotus/factory/skills` when the repo has no factory.
pub fn read_catalog_with(
    sources: &KitSources,
    checkout: &Path,
    at: Option<&str>,
    private: Option<&Path>,
    meta: Option<&Path>,
    env: &HashMap<String, String>,
) -> Catalog {
    // Match Claude's config root for the same environment the agent runner inherits. Do not
    // silently mix the default home with a chosen profile, even when it is not installed yet.
    let mut effective = sources.clone();
    if let Some(dir) = env.get("CLAUDE_CONFIG_DIR").filter(|dir| !dir.trim().is_empty()) {
        let dir = PathBuf::from(dir);
        effective.claude_json = Some(dir.join(".claude.json"));
        effective.claude_dir = Some(dir);
    }
    let sources = &effective;
    let mut catalog = Catalog::default();
    if sources.claude_dir.as_ref().is_some_and(|dir| !dir.is_dir()) {
        catalog.notes.push("Claude config directory is unavailable; check the agent profile and refresh integrations".into());
    }
    if let Some(at) = at {
        for (dir, source) in REPO_SKILL_DIRS.into_iter().zip([SkillSource::Factory, SkillSource::Repo]) {
            for (name, path) in git_subdirs(checkout, at, dir, env) {
                let text = git_show(checkout, &format!("{at}:{path}/SKILL.md"), env)
                    .or_else(|| git_show(checkout, &format!("{at}:{path}/skill.md"), env));
                let Some(text) = text else { continue };
                push_skill(&mut catalog, name, source, &text, SkillFrom::AtRef { reference: at.to_string(), path });
            }
        }
    }
    // The meta-repo's skills come after the repo's own, so a sub-repo's skill wins a name clash.
    if let Some((root, at)) = meta.and_then(|root| Some((root.to_path_buf(), format!("origin/{}", super::runner::origin_head(root, env)?)))) {
        for (name, path) in git_subdirs(&root, &at, META_SKILL_DIR, env) {
            let text = git_show(&root, &format!("{at}:{path}/SKILL.md"), env).or_else(|| git_show(&root, &format!("{at}:{path}/skill.md"), env));
            let Some(text) = text else { continue };
            push_skill(&mut catalog, name, SkillSource::Meta, &text, SkillFrom::AtRefIn { root: root.clone(), reference: at.clone(), path });
        }
    }
    if let Some(private) = private {
        for (name, dir) in skill_dirs(&private.join(REPO_SKILL_DIRS[0])) {
            if let Some(text) = skill_text(&dir) {
                push_skill(&mut catalog, name, SkillSource::Factory, &text, SkillFrom::Dir(dir));
            }
        }
    }
    if let Some(claude) = &sources.claude_dir {
        for (name, dir) in skill_dirs(&claude.join("skills")) {
            if let Some(text) = skill_text(&dir) {
                push_skill(&mut catalog, name, SkillSource::User, &text, SkillFrom::Dir(dir));
            }
        }
    }

    let claude_json = sources.claude_json.as_ref().and_then(|path| match std::fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(json) => Some(json),
            Err(_) => {
                catalog.notes.push("Claude MCP configuration: invalid JSON; repair it and refresh integrations".into());
                None
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => {
            catalog.notes.push("Claude MCP configuration is unreadable".into());
            None
        }
    });
    if let Some(json) = &claude_json {
        push_servers(&mut catalog, local_servers(json, checkout), McpScope::Local);
    }
    if let Some(text) = at.and_then(|at| git_show(checkout, &format!("{at}:{PROJECT_MCP_FILE}"), env)) {
        match serde_json::from_str::<Value>(&text) {
            Ok(json) => push_servers(&mut catalog, json.get("mcpServers"), McpScope::Project),
            Err(_) => catalog.notes.push(format!("{PROJECT_MCP_FILE}: invalid JSON; repair it and refresh integrations")),
        }
    }
    if let Some(json) = &claude_json {
        push_servers(&mut catalog, json.get("mcpServers"), McpScope::User);
    }
    if let Some(claude) = &sources.claude_dir {
        plugins::discover(&mut catalog, claude, checkout);
    }
    catalog
}

fn push_skill(catalog: &mut Catalog, id: String, source: SkillSource, text: &str, from: SkillFrom) {
    if catalog.skills.iter().any(|s| s.id == id) {
        return;
    }
    catalog.skills.push(SkillEntry { id, source, plugin: None, description: description_of(text), from });
}

fn push_servers(catalog: &mut Catalog, servers: Option<&Value>, scope: McpScope) {
    let Some(servers) = servers.and_then(Value::as_object) else { return };
    for (name, config) in servers {
        if catalog.mcp.iter().any(|m| &m.name == name) || !config.is_object() {
            continue;
        }
        let (transport, target) = describe_server(config);
        catalog.mcp.push(McpEntry { name: name.clone(), scope, plugin: None, transport, target, config: config.clone() });
    }
}

/// `~/.claude.json` → `projects[<checkout>].mcpServers`, by the path as written or as resolved.
fn local_servers<'a>(json: &'a Value, checkout: &Path) -> Option<&'a Value> {
    let projects = json.get("projects")?.as_object()?;
    let mut keys = vec![checkout.to_string_lossy().trim_end_matches('/').to_string()];
    if let Ok(real) = checkout.canonicalize() {
        keys.push(real.to_string_lossy().trim_end_matches('/').to_string());
    }
    keys.iter().find_map(|k| projects.get(k)?.get("mcpServers"))
}

/// A server's transport and what it reaches, without anything that may be a key.
fn describe_server(config: &Value) -> (String, String) {
    let url = config.get("url").and_then(Value::as_str);
    let transport = config
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| if url.is_some() { "http".into() } else { "stdio".into() });
    let target = match url {
        Some(url) => host_of(url),
        None => config
            .get("command")
            .and_then(Value::as_str)
            .map(|c| Path::new(c).file_name().map_or(c.to_string(), |n| n.to_string_lossy().into_owned()))
            .unwrap_or_default(),
    };
    (transport, target)
}

/// `https://user:key@mcp.context7.com/mcp?key=x` → `mcp.context7.com`.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    host.to_string()
}

/// The skill folders under `dir`, sorted, symlinks followed.
fn skill_dirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| Some((e.file_name().to_str()?.to_string(), e.path())))
        .filter(|(name, _)| !name.starts_with('.'))
        .collect();
    found.sort();
    found
}

fn skill_text(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join("SKILL.md")).or_else(|_| std::fs::read_to_string(dir.join("skill.md"))).ok()
}

/// The frontmatter's one-line `description:`.
fn description_of(text: &str) -> Option<String> {
    let body = text.strip_prefix("---")?;
    let end = body.find("\n---")?;
    body[..end].lines().find_map(|line| {
        let value = line.strip_prefix("description:")?.trim().trim_matches(|c| c == '"' || c == '\'');
        (!value.is_empty()).then(|| value.chars().take(300).collect())
    })
}

/// The names this role's agent gets: the factory's, then its own, each once.
pub fn wanted(definition: &FactoryDefinition, role: Role) -> (Vec<String>, Vec<String>) {
    let agent = definition.agent(role);
    let merge = |all: &[String], own: &[String]| {
        let mut out: Vec<String> = Vec::new();
        for name in all.iter().chain(own) {
            if !out.contains(name) {
                out.push(name.clone());
            }
        }
        out
    };
    // Triage reads only the ticket and the code: no MCP server, not even the factory's (FI3 ac1).
    let mcp = if role == Role::Triage { Vec::new() } else { merge(&definition.mcp, &agent.mcp) };
    (merge(&definition.skills, &agent.skills), mcp)
}

/// What one role gets, found in the catalog.
#[derive(Debug, Clone, PartialEq)]
pub struct Kit {
    pub skills: Vec<SkillEntry>,
    pub mcp: Vec<McpEntry>,
}

impl Catalog {
    /// The named skills and servers, or the names it does not have.
    pub fn resolve(&self, skills: &[String], mcp: &[String]) -> Result<Kit, (Vec<String>, Vec<String>)> {
        let found_skills: Vec<_> = skills.iter().filter_map(|n| self.skills.iter().find(|s| s.id == *n).cloned()).collect();
        let found_mcp: Vec<_> = mcp.iter().filter_map(|n| self.mcp.iter().find(|m| m.name == *n).cloned()).collect();
        let missing_skills: Vec<String> = skills.iter().filter(|n| !self.skills.iter().any(|s| s.id == **n)).cloned().collect();
        let missing_mcp: Vec<String> = mcp.iter().filter(|n| !self.mcp.iter().any(|m| m.name == **n)).cloned().collect();
        if missing_skills.is_empty() && missing_mcp.is_empty() {
            Ok(Kit { skills: found_skills, mcp: found_mcp })
        } else {
            Err((missing_skills, missing_mcp))
        }
    }

    /// Every role's kit can be found (FI4 ac5); else one message naming each missing name and the
    /// roles that ask for it.
    pub fn check(&self, definition: &FactoryDefinition) -> Result<(), String> {
        let mut missing: BTreeMap<(u8, String), Vec<&'static str>> = BTreeMap::new();
        for role in Role::ALL {
            let (skills, mcp) = wanted(definition, role);
            if let Err((skills, mcp)) = self.resolve(&skills, &mcp) {
                for name in skills {
                    missing.entry((0, name)).or_default().push(role.name());
                }
                for name in mcp {
                    missing.entry((1, name)).or_default().push(role.name());
                }
            }
        }
        if missing.is_empty() {
            return Ok(());
        }
        let list: Vec<String> = missing
            .into_iter()
            .map(|((kind, name), roles)| {
                let what = if kind == 0 { "skill" } else { "MCP server" };
                format!("{what} \"{name}\" (for {})", roles.join(", "))
            })
            .collect();
        Err(format!(
            "the factory definition names what this Mac does not have: {}. Install it, or remove it from .lotus/factory.toml or the agent file",
            list.join("; ")
        ))
    }
}

/// One agent turn's kit on disk, for the CLI's flags.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct KitPaths {
    /// `--mcp-config`, with `--strict-mcp-config`: only these servers start (none when empty).
    pub mcp_config: PathBuf,
    /// `--plugin-dir`; `None` when the role has no skills.
    pub plugin_dir: Option<PathBuf>,
    /// The skills as the agent calls them: `lotus-factory:<folder>`.
    pub skills: Vec<String>,
    /// The server names, as its MCP tools start (`mcp__<name>__…`).
    pub mcp: Vec<String>,
}

/// `<root>/<run>.kit`: every turn's kit of one run; removed when the turn ends, and by the reaper.
pub fn kit_root(root: &Path, graph_run_id: &str) -> PathBuf {
    root.join(format!("{graph_run_id}.kit"))
}

/// Keep legacy names stable; escape marketplace qualifiers for CLI skill folder names.
fn skill_folder(id: &str) -> String {
    id.replace('@', "_40").replace(':', "--")
}

/// Writes `kit` into `dir` (emptied first). Repo skills are read from git at the ref they were
/// listed at, so an agent's edit of its worktree cannot change them.
pub fn materialize(kit: &Kit, dir: &Path, checkout: &Path, env: &HashMap<String, String>) -> Result<KitPaths, String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot make the agent's kit folder {}: {e}", dir.display()))?;
    let servers: serde_json::Map<String, Value> = kit.mcp.iter().map(|m| (m.name.clone(), m.config.clone())).collect();
    let mcp_config = dir.join("mcp.json");
    write_private(&mcp_config, &serde_json::json!({ "mcpServers": servers }).to_string())
        .map_err(|e| format!("cannot write the agent's MCP config: {e}"))?;
    let mut paths = KitPaths { mcp_config, plugin_dir: None, skills: Vec::new(), mcp: kit.mcp.iter().map(|m| m.name.clone()).collect() };
    if kit.skills.is_empty() {
        return Ok(paths);
    }
    let plugin = dir.join("plugin");
    std::fs::create_dir_all(plugin.join(".claude-plugin")).map_err(|e| format!("cannot make the skills plugin: {e}"))?;
    let manifest = serde_json::json!({
        "name": KIT_PLUGIN,
        "version": "0.0.0",
        "description": "The skills Lotus chose for one Factory Run agent",
    });
    std::fs::write(plugin.join(".claude-plugin").join("plugin.json"), manifest.to_string())
        .map_err(|e| format!("cannot write the skills plugin: {e}"))?;
    for skill in &kit.skills {
        let folder = skill_folder(&skill.id);
        let to = plugin.join("skills").join(&folder);
        let copied = match &skill.from {
            SkillFrom::Dir(from) => copy_dir(from, &to),
            SkillFrom::PluginDir { dir, root } => {
                let root = root.canonicalize().map_err(|_| "plugin installation is unavailable".to_string())?;
                let mut budget = (MAX_SKILL_FILES, MAX_SKILL_BYTES);
                copy_dir_within(dir, &to, &mut budget, 0, Some(&root))
            }
            SkillFrom::AtRef { reference, path } => copy_from_git(checkout, reference, path, &to, env),
            SkillFrom::AtRefIn { root, reference, path } => copy_from_git(root, reference, path, &to, env),
        };
        copied.map_err(|why| format!("cannot copy skill \"{}\": {why}", skill.id))?;
        paths.skills.push(format!("{KIT_PLUGIN}:{folder}"));
    }
    paths.plugin_dir = Some(plugin);
    Ok(paths)
}

/// What the agent's prompt says about its kit; empty with none.
pub fn kit_note(paths: &KitPaths) -> String {
    let mut note = String::new();
    if !paths.skills.is_empty() {
        let names: Vec<String> = paths.skills.iter().map(|s| format!("`{s}`")).collect();
        note.push_str(&format!(
            "\n\nSkills chosen for you: {}. Before you start, load each one that fits this task with the Skill tool, and follow it.",
            names.join(", ")
        ));
    }
    if !paths.mcp.is_empty() {
        note.push_str(&format!("\n\nMCP servers you may use: {}.", paths.mcp.join(", ")));
    }
    note
}

/// Owner-only: the file holds the servers' keys.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(text.as_bytes())
}

/// Copies a skill folder, symlinks followed, `.git` left out, within the size limits.
fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    let mut budget = (MAX_SKILL_FILES, MAX_SKILL_BYTES);
    copy_dir_within(from, to, &mut budget, 0, None)
}

fn copy_dir_within(from: &Path, to: &Path, budget: &mut (usize, u64), depth: usize, boundary: Option<&Path>) -> Result<(), String> {
    if depth > 8 {
        return Err(format!("{} is nested too deep", from.display()));
    }
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    let entries = std::fs::read_dir(from).map_err(|e| format!("cannot read {}: {e}", from.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name == ".git" {
            continue;
        }
        let path = entry.path();
        if let Some(boundary) = boundary {
            let real = path.canonicalize().map_err(|_| "plugin resource is unreadable".to_string())?;
            if !real.starts_with(boundary) {
                return Err("a resource symlink points outside the plugin installation".into());
            }
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.is_dir() {
            copy_dir_within(&path, &to.join(&name), budget, depth + 1, boundary)?;
        } else if meta.is_file() {
            take(budget, meta.len())?;
            std::fs::copy(&path, to.join(&name)).map_err(|e| format!("cannot copy {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

fn take(budget: &mut (usize, u64), bytes: u64) -> Result<(), String> {
    if budget.0 == 0 || bytes > budget.1 {
        return Err(format!("it holds more than {MAX_SKILL_FILES} files or {} MB", MAX_SKILL_BYTES / 1024 / 1024));
    }
    budget.0 -= 1;
    budget.1 -= bytes;
    Ok(())
}

/// Copies `path` at `reference` from the checkout's git, within the size limits.
fn copy_from_git(checkout: &Path, reference: &str, path: &str, to: &Path, env: &HashMap<String, String>) -> Result<(), String> {
    let listed = git_bytes(checkout, &["ls-tree", "-r", "--name-only", reference, "--", &format!("{path}/")], env)
        .ok_or_else(|| format!("cannot list {path} at {reference}"))?;
    let mut budget = (MAX_SKILL_FILES, MAX_SKILL_BYTES);
    for file in String::from_utf8_lossy(&listed).lines() {
        let Some(rel) = file.strip_prefix(path).map(|r| r.trim_start_matches('/')) else { continue };
        if rel.is_empty() || rel.split('/').any(|part| part == ".." || part == ".git") {
            continue;
        }
        let bytes = git_bytes(checkout, &["show", &format!("{reference}:{file}")], env).ok_or_else(|| format!("cannot read {file} at {reference}"))?;
        take(&mut budget, bytes.len() as u64)?;
        let target = to.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A guess at the meta-repo above `checkout`: the git repo that is its parent folder and git-ignores
/// it (ADR-0063). Only for a view that is told no workspace (Settings' catalog); a run passes its
/// workspace to [`read_catalog_with`] explicitly. `None` for a plain repo.
pub fn guess_meta_repo(checkout: &Path, env: &HashMap<String, String>) -> Option<PathBuf> {
    let checkout = checkout.canonicalize().ok()?;
    let parent = checkout.parent()?;
    let top = String::from_utf8(git_bytes(parent, &["rev-parse", "--show-toplevel"], env)?).ok()?;
    if Path::new(top.trim()).canonicalize().ok()? != parent {
        return None;
    }
    let name = checkout.file_name()?.to_str()?;
    git_bytes(parent, &["check-ignore", "-q", "--", name], env)?;
    Some(parent.to_path_buf())
}

fn git_bytes(checkout: &Path, args: &[&str], env: &HashMap<String, String>) -> Option<Vec<u8>> {
    let out = std::process::Command::new("git").no_window().arg("-C").arg(checkout).args(args).envs(env).stdin(Stdio::null()).output().ok()?;
    out.status.success().then_some(out.stdout)
}

fn git_show(checkout: &Path, spec: &str, env: &HashMap<String, String>) -> Option<String> {
    git_bytes(checkout, &["show", spec], env).map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// The folders right under `dir` at `at`: `(name, path)`.
fn git_subdirs(checkout: &Path, at: &str, dir: &str, env: &HashMap<String, String>) -> Vec<(String, String)> {
    let Some(out) = git_bytes(checkout, &["ls-tree", "-d", "--name-only", at, "--", &format!("{dir}/")], env) else { return Vec::new() };
    String::from_utf8_lossy(&out)
        .lines()
        .filter_map(|path| Some((path.rsplit('/').next()?.to_string(), path.to_string())))
        .filter(|(name, _)| !name.is_empty() && !name.starts_with('.'))
        .collect()
}

#[cfg(test)]
#[path = "kit_discovery_tests.rs"]
mod discovery_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn skill(dir: &Path, name: &str, description: &str) {
        write(&dir.join(name).join("SKILL.md"), &format!("---\nname: {name}\ndescription: {description}\n---\n\nDo it.\n"));
    }

    /// `~/.claude` with two user skills and one plugin; `~/.claude.json` with servers that hold keys.
    fn home(tmp: &Path, checkout: &Path) -> KitSources {
        let claude = tmp.join(".claude");
        skill(&claude.join("skills"), "grilling", "Grill the user.");
        skill(&claude.join("skills"), "caveman", "\"Talk short.\"");
        let plugin = tmp.join("cache/mattpocock-skills/1.0");
        skill(&plugin.join("skills"), "tdd", "Red, green, refactor.");
        write(
            &claude.join("plugins/installed_plugins.json"),
            &serde_json::json!({ "version": 2, "plugins": { "mattpocock-skills@market": [{ "scope": "user", "installPath": plugin }] } })
                .to_string(),
        );
        let claude_json = tmp.join(".claude.json");
        write(
            &claude_json,
            &serde_json::json!({
                "mcpServers": {
                    "context7": { "type": "http", "url": "https://mcp.context7.com/mcp", "headers": { "CONTEXT7_API_KEY": "sk-secret-1" } },
                    "pencil": { "command": "/opt/pencil/bin/pencil-mcp", "args": ["--token", "sk-secret-2"], "env": { "K": "sk-secret-3" } },
                },
                "projects": { checkout.to_string_lossy(): { "mcpServers": { "pencil": { "command": "local-pencil" } } } },
            })
            .to_string(),
        );
        KitSources { claude_dir: Some(claude), claude_json: Some(claude_json), private_root: None }
    }

    #[test]
    fn a_private_factory_lives_in_one_folder_per_repo_and_its_skills_are_listed_as_factory_skills() {
        let tmp = tempfile::tempdir().unwrap();
        let sources = KitSources { private_root: Some(tmp.path().join("factory-private")), ..Default::default() };
        let dir = sources.private_dir("acme/widgets").unwrap();
        assert_eq!(dir, tmp.path().join("factory-private/acme/widgets"));
        for odd in ["acme", "../x", "acme/..", "acme/a b", "/widgets", "acme/"] {
            assert_eq!(sources.private_dir(odd), None, "{odd}");
        }
        assert_eq!(KitSources::default().private_dir("acme/widgets"), None);
        skill(&dir.join(".lotus/factory/skills"), "house-style", "Our style.");
        let catalog = read_catalog_with(&sources, tmp.path(), None, Some(&dir), None, &Default::default());
        assert_eq!(catalog.skills.len(), 1);
        assert_eq!((catalog.skills[0].id.as_str(), catalog.skills[0].source), ("house-style", SkillSource::Factory));
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    /// A repo whose `main` is also `origin/main` (and origin's default), holding `files`.
    fn repo_with(dir: &Path, files: &[(&str, &str)]) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q", "-b", "main"]);
        for (path, text) in files {
            write(&dir.join(path), text);
        }
        git(dir, &["add", "-A"]);
        git(dir, &["commit", "-q", "-m", "init"]);
        git(dir, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        git(dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    }

    fn skill_md(name: &str, description: &str) -> String {
        format!("---\nname: {name}\ndescription: {description}\n---\n\nDo it.\n")
    }

    #[test]
    fn a_sub_repos_catalog_lists_the_meta_repos_agents_skills_after_its_own() {
        let tmp = tempfile::tempdir().unwrap();
        let meta = tmp.path().join("acme-main");
        repo_with(
            &meta,
            &[
                (".gitignore", "acme-api/\n"),
                (".agents/skills/api-style/SKILL.md", &skill_md("api-style", "Meta API style.")),
                (".agents/skills/shared/SKILL.md", &skill_md("shared", "Meta shared.")),
            ],
        );
        let back = meta.join("acme-api");
        repo_with(&back, &[(".agents/skills/shared/SKILL.md", &skill_md("shared", "Back shared."))]);
        let catalog = read_catalog_with(&KitSources::default(), &back, Some("origin/main"), None, Some(&meta), &HashMap::new());
        let skills: Vec<_> = catalog.skills.iter().map(|s| (s.id.as_str(), s.source, s.description.as_deref().unwrap())).collect();
        assert_eq!(skills, [("shared", SkillSource::Repo, "Back shared."), ("api-style", SkillSource::Meta, "Meta API style.")]);

        // Chosen for a role, the meta skill is copied from the meta-repo's git, not from the sub-repo.
        let kit = catalog.resolve(&["api-style".to_string()], &[]).unwrap();
        let paths = materialize(&kit, &tmp.path().join("kit"), &back, &HashMap::new()).unwrap();
        assert_eq!(paths.skills, ["lotus-factory:api-style"]);
        assert!(tmp.path().join("kit/plugin/skills/api-style/SKILL.md").is_file());
    }

    #[test]
    fn a_repo_that_is_not_inside_a_meta_repo_gets_no_meta_skills() {
        let tmp = tempfile::tempdir().unwrap();
        // The parent is a git repo with skills, but does not ignore the folder: not a meta-repo.
        let parent = tmp.path().join("parent");
        repo_with(&parent, &[(".agents/skills/stray/SKILL.md", &skill_md("stray", "Stray."))]);
        let plain = parent.join("plain");
        repo_with(&plain, &[(".agents/skills/own/SKILL.md", &skill_md("own", "Own."))]);
        let catalog = read_catalog(&KitSources::default(), &plain, Some("origin/main"), &HashMap::new());
        let ids: Vec<_> = catalog.skills.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["own"], "a run names its meta-repo; nothing is guessed from the parent folder");
        assert_eq!(guess_meta_repo(&plain, &HashMap::new()), None);
    }

    #[test]
    fn the_catalog_lists_user_and_plugin_skills_and_servers_without_their_keys() {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("repo");
        let catalog = read_catalog(&home(tmp.path(), &checkout), &checkout, None, &HashMap::new());
        let ids: Vec<_> = catalog.skills.iter().map(|s| (s.id.as_str(), s.source)).collect();
        assert_eq!(ids, [("caveman", SkillSource::User), ("grilling", SkillSource::User), ("mattpocock-skills:tdd", SkillSource::Plugin)]);
        assert_eq!(catalog.skills[0].description.as_deref(), Some("Talk short."));

        let servers: Vec<_> = catalog.mcp.iter().map(|m| (m.name.as_str(), m.scope, m.transport.as_str(), m.target.as_str())).collect();
        // The checkout's local pencil wins over the user's.
        assert_eq!(servers, [("pencil", McpScope::Local, "stdio", "local-pencil"), ("context7", McpScope::User, "http", "mcp.context7.com")]);
        let shown = format!("{} {:?}", serde_json::to_string(&catalog).unwrap(), catalog);
        assert!(!shown.contains("sk-secret"), "a key reached the UI or a log: {shown}");
    }

    #[test]
    fn a_host_never_carries_its_credentials_or_query() {
        assert_eq!(host_of("https://user:key@mcp.example.com:8443/mcp?token=x"), "mcp.example.com:8443");
        assert_eq!(host_of("mcp.example.com/x"), "mcp.example.com");
    }

    #[test]
    fn check_names_every_missing_skill_and_server_with_the_roles_that_want_it() {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("repo");
        let catalog = read_catalog(&home(tmp.path(), &checkout), &checkout, None, &HashMap::new());
        let def = super::super::parse_definition(
            "gate = \"g\"\nmcp = [\"context7\"]\n",
            &[
                (format!("{}/spec.md", super::super::AGENTS_DIR), "---\nskills: [grilling, nope]\nmcp: [github]\n---\n".into()),
                (format!("{}/implement.md", super::super::AGENTS_DIR), "---\nskills: [nope, \"mattpocock-skills:tdd\"]\n---\n".into()),
            ],
        )
        .unwrap();
        let err = catalog.check(&def).unwrap_err();
        assert!(err.contains("skill \"nope\" (for spec, implement)"), "{err}");
        assert!(err.contains("MCP server \"github\" (for spec)"), "{err}");
        assert!(!err.contains("context7") && !err.contains("grilling"), "{err}");

        let ok = super::super::parse_definition("gate = \"g\"\nskills = [\"grilling\"]\n", &[]).unwrap();
        assert_eq!(catalog.check(&ok), Ok(()));
    }

    #[test]
    fn a_turns_kit_holds_only_its_servers_owner_only_and_its_skills_as_one_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("repo");
        let catalog = read_catalog(&home(tmp.path(), &checkout), &checkout, None, &HashMap::new());
        let kit = catalog.resolve(&["grilling".into(), "mattpocock-skills:tdd".into()], &["context7".into()]).unwrap();
        let dir = kit_root(tmp.path(), "run-1").join("spec");
        let paths = materialize(&kit, &dir, &checkout, &HashMap::new()).unwrap();

        let config: Value = serde_json::from_str(&std::fs::read_to_string(&paths.mcp_config).unwrap()).unwrap();
        assert_eq!(config["mcpServers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["context7"]);
        assert_eq!(config["mcpServers"]["context7"]["headers"]["CONTEXT7_API_KEY"], "sk-secret-1", "the CLI needs the real definition");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&paths.mcp_config).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let plugin = paths.plugin_dir.clone().unwrap();
        let manifest: Value = serde_json::from_str(&std::fs::read_to_string(plugin.join(".claude-plugin/plugin.json")).unwrap()).unwrap();
        assert_eq!(manifest["name"], KIT_PLUGIN);
        assert!(plugin.join("skills/grilling/SKILL.md").exists());
        assert!(plugin.join("skills/mattpocock-skills--tdd/SKILL.md").exists());
        assert_eq!(paths.skills, ["lotus-factory:grilling", "lotus-factory:mattpocock-skills--tdd"]);
        let note = kit_note(&paths);
        assert!(note.contains("`lotus-factory:grilling`") && note.contains("Skill tool") && note.contains("context7"), "{note}");

        // No skills, no servers: an empty config (strict MCP starts none) and no plugin.
        let bare = materialize(&catalog.resolve(&[], &[]).unwrap(), &dir, &checkout, &HashMap::new()).unwrap();
        assert_eq!(std::fs::read_to_string(&bare.mcp_config).unwrap(), "{\"mcpServers\":{}}");
        assert_eq!((bare.plugin_dir.clone(), kit_note(&bare)), (None, String::new()));
        assert!(!dir.join("plugin").exists(), "the folder is emptied first");
    }

    #[test]
    fn a_skill_over_the_size_limit_is_refused_by_name() {
        let tmp = tempfile::tempdir().unwrap();
        let checkout = tmp.path().join("repo");
        let sources = home(tmp.path(), &checkout);
        let big = sources.claude_dir.as_ref().unwrap().join("skills/grilling/big.bin");
        std::fs::write(&big, vec![0u8; (MAX_SKILL_BYTES + 1) as usize]).unwrap();
        let catalog = read_catalog(&sources, &checkout, None, &HashMap::new());
        let kit = catalog.resolve(&["grilling".into()], &[]).unwrap();
        let err = materialize(&kit, &tmp.path().join("k"), &checkout, &HashMap::new()).unwrap_err();
        assert!(err.contains("skill \"grilling\"") && err.contains("MB"), "{err}");
    }

    #[test]
    fn wanted_puts_the_factorys_names_first_each_once() {
        let def = super::super::parse_definition(
            "gate = \"g\"\nskills = [\"a\"]\nmcp = [\"m\"]\n",
            &[(format!("{}/spec.md", super::super::AGENTS_DIR), "---\nskills: [b, a]\nmcp: [m, n]\n---\n".into())],
        )
        .unwrap();
        assert_eq!(wanted(&def, Role::Spec), (vec!["a".to_string(), "b".into()], vec!["m".to_string(), "n".into()]));
        assert_eq!(wanted(&def, Role::Implement), (vec!["a".to_string()], vec!["m".to_string()]));
        assert_eq!(wanted(&def, Role::Triage), (vec!["a".to_string()], vec![]), "triage gets skills, never MCP");
        let err = super::super::parse_definition("gate = \"g\"\n", &[(format!("{}/triage.md", super::super::AGENTS_DIR), "---\nmcp: [m]\n---\n".into())])
            .unwrap_err();
        assert!(err.contains("triage.md:2: mcp is not allowed"), "{err}");
    }
}
