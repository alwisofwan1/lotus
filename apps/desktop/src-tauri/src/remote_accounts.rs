//! Claude accounts on another machine (portable accounts, step 7): list, add, choose its default.
//! Same path as `remote_usage`: the machine's Lotus Host, over an SSH master already open — never a
//! new connection, which on a Cloudflare Access host would put an SSO prompt in front of the operator.

use serde_json::{json, Value};

use crate::cli_tools::run_ssh_over_master;
use crate::remote_lotus_host::{call_host, check_status, parse_host_answer};
use crate::remote_transport::RemoteTransport;

/// `target` is the key `usage_remote` reports (`user@host:port`).
fn ask(transport: &RemoteTransport, target: &str, path: &str, body: Value) -> Result<Value, String> {
    let (ssh, socket) = transport
        .live_targets()
        .into_iter()
        .find(|(t, _)| crate::remote_usage::label(t) == target)
        .ok_or_else(|| format!("not connected to {target} — open a terminal there first"))?;
    let answer = run_ssh_over_master(&ssh, &call_host(path, &body), &socket)
        .map_err(|e| e.to_string())
        .and_then(|o| parse_host_answer(&String::from_utf8_lossy(&o.stdout)).map_err(|e| e.to_string()));
    interpret(target, answer)
}

/// One host answer → its JSON body, or what to tell the operator.
fn interpret(target: &str, answer: Result<Option<(String, u16)>, String>) -> Result<Value, String> {
    let (payload, status) = answer?.ok_or_else(|| format!("{target} runs no Lotus Host"))?;
    match status {
        404 => return Err(format!("update Lotus Host on {target} to manage its accounts")),
        400 => {
            let error = serde_json::from_str::<Value>(&payload).ok().and_then(|v| v["error"].as_str().map(str::to_string));
            return Err(error.unwrap_or(payload));
        }
        _ => check_status(status, &payload).map_err(|e| e.to_string())?,
    }
    serde_json::from_str(&payload).map_err(|e| format!("Lotus Host on {target} sent an answer this Lotus cannot read ({e})"))
}

/// `{ machine, accounts: AccountView[] }`. Blocking.
pub fn list(transport: &RemoteTransport, target: &str) -> Result<Value, String> {
    ask(transport, target, "/v1/accounts/list", json!({}))
}

/// The new `AccountView`. Blocking.
pub fn create(transport: &RemoteTransport, target: &str, name: &str, isolated: bool) -> Result<Value, String> {
    ask(transport, target, "/v1/accounts/create", json!({ "name": name, "isolated": isolated }))
}

/// Deletes a Lotus-made account there, login included; the host refuses any other. Blocking.
pub fn remove(transport: &RemoteTransport, target: &str, id: &str) -> Result<(), String> {
    ask(transport, target, "/v1/accounts/remove", json!({ "id": id })).map(|_| ())
}

/// Which account that machine's own spawns run as; `None` goes back to its default login. Blocking.
pub fn set_default(transport: &RemoteTransport, target: &str, id: Option<&str>) -> Result<(), String> {
    ask(transport, target, "/v1/accounts/default", json!({ "provider": "claude", "id": id })).map(|_| ())
}

/// Moving that machine off ccs: `action` is `plan` (null without `~/.ccs`), `run` or `remove-mcp`. Blocking.
pub fn migrate_ccs(transport: &RemoteTransport, target: &str, action: &str) -> Result<Value, String> {
    ask(transport, target, "/v1/accounts/migrate-ccs", json!({ "action": action }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_good_answer_is_its_body() {
        let body = interpret("vps", Ok(Some((r#"{"machine":"m","accounts":[]}"#.into(), 200)))).unwrap();
        assert_eq!(body["machine"], "m");
    }

    #[test]
    fn a_refusal_says_why_in_the_hosts_words() {
        let err = interpret("vps", Ok(Some((r#"{"error":"an account named a already exists"}"#.into(), 400)))).unwrap_err();
        assert_eq!(err, "an account named a already exists");
    }

    #[test]
    fn an_older_host_or_none_is_named() {
        assert_eq!(interpret("vps", Ok(Some(("".into(), 404)))).unwrap_err(), "update Lotus Host on vps to manage its accounts");
        assert_eq!(interpret("vps", Ok(None)).unwrap_err(), "vps runs no Lotus Host");
        assert_eq!(interpret("vps", Err("ssh: closed".into())).unwrap_err(), "ssh: closed");
    }
}
