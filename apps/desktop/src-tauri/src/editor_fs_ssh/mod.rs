//! SSH-backed editor filesystem operations.
//!
//! Mirrors the local `editor_fs` API surface but executes against a remote
//! host via the system `ssh` binary. The module is organised as:
//!
//! - [`script`] — pure shell-script builders (deterministic, easily testable).
//! - [`parse`]  — pure stdout parsers turning script output into typed values.
//! - [`validate`] — relative-path sandbox checks shared by the public commands.
//! - this file — the side-effectful top-level commands wired into Tauri.
//!
//! Pure functions are unit tested. The integration paths against a real SSH
//! host are exercised in `tests/ssh_integration.rs` (gated behind a feature
//! flag, see `plans/ssh-right-panel/06-testing.md`).

mod parse;
mod script;
mod validate;

pub(crate) use parse::{
    parse_remote_list_output, parse_remote_path_output, parse_remote_read_output,
    parse_remote_write_output,
};
pub(crate) use script::{
    build_remote_create_directory_script, build_remote_create_file_script,
    build_remote_delete_script, build_remote_list_script, build_remote_read_bytes_script,
    build_remote_read_script,
    build_remote_rename_script, build_remote_write_script,
};
pub(crate) use validate::validate_relative_path;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use crate::cli_tools::{
    run_ssh_shell_command, run_ssh_shell_command_with_stdin, validate_remote_cwd, SshCommandMode,
    SshToolTarget,
};
use crate::editor_fs::{
    EditorCreateEntryResult, EditorListEntry, EditorReadFileResult, EditorWriteFileResult,
};
use crate::error::AppError;
use crate::remote_capability::StatVariant;
use crate::remote_error::map_remote_error_typed;
use crate::remote_transport::RemoteTransport;

/// Hard cap on remote file size accepted by the editor (10 MiB).
///
/// Mirrors `editor_fs::MAX_EDITOR_FILE_SIZE_BYTES` so behaviour matches local mode.
pub(crate) const MAX_REMOTE_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;

/// Find in files under the remote workspace root.
pub fn editor_search_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    query: crate::editor_search::EditorSearchQuery,
    transport: Option<&RemoteTransport>,
) -> Result<crate::editor_search::EditorSearchResult, AppError> {
    let cwd = validate_remote_cwd(&remote_cwd)?;
    // A bad regex is reported here, before anything runs on the host.
    let matcher = crate::editor_search::build_matcher(&query)?;
    let script = crate::editor_search::build_remote_search_script(cwd, &query);
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, MAX_REMOTE_FILE_SIZE_BYTES).into());
    }
    crate::editor_search::parse_remote_search_output(cwd, &output.stdout, &matcher)
}

/// List entries under the remote workspace root.
pub fn editor_list_entries_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    max_depth: Option<u32>,
    transport: Option<&RemoteTransport>,
) -> Result<Vec<EditorListEntry>, AppError> {
    let cwd = validate_remote_cwd(&remote_cwd)?;
    let script = build_remote_list_script(cwd, max_depth);
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, MAX_REMOTE_FILE_SIZE_BYTES).into());
    }
    Ok(parse_remote_list_output(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

/// Read a single file under the remote workspace root.
pub fn editor_read_file_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    relative_path: String,
    allow_large: bool,
    transport: Option<&RemoteTransport>,
    stat_variant: Option<StatVariant>,
) -> Result<EditorReadFileResult, AppError> {
    let cwd = validate_remote_cwd(&remote_cwd)?;
    let rel = validate_relative_path(&relative_path)?;
    let script = build_remote_read_script(
        cwd,
        &rel,
        crate::editor_fs::text_size_cap(allow_large),
        stat_variant,
    );
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, MAX_REMOTE_FILE_SIZE_BYTES).into());
    }
    parse_remote_read_output(&output.stdout)
}

/// The raw bytes of a remote file, for the media viewer (capped at
/// `editor_fs::MAX_EDITOR_MEDIA_SIZE_BYTES`).
pub fn editor_read_file_bytes_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    relative_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<Vec<u8>, AppError> {
    let cwd = validate_remote_cwd(&remote_cwd)?;
    let rel = validate_relative_path(&relative_path)?;
    let script = build_remote_read_bytes_script(cwd, &rel);
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(
            map_remote_error_typed(&output, crate::editor_fs::MAX_EDITOR_MEDIA_SIZE_BYTES).into(),
        );
    }
    let trimmed: Vec<u8> = output
        .stdout
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    BASE64
        .decode(&trimmed)
        .map_err(|err| AppError::Other(format!("Failed to decode remote file content: {err}")))
}

