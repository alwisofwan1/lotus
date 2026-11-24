//! PTY output flusher — coalesces raw bytes into lossless IPC emissions, at most
//! one per 16ms frame during a burst (the webview cannot paint faster), with the
//! first output after a quiet window emitted immediately so keystroke echo stays instant.
//!
//! Raw bytes are forwarded without any UTF-8 validation. The frontend uses
//! `TextDecoder({stream: true})` which handles split multi-byte sequences
//! correctly across chunk boundaries, so no bytes are ever dropped.

use std::io::Read;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Coalescing window: one frame. Every emit is an IPC message plus a JS callback, and the
/// terminal batches writes per frame anyway, so a shorter window only adds overhead.
pub const PTY_OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(16);
pub const PTY_PENDING_BUFFER_CAP: usize = 256 * 1024;
/// No \x1bc (RIS) — preserves scrollback history on overflow.
pub const PTY_PENDING_TRUNCATION_NOTICE: &str =
    "\x1b[2m[PTY output exceeded 256KB before flush; pending output truncated]\x1b[0m\r\n";

pub struct PtyOutputFlusher {
    pending: Vec<u8>,
}

pub struct PtyPendingOutput {
    pub bytes: Vec<u8>,
    pub ended: bool,
}

pub type SharedPtyPendingOutput = Arc<(Mutex<PtyPendingOutput>, Condvar)>;

/// After a truncation event, the next chunk of PTY output may begin mid-ANSI
/// escape sequence (e.g. `38;2;178;148;187m` without the leading `\x1b[`).
/// This function skips those orphaned CSI parameter/intermediate/final bytes
/// so they don't render as visible text in the terminal.
///
/// Returns the slice starting at the first byte that is NOT part of an orphaned
/// CSI sequence. If the entire slice is orphaned tail, returns an empty slice.
pub fn skip_orphaned_ansi_head(bytes: &[u8]) -> &[u8] {
    if bytes.is_empty() {
        return bytes;
    }
    let first = bytes[0];
    if first == 0x1b || first < 0x20 || first >= 0x80 {
        return bytes;
    }

    let end = match first {
        b'[' => parse_bracketed_csi_fragment(bytes),
        b'?' => parse_private_mode_fragment(bytes),
        b'0'..=b'9' | b';' => parse_numeric_csi_fragment(bytes),
        _ => None,
    };

    end.map_or(bytes, |idx| &bytes[idx..])
}

#[inline]
fn is_ascii_digit(b: u8) -> bool {
    b.is_ascii_digit()
}

#[inline]
fn is_param_separator(b: u8) -> bool {
    matches!(b, b';' | b':')
}

fn parse_bracketed_csi_fragment(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 3 {
        return None;
    }

    let second = bytes[1];
    if second == b'?' {
        return parse_private_mode_fragment(&bytes[1..]).map(|idx| idx + 1);
    }
    if !is_ascii_digit(second) && !is_param_separator(second) {
        return None;
    }
    parse_numeric_csi_fragment(&bytes[1..]).map(|idx| idx + 1)
}

fn parse_private_mode_fragment(bytes: &[u8]) -> Option<usize> {
    if bytes.first().copied() != Some(b'?') {
        return None;
    }

    let mut i = 1;
    let mut has_digit = false;
    while i < bytes.len() && (is_ascii_digit(bytes[i]) || is_param_separator(bytes[i])) {
        has_digit |= is_ascii_digit(bytes[i]);
        i += 1;
    }

    if has_digit && i < bytes.len() && matches!(bytes[i], b'h' | b'l') {
        return Some(i + 1);
    }
    None
}

fn parse_numeric_csi_fragment(bytes: &[u8]) -> Option<usize> {
    let mut i = 0;
    let mut has_digit = false;
    let mut has_separator = false;

    while i < bytes.len() && (is_ascii_digit(bytes[i]) || is_param_separator(bytes[i])) {
        has_digit |= is_ascii_digit(bytes[i]);
        has_separator |= is_param_separator(bytes[i]);
        i += 1;
    }

    if !has_digit || i >= bytes.len() {
        return None;
    }

    let final_byte = bytes[i];
    match final_byte {
        b'm' if has_separator
            || single_numeric_param(bytes, i).is_some_and(|value| value <= 109) =>
        {
            Some(i + 1)
        }
        b'H' | b'f' if has_separator => Some(i + 1),
        b'J' | b'K' if single_numeric_param(bytes, i).is_some_and(|value| value <= 3) => {
            Some(i + 1)
        }
        _ => None,
    }
}

