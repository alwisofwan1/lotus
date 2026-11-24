//! Client for the host runtime's loopback admin channel.
//!
//! The channel exists because pairing codes are minted by an in-process method
//! on the host's `MobileAdapter`, and Rust deliberately holds no device
//! credentials (ADR-5). Rather than move credential handling into Rust, the
//! desktop asks the host over a listener that only loopback can reach.
//!
//! Rust owns the secret and generates a fresh one per start; the child owns the
//! port, because a port picked before spawn can be taken by someone else before
//! the child manages to bind it. So the secret travels down through env and the
//! port travels back up through a discovery file, mirroring `mcp_config.rs`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rand::RngCore;
use serde::{Deserialize, Serialize};

use super::stale::{ProcessOps, RealProcessOps};

/// Admin calls are local and answer immediately; a long timeout would only turn
/// a wedged host into a frozen settings pane.
const TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum AdminError {
    #[error("host runtime has not advertised an admin channel yet")]
    NotAdvertised,
    #[error("admin discovery file at {path} is unreadable: {source}")]
    Unreadable {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("admin discovery file at {path} is not valid JSON: {source}")]
    Malformed {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("admin channel rejected the request with status {0}")]
    Status(u16),
    #[error("admin channel is unreachable: {0}")]
    Transport(String),
}

/// What the child writes once it knows the port the OS gave it.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AdminAdvert {
    pub port: u16,
    pub pid: u32,
    #[serde(default = "loopback")]
    pub host: String,
}

fn loopback() -> String {
    "127.0.0.1".to_string()
}

/// A 32-byte secret as hex. Regenerated per host start, never persisted.
pub fn generate_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Default discovery path, alongside the device store the child also writes.
pub fn default_advert_path() -> PathBuf {
    crate::paths::lotus_state_dir().join("mobile-admin.json")
}

pub fn read_advert(path: &Path) -> Result<AdminAdvert, AdminError> {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(AdminError::NotAdvertised)
        }
        Err(source) => {
            return Err(AdminError::Unreadable {
                path: path.to_path_buf(),
                source,
            })
        }
    };
    serde_json::from_slice(&raw).map_err(|source| AdminError::Malformed {
        path: path.to_path_buf(),
        source,
    })
}

/// Bound to one host start: the secret it was built with must match the one that
/// start passed to the child, so a stale client cannot talk to a new host.
pub struct AdminClient {
    secret: String,
    advert_path: PathBuf,
}

impl AdminClient {
    pub fn new(secret: String, advert_path: PathBuf) -> Self {
        Self {
            secret,
            advert_path,
        }
    }

    pub fn create_pairing_code(&self) -> Result<serde_json::Value, AdminError> {
        self.call("POST", "/admin/pairing-code")
    }

    pub fn list_devices(&self) -> Result<serde_json::Value, AdminError> {
        self.call("GET", "/admin/devices")
    }

    pub fn revoke_device(&self, device_id: &str) -> Result<serde_json::Value, AdminError> {
        // Percent-encoding is deliberate rather than paranoid: device ids come
        // from the child, but a `/` or `?` in one would silently change the route.
        self.call(
            "DELETE",
            &format!("/admin/devices/{}", encode_segment(device_id)),
        )
    }

    pub fn health(&self) -> Result<serde_json::Value, AdminError> {
        self.call("GET", "/admin/health")
    }

    fn call(&self, method: &str, path: &str) -> Result<serde_json::Value, AdminError> {
        let advert = read_advert(&self.advert_path)?;
        // The child cannot delete its advert when it is SIGKILLed — by `stop()`, or by
        // the kernel at exec — so the file outlives it. Calling the dead port then
        // fails as a transport error, which the settings UI rendered as an unexplained
        // fault instead of "not running" (2026-10-04, an advert three weeks stale).
        // Not deleted here: a new child may be rewriting it right now.
        if !RealProcessOps.is_alive(advert.pid) {
            return Err(AdminError::NotAdvertised);
        }
        let url = format!("http://{}:{}{}", advert.host, advert.port, path);
        let response = ureq::request(method, &url)
            .timeout(TIMEOUT)
            .set("Authorization", &format!("Bearer {}", self.secret))
            .call();

        match response {
            // `into_string` rather than `into_json`: the latter needs ureq's json
            // feature, which this crate does not enable, and parsing here keeps
            // the dependency surface unchanged.
            Ok(res) => {
                let body = res
                    .into_string()
                    .map_err(|err| AdminError::Transport(err.to_string()))?;
                serde_json::from_str(&body)
                    .map_err(|err| AdminError::Transport(format!("bad JSON from admin: {err}")))
            }
            Err(ureq::Error::Status(code, _)) => Err(AdminError::Status(code)),
            Err(err) => Err(AdminError::Transport(err.to_string())),
        }
    }
}

