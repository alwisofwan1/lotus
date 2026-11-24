//! The Slack threads a review was asked in, read fresh from Slack when the run starts
//! (ADR-0052 §8). The listener's saved replies (`review_feedback`) miss replies written before
//! Lotus tracked the thread, keep the text a message had before it was edited, drop files and cut
//! long messages; Slack itself has none of those gaps. Lotus reads as the user: the agent never
//! holds a Slack token.

use crate::registry::BoxFuture;
use crate::slack::web::ThreadMessage;

/// Reads one Slack thread, parent first. The host's adapter uses the running Slack session.
pub trait ThreadReader: Send + Sync {
    fn read(&self, channel: &str, thread_ts: &str) -> BoxFuture<Result<Vec<ThreadMessage>, String>>;
}

/// Longest text kept from one message; Slack itself caps a message at 40 000 characters.
const MAX_MESSAGE_CHARS: usize = 8_000;
/// Most text the threads add to a prompt. Over it, the oldest replies go first; each thread's
/// parent (the request) stays.
const MAX_TOTAL_CHARS: usize = 60_000;

/// The threads as prompt text: one block per thread, one line per message, oldest first.
/// `since_s`: when this automation's last review of the PR was sent (Unix seconds); every message
/// after it is marked NEW, so a later round reads what changed first.
pub fn render(threads: &[(String, String, Vec<ThreadMessage>)], since_s: Option<i64>) -> String {
    let mut blocks: Vec<(String, Vec<String>)> = threads
        .iter()
        .map(|(channel, thread_ts, messages)| {
            (format!("Slack thread {channel}/{thread_ts}, oldest first:"), messages.iter().map(|m| line(m, since_s)).collect())
        })
        .collect();
    let size = |blocks: &[(String, Vec<String>)]| blocks.iter().map(|(h, l)| h.len() + l.iter().map(|l| l.len() + 1).sum::<usize>()).sum::<usize>();
    let mut dropped = 0;
    while size(&blocks) > MAX_TOTAL_CHARS {
        // The thread with the most replies loses its oldest reply (never the parent at index 0).
        let Some((_, lines)) = blocks.iter_mut().filter(|(_, l)| l.len() > 1).max_by_key(|(_, l)| l.len()) else { break };
        lines.remove(1);
        dropped += 1;
    }
    let mut out = String::new();
    if dropped > 0 {
        out.push_str(&format!("({dropped} older replies left out for length.)\n"));
    }
    for (head, lines) in blocks {
        out.push_str(&head);
        out.push('\n');
        for l in lines {
            out.push_str(&l);
            out.push('\n');
        }
    }
    out
}

fn line(m: &ThreadMessage, since_s: Option<i64>) -> String {
    let secs = m.ts.split('.').next().and_then(|s| s.parse::<i64>().ok()).unwrap_or(0);
    let new = if since_s.is_some_and(|since| secs > since) { "NEW " } else { "" };
    let when = chrono::DateTime::from_timestamp(secs, 0).map(|t| t.format("%Y-%m-%d %H:%M UTC").to_string()).unwrap_or_default();
    let who = match (&m.name, &m.user) {
        (Some(name), Some(id)) => format!("{name} ({id})"),
        (Some(name), None) => name.clone(),
        (None, Some(id)) => id.clone(),
        (None, None) => "someone".into(),
    };
    let mut text: String = m.text.chars().take(MAX_MESSAGE_CHARS).collect();
    if text.len() < m.text.len() {
        text.push_str(" […]");
    }
    let mut out = format!("{new}[{when}] {who}: {}", text.replace('\n', "\n    "));
    if m.edited {
        out.push_str(" (edited)");
    }
    if !m.files.is_empty() {
        out.push_str(&format!(" [files: {}]", m.files.join(", ")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(ts: &str, text: &str) -> ThreadMessage {
        ThreadMessage { ts: ts.into(), user: Some("U1".into()), name: Some("Budi".into()), text: text.into(), edited: false, files: vec![] }
    }

    #[test]
    fn a_thread_reads_with_names_times_edits_and_files() {
        let edited = ThreadMessage { edited: true, files: vec!["trace.log".into()], ..msg("1791400060.000200", "fixed in abc\nsee log") };
        let anon = ThreadMessage { name: None, ..msg("1791400120.000300", "ok") };
        let text = render(&[("C1".into(), "1791400000.000100".into(), vec![msg("1791400000.000100", "please review"), edited, anon])], Some(1791400100));
        assert!(text.starts_with("Slack thread C1/1791400000.000100, oldest first:\n"), "{text}");
        assert!(text.contains("UTC] Budi (U1): please review\n"), "{text}");
        assert!(text.contains("Budi (U1): fixed in abc\n    see log (edited) [files: trace.log]\n"), "{text}");
        assert!(text.contains("NEW [") && text.contains("UTC] U1: ok\n"), "{text}");
        assert!(text.contains("\n[") , "older messages are not marked: {text}");
    }

    #[test]
    fn a_huge_thread_keeps_its_request_and_newest_replies() {
        let mut messages = vec![msg("1.0", "the request")];
        messages.extend((0..40).map(|i| msg(&format!("{}.0", i + 2), &format!("reply {i} {}", "x".repeat(3_000)))));
        let text = render(&[("C1".into(), "1.0".into(), messages)], None);
        assert!(text.len() <= MAX_TOTAL_CHARS + 200, "{}", text.len());
        assert!(text.contains("the request"));
        assert!(text.contains("reply 39 "));
        assert!(!text.contains("reply 0 "));
        assert!(text.starts_with("("), "says replies were left out");
    }
}
