//! Rolling output tail buffer for MCP sidecar tools, pane title generation,
//! readiness checks, and frontend agent detection.

use std::collections::VecDeque;
use std::time::Instant;

use serde::Serialize;

/// Per-session rolling output buffer used by the MCP sidecar's
/// `lotus_read_cell_output` / `lotus_wait_cell_idle` tools, and — the constraint that
/// sizes it — by the mobile poller's `/api/fleet/scrollback` reads.
///
/// **256KB, and the number is measured rather than chosen** (Fase 2 of
/// `plans/session-history-hardening`, from `issues/01`'s answer).
///
/// A watching client polls every `POLL_MS`, so anything a pane emits faster than
/// `ring ÷ poll` is gone before it can be read. At the previous 64KB with a 400ms poll
/// that ceiling was ~160KB/s, and a rate ladder against a live pane put the cliff exactly
/// there: 100KB/s clean, 176KB/s losing 65 gaps and 521,115 bytes in thirty seconds,
/// 265KB/s losing 3,207,378. Across the measured window a quarter of all output never
/// reached the client.
///
/// The same ladder showed this machine's PTY path sustaining ~794KB/s, so the ceiling has
/// to clear that. 256KB against the poll's new 250ms gives ~1MB/s — about 30% headroom
/// over the fastest output actually observed.
///
/// Cost is bounded and worth stating: `MAX_SESSIONS_TOTAL` is 128, so the worst case grows
/// from 8MB to 32MB of ring across every session on the machine. A board with 128 live
/// panes is the documented ceiling rather than a normal day.
///
/// **This does not make gaps impossible**, only rare — a burst past ~1MB/s still outruns
/// it. What a client should do when that happens is `issues/03`'s remaining question, and
/// answering it needs a screen model this app does not have yet.
pub const OUTPUT_TAIL_BYTES: usize = 256 * 1024;

/// Fixed-size ring that keeps only the last [`OUTPUT_TAIL_BYTES`] bytes of a
/// PTY session's output. Cheap to append to and cheap to snapshot.
#[derive(Debug)]
pub struct OutputTail {
    pub bytes: VecDeque<u8>,
    pub total_bytes_seen: u64,
    pub last_write_at: Option<Instant>,
    pub created_at: Instant,
    pub detected_agent: Option<String>,
}

impl Default for OutputTail {
    fn default() -> Self {
        Self {
            bytes: VecDeque::new(),
            total_bytes_seen: 0,
            last_write_at: None,
            created_at: Instant::now(),
            detected_agent: None,
        }
    }
}

/// Banner-substring → agent-name table. Order matters when banners overlap;
/// more specific patterns must come before generic prefixes. All matching is
/// case-sensitive against raw PTY output because CLI banners are stable.
/// Mirrors `detectProviderLaunchBanner` in fleet-output-tap.ts; Pi and Antigravity come first
/// because their footers name another vendor's model.
const AGENT_BANNERS: &[(&str, &str)] = &[
    ("Pi can explain its own features", "pi"),
    ("Antigravity CLI", "antigravity"),
    ("OpenAI Codex", "codex"),
    ("Ask Codex to do anything", "codex"),
    ("Welcome to Claude Code", "claude"),
    ("Claude Code v", "claude"),
    ("Claude Code", "claude"),
    ("claude.ai/code", "claude"),
    ("Gemini CLI", "gemini"),
    ("@google/gemini-cli", "gemini"),
    ("Cursor CLI", "cursor"),
    ("OpenCode", "opencode"),
    ("sst/opencode", "opencode"),
    ("Aider v", "aider"),
    ("GitHub Copilot CLI", "copilot"),
    ("Grok Build", "grok"),
];

fn detect_agent_in_tail(tail: &str) -> Option<&'static str> {
    AGENT_BANNERS
        .iter()
        .find(|(needle, _)| tail.contains(needle))
        .map(|(_, agent)| *agent)
}

impl OutputTail {
    pub fn push(&mut self, data: &str) {
        let len = data.len();
        self.bytes.extend(data.as_bytes().iter().copied());
        self.total_bytes_seen = self.total_bytes_seen.saturating_add(len as u64);
        self.last_write_at = Some(Instant::now());
        while self.bytes.len() > OUTPUT_TAIL_BYTES {
            self.bytes.pop_front();
        }
        if self.detected_agent.is_none() {
            if let Some(agent) = detect_agent_in_tail(data) {
                self.detected_agent = Some(agent.to_string());
            } else if self.total_bytes_seen <= 32_768 {
                let scan = self.snapshot_tail(8192);
                if let Some(agent) = detect_agent_in_tail(&scan) {
                    self.detected_agent = Some(agent.to_string());
                }
            }
        }
    }

