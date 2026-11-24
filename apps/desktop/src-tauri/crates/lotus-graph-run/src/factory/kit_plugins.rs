//! Installed-plugin discovery only: no plugin code or hooks execute here.
use super::*;
use std::collections::{BTreeSet, HashSet};
use std::io::Read;

/// JSON diagnostics never echo values (parser errors may contain credentials).
fn json_file(path: &Path, label: &str, notes: &mut Vec<String>) -> Option<Value> {
    let mut bytes = Vec::new();
    let read = std::fs::File::open(path).and_then(|file| file.take(1024 * 1024 + 1).read_to_end(&mut bytes));
    match read {
        Ok(_) if bytes.len() <= 1024 * 1024 => match serde_json::from_slice(&bytes) {
            Ok(value) => Some(value),
            Err(_) => {
                notes.push(format!("{label}: invalid JSON; repair the configuration and refresh integrations"));
                None
            }
        },
        Ok(_) => {
            notes.push(format!("{label}: configuration exceeds 1 MB"));
            None
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => {
            notes.push(format!("{label}: configuration is unreadable"));
            None
        }
    }
}

fn same_project(path: &str, checkout: &Path) -> bool {
    let path = Path::new(path);
    path == checkout || path.canonicalize().ok().zip(checkout.canonicalize().ok()).is_some_and(|(a, b)| a == b)
}

fn enabled(claude: &Path, checkout: &Path, notes: &mut Vec<String>) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    for (path, label) in [
        (claude.join("settings.json"), "Claude user settings"),
        (checkout.join(".claude/settings.json"), "Claude project settings"),
        (checkout.join(".claude/settings.local.json"), "Claude local settings"),
    ] {
        if let Some(json) = json_file(&path, label, notes) {
            if let Some(map) = json.get("enabledPlugins").and_then(Value::as_object) {
                out.extend(map.iter().filter_map(|(k, v)| Some((k.clone(), v.as_bool()?))));
            }
        }
    }
    out
}

pub(super) fn discover(catalog: &mut Catalog, claude: &Path, checkout: &Path) {
    let enabled = enabled(claude, checkout, &mut catalog.notes);
    let json = json_file(&claude.join("plugins/installed_plugins.json"), "Claude installed plugins", &mut catalog.notes)
        .unwrap_or_else(|| serde_json::json!({"plugins": {}}));
    let Some(plugins) = json.get("plugins").and_then(Value::as_object) else {
        catalog.notes.push("Claude installed plugins: unsupported registry format".into());
        return;
    };
    let mut selected = Vec::new();
    let mut missing = Vec::new();
    let keys: BTreeSet<_> = plugins.keys().chain(enabled.keys()).collect();
    for key in keys {
        if key.is_empty() || key.len() > 160 || !key.chars().all(|c| c.is_ascii_alphanumeric() || "-_@.".contains(c)) {
            catalog.notes.push("Claude installed plugins: invalid plugin identity".into());
            continue;
        }
        if enabled.get(key) == Some(&false) {
            catalog.notices.push(format!("Plugin {key} is disabled for this checkout"));
            continue;
        }
        let Some(installs) = plugins.get(key) else {
            if enabled.get(key) == Some(&true) { missing.push((key.clone(), false)); }
            continue;
        };
        let Some(installs) = installs.as_array() else {
            catalog.notes.push(format!("Plugin {key}: unsupported installation metadata"));
            continue;
        };
        let mut candidates = Vec::new();
        let mut other_project = false;
        for install in installs {
            let rank = match install.get("scope").and_then(Value::as_str).unwrap_or("user") {
                "user" => 0,
                "project" | "local" => {
                    if !install.get("projectPath").and_then(Value::as_str).is_some_and(|p| same_project(p, checkout)) {
                        other_project |= install.get("projectPath").and_then(Value::as_str).is_some();
                        continue;
                    }
                    if install["scope"] == "local" {
                        2
                    } else {
                        1
                    }
                }
                _ => {
                    catalog.notes.push(format!("Plugin {key}: unsupported installation scope"));
                    continue;
                }
            };
            let Some(path) = install.get("installPath").and_then(Value::as_str) else { continue };
            let root = PathBuf::from(path);
            if !root.is_dir() {
                catalog.notes.push(format!("Plugin {key}: an installation is unavailable; reinstall or remove its stale registry entry"));
                continue;
            }
            candidates.push((rank, root));
        }
        candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        if let Some((_, root)) = candidates.into_iter().next() {
            selected.push((key.clone(), root));
        } else if enabled.get(key) == Some(&true) {
            missing.push((key.clone(), other_project));
        }
    }
    let mut counts = BTreeMap::<String, usize>::new();
    for (key, _) in &selected {
        *counts.entry(short_name(key).into()).or_default() += 1;
    }
    for (key, other_project) in missing {
        let alternatives: Vec<_> = selected.iter()
            .filter(|(available, _)| short_name(available) == short_name(&key))
            .map(|(available, _)| available.as_str()).collect();
        missing_installation(catalog, &key, other_project, &alternatives);
    }
    for (key, root) in selected {
        let short = short_name(&key);
        let id = if counts[short] > 1 {
            catalog.notices.push(format!("Plugin {short} occurs in multiple marketplaces; select its marketplace-qualified name"));
            key.as_str()
        } else {
            short
        };
        let skills_start = catalog.skills.len();
        let mcp_start = catalog.mcp.len();
        read_plugin(catalog, id, &root);
        for skill in &mut catalog.skills[skills_start..] { skill.plugin = Some(key.clone()); }
        for server in &mut catalog.mcp[mcp_start..] { server.plugin = Some(key.clone()); }
    }
}