/// Write content to a remote file with optimistic mtime concurrency, in the file's `encoding`.
#[allow(clippy::too_many_arguments)]
pub fn editor_write_file_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    relative_path: String,
    content: String,
    expected_mtime: Option<i64>,
    encoding: Option<String>,
    transport: Option<&RemoteTransport>,
    stat_variant: Option<StatVariant>,
) -> Result<EditorWriteFileResult, AppError> {
    let cwd = validate_remote_cwd(&remote_cwd)?;
    let rel = validate_relative_path(&relative_path)?;
    let bytes = crate::editor_encoding::encode(&content, encoding.as_deref())?;
    // A file opened with "Open anyway" can be saved; the cap is the large-file one.
    let limit = crate::editor_fs::MAX_EDITOR_LARGE_FILE_SIZE_BYTES;
    if (bytes.len() as u64) > limit {
        return Err(crate::remote_error::RemoteError::TooLarge {
            size: bytes.len() as u64,
            limit,
        }
        .into());
    }
    let script = build_remote_write_script(cwd, &rel, expected_mtime, stat_variant);
    let payload = BASE64.encode(&bytes);
    let output = run_ssh_shell_command_with_stdin(
        &target,
        &script,
        SshCommandMode::NoTty,
        payload.as_bytes(),
        transport,
    )?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, limit).into());
    }
    parse_remote_write_output(&output.stdout)
}

/// Create an empty file at `relative_path` (fails if anything already exists).
pub fn editor_create_file_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    relative_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<EditorCreateEntryResult, AppError> {
    run_path_emitting_script(
        &target,
        &remote_cwd,
        &relative_path,
        build_remote_create_file_script,
        transport,
    )
}

/// Create a directory at `relative_path` (idempotent via `mkdir -p`).
pub fn editor_create_directory_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    relative_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<EditorCreateEntryResult, AppError> {
    run_path_emitting_script(
        &target,
        &remote_cwd,
        &relative_path,
        build_remote_create_directory_script,
        transport,
    )
}

/// Delete a file or directory at `relative_path` (refuses to delete the root).
pub fn editor_delete_entry_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    relative_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<EditorCreateEntryResult, AppError> {
    run_path_emitting_script(
        &target,
        &remote_cwd,
        &relative_path,
        build_remote_delete_script,
        transport,
    )
}

/// Rename / move a file or directory inside the remote workspace root.
pub fn editor_rename_entry_ssh(
    target: SshToolTarget,
    remote_cwd: String,
    from_relative_path: String,
    to_relative_path: String,
    transport: Option<&RemoteTransport>,
) -> Result<EditorCreateEntryResult, AppError> {
    let cwd = validate_remote_cwd(&remote_cwd)?;
    let from = validate_relative_path(&from_relative_path)?;
    let to = validate_relative_path(&to_relative_path)?;
    let script = build_remote_rename_script(cwd, &from, &to);
    let output = run_ssh_shell_command(&target, &script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, MAX_REMOTE_FILE_SIZE_BYTES).into());
    }
    parse_remote_path_output(&output.stdout)
}

fn run_path_emitting_script(
    target: &SshToolTarget,
    remote_cwd: &str,
    relative_path: &str,
    builder: fn(&str, &str) -> String,
    transport: Option<&RemoteTransport>,
) -> Result<EditorCreateEntryResult, AppError> {
    let cwd = validate_remote_cwd(remote_cwd)?;
    let rel = validate_relative_path(relative_path)?;
    let script = builder(cwd, &rel);
    let output = run_ssh_shell_command(target, &script, SshCommandMode::NoTty, transport)?;
    if !output.status.success() {
        return Err(map_remote_error_typed(&output, MAX_REMOTE_FILE_SIZE_BYTES).into());
    }
    parse_remote_path_output(&output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_error::RemoteError;

    #[test]
    fn write_pre_validates_oversize_content_locally() {
        let limit = crate::editor_fs::MAX_EDITOR_LARGE_FILE_SIZE_BYTES;
        let huge = "x".repeat((limit + 1) as usize);
        let result = editor_write_file_ssh(
            SshToolTarget {
                host: "host".into(),
                user: None,
                port: None,
            },
            "/repo".into(),
            "x.txt".into(),
            huge,
            None,
            None,
            None,
            None,
        );
        let err = result.expect_err("oversize content must be rejected before SSH");
        assert!(
            matches!(
                err,
                AppError::Remote(RemoteError::TooLarge { limit: l, .. }) if l == limit
            ),
            "expected AppError::Remote(TooLarge), got {err:?}"
        );
    }
}
