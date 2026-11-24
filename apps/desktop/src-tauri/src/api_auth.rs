use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use axum::extract::FromRequestParts;
use axum::http::{request::Parts, StatusCode};
use rand::RngCore;

use crate::paths;

// ─── API Key ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ApiKey(pub String);

impl ApiKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Loads the API key from `~/.lotus/api-server.key` (canonical), falling back
/// to the legacy `~/.claude/api-server.key` for pre-Slice-6 installs. Creates
/// a new random 32-byte hex key (mode 0600) at the canonical path when both
/// locations are absent.
pub fn load_or_create_api_key() -> ApiKey {
    let canonical = paths::lotus_state_dir().join("api-server.key");
    let legacy = paths::claude_dir().join("api-server.key");

    if let Some(existing) = read_nonempty_key(&canonical) {
        return ApiKey(existing);
    }
    if let Some(existing) = read_nonempty_key(&legacy) {
        // Best-effort migrate: copy legacy → canonical so future starts skip
        // the fallback path. Failure to migrate is non-fatal — the key still
        // returns from the legacy location until the next restart.
        if let Some(parent) = canonical.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&canonical, &existing);
        #[cfg(unix)]
        if let Ok(meta) = fs::metadata(&canonical) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(&canonical, perms);
        }
        return ApiKey(existing);
    }

    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let key = hex::encode(bytes);

    if let Some(parent) = canonical.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&canonical, &key);

    // Restrict to owner-only read/write on Unix
    #[cfg(unix)]
    if let Ok(meta) = fs::metadata(&canonical) {
        let mut perms = meta.permissions();
        perms.set_mode(0o600);
        let _ = fs::set_permissions(&canonical, perms);
    }

    ApiKey(key)
}

fn read_nonempty_key(path: &std::path::Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

// ─── Bearer token validation ──────────────────────────────────────────────────

/// Validates a `Authorization: Bearer <token>` header against the expected key.
/// Uses constant-length comparison to mitigate trivial timing attacks.
pub fn validate_bearer(parts: &Parts, key: &ApiKey) -> bool {
    let Some(auth_header) = parts.headers.get("Authorization") else {
        return false;
    };
    let Ok(auth_str) = auth_header.to_str() else {
        return false;
    };
    let Some(token) = auth_str.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(token.as_bytes(), key.0.as_bytes())
}

/// Byte-by-byte comparison that always reads all bytes of the longer input,
/// preventing early-exit timing leaks.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

// ─── Axum extractor ───────────────────────────────────────────────────────────

/// Axum extractor that rejects requests missing a valid Bearer token.
/// Requires `ApiKey` to have been added via `axum::Extension(key)` layer on the router.
pub struct RequireAuth;

#[async_trait::async_trait]
impl<S> FromRequestParts<S> for RequireAuth
where
    S: Send + Sync,
{
    type Rejection = StatusCode;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        // Retrieve the key that was injected by the Extension layer in build_router.
        let axum::Extension(key) = axum::Extension::<ApiKey>::from_request_parts(parts, _state)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        if validate_bearer(parts, &key) {
            Ok(RequireAuth)
        } else {
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;

    fn make_parts_with_bearer(token: &str) -> Parts {
        let (mut parts, _) = Request::builder()
            .header("Authorization", format!("Bearer {token}"))
            .body(())
            .unwrap()
            .into_parts();
        // Inject the key as an extension so the extractor can find it
        parts.extensions.insert(ApiKey("correct_key".to_string()));
        parts
    }

    fn make_parts_without_auth() -> Parts {
        let (parts, _) = Request::builder().body(()).unwrap().into_parts();
        parts
    }

    #[test]
    fn constant_time_eq_returns_true_for_identical_bytes() {
        assert!(constant_time_eq(b"hello", b"hello"));
    }

    #[test]
    fn constant_time_eq_returns_false_for_different_bytes() {
        assert!(!constant_time_eq(b"hello", b"world"));
    }

    #[test]
    fn constant_time_eq_returns_false_for_different_lengths() {
        assert!(!constant_time_eq(b"short", b"longer_string"));
    }

    #[test]
    fn validate_bearer_accepts_correct_token() {
        let parts = make_parts_with_bearer("correct_key");
        let key = ApiKey("correct_key".to_string());
        assert!(validate_bearer(&parts, &key));
    }

    #[test]
    fn validate_bearer_rejects_wrong_token() {
        let parts = make_parts_with_bearer("wrong_key");
        let key = ApiKey("correct_key".to_string());
        assert!(!validate_bearer(&parts, &key));
    }

    #[test]
    fn validate_bearer_rejects_missing_header() {
        let parts = make_parts_without_auth();
        let key = ApiKey("correct_key".to_string());
        assert!(!validate_bearer(&parts, &key));
    }

    #[test]
    fn validate_bearer_rejects_malformed_header() {
        let (parts, _) = Request::builder()
            .header("Authorization", "Token notbearer")
            .body(())
            .unwrap()
            .into_parts();
        let key = ApiKey("notbearer".to_string());
        assert!(!validate_bearer(&parts, &key));
    }

    fn lotus_state_subdir() -> &'static str {
        if cfg!(debug_assertions) {
            ".lotus-dev"
        } else {
            ".lotus"
        }
    }

    #[test]
    fn load_or_create_api_key_creates_file_and_returns_hex_key() {
        let _g = crate::paths::TEST_ENV_LOCK.lock().expect("env lock");
        let tmp = tempfile::tempdir().expect("tempdir");
        let saved_home = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());

        let key = load_or_create_api_key();

        assert_eq!(key.0.len(), 64);
        assert!(key.0.chars().all(|c| c.is_ascii_hexdigit()));

        // File should exist at the canonical Lotus state path, NOT in ~/.claude/.
        let canonical = tmp.path().join(lotus_state_subdir()).join("api-server.key");
        assert!(canonical.exists(), "expected key at {canonical:?}");
        let legacy = tmp.path().join(".claude").join("api-server.key");
        assert!(
            !legacy.exists(),
            "fresh install should not write to ~/.claude/"
        );

        // Second call should return the same key
        let key2 = load_or_create_api_key();
        assert_eq!(key.0, key2.0);

        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn load_or_create_api_key_migrates_from_legacy_claude_dir() {
        let _g = crate::paths::TEST_ENV_LOCK.lock().expect("env lock");
        let tmp = tempfile::tempdir().expect("tempdir");
        let saved_home = std::env::var_os("HOME");
        std::env::set_var("HOME", tmp.path());

        // Plant a legacy key at ~/.claude/api-server.key
        let legacy_dir = tmp.path().join(".claude");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_key = "deadbeef".repeat(8); // 64 hex chars
        std::fs::write(legacy_dir.join("api-server.key"), &legacy_key).unwrap();

        let key = load_or_create_api_key();
        assert_eq!(key.0, legacy_key);

        // After migration, canonical path should also have the same key
        let canonical = tmp.path().join(lotus_state_subdir()).join("api-server.key");
        assert!(canonical.exists());
        assert_eq!(std::fs::read_to_string(&canonical).unwrap(), legacy_key);

        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
