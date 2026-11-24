use std::fs;
use std::path::{Component, Path, PathBuf};

pub(crate) fn resolve_project_root(project_path: &str) -> Result<PathBuf, String> {
    let root = Path::new(project_path);
    if !root.is_dir() {
        return Err(format!("Project path `{project_path}` is not a directory."));
    }

    fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve project path `{project_path}`: {error}"))
}

pub(crate) fn resolve_project_child(
    project_path: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let root = resolve_project_root(project_path)?;
    resolve_child_from_root(&root, relative_path)
}

pub(crate) fn resolve_child_from_root(
    canonical_root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let child = Path::new(relative_path);
    if child.as_os_str().is_empty() {
        return Ok(canonical_root.to_path_buf());
    }
    if child.is_absolute() || has_forbidden_component(child) {
        return Err(format!(
            "Project path `{relative_path}` must be relative and stay inside the project."
        ));
    }

    let unresolved = canonical_root.join(child);
    let resolved = fs::canonicalize(&unresolved).map_err(|error| {
        format!(
            "Failed to resolve project path `{}`: {error}",
            unresolved.display()
        )
    })?;

    if !resolved.starts_with(canonical_root) {
        return Err(format!(
            "Project path `{relative_path}` resolves outside the project."
        ));
    }

    Ok(resolved)
}

pub(crate) fn relative_to_root(canonical_root: &Path, path: &Path) -> String {
    path.strip_prefix(canonical_root)
        .unwrap_or(path)
        .to_string_lossy()
        .trim_start_matches("./")
        .to_string()
}

pub(crate) fn normalize_rg_path(path: &str) -> String {
    path.trim_start_matches("./").replace('\\', "/")
}

fn has_forbidden_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::Prefix(_) | Component::RootDir
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lotus-codechat-tools-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ))
    }

    #[test]
    fn resolve_project_child_rejects_parent_traversal() {
        let root = unique_temp_dir("traversal");
        fs::create_dir_all(&root).expect("create root");

        let error = resolve_project_child(root.to_str().expect("root str"), "../outside")
            .expect_err("parent traversal must be rejected");

        assert!(error.contains("must be relative"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_child_rejects_absolute_path() {
        let root = unique_temp_dir("absolute");
        fs::create_dir_all(&root).expect("create root");

        let error = resolve_project_child(
            root.to_str().expect("root str"),
            root.join("child").to_str().expect("child str"),
        )
        .expect_err("absolute path must be rejected");

        assert!(error.contains("must be relative"));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn resolve_project_child_rejects_symlink_escape() {
        let root = unique_temp_dir("symlink-root");
        let outside = unique_temp_dir("symlink-outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        fs::write(outside.join("secret.txt"), "secret").expect("write outside");
        std::os::unix::fs::symlink(&outside, root.join("linked")).expect("create symlink");

        let error = resolve_project_child(root.to_str().expect("root str"), "linked/secret.txt")
            .expect_err("symlink escape must be rejected");

        assert!(error.contains("outside the project"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
