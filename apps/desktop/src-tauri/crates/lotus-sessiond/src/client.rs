//! Finding the daemon: socket path, connect, start it when nobody is listening, `hello`.

use crate::proto::*;
use std::fs::OpenOptions;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// `sun_path` is 104 bytes on macOS, NUL included.
pub const MAX_SOCKET_PATH: usize = 103;
pub const SOCKET_NAME: &str = "sessiond.sock";

/// `<state dir>/sessiond.sock`, or `/tmp/lotus-<uid>/sessiond.sock` when that is too long to bind.
pub fn socket_path(state_dir: &Path, uid: u32) -> PathBuf {
    let preferred = state_dir.join(SOCKET_NAME);
    if preferred.as_os_str().len() <= MAX_SOCKET_PATH {
        preferred
    } else {
        PathBuf::from(format!("/tmp/lotus-{uid}")).join(SOCKET_NAME)
    }
}

#[derive(Debug)]
pub enum ConnectError {
    Io(io::Error),
    /// The daemon speaks another protocol; the caller falls back to in-process PTYs.
    Version {
        daemon: u32,
    },
    /// Something listening there is not running as us.
    ForeignPeer {
        uid: u32,
    },
}

impl From<io::Error> for ConnectError {
    fn from(e: io::Error) -> Self {
        ConnectError::Io(e)
    }
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Io(e) => write!(f, "{e}"),
            ConnectError::Version { daemon } => {
                write!(
                    f,
                    "daemon speaks protocol {daemon}, we speak {PROTO_VERSION}"
                )
            }
            ConnectError::ForeignPeer { uid } => write!(f, "socket is served by uid {uid}"),
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let (mut uid, mut gid) = (0, 0);
    if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(uid)
}

/// Linux has no `getpeereid`; `SO_PEERCRED` gives the same uid.
#[cfg(target_os = "linux")]
pub fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}

/// Connects and says `hello`. Returns the stream and the daemon's pid.
pub fn connect(socket: &Path) -> Result<(UnixStream, u32), ConnectError> {
    let mut stream = UnixStream::connect(socket)?;
    let me = unsafe { libc::getuid() };
    let uid = peer_uid(&stream)?;
    if uid != me {
        return Err(ConnectError::ForeignPeer { uid });
    }
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    write_frame(
        &mut stream,
        &Request::Hello {
            proto: PROTO_VERSION,
        },
        b"",
    )?;
    let (event, _): (Event, _) = read_frame(&mut stream)?;
    match event {
        Event::Hello {
            proto, daemon_pid, ..
        } if proto == PROTO_VERSION => {
            // After the match: macOS refuses setsockopt (EINVAL) once the peer has closed, which
            // a daemon refusing our version does right after its hello.
            stream.set_read_timeout(None)?;
            Ok((stream, daemon_pid))
        }
        Event::Hello { proto, .. } => Err(ConnectError::Version { daemon: proto }),
        other => Err(io::Error::other(format!("expected hello, got {other:?}")).into()),
    }
}

/// [`connect`], starting `daemon_bin --socket <socket>` first when nothing listens there.
/// The daemon detaches itself (`setsid`) and outlives the caller; its stderr goes to
/// `sessiond.log` beside the socket.
pub fn connect_or_spawn(
    socket: &Path,
    daemon_bin: &Path,
    wait: Duration,
) -> Result<(UnixStream, u32), ConnectError> {
    match connect(socket) {
        Err(ConnectError::Io(e))
            if matches!(
                e.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) => {}
        other => return other,
    }
    let dir = socket.parent().unwrap_or(Path::new("/"));
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    if !(launchd::wanted(daemon_bin) && launchd::start(socket, daemon_bin)) {
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("sessiond.log"))?;
        let mut child = Command::new(daemon_bin)
            .arg("--socket")
            .arg(socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            .spawn()?;
        // Reaped here so a daemon that exits while we live is not left a zombie.
        std::thread::spawn(move || child.wait());
    }

    let deadline = Instant::now() + wait;
    loop {
        match connect(socket) {
            Err(ConnectError::Io(e)) if Instant::now() < deadline => {
                let _ = e;
                std::thread::sleep(Duration::from_millis(25));
            }
            other => return other,
        }
    }
}

/// macOS: the daemon runs as its own launchd job, so it is not in the app's coalition.
///
/// A daemon the app spawns directly stays in the app's coalition even after `setsid`. Quitting
/// the Dock's "Lotus — Running in Background" entry then kills the whole coalition: daemon and
/// every agent (measured 2026-11-17, `plans/session-daemon/RESEARCH-coalition.md`).
pub mod launchd {
    use super::*;

    pub const LABEL_PREFIX: &str = "com.lotus.sessiond.";

    /// Only for a daemon inside an app bundle: TCC credits that binary to the bundle, so the
    /// app's folder grants still apply. Dev builds and tests keep the direct spawn.
    pub fn wanted(daemon_bin: &Path) -> bool {
        cfg!(target_os = "macos")
            && daemon_bin
                .to_string_lossy()
                .contains(".app/Contents/MacOS/")
    }

    /// One label per socket, so the dev and release daemons are separate jobs.
    pub fn label(socket: &Path) -> String {
        // FNV-1a: stable across builds, unlike `DefaultHasher`.
        let hash = socket
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .fold(0xcbf29ce484222325u64, |h, b| {
                (h ^ *b as u64).wrapping_mul(0x100000001b3)
            });
        format!("{LABEL_PREFIX}{:08x}", hash as u32)
    }

