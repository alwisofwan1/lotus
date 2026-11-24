//! Per-node origin policy for the Canvas Browser Node (plan slice H2).
//!
//! A browser node the agent can drive is an untrusted-content surface. Scheme
//! safety is already enforced by `normalize_browser_preview_url` (http/https
//! only). This module adds an opt-in *origin* allowlist so a node can be pinned
//! to, say, `localhost` during dev — blocking both agent-issued navigations and
//! page-initiated redirects to other origins.
//!
//! Default is `Open` (any http/https), preserving today's behavior; tightening
//! is explicit per node. All matching is host/scheme/port exact by default, with
//! two deliberately-narrow conveniences (bare host = any-scheme, leading-dot =
//! subdomain suffix) that are unit-tested against the classic look-alike bypass
//! (`evilexample.com` must never match `.example.com`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CanvasBrowserPolicyMode {
    /// Any http/https origin is allowed (default; scheme still validated upstream).
    Open,
    /// Only origins matching an allowlist entry are allowed.
    Allowlist,
}

impl Default for CanvasBrowserPolicyMode {
    fn default() -> Self {
        Self::Open
    }
}

/// A single normalized allowlist matcher, parsed once from a user entry.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OriginMatcher {
    /// Exact origin, e.g. `https://example.com` or `http://localhost:3000`.
    Origin(String),
    /// Bare host (optionally with port), matching any http/https scheme.
    Host { host: String, port: Option<u16> },
    /// Leading-dot suffix: `.example.com` matches `example.com` and `*.example.com`.
    Suffix(String),
}

impl OriginMatcher {
    /// Parse a raw allowlist entry into a matcher. Returns `None` for blanks.
    fn parse(entry: &str) -> Option<Self> {
        let raw = entry.trim();
        if raw.is_empty() {
            return None;
        }
        let lower = raw.to_ascii_lowercase();

        if lower.starts_with('.') && lower.len() > 1 {
            return Some(OriginMatcher::Suffix(lower));
        }

        // Explicit scheme → exact origin match.
        if lower.starts_with("http://") || lower.starts_with("https://") {
            let url = Url::parse(&lower).ok()?;
            return Some(OriginMatcher::Origin(url.origin().ascii_serialization()));
        }

        // Bare `host` or `host:port` → any-scheme host match. Parse via a dummy
        // scheme so we get proper host/port splitting and IDNA/IPv6 handling.
        let url = Url::parse(&format!("http://{lower}")).ok()?;
        let host = url.host_str()?.to_ascii_lowercase();
        Some(OriginMatcher::Host {
            host,
            port: url.port(),
        })
    }

    fn matches(&self, url: &Url) -> bool {
        match self {
            OriginMatcher::Origin(origin) => &url.origin().ascii_serialization() == origin,
            OriginMatcher::Host { host, port } => {
                let Some(url_host) = url.host_str() else {
                    return false;
                };
                if !url_host.eq_ignore_ascii_case(host) {
                    return false;
                }
                // A port in the entry must match; no port in the entry matches any.
                match port {
                    Some(p) => url.port_or_known_default() == Some(*p),
                    None => true,
                }
            }
            OriginMatcher::Suffix(dotted) => {
                let Some(url_host) = url.host_str() else {
                    return false;
                };
                let url_host = url_host.to_ascii_lowercase();
                // `.example.com` matches `example.com` (bare) and any `*.example.com`.
                let bare = &dotted[1..];
                url_host == *bare || url_host.ends_with(dotted.as_str())
            }
        }
    }
}

/// A per-node policy: a mode plus the raw allowlist entries the user supplied
/// (kept verbatim for round-tripping to the UI; matched via parsed matchers).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasBrowserPolicy {
    pub mode: CanvasBrowserPolicyMode,
    #[serde(default)]
    pub origins: Vec<String>,
}

impl Default for CanvasBrowserPolicy {
    fn default() -> Self {
        Self {
            mode: CanvasBrowserPolicyMode::Open,
            origins: Vec::new(),
        }
    }
}

impl CanvasBrowserPolicy {
    pub fn open() -> Self {
        Self::default()
    }

    /// Whether a normalized (already scheme-validated) URL string is permitted.
    /// A URL that fails to parse is denied under `Allowlist` and permitted under
    /// `Open` — under Open the scheme check upstream is the only gate, and a
    /// value that reached here already passed `normalize_browser_preview_url`.
    pub fn allows(&self, url_str: &str) -> bool {
        match self.mode {
            CanvasBrowserPolicyMode::Open => true,
            CanvasBrowserPolicyMode::Allowlist => {
                let Ok(url) = Url::parse(url_str) else {
                    return false;
                };
                self.origins
                    .iter()
                    .filter_map(|entry| OriginMatcher::parse(entry))
                    .any(|matcher| matcher.matches(&url))
            }
        }
    }
}

