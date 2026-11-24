//! Streaming speech-to-text for the CodeCanvas NL command bar (Deepgram realtime).
//!
//! World-class voice input wants live, partial transcripts as the user speaks — not a one-shot
//! batch round-trip ([`stt_providers::cmd_transcribe`]). This module opens a WebSocket to Deepgram's
//! realtime `/listen` endpoint, with the API key staying in Rust (BYOK threat model — keys never enter
//! the renderer). The frontend captures mic audio (MediaRecorder webm/opus, which Deepgram
//! auto-detects) and pushes chunks via [`cmd_send`]; partial + final transcripts stream back to the
//! UI through a Tauri [`Channel`].
//!
//! Lifecycle: [`cmd_start`] (open WS, return a session id) → [`cmd_send`] (per audio chunk) →
//! [`cmd_finish`] (flush + await finals) or [`cmd_cancel`] (abort). The driver task removes its own
//! session entry when it ends, and a post-finish grace timeout guarantees the task can never hang.

use std::collections::HashMap;
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio::time::{sleep_until, Duration, Instant};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

use crate::error::{other, AppError};

/// Transcript events streamed to the renderer over the per-session [`Channel`].
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StreamEvent {
    /// An interim hypothesis — overwrites the previous interim line in the UI.
    Partial { transcript: String },
    /// A settled segment — the UI appends it to the committed transcript.
    Final { transcript: String },
    /// The stream failed; `message` is safe to surface (no key material).
    Error { message: String },
    /// The WebSocket closed cleanly (after finish, or remote close).
    Closed,
}

/// Finish/cancel control is separate from bounded audio so user control never waits behind chunks.
enum ControlMsg {
    Finish,
    Cancel,
}

enum ControlAction {
    Continue,
    Cancel,
}

fn apply_control_message(message: ControlMsg, finish_requested: &mut bool) -> ControlAction {
    match message {
        ControlMsg::Finish => {
            *finish_requested = true;
            ControlAction::Continue
        }
        ControlMsg::Cancel => ControlAction::Cancel,
    }
}

const AUDIO_QUEUE_CAPACITY: usize = 32;

struct Session {
    audio_tx: Option<mpsc::Sender<Vec<u8>>>,
    control_tx: mpsc::UnboundedSender<ControlMsg>,
}

impl Session {
    fn request_finish(&mut self) {
        if self.audio_tx.take().is_some() {
            let _ = self.control_tx.send(ControlMsg::Finish);
        }
    }
}

fn enqueue_audio_chunk(tx: &mpsc::Sender<Vec<u8>>, bytes: Vec<u8>) -> Result<(), AppError> {
    tx.try_send(bytes).map_err(|error| match error {
        mpsc::error::TrySendError::Full(_) => {
            other("streaming STT audio queue is full; transcription would be incomplete")
        }
        mpsc::error::TrySendError::Closed(_) => other("stt stream closed"),
    })
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Post-finish grace: keep reading Deepgram finals this long after CloseStream before giving up,
/// so a wedged socket can never hang the driver task.
const FINISH_GRACE: Duration = Duration::from_secs(8);

/// Deepgram's conversational "Flux" models run on the `/v2/listen` endpoint with a turn-based event
/// protocol; the nova/enhanced families run on `/v1/listen` with the classic Results protocol. We pick
/// the endpoint + parameter set by model so either works.
fn is_flux_model(model: Option<&str>) -> bool {
    model
        .map(|m| m.to_lowercase().contains("flux"))
        .unwrap_or(false)
}

/// Query-value characters that can alter parameter structure or produce an invalid WebSocket URL.
/// Keep unreserved characters such as `-` readable so normal model ids remain stable.
const QUERY_VALUE_ENCODE_SET: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b'/')
    .add(b'=')
    .add(b'?');

