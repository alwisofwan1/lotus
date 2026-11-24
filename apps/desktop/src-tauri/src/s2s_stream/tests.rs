use super::*;

#[test]
fn bounded_audio_queue_drops_overload_and_reports_sanitized_diagnostics() {
    let (audio_tx, mut audio_rx) = mpsc::channel::<String>(2);
    let (tx, _rx) = mpsc::unbounded_channel::<ControlMsg>();
    let stats = Arc::new(SessionStats::default());
    let session = Session {
        tx,
        audio_tx,
        stats: stats.clone(),
    };

    try_enqueue_audio(&session, "a".to_string()).unwrap();
    try_enqueue_audio(&session, "b".to_string()).unwrap();
    try_enqueue_audio(&session, "c".to_string()).unwrap();

    let diag = build_diagnostics(&session);
    assert_eq!(diag.queue_capacity, 2);
    assert_eq!(diag.queue_used, 2);
    assert_eq!(diag.enqueued_audio_chunks, 2);
    assert_eq!(diag.dropped_audio_chunks, 1);
    assert_eq!(diag.forwarded_audio_chunks, 0);

    assert_eq!(audio_rx.try_recv().unwrap(), "a");
    try_enqueue_audio(&session, "d".to_string()).unwrap();
    let diag = build_diagnostics(&session);
    assert_eq!(diag.enqueued_audio_chunks, 3);
    assert_eq!(diag.dropped_audio_chunks, 1);
}

#[test]
fn stream_event_serializes_fields_in_camelcase_the_frontend_reads() {
    // The renderer bridge reads `audioBase64`, `isFinal`, `callId`. `#[serde(rename_all)]` on an
    // enum renames only the VARIANT tags, NOT struct-variant fields — so without per-field/field
    // renaming these arrive snake_case and the frontend reads `undefined` (silent audio: the whole
    // playback saga). This locks the wire shape.
    let audio = serde_json::to_value(S2sStreamEvent::AudioDelta {
        audio_base64: "QUJD".into(),
        response_id: None,
    })
    .unwrap();
    assert_eq!(audio["kind"], "audioDelta");
    assert_eq!(audio["audioBase64"], "QUJD", "field must be camelCase");
    assert!(audio.get("responseId").is_none());

    let t = serde_json::to_value(S2sStreamEvent::Transcript {
        text: "hi".into(),
        is_final: true,
        speaker: Some("user"),
        item_id: None,
        content_index: None,
        cumulative: false,
    })
    .unwrap();
    assert_eq!(t["isFinal"], true);
    assert_eq!(t["speaker"], "user");

    let call = serde_json::to_value(S2sStreamEvent::ToolCall {
        call_id: "c1".into(),
        name: "spawn".into(),
        arguments: "{}".into(),
    })
    .unwrap();
    assert_eq!(call["callId"], "c1");
}

#[test]
fn transcript_item_id_and_content_index_serialize_camelcase_and_absent_is_omitted() {
    // Slice 1: `itemId`/`contentIndex` let the frontend accumulator tell "same item, refined
    // text" from "next item" apart. Absent must be an OMITTED key, never an empty string — a
    // present-but-empty `itemId` would be indistinguishable from a real (if unlikely) empty id.
    let present = serde_json::to_value(S2sStreamEvent::Transcript {
        text: "halo".into(),
        is_final: false,
        speaker: Some("user"),
        item_id: Some("item_abc".into()),
        content_index: Some(0),
        cumulative: false,
    })
    .unwrap();
    assert_eq!(present["itemId"], "item_abc");
    assert_eq!(present["contentIndex"], 0);

    let absent = serde_json::to_value(S2sStreamEvent::Transcript {
        text: "halo".into(),
        is_final: false,
        speaker: Some("user"),
        item_id: None,
        content_index: None,
        cumulative: false,
    })
    .unwrap();
    assert!(absent.get("itemId").is_none());
    assert!(absent.get("contentIndex").is_none());
}

#[test]
fn builds_wss_url_and_appends_model() {
    assert_eq!(
        build_realtime_url("wss://api.x.ai/v1/realtime", Some("grok-voice")),
        "wss://api.x.ai/v1/realtime?model=grok-voice"
    );
}

