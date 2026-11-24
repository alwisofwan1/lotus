//! The Socket Mode connection loop: connect, acknowledge every envelope,
//! hand events on, reconnect as the protocol says. The decisions it makes
//! are the pure functions in `socket.rs`; this is only their wiring to the
//! network, smoke-tested with `examples/slack_probe.rs`.

use std::future::Future;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

use super::socket::{ack, after_disconnect, backoff, read_frame, Frame, Reconnect};
use super::web::open_socket_url;
use crate::secrets::Secret;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocketState {
    Connecting,
    /// Slack's count of open sockets for this Slack app; more than 1 means another app shares its events.
    Connected(Option<u64>),
    /// A failure; the loop tries again by itself.
    Retrying(String),
    /// Will not reconnect (app disabled, or asked to stop).
    Stopped(String),
}

/// Runs until `stop` becomes true or Slack disables the app. `on_event`
/// receives each `events_api` event (`payload.event`); it runs after the ack.
pub async fn run_socket_mode<F, Fut>(
    app_token: Secret,
    mut stop: watch::Receiver<bool>,
    mut on_state: impl FnMut(SocketState),
    mut on_event: F,
) where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut failures: u32 = 0;
    loop {
        if *stop.borrow() {
            return on_state(SocketState::Stopped("stopped".into()));
        }
        on_state(SocketState::Connecting);
        let outcome = tokio::select! {
            outcome = connect_once(&app_token, &mut on_state, &mut on_event, &mut failures) => outcome,
            _ = stop.changed() => return on_state(SocketState::Stopped("stopped".into())),
        };
        let wait = match outcome {
            Reconnect::Now => std::time::Duration::ZERO,
            Reconnect::After(wait) => wait,
            Reconnect::Stop(reason) => return on_state(SocketState::Stopped(reason)),
        };
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = stop.changed() => return on_state(SocketState::Stopped("stopped".into())),
        }
    }
}

async fn connect_once<F, Fut>(
    app_token: &Secret,
    on_state: &mut impl FnMut(SocketState),
    on_event: &mut F,
    failures: &mut u32,
) -> Reconnect
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    let url = match open_socket_url(app_token).await {
        Ok(url) => url,
        // A refused token will not fix itself.
        Err(e) if e.contains("invalid_auth") || e.contains("not_authed") || e.contains("token_revoked") => {
            return Reconnect::Stop(format!("Slack rejected the app token: {e}"));
        }
        Err(e) => return fail(on_state, e, failures),
    };
    let (ws, _) = match tokio_tungstenite::connect_async(url.as_str()).await {
        Ok(ok) => ok,
        Err(e) => return fail(on_state, format!("Socket Mode connection failed: {e}"), failures),
    };
    let (tx, rx) = ws.split();
    serve(rx, tx, on_state, on_event, failures).await
}

/// Reads one connection's frames until it ends. Events are handed to `on_event` one at a time,
/// in order, by a worker beside the reader: a slow event (it waits on GitHub) must not stop the
/// reader answering pings and acknowledging the envelopes behind it. Events still queued when the
/// connection ends are handled before this returns. Public so it is tested without a network.
pub async fn serve<R, W, E, F, Fut>(
    mut rx: R,
    mut tx: W,
    on_state: &mut impl FnMut(SocketState),
    on_event: &mut F,
    failures: &mut u32,
) -> Reconnect
where
    R: futures_util::Stream<Item = Result<Message, E>> + Unpin,
    W: futures_util::Sink<Message> + Unpin,
    W::Error: std::fmt::Display,
    E: std::fmt::Display,
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = ()>,
{
    let (queue, mut queued) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let reader = async move {
        while let Some(frame) = rx.next().await {
            let text = match frame {
                Ok(Message::Text(text)) => text,
                Ok(Message::Ping(p)) => {
                    let _ = tx.send(Message::Pong(p)).await;
                    continue;
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => continue,
                Err(e) => return fail(on_state, format!("Socket Mode connection dropped: {e}"), failures),
            };
            match read_frame(&text) {
                Frame::Hello { connections } => {
                    *failures = 0;
                    on_state(SocketState::Connected(connections));
                }
                Frame::Disconnect { reason } => return after_disconnect(&reason),
                Frame::Envelope { envelope_id, kind, event, .. } => {
                    // Ack first: Slack redelivers anything not acknowledged in time.
                    if let Err(e) = tx.send(Message::Text(ack(&envelope_id))).await {
                        return fail(on_state, format!("could not acknowledge: {e}"), failures);
                    }
                    if kind == "events_api" {
                        if let Some(event) = event {
                            let _ = queue.send(event);
                        }
                    }
                }
                Frame::Unknown => {}
            }
        }
        fail(on_state, "Socket Mode connection closed".into(), failures)
    };
    let worker = async {
        while let Some(event) = queued.recv().await {
            on_event(event).await;
        }
    };
    tokio::pin!(reader, worker);
    let outcome = tokio::select! {
        outcome = &mut reader => outcome,
        // Never first: the queue stays open while the reader holds its sender.
        _ = &mut worker => unreachable!("the event queue closed while the socket was read"),
    };
    // The reader is done and its sender with it: finish what it already acknowledged.
    worker.await;
    outcome
}

fn fail(on_state: &mut impl FnMut(SocketState), why: String, failures: &mut u32) -> Reconnect {
    let wait = backoff(*failures);
    *failures = failures.saturating_add(1);
    on_state(SocketState::Retrying(why));
    Reconnect::After(wait)
}
