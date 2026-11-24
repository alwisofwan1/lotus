//! OSC 133 shell-integration observer.
//!
//! Many modern shells (zsh, bash, fish with shell integration enabled) and
//! terminal apps (Claude Code `--shell-integration`, kitty, iTerm2) emit
//! OSC 133 sequences as semantic prompt/command boundary markers:
//!
//!   OSC 133 ; A ST          — prompt start (shell is idle, awaiting input)
//!   OSC 133 ; B ST          — command start (user submitted input)
//!   OSC 133 ; C [;name=X] ST — command output starting (command is running)
//!   OSC 133 ; D [;N] ST     — command done, optional exit code N
//!
//! `AgentDetector::observe` scans the PTY byte stream for these sequences and
//! fires `on_signal` for each recognised event. Every input byte is passed
//! through unchanged — this is a **pure observer**, not a filter.
//!
//! Wired into the flusher thread in `spawn_session`: every burst emission is
//! scanned and the result updates `PtySession::is_shell_idle` so that
//! `lotus_wait_cell_idle` has a low-latency idle signal without relying solely
//! on time-based output heuristics.

const ESC: u8 = 0x1b;
const OSC_INTRO: u8 = b']';
const BEL: u8 = 0x07;

/// Safety cap: an OSC body longer than this is almost certainly corrupt data.
/// Flush the hold buffer and reset rather than accumulating indefinitely.
/// Sized for OSC 7501, whose base64 `msg` alone may reach 2732 bytes.
const HOLD_MAX: usize = 4096;

// ── Public signal type ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSignal {
    /// Shell displayed its prompt — cell is idle, waiting for user input.
    PromptStart,
    /// User submitted a command — about to start running.
    CommandStart,
    /// Command output is flowing; `name` identifies the agent when present.
    CommandOutput { name: Option<String> },
    /// Command finished; `exit_code` carries the process exit status.
    CommandDone { exit_code: Option<i32> },
    /// OSC 7501 program status of the ROOT record: `working`, `blocked`, `done`, `error` or
    /// `idle` (spec: superlogical.com/rex/docs/build/program-status). Sent by grok, pi and agy.
    ProgramStatus(String),
}

impl AgentSignal {
    /// `true` when this signal means the shell has returned to the prompt.
    pub fn is_idle(&self) -> bool {
        matches!(
            self,
            AgentSignal::PromptStart | AgentSignal::CommandDone { .. }
        )
    }
}

// ── State machine ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Idle,
    AfterEsc,
    InOsc,
    AfterOscEsc, // ESC inside OSC body — could be start of ST (ESC \)
}

pub struct AgentDetector {
    state: State,
    hold: Vec<u8>,
}

impl AgentDetector {
    pub fn new() -> Self {
        Self {
            state: State::Idle,
            hold: Vec::new(),
        }
    }

    /// Scan `input` for OSC 133 sequences; call `on_signal` for each one.
    /// All bytes pass through; nothing is consumed or modified.
    pub fn observe(&mut self, input: &[u8], mut on_signal: impl FnMut(AgentSignal)) {
        // Fast path: no escape sequences in input and state machine is idle.
        if self.state == State::Idle && !input.contains(&ESC) {
            return;
        }
        for &byte in input {
            self.step(byte, &mut on_signal);
        }
    }

    fn step(&mut self, byte: u8, on_signal: &mut impl FnMut(AgentSignal)) {
        match self.state {
            State::Idle => {
                if byte == ESC {
                    self.hold.push(byte);
                    self.state = State::AfterEsc;
                }
            }
            State::AfterEsc => {
                self.hold.push(byte);
                if byte == OSC_INTRO {
                    self.state = State::InOsc;
                } else {
                    // Not an OSC — abandon and reset.
                    self.hold.clear();
                    self.state = State::Idle;
                }
            }
            State::InOsc => {
                if byte == BEL {
                    self.classify_and_signal(on_signal);
                    self.hold.clear();
                    self.state = State::Idle;
                } else if byte == ESC {
                    self.hold.push(byte);
                    self.state = State::AfterOscEsc;
                } else {
                    self.hold.push(byte);
                    if self.hold.len() > HOLD_MAX {
                        self.hold.clear();
                        self.state = State::Idle;
                    }
                }
            }
            State::AfterOscEsc => {
                self.hold.push(byte);
                if byte == b'\\' {
                    // ST (ESC \) complete — OSC terminated.
                    self.classify_and_signal(on_signal);
                    self.hold.clear();
                    self.state = State::Idle;
                } else {
                    // Not ST — treat the ESC as OSC body content and continue.
                    self.state = State::InOsc;
                    if self.hold.len() > HOLD_MAX {
                        self.hold.clear();
                        self.state = State::Idle;
                    }
                }
            }
        }
    }

