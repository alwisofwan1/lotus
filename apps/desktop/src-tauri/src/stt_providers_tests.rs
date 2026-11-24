use super::*;
use crate::stt_decoder_context::{
    build_openai_context_fields, parse_openai_transcript, sanitize_decoder_prompt,
    MAX_DECODER_PROMPT_CHARS,
};

fn cfg(id: &str, kind: &str, key: Option<&str>) -> SttProviderConfig {
    SttProviderConfig {
        id: id.to_string(),
        name: id.to_string(),
        kind: kind.to_string(),
        builtin: false,
        enabled: true,
        base_url: None,
        api_key: key.map(|k| k.to_string()),
        model: None,
        language: None,
    }
}

#[test]
fn debug_output_never_exposes_the_api_key() {
    let provider = cfg("openai", "openai", Some("sk-super-secret"));
    let debug = format!("{provider:?}");
    assert!(!debug.contains("sk-super-secret"), "{debug}");
    assert!(debug.contains("<redacted>"), "{debug}");
}

#[test]
fn sanitizes_and_bounds_decoder_context_before_multipart_encoding() {
    let prompt = format!("trusted name\r\n--boundary injection {}", "x".repeat(4_000));
    let sanitized = sanitize_decoder_prompt(&prompt);
    assert!(!sanitized.contains('\r'));
    assert!(!sanitized.contains('\n'));
    assert!(sanitized.len() <= MAX_DECODER_PROMPT_CHARS);
}

#[test]
fn projects_structured_context_only_to_fields_supported_by_the_openai_model() {
    let context = SttDecoderContext {
        prompt: "Technical dictation".to_string(),
        keywords: vec!["Lotus".to_string(), "AGENTS.md".to_string()],
        languages: vec!["id".to_string(), "en".to_string()],
    };

    assert_eq!(
        build_openai_context_fields("gpt-transcribe", Some(&context), true),
        vec![
            ("prompt".to_string(), "Technical dictation".to_string()),
            ("keywords[]".to_string(), "Lotus".to_string()),
            ("keywords[]".to_string(), "AGENTS.md".to_string()),
            ("languages[]".to_string(), "id".to_string()),
            ("languages[]".to_string(), "en".to_string()),
        ]
    );
    assert_eq!(
        build_openai_context_fields("gpt-4o-transcribe", Some(&context), true),
        vec![(
            "prompt".to_string(),
            "Technical dictation Vocabulary only: Lotus, AGENTS.md.".to_string()
        )]
    );
    let single_regional_language = SttDecoderContext {
        prompt: "Natural speech".to_string(),
        keywords: vec![],
        languages: vec!["id-ID".to_string()],
    };
    assert_eq!(
        build_openai_context_fields("gpt-4o-transcribe", Some(&single_regional_language), true),
        vec![
            ("language".to_string(), "id".to_string()),
            ("prompt".to_string(), "Natural speech".to_string()),
        ]
    );
    assert_eq!(
        build_openai_context_fields("custom-model", Some(&context), false),
        vec![("prompt".to_string(), "Technical dictation".to_string())]
    );
    assert_eq!(
        build_openai_context_fields("gpt-transcribe", Some(&context), false),
        vec![("prompt".to_string(), "Technical dictation".to_string())]
    );
}

#[test]
fn gpt_transcribe_receives_bare_language_codes_because_regional_tags_are_rejected() {
    // OpenAI answers `languages[]=id-ID` with HTTP 400 "Invalid request." (param null), while
    // `languages[]=id` succeeds; device locales such as `id-ID` and `en-US` reach this path.
    let context = SttDecoderContext {
        prompt: String::new(),
        keywords: vec![],
        languages: vec!["id-ID".to_string(), "en-US".to_string(), "ID".to_string()],
    };

    assert_eq!(
        build_openai_context_fields("gpt-transcribe", Some(&context), true),
        vec![
            ("languages[]".to_string(), "id".to_string()),
            ("languages[]".to_string(), "en".to_string()),
        ]
    );
}

#[test]
fn configured_provider_language_overrides_turn_languages_without_dropping_keywords() {
    let context = SttDecoderContext {
        prompt: "Technical dictation".to_string(),
        keywords: vec!["Lotus".to_string()],
        languages: vec!["id".to_string(), "en".to_string()],
    };
    let effective = with_configured_language(Some(&context), Some("ja-JP")).unwrap();

    assert_eq!(effective.languages, vec!["ja-JP"]);
    assert_eq!(effective.keywords, vec!["Lotus"]);
    assert_eq!(context.languages, vec!["id", "en"]);
}

#[test]
fn multiple_turn_languages_do_not_collapse_to_one_for_single_language_providers() {
    let context = SttDecoderContext {
        prompt: String::new(),
        keywords: vec![],
        languages: vec!["id".to_string(), "en".to_string()],
    };
    assert_eq!(single_language_hint(Some(&context)), None);

    let explicit = with_configured_language(Some(&context), Some("ja-JP")).unwrap();
    assert_eq!(
        single_language_hint(Some(&explicit)).as_deref(),
        Some("ja-JP")
    );
}

#[test]
fn deepgram_batch_url_percent_encodes_configured_values() {
    let url = build_deepgram_url(
        "https://api.deepgram.com/v1".to_string(),
        Some("nova-2&tier=evil"),
        Some("id ID&channels=99"),
    );
    assert!(url.contains("model=nova-2%26tier%3Devil"), "{url}");
    assert!(url.contains("language=id%20ID%26channels%3D99"), "{url}");
    assert!(!url.contains("tier=evil"), "{url}");
    assert!(!url.contains("channels=99"), "{url}");
}

