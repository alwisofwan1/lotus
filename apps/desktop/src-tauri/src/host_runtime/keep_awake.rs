//! Holds idle sleep off while Mobile Access is on.
//!
//! **Why this exists.** A phone reaches this machine only while the host runtime is
//! answering, and a sleeping Mac answers nothing. Until now Lotus had no mitigation at
//! all for that — no `caffeinate`, no `IOPMAssertion`, nothing — so the whole remote
//! story quietly depended on the operator never letting the laptop idle out. From the
//! phone that failure is indistinguishable from a dead tailnet or a stopped host, which
//! is the expensive kind of ambiguity `plans/lotus-pocket/issues/02` was written to
//! remove.
//!
//! **What it actually buys, and what it does not.** The hold is
//! `PreventUserIdleSystemSleep` — verified by running `caffeinate -i` and reading
//! `pmset -g assertions`, which also reports `PreventSystemSleep 0`. So: a laptop left
//! open and untouched stays up. **Closing the lid still sleeps it.** No user-space
//! assertion prevents clamshell sleep, so promising otherwise in the UI would be a lie
//! the operator only discovers from a phone that has gone silent.
//!
//! `caffeinate` rather than linking IOKit because it is a first-party tool present on
//! every macOS, and `-w <pid>` gives the property that matters most: if Lotus dies
//! abnormally, the assertion goes with it instead of orphaning a process that keeps the
//! machine awake forever with nothing left to explain why.

use std::io;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Outcome of one attempt to hold sleep off. Carried rather than swallowed so the
/// caller can say which of the four happened — "no hold" and "hold failed" need
/// different words, and neither is an error worth failing `apply()` over.
///
/// Tagged like `HostRuntimeStatus` because it crosses to the frontend the same way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SleepHoldState {
    /// Idle sleep is held off right now.
    Holding,
    /// Nothing is being held, and nothing is meant to be.
    Released,
    /// This platform has no implementation here; the machine sleeps as usual.
    Unsupported,
    /// Tried and failed. The reason is the only diagnostic the operator gets.
    Failed { reason: String },
}

/// Takes and drops the platform's sleep hold. A trait so the policy in [`KeepAwake`]
/// is testable without a real assertion — the same reason `Spawner` exists.
pub trait SleepBlocker: Send + Sync + 'static {
    /// Take a hold. `Ok(None)` means this platform cannot, which is not a failure.
    fn engage(&self) -> io::Result<Option<Box<dyn SleepHold>>>;
}

/// A live hold. Dropping it must release, so a panic cannot leave the machine awake.
pub trait SleepHold: Send + Sync {}

/// Owns at most one hold and keeps it in step with whether Mobile Access is on.
pub struct KeepAwake {
    blocker: Box<dyn SleepBlocker>,
    state: Mutex<Option<Box<dyn SleepHold>>>,
    last: Mutex<SleepHoldState>,
}

impl KeepAwake {
    pub fn new(blocker: Box<dyn SleepBlocker>) -> Self {
        Self {
            blocker,
            state: Mutex::new(None),
            last: Mutex::new(SleepHoldState::Released),
        }
    }

    /// The production wiring: `caffeinate` on macOS, nothing anywhere else.
    pub fn build_default() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::new(Box::new(CaffeinateBlocker))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self::new(Box::new(UnsupportedBlocker))
        }
    }

    /// Make reality match `wanted`, and report what reality now is.
    ///
    /// Idempotent in both directions: this is called from `apply()`, which the settings
    /// UI invokes on every save, so re-engaging an existing hold must not stack a second
    /// `caffeinate` — two holds mean one leaks the moment the other is released.
    pub fn sync(&self, wanted: bool) -> SleepHoldState {
        let mut held = self.state.lock().unwrap();
        let outcome = match (wanted, held.is_some()) {
            (true, true) => SleepHoldState::Holding,
            (false, false) => SleepHoldState::Released,
            (false, true) => {
                // Dropping the hold is what releases it — see `SleepHold`.
                *held = None;
                SleepHoldState::Released
            }
            (true, false) => match self.blocker.engage() {
                Ok(Some(hold)) => {
                    *held = Some(hold);
                    SleepHoldState::Holding
                }
                Ok(None) => SleepHoldState::Unsupported,
                Err(e) => SleepHoldState::Failed {
                    reason: e.to_string(),
                },
            },
        };
        *self.last.lock().unwrap() = outcome.clone();
        outcome
    }

    /// Last outcome, for the status surface. Never re-attempts.
    pub fn state(&self) -> SleepHoldState {
        self.last.lock().unwrap().clone()
    }
}

