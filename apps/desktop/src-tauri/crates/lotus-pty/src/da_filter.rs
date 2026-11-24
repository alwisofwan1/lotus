//! Device-Attribute (DA) query filter.
//!
//! Many TUI apps (vim, htop, tmux, claude CLI) send VT100 Device Attribute
//! queries to probe terminal capabilities:
//!   DA1  ESC [ c   or  ESC [ 0 c   → "what are you?"
//!   DA2  ESC [ > 0 c               → "which firmware version?"
//!   DA3  ESC [ = 0 c               → "what is your unit ID?"
//!
//! When a pane is hidden (workspace switch), the frontend xterm instance
//! never sees the query and therefore never replies. The app stalls waiting
//! for a response and may misrender or hang when the pane is revealed.
//!
//! `DaFilter::process_into` intercepts DA queries in the raw PTY byte stream
//! and synthesises the correct reply on the PTY writer, allowing the app to
//! continue regardless of pane visibility.

const ESC: u8 = 0x1b;
const CSI_INTRO: u8 = b'[';
const DA_FINAL: u8 = b'c';
const PREFIX_GT: u8 = b'>'; // DA2
const PREFIX_EQ: u8 = b'='; // DA3

/// VT100 DA1 reply: "I am a VT100 with Advanced Video Option."
pub const DA1_REPLY: &[u8] = b"\x1b[?1;2c";
/// DA2 reply: "I am a VT220, firmware 2.76, no cartridge."
pub const DA2_REPLY: &[u8] = b"\x1b[>0;276;0c";

/// Safety limit: a CSI sequence longer than this is almost certainly runaway
/// data (binary output, corrupt stream). Flush it as passthrough and reset.
const HOLD_MAX: usize = 256;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Idle,
    AfterEsc,
    InsideCsi,
}

pub struct DaFilter {
    state: State,
    /// Accumulator for partial ESC sequences not yet classified.
    hold: Vec<u8>,
}

impl DaFilter {
    pub fn new() -> Self {
        Self {
            state: State::Idle,
            hold: Vec::new(),
        }
    }

    /// Process `input` bytes:
    /// - Passthrough bytes (non-DA content) are appended to `output`.
    /// - DA query bytes are consumed; `respond` is called with the reply.
    ///
    /// Across multiple calls, partial sequences are held in `self.hold` until
    /// classification is possible (handles queries split across read syscalls).
    pub fn process_into(
        &mut self,
        input: &[u8],
        output: &mut Vec<u8>,
        mut respond: impl FnMut(&[u8]),
    ) {
        // Fast path: no ESC in input and already idle — nothing to filter.
        if self.state == State::Idle && !input.contains(&ESC) {
            output.extend_from_slice(input);
            return;
        }
        for &byte in input {
            self.step(byte, output, &mut respond);
        }
    }

    fn step(&mut self, byte: u8, output: &mut Vec<u8>, respond: &mut impl FnMut(&[u8])) {
        match self.state {
            State::Idle => {
                if byte == ESC {
                    self.hold.push(ESC);
                    self.state = State::AfterEsc;
                } else {
                    output.push(byte);
                }
            }
            State::AfterEsc => {
                if byte == CSI_INTRO {
                    self.hold.push(byte); // hold = [ESC, '[']
                    self.state = State::InsideCsi;
                } else if byte == ESC {
                    // Double ESC: the held single ESC is a standalone escape —
                    // flush it as passthrough then start a new AfterEsc.
                    output.extend_from_slice(&self.hold);
                    self.hold.clear();
                    self.hold.push(ESC);
                    // state stays AfterEsc
                } else {
                    // ESC followed by a non-bracket byte (e.g. ESC M reverse-index).
                    output.extend_from_slice(&self.hold);
                    self.hold.clear();
                    output.push(byte);
                    self.state = State::Idle;
                }
            }
            State::InsideCsi => {
                self.hold.push(byte);

                if self.hold.len() > HOLD_MAX {
                    // Runaway / binary data — flush and reset.
                    output.extend_from_slice(&self.hold);
                    self.hold.clear();
                    self.state = State::Idle;
                    return;
                }

                if is_csi_final(byte) {
                    if byte == DA_FINAL {
                        // Params are hold[2..len-1]  (strip leading ESC [ and trailing c).
                        let params = &self.hold[2..self.hold.len() - 1];
                        if is_da_response(params) {
                            // This is a DA *response* from the terminal — pass through
                            // unchanged so it reaches the frontend xterm.
                            output.extend_from_slice(&self.hold);
                        } else {
                            // DA query — synthesise reply, do NOT forward to frontend.
                            match params.first().copied() {
                                Some(PREFIX_GT) => respond(DA2_REPLY),
                                Some(PREFIX_EQ) => {} // DA3: silently consume
                                _ => respond(DA1_REPLY),
                            }
                        }
                    } else {
                        // Non-DA CSI sequence (e.g. ESC[2J clear-screen) — pass through.
                        output.extend_from_slice(&self.hold);
                    }
                    self.hold.clear();
                    self.state = State::Idle;
                }
                // else: intermediate byte, keep accumulating
            }
        }
    }
}

/// CSI final byte: 0x40..=0x7e  (letters + a few symbols, excludes 0x3a..0x3f params).
fn is_csi_final(b: u8) -> bool {
    b >= 0x40 && b <= 0x7e
}

