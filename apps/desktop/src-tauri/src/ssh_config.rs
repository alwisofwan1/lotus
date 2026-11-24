use crate::no_window::NoWindow;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{other, AppError};
use crate::paths;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// The Cloudflare Access application this host is reached through, when it is.
    ///
    /// Read off `ProxyCommand ... cloudflared access ssh --hostname %h`: `%h` is the host after
    /// `HostName` substitution, which is exactly the name `cloudflared access login` takes. Knowing
    /// it turns "the machine timed out" into "this machine needs you to sign in", which is a
    /// different sentence and a different button.
    pub access_hostname: Option<String>,
}

#[derive(Debug, Clone)]
struct HostBlock {
    aliases: Vec<String>,
    hostname: Option<String>,
    user: Option<String>,
    port: Option<u16>,
    proxy_command: Option<String>,
}

impl HostBlock {
    fn new(aliases: Vec<String>) -> Self {
        Self {
            aliases,
            hostname: None,
            user: None,
            port: None,
            proxy_command: None,
        }
    }
}

/// The Cloudflare Access app name behind a `ProxyCommand`, if that is what the proxy is.
///
/// Matched on both words rather than the binary path: an operator may point `ProxyCommand` at
/// `/opt/homebrew/bin/cloudflared`, at a wrapper script, or at plain `cloudflared` on PATH, and all
/// three are the same arrangement. Anything else — a jump host, `nc`, corkscrew — is not Access and
/// must not be labelled as needing an Access login.
pub(crate) fn access_hostname_from(
    proxy_command: Option<&str>,
    hostname: Option<&str>,
    alias: &str,
) -> Option<String> {
    let proxy = proxy_command?;
    let lowered = proxy.to_ascii_lowercase();
    if !(lowered.contains("cloudflared") && lowered.contains("access")) {
        return None;
    }
    // `%h` is substituted with HostName when there is one, and with the alias when there is not.
    let resolved = hostname
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(alias)
        .to_string();
    if resolved.is_empty() {
        None
    } else {
        Some(resolved)
    }
}

/// The Access application `alias` is reached through, per `~/.ssh/config`, if it is one.
///
/// Read from the file only: `access_hostname` is set while parsing, so the `ssh -G` per host that
/// `list_ssh_hosts` runs would add a process per alias to every connect for nothing.
pub(crate) fn access_hostname_for(alias: &str) -> Option<String> {
    let config_path = paths::home_dir().join(".ssh").join("config");
    parse_ssh_config_file(&config_path, &mut HashSet::new())
        .ok()?
        .into_iter()
        .find(|host| host.alias == alias)?
        .access_hostname
}

