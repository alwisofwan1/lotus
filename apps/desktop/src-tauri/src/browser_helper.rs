use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::paths;

const LOTUS_BROWSER_SCRIPT: &str = include_str!("../../scripts/lotus-browser.mjs");
const LOTUS_BROWSER_SKILL: &str = include_str!("../../scripts/lotus-browser-skill.md");
const LOTUS_BROWSER_AGENTS_BLOCK: &str =
    include_str!("../../scripts/lotus-browser-agents-block.md");

/// Marker fences around the managed instruction block we inject into non-Claude
/// providers' global instruction files. Everything between them is Lotus-owned
/// and rewritten on every app start; content outside is the user's and untouched.
const BLOCK_BEGIN: &str = "<!-- lotus-browser:begin -->";
const BLOCK_END: &str = "<!-- lotus-browser:end -->";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserHelperEnv {
    pub bin_dir: PathBuf,
    pub script_path: PathBuf,
    pub state_dir: PathBuf,
    pub path: OsString,
}

pub fn helper_bin_dir() -> PathBuf {
    paths::lotus_state_dir().join("bin")
}

pub fn helper_state_dir() -> PathBuf {
    paths::lotus_state_dir().join("browser-helper")
}

pub fn terminal_env() -> BrowserHelperEnv {
    let bin_dir = helper_bin_dir();
    BrowserHelperEnv {
        script_path: bin_dir.join("lotus-browser.mjs"),
        state_dir: helper_state_dir(),
        path: prepend_helper_bin_to_path(std::env::var_os("PATH")),
        bin_dir,
    }
}

pub fn prepend_helper_bin_to_path(existing: Option<OsString>) -> OsString {
    let helper = helper_bin_dir();
    let mut parts = vec![helper.clone()];
    if let Some(value) = existing {
        parts.extend(std::env::split_paths(&value).filter(|path| path != &helper));
    }
    std::env::join_paths(parts).unwrap_or_else(|_| OsString::new())
}

pub fn install_lotus_browser_helper() -> io::Result<BrowserHelperEnv> {
    let env = terminal_env();
    fs::create_dir_all(&env.bin_dir)?;
    fs::create_dir_all(&env.state_dir)?;
    write_executable(&env.script_path, LOTUS_BROWSER_SCRIPT.as_bytes())?;

    #[cfg(unix)]
    write_executable(
        &env.bin_dir.join("lotus-browser"),
        br#"#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/lotus-browser.mjs" "$@"
"#,
    )?;

    #[cfg(windows)]
    fs::write(
        env.bin_dir.join("lotus-browser.cmd"),
        b"@echo off\r\nnode \"%~dp0lotus-browser.mjs\" %*\r\n",
    )?;

    Ok(env)
}

pub fn install_lotus_browser_skill() -> io::Result<PathBuf> {
    let dir = paths::claude_dir().join("skills").join("lotus-browser");
    fs::create_dir_all(&dir)?;
    let path = dir.join("SKILL.md");
    fs::write(&path, LOTUS_BROWSER_SKILL)?;
    Ok(path)
}

/// The Lotus-owned block, fenced by [`BLOCK_BEGIN`]/[`BLOCK_END`].
fn managed_block() -> String {
    format!(
        "{BLOCK_BEGIN}\n{}\n{BLOCK_END}",
        LOTUS_BROWSER_AGENTS_BLOCK.trim()
    )
}

/// Insert or replace the managed block in a markdown instruction file, leaving
/// all user content intact. Pure and idempotent: applying twice is a no-op.
pub fn apply_managed_block(existing: &str, block: &str) -> String {
    if let (Some(start), Some(end_idx)) = (existing.find(BLOCK_BEGIN), existing.find(BLOCK_END)) {
        // Replace the span from BEGIN through END (+ marker length) in place.
        let end = end_idx + BLOCK_END.len();
        if end > start {
            let mut out = String::with_capacity(existing.len());
            out.push_str(&existing[..start]);
            out.push_str(block);
            out.push_str(&existing[end..]);
            return out;
        }
    }
    // No existing block: append, preserving the user's content and a blank line.
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        let sep = if existing.ends_with("\n\n") {
            ""
        } else if existing.ends_with('\n') {
            "\n"
        } else {
            "\n\n"
        };
        format!("{existing}{sep}{block}\n")
    }
}