// ─── macOS ───────────────────────────────────────────────────────────────────

/// Spawns `caffeinate -i -w <our pid>`.
///
/// `-i` and not `-s`: `-s` is honoured only on AC power, and a laptop carried out of the
/// house is exactly the case this feature exists for.
#[cfg(target_os = "macos")]
pub struct CaffeinateBlocker;

#[cfg(target_os = "macos")]
impl SleepBlocker for CaffeinateBlocker {
    fn engage(&self) -> io::Result<Option<Box<dyn SleepHold>>> {
        let child = std::process::Command::new("/usr/bin/caffeinate")
            .arg("-i")
            // The safety net, not the release mechanism: we kill it ourselves on
            // release, and this only covers Lotus exiting without getting the chance.
            .arg("-w")
            .arg(std::process::id().to_string())
            .stdin(std::process::Stdio::null())
            // Null, not piped. A piped stream nobody drains is the deadlock documented
            // on `drain_into_log`, and caffeinate has nothing to say anyway.
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;
        Ok(Some(Box::new(CaffeinateHold(child))))
    }
}

#[cfg(target_os = "macos")]
struct CaffeinateHold(std::process::Child);

#[cfg(target_os = "macos")]
impl SleepHold for CaffeinateHold {}

#[cfg(target_os = "macos")]
impl Drop for CaffeinateHold {
    fn drop(&mut self) {
        let _ = self.0.kill();
        // Reap it. Without this the released hold lingers as a zombie for the life of
        // the app, and a toggled setting would accumulate one per flip.
        let _ = self.0.wait();
    }
}

// ─── Everything else ─────────────────────────────────────────────────────────

/// Windows (`SetThreadExecutionState`) and Linux (`systemd-inhibit`) have equivalents;
/// neither is written because Pocket's remote story is being proven on macOS first.
/// Saying `Unsupported` out loud beats a silent no-op that reads as a working hold.
#[cfg(not(target_os = "macos"))]
pub struct UnsupportedBlocker;

#[cfg(not(target_os = "macos"))]
impl SleepBlocker for UnsupportedBlocker {
    fn engage(&self) -> io::Result<Option<Box<dyn SleepHold>>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[derive(Default)]
    struct Counts {
        engaged: AtomicU32,
        released: AtomicU32,
    }

    struct FakeHold(Arc<Counts>);

    impl SleepHold for FakeHold {}