pub fn list_ssh_hosts() -> Result<Vec<SshConfigHost>, AppError> {
    let config_path = paths::home_dir().join(".ssh").join("config");
    if !config_path.exists() {
        return Ok(Vec::new());
    }

    let mut visited = HashSet::new();
    let hosts = parse_ssh_config_file(&config_path, &mut visited)?;
    Ok(resolve_ssh_hosts(hosts))
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_ssh_config_hosts(content: &str) -> Vec<SshConfigHost> {
    parse_ssh_config(content).hosts
}

#[derive(Debug, Default)]
struct ParsedSshConfig {
    hosts: Vec<SshConfigHost>,
    includes: Vec<String>,
}

fn parse_ssh_config(content: &str) -> ParsedSshConfig {
    let mut hosts = Vec::new();
    let mut includes = Vec::new();
    let mut current: Option<HostBlock> = None;

    for line in content.lines() {
        let normalized = strip_comment(line).trim();
        if normalized.is_empty() {
            continue;
        }

        let (key, value) = match split_directive(normalized) {
            Some(parts) => parts,
            None => continue,
        };

        if key.eq_ignore_ascii_case("include") {
            includes.extend(value.split_whitespace().map(ToOwned::to_owned));
            continue;
        }

        if key.eq_ignore_ascii_case("host") {
            flush_host_block(current.take(), &mut hosts);
            let aliases = value
                .split_whitespace()
                .filter(is_listable_host_alias)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>();
            current = Some(HostBlock::new(aliases));
            continue;
        }

        let Some(block) = current.as_mut() else {
            continue;
        };

        if key.eq_ignore_ascii_case("hostname") {
            block.hostname = Some(value.trim().to_string());
        } else if key.eq_ignore_ascii_case("user") {
            block.user = Some(value.trim().to_string());
        } else if key.eq_ignore_ascii_case("port") {
            block.port = value.trim().parse::<u16>().ok();
        } else if key.eq_ignore_ascii_case("proxycommand") {
            block.proxy_command = Some(value.trim().to_string());
        }
    }

    flush_host_block(current.take(), &mut hosts);
    ParsedSshConfig { hosts, includes }
}

fn parse_ssh_config_file(
    config_path: &Path,
    visited: &mut HashSet<PathBuf>,
) -> Result<Vec<SshConfigHost>, AppError> {
    let canonical_path = config_path
        .canonicalize()
        .unwrap_or_else(|_| config_path.to_path_buf());
    if !visited.insert(canonical_path) {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(config_path).map_err(AppError::Io)?;
    let parsed = parse_ssh_config(&content);
    let mut hosts = parsed.hosts;
    let base_dir = config_path.parent().unwrap_or_else(|| Path::new("."));

    for include in parsed.includes {
        for include_path in expand_include_pattern(base_dir, &include) {
            if include_path.is_file() {
                hosts.extend(parse_ssh_config_file(&include_path, visited)?);
            }
        }
    }

    Ok(hosts)
}

fn expand_include_pattern(base_dir: &Path, pattern: &str) -> Vec<PathBuf> {
    let expanded = expand_home(pattern);
    let path = PathBuf::from(expanded);
    let absolute_pattern = if path.is_absolute() {
        path
    } else {
        base_dir.join(path)
    };

    if !pattern_has_wildcard(&absolute_pattern) {
        return vec![absolute_pattern];
    }

    expand_wildcard_path(&absolute_pattern)
}

fn expand_home(pattern: &str) -> String {
    if pattern == "~" {
        return paths::home_dir().to_string_lossy().into_owned();
    }
    if let Some(rest) = pattern.strip_prefix("~/") {
        return paths::home_dir().join(rest).to_string_lossy().into_owned();
    }
    pattern.to_string()
}

fn pattern_has_wildcard(path: &Path) -> bool {
    path.components().any(|component| {
        let text = component.as_os_str().to_string_lossy();
        text.contains('*') || text.contains('?')
    })
}

fn expand_wildcard_path(pattern: &Path) -> Vec<PathBuf> {
    let mut matches = vec![PathBuf::new()];

    for component in pattern.components() {
        let component_text = component.as_os_str().to_string_lossy().to_string();
        let has_wildcard = component_text.contains('*') || component_text.contains('?');
        let mut next_matches = Vec::new();

        for prefix in &matches {
            if has_wildcard {
                let dir = if prefix.as_os_str().is_empty() {
                    Path::new(".")
                } else {
                    prefix.as_path()
                };
                if let Ok(entries) = fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let file_name = entry.file_name();
                        let file_name = file_name.to_string_lossy();
                        if wildcard_matches(&component_text, &file_name) {
                            next_matches.push(prefix.join(file_name.as_ref()));
                        }
                    }
                }
            } else {
                next_matches.push(prefix.join(component.as_os_str()));
            }
        }

        matches = next_matches;
        if matches.is_empty() {
            break;
        }
    }

    matches.sort();
    matches
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    fn matches(pattern: &[u8], value: &[u8]) -> bool {
        if pattern.is_empty() {
            return value.is_empty();
        }

        match pattern[0] {
            b'*' => {
                matches(&pattern[1..], value)
                    || (!value.is_empty() && matches(pattern, &value[1..]))
            }
            b'?' => !value.is_empty() && matches(&pattern[1..], &value[1..]),
            char => !value.is_empty() && char == value[0] && matches(&pattern[1..], &value[1..]),
        }
    }

    matches(pattern.as_bytes(), value.as_bytes())
}