#[test]
fn coerces_https_base_and_omits_blank_model() {
    assert_eq!(
        build_realtime_url("https://api.openai.com/v1/realtime", None),
        "wss://api.openai.com/v1/realtime"
    );
    assert_eq!(
        build_realtime_url("wss://api.x.ai/v1/realtime/", Some("")),
        "wss://api.x.ai/v1/realtime"
    );
}

#[test]
fn session_update_uses_ga_nested_pcm_duplex_server_vad_and_input_transcription() {
    // Grok keeps server_vad with a long-utterance-safe silence boundary, but uses its native
    // cumulative transcriber and disables default high reasoning for low-latency tool routing.
    let raw = build_session_update(
        "grok",
        Some("grok-voice-latest"),
        Some("alloy"),
        Some("Be concise."),
        None,
    );
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["type"], "session.update");
    // GA schema: type=realtime, output_modalities, nested audio.input/output PCM 24 kHz.
    assert_eq!(v["session"]["type"], "realtime");
    assert_eq!(v["session"]["output_modalities"][0], "audio");
    assert_eq!(
        v["session"]["audio"]["input"]["format"]["type"],
        "audio/pcm"
    );
    assert_eq!(v["session"]["audio"]["input"]["format"]["rate"], 24000);
    assert_eq!(
        v["session"]["audio"]["input"]["turn_detection"]["type"],
        "server_vad"
    );
    assert_eq!(
        v["session"]["audio"]["input"]["turn_detection"]["silence_duration_ms"],
        850
    );
    assert_eq!(
        v["session"]["audio"]["input"]["transcription"]["model"],
        "grok-transcribe"
    );
    assert_eq!(v["session"]["reasoning"]["effort"], "none");
    assert_eq!(
        v["session"]["audio"]["output"]["format"]["type"],
        "audio/pcm"
    );
    assert_eq!(v["session"]["audio"]["output"]["voice"], "alloy");
    assert_eq!(v["session"]["instructions"], "Be concise.");
    // The retired Beta flat fields must be gone.
    assert!(v["session"].get("input_audio_format").is_none());
    assert!(v["session"].get("modalities").is_none());
    assert!(v["session"].get("voice").is_none());
}

#[test]
fn session_update_uses_semantic_vad_and_fast_transcription_for_openai_realtime() {
    // OpenAI semantic VAD protects incomplete speech while high eagerness returns completed
    // command turns promptly. Pair it with the delta-streaming gpt-4o-mini-transcribe model.
    let raw = build_session_update(
        "openai-realtime",
        Some("gpt-realtime-2.1"),
        None,
        None,
        None,
    );
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let turn_detection = &v["session"]["audio"]["input"]["turn_detection"];
    assert_eq!(turn_detection["type"], "semantic_vad");
    assert_eq!(turn_detection["eagerness"], "high");
    assert_eq!(turn_detection["create_response"], true);
    assert_eq!(turn_detection["interrupt_response"], true);
    assert_eq!(v["session"]["reasoning"]["effort"], "low");
    assert_eq!(
        v["session"]["audio"]["input"]["transcription"]["model"],
        "gpt-4o-mini-transcribe"
    );
}

#[test]
fn session_update_keeps_conservative_fallbacks_for_custom_kind() {
    // Custom compatible providers are unverified for provider-native VAD, transcription, and
    // reasoning fields, so they keep server_vad + 850ms + whisper-1 without reasoning config.
    let raw = build_session_update("custom", None, None, None, None);
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(
        v["session"]["audio"]["input"]["turn_detection"]["type"],
        "server_vad"
    );
    assert_eq!(
        v["session"]["audio"]["input"]["turn_detection"]["silence_duration_ms"],
        850
    );
    assert_eq!(
        v["session"]["audio"]["input"]["transcription"]["model"],
        "whisper-1"
    );
    assert!(v["session"].get("reasoning").is_none());
}

