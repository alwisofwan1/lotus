//! Typed remote-operation errors for SSH editor and git commands.
//!
//! `RemoteError` serialises as a discriminated union `{ code: "NOT_FOUND", … }`
//! so TypeScript callers can switch on `code` instead of parsing error strings.

use std::fmt;

use serde::Serialize;

use crate::cli_tools::read_command_error;
use crate::ssh_error_hints::{ssh_error_hint, SshErrorCategory};

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RemoteError {
    NotFound,
    ParentNotFound,
    Escape,
    NotAFile,
    AlreadyExists,
    IsRoot,
    MtimeConflict { current_mtime: Option<i64> },
    TooLarge { size: u64, limit: u64 },
    AuthFailure,
    Timeout,
    Other { message: String },
}

impl std::error::Error for RemoteError {}

impl fmt::Display for RemoteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RemoteError::NotFound => write!(f, "Remote path not found."),
            RemoteError::ParentNotFound => write!(f, "Remote parent directory does not exist."),
            RemoteError::Escape => write!(f, "Remote path escapes the workspace root."),
            RemoteError::NotAFile => write!(f, "Remote path is not a regular file."),
            RemoteError::AlreadyExists => write!(f, "Remote path already exists."),
            RemoteError::IsRoot => write!(f, "Refusing to delete the workspace root."),
            RemoteError::MtimeConflict { .. } => {
                write!(f, "Remote file changed since it was opened.")
            }
            RemoteError::TooLarge { limit, .. } => {
                write!(f, "Remote file exceeds the {limit}-byte editor limit.")
            }
            RemoteError::AuthFailure => write!(f, "SSH authentication failed."),
            RemoteError::Timeout => write!(f, "SSH connection timed out."),
            RemoteError::Other { message } => write!(f, "{message}"),
        }
    }
}

