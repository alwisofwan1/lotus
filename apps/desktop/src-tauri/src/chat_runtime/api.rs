//! The "api" runner (#288, mockup page "06e API providers"): a text-only chat with any
//! OpenAI-compatible `/chat/completions` endpoint from the model registry — DeepSeek, Sumopod,
//! OpenRouter, a local Ollama. The bridge streams the answer; this side picks the provider, reads
//! its key (keychain, via [`model_registry::read`]) and rebuilds the conversation the API needs,
//! since the API keeps no session of its own.

use std::time::Duration;

use serde_json::{json, Value};

use super::store::{event_type, Envelope};
use crate::model_registry::{self, ProviderConfig};

/// Registry types that speak `/chat/completions`.
const API_TYPES: [&str; 2] = ["openai-compat", "ollama"];

fn is_api(provider: &ProviderConfig) -> bool {
    API_TYPES.contains(&provider.r#type.as_str()) && provider.base_url.as_deref().is_some_and(|u| !u.trim().is_empty())
}

/// An enabled API provider by id, with its key.
pub fn provider(id: &str) -> Result<ProviderConfig, String> {
    model_registry::read()
        .providers
        .into_iter()
        .find(|p| p.id == id && is_api(p))
        .filter(|p| p.enabled)
        .ok_or_else(|| format!("No API provider \"{id}\" in Settings › Chat › Accounts, or it is turned off"))
}

/// The picker's API tab: every enabled API provider's models, as the runner model list.
pub fn models() -> Value {
    let models: Vec<Value> = model_registry::read()
        .providers
        .iter()
        .filter(|p| p.enabled && is_api(p))
        .flat_map(|p| {
            p.models.iter().map(move |m| {
                json!({
                    "value": m.id,
                    "displayName": if m.label.trim().is_empty() { &m.id } else { &m.label },
                    "description": "",
                    "isDefault": m.id == p.default_model,
                    "provider": p.id,
                    "providerName": p.name,
                })
            })
        })
        .collect();
    json!({ "models": models })
}

/// The `api` param of `thread/start`. The key goes to the bridge only, never to the page.
pub fn session_params(provider: &ProviderConfig) -> Value {
    json!({
        "baseUrl": provider.base_url.as_deref().unwrap_or_default().trim_end_matches('/'),
        "apiKey": provider.api_key.as_deref().filter(|k| !k.is_empty()),
        "providerName": provider.name,
    })
}

/// The conversation so far, as chat-completions messages: each turn's input and steers as the
/// user's, its finished answers as the assistant's. Reasoning is left out, as the APIs ask.
pub fn history(envelopes: &[Envelope]) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    let mut push = |role: &str, text: &str| {
        if text.trim().is_empty() {
            return;
        }
        // Two answers in a row (a turn cut by a steer) read as one message.
        if let Some(last) = messages.last_mut().filter(|m| m["role"] == role) {
            let joined = format!("{}\n\n{text}", last["content"].as_str().unwrap_or_default());
            last["content"] = json!(joined);
        } else {
            messages.push(json!({ "role": role, "content": text }));
        }
    };
    for envelope in envelopes {
        let event = &envelope.event;
        match event_type(event) {
            "turn/started" => push("user", event.pointer("/input/text").and_then(Value::as_str).unwrap_or_default()),
            "item/completed" => {
                let item = &event["item"];
                // A sub-agent's reply went to its agent, not to the user.
                if item.get("parentId").is_some_and(|p| !p.is_null()) {
                    continue;
                }
                let text = item["text"].as_str().unwrap_or_default();
                match item["kind"].as_str() {
                    Some("agentMessage") => push("assistant", text),
                    Some("userMessage") => push("user", text),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    messages
}

/// The ids `GET {baseUrl}/models` lists, for Settings. `api_key` "***" means the provider's saved key.
pub async fn fetch_models(base_url: &str, api_key: Option<&str>, provider_id: Option<&str>) -> Result<Vec<String>, String> {
    let saved;
    let key = match api_key {
        Some("***") => {
            saved = provider_id.map(provider).transpose()?.and_then(|p| p.api_key);
            saved.as_deref()
        }
        other => other.filter(|k| !k.trim().is_empty()),
    };
    let url = format!("{}/models", base_url.trim().trim_end_matches('/'));
    let http = reqwest::Client::builder().timeout(Duration::from_secs(20)).build().map_err(|e| e.to_string())?;
    let mut request = http.get(&url);
    if let Some(key) = key {
        request = request.bearer_auth(key.trim());
    }
    let response = request.send().await.map_err(|e| format!("{url}: {e}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        let detail = body.pointer("/error/message").and_then(Value::as_str).unwrap_or_default();
        return Err(format!("{url} answered {status} {detail}").trim().to_string());
    }
    Ok(model_ids(&body))
}

/// `{data: [{id}]}` (OpenAI) or `{models: [{name}]}` (Ollama's own list), sorted.
fn model_ids(body: &Value) -> Vec<String> {
    let list = body["data"].as_array().or_else(|| body["models"].as_array());
    let mut ids: Vec<String> = list
        .into_iter()
        .flatten()
        .filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()).map(str::to_string))
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(seq: u64, event: Value) -> Envelope {
        Envelope { thread_id: "t".into(), seq, at: 0, event }
    }

    #[test]
    fn rebuilds_the_conversation_from_the_thread() {
        let answer = |id: &str, text: &str| {
            json!({ "type": "item/completed", "turnId": "a", "item": { "id": id, "kind": "agentMessage", "status": "completed", "text": text } })
        };
        let events = [
            env(1, json!({ "type": "turn/started", "turnId": "a", "input": { "text": "Why 5 retries?", "clientRequestId": "c" } })),
            env(2, json!({ "type": "item/completed", "turnId": "a", "item": { "id": "r", "kind": "reasoning", "status": "completed", "text": "hmm" } })),
            env(3, answer("m1", "Because")),
            // A sub-agent's report to its agent is not part of the conversation.
            env(4, json!({ "type": "item/completed", "turnId": "a", "item": { "id": "s", "kind": "agentMessage", "status": "completed", "text": "3 lines", "parentId": "toolu_1" } })),
            env(4, answer("m2", "of the cap.")),
            env(5, json!({ "type": "turn/started", "turnId": "b", "input": { "text": "And jitter?", "clientRequestId": "d" } })),
            env(6, answer("m3", "")),
        ];
        assert_eq!(
            history(&events),
            vec![
                json!({ "role": "user", "content": "Why 5 retries?" }),
                json!({ "role": "assistant", "content": "Because\n\nof the cap." }),
                json!({ "role": "user", "content": "And jitter?" }),
            ]
        );
    }

    #[test]
    fn reads_openai_and_ollama_model_lists() {
        let openai = json!({ "data": [{ "id": "deepseek-v4-pro" }, { "id": "deepseek-v4-flash" }] });
        assert_eq!(model_ids(&openai), ["deepseek-v4-flash", "deepseek-v4-pro"]);
        assert_eq!(model_ids(&json!({ "models": [{ "name": "qwen3:8b" }] })), ["qwen3:8b"]);
        assert!(model_ids(&json!({})).is_empty());
    }
}
