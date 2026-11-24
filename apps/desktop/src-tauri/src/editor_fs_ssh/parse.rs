//! Output parsers for SSH editor commands.
//!
//! All parsers are pure: they accept raw bytes (or a `&str`) from a successful
//! SSH invocation and return typed results without touching the filesystem.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use crate::editor_fs::{
    EditorCreateEntryResult, EditorListEntry, EditorListEntryKind, EditorReadFileResult,
    EditorWriteFileResult,
};
use crate::error::AppError;

/// Parse `find` output of `KIND\tPATH` lines into editor entries.
///
/// Lines that don't match the expected shape are silently dropped — the remote
/// `find` may emit warnings to stderr, but stdout is structurally strict.
pub(crate) fn parse_remote_list_output(stdout: &str) -> Vec<EditorListEntry> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(2, '\t');
            let kind_token = parts.next()?.trim();
            let path = parts.next()?.trim();
            if path.is_empty() {
                return None;
            }
            let kind = match kind_token {
                "file" => EditorListEntryKind::File,
                "directory" => EditorListEntryKind::Directory,
                _ => return None,
            };
            Some(EditorListEntry {
                path: path.to_string(),
                kind,
                ignored: false,
            })
        })
        .collect()
}

/// Parse the read envelope produced by
/// [`super::script::build_remote_read_script`].
///
/// Expected layout:
/// ```text
/// MTIME=<i64 ms>
/// SIZE=<u64 bytes>
/// BINARY=<0|1>
/// [TOO_LARGE=1]
/// ---
/// <base64-encoded content, omitted when BINARY=1>
/// ```
///
/// The content is decoded as the local read decodes it (`editor_encoding`): a Windows-1252 or
/// UTF-16 file is text in its encoding, not an error.
pub(crate) fn parse_remote_read_output(stdout: &[u8]) -> Result<EditorReadFileResult, AppError> {
    let separator = b"---\n";
    let split = stdout
        .windows(separator.len())
        .position(|w| w == separator)
        .ok_or_else(|| AppError::Other("Malformed remote read response".into()))?;
    let header = std::str::from_utf8(&stdout[..split])
        .map_err(|_| AppError::Other("Remote read header is not UTF-8".into()))?;
    let body = &stdout[split + separator.len()..];

    let mut mtime: Option<i64> = None;
    let mut size: Option<u64> = None;
    let mut binary: Option<bool> = None;
    let mut too_large = false;

    for line in header.lines() {
        if let Some(value) = line.strip_prefix("MTIME=") {
            mtime =
                Some(value.trim().parse::<i64>().map_err(|_| {
                    AppError::Other("Invalid MTIME in remote read response".into())
                })?);
        } else if let Some(value) = line.strip_prefix("SIZE=") {
            size = Some(
                value
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| AppError::Other("Invalid SIZE in remote read response".into()))?,
            );
        } else if let Some(value) = line.strip_prefix("BINARY=") {
            binary = Some(value.trim() == "1");
        } else if let Some(value) = line.strip_prefix("TOO_LARGE=") {
            too_large = value.trim() == "1";
        }
    }

    let mtime =
        mtime.ok_or_else(|| AppError::Other("Missing MTIME in remote read response".into()))?;
    let size =
        size.ok_or_else(|| AppError::Other("Missing SIZE in remote read response".into()))?;
    let binary = binary
        .ok_or_else(|| AppError::Other("Missing BINARY flag in remote read response".into()))?;

    if binary {
        return Ok(EditorReadFileResult::not_text(mtime, size, too_large));
    }
    Ok(EditorReadFileResult::from_bytes(
        &decode_base64_content(body)?,
        mtime,
        size,
    ))
}

/// Parse the `NEW_MTIME=<ms>` line emitted by
/// [`super::script::build_remote_write_script`].
pub(crate) fn parse_remote_write_output(stdout: &[u8]) -> Result<EditorWriteFileResult, AppError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|_| AppError::Other("Remote write response is not UTF-8".into()))?;
    let mtime_str = text
        .lines()
        .filter_map(|line| line.strip_prefix("NEW_MTIME="))
        .next()
        .ok_or_else(|| AppError::Other("Remote write did not return NEW_MTIME".into()))?;
    let mtime = mtime_str
        .trim()
        .parse::<i64>()
        .map_err(|_| AppError::Other("Invalid NEW_MTIME in remote write response".into()))?;
    Ok(EditorWriteFileResult { mtime })
}

/// Parse the `PATH=<abs>` line emitted by create/delete scripts.
pub(crate) fn parse_remote_path_output(stdout: &[u8]) -> Result<EditorCreateEntryResult, AppError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|_| AppError::Other("Remote response is not UTF-8".into()))?;
    let path = text
        .lines()
        .filter_map(|line| line.strip_prefix("PATH="))
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| AppError::Other("Remote command did not return PATH".into()))?;
    Ok(EditorCreateEntryResult {
        path: path.to_string(),
    })
}