fn resolve_ssh_hosts(hosts: Vec<SshConfigHost>) -> Vec<SshConfigHost> {
    hosts.into_iter().map(resolve_ssh_host).collect()
}

fn resolve_ssh_host(host: SshConfigHost) -> SshConfigHost {
    let output = Command::new("ssh").no_window().arg("-G").arg(&host.alias).output();
    let Ok(output) = output else {
        return host;
    };
    if !output.status.success() {
        return host;
    }
    let resolved = String::from_utf8_lossy(&output.stdout);
    merge_resolved_config(host, &resolved)
}

fn merge_resolved_config(mut host: SshConfigHost, resolved_config: &str) -> SshConfigHost {
    for line in resolved_config.lines() {
        let Some((key, value)) = split_directive(line.trim()) else {
            continue;
        };
        if key.eq_ignore_ascii_case("hostname") {
            host.hostname = Some(value.to_string());
        } else if key.eq_ignore_ascii_case("user") {
            host.user = Some(value.to_string());
        } else if key.eq_ignore_ascii_case("port") {
            host.port = value.parse::<u16>().ok();
        }
    }

    host
}

fn is_listable_host_alias(alias: &&str) -> bool {
    !alias.is_empty()
        && !alias.contains('*')
        && !alias.contains('?')
        && !alias.starts_with('!')
        && !alias.starts_with('-')
}

fn flush_host_block(block: Option<HostBlock>, hosts: &mut Vec<SshConfigHost>) {
    let Some(block) = block else {
        return;
    };

    for alias in block.aliases {
        if alias.trim().is_empty() {
            continue;
        }
        let access_hostname = access_hostname_from(
            block.proxy_command.as_deref(),
            block.hostname.as_deref(),
            &alias,
        );
        hosts.push(SshConfigHost {
            alias,
            hostname: block.hostname.clone(),
            user: block.user.clone(),
            port: block.port,
            access_hostname,
        });
    }
}

fn split_directive(line: &str) -> Option<(&str, &str)> {
    let mut parts = line.splitn(2, char::is_whitespace);
    let key = parts.next()?.trim();
    if key.is_empty() {
        return None;
    }
    let value = parts.next()?.trim();
    if value.is_empty() {
        return None;
    }
    Some((key, value))
}

fn strip_comment(line: &str) -> &str {
    match line.find('#') {
        Some(index) => &line[..index],
        None => line,
    }
}