    /// Push raw bytes from the PTY IPC channel. Uses lossy UTF-8 decode only
    /// for banner-string detection; display decoding is handled by xterm.
    pub fn push_bytes(&mut self, data: &[u8]) {
        let len = data.len();
        self.bytes.extend(data.iter().copied());
        self.total_bytes_seen = self.total_bytes_seen.saturating_add(len as u64);
        self.last_write_at = Some(Instant::now());
        while self.bytes.len() > OUTPUT_TAIL_BYTES {
            self.bytes.pop_front();
        }
        if self.detected_agent.is_none() && self.total_bytes_seen <= 32_768 {
            let scan = String::from_utf8_lossy(data);
            if let Some(agent) = detect_agent_in_tail(&scan) {
                self.detected_agent = Some(agent.to_string());
            } else {
                let snapshot = self.snapshot_tail(8192);
                if let Some(agent) = detect_agent_in_tail(&snapshot) {
                    self.detected_agent = Some(agent.to_string());
                }
            }
        }
    }

    pub fn snapshot_tail(&self, max_bytes: usize) -> String {
        let len = self.bytes.len().min(max_bytes);
        let skip = self.bytes.len() - len;
        let raw: Vec<u8> = self.bytes.iter().skip(skip).copied().collect();
        // The slice may begin mid-ANSI-sequence. We do NOT strip orphaned CSI
        // bytes here: the previous heuristic (skip_orphaned_ansi_head) matched
        // any leading digit/semicolon run terminated by an ANSI final byte,
        // which false-positives on legitimate plain text (e.g. "30m to go",
        // ISO timestamps, line numbers). Losing real content is worse than
        // briefly rendering a malformed escape — xterm tolerates the latter.
        String::from_utf8_lossy(&raw).into_owned()
    }

    /// Bytes `[offset, offset + len)` of the session's whole output stream, `offset` clamped up
    /// to the oldest byte the ring still holds. Copies only that range, not the ring.
    pub fn read_range(&self, offset: u64, len: usize) -> (u64, Vec<u8>) {
        let held = self.bytes.len();
        let available_start = self.total_bytes_seen.saturating_sub(held as u64);
        let start = offset.max(available_start);
        let rel = (start - available_start).min(held as u64) as usize;
        let end = rel.saturating_add(len).min(held);
        (start, self.bytes.range(rel..end).copied().collect())
    }

    /// [`Self::read_range`] decoded as text, with both edges on character boundaries: a
    /// character cut at the end is left for the next read, and continuation bytes at the
    /// start are skipped (the returned offset moves past them). So `offset + text.len()` is
    /// always the next byte to ask for — a lossy `�` there would be 3 bytes standing in for
    /// 1–3 real ones and push the caller's next read off a boundary.
    pub fn read_text(&self, offset: u64, len: usize) -> (u64, String) {
        let (start, bytes) = self.read_range(offset, len);
        let lead = bytes
            .iter()
            .take(3)
            .take_while(|b| is_continuation(**b))
            .count();
        let body = &bytes[lead..];
        let body = &body[..body.len() - unfinished_tail(body)];
        (
            start + lead as u64,
            String::from_utf8_lossy(body).into_owned(),
        )
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn metrics(&self) -> PtyOutputMetrics {
        let now = Instant::now();
        let idle_ms = self
            .last_write_at
            .and_then(|t| now.checked_duration_since(t))
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let age_ms = now
            .checked_duration_since(self.created_at)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let detected_agent = self.detected_agent.clone().or_else(|| {
            let snapshot = self.snapshot_tail(8192);
            detect_agent_in_tail(&snapshot).map(str::to_string)
        });
        PtyOutputMetrics {
            total_bytes: self.total_bytes_seen,
            buffer_len: self.bytes.len() as u64,
            idle_ms,
            age_ms,
            has_output: self.last_write_at.is_some(),
            detected_agent,
        }
    }
}

fn is_continuation(b: u8) -> bool {
    b & 0xC0 == 0x80
}

/// How many trailing bytes are the start of a UTF-8 character that is not complete yet.
pub fn unfinished_tail(bytes: &[u8]) -> usize {
    for back in 1..=bytes.len().min(3) {
        let b = bytes[bytes.len() - back];
        if is_continuation(b) {
            continue;
        }
        let need = match b {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => 1,
        };
        return if need > back { back } else { 0 };
    }
    0
}

/// Lightweight, IPC-friendly snapshot of a PTY session's output activity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOutputMetrics {
    pub total_bytes: u64,
    pub buffer_len: u64,
    pub idle_ms: u64,
    pub age_ms: u64,
    pub has_output: bool,
    pub detected_agent: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_tail_starts_with_no_output() {
        let tail = OutputTail::default();
        let m = tail.metrics();
        assert_eq!(m.total_bytes, 0);
        assert_eq!(m.buffer_len, 0);
        assert_eq!(m.idle_ms, 0);
        assert!(!m.has_output);
    }

    #[test]
    fn output_tail_tracks_total_across_eviction() {
        let mut tail = OutputTail::default();
        // Sized from the constant rather than a literal: this asserts the *relationship*
        // between total-seen and buffer-len across eviction, and a resize of the ring
        // (Fase 2 took it from 64KB to 256KB) must not read as a broken invariant.
        let chunk = "x".repeat(8 * 1024);
        let pushes = (OUTPUT_TAIL_BYTES / chunk.len()) * 2;
        for _ in 0..pushes {
            tail.push(&chunk);
        }
        let m = tail.metrics();
        assert_eq!(m.total_bytes, (pushes * chunk.len()) as u64);
        assert_eq!(m.buffer_len, OUTPUT_TAIL_BYTES as u64);
        assert!(m.has_output);
    }

