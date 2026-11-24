//! Startup sweep for processes a previous Lotus left behind.
//!
//! `terminate_session` kills a pane's process tree when the pane closes, and `RunEvent::Exit`
//! now does the same for every pane. Neither runs when Lotus dies without a clean exit — a
//! crash, a force-quit, or Ctrl-C on `tauri dev`, which is the common case in development. The
//! PTY master then closes, the shell dies, and anything that ignores SIGHUP is reparented to
//! launchd with no terminal. A TUI in that state can spin on the dead TTY forever: measured
//! 2026-09-25, five `opencode` processes sat at 100% CPU each for 2.5 days. macOS keeps
//! billing them to Lotus (they inherit `__CFBundleIdentifier`), so Activity Monitor showed
//! Lotus as the machine's top energy user.
//!
//! Every PTY child is stamped with `LOTUS_PTY_OWNER_PID`. A process is reaped only when ALL hold:
//!
//! - its parent is launchd (pid 1) — it is an orphan, not part of a live pane;
//! - it has no controlling terminal — its PTY is gone;
//! - its `LOTUS_PTY_OWNER_PID` names a process that is no longer running, and is not us;
//! - it burned at least [`BUSY_CPU_FRACTION`] of one core across the sample window.
//!
//! The busy check is what spares deliberate daemons started from a pane (a tmux server, a
//! background worker): they are orphans with no TTY too, but they sit idle. The harm this
//! sweep exists to stop is CPU, so CPU is the deciding signal.

use crate::no_window::NoWindow;
use std::collections::HashMap;
use std::process::Command;
use std::time::Duration;

/// The env var that ties a PTY child back to the Lotus process that spawned it.
pub(crate) const OWNER_PID_ENV: &str = "LOTUS_PTY_OWNER_PID";

/// Fraction of one core an orphan must use across the sample to count as runaway.
///
/// Low on purpose: a runaway competes for cores like everything else, and on a loaded machine
/// (load average 55 on 10 cores, measured 2026-09-25) a pure spin loop got only ~40% of one.
/// Idle daemons sit near 0%, so the margin on that side stays wide.
const BUSY_CPU_FRACTION: f64 = 0.25;

const SAMPLE_WINDOW: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq)]
struct ProcessRow {
    pid: i32,
    parent_pid: i32,
    has_tty: bool,
    cpu_seconds: f64,
    owner_pid: Option<i32>,
}

/// Parses one line of `ps -A -ww -E -o pid=,ppid=,tty=,time=,command=`.
fn parse_row(line: &str) -> Option<ProcessRow> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    let parent_pid = fields.next()?.parse().ok()?;
    let tty = fields.next()?;
    let cpu_seconds = parse_cpu_time(fields.next()?)?;
    let prefix = format!("{OWNER_PID_ENV}=");
    let owner_pid = fields
        .find_map(|token| token.strip_prefix(prefix.as_str()))
        .and_then(|value| value.parse().ok());
    Some(ProcessRow {
        pid,
        parent_pid,
        has_tty: tty != "??" && tty != "-",
        cpu_seconds,
        owner_pid,
    })
}

/// `ps` prints cumulative CPU as `[dd-][hh:]mm:ss[.ss]`.
fn parse_cpu_time(value: &str) -> Option<f64> {
    let (days, clock) = match value.split_once('-') {
        Some((days, rest)) => (days.parse::<f64>().ok()?, rest),
        None => (0.0, value),
    };
    let mut seconds = 0.0;
    for part in clock.split(':') {
        seconds = seconds * 60.0 + part.parse::<f64>().ok()?;
    }
    Some(days * 86_400.0 + seconds)
}

/// Orphans of a dead Lotus, before the busy check.
fn stranded(rows: &[ProcessRow], current_pid: i32, is_alive: impl Fn(i32) -> bool) -> Vec<i32> {
    rows.iter()
        .filter(|row| row.parent_pid == 1 && !row.has_tty)
        .filter(|row| match row.owner_pid {
            Some(owner) => owner != current_pid && !is_alive(owner),
            None => false,
        })
        .map(|row| row.pid)
        .collect()
}