fn single_numeric_param(bytes: &[u8], end: usize) -> Option<u16> {
    if bytes[..end].iter().any(|b| !is_ascii_digit(*b)) {
        return None;
    }

    std::str::from_utf8(&bytes[..end]).ok()?.parse().ok()
}

impl PtyOutputFlusher {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    pub fn push_bytes(&mut self, bytes: &[u8], mut emit: impl FnMut(Vec<u8>)) {
        if self.pending.len().saturating_add(bytes.len()) > PTY_PENDING_BUFFER_CAP {
            self.pending.clear();
            emit(PTY_PENDING_TRUNCATION_NOTICE.as_bytes().to_vec());
            if bytes.len() > PTY_PENDING_BUFFER_CAP {
                return;
            }
            // After truncation the incoming chunk may start mid-ANSI-sequence
            // (e.g. "38;2;178;148;187m" without the leading "\x1b[").
            // Skip orphaned CSI parameter bytes so xterm doesn't render them as text.
            let clean = skip_orphaned_ansi_head(bytes);
            self.pending.extend_from_slice(clean);
            return;
        }
        self.pending.extend_from_slice(bytes);
    }

    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    #[cfg(test)]
    pub fn flush_if_due(&mut self, elapsed: Duration, emit: impl FnMut(Vec<u8>)) {
        if elapsed >= PTY_OUTPUT_FLUSH_INTERVAL {
            self.flush_pending(emit);
        }
    }

    /// Drain all buffered bytes as-is. The frontend `TextDecoder({stream:true})`
    /// handles split multi-byte sequences — no validation needed here.
    pub fn flush_pending(&mut self, mut emit: impl FnMut(Vec<u8>)) {
        if self.pending.is_empty() {
            return;
        }
        emit(std::mem::take(&mut self.pending));
    }

    /// Alias for [`flush_pending`] used at session EOF (was `flush_remaining_lossy`).
    pub fn flush_remaining(&mut self, emit: impl FnMut(Vec<u8>)) {
        self.flush_pending(emit);
    }
}

/// Reader half of the two-thread PTY pipeline.
///
/// Reads raw bytes from `reader`, passes them through the DA-query filter
/// (which auto-replies to DA1/DA2/DA3 queries via `respond` without waiting
/// for the frontend xterm), then pushes passthrough bytes into the shared
/// `pending_output` buffer and signals the flusher via the Condvar.
///
/// `respond(reply_bytes)` is called from the DA filter whenever a DA query
/// is detected. The caller should write these bytes back to the PTY master
/// so apps get a consistent capability response even when the pane is hidden.
pub fn run_pty_reader(
    mut reader: Box<dyn Read + Send>,
    pending_output: SharedPtyPendingOutput,
    mut respond: impl FnMut(&[u8]),
) {
    use crate::da_filter::DaFilter;
    let mut buf = [0u8; 16384];
    let mut da_filter = DaFilter::new();
    // Reusable passthrough buffer: pre-allocated once, cleared per read syscall.
    let mut filtered: Vec<u8> = Vec::with_capacity(16384);
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => {
                let (lock, condvar) = &*pending_output;
                if let Ok(mut pending) = lock.lock() {
                    pending.ended = true;
                    condvar.notify_one();
                }
                break;
            }
            Ok(n) => {
                // DA filter: intercept queries, synthesise replies, collect passthrough.
                // Respond is called before the lock is acquired — no nested locking.
                filtered.clear();
                da_filter.process_into(&buf[..n], &mut filtered, |reply| respond(reply));

                // Skip pending-push entirely when all bytes were DA queries (rare but
                // avoids a lock acquire + spurious condvar wake for zero-byte batches).
                if filtered.is_empty() {
                    continue;
                }

                let (lock, condvar) = &*pending_output;
                let Ok(mut pending) = lock.lock() else {
                    break;
                };
                let n_filtered = filtered.len();
                if pending.bytes.len().saturating_add(n_filtered) > PTY_PENDING_BUFFER_CAP {
                    pending.bytes.clear();
                    pending
                        .bytes
                        .extend_from_slice(PTY_PENDING_TRUNCATION_NOTICE.as_bytes());
                    // After overflow the retained chunk may start mid-ANSI-sequence.
                    // skip_orphaned_ansi_head removes bare CSI-parameter/final bytes
                    // that would render as visible garbage.
                    let clean = skip_orphaned_ansi_head(&filtered);
                    let cap = PTY_PENDING_BUFFER_CAP.saturating_sub(pending.bytes.len());
                    if clean.len() <= cap {
                        pending.bytes.extend_from_slice(clean);
                    }
                } else {
                    let cap = PTY_PENDING_BUFFER_CAP.saturating_sub(pending.bytes.len());
                    if n_filtered <= cap {
                        pending.bytes.extend_from_slice(&filtered);
                    }
                }
                condvar.notify_one();
            }
        }
    }
}

