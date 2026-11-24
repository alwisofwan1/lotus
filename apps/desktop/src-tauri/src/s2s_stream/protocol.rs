use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use serde_json::json;

use super::S2sStreamEvent;
use crate::error::{other, AppError};

/// Everything but RFC 3986 unreserved characters, so a model id cannot add or split query params.
const UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

pub(super) fn build_realtime_url(base_url: &str, model: Option<&str>) -> String {
    let coerced = if let Some(r) = base_url.strip_prefix("https://") {
        format!("wss://{r}")
    } else if let Some(r) = base_url.strip_prefix("http://") {
        format!("ws://{r}")
    } else {
        base_url.to_string()
    };
    let trimmed = coerced.trim_end_matches('/').to_string();
    match model.filter(|m| !m.is_empty()) {
        Some(m) => {
            let sep = if trimmed.contains('?') { '&' } else { '?' };
            format!("{trimmed}{sep}model={}", utf8_percent_encode(m, UNRESERVED))
        }
        None => trimmed,
    }
}

/// Parse the frontend's tool definitions. Absent or blank means "no tools"; anything else must be
/// valid JSON, so a broken tool list fails loudly instead of leaving the agent silently tool-less.
pub(super) fn parse_tools_json(
    tools_json: Option<&str>,
) -> Result<Option<serde_json::Value>, AppError> {
    match tools_json.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(raw) => serde_json::from_str(raw)
            .map(Some)
            .map_err(|e| other(format!("invalid S2S tools JSON: {e}"))),
    }
}

const S2S_PCM_RATE: u32 = 24_000;

pub(super) fn build_tool_result_messages(
    call_id: &str,
    output: &str,
    continue_response: bool,
) -> Vec<String> {
    let mut messages = vec![json!({
        "type": "conversation.item.create",
        "item": {
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        },
    })
    .to_string()];
    if continue_response {
        messages.push(json!({ "type": "response.create" }).to_string());
    }
    messages
}

pub(super) fn build_context_session_update(
    instructions: Option<&str>,
    tools: Option<&serde_json::Value>,
) -> String {
    let mut session = json!({ "type": "realtime" });
    if let Some(i) = instructions.filter(|i| !i.is_empty()) {
        session["instructions"] = json!(i);
    }
    if let Some(t) = tools.filter(|t| t.as_array().map(|a| !a.is_empty()).unwrap_or(false)) {
        session["tools"] = t.clone();
        session["tool_choice"] = json!("auto");
    }
    json!({ "type": "session.update", "session": session }).to_string()
}

fn provider_reasoning_effort(kind: &str, model: Option<&str>) -> Option<&'static str> {
    match (kind, model.unwrap_or_default()) {
        ("grok", "grok-voice-latest" | "grok-voice-think-fast-1.0") => Some("none"),
        ("openai-realtime", model) if model.starts_with("gpt-realtime-2") => Some("low"),
        _ => None,
    }
}

/// Provider-specific initial session profile for low-latency duplex Canvas voice.
pub(super) fn build_session_update(
    kind: &str,
    model: Option<&str>,
    voice: Option<&str>,
    instructions: Option<&str>,
    tools: Option<&serde_json::Value>,
) -> String {
    let mut output = json!({ "format": { "type": "audio/pcm", "rate": S2S_PCM_RATE } });
    if let Some(v) = voice.filter(|v| !v.is_empty()) {
        output["voice"] = json!(v);
    }
    let is_openai_realtime = kind == "openai-realtime";
    let is_grok = kind == "grok";
    let transcription = if is_openai_realtime {
        json!({ "model": "gpt-4o-mini-transcribe" })
    } else if is_grok {
        json!({ "model": "grok-transcribe" })
    } else {
        json!({ "model": "whisper-1" })
    };
    let turn_detection = if is_openai_realtime {
        json!({
            "type": "semantic_vad",
            "eagerness": "high",
            "create_response": true,
            "interrupt_response": true,
        })
    } else {
        json!({
            "type": "server_vad",
            "silence_duration_ms": 850,
            "create_response": true,
            "interrupt_response": true,
        })
    };
    let mut session = json!({
        "type": "realtime",
        "output_modalities": ["audio"],
        "audio": {
            "input": {
                "format": { "type": "audio/pcm", "rate": S2S_PCM_RATE },
                "transcription": transcription,
                "turn_detection": turn_detection,
            },
            "output": output,
        },
    });
    if let Some(effort) = provider_reasoning_effort(kind, model) {
        session["reasoning"] = json!({ "effort": effort });
    }
    if let Some(i) = instructions.filter(|i| !i.is_empty()) {
        session["instructions"] = json!(i);
    }
    if let Some(t) = tools.filter(|t| t.as_array().map(|a| !a.is_empty()).unwrap_or(false)) {
        session["tools"] = t.clone();
        session["tool_choice"] = json!("auto");
    }
    json!({ "type": "session.update", "session": session }).to_string()
}