fn decode_base64_content(body: &[u8]) -> Result<Vec<u8>, AppError> {
    let trimmed: Vec<u8> = body
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    BASE64
        .decode(&trimmed)
        .map_err(|err| AppError::Other(format!("Failed to decode remote file content: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_envelope(mtime: i64, size: u64, binary: bool, content: &str) -> Vec<u8> {
        let body = if binary {
            String::new()
        } else {
            BASE64.encode(content.as_bytes())
        };
        format!(
            "MTIME={mtime}\nSIZE={size}\nBINARY={}\n---\n{body}",
            if binary { 1 } else { 0 }
        )
        .into_bytes()
    }

    #[test]
    fn parses_text_file_envelope() {
        let bytes = build_envelope(1_714_492_800_000, 5, false, "hello");
        let result = parse_remote_read_output(&bytes).expect("ok");
        assert_eq!(result.content, "hello");
        assert_eq!(result.mtime, 1_714_492_800_000);
        assert_eq!(result.size_bytes, 5);
        assert!(!result.binary);
    }

    #[test]
    fn parses_binary_file_with_no_content_payload() {
        let bytes = build_envelope(1_000, 12345, true, "");
        let result = parse_remote_read_output(&bytes).expect("ok");
        assert!(result.binary);
        assert_eq!(result.content, "");
        assert_eq!(result.size_bytes, 12345);
    }

    #[test]
    fn decodes_non_utf8_text_instead_of_failing() {
        let body = BASE64.encode(b"caf\xE9");
        let bytes = format!("MTIME=1\nSIZE=4\nBINARY=0\n---\n{body}").into_bytes();
        let result = parse_remote_read_output(&bytes).expect("ok");
        assert!(!result.binary);
        assert_eq!(result.content, "café");
        assert_eq!(result.encoding, "windows1252");
    }

    #[test]
    fn a_too_large_envelope_is_binary_and_says_so() {
        let bytes = b"MTIME=1\nSIZE=99999999\nBINARY=1\nTOO_LARGE=1\n---\n".to_vec();
        let result = parse_remote_read_output(&bytes).expect("ok");
        assert!(result.binary && result.too_large);
        assert_eq!(result.size_bytes, 99_999_999);
    }

    #[test]
    fn rejects_envelope_missing_separator() {
        let bytes = b"MTIME=1\nSIZE=1\nBINARY=0\n".to_vec();
        assert!(parse_remote_read_output(&bytes).is_err());
    }

    #[test]
    fn rejects_envelope_with_invalid_base64() {
        let bytes = b"MTIME=1\nSIZE=1\nBINARY=0\n---\n!!!not-base64!!!".to_vec();
        assert!(parse_remote_read_output(&bytes).is_err());
    }

    #[test]
    fn parser_tolerates_base64_line_wraps() {
        let raw = "x".repeat(200);
        let mut wrapped = BASE64.encode(raw.as_bytes());
        wrapped = wrapped
            .as_bytes()
            .chunks(76)
            .map(|chunk| std::str::from_utf8(chunk).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let bytes = format!("MTIME=1\nSIZE=200\nBINARY=0\n---\n{wrapped}\n").into_bytes();
        let result = parse_remote_read_output(&bytes).expect("ok");
        assert_eq!(result.content.len(), 200);
    }

    #[test]
    fn parses_list_output_with_files_and_directories() {
        let stdout = "directory\t/repo/src\nfile\t/repo/src/main.rs\nfile\t/repo/README.md\n";
        let entries = parse_remote_list_output(stdout);
        assert_eq!(entries.len(), 3);
        assert!(matches!(entries[0].kind, EditorListEntryKind::Directory));
        assert_eq!(entries[0].path, "/repo/src");
        assert!(matches!(entries[1].kind, EditorListEntryKind::File));
        assert_eq!(entries[1].path, "/repo/src/main.rs");
    }

    #[test]
    fn parser_drops_malformed_lines() {
        let stdout = "directory\t/repo/src\nbogus\nlink\t/repo/symlink\n\nfile\t/repo/x";
        let entries = parse_remote_list_output(stdout);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/repo/src");
        assert_eq!(entries[1].path, "/repo/x");
    }

    #[test]
    fn parses_path_output() {
        let bytes = b"PATH=/repo/src/new.rs\n".to_vec();
        let result = parse_remote_path_output(&bytes).expect("ok");
        assert_eq!(result.path, "/repo/src/new.rs");
    }

    #[test]
    fn path_parser_rejects_missing_or_empty() {
        assert!(parse_remote_path_output(b"OK\n").is_err());
        assert!(parse_remote_path_output(b"PATH=\n").is_err());
        assert!(parse_remote_path_output(b"PATH=   \n").is_err());
    }

    #[test]
    fn parses_write_output_extracts_new_mtime() {
        let bytes = b"NEW_MTIME=1714492800000\n".to_vec();
        let result = parse_remote_write_output(&bytes).expect("ok");
        assert_eq!(result.mtime, 1_714_492_800_000);
    }

    #[test]
    fn write_output_parser_tolerates_trailing_whitespace() {
        let bytes = b"NEW_MTIME=42  \n\n".to_vec();
        let result = parse_remote_write_output(&bytes).expect("ok");
        assert_eq!(result.mtime, 42);
    }

    #[test]
    fn write_output_parser_rejects_missing_field() {
        let bytes = b"OK\n".to_vec();
        assert!(parse_remote_write_output(&bytes).is_err());
    }

    #[test]
    fn write_output_parser_rejects_invalid_number() {
        let bytes = b"NEW_MTIME=not-a-number\n".to_vec();
        assert!(parse_remote_write_output(&bytes).is_err());
    }

    #[test]
    fn parser_drops_lines_with_empty_path() {
        let stdout = "file\t   \nfile\t/repo/ok";
        let entries = parse_remote_list_output(stdout);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/repo/ok");
    }
}