/// Run the flusher half of the two-thread PTY output pipeline.
///
/// Blocks until `pending_output.ended` becomes true and all bytes have been
/// forwarded to `emit`. `emit(data)` returns `true` to signal the IPC channel
/// is gone — the loop returns immediately without processing further output.
///
/// Coalescing: output after a quiet window is emitted at once (leading edge). Inside a
/// burst the loop holds until `PTY_OUTPUT_FLUSH_INTERVAL` has passed since the last emit,
/// ignoring the reader's per-read notifies, so a burst becomes one emit per window.
pub fn run_pty_flusher_loop(
    pending_output: SharedPtyPendingOutput,
    mut flusher: PtyOutputFlusher,
    mut emit: impl FnMut(Vec<u8>) -> bool,
) {
    // Back-dated so the very first output goes out on the leading edge.
    let mut last_flush = std::time::Instant::now()
        .checked_sub(PTY_OUTPUT_FLUSH_INTERVAL)
        .unwrap_or_else(std::time::Instant::now);
    loop {
        let (drained_bytes, ended) = {
            let (lock, condvar) = &*pending_output;
            let Ok(guard) = lock.lock() else { break };
            let has_pending = flusher.has_pending();
            let Ok(guard) =
                condvar.wait_while(guard, |p| !has_pending && p.bytes.is_empty() && !p.ended)
            else {
                break;
            };
            // Inside a burst, hold for the rest of the window. The reader notifies on every
            // read syscall; flushing on each wake made every read its own IPC message.
            let remaining = PTY_OUTPUT_FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
            let mut guard = if remaining.is_zero() || guard.ended {
                guard
            } else {
                match condvar.wait_timeout_while(guard, remaining, |p| !p.ended) {
                    Ok((g, _)) => g,
                    Err(_) => break,
                }
            };
            let bytes = std::mem::take(&mut guard.bytes);
            let ended = guard.ended;
            (bytes, ended)
        };

        if !drained_bytes.is_empty() {
            let mut stopped = false;
            flusher.push_bytes(&drained_bytes, |notice| {
                if emit(notice) {
                    stopped = true;
                }
            });
            if stopped {
                return;
            }
        }

        // Drain all buffered bytes. split UTF-8 sequences are forwarded as-is;
        // the frontend TextDecoder({stream:true}) reassembles them correctly.
        last_flush = std::time::Instant::now();
        let mut stopped = false;
        flusher.flush_pending(|data| {
            if emit(data) {
                stopped = true;
            }
        });
        if stopped {
            return;
        }

        if ended {
            flusher.flush_remaining(|data| {
                let _ = emit(data);
            });
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── constants ────────────────────────────────────────────────────────────

    #[test]
    fn coalesce_interval_is_one_frame() {
        assert_eq!(PTY_OUTPUT_FLUSH_INTERVAL.as_millis(), 16);
    }

    // ── PtyOutputFlusher ─────────────────────────────────────────────────────

    #[test]
    fn push_bytes_accumulates_without_emitting() {
        let mut f = PtyOutputFlusher::new();
        let mut emitted: Vec<Vec<u8>> = Vec::new();
        f.push_bytes(b"hello ", |b| emitted.push(b));
        f.push_bytes(b"world", |b| emitted.push(b));
        // push_bytes only emits on overflow; nothing should be emitted yet
        assert!(
            emitted.is_empty(),
            "push_bytes should not emit before flush"
        );
        assert!(f.has_pending());
    }

    #[test]
    fn flush_pending_emits_all_bytes() {
        let mut f = PtyOutputFlusher::new();
        let mut emitted: Vec<Vec<u8>> = Vec::new();
        f.push_bytes(b"hello ", |_| {});
        f.push_bytes(b"world", |_| {});
        f.flush_pending(|b| emitted.push(b));
        let joined: Vec<u8> = emitted.into_iter().flatten().collect();
        assert_eq!(joined, b"hello world");
        assert!(!f.has_pending());
    }

    #[test]
    fn push_bytes_emits_truncation_notice_on_overflow() {
        let mut f = PtyOutputFlusher::new();
        let mut emitted: Vec<Vec<u8>> = Vec::new();
        // Push slightly more than the cap in one shot.
        let big = vec![b'a'; PTY_PENDING_BUFFER_CAP + 1];
        f.push_bytes(&big, |b| emitted.push(b));
        // The truncation notice must be first.
        assert!(
            emitted
                .first()
                .map(|b| b
                    .windows(b"[PTY output exceeded".len())
                    .any(|w| w == b"[PTY output exceeded"))
                .unwrap_or(false),
            "overflow must emit truncation notice"
        );
    }

    #[test]
    fn truncation_notice_does_not_contain_hard_reset() {
        // \x1bc (ESC c = RIS) clears scrollback — the overflow notice must
        // never include it so users don't lose terminal history on a big burst.
        // Dim styling (\x1b[2m) is fine; only the RIS sequence is banned.
        assert!(
            !PTY_PENDING_TRUNCATION_NOTICE.contains("\x1bc"),
            "truncation notice must not contain RIS (ESC c): {PTY_PENDING_TRUNCATION_NOTICE:?}"
        );
    }

    #[test]
    fn flush_pending_emits_raw_bytes_as_is() {
        let mut f = PtyOutputFlusher::new();
        let mut emitted: Vec<u8> = Vec::new();
        // "é" is 0xC3 0xA9 — both bytes must pass through unmodified.
        f.push_bytes(&[0xC3], |_| {});
        f.push_bytes(&[0xA9], |_| {});
        f.flush_pending(|b| emitted.extend_from_slice(&b));
        assert_eq!(emitted, &[0xC3, 0xA9], "raw bytes must not be altered");
    }

    #[test]
    fn flush_if_due_flushes_after_interval() {
        let mut f = PtyOutputFlusher::new();
        let mut emitted: Vec<Vec<u8>> = Vec::new();
        f.push_bytes(b"data", |_| {});
        // Not yet due — nothing emitted.
        f.flush_if_due(Duration::from_millis(1), |b| emitted.push(b));
        assert!(emitted.is_empty());
        // Due — flush fires.
        f.flush_if_due(PTY_OUTPUT_FLUSH_INTERVAL, |b| emitted.push(b));
        let joined: Vec<u8> = emitted.into_iter().flatten().collect();
        assert_eq!(joined, b"data");
    }

    // ── run_pty_flusher_loop ─────────────────────────────────────────────────

    fn make_pending() -> SharedPtyPendingOutput {
        Arc::new((
            Mutex::new(PtyPendingOutput {
                bytes: Vec::new(),
                ended: false,
            }),
            Condvar::new(),
        ))
    }

    fn push_and_end(pending: &SharedPtyPendingOutput, data: &[u8]) {
        let (lock, condvar) = &**pending;
        let mut p = lock.lock().unwrap();
        p.bytes.extend_from_slice(data);
        p.ended = true;
        condvar.notify_one();
    }

    #[test]
    fn flusher_loop_emits_bytes_and_exits_when_ended() {
        let pending = make_pending();
        let p2 = Arc::clone(&pending);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1));
            push_and_end(&p2, b"hello world");
        });

        let mut emitted: Vec<u8> = Vec::new();
        run_pty_flusher_loop(pending, PtyOutputFlusher::new(), |data| {
            emitted.extend_from_slice(&data);
            false
        });

        assert_eq!(emitted, b"hello world");
    }

    #[test]
    fn flusher_loop_stops_when_emit_signals_channel_closed() {
        let pending = make_pending();
        let p2 = Arc::clone(&pending);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1));
            let (lock, condvar) = &*p2;
            let mut p = lock.lock().unwrap();
            p.bytes.extend_from_slice(b"data");
            // ended stays false — closed channel is the only exit signal
            condvar.notify_one();
        });

        let result = std::thread::spawn(move || {
            let mut count = 0usize;
            run_pty_flusher_loop(pending, PtyOutputFlusher::new(), |_| {
                count += 1;
                true // signal IPC channel gone
            });
            count
        })
        .join()
        .unwrap();

        assert_eq!(
            result, 1,
            "loop must stop after the first emit that returns true"
        );
    }

    #[test]
    fn flusher_loop_emits_truncation_notice_on_overflow() {
        let pending = make_pending();
        let p2 = Arc::clone(&pending);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1));
            push_and_end(&p2, &vec![b'x'; PTY_PENDING_BUFFER_CAP + 1]);
        });

        let mut emitted: Vec<Vec<u8>> = Vec::new();
        run_pty_flusher_loop(pending, PtyOutputFlusher::new(), |data| {
            emitted.push(data);
            false
        });

        assert!(
            emitted.iter().any(|b| b
                .windows(b"PTY output exceeded".len())
                .any(|w| w == b"PTY output exceeded")),
            "overflow must produce truncation notice"
        );
    }

    #[test]
    fn flusher_loop_passes_split_bytes_intact() {
        // "é" = 0xC3 0xA9 — bytes arrive in separate flush intervals.
        // With raw-byte forwarding, both bytes must be present in emitted
        // output; the frontend TextDecoder({stream:true}) reassembles them.
        let pending = make_pending();
        let p2 = Arc::clone(&pending);

        std::thread::spawn(move || {
            // First byte — arrives alone.
            {
                let (lock, condvar) = &*p2;
                let mut p = lock.lock().unwrap();
                p.bytes.push(0xC3);
                condvar.notify_one();
            }
            std::thread::sleep(Duration::from_millis(6)); // cross a flush boundary
                                                          // Second byte — arrives after the first flush.
            push_and_end(&p2, &[0xA9]);
        });

        let mut emitted: Vec<u8> = Vec::new();
        run_pty_flusher_loop(pending, PtyOutputFlusher::new(), |data| {
            emitted.extend_from_slice(&data);
            false
        });

        assert_eq!(
            emitted,
            &[0xC3, 0xA9],
            "split bytes must be forwarded intact"
        );
    }

    #[test]
    fn flusher_loop_coalesces_a_burst_of_reads_into_few_emits() {
        // 40 reads ~1ms apart, each notifying, like a TUI redraw streaming in.
        let pending = make_pending();
        let p2 = Arc::clone(&pending);
        std::thread::spawn(move || {
            for i in 0..40u8 {
                let (lock, condvar) = &*p2;
                lock.lock().unwrap().bytes.push(i);
                condvar.notify_one();
                std::thread::sleep(Duration::from_millis(1));
            }
            let (lock, condvar) = &*p2;
            lock.lock().unwrap().ended = true;
            condvar.notify_one();
        });

        let mut emits = 0usize;
        let mut emitted: Vec<u8> = Vec::new();
        run_pty_flusher_loop(pending, PtyOutputFlusher::new(), |data| {
            emits += 1;
            emitted.extend_from_slice(&data);
            false
        });

        assert_eq!(
            emitted,
            (0..40u8).collect::<Vec<_>>(),
            "no byte lost or reordered"
        );
        // >=40ms of output at 16ms windows: a leading emit plus ~1 per window. The old
        // wake-per-read loop emitted ~40 here.
        assert!(emits <= 8, "burst must coalesce, got {emits} emits");
    }
}