fn missing_installation(catalog: &mut Catalog, key: &str, other_project: bool, alternatives: &[&str]) {
    let reason = if other_project { " Its registered installation belongs to another project." } else { "" };
    let recovery = if !alternatives.is_empty() {
        format!("{} is available from a different marketplace. These entries are not interchangeable. If you intended to use that source, disable the unused entry {key} in Claude Code settings; otherwise install {key} for this project or at user scope in the active Claude profile.", alternatives.join(", "))
    } else if key.ends_with("@builtin") {
        "Factory cannot verify this built-in entry through the installed-plugin registry. Check it in Claude Code; disable the entry if unused, or use a supported registered installation. This does not prove the built-in is unavailable in Claude Code itself.".into()
    } else {
        "Install it in Claude Code for this project or at user scope in the active Claude profile, or disable the unused entry in Claude Code settings.".into()
    };
    catalog.notes.push(format!(
        "Plugin {key} is enabled but has no applicable installation for this checkout.{reason} {recovery} Then refresh integrations. Lotus does not reuse other projects' installations."
    ));
}

fn short_name(key: &str) -> &str {
    key.split_once('@').map_or(key, |(name, _)| name)
}

/// Manifest paths and symlinks must remain within the plugin installation.
fn contained(root: &Path, value: &str) -> Option<PathBuf> {
    let rel = Path::new(value);
    if rel.is_absolute() || rel.components().any(|p| matches!(p, std::path::Component::ParentDir)) {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let path = root.join(rel).canonicalize().ok()?;
    path.starts_with(&root).then_some(path)
}

fn strings(value: &Value) -> Option<Vec<&str>> {
    match value {
        Value::String(s) => Some(vec![s]),
        Value::Array(a) => a.iter().map(Value::as_str).collect(),
        _ => None,
    }
}

fn optional_plugin_json(root: &Path, relative: &str, label: &str, notes: &mut Vec<String>) -> Option<Value> {
    match std::fs::symlink_metadata(root.join(relative)) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            notes.push(format!("{label}: configuration is unreadable"));
            return None;
        }
    }
    let Some(path) = contained(root, relative) else {
        notes.push(format!("{label}: config path is unavailable or outside the installation"));
        return None;
    };
    json_file(&path, label, notes)
}

