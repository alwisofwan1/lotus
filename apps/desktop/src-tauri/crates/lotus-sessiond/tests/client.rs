//! Starting and finding the real `lotus-sessiond` binary (PHASE-3 step 3). Run unsandboxed.
#![cfg(unix)]

use lotus_sessiond::client::{connect, connect_or_spawn, ConnectError};
use lotus_sessiond::proto::*;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

const BIN: &str = env!("CARGO_BIN_EXE_lotus-sessiond");
const WAIT: Duration = Duration::from_secs(3);

fn fresh_dir() -> PathBuf {
    static N: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "sdc-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

/// Kills the daemon when the test ends, pass or fail.
struct Daemon(u32);
impl Drop for Daemon {
    fn drop(&mut self) {
        unsafe { libc::kill(self.0 as i32, libc::SIGTERM) };
    }
}

fn alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[test]
fn nobody_listening_starts_a_detached_daemon_and_the_next_call_finds_it() {
    let socket = fresh_dir().join("sessiond.sock");
    let (_, pid) = connect_or_spawn(&socket, Path::new(BIN), WAIT).expect("spawn");
    let _guard = Daemon(pid);
    assert_ne!(pid, std::process::id());
    assert!(alive(pid));
    // Its own session: not in our process group, so our terminal's signals do not reach it.
    assert_eq!(unsafe { libc::getsid(pid as i32) }, pid as i32);

    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&socket), 0o600);
    assert_eq!(mode(socket.parent().unwrap()), 0o700);

    let (_, again) = connect_or_spawn(&socket, Path::new("/nonexistent"), WAIT).expect("reuse");
    assert_eq!(again, pid, "a second daemon was started");
}

#[test]
fn two_callers_racing_end_up_on_one_daemon() {
    let socket = fresh_dir().join("sessiond.sock");
    let handles: Vec<_> = (0..4)
        .map(|_| {
            let socket = socket.clone();
            std::thread::spawn(move || {
                connect_or_spawn(&socket, Path::new(BIN), WAIT).map(|(_, p)| p)
            })
        })
        .collect();
    let pids: Vec<u32> = handles
        .into_iter()
        .map(|h| h.join().unwrap().expect("connect"))
        .collect();
    let _guard = Daemon(pids[0]);
    assert!(pids.iter().all(|p| *p == pids[0]), "{pids:?}");
}

#[test]
fn a_stale_socket_file_from_a_dead_daemon_is_replaced() {
    let dir = fresh_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("sessiond.sock");
    drop(UnixListener::bind(&socket).unwrap()); // file stays, nobody listens
    assert!(matches!(connect(&socket), Err(ConnectError::Io(_))));

    let (_, pid) = connect_or_spawn(&socket, Path::new(BIN), WAIT).expect("spawn");
    let _guard = Daemon(pid);
    assert!(alive(pid));
}

#[test]
fn a_daemon_speaking_another_version_is_not_replaced_or_used() {
    let dir = fresh_dir();
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("sessiond.sock");
    let listener = UnixListener::bind(&socket).unwrap();
    std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let _: (Request, _) = read_frame(&mut s).unwrap();
        write_frame(
            &mut s,
            &Event::Hello {
                proto: 99,
                daemon_pid: 1,
                features: vec![],
            },
            b"",
        )
        .unwrap();
    });
    // A spawn attempt would fail on this path with Io, not Version.
    match connect_or_spawn(&socket, Path::new("/nonexistent"), WAIT) {
        Err(ConnectError::Version { daemon: 99 }) => {}
        other => panic!("expected Version, got {:?}", other.map(|(_, p)| p)),
    }
}

#[test]
fn a_socket_dir_owned_by_someone_else_is_refused() {
    // Not root here, so "someone else" is simulated by a dir we cannot chmod: `/`'s owner is root.
    let err = lotus_sessiond::client::prepare_socket_dir(Path::new("/")).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::PermissionDenied);
}

#[test]
fn a_loose_socket_dir_is_tightened_to_0700() {
    let dir = fresh_dir();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    lotus_sessiond::client::prepare_socket_dir(&dir).unwrap();
    assert_eq!(
        std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
        0o700
    );
}

/// Live launchd check (macOS, unsandboxed): `cargo test --test client -- --ignored launchd`.
/// The job's process forks the daemon and the job is unloaded: nothing left for launchd to
/// attribute to the app, and the daemon lives on with launchd as its parent.
#[cfg(target_os = "macos")]
#[test]
#[ignore]
fn a_bundled_daemon_outlives_its_unloaded_launchd_job() {
    let root = fresh_dir();
    let bin_dir = root.join("T.app/Contents/MacOS");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let bin = bin_dir.join("lotus-sessiond");
    std::fs::copy(BIN, &bin).unwrap();
    let socket = root.join("s/sessiond.sock");
    let label = lotus_sessiond::client::launchd::label(&socket);
    let target = format!("gui/{}/{label}", unsafe { libc::getuid() });
    let loaded = || {
        std::process::Command::new("/bin/launchctl")
            .args(["print", &target])
            .output()
            .unwrap()
            .status
            .success()
    };

    let (_, pid) = connect_or_spawn(&socket, &bin, Duration::from_secs(10)).expect("spawn");
    let _guard = Daemon(pid);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while loaded() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(!loaded(), "job {label} still loaded");
    std::thread::sleep(Duration::from_millis(500));
    assert!(alive(pid), "unloading the job took the daemon with it");
    let ppid = std::process::Command::new("/bin/ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&ppid.stdout).trim(), "1");
    let (_, again) = connect(&socket).expect("still serving");
    assert_eq!(again, pid);
}
