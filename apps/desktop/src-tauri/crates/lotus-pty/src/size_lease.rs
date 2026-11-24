//! Who sets a pane's size: the desktop's own view, or a phone holding a lease.
//!
//! ADR-6 addendum 2026-10-05 (`plans/lotus-pocket/PLAN.md`). A PTY has exactly one winsize and
//! the TUI draws for it, so two screens cannot each have their own; what they can have is a rule
//! for who wins. This is tmux's `window-size latest`, with two additions a phone needs:
//!
//! - **The desktop's size is remembered, then put back on purpose.** The desktop only sends a
//!   size when its layout changes (`ResizeObserver` → `fitAddon.fit()`), never when its window
//!   comes back, so nothing would restore it otherwise.
//! - **A phone holds the size on a lease.** A phone that drops off a cellular link never says
//!   goodbye; without an expiry the desktop would be left drawing at phone width indefinitely.
//!
//! Pure state, no I/O: every method answers the size to apply, and `pty.rs` applies it.

use std::time::{Duration, Instant};

/// How long a phone's hold lasts without a renewal.
pub const LEASE_TTL: Duration = Duration::from_secs(30);

pub type Size = (u16, u16);

#[derive(Debug, Clone, Copy)]
struct Lease {
    token: u64,
    size: Size,
    expires: Instant,
}

/// What a phone's request came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    /// The phone holds the size; apply `size` if it is `Some`.
    Held { token: u64, apply: Option<Size> },
    /// The token is not the live lease — the desktop took the pane back, or the lease ran out.
    /// The phone stops renewing until the operator opens Terminal again.
    Lost,
}

#[derive(Debug, Default)]
pub struct Sizing {
    /// The last size the desktop sent. `None` until it sends one.
    desktop: Option<Size>,
    lease: Option<Lease>,
}

impl Sizing {
    /// The desktop laid itself out. Remembered always; applied only when no phone holds the
    /// pane — a layout pass can fire with nobody at the desk (a tab mounting, a workspace
    /// switch), and it must not count as a person taking the pane back.
    pub fn desktop_resized(&mut self, size: Size) -> Option<Size> {
        self.desktop = Some(size);
        if self.lease.is_some() {
            None
        } else {
            Some(size)
        }
    }

    /// A phone asks to hold `size`. No token starts a new lease and always succeeds (the
    /// operator just opened Terminal); a token renews, and fails if it is not the live one.
    ///
    /// `current` is the pane's size right now: what the desktop gets back if it never sent
    /// one of its own.
    pub fn hold(
        &mut self,
        token: Option<u64>,
        size: Size,
        current: Size,
        now: Instant,
        fresh_token: u64,
    ) -> Hold {
        let token = match (token, self.lease) {
            (None, _) => fresh_token,
            (Some(t), Some(live)) if t == live.token && live.expires > now => t,
            (Some(_), _) => return Hold::Lost,
        };
        let before = self.lease.map(|l| l.size).unwrap_or(current);
        if self.desktop.is_none() {
            self.desktop = Some(current);
        }
        self.lease = Some(Lease {
            token,
            size,
            expires: now + LEASE_TTL,
        });
        Hold::Held {
            token,
            apply: (before != size).then_some(size),
        }
    }

    /// The phone left Terminal. Answers the desktop's size if this token was holding it.
    pub fn release(&mut self, token: u64) -> Option<Size> {
        match self.lease {
            Some(live) if live.token == token => self.end(),
            _ => None,
        }
    }

    /// Someone at the desk typed or clicked in this pane: the desktop wins.
    pub fn reclaim(&mut self) -> Option<Size> {
        self.end()
    }

    /// The phone went quiet past its lease.
    pub fn expire(&mut self, now: Instant) -> Option<Size> {
        match self.lease {
            Some(live) if live.expires <= now => self.end(),
            _ => None,
        }
    }

    fn end(&mut self) -> Option<Size> {
        let held = self.lease.take()?;
        self.desktop.filter(|d| *d != held.size)
    }
}

