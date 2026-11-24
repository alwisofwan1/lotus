//! Diagnostic probe for ADR-0038's riskiest assumption: that Socket Mode
//! delivers USER-token event subscriptions to an app with no bot user.
//! Prints what arrives; never prints a token. Ctrl-C to stop.
//!
//! ```sh
//! cargo run -p lotus-automation --example slack_probe
//! ```
//! It asks for both tokens with hidden input (or reads SLACK_APP_TOKEN /
//! SLACK_USER_TOKEN from the environment if set).
//! Then, in a channel you are in: post a message, add a 👀 reaction.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

async fn slack(token: &str, method: &str, form: &[(&str, &str)]) -> Value {
    let res = reqwest::Client::new()
        .post(format!("https://slack.com/api/{method}"))
        .bearer_auth(token)
        .form(form)
        .send()
        .await
        .unwrap_or_else(|e| panic!("{method}: {e}"));
    res.json::<Value>().await.unwrap_or_else(|e| panic!("{method}: unreadable reply: {e}"))
}

/// Prompts on the terminal with echo off, so the token never shows on screen or in scrollback.
fn ask_hidden(prompt: &str) -> String {
    use std::io::Write;
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    let stty = |arg: &str| {
        let _ = std::process::Command::new("stty").arg(arg).stdin(std::process::Stdio::inherit()).status();
    };
    stty("-echo");
    let mut line = String::new();
    let _ = std::io::stdin().read_line(&mut line);
    stty("echo");
    eprintln!();
    line
}

/// Reads a token from the environment (or asks for it), forgiving pasted whitespace and quotes. On a wrong kind it
/// names what it looks like — from the public prefix only, never the secret part.
fn token(var: &str, prefix: &str, where_: &str) -> String {
    let raw = match std::env::var(var) {
        Ok(v) if !v.trim().is_empty() => v,
        _ => ask_hidden(&format!("Paste {prefix}... token ({where_}), then Enter (hidden): ")),
    };
    let t = raw.trim().trim_matches(|c| c == '"' || c == '\'').trim().to_string();
    if t.starts_with(prefix) {
        return t;
    }
    let looks_like = match t.split('-').next().unwrap_or("") {
        "" if t.is_empty() => "nothing (empty)".to_string(),
        "xapp" => "an app-level token (xapp-)".into(),
        "xoxp" => "a user token (xoxp-)".into(),
        "xoxb" => "a BOT token (xoxb-)".into(),
        "xoxe" => "a refresh/rotating token (xoxe-)".into(),
        _ if t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()) => {
            "a 32-hex secret — the Signing Secret or Client Secret, not a token".into()
        }
        _ => format!("something else ({} characters, no token prefix)", t.len()),
    };
    eprintln!("{var} should start with {prefix}, but what was pasted looks like {looks_like}.");
    eprintln!("Get it from: {where_}");
    std::process::exit(2);
}

fn clip(text: &str) -> String {
    let t: String = text.chars().take(90).collect();
    t.replace('\n', " ⏎ ")
}

#[tokio::main]
async fn main() {
    let app = token("SLACK_APP_TOKEN", "xapp-", "Basic Information → App-Level Tokens (scope connections:write)");
    let user = token("SLACK_USER_TOKEN", "xoxp-", "OAuth & Permissions → User OAuth Token");

    let me = slack(&user, "auth.test", &[]).await;
    println!("[1] auth.test ok={} user_id={} team={}", me["ok"], me["user_id"], me["team"]);
    if me["ok"] != true {
        println!("    error={}", me["error"]);
        return;
    }

    let open = slack(&app, "apps.connections.open", &[]).await;
    println!("[2] apps.connections.open ok={} error={}", open["ok"], open["error"]);
    let Some(url) = open["url"].as_str() else { return };

    let (ws, _) = tokio_tungstenite::connect_async(url).await.expect("websocket connect");
    println!("[3] websocket connected. Now post a message and add a 👀 reaction in a channel you are in.");
    let (mut tx, mut rx) = ws.split();
    let mut seen = 0usize;

    while let Some(frame) = rx.next().await {
        let text = match frame {
            Ok(Message::Text(t)) => t,
            Ok(Message::Ping(p)) => {
                let _ = tx.send(Message::Pong(p)).await;
                continue;
            }
            Ok(Message::Close(c)) => {
                println!("[x] closed: {c:?}");
                break;
            }
            Ok(_) => continue,
            Err(e) => {
                println!("[x] websocket error: {e}");
                break;
            }
        };
        let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        match v["type"].as_str().unwrap_or("?") {
            "hello" => println!("[hello] connections={} ", v["num_connections"]),
            "disconnect" => {
                println!("[disconnect] reason={}", v["reason"]);
                break;
            }
            kind => {
                if let Some(id) = v["envelope_id"].as_str() {
                    let _ = tx.send(Message::Text(json!({ "envelope_id": id }).to_string())).await;
                }
                let e = &v["payload"]["event"];
                seen += 1;
                println!(
                    "[event #{seen}] envelope={kind} event_id={} type={} subtype={} channel={} user={} ts={} thread_ts={} reaction={} text=\"{}\"",
                    v["payload"]["event_id"],
                    e["type"],
                    e["subtype"],
                    e["channel"].as_str().or(e["item"]["channel"].as_str()).unwrap_or("-"),
                    e["user"],
                    e["ts"].as_str().or(e["item"]["ts"].as_str()).unwrap_or("-"),
                    e["thread_ts"],
                    e["reaction"],
                    clip(e["text"].as_str().unwrap_or("")),
                );
            }
        }
    }
}
