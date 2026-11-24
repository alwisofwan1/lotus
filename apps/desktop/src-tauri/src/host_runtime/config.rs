//! Persistent configuration for the embedded host runtime.
//!
//! Storage shape: a single JSON file at `~/.lotus/host-runtime.json`, plaintext
//! + chmod 0600 (mirroring `mcp_config::atomic_write`) — same threat model as
//! the existing IPC discovery file.
//!
//! Renamed from `telegram-bot.json` on 2026-08-02 together with the module
//! (ADR-2). The Telegram-specific fields — bot token, allowed Telegram user ids,
//! Mini App URL — are gone. Device credentials are NOT configured here: per
//! ADR-5 they are issued and revoked by the host itself during pairing, so Rust
//! only needs to know whether to run the runtime and where it should listen.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// On-disk + in-memory shape of the host runtime config.
///
/// `Default` returns a disabled config so the app boots cleanly on a fresh
/// install — the operator opts in explicitly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostRuntimeConfig {
    /// Master switch. When false, the supervisor never spawns the runtime.
    pub enabled: bool,

    /// Optional override for the runtime's default agent provider (`claude` or
    /// `codex`). `None` keeps the host's built-in default.
    #[serde(default)]
    pub default_provider: Option<String>,

    /// Address the mobile façade should bind to, e.g. `127.0.0.1:8787` or a
    /// tailnet interface address (ADR-3). `None` means the host picks its
    /// localhost-only default.
    ///
    /// This is the one knob that decides whether the host is reachable from
    /// another device at all, which is why it is validated rather than trusted.
    #[serde(default)]
    pub bind_address: Option<String>,
}

impl Default for HostRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            default_provider: None,
            bind_address: None,
        }
    }
}

impl HostRuntimeConfig {
    /// Validate and return a list of human-readable problems. Used by the
    /// supervisor to refuse start with a clear error rather than spawn a
    /// child that will crash on startup.
    pub fn validate(&self) -> Vec<String> {
        let mut errs = Vec::new();
        if let Some(addr) = &self.bind_address {
            match split_host_port(addr) {
                None => errs.push(format!(
                    "Bind address `{addr}` is not `host:port` (e.g. `127.0.0.1:8787`)"
                )),
                Some((host, _)) => {
                    if let Err(reason) = super::interfaces::validate_bind_host(host) {
                        errs.push(reason);
                    }
                }
            }
        }
        errs
    }
}

/// Splits `host:port`, rejecting URLs and missing/non-numeric ports. The host
/// half is judged by `interfaces::validate_bind_host`, which owns the policy.
fn split_host_port(s: &str) -> Option<(&str, u16)> {
    let s = s.trim();
    if s.is_empty() || s.contains("://") || s.contains('/') {
        return None;
    }
    let (host, port) = s.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    port.parse::<u16>().ok().map(|p| (host, p))
}

/// Atomic write with 0600 perms (mirrors `mcp_config::atomic_write`).
pub fn atomic_write_secret(target: &Path, contents: &[u8]) -> io::Result<()> {
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

/// Read the config from disk. Returns `Default::default()` for any
/// failure (missing file, corrupt JSON, perm error). The supervisor
/// gates start on `enabled`, so a transient read error degrades to "bot
/// stays off" rather than "bot crashes the app".
pub fn load(path: &Path) -> HostRuntimeConfig {
    let raw = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return HostRuntimeConfig::default(),
    };
    serde_json::from_slice(&raw).unwrap_or_default()
}

/// Persist the config to disk. Uses `atomic_write_secret` (0600 on Unix).
pub fn save(path: &Path, cfg: &HostRuntimeConfig) -> io::Result<()> {
    let body = serde_json::to_vec_pretty(cfg)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    atomic_write_secret(path, &body)
}

