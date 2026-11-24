//! Turns a PTY byte stream back into the screen it draws.
//!
//! **Why this exists.** A TUI does not print what it displays. Claude moves between rows with
//! `\r` + `ESC[1B` and separates words by jumping columns (`ESC[5G`), so stripping the escapes
//! destroys the layout rather than revealing it: a whole permission prompt arrives as one line
//! reading `Doyouwanttocreategate17.txt?` (measured on `devbox-vps` 2026-09-06). Anything that
//! reads a prompt's options off the terminal therefore needs a rendered screen, and on desktop
//! there is nothing else to render it — the host solves the same problem by asking tmux, which
//! desktop has no equivalent of (`plans/pocket-without-laptop/issues/18`).
//!
//! **Fed live, not on demand.** The parser sits on the flusher's path and sees every byte in
//! order. Rendering a *tail* instead would start mid-stream against a blank grid, and whether
//! that lands on a complete repaint depends on what the agent happened to redraw — a correctness
//! question with no stable answer. Feeding it live removes the question.
//!
//! The grid is the visible screen only: 80x24 of cells, no scrollback. History already has a
//! home in `OutputTail`, and duplicating it here would double a hot buffer to no purpose.

use std::sync::{Arc, Mutex};

/// Rows kept when the caller never said. Matches the app's PTY's own fallback, so a session that
/// never resized renders at the size the agent was told it had.
const DEFAULT_ROWS: u16 = 24;
const DEFAULT_COLS: u16 = 80;

/// A terminal grid fed by one PTY session's output.
pub struct TerminalScreen {
    parser: vt100::Parser,
}

impl TerminalScreen {
    pub fn new(rows: u16, cols: u16) -> Self {
        Self {
            // Zero scrollback: only the visible screen is ever read, and `OutputTail` already
            // owns history.
            parser: vt100::Parser::new(
                if rows > 0 { rows } else { DEFAULT_ROWS },
                if cols > 0 { cols } else { DEFAULT_COLS },
                0,
            ),
        }
    }

    pub fn push_bytes(&mut self, data: &[u8]) {
        self.parser.process(data);
    }

    /// The visible rows, newline-separated, **with trailing whitespace trimmed off each row**.
    ///
    /// The trimming is not tidiness. `tmux capture-pane -p` trims, the wrapping rules in
    /// the app's `permission_prompt_wrap` were measured against its output, and one of those rules
    /// asks whether a row was *filled to the edge* — a question answered by the row's length.
    /// Leaving the padding on would make desktop join a wrapped label differently from the host
    /// for the very same screen. vt100 keeps cells that were written as spaces; tmux does not.
    pub fn contents(&self) -> String {
        self.parser
            .screen()
            .contents()
            .lines()
            .map(str::trim_end)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Bytes that redraw this screen on a blank terminal, cursor and modes included.
    pub fn state_formatted(&self) -> Vec<u8> {
        self.parser.screen().state_formatted()
    }

    pub fn resize(&mut self, rows: u16, cols: u16) {
        if rows > 0 && cols > 0 {
            self.parser.screen_mut().set_size(rows, cols);
        }
    }
}

impl Default for TerminalScreen {
    fn default() -> Self {
        Self::new(DEFAULT_ROWS, DEFAULT_COLS)
    }
}

pub type SharedTerminalScreen = Arc<Mutex<TerminalScreen>>;