/// A DA sequence is a *response* (not a query) when its parameter string
/// contains `?` (DA1 response marker) or `;` (multi-part parameter, e.g.
/// DA2 response `>0;276;0c`). Bare queries like `c`, `0c`, `>0c` have neither.
fn is_da_response(params: &[u8]) -> bool {
    params.contains(&b'?') || params.contains(&b';')
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run input through a fresh filter; return (passthrough_bytes, reply_bytes).
    fn run(f: &mut DaFilter, input: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut output = Vec::new();
        let mut replies = Vec::new();
        f.process_into(input, &mut output, |r| replies.extend_from_slice(r));
        (output, replies)
    }

    // ── passthrough ──────────────────────────────────────────────────────────

    #[test]
    fn plain_bytes_pass_through() {
        let (pt, rep) = run(&mut DaFilter::new(), b"hello world");
        assert_eq!(pt, b"hello world");
        assert!(rep.is_empty());
    }

    #[test]
    fn non_da_csi_passes_through() {
        // ESC[2J — clear screen; must not be intercepted
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b[2J");
        assert_eq!(pt, b"\x1b[2J");
        assert!(rep.is_empty());
    }

    #[test]
    fn esc_followed_by_non_bracket_passes_through() {
        // ESC M — reverse index; a common non-CSI escape
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1bM");
        assert_eq!(pt, b"\x1bM");
        assert!(rep.is_empty());
    }

    // ── DA1 ──────────────────────────────────────────────────────────────────

    #[test]
    fn da1_bare_query_is_intercepted() {
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b[c");
        assert!(pt.is_empty(), "DA1 query must not pass through");
        assert_eq!(rep, DA1_REPLY);
    }

    #[test]
    fn da1_zero_param_query_is_intercepted() {
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b[0c");
        assert!(pt.is_empty());
        assert_eq!(rep, DA1_REPLY);
    }

    #[test]
    fn da1_response_passes_through() {
        // ESC[?1;2c is xterm's own DA1 *response* — must not be re-intercepted
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b[?1;2c");
        assert_eq!(
            pt, b"\x1b[?1;2c",
            "DA1 response must pass through unchanged"
        );
        assert!(rep.is_empty());
    }

    // ── DA2 ──────────────────────────────────────────────────────────────────

    #[test]
    fn da2_query_is_intercepted() {
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b[>0c");
        assert!(pt.is_empty(), "DA2 query must not pass through");
        assert_eq!(rep, DA2_REPLY);
    }

    #[test]
    fn da2_response_passes_through() {
        // ESC[>0;276;0c has ';' → it is a response, not a query
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b[>0;276;0c");
        assert_eq!(pt, b"\x1b[>0;276;0c");
        assert!(rep.is_empty());
    }

    // ── DA3 ──────────────────────────────────────────────────────────────────

    #[test]
    fn da3_query_is_silently_consumed() {
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b[=0c");
        assert!(pt.is_empty(), "DA3 query must not pass through");
        assert!(rep.is_empty(), "DA3 must not produce a reply");
    }

    // ── split sequences ───────────────────────────────────────────────────────

    #[test]
    fn split_da1_query_across_two_chunks() {
        let mut f = DaFilter::new();
        let (pt1, rep1) = run(&mut f, b"\x1b[");
        let (pt2, rep2) = run(&mut f, b"c");
        assert!(
            pt1.is_empty(),
            "partial sequence must be held, not forwarded"
        );
        assert!(
            rep1.is_empty(),
            "partial sequence must not trigger early reply"
        );
        assert!(pt2.is_empty());
        assert_eq!(rep2, DA1_REPLY, "reply must fire when sequence completes");
    }

    #[test]
    fn split_esc_then_bracket_then_c() {
        let mut f = DaFilter::new();
        run(&mut f, b"\x1b");
        run(&mut f, b"[");
        let (pt, rep) = run(&mut f, b"c");
        assert!(pt.is_empty());
        assert_eq!(rep, DA1_REPLY);
    }

    // ── edge cases ────────────────────────────────────────────────────────────

    #[test]
    fn double_esc_before_da_query() {
        // ESC ESC[c → first ESC passes through, second starts a DA1 query
        let (pt, rep) = run(&mut DaFilter::new(), b"\x1b\x1b[c");
        assert_eq!(pt, b"\x1b", "standalone ESC must pass through");
        assert_eq!(rep, DA1_REPLY);
    }

    #[test]
    fn runaway_csi_flushed_as_passthrough() {
        let mut seq = b"\x1b[".to_vec();
        seq.extend(std::iter::repeat(b'1').take(HOLD_MAX + 1));
        let (pt, rep) = run(&mut DaFilter::new(), &seq);
        assert!(!pt.is_empty(), "runaway CSI must be flushed as passthrough");
        assert!(rep.is_empty(), "runaway sequence must not trigger a reply");
    }

    #[test]
    fn interleaved_text_and_da_query() {
        let (pt, rep) = run(&mut DaFilter::new(), b"hello\x1b[cworld");
        assert_eq!(pt, b"helloworld");
        assert_eq!(rep, DA1_REPLY);
    }

    #[test]
    fn multiple_da_queries_in_one_chunk() {
        let mut f = DaFilter::new();
        let mut output = Vec::new();
        let mut replies: Vec<Vec<u8>> = Vec::new();
        f.process_into(b"\x1b[c\x1b[>0c", &mut output, |r| replies.push(r.to_vec()));
        assert!(output.is_empty());
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0], DA1_REPLY);
        assert_eq!(replies[1], DA2_REPLY);
    }
}