/// Trace one inbound frame when `LOTUS_S2S_DEBUG` is enabled. Audio deltas stay suppressed. The
/// caller (`s2s_stream.rs`) only invokes this inside its own `LOTUS_S2S_DEBUG` check, so nothing
/// here needs to re-check the flag — the whole function is unreachable when it is unset.
pub(super) fn log_inbound(text: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        eprintln!("[s2s] ← (non-JSON frame, {} bytes)", text.len());
        return;
    };
    let ty = v
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("(no type)");
    match ty {
        "response.output_audio.delta" | "response.audio.delta" => {}
        "error" => eprintln!("[s2s] ← error {}", v.get("error").unwrap_or(&v)),
        // Full echo — the only way to verify a provider (esp. xAI/Grok) actually accepted our
        // nested `audio.input.turn_detection` / `audio.output.voice` session shape rather than
        // silently ignoring it (plan §2.6 gap 6 — Grok session-shape conformance unverified).
        "session.updated" => eprintln!("[s2s] ← session.updated {v}"),
        "conversation.item.input_audio_transcription.delta"
        | "conversation.item.input_audio_transcription.updated"
        | "conversation.item.input_audio_transcription.completed" => {
            let item_id = v.get("item_id").and_then(|i| i.as_str()).unwrap_or("?");
            let content_index = v.get("content_index").and_then(|c| c.as_i64());
            let payload = v
                .get("delta")
                .or_else(|| v.get("transcript"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            eprintln!(
                "[s2s] ← {ty} item_id={item_id} content_index={content_index:?} text={payload:?}"
            );
        }
        "conversation.item.input_audio_transcription.failed" => {
            let item_id = v.get("item_id").and_then(|i| i.as_str()).unwrap_or("?");
            let content_index = v.get("content_index").and_then(|c| c.as_i64());
            let error = v.get("error").cloned().unwrap_or_default();
            eprintln!(
                "[s2s] ← {ty} item_id={item_id} content_index={content_index:?} error={error}"
            );
        }
        "conversation.item.input_audio_transcription.segment" => {
            let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("?");
            let start = v.get("start");
            let end = v.get("end");
            let speaker = v.get("speaker").and_then(|s| s.as_str()).unwrap_or("?");
            let text_payload = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
            eprintln!(
                "[s2s] ← {ty} id={id} start={start:?} end={end:?} speaker={speaker} text={text_payload:?}"
            );
        }
        _ => eprintln!("[s2s] ← {ty}"),
    }
}

/// Barge-in continuation: `{"type":"conversation.item.truncate", "item_id", "content_index":0,
/// "audio_end_ms"}`. Per OpenAI's realtime docs, truncating deletes the server-side text
/// transcript for the un-heard tail of the assistant's turn, so the model's context can never
/// reference something the user was never actually played. `content_index` is always `0` — the
/// app requests single-part audio output, so there is only one content part to truncate.
pub(super) fn build_truncate_message(item_id: &str, audio_end_ms: u64) -> String {
    json!({
        "type": "conversation.item.truncate",
        "item_id": item_id,
        "content_index": 0,
        "audio_end_ms": audio_end_ms,
    })
    .to_string()
}

/// Every transcription event (OpenAI + xAI) carries `item_id`; absent must stay `None`, never "".
fn item_id_of(v: &serde_json::Value) -> Option<String> {
    v.get("item_id")
        .and_then(|i| i.as_str())
        .map(str::to_string)
}

/// `content_index` identifies the content part within the item; absent must stay `None`.
fn content_index_of(v: &serde_json::Value) -> Option<i64> {
    v.get("content_index").and_then(|c| c.as_i64())
}

/// Map an OpenAI/xAI realtime wire event into the renderer-safe stream contract.
pub(super) fn parse_realtime_message(text: &str) -> Option<S2sStreamEvent> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    match v.get("type").and_then(|t| t.as_str())? {
        "response.output_audio.delta" | "response.audio.delta" => {
            let audio = v.get("delta")?.as_str()?;
            if audio.is_empty() {
                return None;
            }
            let response_id = v
                .get("response_id")
                .and_then(|id| id.as_str())
                .map(|id| id.to_string());
            Some(S2sStreamEvent::AudioDelta {
                audio_base64: audio.to_string(),
                response_id,
            })
        }
        "response.output_audio.done" | "response.audio.done" => Some(S2sStreamEvent::AgentAudioEnd),
        "response.done" => Some(S2sStreamEvent::ResponseDone),
        "input_audio_buffer.speech_started" => Some(S2sStreamEvent::UserSpeechStart),
        "input_audio_buffer.speech_stopped" => Some(S2sStreamEvent::UserSpeechEnd),
        "response.output_audio_transcript.delta" | "response.audio_transcript.delta" => {
            let text = v.get("delta")?.as_str()?;
            Some(S2sStreamEvent::Transcript {
                text: text.to_string(),
                is_final: false,
                speaker: Some("agent"),
                item_id: item_id_of(&v),
                content_index: content_index_of(&v),
                cumulative: false,
            })
        }
        "response.output_audio_transcript.done" | "response.audio_transcript.done" => {
            let text = v.get("transcript")?.as_str()?;
            Some(S2sStreamEvent::Transcript {
                text: text.to_string(),
                is_final: true,
                speaker: Some("agent"),
                item_id: item_id_of(&v),
                content_index: content_index_of(&v),
                cumulative: false,
            })
        }
        "conversation.item.input_audio_transcription.completed" => {
            let text = v.get("transcript")?.as_str()?;
            Some(S2sStreamEvent::Transcript {
                text: text.to_string(),
                is_final: true,
                speaker: Some("user"),
                item_id: item_id_of(&v),
                content_index: content_index_of(&v),
                cumulative: false,
            })
        }
        "conversation.item.input_audio_transcription.delta" => {
            let text = v.get("delta")?.as_str()?;
            if text.is_empty() {
                return None;
            }
            Some(S2sStreamEvent::Transcript {
                text: text.to_string(),
                is_final: false,
                speaker: Some("user"),
                item_id: item_id_of(&v),
                content_index: content_index_of(&v),
                cumulative: false,
            })
        }
        "conversation.item.input_audio_transcription.updated" => {
            let text = v.get("transcript")?.as_str()?;
            if text.is_empty() {
                return None;
            }
            Some(S2sStreamEvent::Transcript {
                text: text.to_string(),
                is_final: false,
                speaker: Some("user"),
                item_id: item_id_of(&v),
                content_index: content_index_of(&v),
                cumulative: true,
            })
        }
        "conversation.item.input_audio_transcription.failed" => {
            // Recoverable, per-item — deliberately NOT `S2sStreamEvent::Error` (see the test
            // `parses_input_transcription_failed_as_a_distinct_recoverable_event_not_generic_error`
            // for why: `Error` reaches the TS session reducer's terminal `error` phase and tears
            // the whole live-voice session down; one failed transcription must not do that).
            let error = v.get("error");
            let message = error
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("input audio transcription failed")
                .to_string();
            let code = error
                .and_then(|e| e.get("code"))
                .and_then(|c| c.as_str())
                .map(str::to_string);
            Some(S2sStreamEvent::TranscriptionFailed {
                item_id: item_id_of(&v),
                content_index: content_index_of(&v),
                code,
                message,
            })
        }
        "conversation.item.input_audio_transcription.segment" => {
            let id = v.get("id")?.as_str()?.to_string();
            let start = v.get("start").and_then(|s| s.as_f64()).unwrap_or(0.0);
            let end = v.get("end").and_then(|e| e.as_f64()).unwrap_or(0.0);
            let speaker = v
                .get("speaker")
                .and_then(|s| s.as_str())
                .map(str::to_string);
            let text = v.get("text")?.as_str()?.to_string();
            Some(S2sStreamEvent::TranscriptionSegment {
                id,
                start,
                end,
                speaker,
                text,
            })
        }
        "response.function_call_arguments.done" => {
            let name = v.get("name")?.as_str()?;
            let arguments = v
                .get("arguments")
                .and_then(|a| a.as_str())
                .unwrap_or("{}")
                .to_string();
            let call_id = v
                .get("call_id")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            Some(S2sStreamEvent::ToolCall {
                call_id,
                name: name.to_string(),
                arguments,
            })
        }
        "error" => {
            let message = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("realtime error")
                .to_string();
            Some(S2sStreamEvent::Error { message })
        }
        _ => None,
    }
}