fn read_plugin(catalog: &mut Catalog, id: &str, root: &Path) {
    let manifest = optional_plugin_json(root, ".claude-plugin/plugin.json", &format!("Plugin {id} manifest"), &mut catalog.notes);
    let declaration = manifest.as_ref().and_then(|m| m.get("skills"));
    let paths = match declaration {
        Some(value) => match strings(value) {
            Some(paths) => paths,
            None => {
                catalog.notes.push(format!("Plugin {id}: unsupported skills declaration"));
                Vec::new()
            }
        },
        None => vec!["./skills"],
    };
    let mut visited = HashSet::new();
    let mut names = BTreeSet::new();
    for path in paths {
        if let Some(path) = contained(root, path) {
            scan_skills(catalog, id, root, &path, &mut visited, &mut names, 0);
        } else if declaration.is_some() {
            catalog.notes.push(format!("Plugin {id}: a declared skill path is missing or outside the installation"));
        }
    }
    let mut servers = serde_json::Map::new();
    if let Some(json) = optional_plugin_json(root, ".mcp.json", &format!("Plugin {id} MCP"), &mut catalog.notes) {
        merge_servers(&mut servers, &json, catalog, id);
    }
    if let Some(value) = manifest.as_ref().and_then(|m| m.get("mcpServers")) {
        if value.is_object() {
            merge_servers(&mut servers, value, catalog, id);
        } else if let Some(paths) = strings(value) {
            for path in paths {
                if let Some(path) = contained(root, path) {
                    if let Some(json) = json_file(&path, &format!("Plugin {id} MCP"), &mut catalog.notes) {
                        merge_servers(&mut servers, &json, catalog, id);
                    }
                } else {
                    catalog.notes.push(format!("Plugin {id}: an MCP config path is missing or outside the installation"));
                }
            }
        } else {
            catalog.notes.push(format!("Plugin {id}: unsupported MCP declaration"));
        }
    }
    for (name, mut config) in servers {
        expand_root(&mut config, root);
        let name = format!("plugin-{}--{}", encoded(id), encoded(&name));
        if catalog.mcp.iter().any(|m| m.name == name) {
            catalog.notes.push(format!("Plugin {id}: duplicate MCP server {name}; explicit configuration wins"));
            continue;
        }
        let map = serde_json::json!({name: config});
        push_servers(catalog, Some(&map), McpScope::Plugin);
    }
    if root.join("commands").is_dir()
        || root.join("hooks").is_dir()
        || root.join("agents").is_dir()
        || root.join(".lsp.json").is_file()
        || manifest.as_ref().is_some_and(|m| ["commands", "hooks", "agents", "lspServers"].iter().any(|key| m.get(key).is_some()))
    {
        catalog.notices.push(format!("Plugin {id}: Factory imports skills and selected MCP servers, not plugin commands, agents, hooks or LSPs"));
    }
}

fn scan_skills(
    catalog: &mut Catalog,
    id: &str,
    root: &Path,
    dir: &Path,
    visited: &mut HashSet<PathBuf>,
    names: &mut BTreeSet<String>,
    depth: usize,
) {
    let Ok(real) = dir.canonicalize() else { return };
    let Ok(root_real) = root.canonicalize() else { return };
    if !real.starts_with(&root_real) {
        catalog.notes.push(format!("Plugin {id}: a skill symlink points outside the installation"));
        return;
    }
    if !visited.insert(real.clone()) {
        return;
    }
    if depth > 8 || visited.len() > 1000 {
        catalog.notes.push(format!("Plugin {id}: skill discovery limit exceeded"));
        return;
    }
    for file in ["SKILL.md", "skill.md"] {
        let path = real.join(file);
        if std::fs::symlink_metadata(&path).is_ok() && !path.canonicalize().is_ok_and(|p| p.starts_with(&root_real)) {
            catalog.notes.push(format!("Plugin {id}: skill metadata is unavailable or outside the installation"));
            return;
        }
    }
    if let Some(text) = skill_text(&real) {
        let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { return };
        if !names.insert(name.to_string()) {
            catalog.notes.push(format!("Plugin {id}: duplicate skill {name}; first declared path wins"));
            return;
        }
        push_skill(
            catalog,
            format!("{id}:{name}"),
            SkillSource::Plugin,
            &text,
            SkillFrom::PluginDir { dir: real, root: root.to_path_buf() },
        );
        return;
    }
    for (_, child) in skill_dirs(&real) {
        scan_skills(catalog, id, root, &child, visited, names, depth + 1);
    }
}

fn merge_servers(out: &mut serde_json::Map<String, Value>, json: &Value, catalog: &mut Catalog, id: &str) {
    let value = json.get("mcpServers").unwrap_or(json);
    let Some(map) = value.as_object() else {
        catalog.notes.push(format!("Plugin {id}: unsupported MCP config format"));
        return;
    };
    for (name, config) in map {
        if !config.is_object()
            || (config.get("command").and_then(Value::as_str).is_none() && config.get("url").and_then(Value::as_str).is_none())
        {
            catalog.notes.push(format!("Plugin {id}: an MCP server lacks a command or URL"));
            continue;
        }
        if out.contains_key(name) {
            if out[name] != *config {
                catalog.notes.push(format!("Plugin {id}: duplicate MCP server {name}; manifest definition wins"));
            }
        }
        out.insert(name.clone(), config.clone());
    }
}

fn expand_root(value: &mut Value, root: &Path) {
    match value {
        Value::String(s) => *s = s.replace("${CLAUDE_PLUGIN_ROOT}", &root.to_string_lossy()),
        Value::Array(a) => a.iter_mut().for_each(|v| expand_root(v, root)),
        Value::Object(m) => m.values_mut().for_each(|v| expand_root(v, root)),
        _ => {}
    }
}

/// Reversible escaping keeps MCP permissions plain and prevents namespace collisions.
fn encoded(value: &str) -> String {
    value.bytes().map(|b| if b.is_ascii_alphanumeric() { char::from(b).to_string() } else { format!("_{b:02x}") }).collect()
}