/// In-memory per-terminal policy store. Absent terminal → `Open` (default).
#[derive(Debug, Default, Clone)]
pub struct CanvasBrowserPolicyStore(Arc<Mutex<HashMap<String, CanvasBrowserPolicy>>>);

impl CanvasBrowserPolicyStore {
    pub fn set(&self, terminal_id: &str, policy: CanvasBrowserPolicy) {
        self.0
            .lock()
            .expect("policy store lock")
            .insert(terminal_id.to_string(), policy);
    }

    /// The policy for a terminal, or the permissive default when none is set.
    pub fn get(&self, terminal_id: &str) -> CanvasBrowserPolicy {
        self.0
            .lock()
            .expect("policy store lock")
            .get(terminal_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn remove(&self, terminal_id: &str) {
        self.0
            .lock()
            .expect("policy store lock")
            .remove(terminal_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowlist(origins: &[&str]) -> CanvasBrowserPolicy {
        CanvasBrowserPolicy {
            mode: CanvasBrowserPolicyMode::Allowlist,
            origins: origins.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn open_mode_allows_any_https_and_http() {
        let p = CanvasBrowserPolicy::open();
        assert!(p.allows("https://example.com/"));
        assert!(p.allows("http://localhost:3000/app"));
        assert!(p.allows("https://anything.example.io/x?y=1"));
    }

    #[test]
    fn allowlist_exact_origin_matches_only_that_origin() {
        let p = allowlist(&["https://example.com"]);
        assert!(p.allows("https://example.com/path"));
        assert!(!p.allows("http://example.com/path")); // scheme differs
        assert!(!p.allows("https://evil.com/"));
        assert!(!p.allows("https://sub.example.com/")); // subdomain not included
    }

    #[test]
    fn allowlist_bare_host_matches_any_scheme_and_port() {
        let p = allowlist(&["example.com"]);
        assert!(p.allows("https://example.com/"));
        assert!(p.allows("http://example.com:8080/"));
        assert!(!p.allows("https://notexample.com/"));
        assert!(!p.allows("https://example.com.evil.com/"));
    }

    #[test]
    fn allowlist_host_with_port_requires_matching_port() {
        let p = allowlist(&["localhost:3000"]);
        assert!(p.allows("http://localhost:3000/dashboard"));
        assert!(!p.allows("http://localhost:5173/"));
        // Default ports are resolved: :443 for https is the known default.
        let https = allowlist(&["example.com:443"]);
        assert!(https.allows("https://example.com/"));
    }

    #[test]
    fn allowlist_subdomain_suffix_matches_apex_and_children_only() {
        let p = allowlist(&[".example.com"]);
        assert!(p.allows("https://example.com/"));
        assert!(p.allows("https://app.example.com/"));
        assert!(p.allows("https://a.b.example.com/"));
        // Classic look-alike bypass must NOT match.
        assert!(!p.allows("https://evilexample.com/"));
        assert!(!p.allows("https://example.com.evil.com/"));
        assert!(!p.allows("https://notexample.com/"));
    }

    #[test]
    fn allowlist_denies_unparseable_or_empty() {
        let p = allowlist(&["example.com"]);
        assert!(!p.allows("not a url"));
        let empty = allowlist(&[]);
        assert!(!empty.allows("https://example.com/"));
    }

    #[test]
    fn allowlist_ignores_blank_entries() {
        let p = allowlist(&["", "   ", "example.com"]);
        assert!(p.allows("https://example.com/"));
        assert!(!p.allows("https://other.com/"));
    }

    #[test]
    fn store_defaults_to_open_and_round_trips() {
        let store = CanvasBrowserPolicyStore::default();
        assert_eq!(store.get("term-1").mode, CanvasBrowserPolicyMode::Open);
        store.set("term-1", allowlist(&["localhost:3000"]));
        let got = store.get("term-1");
        assert_eq!(got.mode, CanvasBrowserPolicyMode::Allowlist);
        assert!(got.allows("http://localhost:3000/"));
        store.remove("term-1");
        assert_eq!(store.get("term-1").mode, CanvasBrowserPolicyMode::Open);
    }
}