    fn classify_and_signal(&self, on_signal: &mut impl FnMut(AgentSignal)) {
        // hold layout:
        //   BEL-terminated:  [ESC, ], <body...>]
        //   ST-terminated:   [ESC, ], <body...>, ESC, \]
        let body = {
            let raw = &self.hold[2..]; // skip leading ESC ]
            if raw.ends_with(b"\x1b\\") {
                &raw[..raw.len() - 2]
            } else {
                raw
            }
        };

        let s = match std::str::from_utf8(body) {
            Ok(s) => s,
            Err(_) => return,
        };

        if let Some(rest) = s.strip_prefix("7501;") {
            if let Some(state) = program_status_state(rest) {
                on_signal(AgentSignal::ProgramStatus(state.to_string()));
            }
            return;
        }

        // Require "133;" prefix.
        let rest = match s.strip_prefix("133;") {
            Some(r) => r,
            None => return,
        };

        // Split "code" from optional ";params" tail.
        let (code, params) = match rest.split_once(';') {
            Some((c, p)) => (c, Some(p)),
            None => (rest, None),
        };

        let signal = match code {
            "A" => AgentSignal::PromptStart,
            "B" => AgentSignal::CommandStart,
            "C" => {
                let name = params.and_then(|p| {
                    p.split(';')
                        .find_map(|kv| kv.strip_prefix("name=").map(|v| v.to_string()))
                });
                AgentSignal::CommandOutput { name }
            }
            "D" => {
                let exit_code = params
                    .and_then(|p| p.split(';').next())
                    .and_then(|n| n.parse::<i32>().ok());
                AgentSignal::CommandDone { exit_code }
            }
            _ => return,
        };

        on_signal(signal);
    }
}

