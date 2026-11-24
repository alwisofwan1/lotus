//! Reads a host's `/v1/cell-conversation/stream` (SSE) and keeps reading across drops.

use std::time::Duration;

use super::HostLink;

/// One server-sent event. `id` is `<bootId>:<cursor>`, sent back as `Last-Event-ID` on reconnect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub id: Option<String>,
    pub data: String,
}

/// Splits a byte stream into events. Bytes, not `str`: a chunk can end inside a UTF-8 character.
#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    id: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let raw: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() || !self.event.is_empty() {
                    let event = std::mem::take(&mut self.event);
                    out.push(SseEvent {
                        event: if event.is_empty() { "message".into() } else { event },
                        id: self.id.take(),
                        data: self.data.join("\n"),
                    });
                    self.data.clear();
                }
                continue;
            }
            // `: ping` heartbeats are comments; they only prove the link is alive.
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line, ""),
            };
            match field {
                "event" => self.event = value.to_string(),
                "data" => self.data.push(value.to_string()),
                "id" => self.id = Some(value.to_string()),
                _ => {}
            }
        }
        out
    }
}

/// What the follower tells its caller: an event, or that it is reconnecting (for a banner).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamSignal {
    Event(SseEvent),
    Reconnecting { attempt: u32, reason: String },
}

/// Why following stopped. Anything else is retried, so the caller stops it by aborting the task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEnd {
    /// The host said `ended`: the cell is gone.
    Ended,
    /// The host does not know this pane (404).
    Unknown,
}

/// 0.5 s doubling to 30 s, scaled by `jitter` in [0, 1) to 50–100 % so clients do not reconnect in step.
pub fn backoff(attempt: u32, jitter: f64) -> Duration {
    let base = (500u64 << attempt.min(6)).min(30_000) as f64;
    Duration::from_millis((base * (0.5 + jitter.clamp(0.0, 1.0) * 0.5)) as u64)
}

/// Follow one cell's stream until it ends, resuming from `last_id` after every drop.
///
/// A `truncated` event is passed on: the caller reloads `/v1/cell-conversation` and keeps going.
/// `idle` is 45 s in use (three missed 15 s heartbeats: dead even if TCP has not noticed).
pub async fn follow(
    link: &HostLink,
    pane_id: &str,
    mut last_id: Option<String>,
    idle: Duration,
    mut on_signal: impl FnMut(StreamSignal),
) -> StreamEnd {
    let mut attempt: u32 = 0;
    loop {
        let reason = match link.open_stream(pane_id, last_id.as_deref()).await {
            Ok(resp) if resp.status().as_u16() == 404 => return StreamEnd::Unknown,
            Ok(resp) if resp.status().is_success() => {
                attempt = 0;
                let mut resp = resp;
                let mut parser = SseParser::default();
                loop {
                    match tokio::time::timeout(idle, resp.chunk()).await {
                        Ok(Ok(Some(bytes))) => {
                            for ev in parser.push(&bytes) {
                                if ev.id.is_some() {
                                    last_id.clone_from(&ev.id);
                                }
                                let ended = ev.event == "ended";
                                on_signal(StreamSignal::Event(ev));
                                if ended {
                                    return StreamEnd::Ended;
                                }
                            }
                        }
                        Ok(Ok(None)) => break "the host closed the stream".to_string(),
                        Ok(Err(e)) => break format!("stream read failed: {e}"),
                        Err(_) => break format!("no heartbeat for {} s", idle.as_secs()),
                    }
                }
            }
            Ok(resp) => format!("the host answered {}", resp.status()),
            Err(e) => e.to_string(),
        };
        attempt += 1;
        on_signal(StreamSignal::Reconnecting { attempt, reason });
        tokio::time::sleep(backoff(attempt - 1, rand::random::<f64>())).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_events_across_chunk_and_utf8_boundaries() {
        let mut p = SseParser::default();
        let frame = "event: hello\ndata: {\"a\":1}\n\n: ping\n\nid: b:3\nevent: conversation\ndata: é\n\n";
        let bytes = frame.as_bytes();
        let cut = frame.find('é').unwrap() + 1; // inside the two-byte é
        let mut got = p.push(&bytes[..cut]);
        got.extend(p.push(&bytes[cut..]));
        assert_eq!(
            got,
            vec![
                SseEvent { event: "hello".into(), id: None, data: "{\"a\":1}".into() },
                SseEvent { event: "conversation".into(), id: Some("b:3".into()), data: "é".into() },
            ]
        );
    }

    #[test]
    fn backoff_doubles_to_a_cap_and_never_drops_below_half() {
        assert_eq!(backoff(0, 1.0), Duration::from_millis(500));
        assert_eq!(backoff(1, 1.0), Duration::from_millis(1000));
        assert_eq!(backoff(20, 1.0), Duration::from_secs(30));
        assert_eq!(backoff(20, 0.0), Duration::from_secs(15));
    }
}