// The uninstall inverse of [`apply_managed_block`]. Kept (and tested) so a future
// uninstall/disable flow can cleanly remove the managed block; not wired into a
// teardown path yet.
#[allow(dead_code)]
/// Inverse of [`apply_managed_block`] — remove a Lotus block (and the blank line
/// it introduced) while leaving user content untouched.
pub fn strip_managed_block(existing: &str) -> String {
    let (Some(start), Some(end_idx)) = (existing.find(BLOCK_BEGIN), existing.find(BLOCK_END))
    else {
        return existing.to_string();
    };
    let end = end_idx + BLOCK_END.len();
    if end <= start {
        return existing.to_string();
    }
    let mut out = String::with_capacity(existing.len());
    out.push_str(existing[..start].trim_end_matches('\n'));
    let tail = existing[end..].trim_start_matches('\n');
    if !out.is_empty() && !tail.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(tail);
    out
}

/// Where each non-Claude provider expects its global instruction block, and
/// whether the block should carry Cursor `.mdc` frontmatter. Only providers
/// whose home directory already exists are targeted — we never bootstrap a
/// provider the user has not installed.
fn agent_instruction_targets() -> Vec<(PathBuf, bool)> {
    let mut targets = Vec::new();
    let codex = paths::codex_dir();
    if codex.is_dir() {
        targets.push((codex.join("AGENTS.md"), false));
    }
    let gemini = paths::gemini_dir();
    if gemini.is_dir() {
        targets.push((gemini.join("GEMINI.md"), false));
    }
    let cursor = paths::cursor_dir();
    if cursor.is_dir() {
        targets.push((cursor.join("rules").join("lotus-browser.mdc"), true));
    }
    targets
}

/// Cursor rules are whole managed files, so they get frontmatter that scopes the
/// rule to browser-flavored requests instead of loading on every turn.
fn cursor_rule_document(block: &str) -> String {
    format!(
        "---\ndescription: Use the paired Lotus Canvas Browser Node for live web QA\nalwaysApply: false\n---\n\n{block}\n"
    )
}

/// Install the browser-discovery block into every installed non-Claude provider's
/// global instruction file. Idempotent across restarts; returns the files written.
pub fn install_agent_browser_instructions() -> io::Result<Vec<PathBuf>> {
    let block = managed_block();
    let mut written = Vec::new();
    for (path, is_cursor) in agent_instruction_targets() {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let next = if is_cursor {
            // The whole file is Lotus-owned; overwrite wholesale.
            cursor_rule_document(&block)
        } else {
            let prior = fs::read_to_string(&path).unwrap_or_default();
            apply_managed_block(&prior, &block)
        };
        let already = fs::read_to_string(&path)
            .map(|cur| cur == next)
            .unwrap_or(false);
        if !already {
            fs::write(&path, next)?;
        }
        written.push(path);
    }
    Ok(written)
}

