use crate::{mcp_config, paths};

#[cfg(unix)]
extern crate libc;

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct BridgeMcpHealthItem {
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeMcpDiscoveryStatus {
    Missing,
    StalePid,
    StalePort,
    Responsive,
    OtherProfileLive,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BridgeMcpDiscoveryHealthInput {
    pub discovery_present: bool,
    pub pid_alive: Option<bool>,
    pub server_responsive: bool,
    pub other_profile: bool,
}

pub fn classify_bridge_mcp_discovery(
    input: BridgeMcpDiscoveryHealthInput,
) -> BridgeMcpDiscoveryStatus {
    if !input.discovery_present {
        return BridgeMcpDiscoveryStatus::Missing;
    }
    if matches!(input.pid_alive, Some(false)) {
        return BridgeMcpDiscoveryStatus::StalePid;
    }
    if input.other_profile && matches!(input.pid_alive, Some(true)) {
        return BridgeMcpDiscoveryStatus::OtherProfileLive;
    }
    if input.server_responsive {
        return BridgeMcpDiscoveryStatus::Responsive;
    }
    BridgeMcpDiscoveryStatus::StalePort
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
pub struct BridgeMcpHealth {
    pub status: &'static str,
    pub reason: Option<String>,
    pub port: Option<u16>,
    pub profile_key: String,
    pub discovery_present: bool,
    pub mcp_entry_present: bool,
    pub codex_mcp_entry_present: bool,
    pub server_responsive: bool,
    pub discovery_status: BridgeMcpDiscoveryStatus,
    pub other_profile_live: bool,
    pub other_profile_status: BridgeMcpDiscoveryStatus,
    pub local_orchestration: BridgeMcpHealthItem,
    pub discovery_file: BridgeMcpHealthItem,
    pub claude_mcp: BridgeMcpHealthItem,
    pub codex_mcp: BridgeMcpHealthItem,
    pub other_profile: BridgeMcpHealthItem,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeMcpHealthInput {
    pub port: Option<u16>,
    pub profile_key: String,
    pub discovery_present: bool,
    pub discovery_pid_alive: Option<bool>,
    pub claude_mcp_present: bool,
    pub codex_mcp_present: bool,
    pub server_responsive: bool,
    pub other_profile_live: bool,
    pub other_profile_key: Option<String>,
    pub other_profile_status: BridgeMcpDiscoveryStatus,
}

pub fn build_bridge_mcp_health(input: BridgeMcpHealthInput) -> BridgeMcpHealth {
    let local_orchestration = BridgeMcpHealthItem {
        ok: true,
        detail: "Local Bridge commands are available.".to_string(),
    };
    let discovery_file = BridgeMcpHealthItem {
        ok: input.discovery_present,
        detail: if input.discovery_present {
            "Lotus MCP discovery file is present.".to_string()
        } else {
            "Lotus MCP discovery file is missing.".to_string()
        },
    };
    let claude_mcp = BridgeMcpHealthItem {
        ok: input.claude_mcp_present,
        detail: if input.claude_mcp_present {
            format!("Claude MCP {} is registered.", input.profile_key)
        } else {
            format!("Claude MCP {} is missing.", input.profile_key)
        },
    };
    let codex_mcp = BridgeMcpHealthItem {
        ok: input.codex_mcp_present,
        detail: if input.codex_mcp_present {
            format!("Codex MCP {} is registered.", input.profile_key)
        } else {
            format!("Codex MCP {} is missing.", input.profile_key)
        },
    };

    let discovery_status = classify_bridge_mcp_discovery(BridgeMcpDiscoveryHealthInput {
        discovery_present: input.discovery_present,
        pid_alive: input.discovery_pid_alive,
        server_responsive: input.server_responsive,
        other_profile: false,
    });

    let other_profile_key = input
        .other_profile_key
        .as_deref()
        .unwrap_or("other Lotus profile");
    let other_profile = BridgeMcpHealthItem {
        ok: !input.other_profile_live,
        detail: if input.other_profile_live {
            format!("Other Lotus MCP profile {other_profile_key} is also live.")
        } else {
            "No other live Lotus MCP profile detected.".to_string()
        },
    };

    let reason = if !input.discovery_present {
        Some("Lotus MCP discovery file missing. Local Bridge commands still work.".to_string())
    } else if discovery_status == BridgeMcpDiscoveryStatus::StalePid {
        Some(
            "Lotus MCP discovery file points to a dead process. Local Bridge commands still work."
                .to_string(),
        )
    } else if !input.server_responsive {
        Some(
            "Lotus MCP IPC server is not responding. Local Bridge commands still work.".to_string(),
        )
    } else if !input.claude_mcp_present {
        Some(format!(
            "Claude MCP {} missing. Local Bridge commands still work.",
            input.profile_key
        ))
    } else if !input.codex_mcp_present {
        Some(format!(
            "Codex MCP {} missing. Local Bridge commands still work.",
            input.profile_key
        ))
    } else if input.other_profile_live {
        Some(format!(
            "Both {} and {other_profile_key} MCP profiles are live. Local Bridge commands still work, but external Claude/Codex sessions may see duplicate Lotus tool sets.",
            input.profile_key
        ))
    } else {
        None
    };

    BridgeMcpHealth {
        status: if reason.is_some() {
            "degraded"
        } else {
            "healthy"
        },
        reason,
        port: input.port,
        profile_key: input.profile_key,
        discovery_present: input.discovery_present,
        mcp_entry_present: input.claude_mcp_present,
        codex_mcp_entry_present: input.codex_mcp_present,
        server_responsive: input.server_responsive,
        discovery_status,
        other_profile_live: input.other_profile_live,
        other_profile_status: input.other_profile_status,
        local_orchestration,
        discovery_file,
        claude_mcp,
        codex_mcp,
        other_profile,
    }
}

pub fn collect_bridge_mcp_health(
    port: Option<u16>,
    server_responsive: bool,
    sidecar_spawn: Option<(String, Vec<String>)>,
) -> BridgeMcpHealth {
    let discovery_path = mcp_config::ipc_discovery_path().ok();
    let discovery_present = discovery_path
        .as_ref()
        .map(|path| path.exists())
        .unwrap_or(false);
    let discovery_pid_alive = discovery_path
        .as_ref()
        .and_then(|path| discovery_pid_alive(path));
    let profile_key = mcp_config::mcp_server_key().to_string();
    let (claude_mcp_present, codex_mcp_present) = match sidecar_spawn {
        Some((command, args)) => (
            claude_mcp_entry_present(&command, &args),
            codex_mcp_entry_present(&command, &args),
        ),
        None => (false, false),
    };

    let (other_profile_key, other_profile_status) = other_profile_health();
    let other_profile_live = other_profile_status == BridgeMcpDiscoveryStatus::OtherProfileLive;

    build_bridge_mcp_health(BridgeMcpHealthInput {
        port,
        profile_key,
        discovery_present,
        discovery_pid_alive,
        claude_mcp_present,
        codex_mcp_present,
        server_responsive,
        other_profile_live,
        other_profile_key,
        other_profile_status,
    })
}

fn other_profile_health() -> (Option<String>, BridgeMcpDiscoveryStatus) {
    let home = match dirs::home_dir() {
        Some(home) => home,
        None => return (None, BridgeMcpDiscoveryStatus::Missing),
    };
    let (key, discovery_path) = if paths::is_dev_profile() {
        (
            "lotus".to_string(),
            home.join(".lotus").join("lotus-mcp-ipc.json"),
        )
    } else {
        (
            "lotus-dev".to_string(),
            home.join(".lotus-dev").join("lotus-mcp-ipc.json"),
        )
    };
    let discovery_present = discovery_path.exists();
    let pid_alive = discovery_pid_alive(&discovery_path);
    let status = classify_bridge_mcp_discovery(BridgeMcpDiscoveryHealthInput {
        discovery_present,
        pid_alive,
        server_responsive: false,
        other_profile: true,
    });
    (Some(key), status)
}

fn discovery_pid_alive(path: &std::path::Path) -> Option<bool> {
    let bytes = std::fs::read(path).ok()?;
    let discovery = serde_json::from_slice::<mcp_config::IpcDiscoveryFile>(&bytes).ok()?;
    Some(is_pid_alive(discovery.pid))
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) != -1 || *libc::__error() != libc::ESRCH }
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    true
}

fn claude_mcp_entry_present(command: &str, args: &[String]) -> bool {
    match mcp_config::mcp_config_path() {
        Ok(path) => match std::fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(root) => mcp_config::has_exact_lotus_entry(&root, command, args),
                Err(_) => false,
            },
            Err(_) => false,
        },
        Err(_) => false,
    }
}