/// Whether bytes the desktop terminal wrote are a **report it generated**, not a person.
///
/// xterm.js answers a TUI's queries by itself — a cursor-position report (`ESC [ r ; c R`), a
/// focus event (`ESC [ I` / `ESC [ O`), a colour or DECRQSS answer (`ESC ]` / `ESC P` …) — and
/// those arrive on the same `write_to_session` as a keystroke. Counted as a touch, the first
/// redraw at phone width would make the desktop's own reply take the pane straight back.
///
/// Focus-in is a report on purpose: the desktop focuses panes programmatically, and the rule
/// is that a *person* at the desk wins.
///
/// **A mouse report counts only when a button is down** — a click, a drag, the wheel. Under a
/// TUI with any-motion tracking (Claude Code turns it on), xterm.js also reports the pointer
/// merely passing over the pane: `ESC [ < 35 ; x ; y M`, 32 for motion plus 3 for no button.
/// Measured on device 2026-10-05: a pointer resting near the pane took the size back from the
/// phone seven seconds after every hold.
pub fn is_terminal_report(data: &str) -> bool {
    let b = data.as_bytes();
    if b.len() < 3 || b[0] != 0x1b {
        return false;
    }
    match b[1] {
        b']' | b'P' => true,
        b'[' if b[2] == b'<' => sgr_hover(&b[3..]),
        // Legacy X10 encoding: `ESC [ M` then button, column and row, each offset by 32.
        b'[' if b[2] == b'M' && b.len() == 6 => is_hover(u32::from(b[3]).wrapping_sub(32)),
        b'[' => {
            let body = &b[2..];
            let last = *body.last().unwrap_or(&0);
            match last {
                b'I' | b'O' => body.len() == 1,
                // CPR `ESC [ 12 ; 40 R`, DA answers `ESC [ ? 1 ; 2 c`, mode reports `… $ y`.
                b'R' | b'c' | b'y' => body[..body.len() - 1]
                    .iter()
                    .all(|c| c.is_ascii_digit() || matches!(c, b';' | b'?' | b'>' | b'$')),
                _ => false,
            }
        }
        _ => false,
    }
}

/// `b ; x ; y M` (the bytes after `ESC [ <`) is a pointer moving with no button down.
/// A burst of several reports in one write is hover only if every one of them is.
fn sgr_hover(body: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(body) else {
        return false;
    };
    text.split("\x1b[<").all(|one| {
        one.strip_suffix('M')
            .and_then(|rest| rest.split(';').next())
            .and_then(|button| button.parse::<u32>().ok())
            .is_some_and(is_hover)
    })
}

/// Motion (bit 32) with the "no button" code (low bits 3). Shift/alt/ctrl (4, 8, 16) do not
/// change what it is.
fn is_hover(button: u32) -> bool {
    button & 32 != 0 && button & 3 == 3
}

#[cfg(test)]
mod tests {
    use super::*;

    const DESK: Size = (160, 40);
    const PHONE: Size = (54, 30);

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn a_phone_takes_the_size_and_gives_back_the_desktops() {
        let now = t0();
        let mut s = Sizing::default();
        assert_eq!(s.desktop_resized(DESK), Some(DESK));

        assert_eq!(
            s.hold(None, PHONE, DESK, now, 7),
            Hold::Held {
                token: 7,
                apply: Some(PHONE)
            }
        );
        assert_eq!(s.release(7), Some(DESK));
        assert_eq!(s.release(7), None, "a second release is a no-op");
    }

    #[test]
    fn a_desktop_that_never_sent_a_size_gets_the_one_it_had() {
        let now = t0();
        let mut s = Sizing::default();
        s.hold(None, PHONE, (120, 33), now, 1);
        assert_eq!(s.release(1), Some((120, 33)));
    }

    #[test]
    fn a_layout_pass_under_a_lease_is_remembered_not_applied() {
        let now = t0();
        let mut s = Sizing::default();
        s.desktop_resized(DESK);
        s.hold(None, PHONE, DESK, now, 1);
        assert_eq!(s.desktop_resized((140, 38)), None);
        assert_eq!(s.release(1), Some((140, 38)));
    }