/// The root record's state, or `None` for the support query (`?`), a child record (`id=`),
/// `clear`, or a state this build does not know.
fn program_status_state(body: &str) -> Option<&str> {
    let mut state = None;
    for pair in body.split(':') {
        if pair.starts_with("id=") {
            return None;
        }
        if let Some(v) = pair.strip_prefix("state=") {
            state = Some(v);
        }
    }
    state.filter(|s| matches!(*s, "working" | "blocked" | "done" | "error" | "idle"))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn detect(input: &[u8]) -> Vec<AgentSignal> {
        let mut det = AgentDetector::new();
        let mut out = Vec::new();
        det.observe(input, |s| out.push(s));
        out
    }

    #[test]
    fn detects_prompt_start_bel() {
        assert_eq!(detect(b"\x1b]133;A\x07"), vec![AgentSignal::PromptStart]);
    }

    #[test]
    fn detects_prompt_start_st() {
        assert_eq!(detect(b"\x1b]133;A\x1b\\"), vec![AgentSignal::PromptStart]);
    }

    #[test]
    fn detects_command_start() {
        assert_eq!(detect(b"\x1b]133;B\x07"), vec![AgentSignal::CommandStart]);
    }

    #[test]
    fn detects_command_output_no_name() {
        assert_eq!(
            detect(b"\x1b]133;C\x07"),
            vec![AgentSignal::CommandOutput { name: None }]
        );
    }

    #[test]
    fn detects_command_output_with_name() {
        assert_eq!(
            detect(b"\x1b]133;C;name=claude\x07"),
            vec![AgentSignal::CommandOutput {
                name: Some("claude".into())
            }]
        );
    }

    #[test]
    fn detects_command_done_exit_zero() {
        assert_eq!(
            detect(b"\x1b]133;D;0\x07"),
            vec![AgentSignal::CommandDone { exit_code: Some(0) }]
        );
    }

    #[test]
    fn detects_command_done_nonzero_exit() {
        assert_eq!(
            detect(b"\x1b]133;D;1\x07"),
            vec![AgentSignal::CommandDone { exit_code: Some(1) }]
        );
    }

    #[test]
    fn ignores_non_133_osc() {
        // OSC 0 (window title) — must not fire any signal.
        assert_eq!(detect(b"\x1b]0;window title\x07"), vec![]);
    }

    #[test]
    fn ignores_plain_text() {
        assert_eq!(detect(b"Hello, world!\r\n"), vec![]);
    }

    #[test]
    fn handles_split_across_calls_bel() {
        let mut det = AgentDetector::new();
        let mut out = Vec::new();
        det.observe(b"\x1b]133;", |s| out.push(s));
        det.observe(b"A\x07", |s| out.push(s));
        assert_eq!(out, vec![AgentSignal::PromptStart]);
    }

    #[test]
    fn handles_split_across_calls_st() {
        let mut det = AgentDetector::new();
        let mut out = Vec::new();
        det.observe(b"\x1b]133;D;0\x1b", |s| out.push(s));
        det.observe(b"\\", |s| out.push(s));
        assert_eq!(out, vec![AgentSignal::CommandDone { exit_code: Some(0) }]);
    }

    #[test]
    fn multiple_sequences_in_one_chunk() {
        let input = b"\x1b]133;A\x07normal output\x1b]133;B\x07";
        assert_eq!(
            detect(input),
            vec![AgentSignal::PromptStart, AgentSignal::CommandStart]
        );
    }

    #[test]
    fn is_idle_classification() {
        assert!(AgentSignal::PromptStart.is_idle());
        assert!(AgentSignal::CommandDone { exit_code: Some(0) }.is_idle());
        assert!(AgentSignal::CommandDone { exit_code: None }.is_idle());
        assert!(!AgentSignal::CommandStart.is_idle());
        assert!(!AgentSignal::CommandOutput { name: None }.is_idle());
        assert!(!AgentSignal::CommandOutput {
            name: Some("x".into())
        }
        .is_idle());
    }

    #[test]
    fn truncates_runaway_osc_and_recovers() {
        let mut det = AgentDetector::new();
        let mut out = Vec::new();
        // Start an OSC, push garbage past HOLD_MAX to trigger the reset.
        det.observe(b"\x1b]", |s| out.push(s));
        det.observe(&vec![b'x'; HOLD_MAX + 100], |s| out.push(s));
        // State machine should have reset — subsequent valid OSC fires.
        det.observe(b"\x1b]133;A\x07", |s| out.push(s));
        assert_eq!(out, vec![AgentSignal::PromptStart]);
    }

    #[test]
    fn detects_program_status_root_record() {
        assert_eq!(
            detect(b"\x1b]7501;state=working:app=pi\x1b\\"),
            vec![AgentSignal::ProgramStatus("working".into())]
        );
        assert_eq!(
            detect(b"\x1b]7501;state=blocked:kind=permission:msg=SGk=\x07"),
            vec![AgentSignal::ProgramStatus("blocked".into())]
        );
    }

    #[test]
    fn program_status_with_long_message_still_fires() {
        let mut seq = b"\x1b]7501;state=done:msg=".to_vec();
        seq.extend(vec![b'A'; 2732]);
        seq.extend_from_slice(b"\x1b\\");
        assert_eq!(detect(&seq), vec![AgentSignal::ProgramStatus("done".into())]);
    }

    #[test]
    fn program_status_ignores_query_child_clear_and_unknown() {
        assert_eq!(detect(b"\x1b]7501;?\x1b\\"), vec![]);
        assert_eq!(detect(b"\x1b]7501;state=working:id=sub-1\x1b\\"), vec![]);
        assert_eq!(detect(b"\x1b]7501;state=clear:id=sub-1\x1b\\"), vec![]);
        assert_eq!(detect(b"\x1b]7501;state=dreaming\x1b\\"), vec![]);
    }

    #[test]
    fn program_status_is_not_idle() {
        assert!(!AgentSignal::ProgramStatus("idle".into()).is_idle());
    }

    #[test]
    fn does_not_fire_for_csi_sequences() {
        // ESC [ ... — CSI, not OSC — must produce no signals.
        assert_eq!(detect(b"\x1b[2J\x1b[H"), vec![]);
    }
}
