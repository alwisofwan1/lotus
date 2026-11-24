//! Local-file (`file://`) support for the Canvas Browser Node.
//!
//! macOS WKWebView cannot meaningfully load a raw `file://` URL (no directory
//! read grant; relative assets fail), and Tauri v2's `WebviewBuilder` does not
//! expose `loadFileURL:allowingReadAccessToURL:`. So instead of navigating the
//! child WebView to `file://`, we keep `file:///…` as the *display* URL and load
//! the file through the app's existing localhost HTTP server. This module holds
//! the pure mapping + confinement logic (plan slice 1); the axum route and token
//! store live in slice 2.
//!
//! Security: a browser node is an agent-drivable, untrusted-content surface, so a
//! requested file is confined to an `allowed_root` (canonicalized, symlinks and
//! `..` resolved) and rejected if it escapes that root or does not exist.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tauri::Url;

use crate::error::AppError;

/// Path prefix the localhost file-serving route is mounted under.
pub const LOCAL_FILE_SERVE_PREFIX: &str = "__local";

/// A `file://` URL resolved to something the browser node can use: a `display`
/// URL the address bar shows (`file:///…`) and a `serve` URL the WebView loads
/// (`http://127.0.0.1:<port>/__local/<token>/<relpath>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFileServe {
    pub display: String,
    pub serve: Url,
}

/// Whether `value` is a `file://` URL.
pub fn is_file_url(value: &str) -> bool {
    value.trim_start().to_ascii_lowercase().starts_with("file:")
}

/// Resolve a `file://` URL to a confined [`LocalFileServe`].
///
/// Errors if `value` is not a file URL, the target does not exist, or the
/// canonicalized target escapes `allowed_root`.
pub fn map_local_file_url(
    value: &str,
    allowed_root: &Path,
    token: &str,
    port: u16,
) -> Result<LocalFileServe, AppError> {
    let url = Url::parse(value.trim())
        .map_err(|err| AppError::Other(format!("Invalid file URL: {err}")))?;
    if url.scheme() != "file" {
        return Err(AppError::Other(format!("Not a file URL: {}", url.scheme())));
    }
    let requested = url
        .to_file_path()
        .map_err(|_| AppError::Other("file URL has no filesystem path".into()))?;

    let canonical_root = allowed_root
        .canonicalize()
        .map_err(|err| AppError::Other(format!("Local file root is unavailable: {err}")))?;
    let canonical_file = requested
        .canonicalize()
        .map_err(|err| AppError::Other(format!("Local file not found: {err}")))?;

    let relative = canonical_file
        .strip_prefix(&canonical_root)
        .map_err(|_| AppError::Other("Local file is outside the allowed folder.".into()))?;

    let display = Url::from_file_path(&canonical_file)
        .map_err(|_| AppError::Other("Local file path is not absolute.".into()))?
        .to_string();

    let serve = build_local_serve_url(port, token, relative)?;

    Ok(LocalFileServe { display, serve })
}

/// Build the localhost URL the WebView loads for a confined local file.
fn build_local_serve_url(port: u16, token: &str, relative: &Path) -> Result<Url, AppError> {
    let mut url = Url::parse(&format!("http://127.0.0.1:{port}"))
        .map_err(|err| AppError::Other(format!("Invalid local serve base: {err}")))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| AppError::Other("Local serve URL cannot have a path.".into()))?;
        segments.push(LOCAL_FILE_SERVE_PREFIX);
        segments.push(token);
        for component in relative.components() {
            if let std::path::Component::Normal(part) = component {
                segments.push(&part.to_string_lossy());
            }
        }
    }
    Ok(url)
}

/// The effective navigation for a browser-node URL: remote URLs are loaded as-is;
/// `file://` URLs are loaded through the localhost serve route while the address
/// bar keeps showing the original `file://` path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedBrowserNavigation {
    Remote { url: Url },
    LocalFile { display: String, serve: Url },
}

/// Decide how a browser-node URL should be navigated. `file://` URLs require an
/// `allowed_root` (confinement boundary) and are mapped to a localhost serve URL;
/// everything else flows through the existing http/https normalization.
pub fn resolve_browser_navigation(
    url_str: &str,
    allowed_root: Option<&Path>,
    token: &str,
    port: u16,
) -> Result<ResolvedBrowserNavigation, AppError> {
    if is_file_url(url_str) {
        let root = allowed_root
            .ok_or_else(|| AppError::Other("Local files require an allowed folder.".into()))?;
        let served = map_local_file_url(url_str, root, token, port)?;
        return Ok(ResolvedBrowserNavigation::LocalFile {
            display: served.display,
            serve: served.serve,
        });
    }
    let url = crate::browser_preview::normalize_browser_preview_url(url_str)?;
    Ok(ResolvedBrowserNavigation::Remote { url })
}

