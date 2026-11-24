//! Streaming **voice-to-voice** (speech-to-speech) transport for CodeCanvas.
//!
//! Opens a bidirectional WebSocket to an OpenAI-Realtime-compatible provider (Grok Voice at
//! `wss://api.x.ai/v1/realtime`, or OpenAI Realtime), with the API key staying in Rust (BYOK — keys
//! never enter the renderer). The frontend streams mic audio (raw PCM16, 16 kHz mono, base64) via
//! [`cmd_send`]; the model's audio deltas + turn events stream back to the UI through a Tauri
//! [`Channel`]. This is the imperative shell around the pure session state machine in
//! `services/voice/s2s-session.ts` (see `plans/voice-to-voice/research-and-analysis.md`).
//!
//! Lifecycle: [`cmd_start`] (open WS, send `session.update`, return a session id) → [`cmd_send`]
//! (per mic chunk) → [`cmd_interrupt`] (barge-in: cancel the in-flight response) → [`cmd_close`].
//!
//! ADDITIVE: entirely new module; it does not touch the turn-based STT (`stt_stream.rs`) or TTS
//! paths. Nothing here runs unless the user opts into voice-to-voice and configures a provider.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message;

use crate::error::{other, AppError};

mod protocol;
use protocol::{
    build_context_session_update, build_realtime_url, build_session_update,
    build_tool_result_messages, build_truncate_message, log_inbound, parse_realtime_message,
    parse_tools_json,
};

/// Events streamed to the renderer over the per-session [`Channel`]. These map onto the pure
/// `S2sEvent` union consumed by `reduceS2sSession` on the frontend.
// NOTE: `rename_all = "camelCase"` on the enum renames only the VARIANT tags ("audioDelta"), NOT the
// fields inside struct variants — those need per-field `rename` (or `rename_all_fields`). Without it
// the renderer received `audio_base64`/`is_final`/`call_id` but reads `audioBase64`/`isFinal`/`callId`
// → `undefined` → audio never enqueued (the entire "connects but silent" bug). See the serialization
// test below, which locks this contract.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum S2sStreamEvent {
    /// A chunk of the model's spoken reply — base64 PCM16 for the streaming playback queue.
    AudioDelta {
        #[serde(rename = "audioBase64")]
        audio_base64: String,
        #[serde(rename = "responseId", skip_serializing_if = "Option::is_none")]
        response_id: Option<String>,
    },
    /// Server VAD detected the user began speaking.
    UserSpeechStart,
    /// Server VAD detected the user stopped speaking.
    UserSpeechEnd,
    /// The model finished emitting audio for this turn.
    AgentAudioEnd,
    /// The provider finished emitting every output item for one response. Tool-result batching uses
    /// this boundary to continue only after all calls from that response have settled.
    ResponseDone,
    /// A transcript fragment; `isFinal` marks a settled segment and `speaker` identifies whether it
    /// came from the user input transcription or the model's spoken output.
    Transcript {
        text: String,
        #[serde(rename = "isFinal")]
        is_final: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<&'static str>,
        /// The realtime item this fragment belongs to. Every transcription event (OpenAI + xAI)
        /// carries `item_id` per spec; absent stays `None`, never coerced to `""`, so the
        /// frontend accumulator can distinguish "same item, refined text" from "next item".
        #[serde(rename = "itemId", skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        /// The content-part index within the item, when the wire frame carries one.
        #[serde(rename = "contentIndex", skip_serializing_if = "Option::is_none")]
        content_index: Option<i64>,
        /// True only for `…input_audio_transcription.updated`, which xAI documents as the CUMULATIVE
        /// transcript of the item so far — the text REPLACES what was accumulated for this item. An
        /// OpenAI `.delta` is an incremental fragment and is never cumulative. Without this the two
        /// were indistinguishable (`is_final: false` for both), and treating a delta as cumulative is
        /// exactly how the quadratic duplication bug reappears.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        cumulative: bool,
    },
    /// The concierge model called a tool. `arguments` is the raw JSON string from the model; the
    /// frontend parses it and maps `name` via `resolveConciergeAction` → a Lotus MCP action.
    ToolCall {
        #[serde(rename = "callId")]
        call_id: String,
        name: String,
        arguments: String,
    },
    /// The stream failed; `message` is safe to surface (no key material).
    Error { message: String },
    /// A single user input transcription attempt failed
    /// (`conversation.item.input_audio_transcription.failed`). Deliberately a DISTINCT variant
    /// from [`S2sStreamEvent::Error`]: the frontend's `reduceS2sSession` treats any `error` event
    /// as terminal (tears the whole session down via a `teardown` effect), but a failed
    /// transcription is per-item and recoverable — the duplex session must keep running.
    TranscriptionFailed {
        #[serde(rename = "itemId", skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(rename = "contentIndex", skip_serializing_if = "Option::is_none")]
        content_index: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
        message: String,
    },
    /// A spec-sanctioned transcription segment
    /// (`conversation.item.input_audio_transcription.segment`) — the provider's own
    /// accumulation unit, carrying a stable `id` plus timing/speaker metadata.
    TranscriptionSegment {
        id: String,
        start: f64,
        end: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        speaker: Option<String>,
        text: String,
    },
    /// The WebSocket closed cleanly.
    Closed,
}

