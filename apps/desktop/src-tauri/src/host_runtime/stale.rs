//! Reaps a host runtime that outlived the app that spawned it.
//!
//! The supervisor kills its own child on `stop()`, but nothing protects against the
//! parent dying abnormally — `tauri dev` restarting, a SIGKILL, a crash. The child is
//! then reparented to init and keeps the mobile port bound, so the *next* run fails to
//! listen. Observed exactly once and it cost a debugging round: the new façade threw
//! EADDRINUSE on 8787 while `ps` showed the old runtime with PPID 1.
//!
//! The information needed was already on disk: the child writes `{port, pid, host}` to
//! its advert file. Nothing read the pid until now.

use crate::no_window::NoWindow;
use std::path::Path;

use super::admin_client::{read_advert, AdminAdvert};

/// Process operations, injected so the decision is testable without killing anything.
pub trait ProcessOps {
    fn is_alive(&self, pid: u32) -> bool;
    fn terminate(&self, pid: u32);
    fn kill(&self, pid: u32);

    /// The pid's parent, or `None` when it cannot be read. Injected like the rest so
    /// the ownership decision below is testable without orphaning a real process.
    fn parent_of(&self, pid: u32) -> Option<u32>;
}

/// The reaper of last resort — `launchd` on macOS, `init` on Linux.
/// A runtime whose parent is this and nothing else is one that outlived its app.
///
/// **Not every orphan lands here, and on Linux most do not.** A session with a child
/// subreaper adopts its own orphans before pid 1 ever sees them, and `systemd --user`
/// sets exactly that in an ordinary desktop session — so an orphaned host runtime is
/// reparented to the user manager, the guard below reads a living parent, and the port
/// stays held. That is the failure this module exists to prevent, silently back on Linux.
///
/// Left as it is deliberately rather than widened on a guess: the loosened predicate that
/// would catch it can also catch a host the operator started by hand, and trading a held
/// port for killing somebody's process is not a trade to make from reasoning alone. It
/// needs a probe on a real Linux session first —
/// `plans/pocket-without-laptop/issues/19-reaper-diam-di-linux-ber-subreaper.md`.
pub const INIT_PID: u32 = 1;

/// What the reaper did, for logging and for tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reaped {
    /// No advert, or one that named a process that is already gone.
    Nothing,
    /// The named process was alive and has been asked to stop.
    Terminated { pid: u32 },
    /// It ignored SIGTERM and was killed.
    Killed { pid: u32 },
}

/// Stops a previous host runtime named by the advert at `path`, if it is still alive.
///
/// `wait` is called between the polite signal and the blunt one, so the caller decides
/// how long to be patient (and a test decides not to wait at all).
pub fn reap_stale_runtime<P: ProcessOps>(path: &Path, ops: &P, mut wait: impl FnMut()) -> Reaped {
    let Ok(AdminAdvert { pid, .. }) = read_advert(path) else {
        return Reaped::Nothing;
    };

    // Our own pid would mean the advert belongs to this process — never signal that.
    if pid == std::process::id() || !ops.is_alive(pid) {
        return Reaped::Nothing;
    }

    // **Orphaned, not merely alive.** The advert is shared state: any host runtime
    // writing to this state dir overwrites it, including one an operator started by
    // hand from `packages/host`. Liveness alone therefore identified "some host is
    // running", not "our host was orphaned", and the two are only the same on a
    // machine with nothing else on it. A process that still has a living parent is
    // somebody's child and none of our business — even if it is holding the port,
    // because then the honest failure is EADDRINUSE and a message, not a silent kill.
    if ops.parent_of(pid) != Some(INIT_PID) {
        return Reaped::Nothing;
    }

    ops.terminate(pid);
    wait();

    if ops.is_alive(pid) {
        ops.kill(pid);
        return Reaped::Killed { pid };
    }
    Reaped::Terminated { pid }
}