/// The stranded pids that also burned CPU between the two snapshots.
fn runaway(
    candidates: &[i32],
    before: &HashMap<i32, f64>,
    after: &[ProcessRow],
    window: Duration,
) -> Vec<i32> {
    let threshold = window.as_secs_f64() * BUSY_CPU_FRACTION;
    after
        .iter()
        .filter(|row| candidates.contains(&row.pid))
        .filter(|row| {
            before
                .get(&row.pid)
                .is_some_and(|start| row.cpu_seconds - start >= threshold)
        })
        .map(|row| row.pid)
        .collect()
}

fn snapshot() -> Vec<ProcessRow> {
    let Ok(output) = Command::new("ps")
        .no_window()
        .args(["-A", "-ww", "-E", "-o", "pid=,ppid=,tty=,time=,command="])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_row)
        .collect()
}

#[cfg(unix)]
fn is_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence and permission; it delivers nothing.
    if unsafe { libc::kill(pid, 0) } == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Finds and kills runaway orphans. Blocks for [`SAMPLE_WINDOW`], so call it off the main thread.
#[cfg(unix)]
pub(crate) fn reap_stranded_orphans() -> Vec<i32> {
    let current_pid = std::process::id() as i32;
    let first = snapshot();
    let candidates = stranded(&first, current_pid, is_alive);
    if candidates.is_empty() {
        return Vec::new();
    }
    let before: HashMap<i32, f64> = first
        .iter()
        .filter(|row| candidates.contains(&row.pid))
        .map(|row| (row.pid, row.cpu_seconds))
        .collect();
    std::thread::sleep(SAMPLE_WINDOW);
    let victims = runaway(&candidates, &before, &snapshot(), SAMPLE_WINDOW);
    for pid in &victims {
        // Each victim is a leaf that ignored SIGHUP; its own children, if any, follow it.
        super::process_tree::terminate_process_tree(*pid as u32, Duration::from_millis(500));
        eprintln!("[pty] reaped runaway orphan pid={pid} left by a previous Lotus");
    }
    victims
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: i32, parent_pid: i32, has_tty: bool, owner_pid: Option<i32>) -> ProcessRow {
        ProcessRow {
            pid,
            parent_pid,
            has_tty,
            cpu_seconds: 0.0,
            owner_pid,
        }
    }

    #[test]
    fn parses_the_ps_line_of_a_real_runaway() {
        let line = "27709     1 ??       1984:16.83 opencode CARGO=/x LOTUS_PANE_ID=abc LOTUS_PTY_OWNER_PID=55903 TERM=xterm-256color";
        assert_eq!(
            parse_row(line),
            Some(ProcessRow {
                pid: 27709,
                parent_pid: 1,
                has_tty: false,
                cpu_seconds: 1984.0 * 60.0 + 16.83,
                owner_pid: Some(55903),
            })
        );
    }

    #[test]
    fn a_process_without_the_marker_has_no_owner() {
        let line = "74345     1 ??         4:46.02 bun worker LOTUS_PANE_ID=abc";
        assert_eq!(parse_row(line).unwrap().owner_pid, None);
    }

    #[test]
    fn parses_cpu_time_with_hours_and_days() {
        assert_eq!(parse_cpu_time("0:01.50"), Some(1.5));
        assert_eq!(parse_cpu_time("1:02:03"), Some(3723.0));
        assert_eq!(parse_cpu_time("2-00:00:01"), Some(172_801.0));
        assert_eq!(parse_cpu_time("junk"), None);
    }

    #[test]
    fn only_ttyless_orphans_of_a_dead_other_lotus_are_stranded() {
        let dead_owner = 500;
        let live_owner = 600;
        let us = 700;
        let rows = [
            row(1, 1, false, Some(dead_owner)),  // stranded
            row(2, 42, false, Some(dead_owner)), // still has a parent: part of a live tree
            row(3, 1, true, Some(dead_owner)),   // still has a terminal
            row(4, 1, false, Some(live_owner)),  // its Lotus is still running
            row(5, 1, false, Some(us)),          // ours
            row(6, 1, false, None),              // not from a Lotus PTY
        ];
        let alive = |pid: i32| pid == live_owner || pid == us;
        assert_eq!(stranded(&rows, us, alive), vec![1]);
    }

    #[test]
    fn idle_orphans_are_spared_and_busy_ones_are_not() {
        let window = Duration::from_secs(2);
        let before = HashMap::from([(10, 100.0), (11, 100.0), (12, 100.0)]);
        let mut busy = row(10, 1, false, Some(1));
        busy.cpu_seconds = 102.0; // one full core
        let mut idle = row(11, 1, false, Some(1));
        idle.cpu_seconds = 100.1;
        let mut not_a_candidate = row(12, 1, false, Some(1));
        not_a_candidate.cpu_seconds = 110.0;
        let after = [busy, idle, not_a_candidate];
        assert_eq!(runaway(&[10, 11], &before, &after, window), vec![10]);
    }

    const HELPER_MODE_ENV: &str = "LOTUS_ORPHAN_REAPER_TEST_MODE";

    /// Not a test: the body the end-to-end test below runs as its orphans. It re-runs this test
    /// binary rather than `sh`/`sleep`, because macOS hides the environment of Apple platform
    /// binaries from `ps`, which would make the marker invisible. Real runaways (`opencode`,
    /// `node`, `bun`, `claude`) are third-party binaries, whose environment `ps` does show.
    #[test]
    #[ignore]
    fn orphan_helper() {
        match std::env::var(HELPER_MODE_ENV).as_deref() {
            Ok("spin") => loop {
                std::hint::spin_loop();
            },
            Ok("idle") => std::thread::sleep(Duration::from_secs(60)),
            _ => {}
        }
    }

    /// End to end against the real process table: a CPU-spinning orphan with no terminal, whose
    /// owner is dead, is killed; an idle one with the same shape survives.
    #[test]
    fn reaps_a_real_spinning_orphan_and_spares_an_idle_one() {
        use std::os::unix::process::CommandExt;
        let _serial = crate::pty::PROCESS_KILL_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        let mut gone = Command::new("/usr/bin/true").spawn().expect("spawn true");
        let dead_owner = gone.id();
        gone.wait().expect("wait true");

        let exe = std::env::current_exe().expect("test binary path");
        let helper = "\"$EXE\" --ignored --exact pty::orphan_reaper::tests::orphan_helper \
                      </dev/null >/dev/null 2>&1";
        // setsid drops the controlling terminal; the outer sh exits at once, so both
        // background children are reparented to launchd.
        let mut outer = Command::new("/bin/sh");
        outer
            .args([
                "-c",
                &format!(
                    "{HELPER_MODE_ENV}=spin {helper} & echo $!; {HELPER_MODE_ENV}=idle {helper} & echo $!"
                ),
            ])
            .env("EXE", exe)
            .env(OWNER_PID_ENV, dead_owner.to_string());
        // SAFETY: setsid is async-signal-safe and touches no parent state.
        unsafe {
            outer.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let output = outer.output().expect("spawn orphans");
        let pids: Vec<i32> = String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect();
        let [spinner, sleeper] = pids[..] else {
            panic!("expected two pids, got {pids:?}");
        };
        // A debug test binary is large and slow to load; wait until the spinner is really
        // spinning so the sample measures the loop, not the loader.
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(20) {
            let cpu = snapshot()
                .into_iter()
                .find(|row| row.pid == spinner)
                .map_or(0.0, |row| row.cpu_seconds);
            if cpu >= 0.5 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let reaped = reap_stranded_orphans();
        let spinner_alive = is_alive(spinner);
        let sleeper_alive = is_alive(sleeper);
        // Clean up before asserting so a failing run cannot leak the spinner it tests for.
        unsafe {
            libc::kill(spinner, libc::SIGKILL);
            libc::kill(sleeper, libc::SIGKILL);
        }

        assert!(reaped.contains(&spinner), "spinner {spinner} not reaped: {reaped:?}");
        assert!(!reaped.contains(&sleeper), "idle orphan {sleeper} was reaped");
        assert!(!spinner_alive, "spinner {spinner} still running");
        assert!(sleeper_alive, "idle orphan {sleeper} was killed");
    }

    #[test]
    fn an_orphan_that_appeared_after_the_first_snapshot_is_not_reaped() {
        let mut fresh = row(20, 1, false, Some(1));
        fresh.cpu_seconds = 50.0;
        assert!(runaway(&[20], &HashMap::new(), &[fresh], Duration::from_secs(2)).is_empty());
    }
}