#[allow(dead_code)]
fn _config_path_for_tests(home: &Path) -> Result<String, AppError> {
    home.join(".ssh")
        .join("config")
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| other("invalid ssh config path"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cloudflared_proxy_names_the_access_application_to_sign_in_to() {
        let hosts = parse_ssh_config_hosts(
            "Host devbox-vps\n  HostName ssh-alwi.example-vps.com\n  User alwi\n  ProxyCommand /usr/local/bin/cloudflared access ssh --hostname %h\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(
            hosts[0].access_hostname.as_deref(),
            Some("ssh-alwi.example-vps.com"),
            "%h resolves to HostName, which is the name `cloudflared access login` takes"
        );
    }

    #[test]
    fn without_a_hostname_the_alias_is_what_percent_h_becomes() {
        let hosts = parse_ssh_config_hosts(
            "Host vps.example.com\n  ProxyCommand cloudflared access ssh --hostname %h\n",
        );
        assert_eq!(hosts[0].access_hostname.as_deref(), Some("vps.example.com"));
    }

    /// A jump host is not Cloudflare Access, and must never be labelled as needing an Access login.
    #[test]
    fn an_ordinary_proxy_command_is_not_an_access_application() {
        let hosts = parse_ssh_config_hosts(
            "Host behind-jump\n  HostName 10.0.0.5\n  ProxyCommand ssh -W %h:%p bastion\n",
        );
        assert_eq!(hosts[0].access_hostname, None);

        let plain = parse_ssh_config_hosts("Host plain\n  HostName 10.0.0.6\n");
        assert_eq!(plain[0].access_hostname, None);
    }

    #[test]
    fn parses_named_hosts_with_metadata() {
        let hosts = parse_ssh_config_hosts(
            r#"
Host *
  ForwardAgent yes

Host orb github-personal
  HostName 10.0.0.5
  User alwi
  Port 2222

Host !excluded *.internal devbox-vps
  HostName devbox.example.com
            "#,
        );

        assert_eq!(
            hosts,
            vec![
                SshConfigHost {
                    alias: "orb".into(),
                    hostname: Some("10.0.0.5".into()),
                    user: Some("alwi".into()),
                    port: Some(2222),
                access_hostname: None,
                },
                SshConfigHost {
                    alias: "github-personal".into(),
                    hostname: Some("10.0.0.5".into()),
                    user: Some("alwi".into()),
                    port: Some(2222),
                access_hostname: None,
                },
                SshConfigHost {
                    alias: "devbox-vps".into(),
                    hostname: Some("devbox.example.com".into()),
                    user: None,
                    port: None,
                access_hostname: None,
                },
            ],
        );
    }

    #[test]
    fn parses_included_config_files() {
        let root =
            std::env::temp_dir().join(format!("lotus_ssh_config_test_{}", std::process::id()));
        let ssh_dir = root.join(".ssh");
        let include_dir = ssh_dir.join("conf.d");
        fs::create_dir_all(&include_dir).expect("create include dir");
        fs::write(
            ssh_dir.join("config"),
            r#"
Include conf.d/*.conf

Host main-vps
  HostName main.example.com
            "#,
        )
        .expect("write main config");
        fs::write(
            include_dir.join("work.conf"),
            r#"
Host work-vps
  User alwi
  Port 2200
            "#,
        )
        .expect("write included config");

        let mut visited = HashSet::new();
        let hosts = parse_ssh_config_file(&ssh_dir.join("config"), &mut visited)
            .expect("parse config tree");

        assert_eq!(
            hosts,
            vec![
                SshConfigHost {
                    alias: "main-vps".into(),
                    hostname: Some("main.example.com".into()),
                    user: None,
                    port: None,
                access_hostname: None,
                },
                SshConfigHost {
                    alias: "work-vps".into(),
                    hostname: None,
                    user: Some("alwi".into()),
                    port: Some(2200),
                access_hostname: None,
                },
            ],
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merges_resolved_open_ssh_config_output() {
        let host = merge_resolved_config(
            SshConfigHost {
                alias: "devbox-vps".into(),
                hostname: None,
                user: None,
                port: None,
                access_hostname: None,
            },
            r#"
host devbox-vps
user deploy
hostname 10.0.0.12
port 2222
            "#,
        );

        assert_eq!(
            host,
            SshConfigHost {
                alias: "devbox-vps".into(),
                hostname: Some("10.0.0.12".into()),
                user: Some("deploy".into()),
                port: Some(2222),
                access_hostname: None,
            },
        );
    }

    #[test]
    fn ignores_comments_and_invalid_directives() {
        let hosts = parse_ssh_config_hosts(
            r#"
# Host disabled
Host gitlab-work # inline comment
  User git
  Port not-a-number
            "#,
        );

        assert_eq!(
            hosts,
            vec![SshConfigHost {
                alias: "gitlab-work".into(),
                hostname: None,
                user: Some("git".into()),
                port: None,
                access_hostname: None,
            }],
        );
    }
}