/// Build the Deepgram realtime WS URL. The frontend streams raw PCM (linear16, 16 kHz mono) via the
/// Web Audio API — the most webview-portable format (no MediaRecorder container quirks on WKWebView).
/// We derive scheme+host from the REST base and choose the listen API version from the model.
fn build_ws_url(base_url: &str, model: Option<&str>, language: Option<&str>) -> String {
    let (scheme, rest) = if let Some(r) = base_url.strip_prefix("https://") {
        ("wss://", r)
    } else if let Some(r) = base_url.strip_prefix("http://") {
        ("ws://", r)
    } else {
        ("wss://", base_url)
    };
    // Drop any REST path (e.g. "/v1") — we own the listen path + version below.
    let host = rest.split('/').next().unwrap_or(rest).trim_end_matches('/');
    let flux = is_flux_model(model);
    let path = if flux { "/v2/listen" } else { "/v1/listen" };

    // Shared raw-audio params. Flux uses turn events instead of interim_results/smart_format, so we
    // keep its query minimal to avoid an "unknown parameter" 400.
    let mut params = vec![
        "encoding=linear16".to_string(),
        "sample_rate=16000".to_string(),
    ];
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        params.push(format!(
            "model={}",
            utf8_percent_encode(m, QUERY_VALUE_ENCODE_SET)
        ));
    }
    if let Some(l) = language.filter(|l| !l.is_empty()) {
        params.push(format!(
            "language={}",
            utf8_percent_encode(l, QUERY_VALUE_ENCODE_SET)
        ));
    }
    if !flux {
        params.push("channels=1".to_string());
        params.push("interim_results=true".to_string());
        params.push("smart_format=true".to_string());
    }
    format!("{scheme}{host}{path}?{}", params.join("&"))
}

/// Extract `(transcript, is_final)` from a Deepgram realtime message, tolerant of BOTH protocols:
///   • v1 `Results`  → transcript at channel.alternatives[0].transcript, finality from `is_final`.
///   • v2 `TurnInfo` (Flux) → transcript top-level, finality when `event == "EndOfTurn"`.
/// Returns `None` for control frames (Metadata, UtteranceEnd, connection events) and empty transcripts.
fn parse_deepgram_message(text: &str) -> Option<(String, bool)> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let (transcript, is_final) = match v.get("type").and_then(|t| t.as_str()) {
        Some("Results") => {
            let t = v
                .get("channel")?
                .get("alternatives")?
                .get(0)?
                .get("transcript")?
                .as_str()?;
            (
                t.to_string(),
                v.get("is_final").and_then(|b| b.as_bool()).unwrap_or(false),
            )
        }
        Some("TurnInfo") => {
            let t = v.get("transcript")?.as_str()?;
            (
                t.to_string(),
                v.get("event").and_then(|e| e.as_str()) == Some("EndOfTurn"),
            )
        }
        _ => return None,
    };
    if transcript.trim().is_empty() {
        return None;
    }
    Some((transcript, is_final))
}

/// Open a streaming session. Validates the provider is a keyed Deepgram entry, connects the WS, and
/// spawns the driver task. Returns the session id used by [`cmd_send`] / [`cmd_finish`] / [`cmd_cancel`].
pub async fn cmd_start(
    provider_id: &str,
    channel: Channel<StreamEvent>,
) -> Result<String, AppError> {
    let provider = crate::stt_providers::find_provider(provider_id)
        .ok_or_else(|| other(format!("stt provider '{provider_id}' not found")))?;
    if provider.kind != "deepgram" {
        return Err(other(format!(
            "streaming STT requires a Deepgram provider; '{provider_id}' is '{}'",
            provider.kind
        )));
    }
    let api_key = provider
        .api_key
        .clone()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            other(format!(
                "stt provider '{provider_id}' has no API key configured"
            ))
        })?;

    let base_url = provider
        .base_url
        .as_deref()
        .unwrap_or("https://api.deepgram.com/v1");
    let url = build_ws_url(
        base_url,
        provider.model.as_deref(),
        provider.language.as_deref(),
    );

    let mut request = url
        .into_client_request()
        .map_err(|e| other(format!("invalid Deepgram URL: {e}")))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Token {api_key}"))
            .map_err(|e| other(format!("invalid Deepgram auth header: {e}")))?,
    );

    let (ws_stream, _resp) = connect_async(request).await.map_err(|e| {
        // Surface Deepgram's 4xx body (it names the offending query param) instead of a bare status.
        if let tokio_tungstenite::tungstenite::Error::Http(resp) = &e {
            let status = resp.status();
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| "(no response body)".to_string());
            other(format!("Deepgram connect rejected ({status}): {body}"))
        } else {
            other(format!("Deepgram connect failed: {e}"))
        }
    })?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let (audio_tx, mut audio_rx) = mpsc::channel::<Vec<u8>>(AUDIO_QUEUE_CAPACITY);
    let (control_tx, mut control_rx) = mpsc::unbounded_channel::<ControlMsg>();
    sessions().lock().insert(
        session_id.clone(),
        Session {
            audio_tx: Some(audio_tx),
            control_tx,
        },
    );

    let task_id = session_id.clone();
    tokio::spawn(async move {
        let (mut write, mut read) = ws_stream.split();
        // Finish first closes renderer send ownership, then drains accepted audio before CloseStream.
        let mut finish_requested = false;
        let mut close_stream_sent = false;
        let mut finish_deadline: Option<Instant> = None;

        loop {
            // A timer future that only resolves once a finish deadline is set.
            let timer = async {
                match finish_deadline {
                    Some(d) => sleep_until(d).await,
                    None => std::future::pending::<()>().await,
                }
            };

            tokio::select! {
                biased;
                _ = timer => break,
                ctrl = control_rx.recv() => match ctrl {
                    Some(message) => {
                        if matches!(apply_control_message(message, &mut finish_requested), ControlAction::Cancel) {
                            let _ = write.send(Message::Close(None)).await;
                            break;
                        }
                    }
                    None => {
                        let _ = write.send(Message::Close(None)).await;
                        break;
                    }
                },
                audio = audio_rx.recv(), if !close_stream_sent => match audio {
                    Some(bytes) => {
                        if write.send(Message::Binary(bytes)).await.is_err() {
                            break;
                        }
                    }
                    None if finish_requested => {
                        let _ = write.send(Message::Text("{\"type\":\"CloseStream\"}".to_string())).await;
                        close_stream_sent = true;
                        finish_deadline = Some(Instant::now() + FINISH_GRACE);
                    }
                    None => {
                        let _ = write.send(Message::Close(None)).await;
                        break;
                    }
                },
                inbound = read.next() => match inbound {
                    Some(Ok(Message::Text(text))) => {
                        if let Some((transcript, is_final)) = parse_deepgram_message(&text) {
                            let ev = if is_final {
                                StreamEvent::Final { transcript }
                            } else {
                                StreamEvent::Partial { transcript }
                            };
                            let _ = channel.send(ev);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        let _ = channel.send(StreamEvent::Error { message: format!("Deepgram stream error: {e}") });
                        break;
                    }
                },
            }
        }

        let _ = channel.send(StreamEvent::Closed);
        sessions().lock().remove(&task_id);
    });

    Ok(session_id)
}

