use super::paths::{relative_to_root, resolve_child_from_root, resolve_project_root};
use super::{DEFAULT_DIRECTORY_DEPTH, MAX_DIRECTORY_DEPTH, MAX_DIRECTORY_ENTRIES};
use std::fs;
use std::path::Path;

/// List directory tree.
pub fn list_project_directory(
    project_path: String,
    relative_path: Option<String>,
    max_depth: Option<u32>,
) -> Result<Vec<String>, String> {
    let root = resolve_project_root(&project_path)?;
    let target = match relative_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        Some(path) => resolve_child_from_root(&root, path)?,
        None => root.clone(),
    };

    if !target.is_dir() {
        return Err(format!(
            "Project path `{}` is not a directory.",
            target.display()
        ));
    }

    let max_depth = max_depth
        .unwrap_or(DEFAULT_DIRECTORY_DEPTH)
        .min(MAX_DIRECTORY_DEPTH);
    let mut entries = Vec::new();
    walk_dir(&target, &root, max_depth, 0, &mut entries)?;
    entries.sort();
    Ok(entries)
}

fn walk_dir(
    dir: &Path,
    root: &Path,
    max_depth: u32,
    current_depth: u32,
    entries: &mut Vec<String>,
) -> Result<(), String> {
    if current_depth >= max_depth || entries.len() >= MAX_DIRECTORY_ENTRIES {
        return Ok(());
    }

    let read_dir = fs::read_dir(dir)
        .map_err(|error| format!("Failed to read dir `{}`: {error}", dir.display()))?;

    for entry in read_dir.flatten() {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            break;
        }

        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        if should_skip_entry(&file_name, &path) {
            continue;
        }

        entries.push(relative_to_root(root, &path));

        if is_descendable_directory(&path) {
            walk_dir(&path, root, max_depth, current_depth + 1, entries)?;
        }
    }

    Ok(())
}

fn should_skip_entry(file_name: &str, path: &Path) -> bool {
    file_name.starts_with('.')
        || file_name == "node_modules"
        || file_name == "target"
        || file_name == ".next"
        || fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(true)
}

fn is_descendable_directory(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "lotus-codechat-listing-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ))
    }

    #[cfg(unix)]
    #[test]
    fn list_project_directory_does_not_follow_symlinked_directories() {
        let root = unique_temp_dir("symlink-root");
        let outside = unique_temp_dir("symlink-outside");
        fs::create_dir_all(&root).expect("create root");
        fs::create_dir_all(&outside).expect("create outside");
        fs::write(outside.join("secret.txt"), "secret").expect("write outside");
        std::os::unix::fs::symlink(&outside, root.join("linked")).expect("create symlink");

        let entries = list_project_directory(root.to_string_lossy().into_owned(), None, Some(4))
            .expect("list root");

        assert!(!entries.iter().any(|entry| entry.contains("secret.txt")));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
