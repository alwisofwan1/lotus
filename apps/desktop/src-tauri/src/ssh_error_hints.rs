//! Pure mapper that turns OpenSSH client stderr into a user-actionable hint.
//!
//! OpenSSH's default error messages are notoriously opaque — `"Connection to
//! UNKNOWN port 65535 timed out"` is the canonical example: the slave hands
//! its host/port info to a multiplex master that never responds and the
//! client has nothing left to print. This module recognizes the common
//! failure shapes and surfaces a single-sentence diagnosis the user can
//! act on (re-auth Cloudflare tunnel, load ssh-agent key, check sshd
//! `MaxStartups`, etc.).
//!
//! Pure: no I/O, no globals. Tested as a regular library function.

#[derive(Debug, PartialEq, Eq)]
pub enum SshErrorCategory {
    /// `"Connection to UNKNOWN port 65535 timed out"` — almost always means
    /// the SSH ProxyCommand (Cloudflare Access tunnel, jump host script, …)
    /// hung or returned no bytes. The slave already handed its host info to
    /// a master/proxy that never produced data.
    ProxyCommandStalled,
    /// `"Connection timed out during banner exchange"` — TCP succeeded but
    /// sshd never sent its `SSH-2.0-...` greeting. Usually means sshd is
    /// rate-limiting (`MaxStartups`), the box is overloaded, or a firewall
    /// is intercepting without forwarding.
    BannerTimeout,
    /// BatchMode rejected the connection — no SSH key in agent or wrong
    /// key permissions on disk.
    AuthFailed,
    /// Hostname could not be resolved by the local resolver. Often a typo
    /// in the alias or a stale `~/.ssh/config`.
    HostUnresolved,
    /// TCP-level refusal (`ECONNREFUSED`). The host is up but nothing is
    /// listening on the SSH port we tried.
    ConnectionRefused,
    /// Catch-all for everything else. Caller should fall back to showing
    /// the raw stderr.
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
pub struct SshErrorHint {
    pub category: SshErrorCategory,
    /// Single-sentence user-facing message. Includes one concrete next
    /// action where possible (e.g. the `cloudflared access login` command).
    pub message: String,
    /// Whether this hint is confident enough to fully replace the raw
    /// stderr in UI. Categories with strong markers set this to true; the
    /// `Unknown` category sets false and the caller should show the raw
    /// stderr instead.
    pub confident: bool,
}

/// Inspect SSH client stderr and (optionally) the resolved `ProxyCommand`
/// for the host. The proxy is passed separately because the stderr usually
/// does not name it — when present we can be specific ("Cloudflare tunnel"
/// instead of "ProxyCommand").
pub fn ssh_error_hint(stderr: &str, proxy_command: Option<&str>) -> SshErrorHint {
    let lower = stderr.to_ascii_lowercase();
    let has_unknown_port = lower.contains("connection to unknown port 65535");
    let has_banner_timeout = lower.contains("timed out during banner exchange");
    let has_perm_denied = lower.contains("permission denied")
        || lower.contains("publickey")
        || lower.contains("could not authenticate");
    let has_resolve_fail = lower.contains("could not resolve hostname")
        || lower.contains("name or service not known")
        || lower.contains("nodename nor servname provided");
    let has_refused = lower.contains("connection refused");

    if has_unknown_port {
        // The "UNKNOWN port 65535" pattern is the strongest single signal
        // for a stalled ProxyCommand. If we know it's cloudflared we can
        // quote the exact command users need to run.
        let proxy_kind = classify_proxy(proxy_command);
        let message = match proxy_kind {
            ProxyKind::Cloudflared { team_url } => match team_url {
                Some(url) => format!(
                    "Cloudflare Access tunnel did not respond. Re-authenticate: \
                     run `cloudflared access login {url}` in a terminal, then retry.",
                ),
                None => "Cloudflare Access tunnel did not respond. Re-authenticate \
                     with `cloudflared access login <your-team-domain>` and retry."
                    .to_string(),
            },
            ProxyKind::Other(name) => format!(
                "ProxyCommand `{name}` returned no data. The proxy may be down, \
                 unauthenticated, or misconfigured — check it before retrying SSH.",
            ),
            ProxyKind::None => {
                // The "UNKNOWN port 65535" pattern can also surface from a
                // dead ControlMaster slave, but Lotus disables multiplexing
                // for one-shots so this branch is mostly defensive.
                "SSH could not reach the host. If you use a ProxyCommand, \
                 jump host, or VPN check it is up; otherwise re-test with \
                 `ssh -v <host>`."
                    .to_string()
            }
        };
        return SshErrorHint {
            category: SshErrorCategory::ProxyCommandStalled,
            message,
            confident: true,
        };
    }

    if has_banner_timeout {
        let suffix = match classify_proxy(proxy_command) {
            ProxyKind::Cloudflared {
                team_url: Some(url),
            } => format!(
                " (If you use a Cloudflare tunnel, re-auth with \
                 `cloudflared access login {url}`.)",
            ),
            ProxyKind::Cloudflared { team_url: None } => {
                " (If you use a Cloudflare tunnel, re-auth with \
                 `cloudflared access login <team-domain>`.)"
                    .to_string()
            }
            _ => String::new(),
        };
        return SshErrorHint {
            category: SshErrorCategory::BannerTimeout,
            message: format!(
                "SSH connected but the remote sshd never sent its banner. \
                 The server may be overloaded, rate-limiting (MaxStartups), \
                 or behind a slow proxy.{suffix}",
            ),
            confident: true,
        };
    }

    if has_perm_denied {
        return SshErrorHint {
            category: SshErrorCategory::AuthFailed,
            message: "SSH authentication failed. Make sure your key is loaded \
                 (`ssh-add -l`) or that the right `IdentityFile` is configured \
                 for this host in `~/.ssh/config`."
                .to_string(),
            confident: true,
        };
    }

    if has_resolve_fail {
        return SshErrorHint {
            category: SshErrorCategory::HostUnresolved,
            message: "SSH could not resolve the hostname. Check the spelling \
                 of the alias or the `HostName` line in `~/.ssh/config`."
                .to_string(),
            confident: true,
        };
    }

    if has_refused {
        return SshErrorHint {
            category: SshErrorCategory::ConnectionRefused,
            message: "SSH connection was refused by the remote host. The box is \
                 reachable but no sshd is listening on that port."
                .to_string(),
            confident: true,
        };
    }

    SshErrorHint {
        category: SshErrorCategory::Unknown,
        message: stderr.trim().to_string(),
        confident: false,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ProxyKind {
    /// `cloudflared access ssh --hostname %h` (or any cloudflared proxy).
    /// `team_url` is the Cloudflare Access team URL when discoverable from
    /// a parallel input; for now we only know it's cloudflared, so leave
    /// it None and let callers prompt the user.
    Cloudflared { team_url: Option<String> },
    /// Some other proxy binary (corkscrew, ProxyJump-via-script, etc.) —
    /// surface the binary name in the hint without claiming we know more.
    Other(String),
    /// No `ProxyCommand` set for this host.
    None,
}

fn classify_proxy(proxy_command: Option<&str>) -> ProxyKind {
    let raw = match proxy_command {
        Some(cmd) if !cmd.trim().is_empty() && cmd.trim() != "none" => cmd.trim(),
        _ => return ProxyKind::None,
    };
    let lower = raw.to_ascii_lowercase();
    if lower.contains("cloudflared") {
        return ProxyKind::Cloudflared { team_url: None };
    }
    // Take the first word as the binary name for the friendly message.
    let name = raw
        .split_whitespace()
        .next()
        .unwrap_or(raw)
        .rsplit('/')
        .next()
        .unwrap_or(raw)
        .to_string();
    ProxyKind::Other(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_port_65535_with_cloudflared_quotes_login_command() {
        let stderr = "Connection timed out during banner exchange\n\
                      Connection to UNKNOWN port 65535 timed out\n";
        let hint = ssh_error_hint(
            stderr,
            Some("/usr/local/bin/cloudflared access ssh --hostname %h"),
        );
        assert_eq!(hint.category, SshErrorCategory::ProxyCommandStalled);
        assert!(hint.confident);
        assert!(hint.message.contains("Cloudflare Access tunnel"));
        assert!(hint.message.contains("cloudflared access login"));
    }

    #[test]
    fn unknown_port_65535_with_generic_proxy_names_the_binary() {
        let stderr = "Connection to UNKNOWN port 65535 timed out\n";
        let hint = ssh_error_hint(
            stderr,
            Some("/usr/local/bin/corkscrew proxy.example 8080 %h %p"),
        );
        assert_eq!(hint.category, SshErrorCategory::ProxyCommandStalled);
        assert!(hint.message.contains("corkscrew"));
    }

    #[test]
    fn unknown_port_65535_without_proxy_falls_back_to_generic_advice() {
        let stderr = "Connection to UNKNOWN port 65535 timed out\n";
        let hint = ssh_error_hint(stderr, None);
        assert_eq!(hint.category, SshErrorCategory::ProxyCommandStalled);
        assert!(
            hint.message.contains("ProxyCommand")
                || hint.message.contains("VPN")
                || hint.message.contains("ssh -v")
        );
    }

    #[test]
    fn banner_timeout_alone_is_categorized_separately() {
        let stderr = "Connection timed out during banner exchange\n";
        let hint = ssh_error_hint(stderr, None);
        assert_eq!(hint.category, SshErrorCategory::BannerTimeout);
        assert!(hint.message.contains("banner"));
        assert!(hint.message.contains("MaxStartups") || hint.message.contains("overloaded"));
    }

    #[test]
    fn banner_timeout_with_cloudflared_appends_login_hint() {
        let stderr = "Connection timed out during banner exchange\n";
        let hint = ssh_error_hint(stderr, Some("cloudflared access ssh --hostname %h"));
        assert_eq!(hint.category, SshErrorCategory::BannerTimeout);
        assert!(hint.message.contains("Cloudflare"));
    }

    #[test]
    fn permission_denied_publickey_classifies_auth() {
        let stderr = "Permission denied (publickey).\n";
        let hint = ssh_error_hint(stderr, None);
        assert_eq!(hint.category, SshErrorCategory::AuthFailed);
        assert!(hint.message.contains("ssh-add") || hint.message.contains("IdentityFile"));
    }

    #[test]
    fn resolve_failure_classifies_host_unresolved() {
        let stderr = "ssh: Could not resolve hostname devbox-vps: nodename nor servname provided, or not known\n";
        let hint = ssh_error_hint(stderr, None);
        assert_eq!(hint.category, SshErrorCategory::HostUnresolved);
    }

    #[test]
    fn connection_refused_classifies_refused() {
        let stderr = "ssh: connect to host 1.2.3.4 port 22: Connection refused\n";
        let hint = ssh_error_hint(stderr, None);
        assert_eq!(hint.category, SshErrorCategory::ConnectionRefused);
    }

    #[test]
    fn unrecognized_stderr_returns_unknown_with_raw_message() {
        let stderr = "some weirdness happened\n";
        let hint = ssh_error_hint(stderr, None);
        assert_eq!(hint.category, SshErrorCategory::Unknown);
        assert!(!hint.confident);
        assert_eq!(hint.message, "some weirdness happened");
    }

    #[test]
    fn empty_proxy_command_is_treated_as_none() {
        assert_eq!(classify_proxy(Some("")), ProxyKind::None);
        assert_eq!(classify_proxy(Some("   ")), ProxyKind::None);
        assert_eq!(classify_proxy(Some("none")), ProxyKind::None);
        assert_eq!(classify_proxy(None), ProxyKind::None);
    }

    #[test]
    fn classify_proxy_strips_path_for_other_binary() {
        match classify_proxy(Some("/opt/jump/bin/jumper -t %h")) {
            ProxyKind::Other(name) => assert_eq!(name, "jumper"),
            other => panic!("expected ProxyKind::Other, got {other:?}"),
        }
    }
}