/// Convert a failed SSH command output into a typed `RemoteError`.
///
/// `size_limit` is the constant used for `TooLarge::limit` — callers pass
/// their module-local `MAX_REMOTE_FILE_SIZE_BYTES` so this function stays
/// pure and easily testable.
///
/// Expected stderr formats from shell scripts:
/// - `"NOT_FOUND\n"` — path missing
/// - `"MTIME_CONFLICT\n<current_ms>\n"` — optimistic mtime guard failed
/// - `"TOO_LARGE\n<actual_bytes>\n"` — file exceeds size cap
/// - All other tags are unit-only (`"ESCAPE\n"`, `"NOT_A_FILE\n"`, etc.)
/// - Unrecognised stderr is classified by [`ssh_error_hint`].
pub fn map_remote_error_typed(output: &std::process::Output, size_limit: u64) -> RemoteError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut non_empty = stderr.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = non_empty.next().unwrap_or("");
    let second = non_empty.next();

    match first {
        "NOT_FOUND" => RemoteError::NotFound,
        "PARENT_NOT_FOUND" => RemoteError::ParentNotFound,
        "ESCAPE" => RemoteError::Escape,
        "NOT_A_FILE" => RemoteError::NotAFile,
        "ALREADY_EXISTS" => RemoteError::AlreadyExists,
        "IS_ROOT" => RemoteError::IsRoot,
        "MTIME_CONFLICT" => RemoteError::MtimeConflict {
            current_mtime: second.and_then(|s| s.parse::<i64>().ok()),
        },
        "TOO_LARGE" => RemoteError::TooLarge {
            size: second.and_then(|s| s.parse::<u64>().ok()).unwrap_or(0),
            limit: size_limit,
        },
        _ => {
            let hint = ssh_error_hint(&stderr, None);
            match hint.category {
                SshErrorCategory::AuthFailed => RemoteError::AuthFailure,
                SshErrorCategory::ProxyCommandStalled | SshErrorCategory::BannerTimeout => {
                    RemoteError::Timeout
                }
                _ if hint.confident => RemoteError::Other {
                    message: hint.message,
                },
                _ => RemoteError::Other {
                    message: read_command_error(output),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_output(stderr: &str) -> std::process::Output {
        std::process::Output {
            status: std::os::unix::process::ExitStatusExt::from_raw(2 << 8),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    const LIMIT: u64 = 10 * 1024 * 1024;

    // ── Known stderr tags ─────────────────────────────────────────────────────

    #[test]
    fn not_found_maps_to_not_found_variant() {
        assert_eq!(
            map_remote_error_typed(&make_output("NOT_FOUND\n"), LIMIT),
            RemoteError::NotFound
        );
    }

    #[test]
    fn parent_not_found_maps_correctly() {
        assert_eq!(
            map_remote_error_typed(&make_output("PARENT_NOT_FOUND\n"), LIMIT),
            RemoteError::ParentNotFound
        );
    }

    #[test]
    fn escape_maps_correctly() {
        assert_eq!(
            map_remote_error_typed(&make_output("ESCAPE\n"), LIMIT),
            RemoteError::Escape
        );
    }

    #[test]
    fn not_a_file_maps_correctly() {
        assert_eq!(
            map_remote_error_typed(&make_output("NOT_A_FILE\n"), LIMIT),
            RemoteError::NotAFile
        );
    }

    #[test]
    fn already_exists_maps_correctly() {
        assert_eq!(
            map_remote_error_typed(&make_output("ALREADY_EXISTS\n"), LIMIT),
            RemoteError::AlreadyExists
        );
    }

    #[test]
    fn is_root_maps_correctly() {
        assert_eq!(
            map_remote_error_typed(&make_output("IS_ROOT\n"), LIMIT),
            RemoteError::IsRoot
        );
    }

    // ── MTIME_CONFLICT ────────────────────────────────────────────────────────

    #[test]
    fn mtime_conflict_parses_current_mtime_from_second_line() {
        let err = map_remote_error_typed(&make_output("MTIME_CONFLICT\n1714838400000\n"), LIMIT);
        assert_eq!(
            err,
            RemoteError::MtimeConflict {
                current_mtime: Some(1714838400000)
            }
        );
    }

    #[test]
    fn mtime_conflict_without_second_line_sets_mtime_to_none() {
        let err = map_remote_error_typed(&make_output("MTIME_CONFLICT\n"), LIMIT);
        assert_eq!(
            err,
            RemoteError::MtimeConflict {
                current_mtime: None
            }
        );
    }

    #[test]
    fn mtime_conflict_with_non_numeric_second_line_sets_mtime_to_none() {
        let err = map_remote_error_typed(&make_output("MTIME_CONFLICT\nnot-a-number\n"), LIMIT);
        assert_eq!(
            err,
            RemoteError::MtimeConflict {
                current_mtime: None
            }
        );
    }

    // ── TOO_LARGE ─────────────────────────────────────────────────────────────

    #[test]
    fn too_large_parses_size_and_uses_provided_limit() {
        let err = map_remote_error_typed(&make_output("TOO_LARGE\n11534336\n"), LIMIT);
        assert_eq!(
            err,
            RemoteError::TooLarge {
                size: 11_534_336,
                limit: LIMIT
            }
        );
    }

    #[test]
    fn too_large_without_size_line_defaults_size_to_zero() {
        let err = map_remote_error_typed(&make_output("TOO_LARGE\n"), LIMIT);
        assert_eq!(
            err,
            RemoteError::TooLarge {
                size: 0,
                limit: LIMIT
            }
        );
    }

    // ── SSH connection errors ─────────────────────────────────────────────────

    #[test]
    fn auth_failure_maps_to_auth_failure_variant() {
        let stderr = "Permission denied (publickey).\n";
        let err = map_remote_error_typed(&make_output(stderr), LIMIT);
        assert_eq!(err, RemoteError::AuthFailure);
    }

    #[test]
    fn proxy_command_stalled_maps_to_timeout_variant() {
        let stderr = "Connection to UNKNOWN port 65535 timed out\n";
        let err = map_remote_error_typed(&make_output(stderr), LIMIT);
        assert_eq!(err, RemoteError::Timeout);
    }

    #[test]
    fn banner_timeout_maps_to_timeout_variant() {
        let stderr = "Connection timed out during banner exchange\n";
        let err = map_remote_error_typed(&make_output(stderr), LIMIT);
        assert_eq!(err, RemoteError::Timeout);
    }

    #[test]
    fn known_connection_error_with_confident_hint_maps_to_other_with_hint_message() {
        let stderr = "ssh: Could not resolve hostname bad-host: nodename nor servname provided\n";
        let err = map_remote_error_typed(&make_output(stderr), LIMIT);
        match err {
            RemoteError::Other { message } => {
                assert!(
                    message.contains("hostname") || message.contains("resolve"),
                    "expected hostname hint, got: {message}"
                );
            }
            other => panic!("expected Other, got {other:?}"),
        }
    }

    #[test]
    fn unknown_stderr_maps_to_other_with_raw_text() {
        let stderr = "some completely unknown error\n";
        let err = map_remote_error_typed(&make_output(stderr), LIMIT);
        match err {
            RemoteError::Other { message } => {
                assert!(message.contains("some completely unknown error"));
            }
            other => panic!("expected Other, got {other:?}"),
        }
    }

    // ── Display (human-readable strings) ─────────────────────────────────────

    #[test]
    fn display_variants_produce_human_readable_strings() {
        assert_eq!(RemoteError::NotFound.to_string(), "Remote path not found.");
        assert_eq!(
            RemoteError::ParentNotFound.to_string(),
            "Remote parent directory does not exist."
        );
        assert_eq!(
            RemoteError::TooLarge {
                size: 0,
                limit: LIMIT
            }
            .to_string(),
            format!("Remote file exceeds the {LIMIT}-byte editor limit.")
        );
        assert_eq!(
            RemoteError::MtimeConflict {
                current_mtime: Some(0)
            }
            .to_string(),
            "Remote file changed since it was opened."
        );
    }

    // ── Serde shape ───────────────────────────────────────────────────────────

    #[test]
    fn not_found_serialises_to_discriminated_union_with_code_field() {
        let json = serde_json::to_value(&RemoteError::NotFound).unwrap();
        assert_eq!(json["code"], "NOT_FOUND");
    }

    #[test]
    fn too_large_serialises_with_size_and_limit_fields() {
        let json = serde_json::to_value(&RemoteError::TooLarge {
            size: 500,
            limit: LIMIT,
        })
        .unwrap();
        assert_eq!(json["code"], "TOO_LARGE");
        assert_eq!(json["size"], 500);
        assert_eq!(json["limit"], LIMIT);
    }

    #[test]
    fn mtime_conflict_serialises_with_current_mtime_field() {
        let json = serde_json::to_value(&RemoteError::MtimeConflict {
            current_mtime: Some(12345),
        })
        .unwrap();
        assert_eq!(json["code"], "MTIME_CONFLICT");
        assert_eq!(json["current_mtime"], 12345);
    }

    #[test]
    fn mtime_conflict_none_serialises_current_mtime_as_null() {
        let json = serde_json::to_value(&RemoteError::MtimeConflict {
            current_mtime: None,
        })
        .unwrap();
        assert_eq!(json["code"], "MTIME_CONFLICT");
        assert!(json["current_mtime"].is_null());
    }

    #[test]
    fn auth_failure_serialises_as_screaming_snake_case_code() {
        let json = serde_json::to_value(&RemoteError::AuthFailure).unwrap();
        assert_eq!(json["code"], "AUTH_FAILURE");
    }
}