    impl Drop for FakeHold {
        fn drop(&mut self) {
            self.0.released.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FakeBlocker {
        counts: Arc<Counts>,
        outcome: fn(&Arc<Counts>) -> io::Result<Option<Box<dyn SleepHold>>>,
    }

    impl SleepBlocker for FakeBlocker {
        fn engage(&self) -> io::Result<Option<Box<dyn SleepHold>>> {
            self.counts.engaged.fetch_add(1, Ordering::SeqCst);
            (self.outcome)(&self.counts)
        }
    }

    fn working() -> (KeepAwake, Arc<Counts>) {
        let counts = Arc::new(Counts::default());
        let blocker = FakeBlocker {
            counts: Arc::clone(&counts),
            outcome: |c| Ok(Some(Box::new(FakeHold(Arc::clone(c))))),
        };
        (KeepAwake::new(Box::new(blocker)), counts)
    }

    #[test]
    fn engages_when_mobile_access_turns_on() {
        let (keep, counts) = working();

        assert_eq!(keep.sync(true), SleepHoldState::Holding);
        assert_eq!(counts.engaged.load(Ordering::SeqCst), 1);
    }

    /// The settings UI calls `apply()` on every save, so this is the common path, and a
    /// second `caffeinate` per save is the bug it would produce.
    #[test]
    fn repeated_enable_holds_exactly_once() {
        let (keep, counts) = working();

        keep.sync(true);
        keep.sync(true);
        keep.sync(true);

        assert_eq!(counts.engaged.load(Ordering::SeqCst), 1);
        assert_eq!(counts.released.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn releases_when_mobile_access_turns_off() {
        let (keep, counts) = working();

        keep.sync(true);
        assert_eq!(keep.sync(false), SleepHoldState::Released);
        assert_eq!(counts.released.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn releasing_twice_releases_once() {
        let (keep, counts) = working();

        keep.sync(true);
        keep.sync(false);
        keep.sync(false);

        assert_eq!(counts.released.load(Ordering::SeqCst), 1);
    }

    /// Toggling must be able to hold again, not stay dead after the first release.
    #[test]
    fn re_enables_after_a_release() {
        let (keep, counts) = working();

        keep.sync(true);
        keep.sync(false);
        assert_eq!(keep.sync(true), SleepHoldState::Holding);
        assert_eq!(counts.engaged.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_platform_without_an_implementation_says_so() {
        let counts = Arc::new(Counts::default());
        let keep = KeepAwake::new(Box::new(FakeBlocker {
            counts: Arc::clone(&counts),
            outcome: |_| Ok(None),
        }));

        assert_eq!(keep.sync(true), SleepHoldState::Unsupported);
        // And it must keep saying so rather than reporting a hold it does not have.
        assert_eq!(keep.sync(true), SleepHoldState::Unsupported);
        assert_eq!(counts.engaged.load(Ordering::SeqCst), 2);
    }

    /// A hold that cannot be taken must not fail `apply()` — Mobile Access still works,
    /// it just sleeps. The reason is carried so the UI can name it.
    #[test]
    fn a_failed_hold_is_reported_not_thrown() {
        let counts = Arc::new(Counts::default());
        let keep = KeepAwake::new(Box::new(FakeBlocker {
            counts: Arc::clone(&counts),
            outcome: |_| {
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "caffeinate missing",
                ))
            },
        }));

        let outcome = keep.sync(true);

        assert!(
            matches!(outcome, SleepHoldState::Failed { ref reason } if reason.contains("caffeinate missing"))
        );
        assert_eq!(keep.state(), outcome);
    }

    #[test]
    fn state_starts_released_before_anything_is_synced() {
        let (keep, _) = working();

        assert_eq!(keep.state(), SleepHoldState::Released);
    }

    /// Mirrors `status_json_shape_is_pinned_for_the_frontend`: these strings are the
    /// contract `host-runtime.ts` reads, and a rename here breaks it silently.
    #[test]
    fn sleep_hold_json_shape_is_pinned_for_the_frontend() {
        let json = |s: &SleepHoldState| serde_json::to_string(s).unwrap();

        assert_eq!(json(&SleepHoldState::Holding), r#"{"kind":"holding"}"#);
        assert_eq!(json(&SleepHoldState::Released), r#"{"kind":"released"}"#);
        assert_eq!(
            json(&SleepHoldState::Unsupported),
            r#"{"kind":"unsupported"}"#
        );
        assert_eq!(
            json(&SleepHoldState::Failed {
                reason: "no caffeinate".into()
            }),
            r#"{"kind":"failed","reason":"no caffeinate"}"#
        );
    }

    /// The fakes above prove the policy and nothing about the machine. This one asks
    /// macOS itself whether an assertion exists, because "we spawned caffeinate" is not
    /// the same claim as "the laptop will stay awake" — and the second is the one the
    /// phone depends on.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_real_hold_registers_a_sleep_assertion_and_drops_it() {
        /// `pmset` names the watched pid on caffeinate's `Details:` line, which is what
        /// makes our own hold distinguishable from every other one on the machine.
        fn ours_is_asserting() -> bool {
            let out = std::process::Command::new("/usr/bin/pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset should exist on macOS");
            String::from_utf8_lossy(&out.stdout)
                .contains(&format!("on behalf of Process ID {}", std::process::id()))
        }

        fn settle(want: bool) -> bool {
            for _ in 0..50 {
                if ours_is_asserting() == want {
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            false
        }

        assert!(!ours_is_asserting(), "a previous test leaked a hold");

        let hold = CaffeinateBlocker
            .engage()
            .expect("spawn should succeed")
            .expect("macOS reports a hold, never None");
        assert!(settle(true), "no sleep assertion appeared for this process");

        drop(hold);
        assert!(
            settle(false),
            "the assertion outlived the hold that owns it"
        );
    }
}
