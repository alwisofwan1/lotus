use std::time::Duration;

use lotus_automation::slack::socket::{ack, after_disconnect, backoff, read_frame, Frame, Reconnect};
use serde_json::json;

#[test]
fn an_events_envelope_is_read_with_its_event_and_ids() {
    let raw = json!({
        "envelope_id": "57d6a792", "type": "events_api", "accepts_response_payload": false,
        "payload": { "event_id": "Ev0C47BGUWFK", "event": { "type": "message", "text": "hi" } }
    });
    let Frame::Envelope { envelope_id, kind, event_id, event } = read_frame(&raw.to_string()) else { panic!() };
    assert_eq!(envelope_id, "57d6a792");
    assert_eq!(kind, "events_api");
    assert_eq!(event_id.as_deref(), Some("Ev0C47BGUWFK"));
    assert_eq!(event.unwrap()["text"], "hi");
}

#[test]
fn every_envelope_is_acknowledged_with_its_id_only() {
    let ack: serde_json::Value = serde_json::from_str(&ack("57d6a792")).unwrap();
    assert_eq!(ack, json!({ "envelope_id": "57d6a792" }));
}

#[test]
fn hello_and_disconnect_frames_are_recognised() {
    assert_eq!(read_frame(r#"{"type":"hello","num_connections":2}"#), Frame::Hello { connections: Some(2) });
    assert_eq!(read_frame(r#"{"type":"hello"}"#), Frame::Hello { connections: None });
    assert_eq!(
        read_frame(r#"{"type":"disconnect","reason":"refresh_requested"}"#),
        Frame::Disconnect { reason: "refresh_requested".into() }
    );
    assert_eq!(read_frame("not json"), Frame::Unknown);
}

#[test]
fn a_routine_disconnect_reconnects_at_once_and_a_disabled_app_stops() {
    assert_eq!(after_disconnect("refresh_requested"), Reconnect::Now);
    assert_eq!(after_disconnect("warning"), Reconnect::Now);
    assert!(matches!(after_disconnect("link_disabled"), Reconnect::Stop(reason) if reason.contains("Socket Mode")));
}

#[test]
fn failures_back_off_exponentially_up_to_a_minute() {
    assert_eq!(backoff(0), Duration::from_secs(1));
    assert_eq!(backoff(1), Duration::from_secs(2));
    assert_eq!(backoff(3), Duration::from_secs(8));
    assert_eq!(backoff(10), Duration::from_secs(60));
    assert_eq!(backoff(u32::MAX), Duration::from_secs(60));
}

/// A slow event (it waits on GitHub) must not stop the socket: the envelopes behind it are
/// acknowledged and a ping answered while it runs, and events are still handled in order.
#[tokio::test]
async fn a_slow_event_does_not_hold_up_acks_and_pings_behind_it() {
    use std::sync::{Arc, Mutex};
    use tokio_tungstenite::tungstenite::Message;

    let envelope = |id: &str, ts: &str| {
        Ok::<_, String>(Message::Text(
            serde_json::json!({ "type": "events_api", "envelope_id": id,
                "payload": { "event": { "type": "message", "ts": ts } } })
            .to_string(),
        ))
    };
    let frames = vec![envelope("e1", "1"), envelope("e2", "2"), Ok(Message::Ping(vec![7]))];
    let sent = Arc::new(Mutex::new(Vec::<Message>::new()));
    let pong_seen = Arc::new(tokio::sync::Semaphore::new(0));
    let sink = {
        let (sent, pong_seen) = (Arc::clone(&sent), Arc::clone(&pong_seen));
        futures_util::sink::unfold((), move |(), message: Message| {
            let (sent, pong_seen) = (Arc::clone(&sent), Arc::clone(&pong_seen));
            async move {
                if matches!(message, Message::Pong(_)) {
                    pong_seen.add_permits(1);
                }
                sent.lock().unwrap().push(message);
                Ok::<_, String>(())
            }
        })
    };
    let handled = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut on_event = {
        let (handled, pong_seen) = (Arc::clone(&handled), Arc::clone(&pong_seen));
        move |event: serde_json::Value| {
            let (handled, pong_seen) = (Arc::clone(&handled), Arc::clone(&pong_seen));
            async move {
                let ts = event["ts"].as_str().unwrap_or_default().to_string();
                if ts == "1" {
                    // Held until the ping behind it is answered: a reader stuck here never answers.
                    pong_seen.acquire().await.unwrap().forget();
                }
                handled.lock().unwrap().push(ts);
            }
        }
    };
    let (mut failures, mut on_state) = (0u32, |_: lotus_automation::slack::client::SocketState| {});

    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        lotus_automation::slack::client::serve(
            Box::pin(futures_util::stream::iter(frames)),
            Box::pin(sink),
            &mut on_state,
            &mut on_event,
            &mut failures,
        ),
    )
    .await
    .expect("the reader waited for a slow event");

    assert_eq!(*handled.lock().unwrap(), vec!["1".to_string(), "2".to_string()], "in order, none dropped");
    let sent = sent.lock().unwrap();
    assert_eq!(sent.iter().filter(|m| matches!(m, Message::Text(t) if t.contains("envelope_id"))).count(), 2);
}