fn codex_mcp_entry_present(command: &str, args: &[String]) -> bool {
    match mcp_config::codex_config_path() {
        Ok(path) => match std::fs::read_to_string(&path) {
            Ok(text) => mcp_config::has_exact_codex_mcp_entry(
                &text,
                mcp_config::codex_mcp_server_key(),
                command,
                args,
            ),
            Err(_) => false,
        },
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_bridge_mcp_discovery_distinguishes_missing_stale_responsive_and_other_live() {
        assert_eq!(
            classify_bridge_mcp_discovery(BridgeMcpDiscoveryHealthInput {
                discovery_present: false,
                pid_alive: None,
                server_responsive: false,
                other_profile: false,
            }),
            BridgeMcpDiscoveryStatus::Missing,
        );
        assert_eq!(
            classify_bridge_mcp_discovery(BridgeMcpDiscoveryHealthInput {
                discovery_present: true,
                pid_alive: Some(false),
                server_responsive: false,
                other_profile: false,
            }),
            BridgeMcpDiscoveryStatus::StalePid,
        );
        assert_eq!(
            classify_bridge_mcp_discovery(BridgeMcpDiscoveryHealthInput {
                discovery_present: true,
                pid_alive: Some(true),
                server_responsive: false,
                other_profile: false,
            }),
            BridgeMcpDiscoveryStatus::StalePort,
        );
        assert_eq!(
            classify_bridge_mcp_discovery(BridgeMcpDiscoveryHealthInput {
                discovery_present: true,
                pid_alive: Some(true),
                server_responsive: true,
                other_profile: false,
            }),
            BridgeMcpDiscoveryStatus::Responsive,
        );
        assert_eq!(
            classify_bridge_mcp_discovery(BridgeMcpDiscoveryHealthInput {
                discovery_present: true,
                pid_alive: Some(true),
                server_responsive: false,
                other_profile: true,
            }),
            BridgeMcpDiscoveryStatus::OtherProfileLive,
        );
    }

    #[test]
    fn build_bridge_mcp_health_reports_healthy_when_every_layer_is_ready() {
        let health = build_bridge_mcp_health(BridgeMcpHealthInput {
            port: Some(43123),
            profile_key: "lotus-dev".into(),
            discovery_present: true,
            discovery_pid_alive: Some(true),
            claude_mcp_present: true,
            codex_mcp_present: true,
            server_responsive: true,
            other_profile_live: false,
            other_profile_key: None,
            other_profile_status: BridgeMcpDiscoveryStatus::Missing,
        });

        assert_eq!(health.status, "healthy");
        assert_eq!(health.reason, None);
        assert!(health.local_orchestration.ok);
        assert!(health.discovery_file.ok);
        assert!(health.claude_mcp.ok);
        assert!(health.codex_mcp.ok);
        assert!(health.discovery_present);
        assert!(health.mcp_entry_present);
        assert!(health.codex_mcp_entry_present);
        assert!(health.server_responsive);
        assert_eq!(health.port, Some(43123));
        assert_eq!(health.profile_key, "lotus-dev");
        assert_eq!(
            health.discovery_status,
            BridgeMcpDiscoveryStatus::Responsive
        );
    }

    #[test]
    fn build_bridge_mcp_health_degrades_on_stale_discovery_pid() {
        let health = build_bridge_mcp_health(BridgeMcpHealthInput {
            port: Some(43123),
            profile_key: "lotus-dev".into(),
            discovery_present: true,
            discovery_pid_alive: Some(false),
            claude_mcp_present: true,
            codex_mcp_present: true,
            server_responsive: true,
            other_profile_live: false,
            other_profile_key: None,
            other_profile_status: BridgeMcpDiscoveryStatus::Missing,
        });

        assert_eq!(health.status, "degraded");
        assert_eq!(health.discovery_status, BridgeMcpDiscoveryStatus::StalePid);
        assert_eq!(
            health.reason.as_deref(),
            Some("Lotus MCP discovery file points to a dead process. Local Bridge commands still work.")
        );
    }

    #[test]
    fn build_bridge_mcp_health_warns_when_the_other_lotus_profile_is_live() {
        let health = build_bridge_mcp_health(BridgeMcpHealthInput {
            port: Some(43123),
            profile_key: "lotus-dev".into(),
            discovery_present: true,
            discovery_pid_alive: Some(true),
            claude_mcp_present: true,
            codex_mcp_present: true,
            server_responsive: true,
            other_profile_live: true,
            other_profile_key: Some("lotus".into()),
            other_profile_status: BridgeMcpDiscoveryStatus::OtherProfileLive,
        });

        assert_eq!(health.status, "degraded");
        assert_eq!(
            health.reason.as_deref(),
            Some("Both lotus-dev and lotus MCP profiles are live. Local Bridge commands still work, but external Claude/Codex sessions may see duplicate Lotus tool sets.")
        );
        assert!(health.other_profile_live);
        assert!(!health.other_profile.ok);
        assert_eq!(
            health.other_profile_status,
            BridgeMcpDiscoveryStatus::OtherProfileLive
        );
    }

    #[test]
    fn build_bridge_mcp_health_degrades_when_codex_mcp_is_missing() {
        let health = build_bridge_mcp_health(BridgeMcpHealthInput {
            port: Some(43123),
            profile_key: "lotus-dev".into(),
            discovery_present: true,
            discovery_pid_alive: Some(true),
            claude_mcp_present: true,
            codex_mcp_present: false,
            server_responsive: true,
            other_profile_live: false,
            other_profile_key: None,
            other_profile_status: BridgeMcpDiscoveryStatus::Missing,
        });

        assert_eq!(health.status, "degraded");
        assert_eq!(
            health.reason.as_deref(),
            Some("Codex MCP lotus-dev missing. Local Bridge commands still work.")
        );
        assert!(health.local_orchestration.ok);
        assert!(!health.codex_mcp.ok);
        assert!(!health.codex_mcp_entry_present);
    }
}