/// Escapes everything that is not unreserved, so an id can never alter the path.
fn encode_segment(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_secret_is_64_hex_chars() {
        let secret = generate_secret();
        assert_eq!(secret.len(), 64, "32 bytes as hex");
        assert!(secret.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// A predictable secret would make the loopback channel guessable, and the
    /// failure would be invisible: everything still works, for everyone.
    #[test]
    fn generate_secret_differs_between_calls() {
        let a = generate_secret();
        let b = generate_secret();
        assert_ne!(a, b);
    }

    #[test]
    fn read_advert_parses_what_the_child_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobile-admin.json");
        std::fs::write(&path, br#"{"port":54321,"pid":42,"host":"127.0.0.1"}"#).unwrap();

        let advert = read_advert(&path).expect("parse");

        assert_eq!(
            advert,
            AdminAdvert {
                port: 54321,
                pid: 42,
                host: "127.0.0.1".into()
            }
        );
    }

    /// An older child may omit `host`; defaulting keeps a version skew from
    /// looking like corruption.
    #[test]
    fn read_advert_defaults_host_to_loopback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobile-admin.json");
        std::fs::write(&path, br#"{"port":1,"pid":2}"#).unwrap();

        assert_eq!(read_advert(&path).unwrap().host, "127.0.0.1");
    }

    /// "Not started yet" is the normal state at app launch, so it must be its own
    /// variant rather than an IO error the UI would render as a fault.
    #[test]
    fn missing_advert_is_not_advertised_not_an_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_advert(&dir.path().join("absent.json")).unwrap_err();
        assert!(matches!(err, AdminError::NotAdvertised), "got {err:?}");
    }

    #[test]
    fn malformed_advert_names_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobile-admin.json");
        std::fs::write(&path, b"not json").unwrap();

        let err = read_advert(&path).unwrap_err();

        assert!(matches!(err, AdminError::Malformed { .. }), "got {err:?}");
        assert!(
            err.to_string().contains("mobile-admin.json"),
            "the message must say which file: {err}"
        );
    }

    #[test]
    fn encode_segment_neutralises_path_and_query_characters() {
        assert_eq!(encode_segment("dev-1"), "dev-1");
        assert_eq!(encode_segment("a/b"), "a%2Fb");
        assert_eq!(encode_segment("a?b=c"), "a%3Fb%3Dc");
        assert_eq!(encode_segment("../../etc"), "..%2F..%2Fetc");
    }

    /// An advert left by a SIGKILLed child names a dead pid and a closed port. That is
    /// "not running", not a transport fault the UI cannot explain.
    #[test]
    fn an_advert_naming_a_dead_process_reads_as_not_advertised() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mobile-admin.json");
        let mut gone = std::process::Command::new("true").spawn().unwrap();
        let pid = gone.id();
        gone.wait().unwrap();
        std::fs::write(&path, format!(r#"{{"port":1,"pid":{pid}}}"#)).unwrap();
        let client = AdminClient::new(generate_secret(), path);

        assert!(matches!(
            client.create_pairing_code().unwrap_err(),
            AdminError::NotAdvertised
        ));
    }

    #[test]
    fn calls_fail_cleanly_when_nothing_is_advertised() {
        let dir = tempfile::tempdir().unwrap();
        let client = AdminClient::new(generate_secret(), dir.path().join("absent.json"));

        assert!(matches!(
            client.create_pairing_code().unwrap_err(),
            AdminError::NotAdvertised
        ));
    }
}
