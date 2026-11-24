//! Unified model registry — single source of truth for all AI providers and
//! models in Lotus. Stored at `~/.lotus/model-registry.json` (chmod 0600).
//!
//! Built-in providers (claude, codex) are always present in the default
//! registry and cannot be deleted — only disabled or reconfigured.
//! Custom providers (qwen, openai-compat, etc.) are fully managed by the user.
//!
//! API keys are not in the file: [`read`] and [`write`] keep them in the OS keychain (the store
//! the Slack tokens and the chat's Anthropic key use), one entry per provider. A key an older
//! build left in the file moves to the keychain the first time it is read.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use lotus_automation::secrets::SecretStore;
use serde::{Deserialize, Serialize};

use crate::error::{other, AppError};

// ─── Domain types ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
}

/// The on-disk + in-memory shape of a single AI provider.
///
/// `builtin = true` means the entry ships with Lotus defaults and cannot be
/// deleted (only disabled). Custom providers have `builtin = false`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub vendor: String,
    /// Dispatch tag: "claude-cli" | "codex-cli" | "qwen-cli" | "openai-compat"
    pub r#type: String,
    pub builtin: bool,
    pub enabled: bool,
    /// API base URL — required for qwen-cli and openai-compat, absent for
    /// built-in CLI providers that don't need external routing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// In memory only once [`read`]; the file never has it after a [`write`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub default_model: String,
    pub models: Vec<ModelEntry>,
}