/// Maps an opaque serve token to the canonical root it is allowed to read from.
///
/// A token is minted per browser-node file navigation; the localhost route trusts
/// only the root bound to the token, and re-confines every requested path under it.
/// Also carries the HTTP API port so callers can mint absolute serve URLs the
/// child WebView can load.
#[derive(Debug, Default, Clone)]
pub struct LocalFileServeStore {
    port: u16,
    tokens: Arc<Mutex<HashMap<String, PathBuf>>>,
}

impl LocalFileServeStore {
    /// Construct a store bound to the live HTTP API port.
    pub fn with_port(port: u16) -> Self {
        Self {
            port,
            tokens: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// The HTTP API port serve URLs are minted against.
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn register(&self, token: &str, allowed_root: PathBuf) {
        self.tokens
            .lock()
            .expect("local file serve store lock")
            .insert(token.to_string(), allowed_root);
    }

    pub fn root_for(&self, token: &str) -> Option<PathBuf> {
        self.tokens
            .lock()
            .expect("local file serve store lock")
            .get(token)
            .cloned()
    }

    pub fn remove(&self, token: &str) {
        self.tokens
            .lock()
            .expect("local file serve store lock")
            .remove(token);
    }
}

/// Re-confine a request-supplied relative path (the tail of a `/__local/<token>/…`
/// URL) under `allowed_root`. Defense in depth: even though the token is trusted,
/// the path tail comes off the network, so `..`/symlink escapes are rejected the
/// same way as the initial mapping.
pub fn resolve_served_path(allowed_root: &Path, relative: &str) -> Result<PathBuf, AppError> {
    let canonical_root = allowed_root
        .canonicalize()
        .map_err(|err| AppError::Other(format!("Local file root is unavailable: {err}")))?;
    let joined = canonical_root.join(relative);
    let canonical_file = joined
        .canonicalize()
        .map_err(|err| AppError::Other(format!("Local file not found: {err}")))?;
    if !canonical_file.starts_with(&canonical_root) {
        return Err(AppError::Other(
            "Local file is outside the allowed folder.".into(),
        ));
    }
    Ok(canonical_file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn maps_file_inside_root_to_localhost_serve_url() {
        let root = tempdir().expect("tempdir");
        let file = root.path().join("index.html");
        fs::write(&file, b"<h1>hi</h1>").expect("write");
        let file_url = Url::from_file_path(&file).expect("file url").to_string();

        let got = map_local_file_url(&file_url, root.path(), "tok123", 9877).expect("mapped");

        assert!(
            got.display.starts_with("file://"),
            "display keeps file scheme: {}",
            got.display
        );
        assert_eq!(got.serve.scheme(), "http");
        assert_eq!(got.serve.host_str(), Some("127.0.0.1"));
        assert_eq!(got.serve.port(), Some(9877));
        assert_eq!(got.serve.path(), "/__local/tok123/index.html");
    }

    #[test]
    fn rejects_file_outside_allowed_root() {
        let base = tempdir().expect("tempdir");
        let root = base.path().join("project");
        fs::create_dir(&root).expect("mkdir");
        let outside = base.path().join("secret.txt");
        fs::write(&outside, b"nope").expect("write");
        let file_url = Url::from_file_path(&outside).expect("file url").to_string();

        let err = map_local_file_url(&file_url, &root, "tok", 9877).expect_err("must reject");

        assert!(
            err.to_string().to_lowercase().contains("outside"),
            "error names the confinement violation: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_that_escapes_root() {
        let base = tempdir().expect("tempdir");
        let root = base.path().join("project");
        fs::create_dir(&root).expect("mkdir");
        let outside = base.path().join("secret.txt");
        fs::write(&outside, b"nope").expect("write");
        // A symlink that lives inside the root but resolves to a file outside it.
        let link = root.join("escape.txt");
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");
        let file_url = Url::from_file_path(&link).expect("file url").to_string();

        let err = map_local_file_url(&file_url, &root, "tok", 9877)
            .expect_err("symlink escape must be rejected");

        assert!(
            err.to_string().to_lowercase().contains("outside"),
            "symlink escape is treated as a confinement violation: {err}"
        );
    }

    #[test]
    fn rejects_non_file_url() {
        let root = tempdir().expect("tempdir");
        let err = map_local_file_url("https://example.com", root.path(), "tok", 9877)
            .expect_err("http is not a file url");
        assert!(err.to_string().to_lowercase().contains("not a file url"));
    }

    #[test]
    fn rejects_missing_file() {
        let root = tempdir().expect("tempdir");
        let missing = root.path().join("nope.html");
        let file_url = Url::from_file_path(&missing).expect("file url").to_string();
        let err = map_local_file_url(&file_url, root.path(), "tok", 9877)
            .expect_err("missing file must be rejected");
        assert!(err.to_string().to_lowercase().contains("not found"));
    }

    #[test]
    fn encodes_nested_relative_path_for_asset_resolution() {
        let root = tempdir().expect("tempdir");
        let sub = root.path().join("docs").join("guide");
        fs::create_dir_all(&sub).expect("mkdirs");
        let file = sub.join("page one.html");
        fs::write(&file, b"x").expect("write");
        let file_url = Url::from_file_path(&file).expect("file url").to_string();

        let got = map_local_file_url(&file_url, root.path(), "tok", 9877).expect("mapped");

        // Nested path is preserved under the token so a sibling `./style.css`
        // resolves within the same served root; the space is percent-encoded.
        assert_eq!(got.serve.path(), "/__local/tok/docs/guide/page%20one.html");
    }

    #[test]
    fn is_file_url_detects_scheme() {
        assert!(is_file_url("file:///Users/a/index.html"));
        assert!(is_file_url("  FILE:///x"));
        assert!(!is_file_url("https://example.com"));
        assert!(!is_file_url("localhost:3000"));
    }

    #[test]
    fn store_round_trips_token_to_root() {
        let store = LocalFileServeStore::default();
        assert_eq!(store.root_for("missing"), None);
        store.register("tok", PathBuf::from("/tmp/project"));
        assert_eq!(store.root_for("tok"), Some(PathBuf::from("/tmp/project")));
        store.remove("tok");
        assert_eq!(store.root_for("tok"), None);
    }

    #[test]
    fn resolve_served_path_accepts_nested_file() {
        let root = tempdir().expect("tempdir");
        let sub = root.path().join("assets");
        fs::create_dir(&sub).expect("mkdir");
        let file = sub.join("app.css");
        fs::write(&file, b"body{}").expect("write");

        let got = resolve_served_path(root.path(), "assets/app.css").expect("resolved");
        assert_eq!(got, file.canonicalize().expect("canon"));
    }

    #[test]
    fn resolve_navigation_passes_remote_url_through() {
        let got = resolve_browser_navigation("example.com", None, "tok", 9877).expect("remote");
        match got {
            ResolvedBrowserNavigation::Remote { url } => {
                assert_eq!(url.as_str(), "https://example.com/");
            }
            other => panic!("expected remote, got {other:?}"),
        }
    }

    #[test]
    fn resolve_navigation_maps_file_url_with_root() {
        let root = tempdir().expect("tempdir");
        let file = root.path().join("index.html");
        fs::write(&file, b"x").expect("write");
        let file_url = Url::from_file_path(&file).expect("file url").to_string();

        let got =
            resolve_browser_navigation(&file_url, Some(root.path()), "tok", 9877).expect("local");
        match got {
            ResolvedBrowserNavigation::LocalFile { display, serve } => {
                assert!(display.starts_with("file://"));
                assert_eq!(serve.host_str(), Some("127.0.0.1"));
                assert_eq!(serve.path(), "/__local/tok/index.html");
            }
            other => panic!("expected local file, got {other:?}"),
        }
    }

    #[test]
    fn resolve_navigation_rejects_file_url_without_root() {
        let err = resolve_browser_navigation("file:///etc/hosts", None, "tok", 9877)
            .expect_err("file url needs a root");
        assert!(err.to_string().to_lowercase().contains("allowed folder"));
    }

    #[test]
    fn resolve_navigation_still_rejects_dangerous_scheme() {
        let err = resolve_browser_navigation("javascript:alert(1)", None, "tok", 9877)
            .expect_err("javascript stays rejected");
        assert!(err.to_string().to_lowercase().contains("unsupported"));
    }

    #[test]
    fn resolve_served_path_rejects_dotdot_traversal() {
        let base = tempdir().expect("tempdir");
        let root = base.path().join("project");
        fs::create_dir(&root).expect("mkdir");
        fs::write(base.path().join("secret.txt"), b"nope").expect("write");

        let err = resolve_served_path(&root, "../secret.txt").expect_err("must reject");
        assert!(
            err.to_string().to_lowercase().contains("outside")
                || err.to_string().to_lowercase().contains("not found"),
            "traversal is blocked: {err}"
        );
    }
}