/// Default file location: `~/.lotus/host-runtime.json`. Kept separate from the
/// path resolver so callers in tests can pass a tempdir directly.
pub fn default_config_path() -> PathBuf {
    crate::paths::lotus_state_dir().join("host-runtime.json")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // Tests for bot-token validation and redaction were removed on 2026-08-02
    // together with their subject (ADR-2): this config carries no secret any
    // more. What replaces them below covers the one field that did arrive —
    // `bind_address`, the knob that decides whether the host is reachable from
    // another device at all.

    #[test]
    fn load_returns_default_when_file_missing() {
        let dir = tempdir().unwrap();
        let cfg = load(&dir.path().join("does-not-exist.json"));
        assert_eq!(cfg, HostRuntimeConfig::default());
        assert!(!cfg.enabled, "a fresh install must not run the runtime");
    }

    #[test]
    fn save_then_load_roundtrips_all_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("host-runtime.json");
        let original = HostRuntimeConfig {
            enabled: true,
            default_provider: Some("codex".into()),
            bind_address: Some("100.64.0.2:8787".into()),
        };
        save(&path, &original).unwrap();
        assert_eq!(load(&path), original);
    }

    #[test]
    fn load_returns_default_for_corrupt_json() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("host-runtime.json");
        fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), HostRuntimeConfig::default());
    }

    #[test]
    fn load_returns_default_for_empty_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("host-runtime.json");
        fs::write(&path, b"").unwrap();
        assert_eq!(load(&path), HostRuntimeConfig::default());
    }

    /// An older `telegram-bot.json` deserialises to the default rather than
    /// failing: every Telegram field is now unknown, and none of the surviving
    /// fields are required. That is the desired degradation — the runtime simply
    /// stays disabled until the operator configures it again.
    #[test]
    fn legacy_telegram_config_degrades_to_disabled_default() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("host-runtime.json");
        fs::write(
            &path,
            br#"{"enabled":true,"token":"12345:secret","allowed_user_ids":[1],"mini_app_url":"https://x"}"#,
        )
        .unwrap();
        let cfg = load(&path);
        // `enabled` still parses; the Telegram fields are ignored.
        assert!(cfg.enabled);
        assert_eq!(cfg.bind_address, None);
        assert_eq!(cfg.default_provider, None);
    }

    /// Pins the wire shape for the frontend. There is no `rename_all` here, so the
    /// JSON stays snake_case while `HostRuntimeStatus` next door is tagged — a
    /// TypeScript type written from memory would guess `bindAddress` and read
    /// `undefined` forever without erroring.
    #[test]
    fn config_json_shape_is_pinned_for_the_frontend() {
        let json = serde_json::to_value(HostRuntimeConfig {
            enabled: true,
            default_provider: Some("claude".into()),
            bind_address: Some("100.64.0.2:8787".into()),
        })
        .unwrap();

        assert_eq!(json["enabled"], true);
        assert_eq!(json["default_provider"], "claude");
        assert_eq!(json["bind_address"], "100.64.0.2:8787");
        assert!(
            json.get("bindAddress").is_none(),
            "snake_case, not camelCase"
        );
    }

    /// `None` travels as an explicit null rather than an absent key, so a client
    /// that round-trips the object cannot accidentally drop the field.
    #[test]
    fn absent_bind_address_serializes_as_null() {
        let json = serde_json::to_value(HostRuntimeConfig::default()).unwrap();

        assert!(json["bind_address"].is_null(), "got {json}");
        assert_eq!(json["enabled"], false, "a fresh install is opt-in");
    }

    #[test]
    fn validate_passes_when_bind_address_is_absent() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            ..Default::default()
        };
        assert!(
            cfg.validate().is_empty(),
            "localhost default needs no config"
        );
    }

    #[test]
    fn validate_accepts_literal_addresses_in_either_family() {
        for addr in ["127.0.0.1:8787", "100.64.0.2:8787", "[::1]:8787"] {
            let cfg = HostRuntimeConfig {
                enabled: true,
                bind_address: Some(addr.into()),
                ..Default::default()
            };
            assert!(cfg.validate().is_empty(), "{addr} should be accepted");
        }
    }

    /// A bind address must be a literal: you bind to a local interface, and a
    /// name adds a resolution step that can silently change which interface that
    /// is. A Tailscale MagicDNS name is the right way to *reach* this host and the
    /// wrong way to *bind* it.
    #[test]
    fn validate_flags_a_hostname_even_a_tailnet_one() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            bind_address: Some("my-host.ts.net:8787".into()),
            ..Default::default()
        };
        assert!(!cfg.validate().is_empty());
    }

    /// The wildcard is the one mistake with unbounded consequences, so it is
    /// refused by name rather than merely failing to parse.
    #[test]
    fn validate_refuses_the_wildcard_with_an_explanation() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            bind_address: Some("0.0.0.0:8787".into()),
            ..Default::default()
        };
        let errs = cfg.validate();
        assert!(
            errs.iter().any(|e| e.contains("exposes this machine")),
            "{errs:?}"
        );
    }

    #[test]
    fn validate_flags_a_url_pasted_as_bind_address() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            bind_address: Some("http://127.0.0.1:8787".into()),
            ..Default::default()
        };
        let errs = cfg.validate();
        assert!(
            errs.iter().any(|e| e.contains("host:port")),
            "a pasted URL is the likeliest mistake and must be named as such: {errs:?}"
        );
    }

    #[test]
    fn validate_flags_missing_or_nonnumeric_port() {
        for addr in ["127.0.0.1", "127.0.0.1:", "127.0.0.1:http", ""] {
            let cfg = HostRuntimeConfig {
                enabled: true,
                bind_address: Some(addr.into()),
                ..Default::default()
            };
            assert!(!cfg.validate().is_empty(), "{addr:?} should be rejected");
        }
    }
}
