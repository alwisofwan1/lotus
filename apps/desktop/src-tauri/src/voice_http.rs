//! Shared HTTP helpers for the BYOK voice seams (`stt_providers` / `tts_providers`).
//!
//! Both seams run inside synchronous Tauri commands, so they use blocking `ureq` (same pattern as
//! `skills.rs`) and decode/parse responses with `into_string()` + `serde_json` (ureq's `json`
//! feature is not assumed enabled). API keys are read in Rust and never cross IPC.

use std::time::Duration;

use crate::error::{other, AppError};

/// Per-request timeout for cloud STT/TTS calls — bounds a hung provider so the command never blocks
/// the Tauri worker thread indefinitely.
pub const VOICE_HTTP_TIMEOUT: Duration = Duration::from_secs(60);

/// Max audio payload (bytes) accepted in either direction. Guards against unbounded memory and
/// matches common provider limits (OpenAI caps Whisper uploads at 25 MB).
pub const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;

/// Map a `ureq` error into an `AppError`, surfacing a short response-body snippet on HTTP status
/// errors so misconfiguration (bad key, wrong model/voice) is debuggable without dumping the whole
/// payload to the user.
pub fn map_http_err(ctx: &'static str) -> impl Fn(ureq::Error) -> AppError {
    move |e| match e {
        ureq::Error::Status(code, resp) => {
            let body = resp.into_string().unwrap_or_default();
            let snippet: String = body.chars().take(300).collect();
            if snippet.trim().is_empty() {
                other(format!("{ctx} failed (HTTP {code})"))
            } else {
                other(format!("{ctx} failed (HTTP {code}): {snippet}"))
            }
        }
        ureq::Error::Transport(t) => other(format!("{ctx} failed: {t}")),
    }
}

/// Normalize a configured base URL (trim a trailing slash) or fall back to the provider default
/// when it is absent or blank.
pub fn base_endpoint(base_url: Option<&str>, fallback: &str) -> String {
    base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .trim_end_matches('/')
        .to_string()
}

/// The base MIME type with any parameters (e.g. `;codecs=opus`) stripped. Falls back to
/// `audio/webm` (the renderer's MediaRecorder default) when the input is empty.
pub fn base_mime(mime: &str) -> &str {
    let base = mime.split(';').next().unwrap_or("").trim();
    if base.is_empty() {
        "audio/webm"
    } else {
        base
    }
}

/// A plausible upload filename for the given audio MIME type. Providers (notably OpenAI) key off the
/// file extension, so map common recorder MIME types to a matching name; default to `.webm`.
pub fn filename_for_mime(mime: &str) -> &'static str {
    match base_mime(mime) {
        "audio/webm" => "audio.webm",
        "audio/ogg" => "audio.ogg",
        "audio/mp4" | "audio/x-m4a" | "audio/aac" => "audio.mp4",
        "audio/mpeg" | "audio/mp3" => "audio.mp3",
        "audio/wav" | "audio/x-wav" | "audio/wave" => "audio.wav",
        "audio/flac" => "audio.flac",
        _ => "audio.webm",
    }
}

/// Build a `multipart/form-data` body: any number of text fields followed by one binary file part.
pub fn build_multipart(
    boundary: &str,
    fields: &[(&str, &str)],
    file_field: &str,
    filename: &str,
    content_type: &str,
    file_bytes: &[u8],
) -> Vec<u8> {
    let mut body = Vec::with_capacity(file_bytes.len() + 512);
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; filename=\"{filename}\"\r\nContent-Type: {content_type}\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(file_bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_mime_strips_codecs_and_defaults_empty() {
        assert_eq!(base_mime("audio/webm;codecs=opus"), "audio/webm");
        assert_eq!(base_mime("audio/wav"), "audio/wav");
        assert_eq!(base_mime(""), "audio/webm");
    }

    #[test]
    fn base_endpoint_trims_slash_and_falls_back() {
        assert_eq!(
            base_endpoint(Some("https://x.test/v1/"), "fb"),
            "https://x.test/v1"
        );
        assert_eq!(
            base_endpoint(Some("  "), "https://fallback/v1"),
            "https://fallback/v1"
        );
        assert_eq!(
            base_endpoint(None, "https://fallback/v1"),
            "https://fallback/v1"
        );
    }

    #[test]
    fn filename_for_mime_maps_common_types() {
        assert_eq!(filename_for_mime("audio/webm;codecs=opus"), "audio.webm");
        assert_eq!(filename_for_mime("audio/mp4"), "audio.mp4");
        assert_eq!(filename_for_mime("audio/wav"), "audio.wav");
        assert_eq!(filename_for_mime("application/octet-stream"), "audio.webm");
    }

    #[test]
    fn build_multipart_frames_fields_and_file() {
        let body = build_multipart(
            "BOUND",
            &[("model", "whisper-1"), ("language", "en")],
            "file",
            "audio.webm",
            "audio/webm",
            b"\x00\x01\x02",
        );
        let text = String::from_utf8_lossy(&body);
        assert!(text.contains(
            "--BOUND\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n"
        ));
        assert!(text.contains("name=\"language\"\r\n\r\nen\r\n"));
        assert!(text.contains(
            "name=\"file\"; filename=\"audio.webm\"\r\nContent-Type: audio/webm\r\n\r\n"
        ));
        assert!(text.ends_with("\r\n--BOUND--\r\n"));
        // Raw file bytes are present between the file header and the closing boundary.
        assert!(body.windows(3).any(|w| w == b"\x00\x01\x02"));
    }
}