/// Forward one base64-encoded audio chunk to the Deepgram socket.
pub fn cmd_send(session_id: &str, audio_base64: &str) -> Result<(), AppError> {
    let bytes = BASE64
        .decode(audio_base64.as_bytes())
        .map_err(|e| other(format!("invalid audio chunk: {e}")))?;
    if bytes.is_empty() {
        return Ok(());
    }
    let map = sessions().lock();
    let session = map
        .get(session_id)
        .ok_or_else(|| other(format!("stt stream '{session_id}' is not active")))?;
    let audio_tx = session
        .audio_tx
        .as_ref()
        .ok_or_else(|| other("stt stream is already finishing"))?;
    enqueue_audio_chunk(audio_tx, bytes)
}

/// Ask Deepgram to flush remaining audio and emit final transcripts; the driver task then closes.
pub fn cmd_finish(session_id: &str) -> Result<(), AppError> {
    // Drop only audio send ownership. Keep the control sender registered so a timeout/unmount can
    // still Cancel while the driver drains accepted audio or waits for provider finals.
    if let Some(session) = sessions().lock().get_mut(session_id) {
        session.request_finish();
    }
    Ok(())
}

/// Abort a stream without waiting for finals.
pub fn cmd_cancel(session_id: &str) -> Result<(), AppError> {
    if let Some(session) = sessions().lock().remove(session_id) {
        let _ = session.control_tx.send(ControlMsg::Cancel);
    }
    Ok(())
}

