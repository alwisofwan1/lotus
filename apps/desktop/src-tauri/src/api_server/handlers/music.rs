use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use serde::Deserialize;

use crate::api_server::ApiState;

const VIDEO_ID_CHARS: usize = 11;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YoutubePlayerQuery {
    pub video_id: String,
    pub autoplay: Option<bool>,
    /// Resume position in seconds, baked into the embed URL for this load.
    pub start: Option<u32>,
}

fn is_valid_video_id(video_id: &str) -> bool {
    video_id.len() == VIDEO_ID_CHARS
        && video_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn build_youtube_player_html(
    video_id: &str,
    autoplay: bool,
    start: Option<u32>,
    origin: &str,
) -> String {
    let video_id = html_escape(video_id);
    let origin = html_escape(origin);
    let autoplay = if autoplay { "1" } else { "0" };
    // `start` is numeric by parse, so it needs no escaping — omitted entirely when absent
    // so a fresh load keeps the exact URL shape it had before resume existed.
    let start = start
        .filter(|value| *value > 0)
        .map(|value| format!("&amp;start={value}"))
        .unwrap_or_default();
    format!(
        r#"<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <title>Lotus YouTube Player</title>
  <style>
    html,body,#player{{margin:0;width:100%;height:100%;overflow:hidden;background:#000;}}
    iframe{{display:block;width:100%;height:100%;border:0;background:#000;}}
  </style>
</head>
<body>
  <iframe
    id="player"
    title="YouTube player"
    src="https://www.youtube.com/embed/{video_id}?enablejsapi=1&amp;playsinline=1&amp;autoplay={autoplay}{start}&amp;origin={origin}"
    allow="autoplay; encrypted-media; picture-in-picture"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen></iframe>
  <script>
    (() => {{
      const YOUTUBE_ORIGIN = "https://www.youtube.com";
      const player = document.getElementById("player");
      window.addEventListener("message", (event) => {{
        if (event.source === window.parent) {{
          player.contentWindow?.postMessage(event.data, YOUTUBE_ORIGIN);
          return;
        }}
        if (event.origin === YOUTUBE_ORIGIN && event.source === player.contentWindow) {{
          window.parent.postMessage(event.data, "*");
        }}
      }});
    }})();
  </script>
</body>
</html>"#
    )
}

pub async fn youtube_player(
    State(state): State<ApiState>,
    Query(query): Query<YoutubePlayerQuery>,
) -> Result<Response, (StatusCode, String)> {
    if !is_valid_video_id(&query.video_id) {
        return Err((StatusCode::BAD_REQUEST, "Invalid YouTube video id".into()));
    }

    let origin = format!("http://127.0.0.1:{}", state.port);
    let html = build_youtube_player_html(
        &query.video_id,
        query.autoplay.unwrap_or(false),
        query.start,
        &origin,
    );

    let mut headers = HeaderMap::new();
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; frame-src https://www.youtube.com; script-src 'unsafe-inline'; style-src 'unsafe-inline';",
        ),
    );

    Ok((headers, Html(html)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_id_validation_is_strict() {
        assert!(is_valid_video_id("dQw4w9WgXcQ"));
        assert!(is_valid_video_id("WPni755-Krg"));
        assert!(!is_valid_video_id("too-short"));
        assert!(!is_valid_video_id("dQw4w9WgXcQ<script>"));
        assert!(!is_valid_video_id("dQw4w9WgXc!"));
    }

    #[test]
    fn wrapper_html_omits_start_when_there_is_no_resume_position() {
        let html = build_youtube_player_html("dQw4w9WgXcQ", true, None, "http://127.0.0.1:9877");
        assert!(!html.contains("start="));
        let zero = build_youtube_player_html("dQw4w9WgXcQ", true, Some(0), "http://127.0.0.1:9877");
        assert!(!zero.contains("start="));
    }

    #[test]
    fn wrapper_html_carries_the_resume_position() {
        let html =
            build_youtube_player_html("dQw4w9WgXcQ", true, Some(137), "http://127.0.0.1:9877");
        assert!(html.contains("autoplay=1&amp;start=137&amp;origin="));
    }

    #[test]
    fn wrapper_html_relays_widget_messages_and_sets_http_origin() {
        let html = build_youtube_player_html("dQw4w9WgXcQ", true, None, "http://127.0.0.1:9877");
        assert!(html.contains("https://www.youtube.com/embed/dQw4w9WgXcQ?"));
        assert!(html.contains("autoplay=1"));
        assert!(html.contains("origin=http://127.0.0.1:9877"));
        assert!(html.contains("player.contentWindow?.postMessage(event.data, YOUTUBE_ORIGIN)"));
        assert!(html.contains("window.parent.postMessage(event.data, \"*\")"));
        assert!(html.contains("strict-origin-when-cross-origin"));
    }
}
