//! YouTube oEmbed metadata resolver for the CodeCanvas music node.
//!
//! The frontend cannot call `youtube.com/oembed` itself (no CORS headers on that
//! endpoint, and the webview has no HTTP capability), so track metadata resolves
//! here: blocking `ureq` inside a synchronous Tauri command, the same seam as
//! `voice_http.rs`. Keyless — oEmbed needs no YouTube Data API key.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{other, AppError};

/// Per-request timeout — a hung oEmbed lookup should fail the paste bar fast, not
/// block a Tauri worker thread for the voice-call 60s.
const OEMBED_TIMEOUT: Duration = Duration::from_secs(8);

/// Track metadata as consumed by `createMusicTrack` on the frontend.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicTrackMeta {
    pub title: String,
    pub author: String,
    pub thumbnail_url: String,
}

/// Decode a YouTube oEmbed response body into track metadata.
fn parse_oembed(body: &str) -> Result<MusicTrackMeta, AppError> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| other(format!("oEmbed response was not JSON: {e}")))?;
    let field = |key: &str| -> Result<String, AppError> {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| other(format!("oEmbed response missing `{key}`")))
    };
    Ok(MusicTrackMeta {
        title: field("title")?,
        author: field("author_name")?,
        thumbnail_url: field("thumbnail_url")?,
    })
}

/// Map oEmbed HTTP failures to messages the paste bar can show as-is.
fn map_oembed_err(e: ureq::Error) -> AppError {
    match e {
        // YouTube's oEmbed uses 400/404 for unknown videos and 401/403 when the
        // video exists but disallows embedding.
        ureq::Error::Status(400 | 404, _) => {
            other("Video not found — it may be private or deleted")
        }
        ureq::Error::Status(401 | 403, _) => other("This video does not allow embedding"),
        ureq::Error::Status(code, _) => other(format!("YouTube oEmbed failed (HTTP {code})")),
        ureq::Error::Transport(t) => other(format!("Could not reach YouTube: {t}")),
    }
}

/// Resolve title/author/thumbnail for a pasted YouTube URL.
pub fn cmd_resolve_track(url: &str) -> Result<MusicTrackMeta, AppError> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(other("No URL provided"));
    }
    let resp = ureq::get("https://www.youtube.com/oembed")
        .query("url", trimmed)
        .query("format", "json")
        .timeout(OEMBED_TIMEOUT)
        .call()
        .map_err(map_oembed_err)?;
    let body = resp
        .into_string()
        .map_err(|e| other(format!("Failed to read oEmbed response: {e}")))?;
    parse_oembed(&body)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"{
        "title": "Hyperfocus Minimal Techno Mix with 40Hz Gamma Isochronic Tones",
        "author_name": "Jason Lewis - Mind Amend",
        "author_url": "https://www.youtube.com/@MindAmend",
        "type": "video",
        "height": 113,
        "width": 200,
        "version": "1.0",
        "provider_name": "YouTube",
        "provider_url": "https://www.youtube.com/",
        "thumbnail_height": 360,
        "thumbnail_width": 480,
        "thumbnail_url": "https://i.ytimg.com/vi/WPni755-Krg/hqdefault.jpg",
        "html": "<iframe></iframe>"
    }"#;

    #[test]
    fn parses_oembed_fixture_into_meta() {
        let meta = parse_oembed(FIXTURE).expect("fixture should parse");
        assert_eq!(
            meta,
            MusicTrackMeta {
                title: "Hyperfocus Minimal Techno Mix with 40Hz Gamma Isochronic Tones".into(),
                author: "Jason Lewis - Mind Amend".into(),
                thumbnail_url: "https://i.ytimg.com/vi/WPni755-Krg/hqdefault.jpg".into(),
            }
        );
    }

    #[test]
    fn missing_fields_and_bad_json_are_reported() {
        let err = parse_oembed(r#"{"title": "x"}"#).unwrap_err();
        assert!(err.to_string().contains("author_name"), "got: {err}");
        let err = parse_oembed("not json").unwrap_err();
        assert!(err.to_string().contains("not JSON"), "got: {err}");
    }

    #[test]
    fn meta_serializes_camel_case_for_the_frontend() {
        let json = serde_json::to_string(&MusicTrackMeta {
            title: "t".into(),
            author: "a".into(),
            thumbnail_url: "u".into(),
        })
        .unwrap();
        assert!(json.contains("\"thumbnailUrl\""), "got: {json}");
    }

    #[test]
    fn empty_url_is_rejected_before_any_network_call() {
        let err = cmd_resolve_track("   ").unwrap_err();
        assert!(err.to_string().contains("No URL"), "got: {err}");
    }
}