#[test]
fn session_update_omits_reasoning_for_models_without_reasoning_support() {
    for (kind, model) in [
        ("openai-realtime", "gpt-realtime-1.5"),
        ("grok", "grok-voice-fast-1.0"),
    ] {
        let raw = build_session_update(kind, Some(model), None, None, None);
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(
            v["session"].get("reasoning").is_none(),
            "{kind}/{model} must not receive an unsupported reasoning field"
        );
    }
}

#[test]
fn session_update_omits_absent_voice_instructions_and_tools() {
    let raw = build_session_update("grok", Some("grok-voice-latest"), None, None, None);
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(v["session"]["audio"]["output"].get("voice").is_none());
    assert!(v["session"].get("instructions").is_none());
    assert!(v["session"].get("tools").is_none());
    assert!(v["session"].get("tool_choice").is_none());
}

#[test]
fn session_update_advertises_concierge_tools_when_provided() {
    let tools = json!([{ "type": "function", "name": "spawn_agent" }]);
    let raw = build_session_update("grok", Some("grok-voice-latest"), None, None, Some(&tools));
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["session"]["tools"][0]["name"], "spawn_agent");
    assert_eq!(v["session"]["tool_choice"], "auto");
}

#[test]
fn context_session_update_refreshes_only_instructions_and_tools() {
    let tools = json!([{ "type": "function", "name": "dispatch" }]);
    let raw = build_context_session_update(Some("Visible agents: Bima is Claude 3"), Some(&tools));
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["type"], "session.update");
    assert_eq!(v["session"]["type"], "realtime");
    assert_eq!(
        v["session"]["instructions"],
        "Visible agents: Bima is Claude 3"
    );
    assert_eq!(v["session"]["tools"][0]["name"], "dispatch");
    assert_eq!(v["session"]["tool_choice"], "auto");
    assert!(v["session"].get("audio").is_none());
}

#[test]
fn parses_a_function_call_into_a_tool_call_event() {
    let msg = r#"{"type":"response.function_call_arguments.done","call_id":"c1","name":"spawn_agent","arguments":"{\"brief\":\"go\"}"}"#;
    match parse_realtime_message(msg).unwrap() {
        S2sStreamEvent::ToolCall {
            call_id,
            name,
            arguments,
        } => {
            assert_eq!(call_id, "c1");
            assert_eq!(name, "spawn_agent");
            assert_eq!(arguments, "{\"brief\":\"go\"}");
        }
        _ => panic!("expected ToolCall"),
    }
}

#[test]
fn parses_ga_and_legacy_audio_delta_into_playable_base64() {
    for msg in [
        r#"{"type":"response.output_audio.delta","delta":"QUJD"}"#,
        r#"{"type":"response.audio.delta","delta":"QUJD"}"#,
    ] {
        match parse_realtime_message(msg).unwrap() {
            S2sStreamEvent::AudioDelta {
                audio_base64,
                response_id,
            } => {
                assert_eq!(audio_base64, "QUJD");
                assert_eq!(response_id, None);
            }
            _ => panic!("expected AudioDelta for {msg}"),
        }
    }
}

#[test]
fn parses_input_transcription_delta_into_non_final_user_transcript_and_skips_empty() {
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"halo"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript {
            text,
            is_final,
            speaker,
            item_id,
            content_index,
            cumulative,
        } => {
            assert_eq!(text, "halo");
            assert!(!is_final);
            assert_eq!(speaker, Some("user"));
            assert!(
                !cumulative,
                "an OpenAI `.delta` is incremental, never cumulative"
            );
            // No item_id/content_index in the wire frame — must stay None, not "".
            assert_eq!(item_id, None);
            assert_eq!(content_index, None);
        }
        _ => panic!("expected Transcript"),
    }

    assert!(parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":""}"#
    )
    .is_none());
}

#[test]
fn parses_item_id_and_content_index_on_input_transcription_delta() {
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"halo","item_id":"item_1","content_index":2}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript {
            item_id,
            content_index,
            ..
        } => {
            assert_eq!(item_id.as_deref(), Some("item_1"));
            assert_eq!(content_index, Some(2));
        }
        _ => panic!("expected Transcript"),
    }
}