/// Control messages from the command surface to the per-session driver task.
enum ControlMsg {
    /// Barge-in: cancel the model's in-flight response so the user can take the floor.
    Interrupt,
    /// Barge-in continuation: tell the provider how much of the assistant's audio was actually
    /// played so it discards the un-heard tail of the transcript from context
    /// (`conversation.item.truncate`).
    Truncate { item_id: String, audio_end_ms: u64 },
    /// Send one frontend-executed function result. Only the final result in a batch requests the
    /// provider's continuation response.
    ToolResult {
        call_id: String,
        output: String,
        continue_response: bool,
    },
    /// Refresh instructions/tools while the realtime socket stays open.
    SessionUpdate(String),
    /// Close the session.
    Close,
}

const AUDIO_QUEUE_CAPACITY: usize = 96;

#[derive(Default)]
struct SessionStats {
    enqueued_audio_chunks: AtomicU64,
    dropped_audio_chunks: AtomicU64,
    forwarded_audio_chunks: AtomicU64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct S2sStreamDiagnostics {
    pub queue_capacity: usize,
    pub queue_available: usize,
    pub queue_used: usize,
    pub enqueued_audio_chunks: u64,
    pub dropped_audio_chunks: u64,
    pub forwarded_audio_chunks: u64,
}

struct Session {
    tx: mpsc::UnboundedSender<ControlMsg>,
    audio_tx: mpsc::Sender<String>,
    stats: Arc<SessionStats>,
}

fn build_diagnostics(session: &Session) -> S2sStreamDiagnostics {
    let queue_capacity = session.audio_tx.max_capacity();
    let queue_available = session.audio_tx.capacity();
    S2sStreamDiagnostics {
        queue_capacity,
        queue_available,
        queue_used: queue_capacity.saturating_sub(queue_available),
        enqueued_audio_chunks: session.stats.enqueued_audio_chunks.load(Ordering::Relaxed),
        dropped_audio_chunks: session.stats.dropped_audio_chunks.load(Ordering::Relaxed),
        forwarded_audio_chunks: session.stats.forwarded_audio_chunks.load(Ordering::Relaxed),
    }
}

fn try_enqueue_audio(session: &Session, audio_base64: String) -> Result<(), AppError> {
    match session.audio_tx.try_send(audio_base64) {
        Ok(()) => {
            session
                .stats
                .enqueued_audio_chunks
                .fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        Err(mpsc::error::TrySendError::Full(_)) => {
            // Realtime mic capture is lossy under overload by design: keep latency bounded and avoid
            // unbounded memory growth. Server VAD/model quality may degrade briefly, but controls stay
            // responsive and diagnostics expose the dropped count.
            session
                .stats
                .dropped_audio_chunks
                .fetch_add(1, Ordering::Relaxed);
            Ok(())
        }
        Err(mpsc::error::TrySendError::Closed(_)) => Err(other("s2s stream closed")),
    }
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Build the realtime WS URL. The provider `base_url` is already a `wss://…/realtime` endpoint; we
/// coerce an http(s) base to ws(s) for safety and append the `?model=` query when a model is set.
/// Open a duplex voice-to-voice session. Validates the provider is a keyed S2S entry, connects the
/// WS, sends the initial `session.update`, and spawns the driver task. Returns the session id used
/// by [`cmd_send`] / [`cmd_interrupt`] / [`cmd_close`].
pub async fn cmd_start(
    provider_id: &str,
    instructions: Option<String>,
    tools_json: Option<String>,
    channel: Channel<S2sStreamEvent>,
) -> Result<String, AppError> {
    let tools = parse_tools_json(tools_json.as_deref())?;
    let provider = crate::s2s_providers::find_provider(provider_id)
        .ok_or_else(|| other(format!("s2s provider '{provider_id}' not found")))?;
    if !provider.enabled {
        return Err(other(format!("s2s provider '{provider_id}' is disabled")));
    }
    let api_key = provider
        .api_key
        .clone()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| {
            other(format!(
                "s2s provider '{provider_id}' has no API key configured"
            ))
        })?;

    let base_url = provider
        .base_url
        .as_deref()
        .unwrap_or("wss://api.x.ai/v1/realtime");
    let url = build_realtime_url(base_url, provider.model.as_deref());

    let mut request = url
        .into_client_request()
        .map_err(|e| other(format!("invalid realtime URL: {e}")))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|e| other(format!("invalid realtime auth header: {e}")))?,
    );
    // NOTE: the GA Realtime API (both OpenAI and Grok) is reached WITHOUT the old
    // `openai-beta: realtime=v1` opt-in header — GA now rejects that header with
    // "The Realtime Beta API is no longer supported." So we send only Authorization.