impl ProviderConfig {
    /// Return a copy with `api_key` replaced by `"***"` for safe logging / IPC.
    pub fn redacted(&self) -> Self {
        Self {
            api_key: self.api_key.as_ref().map(|k| {
                if k.is_empty() {
                    k.clone()
                } else {
                    "***".to_string()
                }
            }),
            ..self.clone()
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRegistry {
    pub active_provider: String,
    pub active_model: String,
    pub providers: Vec<ProviderConfig>,
}

impl Default for ModelRegistry {
    fn default() -> Self {
        default_registry()
    }
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

pub fn default_registry() -> ModelRegistry {
    ModelRegistry {
        active_provider: "claude".to_string(),
        active_model: "claude-sonnet-5".to_string(),
        providers: vec![
            ProviderConfig {
                id: "claude".to_string(),
                name: "Claude".to_string(),
                vendor: "Anthropic".to_string(),
                r#type: "claude-cli".to_string(),
                builtin: true,
                enabled: true,
                base_url: None,
                api_key: None,
                // Mirrors `src/config/models/catalog.ts`, which asks to be kept in step here.
                default_model: "claude-sonnet-5".to_string(),
                models: vec![
                    ModelEntry {
                        id: "claude-opus-5".to_string(),
                        label: "Opus 5".to_string(),
                    },
                    ModelEntry {
                        id: "claude-sonnet-5".to_string(),
                        label: "Sonnet 5".to_string(),
                    },
                    ModelEntry {
                        id: "claude-haiku-4-5".to_string(),
                        label: "Haiku 4.5".to_string(),
                    },
                ],
            },
            ProviderConfig {
                id: "codex".to_string(),
                name: "Codex".to_string(),
                vendor: "OpenAI".to_string(),
                r#type: "codex-cli".to_string(),
                builtin: true,
                enabled: false,
                base_url: None,
                api_key: None,
                // From the CLI's own `~/.codex/models_cache.json` (codex 0.154.0), by its `priority`.
                default_model: "gpt-6-astra".to_string(),
                models: vec![
                    ModelEntry {
                        id: "gpt-6-astra".to_string(),
                        label: "GPT-6-Astra".to_string(),
                    },
                    ModelEntry {
                        id: "gpt-5.6-sol".to_string(),
                        label: "GPT-5.6-Sol".to_string(),
                    },
                    ModelEntry {
                        id: "gpt-5.6-terra".to_string(),
                        label: "GPT-5.6-Terra".to_string(),
                    },
                    ModelEntry {
                        id: "gpt-5.6-luna".to_string(),
                        label: "GPT-5.6-Luna".to_string(),
                    },
                    ModelEntry {
                        id: "gpt-5.5".to_string(),
                        label: "GPT-5.5".to_string(),
                    },
                ],
            },
        ],
    }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

/// Default file location: `~/.lotus/model-registry.json`.
pub fn default_registry_path() -> PathBuf {
    crate::paths::lotus_state_dir().join("model-registry.json")
}

/// Atomic write with 0600 perms — same pattern as `telegram_bot::config`.
fn atomic_write_secret(target: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(contents)?;
        file.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&tmp)?.permissions();
        perms.set_mode(0o600);
        fs::set_permissions(&tmp, perms)?;
    }
    fs::rename(tmp, target)?;
    Ok(())
}

fn is_deprecated_builtin_model(provider_id: &str, model_id: &str) -> bool {
    matches!((provider_id, model_id), ("codex", "o3" | "o4-mini"))
}

fn reconcile_builtin_providers(mut registry: ModelRegistry) -> ModelRegistry {
    let defaults = default_registry();
    for default_provider in defaults
        .providers
        .into_iter()
        .filter(|provider| provider.builtin)
    {
        if let Some(existing) = registry
            .providers
            .iter_mut()
            .find(|provider| provider.id == default_provider.id)
        {
            let enabled = existing.enabled;
            let base_url = existing.base_url.clone();
            let api_key = existing.api_key.clone();
            let mut models = default_provider.models.clone();
            for model in &existing.models {
                if is_deprecated_builtin_model(&existing.id, &model.id) {
                    continue;
                }
                if !models.iter().any(|candidate| candidate.id == model.id) {
                    models.push(model.clone());
                }
            }
            existing.name = default_provider.name;
            existing.vendor = default_provider.vendor;
            existing.r#type = default_provider.r#type;
            existing.builtin = true;
            existing.enabled = enabled;
            existing.base_url = base_url;
            existing.api_key = api_key;
            existing.default_model =
                if is_deprecated_builtin_model(&existing.id, &existing.default_model)
                    || existing.default_model.trim().is_empty()
                {
                    default_provider.default_model
                } else {
                    existing.default_model.clone()
                };
            existing.models = models;
        } else {
            registry.providers.push(default_provider);
        }
    }
    registry
}

/// Load registry from disk. Returns `default_registry()` on any failure
/// (missing file, parse error). Degrades gracefully.
pub fn load(path: &Path) -> ModelRegistry {
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return default_registry(),
    };
    serde_json::from_slice(&raw)
        .map(reconcile_builtin_providers)
        .unwrap_or_else(|_| default_registry())
}

/// Persist registry to disk (0600). Returns `io::Error` on failure.
pub fn save(path: &Path, registry: &ModelRegistry) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(registry)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write_secret(path, &body)
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/// Add or update a provider. If a provider with the same `id` already exists,
/// it is replaced entirely. Built-in providers can be updated (model list,
/// enabled flag, etc.) but never deleted.
pub fn upsert_provider(registry: &mut ModelRegistry, provider: ProviderConfig) {
    if let Some(pos) = registry.providers.iter().position(|p| p.id == provider.id) {
        registry.providers[pos] = provider;
    } else {
        registry.providers.push(provider);
    }
}

/// Remove a non-builtin provider by id. Returns an error if the provider is
/// built-in or not found.
pub fn delete_provider(registry: &mut ModelRegistry, id: &str) -> Result<(), AppError> {
    let pos = registry
        .providers
        .iter()
        .position(|p| p.id == id)
        .ok_or_else(|| other(format!("provider '{id}' not found")))?;

    if registry.providers[pos].builtin {
        return Err(other(format!(
            "provider '{id}' is built-in and cannot be deleted"
        )));
    }

    // If the active provider is being removed, fall back to the first enabled
    // built-in provider so the Bridge is never left pointing at nothing.
    if registry.active_provider == id {
        if let Some(fallback) = registry
            .providers
            .iter()
            .find(|p| p.builtin && p.enabled && p.id != id)
        {
            registry.active_provider = fallback.id.clone();
            registry.active_model = fallback.default_model.clone();
        }
    }

    registry.providers.remove(pos);
    Ok(())
}

/// Update the globally-active provider + model pair.
pub fn set_active_model(registry: &mut ModelRegistry, provider_id: &str, model_id: &str) {
    registry.active_provider = provider_id.to_string();
    registry.active_model = model_id.to_string();
}

// ─── Command implementations (called by Tauri commands in lib.rs) ─────────────

fn key_name(provider_id: &str) -> String {
    format!("model-registry.{provider_id}.api-key")
}

/// Fills each provider's key from `secrets`. A key still in the file moves there first, and the
/// file is rewritten without it.
pub fn with_keys(path: &Path, secrets: &dyn SecretStore) -> Result<ModelRegistry, String> {
    let mut registry = load(path);
    let mut moved = false;
    for provider in &mut registry.providers {
        match provider.api_key.take().filter(|k| !k.is_empty() && k != "***") {
            Some(key) => {
                secrets.set(&key_name(&provider.id), &key)?;
                moved = true;
                provider.api_key = Some(key);
            }
            None => provider.api_key = secrets.get(&key_name(&provider.id))?,
        }
    }
    if moved {
        save(path, &without_keys(&registry)).map_err(|e| e.to_string())?;
    }
    Ok(registry)
}

/// Saves `registry` with its keys in `secrets`: a provider without a key has none stored.
pub fn write_keys(path: &Path, registry: &ModelRegistry, secrets: &dyn SecretStore) -> Result<(), String> {
    for provider in &registry.providers {
        let name = key_name(&provider.id);
        match provider.api_key.as_deref().filter(|k| !k.is_empty()) {
            Some(key) if secrets.get(&name)?.as_deref() != Some(key) => secrets.set(&name, key)?,
            Some(_) => {}
            None => secrets.delete(&name)?,
        }
    }
    save(path, &without_keys(registry)).map_err(|e| e.to_string())
}

fn without_keys(registry: &ModelRegistry) -> ModelRegistry {
    let mut copy = registry.clone();
    for provider in &mut copy.providers {
        provider.api_key = None;
    }
    copy
}

/// The registry at its default path, with its keys. What every caller that needs a key reads.
pub fn read() -> ModelRegistry {
    let path = default_registry_path();
    with_keys(&path, crate::automation_slack::secret_store().as_ref()).unwrap_or_else(|error| {
        eprintln!("[model-registry] keys unavailable: {error}");
        load(&path)
    })
}

fn write(registry: &ModelRegistry) -> Result<(), String> {
    write_keys(&default_registry_path(), registry, crate::automation_slack::secret_store().as_ref())
}

pub fn cmd_list_providers() -> Vec<ProviderConfig> {
    let registry = read();
    registry
        .providers
        .into_iter()
        .map(|p| p.redacted())
        .collect()
}

pub fn cmd_get_provider(id: &str) -> Option<ProviderConfig> {
    let registry = read();
    registry
        .providers
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| p.redacted())
}

/// Upsert a provider from the settings UI. Preserves the real API key when
/// the incoming value carries the `"***"` redaction sentinel.
pub fn cmd_upsert_provider(provider: ProviderConfig) -> Result<(), String> {
    let mut registry = read();

    let mut incoming = provider;
    if incoming.api_key.as_deref() == Some("***") {
        if let Some(existing) = registry.providers.iter().find(|p| p.id == incoming.id) {
            incoming.api_key = existing.api_key.clone();
        } else {
            incoming.api_key = None;
        }
    }

    upsert_provider(&mut registry, incoming);
    write(&registry)
}

pub fn cmd_delete_provider(id: &str) -> Result<(), String> {
    let mut registry = read();
    delete_provider(&mut registry, id).map_err(|e| e.to_string())?;
    crate::automation_slack::secret_store().delete(&key_name(id))?;
    write(&registry)
}

pub fn cmd_get_active_model() -> serde_json::Value {
    let registry = load(&default_registry_path());
    serde_json::json!({
        "provider": registry.active_provider,
        "model": registry.active_model,
    })
}

pub fn cmd_set_active_model(provider: &str, model: &str) -> Result<(), String> {
    let mut registry = read();
    set_active_model(&mut registry, provider, model);
    write(&registry)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {

    #[test]
    fn default_registry_offers_only_models_that_still_exist() {
        let registry = default_registry();

        let claude = registry.providers.iter().find(|p| p.id == "claude").unwrap();
        let codex = registry.providers.iter().find(|p| p.id == "codex").unwrap();
        let ids: Vec<&str> = claude
            .models
            .iter()
            .chain(codex.models.iter())
            .map(|m| m.id.as_str())
            .collect();

        // Retired on 2026-09-10: the Claude 4.x ids, and the codex ids absent from the CLI's own
        // `models_cache.json`. Mirrors `src/config/models/catalog.ts`, as that file asks.
        for retired in [
            "claude-sonnet-4-6",
            "claude-opus-4-7",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.3-codex",
            "gpt-5.2",
            "gpt-5.1-codex-max",
        ] {
            assert!(!ids.contains(&retired), "{retired} should no longer be offered");
        }
        assert!(ids.contains(&"claude-opus-5"));
        assert!(ids.contains(&"gpt-6-astra"));
    }

    #[test]
    fn every_default_provider_defaults_to_a_model_it_lists() {
        // A default that is not in its own list is how a picker ends up blank.
        for provider in default_registry().providers {
            assert!(
                provider.models.iter().any(|m| m.id == provider.default_model),
                "{} defaults to {} which it does not list",
                provider.id,
                provider.default_model
            );
        }
    }

    #[test]
    fn the_active_model_is_one_the_active_provider_lists() {
        let registry = default_registry();
        let active = registry
            .providers
            .iter()
            .find(|p| p.id == registry.active_provider)
            .unwrap();

        assert!(active.models.iter().any(|m| m.id == registry.active_model));
    }
    use super::*;
    use lotus_automation::secrets::FileStore;
    use tempfile::tempdir;

    #[test]
    fn a_key_left_in_the_file_moves_to_the_secret_store() {
        let (dir, path) = tmp_path();
        let secrets = FileStore::new(dir.path().join("secrets.json"));
        let mut registry = default_registry();
        let mut deepseek = custom_provider("deepseek");
        deepseek.api_key = Some("sk-deep-1234".into());
        upsert_provider(&mut registry, deepseek);
        save(&path, &registry).unwrap();

        let read = with_keys(&path, &secrets).unwrap();

        let provider = read.providers.iter().find(|p| p.id == "deepseek").unwrap();
        assert_eq!(provider.api_key.as_deref(), Some("sk-deep-1234"));
        assert_eq!(secrets.get("model-registry.deepseek.api-key").unwrap().as_deref(), Some("sk-deep-1234"));
        assert!(!fs::read_to_string(&path).unwrap().contains("sk-deep-1234"));
    }

    #[test]
    fn writing_keeps_keys_out_of_the_file_and_clears_a_removed_one() {
        let (dir, path) = tmp_path();
        let secrets = FileStore::new(dir.path().join("secrets.json"));
        let mut registry = default_registry();
        let mut sumopod = custom_provider("sumopod");
        sumopod.api_key = Some("sk-sumo-9876".into());
        upsert_provider(&mut registry, sumopod.clone());
        write_keys(&path, &registry, &secrets).unwrap();

        assert!(!fs::read_to_string(&path).unwrap().contains("sk-sumo-9876"));
        let read = with_keys(&path, &secrets).unwrap();
        assert_eq!(read.providers.iter().find(|p| p.id == "sumopod").unwrap().api_key.as_deref(), Some("sk-sumo-9876"));

        sumopod.api_key = None;
        upsert_provider(&mut registry, sumopod);
        write_keys(&path, &registry, &secrets).unwrap();
        assert_eq!(secrets.get("model-registry.sumopod.api-key").unwrap(), None);
    }

    fn tmp_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let path = dir.path().join("model-registry.json");
        (dir, path)
    }

    fn custom_provider(id: &str) -> ProviderConfig {
        ProviderConfig {
            id: id.to_string(),
            name: "Qwen".to_string(),
            vendor: "Alibaba".to_string(),
            r#type: "qwen-cli".to_string(),
            builtin: false,
            enabled: true,
            base_url: Some("https://dashscope-intl.aliyuncs.com/compatible-mode/v1".to_string()),
            api_key: Some("sk-test".to_string()),
            default_model: "qwen3.6-plus".to_string(),
            models: vec![ModelEntry {
                id: "qwen3.6-plus".to_string(),
                label: "Qwen 3.6 Plus".to_string(),
            }],
        }
    }

    // ── load ──────────────────────────────────────────────────────────────────

    #[test]
    fn load_returns_default_when_file_missing() {
        let (_dir, path) = tmp_path();
        let registry = load(&path);
        assert_eq!(registry, default_registry());
    }

    #[test]
    fn load_returns_default_on_corrupt_json() {
        let (_dir, path) = tmp_path();
        fs::write(&path, b"{ not json }").unwrap();
        let registry = load(&path);
        assert_eq!(registry, default_registry());
    }

    #[test]
    fn load_reconciles_stale_builtin_codex_models() {
        let (_dir, path) = tmp_path();
        let mut registry = default_registry();
        let codex = registry
            .providers
            .iter_mut()
            .find(|p| p.id == "codex")
            .unwrap();
        codex.default_model = "o3".to_string();
        codex.models = vec![
            ModelEntry {
                id: "o3".to_string(),
                label: "o3".to_string(),
            },
            ModelEntry {
                id: "custom-codex".to_string(),
                label: "Custom Codex".to_string(),
            },
        ];
        save(&path, &registry).unwrap();

        let loaded = load(&path);
        let loaded_codex = loaded.providers.iter().find(|p| p.id == "codex").unwrap();
        assert_eq!(loaded_codex.default_model, "gpt-6-astra");
        assert!(loaded_codex
            .models
            .iter()
            .any(|model| model.id == "gpt-6-astra"));
        assert!(loaded_codex
            .models
            .iter()
            .any(|model| model.id == "custom-codex"));
        assert!(!loaded_codex.models.iter().any(|model| model.id == "o3"));
    }

    // ── save + load roundtrip ─────────────────────────────────────────────────

    #[test]
    fn save_then_load_roundtrips_all_fields() {
        let (_dir, path) = tmp_path();
        let mut reg = default_registry();
        upsert_provider(&mut reg, custom_provider("qwen-dashscope"));
        set_active_model(&mut reg, "qwen-dashscope", "qwen3.6-plus");

        save(&path, &reg).unwrap();
        let loaded = load(&path);

        assert_eq!(loaded.active_provider, "qwen-dashscope");
        assert_eq!(loaded.active_model, "qwen3.6-plus");
        assert!(loaded.providers.iter().any(|p| p.id == "qwen-dashscope"));
    }

    #[cfg(unix)]
    #[test]
    fn save_writes_with_0600_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let (_dir, path) = tmp_path();
        save(&path, &default_registry()).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    // ── default_registry ─────────────────────────────────────────────────────

    #[test]
    fn default_registry_has_claude_and_codex_builtin() {
        let reg = default_registry();
        let ids: Vec<&str> = reg.providers.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"claude"), "claude missing from defaults");
        assert!(ids.contains(&"codex"), "codex missing from defaults");
        let claude = reg.providers.iter().find(|p| p.id == "claude").unwrap();
        let codex = reg.providers.iter().find(|p| p.id == "codex").unwrap();
        assert!(claude.builtin && claude.enabled);
        assert!(codex.builtin && !codex.enabled);
        assert_eq!(codex.default_model, "gpt-6-astra");
        assert!(codex.models.iter().any(|model| model.id == "gpt-6-astra"));
        assert!(!codex.models.iter().any(|model| model.id == "o3"));
    }

    #[test]
    fn default_registry_active_points_at_claude_sonnet() {
        let reg = default_registry();
        assert_eq!(reg.active_provider, "claude");
        assert_eq!(reg.active_model, "claude-sonnet-5");
    }

    // ── upsert_provider ───────────────────────────────────────────────────────

    #[test]
    fn upsert_adds_new_custom_provider() {
        let mut reg = default_registry();
        let before = reg.providers.len();
        upsert_provider(&mut reg, custom_provider("qwen-dashscope"));
        assert_eq!(reg.providers.len(), before + 1);
        assert!(reg.providers.iter().any(|p| p.id == "qwen-dashscope"));
    }

    #[test]
    fn upsert_replaces_existing_provider_by_id() {
        let mut reg = default_registry();
        upsert_provider(&mut reg, custom_provider("qwen-dashscope"));
        let mut updated = custom_provider("qwen-dashscope");
        updated.default_model = "qvq-max".to_string();
        upsert_provider(&mut reg, updated);
        let provider = reg
            .providers
            .iter()
            .find(|p| p.id == "qwen-dashscope")
            .unwrap();
        assert_eq!(provider.default_model, "qvq-max");
        // No duplicate
        assert_eq!(
            reg.providers
                .iter()
                .filter(|p| p.id == "qwen-dashscope")
                .count(),
            1
        );
    }

    #[test]
    fn upsert_can_update_builtin_provider_models() {
        let mut reg = default_registry();
        let mut claude = reg
            .providers
            .iter()
            .find(|p| p.id == "claude")
            .unwrap()
            .clone();
        claude.models.push(ModelEntry {
            id: "claude-custom".to_string(),
            label: "Custom".to_string(),
        });
        upsert_provider(&mut reg, claude);
        let updated = reg.providers.iter().find(|p| p.id == "claude").unwrap();
        assert!(updated.models.iter().any(|m| m.id == "claude-custom"));
        assert!(updated.builtin, "builtin flag must be preserved");
    }

    // ── delete_provider ───────────────────────────────────────────────────────

    #[test]
    fn delete_removes_custom_provider() {
        let mut reg = default_registry();
        upsert_provider(&mut reg, custom_provider("qwen-dashscope"));
        delete_provider(&mut reg, "qwen-dashscope").unwrap();
        assert!(!reg.providers.iter().any(|p| p.id == "qwen-dashscope"));
    }

    #[test]
    fn delete_builtin_returns_error() {
        let mut reg = default_registry();
        let err = delete_provider(&mut reg, "claude").unwrap_err();
        assert!(
            err.to_string().contains("built-in"),
            "error must mention built-in"
        );
        // Provider still present
        assert!(reg.providers.iter().any(|p| p.id == "claude"));
    }

    #[test]
    fn delete_missing_provider_returns_error() {
        let mut reg = default_registry();
        let err = delete_provider(&mut reg, "nonexistent").unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn delete_active_provider_falls_back_to_claude() {
        let mut reg = default_registry();
        upsert_provider(&mut reg, custom_provider("qwen-dashscope"));
        set_active_model(&mut reg, "qwen-dashscope", "qwen3.6-plus");
        assert_eq!(reg.active_provider, "qwen-dashscope");

        delete_provider(&mut reg, "qwen-dashscope").unwrap();

        assert_eq!(reg.active_provider, "claude", "should fall back to claude");
    }

    // ── set_active_model ──────────────────────────────────────────────────────

    #[test]
    fn set_active_model_updates_both_fields() {
        let mut reg = default_registry();
        set_active_model(&mut reg, "codex", "gpt-4o-codex");
        assert_eq!(reg.active_provider, "codex");
        assert_eq!(reg.active_model, "gpt-4o-codex");
    }

    // ── redacted ──────────────────────────────────────────────────────────────

    #[test]
    fn redacted_masks_api_key() {
        let p = custom_provider("qwen");
        assert_eq!(p.api_key.as_deref(), Some("sk-test"));
        let r = p.redacted();
        assert_eq!(r.api_key.as_deref(), Some("***"));
        // other fields unchanged
        assert_eq!(r.id, p.id);
        assert_eq!(r.name, p.name);
    }

    #[test]
    fn redacted_keeps_none_as_none() {
        let mut p = custom_provider("qwen");
        p.api_key = None;
        assert_eq!(p.redacted().api_key, None);
    }

    #[test]
    fn redacted_keeps_empty_key_as_empty() {
        let mut p = custom_provider("qwen");
        p.api_key = Some(String::new());
        assert_eq!(p.redacted().api_key.as_deref(), Some(""));
    }
}