    #[test]
    fn renewing_the_same_size_applies_nothing_and_a_new_one_applies_it() {
        let now = t0();
        let mut s = Sizing::default();
        s.hold(None, PHONE, DESK, now, 1);
        assert_eq!(
            s.hold(Some(1), PHONE, DESK, now, 9),
            Hold::Held {
                token: 1,
                apply: None
            }
        );
        assert_eq!(
            s.hold(Some(1), (44, 30), DESK, now, 9),
            Hold::Held {
                token: 1,
                apply: Some((44, 30))
            }
        );
    }

    #[test]
    fn last_touch_wins_and_the_phone_does_not_take_it_back_by_renewing() {
        let now = t0();
        let mut s = Sizing::default();
        s.desktop_resized(DESK);
        s.hold(None, PHONE, DESK, now, 1);

        assert_eq!(s.reclaim(), Some(DESK));
        assert_eq!(s.hold(Some(1), PHONE, DESK, now, 9), Hold::Lost);
        // Opening Terminal again is a fresh touch, and it wins.
        assert!(matches!(
            s.hold(None, PHONE, DESK, now, 2),
            Hold::Held { token: 2, .. }
        ));
    }

    #[test]
    fn a_silent_phone_loses_the_pane_after_the_lease() {
        let now = t0();
        let mut s = Sizing::default();
        s.desktop_resized(DESK);
        s.hold(None, PHONE, DESK, now, 1);

        assert_eq!(s.expire(now + LEASE_TTL - Duration::from_secs(1)), None);
        assert_eq!(s.expire(now + LEASE_TTL), Some(DESK));
        assert_eq!(s.hold(Some(1), PHONE, DESK, now + LEASE_TTL, 9), Hold::Lost);
    }

    #[test]
    fn a_renewal_after_expiry_but_before_the_sweep_is_still_lost() {
        let now = t0();
        let mut s = Sizing::default();
        s.hold(None, PHONE, DESK, now, 1);
        assert_eq!(s.hold(Some(1), PHONE, DESK, now + LEASE_TTL, 9), Hold::Lost);
    }

    #[test]
    fn reclaim_with_nobody_holding_changes_nothing() {
        let mut s = Sizing::default();
        s.desktop_resized(DESK);
        assert_eq!(s.reclaim(), None);
    }

    #[test]
    fn reports_are_told_from_people() {
        for report in [
            "\x1b[12;40R",
            "\x1b[I",
            "\x1b[O",
            "\x1b[?1;2c",
            "\x1b[>0;276;0c",
            "\x1b]11;rgb:1212/1212/1414\x1b\\",
            "\x1bP1$r0m\x1b\\",
            "\x1b[?2004;1$y",
        ] {
            assert!(is_terminal_report(report), "{report:?}");
        }
        for person in [
            "a",
            "\r",
            "\x1b",
            "\x1b[A",
            "\x1b[<0;10;5M",
            "\x1b[200~hi\x1b[201~",
            "\x03",
            "\x1b[3~",
        ] {
            assert!(!is_terminal_report(person), "{person:?}");
        }
    }

    #[test]
    fn a_pointer_passing_over_the_pane_is_not_a_person() {
        // Hover: motion with no button, plain and with modifiers, SGR and legacy, one or a burst.
        for hover in [
            "\x1b[<35;22;15M",
            "\x1b[<39;1;1M",
            "\x1b[<35;22;15M\x1b[<35;23;15M",
            "\x1b[MC!!",
        ] {
            assert!(is_terminal_report(hover), "{hover:?}");
        }
        // A person: press, release, drag with a button down, the wheel, a burst that ends in a press.
        for person in [
            "\x1b[<0;22;15M",
            "\x1b[<0;22;15m",
            "\x1b[<32;22;15M",
            "\x1b[<64;22;15M",
            "\x1b[<35;22;15M\x1b[<0;22;15M",
            "\x1b[M !!",
        ] {
            assert!(!is_terminal_report(person), "{person:?}");
        }
    }
}
