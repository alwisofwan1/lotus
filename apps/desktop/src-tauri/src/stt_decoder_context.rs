use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::{other, AppError};
use crate::stt_providers::SttTranscriptResult;

pub const MAX_DECODER_PROMPT_CHARS: usize = 1_200;
const MAX_DECODER_KEYWORDS: usize = 32;
const MAX_DECODER_KEYWORD_CHARS: usize = 64;
const MAX_DECODER_LANGUAGES: usize = 4;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SttDecoderContext {
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub languages: Vec<String>,
}

pub fn sanitize_decoder_prompt(prompt: &str) -> String {
    prompt
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_DECODER_PROMPT_CHARS)
        .collect()
}

fn sanitize_decoder_keywords(keywords: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    keywords
        .iter()
        .map(|keyword| {
            keyword
                .replace(['\r', '\n', '\t'], " ")
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(MAX_DECODER_KEYWORD_CHARS)
                .collect::<String>()
        })
        .filter(|keyword| !keyword.is_empty() && seen.insert(keyword.to_lowercase()))
        .take(MAX_DECODER_KEYWORDS)
        .collect()
}

pub fn sanitize_decoder_languages(languages: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    languages
        .iter()
        .map(|language| language.trim())
        .filter(|language| {
            let mut parts = language.split('-');
            let primary = parts.next().unwrap_or_default();
            let region = parts.next();
            parts.next().is_none()
                && (2..=3).contains(&primary.len())
                && primary.chars().all(|ch| ch.is_ascii_alphabetic())
                && region.map_or(true, |part| {
                    (part.len() == 2 && part.chars().all(|ch| ch.is_ascii_alphabetic()))
                        || (part.len() == 3 && part.chars().all(|ch| ch.is_ascii_digit()))
                })
        })
        .filter(|language| seen.insert(language.to_lowercase()))
        .take(MAX_DECODER_LANGUAGES)
        .map(str::to_string)
        .collect()
}

/// `gpt-transcribe` rejects regional tags (`id-ID` → HTTP 400 "Invalid request."), so send only the
/// primary subtag, lowercased and deduplicated (`id-ID`, `ID` → one `id`).
fn primary_language_codes(languages: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    languages
        .into_iter()
        .map(|language| {
            language
                .split('-')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase()
        })
        .filter(|language| seen.insert(language.clone()))
        .collect()
}

fn is_gpt_transcribe_model(model: &str) -> bool {
    model == "gpt-transcribe" || model.starts_with("gpt-transcribe-")
}

fn is_legacy_prompt_model(model: &str) -> bool {
    model == "whisper-1"
        || model.starts_with("gpt-4o-transcribe")
        || model.starts_with("gpt-4o-mini-transcribe")
}

pub fn build_openai_context_fields(
    model: &str,
    context: Option<&SttDecoderContext>,
    official_openai: bool,
) -> Vec<(String, String)> {
    let Some(context) = context else {
        return Vec::new();
    };
    let prompt = sanitize_decoder_prompt(&context.prompt);
    let keywords = sanitize_decoder_keywords(&context.keywords);
    let languages = sanitize_decoder_languages(&context.languages);
    let mut fields = Vec::new();
    if official_openai && is_gpt_transcribe_model(model) {
        if !prompt.is_empty() {
            fields.push(("prompt".to_string(), prompt));
        }
        fields.extend(
            keywords
                .into_iter()
                .map(|value| ("keywords[]".to_string(), value)),
        );
        fields.extend(
            primary_language_codes(languages)
                .into_iter()
                .map(|value| ("languages[]".to_string(), value)),
        );
    } else if official_openai && is_legacy_prompt_model(model) {
        // A single language is safe only when the user explicitly supplied one. Multiple hints mean
        // code-switching/auto-detect and must not be collapsed into the first language.
        if languages.len() == 1 {
            let primary = languages[0].split('-').next().unwrap_or(&languages[0]);
            fields.push(("language".to_string(), primary.to_ascii_lowercase()));
        }
        let vocabulary = if keywords.is_empty() {
            String::new()
        } else {
            format!("Vocabulary only: {}.", keywords.join(", "))
        };
        let combined = sanitize_decoder_prompt(&format!("{prompt} {vocabulary}"));
        if !combined.is_empty() {
            fields.push(("prompt".to_string(), combined));
        }
    } else if !prompt.is_empty() {
        fields.push(("prompt".to_string(), prompt));
    }
    fields
}

pub fn parse_openai_transcript(raw: &str) -> Result<SttTranscriptResult, AppError> {
    let json: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| other(format!("OpenAI transcription: invalid response: {e}")))?;
    let text = json
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| other("OpenAI transcription: response missing non-empty text"))?;
    let detected_languages = json
        .get("languages")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("code").and_then(serde_json::Value::as_str))
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .take(MAX_DECODER_LANGUAGES)
        .map(str::to_string)
        .collect();
    Ok(SttTranscriptResult {
        text: text.to_string(),
        detected_languages,
    })
}