#[test]
fn parses_grok_cumulative_transcription_update_as_non_final_user_transcript() {
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.updated","transcript":"tolong kirim ke Atlas"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript {
            text,
            is_final,
            speaker,
            item_id,
            content_index,
            cumulative,
        } => {
            assert_eq!(text, "tolong kirim ke Atlas");
            assert!(!is_final);
            assert_eq!(speaker, Some("user"));
            assert!(cumulative, "xAI `.updated` carries the whole item so far — it REPLACES, not appends");
            assert_eq!(item_id, None);
            assert_eq!(content_index, None);
        }
        _ => panic!("expected Transcript"),
    }
}

#[test]
fn parses_item_id_on_grok_cumulative_transcription_update() {
    // The `.updated` cumulative event still carries item_id — needed so the merge accumulator
    // (Slice 2, TS side) can tell "same item, newer cumulative snapshot" from "next item".
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.updated","transcript":"tolong","item_id":"item_9"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript { item_id, .. } => {
            assert_eq!(item_id.as_deref(), Some("item_9"));
        }
        _ => panic!("expected Transcript"),
    }
}

#[test]
fn tool_result_messages_create_one_continuation_only_for_the_final_batch_item() {
    let deferred = build_tool_result_messages("call_1", r#"{"ok":true}"#, false);
    assert_eq!(deferred.len(), 1);
    let item: serde_json::Value = serde_json::from_str(&deferred[0]).unwrap();
    assert_eq!(item["type"], "conversation.item.create");
    assert_eq!(item["item"]["type"], "function_call_output");
    assert_eq!(item["item"]["call_id"], "call_1");
    assert_eq!(item["item"]["output"], r#"{"ok":true}"#);

    let final_item = build_tool_result_messages("call_2", r#"{"ok":true}"#, true);
    assert_eq!(final_item.len(), 2);
    let response: serde_json::Value = serde_json::from_str(&final_item[1]).unwrap();
    assert_eq!(response["type"], "response.create");
}

#[test]
fn parses_response_done_separately_from_audio_done() {
    assert!(matches!(
        parse_realtime_message(r#"{"type":"response.done"}"#).unwrap(),
        S2sStreamEvent::ResponseDone
    ));
    assert!(matches!(
        parse_realtime_message(r#"{"type":"response.output_audio.done"}"#).unwrap(),
        S2sStreamEvent::AgentAudioEnd
    ));
}

#[test]
fn preserves_audio_delta_response_id_for_barge_in_gating() {
    match parse_realtime_message(
        r#"{"type":"response.output_audio.delta","response_id":"resp_1","delta":"QUJD"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::AudioDelta {
            audio_base64,
            response_id,
        } => {
            assert_eq!(audio_base64, "QUJD");
            assert_eq!(response_id.as_deref(), Some("resp_1"));
        }
        _ => panic!("expected AudioDelta"),
    }
}

#[test]
fn maps_vad_and_done_turn_events() {
    assert!(matches!(
        parse_realtime_message(r#"{"type":"input_audio_buffer.speech_started"}"#).unwrap(),
        S2sStreamEvent::UserSpeechStart
    ));
    assert!(matches!(
        parse_realtime_message(r#"{"type":"input_audio_buffer.speech_stopped"}"#).unwrap(),
        S2sStreamEvent::UserSpeechEnd
    ));
    for done in [
        r#"{"type":"response.output_audio.done"}"#,
        r#"{"type":"response.audio.done"}"#,
    ] {
        assert!(matches!(
            parse_realtime_message(done).unwrap(),
            S2sStreamEvent::AgentAudioEnd
        ));
    }
}

#[test]
fn maps_transcript_delta_done_and_user_input_transcript_finality() {
    match parse_realtime_message(
        r#"{"type":"response.output_audio_transcript.delta","delta":"hi"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript {
            text,
            is_final,
            speaker,
            item_id,
            content_index,
            cumulative,
        } => {
            assert_eq!(text, "hi");
            assert!(!is_final);
            assert_eq!(speaker, Some("agent"));
            assert!(!cumulative, "agent transcript deltas are incremental");
            assert_eq!(item_id, None);
            assert_eq!(content_index, None);
        }
        _ => panic!("expected Transcript"),
    }
    match parse_realtime_message(
        r#"{"type":"response.output_audio_transcript.done","transcript":"hello there"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript {
            text,
            is_final,
            speaker,
            ..
        } => {
            assert_eq!(text, "hello there");
            assert!(is_final);
            assert_eq!(speaker, Some("agent"));
        }
        _ => panic!("expected final Transcript"),
    }
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"oke go to sleep"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript { text, is_final, speaker, .. } => {
            assert_eq!(text, "oke go to sleep");
            assert!(is_final);
            assert_eq!(speaker, Some("user"));
        }
        _ => panic!("expected user final Transcript"),
    }
    // Legacy name still parses (Grok parity / older providers).
    assert!(matches!(
        parse_realtime_message(r#"{"type":"response.audio_transcript.delta","delta":"x"}"#)
            .unwrap(),
        S2sStreamEvent::Transcript { .. }
    ));
}

#[test]
fn parses_item_id_on_agent_and_user_completed_transcript_events() {
    match parse_realtime_message(
        r#"{"type":"response.output_audio_transcript.done","transcript":"hello there","item_id":"item_agent_1","content_index":0}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript {
            item_id,
            content_index,
            ..
        } => {
            assert_eq!(item_id.as_deref(), Some("item_agent_1"));
            assert_eq!(content_index, Some(0));
        }
        _ => panic!("expected Transcript"),
    }
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"oke","item_id":"item_user_1","content_index":1}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::Transcript {
            item_id,
            content_index,
            ..
        } => {
            assert_eq!(item_id.as_deref(), Some("item_user_1"));
            assert_eq!(content_index, Some(1));
        }
        _ => panic!("expected Transcript"),
    }
}

#[test]
fn surfaces_error_message_and_ignores_unknown_events() {
    match parse_realtime_message(r#"{"type":"error","error":{"message":"bad key"}}"#).unwrap() {
        S2sStreamEvent::Error { message } => assert_eq!(message, "bad key"),
        _ => panic!("expected Error"),
    }
    assert!(parse_realtime_message(r#"{"type":"response.created"}"#).is_none());
    assert!(parse_realtime_message("not json").is_none());
    assert!(
        parse_realtime_message(r#"{"type":"response.output_audio.delta","delta":""}"#).is_none()
    );
}

// ── Slice 9: `.failed` / `.segment` ─────────────────────────────────────────────────────────

#[test]
fn parses_input_transcription_failed_as_a_distinct_recoverable_event_not_generic_error() {
    // A failed transcription must NOT become `S2sStreamEvent::Error` — the TS reducer
    // (`s2s-session.ts` `reduceS2sSession`) treats ANY `error` event as terminal and fires a
    // `teardown` effect for the whole live-voice session (confirmed by reading the reducer: the
    // `case "error"` arm sets `phase: "error"` and returns `effects: [{ type: "teardown" }]`,
    // and terminal phases ignore every subsequent event). One bad transcription killing an
    // otherwise-healthy duplex session would be a regression, not a fix.
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.failed","item_id":"item_5","content_index":0,"error":{"code":"transcription_failed","message":"could not transcribe audio"}}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::TranscriptionFailed {
            item_id,
            content_index,
            code,
            message,
        } => {
            assert_eq!(item_id.as_deref(), Some("item_5"));
            assert_eq!(content_index, Some(0));
            assert_eq!(code.as_deref(), Some("transcription_failed"));
            assert_eq!(message, "could not transcribe audio");
        }
        other => panic!("expected TranscriptionFailed, got a different variant: {other:?}"),
    }
}

#[test]
fn transcription_failed_serializes_camelcase_and_tolerates_missing_error_fields() {
    let v = serde_json::to_value(S2sStreamEvent::TranscriptionFailed {
        item_id: Some("item_5".into()),
        content_index: Some(0),
        code: None,
        message: "input audio transcription failed".into(),
    })
    .unwrap();
    assert_eq!(v["kind"], "transcriptionFailed");
    assert_eq!(v["itemId"], "item_5");
    assert_eq!(v["contentIndex"], 0);
    assert!(v.get("code").is_none());
    assert_eq!(v["message"], "input audio transcription failed");

    // Absent `error.code`/`error.message` in the wire frame must not panic and must not silently
    // become "" — a placeholder message beats a crash or an empty string that hides the failure.
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.failed","item_id":"item_6"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::TranscriptionFailed {
            item_id,
            code,
            message,
            ..
        } => {
            assert_eq!(item_id.as_deref(), Some("item_6"));
            assert_eq!(code, None);
            assert!(!message.is_empty());
        }
        _ => panic!("expected TranscriptionFailed"),
    }
}

