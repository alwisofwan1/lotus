//! Factory setup and configuration lifecycle. No project scripts execute here.
use super::{edit, kit::KitSources, FactoryDefinition, FACTORY_FILE};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckSuggestion {
    pub label: String,
    pub command: String,
    pub evidence: String,
}

pub fn suggest_checks(checkout: &Path) -> Result<Vec<CheckSuggestion>, String> {
    super::check_discovery::discover(checkout)
}

pub fn validate_gate(gate: &str) -> Result<&str, String> {
    if gate.trim().is_empty() || gate.len() > 4096 || gate.chars().any(|c| c.is_control()) {
        return Err(
            "Enter one non-empty check command, without control characters (maximum 4096 bytes)"
                .into(),
        );
    }
    Ok(gate.trim())
}

pub fn save_gate(dir: &Path, gate: &str, private: bool) -> Result<FactoryDefinition, String> {
    #[derive(serde::Deserialize)]
    struct Gate {
        gate: toml::Spanned<String>,
    }
    let gate = validate_gate(gate)?;
    let file = dir.join(FACTORY_FILE);
    let mut text =
        std::fs::read_to_string(&file).map_err(|_| "Cannot read Factory configuration")?;
    let parsed: Gate = toml::from_str(&text)
        .map_err(|_| "Repair the Factory configuration before editing checks")?;
    text.replace_range(
        parsed.gate.span(),
        &serde_json::to_string(gate).map_err(|_| "Cannot encode check command")?,
    );
    edit::write_checked(dir, FACTORY_FILE, Some(text)).map(|d| FactoryDefinition { private, ..d })
}

// Refuse symlinked lifecycle paths, including archive parents. Only derived repo paths enter here.
pub(super) fn checked_path(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Factory path is outside local storage")?;
    let mut current = root.to_path_buf();
    for component in std::iter::once(None).chain(relative.components().map(Some)) {
        if let Some(c) = component {
            current.push(c);
        }
        match std::fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("Factory storage must not contain symlinked directories".into())
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                return Err("Cannot inspect Factory storage".into())
            }
            _ => {}
        }
    }
    Ok(())
}

fn private_paths(
    sources: &KitSources,
    repo: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf), String> {
    let root = sources
        .private_root
        .as_ref()
        .ok_or("Local Factory storage is unavailable")?
        .clone();
    let dir = sources
        .private_dir(repo)
        .ok_or("Choose a valid owner/name repository")?;
    let backups = root.join(".removed").join(repo);
    checked_path(&root, &dir)?;
    checked_path(&root, &backups)?;
    Ok((root, dir, backups))
}

/// Rename, never recursively delete: history, worktrees and repository files live elsewhere.
pub fn archive_private(sources: &KitSources, repo: &str) -> Result<String, String> {
    let (_, dir, backups) = private_paths(sources, repo)?;
    if !dir.join(FACTORY_FILE).is_file() {
        return Err("No local Factory configuration to remove".into());
    }
    std::fs::create_dir_all(&backups).map_err(|_| "Cannot create Factory recovery storage")?;
    let id = uuid::Uuid::new_v4().to_string();
    std::fs::rename(dir, backups.join(&id))
        .map_err(|_| "Cannot remove local Factory configuration")?;
    Ok(id)
}