    fn xml(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    pub fn plist(label: &str, daemon_bin: &Path, socket: &Path, log: &Path) -> String {
        let s = |p: &Path| xml(&p.to_string_lossy());
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key>
  <array><string>{bin}</string><string>--socket</string><string>{socket}</string><string>--detach</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardErrorPath</key><string>{log}</string>
  <key>SoftResourceLimits</key><dict><key>NumberOfFiles</key><integer>10240</integer></dict>
</dict>
</plist>
"#,
            label = xml(label),
            bin = s(daemon_bin),
            socket = s(socket),
            log = s(log),
        )
    }

    /// `launchctl` with a deadline; true = it ran and exited 0.
    fn launchctl(args: &[&str]) -> bool {
        let Ok(mut child) = Command::new("/bin/launchctl")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return false;
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.success(),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20))
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return false;
                }
            }
        }
    }

    /// Loads and starts the job. Only called when nothing listens on the socket. False = launchd
    /// could not take it; the caller spawns directly.
    pub fn start(socket: &Path, daemon_bin: &Path) -> bool {
        let dir = socket.parent().unwrap_or(Path::new("/"));
        let label = label(socket);
        let path = dir.join("sessiond.plist");
        let body = plist(&label, daemon_bin, socket, &dir.join("sessiond.log"));
        let _ = std::fs::remove_file(&path); // never write through a planted symlink
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .and_then(|mut f| io::Write::write_all(&mut f, body.as_bytes()));
        if written.is_err() {
            return false;
        }
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        if launchctl(&["bootstrap", &domain, &path.to_string_lossy()]) {
            return true;
        }
        // Already loaded: a daemon still starting, or one that died without unloading itself.
        // `kickstart` without `-k` starts it only when not running, so a live one is left alone.
        launchctl(&["kickstart", &format!("{domain}/{label}")])
    }

    /// Run by the job's process once it has forked the daemon: a loaded job is attributed to
    /// the app (Dock quit kills it) and keeps the Dock entry "Running in Background"
    /// (t3code#38140). launchd sets `XPC_SERVICE_NAME` to the job's label.
    pub fn unload_self() {
        let Ok(label) = std::env::var("XPC_SERVICE_NAME") else {
            return;
        };
        if !label.starts_with(LABEL_PREFIX) {
            return;
        }
        let target = format!("gui/{}/{label}", unsafe { libc::getuid() });
        // Not waited on: unloading a job signals its process, which is us.
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &target])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

/// The socket's directory exists, is ours and is `0700`; refuses one owned by another user
/// (a pre-created `/tmp/lotus-<uid>` would otherwise hand them our sessions).
pub fn prepare_socket_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let meta = std::fs::metadata(dir)?;
    if meta.uid() != unsafe { libc::getuid() } {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!("{} is owned by uid {}", dir.display(), meta.uid()),
        ));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_state_dir_holds_the_socket() {
        let p = socket_path(Path::new("/Users/a/.lotus-dev"), 501);
        assert_eq!(p, Path::new("/Users/a/.lotus-dev/sessiond.sock"));
    }

    #[test]
    fn a_state_dir_too_long_to_bind_falls_back_to_tmp() {
        let long = format!("/Users/{}/.lotus", "x".repeat(90));
        let p = socket_path(Path::new(&long), 501);
        assert_eq!(p, Path::new("/tmp/lotus-501/sessiond.sock"));
    }

    #[test]
    fn launchd_is_used_only_for_a_daemon_inside_an_app_bundle() {
        let bundled = Path::new("/Applications/Lotus.app/Contents/MacOS/lotus-sessiond");
        assert_eq!(launchd::wanted(bundled), cfg!(target_os = "macos"));
        assert!(!launchd::wanted(Path::new(
            "/r/target/debug/lotus-sessiond"
        )));
    }

    #[test]
    fn each_socket_gets_its_own_stable_label() {
        let release = launchd::label(Path::new("/Users/a/.lotus/sessiond.sock"));
        let dev = launchd::label(Path::new("/Users/a/.lotus-dev/sessiond.sock"));
        assert_ne!(release, dev);
        assert!(release.starts_with(launchd::LABEL_PREFIX));
        assert_eq!(
            release,
            launchd::label(Path::new("/Users/a/.lotus/sessiond.sock"))
        );
    }

    #[test]
    fn the_plist_escapes_paths_and_never_restarts_the_daemon() {
        let p = launchd::plist(
            "com.lotus.sessiond.1",
            Path::new("/A&B.app/Contents/MacOS/lotus-sessiond"),
            Path::new("/s<1>/sessiond.sock"),
            Path::new("/s/sessiond.log"),
        );
        assert!(p.contains("<string>/A&amp;B.app/Contents/MacOS/lotus-sessiond</string>"));
        assert!(p.contains("<string>/s&lt;1&gt;/sessiond.sock</string>"));
        assert!(p.contains("<key>KeepAlive</key><false/>"));
        assert!(p.contains("<key>NumberOfFiles</key><integer>10240</integer>"));
    }

    #[test]
    fn the_limit_is_inclusive_at_103_bytes() {
        let dir = format!("/{}", "d".repeat(103 - 1 - 1 - SOCKET_NAME.len()));
        let p = socket_path(Path::new(&dir), 501);
        assert_eq!(p.as_os_str().len(), 103);
        assert!(p.starts_with(&dir));
    }
}