#[test]
fn parses_input_transcription_segment_preserving_id_timing_speaker_and_text() {
    match parse_realtime_message(
        r#"{"type":"conversation.item.input_audio_transcription.segment","id":"seg_1","start":0.5,"end":1.25,"speaker":"user","text":"tolong kirim"}"#,
    )
    .unwrap()
    {
        S2sStreamEvent::TranscriptionSegment {
            id,
            start,
            end,
            speaker,
            text,
        } => {
            assert_eq!(id, "seg_1");
            assert_eq!(start, 0.5);
            assert_eq!(end, 1.25);
            assert_eq!(speaker.as_deref(), Some("user"));
            assert_eq!(text, "tolong kirim");
        }
        other => panic!("expected TranscriptionSegment, got a different variant: {other:?}"),
    }
}

#[test]
fn transcription_segment_serializes_camelcase_tag_and_omits_absent_speaker() {
    let v = serde_json::to_value(S2sStreamEvent::TranscriptionSegment {
        id: "seg_1".into(),
        start: 0.0,
        end: 1.0,
        speaker: None,
        text: "hi".into(),
    })
    .unwrap();
    assert_eq!(v["kind"], "transcriptionSegment");
    assert_eq!(v["id"], "seg_1");
    assert!(v.get("speaker").is_none());
    assert_eq!(v["text"], "hi");
}