    let (ws_stream, _resp) = connect_async(request).await.map_err(|e| {
        if let tokio_tungstenite::tungstenite::Error::Http(resp) = &e {
            let status = resp.status();
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .filter(|b| !b.is_empty())
                .unwrap_or_else(|| "(no response body)".to_string());
            // Add an actionable hint for the two most common auth/entitlement rejections instead of
            // surfacing only the raw provider body (which is often terse or empty).
            let hint = match status.as_u16() {
                401 => " — check the API key in Settings → Voice.",
                403 => " — the key lacks Realtime access, or the model id is wrong (OpenAI: gpt-realtime-2.1; Grok: grok-voice-latest).",
                404 => " — unknown model or endpoint; verify the provider's model id and base URL.",
                _ => "",
            };
            other(format!("realtime connect rejected ({status}): {body}{hint}"))
        } else {
            other(format!("realtime connect failed: {e}"))
        }
    })?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::unbounded_channel::<ControlMsg>();
    let (audio_tx, mut audio_rx) = mpsc::channel::<String>(AUDIO_QUEUE_CAPACITY);
    let stats = Arc::new(SessionStats::default());
    sessions().lock().insert(
        session_id.clone(),
        Session {
            tx,
            audio_tx,
            stats: stats.clone(),
        },
    );

    let session_update = build_session_update(
        &provider.kind,
        provider.model.as_deref(),
        provider.voice.as_deref(),
        instructions.as_deref(),
        tools.as_ref(),
    );

