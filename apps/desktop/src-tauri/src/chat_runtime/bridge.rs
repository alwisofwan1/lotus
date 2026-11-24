//! The chat-bridge process (`apps/desktop/scripts/chat-bridge/main.ts`): JSON-RPC 2.0 over stdio,
//! one line per message. One bridge serves every thread. Requests from Rust get a numeric id and a
//! timeout; the bridge's own requests (tool approvals) are answered later through `reply`.
//!
//! The bridge exits by itself when its stdin closes, so it cannot outlive Lotus.

use crate::no_window::NoWindow;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::oneshot;

use super::launch::LaunchCommand;

/// Must match `CHAT_BRIDGE_PROTOCOL_VERSION` in `scripts/chat-bridge/protocol.ts`.
const PROTOCOL_VERSION: u64 = 0;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const STDERR_TAIL_CHARS: usize = 4_000;

pub enum BridgeMessage {
    /// A translated ThreadEvent (`thread/event`). The bridge's own seq is dropped; the store
    /// numbers events.
    Event { thread_id: String, event: Value },
    /// The process is gone. Carries the end of its stderr.
    Exited { error: String },
}

type Pending = Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>;

pub struct Bridge {
    stdin: tokio::sync::Mutex<ChildStdin>,
    pending: Arc<Pending>,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    _child: Child,
}

impl Bridge {
    pub async fn spawn(
        launch: LaunchCommand,
        on_message: impl Fn(BridgeMessage) + Send + Sync + 'static,
    ) -> Result<Arc<Self>, String> {
        let mut child = Command::new(&launch.program)
            .no_window()
            .args(&launch.args)
            .envs(&launch.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                format!(
                    "could not start the chat bridge ({}): {e}",
                    launch.program.display()
                )
            })?;
        let stdin = child.stdin.take().ok_or("chat bridge has no stdin")?;
        let stdout = child.stdout.take().ok_or("chat bridge has no stdout")?;
        let stderr = child.stderr.take().ok_or("chat bridge has no stderr")?;

        let pending: Arc<Pending> = Arc::default();
        let alive = Arc::new(AtomicBool::new(true));
        let stderr_tail = Arc::new(Mutex::new(String::new()));

        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("{line}");
                let mut tail = tail.lock();
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > STDERR_TAIL_CHARS {
                    let cut = tail.len() - STDERR_TAIL_CHARS;
                    let cut = (cut..tail.len())
                        .find(|i| tail.is_char_boundary(*i))
                        .unwrap_or(0);
                    tail.drain(..cut);
                }
            }
        });

        let (reader_pending, reader_alive) = (Arc::clone(&pending), Arc::clone(&alive));
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                route_line(&line, &reader_pending, &on_message);
            }
            reader_alive.store(false, Ordering::SeqCst);
            for (_, waiter) in reader_pending.lock().drain() {
                let _ = waiter.send(Err("the chat bridge exited".into()));
            }
            // Let the stderr reader catch up so the tail holds the reason.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let tail = stderr_tail.lock().trim().to_string();
            let error = if tail.is_empty() {
                "the chat bridge exited".to_string()
            } else {
                format!("the chat bridge exited: {tail}")
            };
            on_message(BridgeMessage::Exited { error });
        });

        let bridge = Arc::new(Self {
            stdin: tokio::sync::Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            alive,
            _child: child,
        });
        let hello = bridge.request("initialize", json!({})).await?;
        let version = hello.get("protocolVersion").and_then(Value::as_u64);
        if version != Some(PROTOCOL_VERSION) {
            return Err(format!(
                "chat bridge speaks protocol {version:?}, Lotus expects {PROTOCOL_VERSION}"
            ));
        }
        if hello.get("claudePath").is_none_or(Value::is_null) {
            return Err("Claude Code was not found. Install it, or set LOTUS_CLAUDE_PATH.".into());
        }
        Ok(bridge)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        if let Err(error) = self
            .write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await
        {
            self.pending.lock().remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("the chat bridge exited".into()),
            Err(_) => {
                self.pending.lock().remove(&id);
                Err(format!(
                    "the chat bridge did not answer {method} in {}s",
                    REQUEST_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// Answers a request the bridge sent (a tool approval).
    pub async fn reply(&self, id: &str, result: Value) -> Result<(), String> {
        self.write(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    async fn write(&self, message: Value) -> Result<(), String> {
        if !self.is_alive() {
            return Err("the chat bridge is not running".into());
        }
        let mut line = message.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write to the chat bridge: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("write to the chat bridge: {e}"))
    }
}

fn route_line(line: &str, pending: &Pending, on_message: &impl Fn(BridgeMessage)) {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        eprintln!(
            "[chat-runtime] dropped a non-JSON line from the bridge: {}",
            line.chars().take(120).collect::<String>()
        );
        return;
    };
    let method = message.get("method").and_then(Value::as_str);
    match (method, message.get("id")) {
        // A reply to one of our requests.
        (None, Some(id)) => {
            let Some(waiter) = id.as_u64().and_then(|id| pending.lock().remove(&id)) else {
                return;
            };
            let result = match message.get("error") {
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("chat bridge error")
                    .to_string()),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = waiter.send(result);
        }
        (Some("thread/event"), _) => {
            let params = message.get("params");
            let thread_id = params
                .and_then(|p| p.get("threadId"))
                .and_then(Value::as_str);
            let event = params
                .and_then(|p| p.get("event"))
                .filter(|e| e.get("type").is_some_and(Value::is_string));
            if let (Some(thread_id), Some(event)) = (thread_id, event) {
                on_message(BridgeMessage::Event {
                    thread_id: thread_id.to_string(),
                    event: event.clone(),
                });
            }
        }
        // `interaction/request` arrives right after the `interaction/requested` event that the UI
        // answers; `thread/ended` right after `session/ended`; `thread/raw` is for scripts only.
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_replies_and_events_and_ignores_the_rest() {
        let pending: Pending = Mutex::default();
        let (tx, mut rx) = oneshot::channel();
        pending.lock().insert(7, tx);
        let seen = Mutex::new(Vec::new());
        let on = |m: BridgeMessage| {
            if let BridgeMessage::Event { thread_id, event } = m {
                seen.lock()
                    .push((thread_id, event["type"].as_str().unwrap().to_string()));
            }
        };
        route_line(
            r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#,
            &pending,
            &on,
        );
        route_line(
            r#"{"method":"thread/event","params":{"threadId":"t","seq":3,"at":1,"event":{"type":"turn/started"}}}"#,
            &pending,
            &on,
        );
        route_line(
            r#"{"method":"thread/event","params":{"threadId":"t","event":{"no":"type"}}}"#,
            &pending,
            &on,
        );
        route_line(
            r#"{"id":"interaction-1","method":"interaction/request","params":{}}"#,
            &pending,
            &on,
        );
        route_line("not json", &pending, &on);
        assert_eq!(rx.try_recv().unwrap(), Ok(json!({"ok": true})));
        assert_eq!(
            *seen.lock(),
            vec![("t".to_string(), "turn/started".to_string())]
        );
    }

    #[test]
    fn an_error_reply_rejects_the_request() {
        let pending: Pending = Mutex::default();
        let (tx, mut rx) = oneshot::channel();
        pending.lock().insert(1, tx);
        route_line(
            r#"{"id":1,"error":{"code":-32602,"message":"bad params"}}"#,
            &pending,
            &|_| {},
        );
        assert_eq!(rx.try_recv().unwrap(), Err("bad params".to_string()));
    }
}