#[test]
fn parses_detected_languages_from_a_structured_openai_response() {
    let result = parse_openai_transcript(
        r#"{"text":"  Halo Lotus  ","languages":[{"code":"id"},{"code":"en"}]}"#,
    )
    .unwrap();
    assert_eq!(result.text, "Halo Lotus");
    assert_eq!(result.detected_languages, vec!["id", "en"]);
}

#[test]
fn parses_a_valid_transcription_response_and_rejects_provider_contract_drift() {
    assert_eq!(
        parse_openai_transcript(r#"{"text":"  buka terminal  "}"#)
            .unwrap()
            .text,
        "buka terminal"
    );
    assert!(parse_openai_transcript(r#"{"unexpected":"shape"}"#)
        .unwrap_err()
        .to_string()
        .contains("missing non-empty text"));
    assert!(parse_openai_transcript(r#"{"text":"   "}"#).is_err());
}

#[test]
fn redacts_a_present_api_key_but_keeps_empty() {
    assert_eq!(
        cfg("x", "openai", Some("sk-secret"))
            .redacted()
            .api_key
            .as_deref(),
        Some("***")
    );
    assert_eq!(
        cfg("x", "openai", Some("")).redacted().api_key.as_deref(),
        Some("")
    );
    assert_eq!(cfg("x", "openai", None).redacted().api_key, None);
}

#[test]
fn default_registry_defaults_to_browser_active_and_enabled() {
    let r = default_registry();
    assert_eq!(r.active_provider, "browser");
    assert!(r
        .providers
        .iter()
        .any(|p| p.id == "browser" && p.enabled && p.builtin));
    let openai = r.providers.iter().find(|p| p.id == "openai").unwrap();
    assert!(!openai.enabled && openai.api_key.is_none());
    assert_eq!(openai.model.as_deref(), Some("gpt-transcribe"));
}

#[test]
fn reconcile_adds_missing_builtins_without_dropping_saved() {
    let saved = SttProviderRegistry {
        active_provider: "openai".to_string(),
        providers: vec![cfg("openai", "openai", Some("sk-real"))],
    };
    let merged = reconcile(saved);
    assert!(merged.providers.iter().any(|p| p.id == "browser"));
    let openai = merged.providers.iter().find(|p| p.id == "openai").unwrap();
    assert_eq!(openai.api_key.as_deref(), Some("sk-real"));
}

#[test]
fn upsert_sentinel_preserves_existing_key_while_updating_other_fields() {
    let mut reg = SttProviderRegistry {
        active_provider: "browser".to_string(),
        providers: vec![cfg("openai", "openai", Some("sk-real"))],
    };
    let mut incoming = cfg("openai", "openai", Some("***"));
    incoming.enabled = false;
    if incoming.api_key.as_deref() == Some("***") {
        if let Some(existing) = reg.providers.iter().find(|p| p.id == incoming.id) {
            incoming.api_key = existing.api_key.clone();
        }
    }
    upsert_provider(&mut reg, incoming);
    let saved = reg.providers.iter().find(|p| p.id == "openai").unwrap();
    assert_eq!(saved.api_key.as_deref(), Some("sk-real"));
    assert!(!saved.enabled);
}

#[test]
fn delete_builtin_is_rejected_and_custom_falls_back_active() {
    let mut reg = default_registry();
    assert!(delete_provider(&mut reg, "openai").is_err());

    reg.providers.push(cfg("my-stt", "custom", Some("k")));
    reg.active_provider = "my-stt".to_string();
    delete_provider(&mut reg, "my-stt").unwrap();
    assert_eq!(reg.active_provider, "browser");
}

#[test]
fn transcribe_off_main_runs_on_another_thread_and_returns_its_result() {
    // Unknown provider fails before any IO or file write; the point is the error crosses the
    // blocking-pool boundary intact rather than being swallowed by the join.
    let err = tauri::async_runtime::block_on(cmd_transcribe_off_main(
        "no-such-provider-175".into(),
        String::new(),
        "audio/wav".into(),
        None,
    ))
    .unwrap_err();
    assert!(err.to_string().contains("no-such-provider-175"), "{err}");
}

#[test]
fn moves_only_the_old_builtin_openai_default_to_gpt_transcribe() {
    let with = |id: &str, builtin: bool, model: &str| SttProviderConfig {
        builtin,
        model: Some(model.to_string()),
        ..cfg(id, "openai", Some("k"))
    };
    let saved = SttProviderRegistry {
        active_provider: "openai".to_string(),
        providers: vec![
            with("openai", true, "gpt-4o-transcribe"),
            with("my-proxy", false, "gpt-4o-transcribe"),
        ],
    };
    let models: Vec<_> = reconcile(saved).providers.into_iter().map(|p| (p.id, p.model)).collect();
    assert!(models.contains(&("openai".to_string(), Some("gpt-transcribe".to_string()))));
    assert!(models.contains(&("my-proxy".to_string(), Some("gpt-4o-transcribe".to_string()))));

    let chosen = SttProviderRegistry {
        active_provider: "openai".to_string(),
        providers: vec![with("openai", true, "whisper-1")],
    };
    assert_eq!(reconcile(chosen).providers[0].model.as_deref(), Some("whisper-1"));
}