/// Abort every open stream — the `RunEvent::Exit` path, so quitting Lotus never leaves a Deepgram
/// socket streaming (and billing).
pub fn close_all() {
    for (_, session) in sessions().lock().drain() {
        let _ = session.control_tx.send(ControlMsg::Cancel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_all_cancels_every_open_stream_and_forgets_it() {
        let (audio_tx, _audio_rx) = mpsc::channel(1);
        let (control_tx, mut control_rx) = mpsc::unbounded_channel();
        sessions().lock().insert(
            "close-all-stt".to_string(),
            Session {
                audio_tx: Some(audio_tx),
                control_tx,
            },
        );

        close_all();

        assert!(!sessions().lock().contains_key("close-all-stt"));
        assert!(matches!(control_rx.try_recv(), Ok(ControlMsg::Cancel)));
    }

    #[test]
    fn bounded_audio_queue_rejects_overload_without_blocking_control() {
        let (audio_tx, _audio_rx) = mpsc::channel(1);
        assert!(enqueue_audio_chunk(&audio_tx, vec![1]).is_ok());
        let error = enqueue_audio_chunk(&audio_tx, vec![2]).unwrap_err();
        assert!(error.to_string().contains("audio queue is full"));

        let (session_audio_tx, _session_audio_rx) = mpsc::channel(1);
        let (control_tx, mut control_rx) = mpsc::unbounded_channel();
        let mut session = Session {
            audio_tx: Some(session_audio_tx),
            control_tx,
        };
        session.request_finish();
        assert!(session.audio_tx.is_none());
        assert!(matches!(control_rx.try_recv(), Ok(ControlMsg::Finish)));
    }

    #[test]
    fn cancel_remains_actionable_after_finish_was_requested() {
        let mut finish_requested = false;
        assert!(matches!(
            apply_control_message(ControlMsg::Finish, &mut finish_requested),
            ControlAction::Continue
        ));
        assert!(finish_requested);
        assert!(matches!(
            apply_control_message(ControlMsg::Cancel, &mut finish_requested),
            ControlAction::Cancel
        ));
    }

    #[test]
    fn parses_a_final_results_frame() {
        let msg = r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"open three agents"}]}}"#;
        assert_eq!(
            parse_deepgram_message(msg),
            Some(("open three agents".to_string(), true))
        );
    }

    #[test]
    fn parses_an_interim_frame_as_not_final() {
        let msg = r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"open three"}]}}"#;
        assert_eq!(
            parse_deepgram_message(msg),
            Some(("open three".to_string(), false))
        );
    }

    #[test]
    fn ignores_non_results_and_empty_transcripts() {
        assert_eq!(parse_deepgram_message(r#"{"type":"Metadata"}"#), None);
        assert_eq!(parse_deepgram_message(r#"{"type":"UtteranceEnd"}"#), None);
        assert_eq!(
            parse_deepgram_message(
                r#"{"type":"Results","is_final":true,"channel":{"alternatives":[{"transcript":"  "}]}}"#
            ),
            None
        );
        assert_eq!(parse_deepgram_message("not json"), None);
    }

    #[test]
    fn builds_wss_url_with_params_and_no_encoding() {
        let url = build_ws_url("https://api.deepgram.com/v1", Some("nova-2"), Some("en"));
        assert!(url.starts_with("wss://api.deepgram.com/v1/listen?"));
        assert!(url.contains("interim_results=true"));
        assert!(url.contains("smart_format=true"));
        assert!(url.contains("model=nova-2"));
        assert!(url.contains("language=en"));
        assert!(url.contains("encoding=linear16"));
        assert!(url.contains("sample_rate=16000"));
    }

    #[test]
    fn omits_blank_model_and_language() {
        let url = build_ws_url("https://api.deepgram.com/v1", None, Some(""));
        assert!(!url.contains("model="));
        assert!(!url.contains("language="));
    }

    #[test]
    fn percent_encodes_user_configured_query_values() {
        let url = build_ws_url(
            "https://api.deepgram.com/v1",
            Some("model name&tier=evil"),
            Some("id ID&channels=99"),
        );
        assert!(url.contains("model=model%20name%26tier%3Devil"), "{url}");
        assert!(url.contains("language=id%20ID%26channels%3D99"), "{url}");
        assert!(!url.contains("tier=evil"), "{url}");
        assert!(!url.contains("channels=99"), "{url}");
    }

    #[test]
    fn routes_flux_models_to_the_v2_endpoint_with_minimal_params() {
        let url = build_ws_url("https://api.deepgram.com/v1", Some("flux-general-en"), None);
        assert!(
            url.starts_with("wss://api.deepgram.com/v2/listen?"),
            "got {url}"
        );
        assert!(url.contains("model=flux-general-en"));
        assert!(url.contains("encoding=linear16"));
        // Flux uses turn events, not these v1 params — they'd 400.
        assert!(!url.contains("interim_results"));
        assert!(!url.contains("smart_format"));
    }

    #[test]
    fn parses_flux_turninfo_finality_from_the_event_field() {
        let update = r#"{"type":"TurnInfo","event":"Update","transcript":"open three"}"#;
        assert_eq!(
            parse_deepgram_message(update),
            Some(("open three".to_string(), false))
        );
        let done = r#"{"type":"TurnInfo","event":"EndOfTurn","transcript":"open three agents"}"#;
        assert_eq!(
            parse_deepgram_message(done),
            Some(("open three agents".to_string(), true))
        );
    }
}