pub fn restore_private(
    sources: &KitSources,
    repo: &str,
    id: &str,
) -> Result<FactoryDefinition, String> {
    let id = uuid::Uuid::parse_str(id)
        .map_err(|_| "Invalid Factory recovery ID")?
        .to_string();
    let (root, dir, backups) = private_paths(sources, repo)?;
    let backup = backups.join(id);
    checked_path(&root, &backup)?;
    if dir.exists() {
        return Err("A local Factory already exists; recovery will not overwrite it".into());
    }
    let definition = edit::read_private_definition(&backup)?;
    std::fs::rename(backup, dir).map_err(|_| "Cannot restore local Factory configuration")?;
    Ok(definition)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sources(root: &Path) -> KitSources {
        KitSources {
            private_root: Some(root.to_path_buf()),
            ..Default::default()
        }
    }
    #[test]
    fn suggestions_use_declared_manager_and_scripts_without_executing_them() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("package.json"), r#"{"packageManager":"pnpm@10.0.0","scripts":{"test":"touch should-not-exist","typecheck":"tsc"}}"#).unwrap();
        let items = suggest_checks(tmp.path()).unwrap();
        assert_eq!(items[1].command, "pnpm run test");
        assert_eq!(items[0].command, "pnpm run test && pnpm run typecheck");
        assert!(!tmp.path().join("should-not-exist").exists());
        std::fs::write(
            tmp.path().join("package.json"),
            r#"{"scripts":{"test":"vitest run"}}"#,
        )
        .unwrap();
        std::fs::write(tmp.path().join("package-lock.json"), "{}").unwrap();
        assert_eq!(
            suggest_checks(tmp.path()).unwrap()[0].command,
            "npm run test"
        );
        std::fs::write(tmp.path().join("bun.lock"), "").unwrap();
        assert!(
            suggest_checks(tmp.path()).unwrap().is_empty(),
            "ambiguous manager requires custom input"
        );
    }
    #[test]
    fn private_setup_refuses_control_characters_and_oversized_commands() {
        let tmp = tempfile::tempdir().unwrap();
        for bad in ["npm test\r", "test\0", &"x".repeat(4097)] {
            assert!(edit::create_private(tmp.path(), bad).is_err());
            assert!(!tmp.path().join(FACTORY_FILE).exists());
        }
    }
    #[test]
    fn gate_edit_preserves_comments_defaults_and_agents_and_rejects_blank_input() {
        let tmp = tempfile::tempdir().unwrap();
        edit::create_private(tmp.path(), "npm test").unwrap();
        let file = tmp.path().join(".lotus/factory.toml");
        std::fs::write(
            &file,
            "# Keep this\ngate = 'npm test' # chosen check\ncap_usd = 5\n",
        )
        .unwrap();
        let def = save_gate(tmp.path(), " npm run test && npm run typecheck ", true).unwrap();
        assert!(def.private);
        assert_eq!(def.gate, "npm run test && npm run typecheck");
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("# Keep this"));
        assert!(text.contains("# chosen check"));
        assert!(text.contains("cap_usd = 5"));
        for bad in ["", "npm test\nrm x", "npm test\r", "test\0"] {
            assert!(save_gate(tmp.path(), bad, true).is_err());
            assert_eq!(std::fs::read_to_string(&file).unwrap(), text);
        }
    }
    #[test]
    fn removal_is_recoverable_scoped_and_does_not_touch_other_factories() {
        let tmp = tempfile::tempdir().unwrap();
        let s = sources(tmp.path());
        let dir = s.private_dir("acme/app").unwrap();
        let other = s.private_dir("acme/other").unwrap();
        edit::create_private(&dir, "npm test").unwrap();
        edit::create_private(&other, "other-check").unwrap();
        let id = archive_private(&s, "acme/app").unwrap();
        assert!(!dir.exists());
        assert!(other.join(".lotus/factory.toml").exists());
        assert!(restore_private(&s, "acme/other", &id).is_err());
        assert!(restore_private(&s, "acme/app", "../escape").is_err());
        assert_eq!(
            restore_private(&s, "acme/app", &id).unwrap().gate,
            "npm test"
        );
        let id = archive_private(&s, "acme/app").unwrap();
        edit::create_private(&dir, "replacement").unwrap();
        assert!(
            restore_private(&s, "acme/app", &id).is_err(),
            "never overwrite a new factory"
        );
        assert_eq!(
            edit::read_private_definition(&dir).unwrap().gate,
            "replacement"
        );
        assert!(archive_private(&s, "../outside").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn lifecycle_refuses_symlinked_factory_and_suggestions_refuse_external_metadata() {
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let s = sources(tmp.path());
        std::fs::create_dir_all(tmp.path().join("acme")).unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("acme/app")).unwrap();
        edit::create_private(outside.path(), "npm test").unwrap();
        assert!(archive_private(&s, "acme/app").is_err());
        std::fs::write(outside.path().join("package.json"), "{}").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("package.json"),
            tmp.path().join("package.json"),
        )
        .unwrap();
        assert!(suggest_checks(tmp.path()).is_err());
    }
}