    // Opt-in wire tracing (`LOTUS_S2S_DEBUG=1`) — prints the outbound session config and every inbound
    // event type (audio deltas suppressed to avoid flooding) to stderr. Invaluable for diagnosing a
    // session that connects but never replies; off by default so production stays quiet.
    let debug = std::env::var("LOTUS_S2S_DEBUG").is_ok_and(|v| v != "0" && !v.is_empty());
    if debug {
        eprintln!("[s2s] → session.update {session_update}");
    }

    let task_id = session_id.clone();
    tokio::spawn(async move {
        let (mut write, mut read) = ws_stream.split();

        // Configure the session before any audio flows.
        if write.send(Message::Text(session_update)).await.is_err() {
            let _ = channel.send(S2sStreamEvent::Error {
                message: "failed to send session.update".to_string(),
            });
            sessions().lock().remove(&task_id);
            return;
        }

        // Running count of audio-byte deltas since the last non-delta frame, so the debug log can
        // confirm the model actually streams audio (not just a transcript) without flooding stderr.
        let mut audio_deltas: u64 = 0;
        loop {
            tokio::select! {
                audio = audio_rx.recv() => match audio {
                    Some(audio_base64) => {
                        let ev = json!({ "type": "input_audio_buffer.append", "audio": audio_base64 }).to_string();
                        if write.send(Message::Text(ev)).await.is_err() {
                            break;
                        }
                        stats.forwarded_audio_chunks.fetch_add(1, Ordering::Relaxed);
                    }
                    None => break,
                },
                ctrl = rx.recv() => match ctrl {
                    Some(ControlMsg::Interrupt) => {
                        let _ = write.send(Message::Text(json!({ "type": "response.cancel" }).to_string())).await;
                    }
                    Some(ControlMsg::Truncate { item_id, audio_end_ms }) => {
                        let msg = build_truncate_message(&item_id, audio_end_ms);
                        let _ = write.send(Message::Text(msg)).await;
                    }
                    Some(ControlMsg::ToolResult { call_id, output, continue_response }) => {
                        for ev in build_tool_result_messages(&call_id, &output, continue_response) {
                            if write.send(Message::Text(ev)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Some(ControlMsg::SessionUpdate(update)) => {
                        if write.send(Message::Text(update)).await.is_err() {
                            break;
                        }
                    }
                    Some(ControlMsg::Close) | None => {
                        let _ = write.send(Message::Close(None)).await;
                        break;
                    }
                },
                inbound = read.next() => match inbound {
                    Some(Ok(Message::Text(text))) => {
                        if debug {
                            if text.contains("output_audio.delta") || text.contains("\"response.audio.delta\"") {
                                audio_deltas += 1;
                            } else {
                                if audio_deltas > 0 {
                                    eprintln!("[s2s] ← ({audio_deltas} audio deltas)");
                                    audio_deltas = 0;
                                }
                                log_inbound(&text);
                            }
                        }
                        if let Some(ev) = parse_realtime_message(&text) {
                            let _ = channel.send(ev);
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        // The frontend matches this prefix to treat a read failure as a reconnectable
                        // drop (s2s-stream-bridge.ts, TRANSPORT_READ_ERROR_PREFIX). Keep them in sync.
                        let _ = channel.send(S2sStreamEvent::Error { message: format!("realtime stream error: {e}") });
                        break;
                    }
                },
            }
        }

        let _ = channel.send(S2sStreamEvent::Closed);
        sessions().lock().remove(&task_id);
    });

    Ok(session_id)
}

/// Forward one base64-encoded PCM16 mic chunk to the realtime socket.
pub fn cmd_send(session_id: &str, audio_base64: &str) -> Result<(), AppError> {
    if audio_base64.is_empty() {
        return Ok(());
    }
    let map = sessions().lock();
    let session = map
        .get(session_id)
        .ok_or_else(|| other(format!("s2s stream '{session_id}' is not active")))?;
    try_enqueue_audio(session, audio_base64.to_string())
}

/// Snapshot backpressure diagnostics for an open voice-to-voice stream. No audio, transcripts,
/// provider payloads, session ids, or secrets are returned — only compact queue counters.
pub fn cmd_diagnostics(session_id: &str) -> Result<S2sStreamDiagnostics, AppError> {
    let map = sessions().lock();
    let session = map
        .get(session_id)
        .ok_or_else(|| other(format!("s2s stream '{session_id}' is not active")))?;
    Ok(build_diagnostics(session))
}

/// Barge-in: cancel the model's in-flight response so the user can interrupt.
pub fn cmd_interrupt(session_id: &str) -> Result<(), AppError> {
    if let Some(session) = sessions().lock().get(session_id) {
        let _ = session.tx.send(ControlMsg::Interrupt);
    }
    Ok(())
}

/// Barge-in continuation: after [`cmd_interrupt`] cancels the model's in-flight response, tell the
/// provider how many milliseconds of the assistant's audio the user actually heard, so it can
/// delete the un-heard tail of the transcript from context (`conversation.item.truncate`). Per
/// OpenAI's realtime docs, skipping this leaves sentences in context that the user never heard,
/// so the model can go on to reference something it never actually said.
///
/// `audio_end_ms` must be a non-negative integer — rejected here at the command boundary rather
/// than forwarded as an invalid frame the server would error on. A session id that no longer
/// exists is a silent no-op (mirrors [`cmd_interrupt`]), not a caller-visible error.
pub fn cmd_truncate(session_id: &str, item_id: &str, audio_end_ms: i64) -> Result<(), AppError> {
    if audio_end_ms < 0 {
        return Err(other(format!(
            "audio_end_ms must be a non-negative integer, got {audio_end_ms}"
        )));
    }
    if let Some(session) = sessions().lock().get(session_id) {
        let _ = session.tx.send(ControlMsg::Truncate {
            item_id: item_id.to_string(),
            audio_end_ms: audio_end_ms as u64,
        });
    }
    Ok(())
}

/// Send a frontend-executed realtime function result back to the provider.
pub fn cmd_tool_result(
    session_id: &str,
    call_id: &str,
    output: &str,
    continue_response: bool,
) -> Result<(), AppError> {
    if call_id.trim().is_empty() {
        return Err(other("s2s tool result call_id is required"));
    }
    let map = sessions().lock();
    let session = map
        .get(session_id)
        .ok_or_else(|| other(format!("s2s stream '{session_id}' is not active")))?;
    session
        .tx
        .send(ControlMsg::ToolResult {
            call_id: call_id.to_string(),
            output: output.to_string(),
            continue_response,
        })
        .map_err(|_| other("s2s stream closed"))?;
    Ok(())
}

/// Refresh instructions/tools on an open voice-to-voice session.
pub fn cmd_update(
    session_id: &str,
    instructions: Option<String>,
    tools_json: Option<String>,
) -> Result<(), AppError> {
    let tools = parse_tools_json(tools_json.as_deref())?;
    let update = build_context_session_update(instructions.as_deref(), tools.as_ref());
    let guard = sessions().lock();
    let session = guard
        .get(session_id)
        .ok_or_else(|| other(format!("s2s session '{session_id}' not found")))?;
    session
        .tx
        .send(ControlMsg::SessionUpdate(update))
        .map_err(|_| other("s2s session is closed"))
}

pub fn cmd_close(session_id: &str) -> Result<(), AppError> {
    if let Some(session) = sessions().lock().get(session_id) {
        let _ = session.tx.send(ControlMsg::Close);
    }
    Ok(())
}

/// Close every open voice-to-voice session — the `RunEvent::Exit` path, so quitting Lotus never
/// leaves a realtime socket streaming (and billing). Each driver sends a WS close frame and exits.
pub fn close_all() {
    for (_, session) in sessions().lock().drain() {
        let _ = session.tx.send(ControlMsg::Close);
    }
}

#[cfg(test)]
mod tests;