fn write_executable(path: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn install_writes_script_and_wrapper_into_lotus_bin() {
        let _g = crate::paths::TEST_ENV_LOCK
            .lock()
            .expect("lock helper env tests");
        let previous_home = std::env::var_os("HOME");
        let home = std::env::temp_dir().join("lotus_browser_helper_install_home");
        std::env::set_var("HOME", &home);

        let env = install_lotus_browser_helper().expect("install helper");

        assert!(env.script_path.is_file());
        assert!(fs::read_to_string(&env.script_path)
            .unwrap()
            .contains("lotus-browser"));
        #[cfg(unix)]
        assert!(env.bin_dir.join("lotus-browser").is_file());
        #[cfg(windows)]
        assert!(env.bin_dir.join("lotus-browser.cmd").is_file());

        match previous_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn managed_block_appends_then_replaces_idempotently() {
        let block = managed_block();
        assert!(block.starts_with(BLOCK_BEGIN));
        assert!(block.trim_end().ends_with(BLOCK_END));

        // Append into user content.
        let prior = "# My agents\n\nSome house rules.\n";
        let once = apply_managed_block(prior, &block);
        assert!(once.contains("# My agents"));
        assert!(once.contains("Some house rules."));
        assert!(once.contains("Lotus Canvas Browser"));
        assert_eq!(once.matches(BLOCK_BEGIN).count(), 1);

        // Re-applying replaces in place — no duplicate block, user content kept.
        let twice = apply_managed_block(&once, &block);
        assert_eq!(twice, once);
        assert_eq!(twice.matches(BLOCK_BEGIN).count(), 1);
        assert!(twice.starts_with("# My agents"));
    }

    #[test]
    fn managed_block_replaces_stale_content_between_markers() {
        let stale = format!("intro\n\n{BLOCK_BEGIN}\nOLD BODY\n{BLOCK_END}\n\noutro\n");
        let fresh = apply_managed_block(&stale, &managed_block());
        assert!(!fresh.contains("OLD BODY"));
        assert!(fresh.contains("Lotus Canvas Browser"));
        assert!(fresh.starts_with("intro"));
        assert!(fresh.trim_end().ends_with("outro"));
    }

    #[test]
    fn strip_managed_block_removes_only_lotus_span() {
        let doc = format!("keep-top\n\n{BLOCK_BEGIN}\nbody\n{BLOCK_END}\n\nkeep-bottom\n");
        let stripped = strip_managed_block(&doc);
        assert!(!stripped.contains(BLOCK_BEGIN));
        assert!(!stripped.contains("body"));
        assert!(stripped.contains("keep-top"));
        assert!(stripped.contains("keep-bottom"));
        // Idempotent when no block present.
        assert_eq!(strip_managed_block(&stripped), stripped);
    }

    #[test]
    fn install_agent_instructions_targets_only_existing_providers() {
        let _g = crate::paths::TEST_ENV_LOCK
            .lock()
            .expect("lock helper env tests");
        let previous_home = std::env::var_os("HOME");
        let home =
            std::env::temp_dir().join(format!("lotus_agent_instr_home_{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        // Only Codex is "installed"; Gemini and Cursor dirs are absent.
        fs::create_dir_all(home.join(".codex")).unwrap();
        std::env::set_var("HOME", &home);

        let written = install_agent_browser_instructions().expect("install");

        let agents = home.join(".codex/AGENTS.md");
        assert!(agents.is_file());
        assert!(written.contains(&agents));
        assert!(!home.join(".gemini/GEMINI.md").exists());
        assert!(!home.join(".cursor/rules/lotus-browser.mdc").exists());
        let body = fs::read_to_string(&agents).unwrap();
        assert!(body.contains(BLOCK_BEGIN));
        assert!(body.contains("lotus-browser open"));

        let _ = fs::remove_dir_all(&home);
        match previous_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn install_writes_claude_skill_for_interactive_terminal_discovery() {
        let _g = crate::paths::TEST_ENV_LOCK
            .lock()
            .expect("lock helper env tests");
        let previous_home = std::env::var_os("HOME");
        let home = std::env::temp_dir().join("lotus_browser_skill_install_home");
        std::env::set_var("HOME", &home);

        let path = install_lotus_browser_skill().expect("install skill");

        assert_eq!(path, home.join(".claude/skills/lotus-browser/SKILL.md"));
        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains("name: lotus-browser"));
        assert!(content.contains("lotus-browser open"));
        assert!(content.contains("AGENT_CANVAS_TERMINAL_ID"));
        assert!(content.contains("Do not satisfy \"canvas browser\" requests by opening Chrome"));

        match previous_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