/// Real signals, via libc. `kill(pid, 0)` is the portable liveness probe: it performs
/// permission checks and returns ESRCH for a pid that no longer exists.
pub struct RealProcessOps;

impl ProcessOps for RealProcessOps {
    #[cfg(unix)]
    fn is_alive(&self, pid: u32) -> bool {
        // SAFETY: signal 0 sends nothing; it only reports whether the pid is signalable.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    // No signals on Windows: ask tasklist / taskkill instead.
    #[cfg(windows)]
    fn is_alive(&self, pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .no_window()
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
            .unwrap_or(false)
    }

    #[cfg(windows)]
    fn terminate(&self, pid: u32) {
        let _ = std::process::Command::new("taskkill").no_window().args(["/PID", &pid.to_string()]).output();
    }

    #[cfg(windows)]
    fn kill(&self, pid: u32) {
        let _ = std::process::Command::new("taskkill").no_window().args(["/F", "/PID", &pid.to_string()]).output();
    }

    #[cfg(unix)]
    fn terminate(&self, pid: u32) {
        // SAFETY: SIGTERM to a pid we already probed. A race where the pid was recycled
        // is possible in principle; the advert is written by our own child seconds
        // earlier, so the window is not one worth trading correctness elsewhere for.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }

    #[cfg(unix)]
    fn kill(&self, pid: u32) {
        // SAFETY: same as above, with the signal that cannot be ignored.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }

    /// Via `ps`, for the same reason `keep_awake.rs` shells out to `caffeinate`: it is
    /// a first-party tool present on every macOS, where the alternative is a `sysctl`
    /// dance with `kinfo_proc` for one integer. This runs once per `apply()`, so the
    /// cost of a process is not worth the unsafe.
    ///
    /// `None` on any failure, and the caller treats that as "not ours" — the safe
    /// direction, since the only action on the other branch is a kill.
    fn parent_of(&self, pid: u32) -> Option<u32> {
        let out = std::process::Command::new("ps")
            .no_window()
            .args(["-o", "ppid=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use tempfile::TempDir;

    struct FakeOps {
        alive: RefCell<Vec<u32>>,
        signals: RefCell<Vec<(u32, &'static str)>>,
        /// Whether SIGTERM actually works on this fake process.
        obeys_term: bool,
        /// pid → parent pid. Absent means orphaned, which is what `parent_of`
        /// reports for a process reparented to init.
        parents: RefCell<Vec<(u32, u32)>>,
    }

    impl FakeOps {
        fn new(alive: &[u32], obeys_term: bool) -> Self {
            Self {
                alive: RefCell::new(alive.to_vec()),
                signals: RefCell::new(Vec::new()),
                obeys_term,
                parents: RefCell::new(Vec::new()),
            }
        }

        /// Gives a pid a living parent, i.e. makes it somebody's child rather than
        /// an orphan.
        fn parented(self, pid: u32, parent: u32) -> Self {
            self.parents.borrow_mut().push((pid, parent));
            self
        }
    }

    impl ProcessOps for FakeOps {
        fn is_alive(&self, pid: u32) -> bool {
            self.alive.borrow().contains(&pid)
        }

        fn terminate(&self, pid: u32) {
            self.signals.borrow_mut().push((pid, "term"));
            if self.obeys_term {
                self.alive.borrow_mut().retain(|p| *p != pid);
            }
        }

        fn kill(&self, pid: u32) {
            self.signals.borrow_mut().push((pid, "kill"));
            self.alive.borrow_mut().retain(|p| *p != pid);
        }

        fn parent_of(&self, pid: u32) -> Option<u32> {
            self.parents
                .borrow()
                .iter()
                .find(|(p, _)| *p == pid)
                .map(|(_, parent)| *parent)
                .or(Some(INIT_PID))
        }
    }

    fn advert(dir: &TempDir, pid: u32) -> std::path::PathBuf {
        let path = dir.path().join("mobile-admin.json");
        std::fs::write(
            &path,
            format!(r#"{{"port":8787,"pid":{pid},"host":"127.0.0.1"}}"#),
        )
        .unwrap();
        path
    }

    #[test]
    fn no_advert_means_nothing_to_reap() {
        let dir = TempDir::new().unwrap();
        let ops = FakeOps::new(&[], true);

        let reaped = reap_stale_runtime(&dir.path().join("absent.json"), &ops, || {});

        assert_eq!(reaped, Reaped::Nothing);
        assert!(ops.signals.borrow().is_empty());
    }

    #[test]
    fn an_advert_naming_a_dead_process_is_left_alone() {
        let dir = TempDir::new().unwrap();
        let path = advert(&dir, 999_999);
        let ops = FakeOps::new(&[], true);

        assert_eq!(reap_stale_runtime(&path, &ops, || {}), Reaped::Nothing);
        assert!(ops.signals.borrow().is_empty());
    }

    /// The case that cost a debugging round: the previous runtime is alive with PPID 1,
    /// still holding the mobile port.
    #[test]
    fn a_live_orphan_is_asked_to_stop() {
        let dir = TempDir::new().unwrap();
        let path = advert(&dir, 45_160);
        let ops = FakeOps::new(&[45_160], true);

        assert_eq!(
            reap_stale_runtime(&path, &ops, || {}),
            Reaped::Terminated { pid: 45_160 }
        );
        assert_eq!(*ops.signals.borrow(), vec![(45_160, "term")]);
    }

    #[test]
    fn one_that_ignores_sigterm_is_killed() {
        let dir = TempDir::new().unwrap();
        let path = advert(&dir, 45_160);
        let ops = FakeOps::new(&[45_160], false);

        assert_eq!(
            reap_stale_runtime(&path, &ops, || {}),
            Reaped::Killed { pid: 45_160 }
        );
        assert_eq!(
            *ops.signals.borrow(),
            vec![(45_160, "term"), (45_160, "kill")]
        );
    }

    /// A stale advert that happens to name *this* process would otherwise make the app
    /// signal itself — the one pid that must never be reaped.
    #[test]
    fn our_own_pid_is_never_signalled() {
        let dir = TempDir::new().unwrap();
        let path = advert(&dir, std::process::id());
        let ops = FakeOps::new(&[std::process::id()], true);

        assert_eq!(reap_stale_runtime(&path, &ops, || {}), Reaped::Nothing);
        assert!(ops.signals.borrow().is_empty());
    }

    /// The bug this guard was missing until 2026-09-08.
    ///
    /// The advert is written by whichever host runtime started last, and on a
    /// developer's machine that is often **not** this app's child — a
    /// `bun run start` from `packages/host` writes it too, into the same state dir.
    /// Reaping on liveness alone therefore killed a process the app never spawned,
    /// on the next settings save, with nothing on screen to connect the two.
    ///
    /// Observed exactly that way: `mobile-admin.json` named pid 33135, whose parent
    /// was a live `bun run start` (33133), not init.
    #[test]
    fn a_process_with_a_living_parent_belongs_to_someone_else() {
        let dir = TempDir::new().unwrap();
        let path = advert(&dir, 33135);
        let ops = FakeOps::new(&[33135], true).parented(33135, 33133);

        assert_eq!(reap_stale_runtime(&path, &ops, || {}), Reaped::Nothing);
        assert!(
            ops.signals.borrow().is_empty(),
            "a process this app did not orphan must not be signalled at all"
        );
    }

    /// And the case the reaper exists for is unchanged: a child reparented to init
    /// is one this app spawned and then lost, so it is ours to clean up.
    #[test]
    fn a_process_reparented_to_init_is_still_reaped() {
        let dir = TempDir::new().unwrap();
        let path = advert(&dir, 4242);
        let ops = FakeOps::new(&[4242], true);

        assert_eq!(
            reap_stale_runtime(&path, &ops, || {}),
            Reaped::Terminated { pid: 4242 }
        );
    }
}
