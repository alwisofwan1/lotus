//! Mutes the Mac's sound output while the user dictates, so music or a video does not play over
//! them, and puts it back afterwards. It only undoes its own mute: output that was already muted
//! stays muted.
//!
//! `osascript` takes 0.4–1 s, so the work runs off the caller's thread. Requests record the wanted
//! state first and each worker acts on the latest one, so a quick on→off can never end muted.

use std::sync::Mutex;

struct Duck {
    want: bool,
    /// We muted the output and owe an unmute.
    ours: bool,
}

static STATE: Mutex<Duck> = Mutex::new(Duck { want: false, ours: false });
/// One `osascript` at a time, in request order of the wanted state.
static WORK: Mutex<()> = Mutex::new(());

pub fn request(on: bool) {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).want = on;
    std::thread::spawn(settle);
}

/// On quit: never leave the user's Mac silent.
pub fn restore() {
    STATE.lock().unwrap_or_else(|e| e.into_inner()).want = false;
    settle();
}

fn settle() {
    let _work = WORK.lock().unwrap_or_else(|e| e.into_inner());
    let (want, ours) = {
        let s = STATE.lock().unwrap_or_else(|e| e.into_inner());
        (s.want, s.ours)
    };
    let ours = step(want, ours, mute, unmute);
    STATE.lock().unwrap_or_else(|e| e.into_inner()).ours = ours;
}

/// The decision, apart from the system call. `mute` returns whether output was already muted
/// (None = it failed). Returns whether we now owe an unmute.
fn step(want: bool, ours: bool, mute: impl FnOnce() -> Option<bool>, unmute: impl FnOnce()) -> bool {
    if want && !ours {
        return mute() == Some(false);
    }
    if !want && ours {
        unmute();
        return false;
    }
    ours
}

#[cfg(target_os = "macos")]
fn osascript(lines: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new("/usr/bin/osascript");
    for line in lines {
        cmd.arg("-e").arg(line);
    }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(target_os = "macos")]
fn mute() -> Option<bool> {
    let was = osascript(&[
        "set m to output muted of (get volume settings)",
        "set volume with output muted",
        "return m",
    ])?;
    Some(was == "true")
}

#[cfg(target_os = "macos")]
fn unmute() {
    let _ = osascript(&["set volume without output muted"]);
}

#[cfg(not(target_os = "macos"))]
fn mute() -> Option<bool> {
    None
}

#[cfg(not(target_os = "macos"))]
fn unmute() {}

#[cfg(test)]
mod tests {
    use super::step;
    use std::cell::Cell;

    #[test]
    fn mutes_and_owes_an_unmute_only_when_output_was_playing() {
        assert!(step(true, false, || Some(false), || panic!("no unmute")));
        assert!(!step(true, false, || Some(true), || panic!("no unmute")));
        assert!(!step(true, false, || None, || panic!("no unmute")));
    }

    #[test]
    fn unmutes_only_what_it_muted() {
        let unmuted = Cell::new(false);
        assert!(!step(false, true, || panic!("no mute"), || unmuted.set(true)));
        assert!(unmuted.get());
        assert!(!step(false, false, || panic!("no mute"), || panic!("no unmute")));
    }

    #[test]
    fn a_repeated_request_does_nothing() {
        assert!(step(true, true, || panic!("no mute"), || panic!("no unmute")));
    }
}