// ── Slice 7: barge-in `conversation.item.truncate` ──────────────────────────────────────────

#[test]
fn builds_truncate_message_with_item_id_content_index_zero_and_audio_end_ms() {
    // OpenAI docs: truncating deletes the server-side text transcript for audio the user never
    // actually heard, so the model's context can't reference lines it never spoke aloud.
    let raw = build_truncate_message("item_42", 1_250);
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["type"], "conversation.item.truncate");
    assert_eq!(v["item_id"], "item_42");
    assert_eq!(v["content_index"], 0);
    assert_eq!(v["audio_end_ms"], 1250);
}

#[test]
fn cmd_truncate_rejects_negative_audio_end_ms_before_touching_the_session() {
    // The guard must fire even for a session id that does not exist — negative input is invalid
    // regardless of session state, and we must never send an invalid frame the server would
    // reject anyway.
    let err = cmd_truncate("no-such-session", "item_1", -1).unwrap_err();
    assert!(
        err.to_string().contains("audio_end_ms"),
        "error should name the offending field: {err}"
    );
}

#[test]
fn cmd_truncate_accepts_zero_and_positive_audio_end_ms_for_an_unknown_session() {
    // No live session to deliver to, but a valid (non-negative) value must not error — the
    // command degrades to a no-op rather than surfacing a spurious failure to the caller.
    assert!(cmd_truncate("no-such-session", "item_1", 0).is_ok());
    assert!(cmd_truncate("no-such-session", "item_1", 500).is_ok());
}

