//! Whether the skill a PR review automation names is one the review agent can load (ADR-0052 §1).
//!
//! A headless review runs with `--setting-sources user`, so it sees the user's own skills and
//! commands and the plugins their settings enable, never the PR repository's. Lotus checks the
//! name before the agent starts: an unknown skill fails the run, with no silent fallback.

use std::path::Path;

/// Deepest a plugin keeps a skill below its `skills/` folder (`skills/<group>/<name>/SKILL.md`).
const MAX_DEPTH: usize = 3;

/// The name as the form takes it: `review`, `/review`, or `plugin:review`.
pub fn normalize(name: &str) -> String {
    name.trim().trim_start_matches('/').to_string()
}

/// What a run says when the skill is missing.
pub fn not_found(name: &str) -> String {
    format!(
        "skill /{} not found: install it in ~/.claude/skills or as an enabled plugin, or clear the skill field to use Lotus's review method",
        normalize(name)
    )
}

/// Whether `name` is a skill or command under `claude_dir` (the CLI's `~/.claude`).
pub fn exists(claude_dir: &Path, name: &str) -> bool {
    let name = normalize(name);
    if name.is_empty() || name.contains("..") || name.contains('/') {
        return false;
    }
    let (plugin, skill) = match name.split_once(':') {
        Some((plugin, skill)) => (Some(plugin), skill),
        None => (None, name.as_str()),
    };
    if plugin.is_none() && (claude_dir.join("skills").join(skill).join("SKILL.md").is_file() || claude_dir.join("commands").join(format!("{skill}.md")).is_file()) {
        return true;
    }
    plugin_paths(claude_dir).iter().any(|(id, path)| {
        plugin.is_none_or(|p| id.split('@').next() == Some(p))
            && (has_skill(&path.join("skills"), skill, MAX_DEPTH) || path.join("commands").join(format!("{skill}.md")).is_file())
    })
}

/// `(id, installPath)` of each installed plugin not switched off in `settings.json`.
fn plugin_paths(claude_dir: &Path) -> Vec<(String, std::path::PathBuf)> {
    let read = |file: &str| -> serde_json::Value {
        std::fs::read_to_string(claude_dir.join(file)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    };
    let installed = read("plugins/installed_plugins.json");
    let enabled = read("settings.json");
    let Some(plugins) = installed["plugins"].as_object() else { return vec![] };
    plugins
        .iter()
        .filter(|(id, _)| enabled["enabledPlugins"][id.as_str()].as_bool() != Some(false))
        .flat_map(|(id, installs)| {
            installs.as_array().into_iter().flatten().filter_map(move |i| i["installPath"].as_str().map(|p| (id.clone(), p.into())))
        })
        .collect()
}

fn has_skill(dir: &Path, skill: &str, depth: usize) -> bool {
    if dir.join(skill).join("SKILL.md").is_file() {
        return true;
    }
    depth > 0
        && std::fs::read_dir(dir)
            .map(|entries| entries.flatten().any(|e| e.path().is_dir() && has_skill(&e.path(), skill, depth - 1)))
            .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "---\nname: x\n---\n").unwrap();
    }

    #[test]
    fn user_skills_commands_and_enabled_plugin_skills_are_found() {
        let home = tempfile::tempdir().unwrap();
        let claude = home.path();
        touch(&claude.join("skills/deep-review/SKILL.md"));
        touch(&claude.join("commands/quick.md"));
        let plugin = claude.join("plugins/cache/m/mattpocock-skills/1.3.1");
        touch(&plugin.join("skills/engineering/code-review/SKILL.md"));
        let off = claude.join("plugins/cache/o/off/1");
        touch(&off.join("skills/hidden/SKILL.md"));
        std::fs::write(
            claude.join("plugins/installed_plugins.json"),
            serde_json::json!({"version": 2, "plugins": {
                "mattpocock-skills@m": [{"installPath": plugin}],
                "off@o": [{"installPath": off}],
            }})
            .to_string(),
        )
        .unwrap();
        std::fs::write(claude.join("settings.json"), r#"{"enabledPlugins": {"off@o": false}}"#).unwrap();

        for name in ["deep-review", "/deep-review", " quick ", "code-review", "mattpocock-skills:code-review"] {
            assert!(exists(claude, name), "{name}");
        }
        for name in ["missing", "hidden", "off:hidden", "other:code-review", "", "../skills/deep-review", "a/b"] {
            assert!(!exists(claude, name), "{name}");
        }
        assert!(not_found("/missing").starts_with("skill /missing not found"));
    }
}
