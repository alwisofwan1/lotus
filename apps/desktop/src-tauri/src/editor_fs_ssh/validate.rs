//! Path validation shared by SSH editor commands.
//!
//! These checks run **client-side**, before any SSH round-trip, so an obviously
//! malformed request is rejected fast. The remote-side `realpath -e` check in
//! [`super::script::build_remote_read_script`] is the second line of defence
//! against symlink escape — both are required.

use crate::error::AppError;

/// Reject relative paths that escape the workspace root.
///
/// Returns the cleaned forward-slash relative path on success. The result is
/// safe to interpolate into a remote shell script after `quote_shell_arg`.
pub(crate) fn validate_relative_path(input: &str) -> Result<String, AppError> {
    let normalized = input.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(AppError::Other("Path cannot be empty".to_string()));
    }
    if normalized.starts_with('/') {
        return Err(AppError::Other(
            "Path must be relative to the workspace".to_string(),
        ));
    }

    let mut clean: Vec<&str> = Vec::new();
    for segment in normalized.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                return Err(AppError::Other(
                    "Path must stay inside the workspace".to_string(),
                ));
            }
            other => clean.push(other),
        }
    }

    if clean.is_empty() {
        return Err(AppError::Other("Path cannot be empty".to_string()));
    }

    Ok(clean.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_simple_relative_path() {
        assert_eq!(
            validate_relative_path("src/main.rs").expect("ok"),
            "src/main.rs"
        );
    }

    #[test]
    fn normalizes_backslashes_and_collapses_current_dir() {
        assert_eq!(
            validate_relative_path("src\\.\\foo/bar.txt").expect("ok"),
            "src/foo/bar.txt"
        );
    }

    #[test]
    fn rejects_empty_path() {
        assert!(validate_relative_path("").is_err());
        assert!(validate_relative_path("   ").is_err());
        assert!(validate_relative_path("./").is_err());
    }

    #[test]
    fn rejects_absolute_path() {
        assert!(validate_relative_path("/etc/passwd").is_err());
    }

    #[test]
    fn rejects_parent_traversal() {
        assert!(validate_relative_path("..").is_err());
        assert!(validate_relative_path("../etc/passwd").is_err());
        assert!(validate_relative_path("src/../../etc").is_err());
    }
}