    #[test]
    fn output_tail_detects_grok_footer() {
        let mut tail = OutputTail::default();
        tail.push("\x1b[2m Grok Build  1.0.77 [stable]\x1b[0m\n");
        assert_eq!(tail.metrics().detected_agent.as_deref(), Some("grok"));
    }

    #[test]
    fn output_tail_detects_codex_banner() {
        let mut tail = OutputTail::default();
        tail.push("\x1b[33m>_ OpenAI Codex (v0.128.0)\x1b[0m\n");
        let m = tail.metrics();
        assert_eq!(m.detected_agent.as_deref(), Some("codex"));
    }

    #[test]
    fn output_tail_detects_claude_banner_in_tail() {
        let mut tail = OutputTail::default();
        tail.push("user@host % ");
        tail.push("Welcome to Claude Code, the official CLI from Anthropic\n");
        let m = tail.metrics();
        assert_eq!(m.detected_agent.as_deref(), Some("claude"));
    }

    #[test]
    fn output_tail_detects_current_claude_code_banner() {
        let mut tail = OutputTail::default();
        tail.push("Claude Code v2.1.181\nHaiku 4.5 · Claude Team\n");
        let m = tail.metrics();
        assert_eq!(m.detected_agent.as_deref(), Some("claude"));
    }

    #[test]
    fn output_tail_detects_no_agent_for_plain_shell() {
        let mut tail = OutputTail::default();
        tail.push("user@host % ls\nfile1\nfile2\nuser@host % ");
        let m = tail.metrics();
        assert!(m.detected_agent.is_none());
    }

    #[test]
    fn output_tail_detection_is_sticky() {
        let mut tail = OutputTail::default();
        tail.push("OpenAI Codex (v1)\n");
        tail.push("some later output without any banner words\n");
        let m = tail.metrics();
        assert_eq!(m.detected_agent.as_deref(), Some("codex"));
    }

    #[test]
    fn output_tail_push_bytes_detects_split_claude_banner() {
        let mut tail = OutputTail::default();
        tail.push_bytes(b"Claude Code ");
        tail.push_bytes(b"v2.1.181\n");
        let m = tail.metrics();
        assert_eq!(m.detected_agent.as_deref(), Some("claude"));
    }

    #[test]
    fn read_range_returns_the_requested_slice_of_the_stream() {
        let mut tail = OutputTail::default();
        tail.push("hello world");
        assert_eq!(tail.read_range(6, 3), (6, b"wor".to_vec()));
        assert_eq!(tail.read_range(6, 100), (6, b"world".to_vec()));
    }

    #[test]
    fn read_range_clamps_an_evicted_offset_to_the_oldest_byte_held() {
        let mut tail = OutputTail::default();
        tail.push(&"a".repeat(OUTPUT_TAIL_BYTES));
        tail.push("bcd");
        let (start, bytes) = tail.read_range(0, 4);
        assert_eq!(start, 3);
        assert_eq!(bytes, b"aaaa".to_vec());
        let end = (OUTPUT_TAIL_BYTES + 3) as u64;
        assert_eq!(tail.read_range(end - 3, 10), (end - 3, b"bcd".to_vec()));
    }

    #[test]
    fn read_range_past_the_end_is_empty_and_keeps_the_offset() {
        let mut tail = OutputTail::default();
        tail.push("abc");
        assert_eq!(tail.read_range(3, 10), (3, Vec::new()));
        assert_eq!(tail.read_range(50, 10), (50, Vec::new()));
    }

    #[test]
    fn read_text_never_splits_a_character_at_the_end() {
        let mut tail = OutputTail::default();
        tail.push("aé|"); // é = C3 A9, bytes 1..3
                          // A cut inside é must leave it for the next read, so offset + text.len() stays the
                          // next byte to ask for (Pocket's poller resumes from exactly that).
        assert_eq!(tail.read_text(0, 2), (0, "a".to_string()));
        assert_eq!(tail.read_text(1, 3), (1, "é|".to_string()));
    }

    #[test]
    fn read_text_starting_inside_a_character_moves_past_it() {
        let mut tail = OutputTail::default();
        tail.push("é🙂z"); // é = 2 bytes, 🙂 = 4 bytes
        assert_eq!(tail.read_text(1, 10), (2, "🙂z".to_string()));
        assert_eq!(tail.read_text(3, 10), (6, "z".to_string()));
        assert_eq!(tail.read_text(2, 3), (2, String::new()));
    }

    #[test]
    fn output_tail_idle_ms_grows_after_push() {
        let mut tail = OutputTail::default();
        tail.push("hello");
        let m1 = tail.metrics();
        assert!(m1.has_output);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let m2 = tail.metrics();
        assert!(m2.idle_ms >= m1.idle_ms);
        assert!(
            m2.idle_ms >= 15,
            "idle_ms should advance ~20ms, got {}",
            m2.idle_ms
        );
    }
}
