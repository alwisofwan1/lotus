//! Subscription usage of the machines Lotus is connected to (portable accounts, PLAN §5, step 6).
//!
//! Each machine's Lotus Host answers `/v1/usage` for its own accounts; the shape is
//! `contract/fixtures/usage-snapshot.json`, the same rows `usage::snapshot` makes here. Only a machine
//! with an SSH master already open is asked — opening one just for usage would put an SSO prompt in
//! front of the operator. A machine asked before keeps its last numbers, shown as not connected.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cli_tools::{run_ssh_over_master, SshToolTarget};
use crate::remote_lotus_host::{build_usage_script, check_status, parse_host_answer};
use crate::remote_transport::RemoteTransport;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineUsage {
    /// The SSH target as the operator wrote it (`host`, `user@host`, `host:port`): the key.
    pub target: String,
    /// What the machine calls itself (its hostname), or the target when it never answered.
    pub machine: String,
    /// `live`, `not-connected`, `old-host` or `error`.
    pub state: &'static str,
    /// `UsageAccount` rows as the host sent them (camelCase JSON, see the fixture).
    pub accounts: Vec<Value>,
    pub error: Option<String>,
    /// When `accounts` were fetched, for anything but `live`.
    pub as_of_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Saved {
    machine: String,
    at_ms: i64,
    accounts: Vec<Value>,
}

#[derive(Deserialize)]
struct Envelope {
    machine: String,
    accounts: Vec<Value>,
}

pub(crate) fn label(t: &SshToolTarget) -> String {
    let user = t.user.as_deref().map(|u| format!("{u}@")).unwrap_or_default();
    let port = t.port.map(|p| format!(":{p}")).unwrap_or_default();
    format!("{user}{}{port}", t.host)
}

fn saved_file() -> PathBuf {
    crate::paths::lotus_state_dir().join("remote-usage-last.json")
}

/// One snapshot at a time: each reads, changes and writes the saved file.
static ONE_AT_A_TIME: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Every connected machine's usage, plus the last numbers of machines not connected now. Blocking.
pub fn snapshot(transport: &RemoteTransport) -> Vec<MachineUsage> {
    let _one = ONE_AT_A_TIME.lock();
    let file = saved_file();
    let mut saved = crate::json::read_json::<HashMap<String, Saved>>(&file).unwrap_or_default();
    let now = crate::usage::now_ms();
    let mut out = Vec::new();
    let mut changed = false;
    for (target, socket) in transport.live_targets() {
        let key = label(&target);
        let answer = run_ssh_over_master(&target, &build_usage_script(), &socket)
            .map_err(|e| e.to_string())
            .and_then(|o| parse_host_answer(&String::from_utf8_lossy(&o.stdout)).map_err(|e| e.to_string()));
        let last = saved.remove(&key);
        if let Some((usage, fresh)) = interpret(&key, answer, last.clone(), now) {
            if let Some(fresh) = fresh {
                saved.insert(key, fresh);
                changed = true;
            } else if let Some(last) = last {
                saved.insert(key, last);
            }
            out.push(usage);
        } else {
            // No host there (any more): nothing to show, and nothing to remember.
            changed |= last.is_some();
        }
    }
    for (key, last) in &saved {
        if !out.iter().any(|m| &m.target == key) {
            out.push(not_connected(key, last));
        }
    }
    if changed {
        let _ = crate::json::write_json(&file, &saved);
    }
    out.sort_by(|a, b| a.machine.cmp(&b.machine));
    out
}

fn not_connected(key: &str, last: &Saved) -> MachineUsage {
    MachineUsage {
        target: key.to_string(),
        machine: last.machine.clone(),
        state: "not-connected",
        accounts: last.accounts.clone(),
        error: None,
        as_of_ms: Some(last.at_ms),
    }
}

/// One machine's answer → what to show, and what to remember when it was a good answer.
/// `None`: the machine runs no Lotus Host, so it is not shown at all.
fn interpret(
    key: &str,
    answer: Result<Option<(String, u16)>, String>,
    last: Option<Saved>,
    now: i64,
) -> Option<(MachineUsage, Option<Saved>)> {
    let stale = |state: &'static str, error: String| MachineUsage {
        target: key.to_string(),
        machine: last.as_ref().map_or_else(|| key.to_string(), |l| l.machine.clone()),
        state,
        accounts: last.as_ref().map(|l| l.accounts.clone()).unwrap_or_default(),
        error: Some(error),
        as_of_ms: last.as_ref().map(|l| l.at_ms),
    };
    let (payload, status) = match answer {
        Ok(Some(found)) => found,
        Ok(None) => return None,
        Err(e) => return Some((stale("error", e), None)),
    };
    if status == 404 {
        let name = last.as_ref().map_or(key, |l| l.machine.as_str());
        return Some((stale("old-host", format!("update Lotus Host on {name} to see its usage")), None));
    }
    if let Err(e) = check_status(status, &payload) {
        return Some((stale("error", e.to_string()), None));
    }
    match serde_json::from_str::<Envelope>(&payload) {
        Ok(mut env) => {
            // A row this desktop cannot draw (another host version) is dropped, not passed on to crash the popover.
            env.accounts.retain(|a| a["provider"].is_string() && a["account"].is_string() && a["windows"].is_array());
            let fresh = Saved { machine: env.machine.clone(), at_ms: now, accounts: env.accounts.clone() };
            let usage = MachineUsage {
                target: key.to_string(),
                machine: env.machine,
                state: "live",
                accounts: env.accounts,
                error: None,
                as_of_ms: None,
            };
            Some((usage, Some(fresh)))
        }
        Err(e) => Some((stale("error", format!("Lotus Host sent usage this Lotus cannot read ({e})")), None)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> String {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../contract/fixtures/usage-snapshot.json");
        std::fs::read_to_string(path).unwrap()
    }

    fn last() -> Saved {
        Saved { machine: "vps-1".into(), at_ms: 7, accounts: vec![serde_json::json!({ "account": "old" })] }
    }

    #[test]
    fn a_live_host_is_shown_and_remembered() {
        let (usage, fresh) = interpret("devbox-vps", Ok(Some((fixture(), 200))), None, 99).unwrap();
        assert_eq!((usage.state, usage.machine.as_str(), usage.accounts.len()), ("live", "vps-1", 3));
        assert_eq!(fresh.unwrap().at_ms, 99);
    }

    #[test]
    fn a_row_this_desktop_cannot_draw_is_dropped() {
        let body = r#"{"machine":"m","accounts":[{"provider":"claude","account":"a","windows":[]},{"account":"b"}]}"#;
        let (usage, _) = interpret("m", Ok(Some((body.into(), 200))), None, 1).unwrap();
        assert_eq!(usage.accounts.len(), 1);
    }

    #[test]
    fn a_machine_without_a_host_is_not_shown() {
        assert!(interpret("box", Ok(None), Some(last()), 99).is_none());
    }

    #[test]
    fn an_older_host_says_update_and_keeps_its_last_numbers() {
        let (usage, fresh) = interpret("devbox-vps", Ok(Some(("not found".into(), 404))), Some(last()), 99).unwrap();
        assert_eq!(usage.state, "old-host");
        assert_eq!(usage.error.as_deref(), Some("update Lotus Host on vps-1 to see its usage"));
        assert_eq!((usage.accounts.len(), usage.as_of_ms), (1, Some(7)));
        assert!(fresh.is_none());
    }

    #[test]
    fn a_failed_ask_is_an_error_with_the_last_numbers() {
        let (usage, _) = interpret("devbox-vps", Err("ssh: broken pipe".into()), Some(last()), 99).unwrap();
        assert_eq!((usage.state, usage.error.as_deref(), usage.as_of_ms), ("error", Some("ssh: broken pipe"), Some(7)));
        let (usage, _) = interpret("devbox-vps", Ok(Some(("".into(), 0))), None, 99).unwrap();
        assert_eq!((usage.state, usage.machine.as_str()), ("error", "devbox-vps"));
    }

    #[test]
    fn a_machine_not_connected_shows_its_last_numbers() {
        let usage = not_connected("devbox-vps", &last());
        assert_eq!((usage.state, usage.machine.as_str(), usage.as_of_ms), ("not-connected", "vps-1", Some(7)));
    }

    #[test]
    fn a_target_label_carries_user_and_port() {
        let t = SshToolTarget { host: "vps".into(), user: Some("me".into()), port: Some(2222) };
        assert_eq!(label(&t), "me@vps:2222");
    }
}