// A non-final transcript is NOT self-describing: OpenAI's `.delta` is an INCREMENTAL fragment while
// xAI's `.updated` is the CUMULATIVE transcript of the item so far
// (docs.x.ai/developers/model-capabilities/audio/voice-agent.md). Both were mapped to an identical
// `is_final: false` shape, so a consumer could not tell "append me" from "replace me" — and treating a
// `.delta` as cumulative is exactly how the quadratic duplication bug reappears. `cumulative` makes the
// distinction explicit at the event level, so it does not depend on a provider-kind lookup table.
#[test]
fn marks_only_the_cumulative_update_event_as_cumulative_never_the_incremental_delta() {
    let cumulative_of = |raw: &str| match parse_realtime_message(raw).unwrap() {
        S2sStreamEvent::Transcript { cumulative, .. } => cumulative,
        _ => panic!("expected Transcript"),
    };

    assert!(cumulative_of(
        r#"{"type":"conversation.item.input_audio_transcription.updated","transcript":"tolong kirim"}"#
    ));
    assert!(!cumulative_of(
        r#"{"type":"conversation.item.input_audio_transcription.delta","delta":"kirim"}"#
    ));
    assert!(!cumulative_of(
        r#"{"type":"conversation.item.input_audio_transcription.completed","transcript":"tolong kirim"}"#
    ));
    assert!(!cumulative_of(
        r#"{"type":"response.output_audio_transcript.delta","delta":"baik"}"#
    ));
}

#[test]
fn cumulative_flag_serializes_camelcase_and_is_omitted_when_false() {
    let cumulative = S2sStreamEvent::Transcript {
        text: "tolong".into(),
        is_final: false,
        speaker: Some("user"),
        item_id: None,
        content_index: None,
        cumulative: true,
    };
    let json = serde_json::to_value(&cumulative).unwrap();
    assert_eq!(json.get("cumulative").and_then(|v| v.as_bool()), Some(true));

    let incremental = S2sStreamEvent::Transcript {
        text: "tolong".into(),
        is_final: false,
        speaker: Some("user"),
        item_id: None,
        content_index: None,
        cumulative: false,
    };
    let json = serde_json::to_value(&incremental).unwrap();
    assert!(
        json.get("cumulative").is_none(),
        "false must stay absent, not serialize as false"
    );
}

#[test]
fn realtime_url_encodes_the_model_id_so_it_cannot_add_params() {
    assert_eq!(
        build_realtime_url("wss://api.x.ai/v1/realtime", Some("grok voice&x=1#f")),
        "wss://api.x.ai/v1/realtime?model=grok%20voice%26x%3D1%23f"
    );
    assert_eq!(
        build_realtime_url(
            "wss://proxy.local/realtime?team=a",
            Some("gpt-realtime-2.1")
        ),
        "wss://proxy.local/realtime?team=a&model=gpt-realtime-2.1"
    );
}

#[test]
fn invalid_tools_json_is_an_error_not_silently_dropped() {
    assert_eq!(parse_tools_json(None).unwrap(), None);
    assert_eq!(parse_tools_json(Some("  ")).unwrap(), None);
    assert_eq!(
        parse_tools_json(Some(r#"[{"type":"function","name":"x"}]"#)).unwrap(),
        Some(json!([{"type": "function", "name": "x"}]))
    );
    let err = parse_tools_json(Some("[{\"type\":")).unwrap_err();
    assert!(err.to_string().contains("invalid S2S tools JSON"), "{err}");
}

#[test]
fn update_with_invalid_tools_json_fails_before_touching_the_session() {
    let err = cmd_update("no-such-session", None, Some("{oops".to_string())).unwrap_err();
    assert!(err.to_string().contains("invalid S2S tools JSON"), "{err}");
}

#[test]
fn close_all_tells_every_open_session_to_close_and_forgets_it() {
    let mut receivers = Vec::new();
    for id in ["close-all-a", "close-all-b"] {
        let (tx, rx) = mpsc::unbounded_channel::<ControlMsg>();
        let (audio_tx, _audio_rx) = mpsc::channel::<String>(1);
        sessions().lock().insert(
            id.to_string(),
            Session {
                tx,
                audio_tx,
                stats: Arc::new(SessionStats::default()),
            },
        );
        receivers.push(rx);
    }

    close_all();

    assert!(!sessions().lock().contains_key("close-all-a"));
    assert!(!sessions().lock().contains_key("close-all-b"));
    for mut rx in receivers {
        assert!(matches!(rx.try_recv(), Ok(ControlMsg::Close)));
    }
}
