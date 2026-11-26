//! SSH connection pool — one persistent `ssh -NM` master per `SshToolTarget`.
//!
//! Every non-PTY SSH operation (editor list/read/write, git status/summary, …)
//! previously spawned a fresh `ssh` process, paying the full TCP+KEX+auth
//! cost (~500 ms) on every call. `RemoteTransport` keeps one backgrounded
//! master alive; slave calls reuse its socket and skip the handshake (~30 ms).
//!
//! **Why ControlMaster is safe here (and was not safe before):**  The previous
//! attempt shared the master socket with the PTY process using `ControlMaster=auto`.
//! When a non-PTY call fired while the PTY was still negotiating, both sides
//! raced to be the master; the loser received `"Connection to UNKNOWN port 65535
//! timed out"`. This module uses a *dedicated*, non-PTY master spawned with
//! `-NM -o ControlPersist=no`. The default CodeSpace terminal path no longer
//! creates SSH PTY sessions, so it does not share these control sockets.

use crate::no_window::NoWindow;
use std::collections::{HashMap, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::cli_tools::{format_ssh_target, SshToolTarget};
use crate::error::AppError;

// ── Key ───────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TransportKey {
    host: String,
    user: Option<String>,
    port: Option<u16>,
}

impl From<&SshToolTarget> for TransportKey {
    fn from(t: &SshToolTarget) -> Self {
        TransportKey {
            host: t.host.trim().to_ascii_lowercase(),
            user: t
                .user
                .as_deref()
                .map(str::trim)
                .filter(|u| !u.is_empty())
                .map(str::to_ascii_lowercase),
            port: t.port,
        }
    }
}

// ── Handle ────────────────────────────────────────────────────────────────────

struct MasterHandle {
    socket_path: PathBuf,
    process: Child,
    stderr: Arc<Mutex<VecDeque<u8>>>,
    stderr_done: mpsc::Receiver<()>,
    stopped: bool,
    /// The machine's session daemon, forwarded to a local socket over this master.
    /// A forward lives and dies with its master, so a new master starts without one.
    sessiond_forward: Option<RemoteSessiond>,
}

/// A machine's session daemon as this app reaches it, plus the login facts a process started
/// there needs: the daemon never reads its own environment, so the spawner builds all of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteSessiond {
    /// The local end of the forward.
    pub socket: PathBuf,
    pub home: String,
    pub user: String,
    pub shell: String,
}

impl MasterHandle {
    fn stop(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        // SSH's ProxyCommand belongs to this connection too. A private process group keeps
        // a timed-out cloudflared callback from surviving a failed/retried connection on Unix.
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.process.id() as i32), libc::SIGKILL);
        }
        let _ = self.process.kill();
        let _ = self.process.wait();
        let _ = self.stderr_done.recv_timeout(Duration::from_millis(200));
    }

    fn diagnostic(&self) -> String {
        let bytes: Vec<u8> = self
            .stderr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .copied()
            .collect();
        // Proxy diagnostics can include browser login URLs; keep these out of error payloads.
        String::from_utf8_lossy(&bytes)
            .split_whitespace()
            .map(|word| {
                if word.starts_with("https://")
                    || word.starts_with("http://")
                    || word.starts_with("eyJ")
                {
                    "[redacted]"
                } else {
                    word
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl Drop for MasterHandle {
    fn drop(&mut self) {
        self.stop();
        let _ = std::fs::remove_file(&self.socket_path);
        if let Some(forward) = &self.sessiond_forward {
            let _ = std::fs::remove_file(&forward.socket);
        }
    }
}

// ── Transport ─────────────────────────────────────────────────────────────────

/// One machine's connection, guarded on its own so a slow handshake only blocks that machine.
type MasterSlot = Arc<Mutex<Option<MasterHandle>>>;

pub struct RemoteTransport {
    /// Held only long enough to find or create a slot — never across a spawn or a handshake.
    masters: Mutex<HashMap<TransportKey, MasterSlot>>,
}

impl RemoteTransport {
    pub fn new() -> Self {
        RemoteTransport {
            masters: Mutex::new(HashMap::new()),
        }
    }

    fn slot(&self, key: &TransportKey) -> MasterSlot {
        let mut masters = self.masters.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(masters.entry(key.clone()).or_default())
    }

    fn existing_slot(&self, key: &TransportKey) -> Option<MasterSlot> {
        let masters = self.masters.lock().unwrap_or_else(|e| e.into_inner());
        masters.get(key).map(Arc::clone)
    }

    /// Whether a live master already exists for `target` — asked, never assumed.
    ///
    /// This is the only honest definition of "connected" available for free: the socket is there and
    /// the master process has not exited. Everything else (a ping, a probe) costs a round trip, and a
    /// picker that probes every machine on open would spend an operator's first eight seconds proving
    /// something they did not ask about. A machine still mid-handshake is not connected yet, and is
    /// answered as such rather than waited on.
    pub fn has_master(&self, target: &SshToolTarget) -> bool {
        let Some(slot) = self.existing_slot(&TransportKey::from(target)) else {
            return false;
        };
        let mut guard = match slot.try_lock() {
            Ok(guard) => guard,
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(std::sync::TryLockError::WouldBlock) => return false,
        };
        let Some(handle) = guard.as_mut() else {
            return false;
        };
        // `try_wait` reaps a master that died since we last looked; a socket file left behind by a
        // crashed master would otherwise read as a live connection.
        match handle.process.try_wait() {
            Ok(Some(_)) => {
                *guard = None;
                false
            }
            Ok(None) => handle.socket_path.exists(),
            Err(_) => false,
        }
    }

    /// Return the control socket path for `target`, spawning a master if needed.
    ///
    /// Callers add `-o ControlMaster=no -o ControlPath=<returned_path>` to
    /// their slave `ssh` command. On failure, propagate the error — the caller
    /// should NOT silently fall back to a direct connection since the error
    /// typically indicates the host is unreachable for all connections.
    ///
    /// Concurrent calls for the same machine queue behind one handshake and share its master;
    /// calls for other machines do not wait at all.
    pub fn acquire(&self, target: &SshToolTarget) -> Result<PathBuf, AppError> {
        let key = TransportKey::from(target);
        let slot = self.slot(&key);
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        ensure_master(&mut guard, &key, target)
    }

    /// The machine's `lotus-sessiond` socket, forwarded to a local Unix socket over the master.
    ///
    /// `Ok(None)` = the machine runs no session daemon (no Lotus host installed): the caller keeps
    /// the plain `ssh -t` pane. Every pane on the machine shares this one master, so the link is
    /// one SSH connection however many panes are open, and a pane whose link drops reconnects here.
    /// Probed 2026-11-26 against a real host: `hello` answered protocol 1 through the forward.
    pub fn forward_sessiond(&self, target: &SshToolTarget) -> Result<Option<RemoteSessiond>, AppError> {
        let key = TransportKey::from(target);
        let slot = self.slot(&key);
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let master = ensure_master(&mut guard, &key, target)?;
        let Some(handle) = guard.as_mut() else {
            return Err(AppError::Other("SSH master vanished".into()));
        };
        if let Some(forward) = &handle.sessiond_forward {
            if forward.socket.exists() {
                return Ok(Some(forward.clone()));
            }
            handle.sessiond_forward = None;
        }

        let ssh_target = format_ssh_target(target)?;
        let Some(probe) = probe_remote_sessiond(&master, target.port, &ssh_target)? else {
            return Ok(None);
        };
        let remote = &probe.socket;
        let local = forward_path_for(&key);
        let _ = std::fs::remove_file(&local);
        let mut cmd = slave_ssh(&master, target.port);
        let out = cmd
            .args(["-O", "forward", "-L"])
            .arg(format!("{}:{remote}", local.display()))
            .arg(&ssh_target)
            .stdin(Stdio::null())
            .output()
            .map_err(AppError::Io)?;
        if !out.status.success() || !local.exists() {
            return Err(AppError::Other(format!(
                "Could not forward the session daemon of {ssh_target}: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
        let found = RemoteSessiond {
            socket: local,
            home: probe.home,
            user: probe.user,
            shell: probe.shell,
        };
        handle.sessiond_forward = Some(found.clone());
        Ok(Some(found))
    }

    /// Kill the master for `target` and remove its socket.
    ///
    /// The next `acquire` will re-spawn. Call this after repeated auth failures
    /// so a new key-loaded agent can reconnect cleanly.
    pub fn evict(&self, target: &SshToolTarget) {
        if let Some(slot) = self.existing_slot(&TransportKey::from(target)) {
            slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
    }

    /// Every machine with a live master now, with its socket: the only ones usage may ask, since
    /// asking any other would open SSH (an SSO prompt on a Cloudflare Access host).
    pub fn live_targets(&self) -> Vec<(SshToolTarget, PathBuf)> {
        let keys: Vec<TransportKey> = self.masters.lock().unwrap_or_else(|e| e.into_inner()).keys().cloned().collect();
        keys.into_iter()
            .map(|k| SshToolTarget { host: k.host, user: k.user, port: k.port })
            .filter(|t| self.has_master(t))
            .map(|t| {
                let socket = socket_path_for(&TransportKey::from(&t));
                (t, socket)
            })
            .collect()
    }

    /// Kill all masters — called from the Tauri `RunEvent::Exit` handler.
    pub fn shutdown(&self) {
        let slots: Vec<MasterSlot> = {
            let mut masters = self.masters.lock().unwrap_or_else(|e| e.into_inner());
            masters.drain().map(|(_, slot)| slot).collect()
        };
        for slot in slots {
            slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        }
    }
}

/// Returns the live master's socket for `key`, spawning one when there is none. The caller holds
/// that machine's slot, so concurrent callers for one machine share a single handshake.
fn ensure_master(
    guard: &mut Option<MasterHandle>,
    key: &TransportKey,
    target: &SshToolTarget,
) -> Result<PathBuf, AppError> {

    // Reuse existing master if still alive and socket present.
    if let Some(handle) = guard.as_mut() {
        let alive = matches!(handle.process.try_wait(), Ok(None));
        if alive && handle.socket_path.exists() {
            return Ok(handle.socket_path.clone());
        }
        // Dead or stale — evict and re-spawn below.
        *guard = None;
    }

    // An expired Cloudflare Access token makes ssh hang its whole budget, and the cloudflared it
    // starts opens a browser tab that dies with it, so a sign-in there saves no token. Every
    // reconnect would open another such tab. Ask first (~1 s, only when no master is live).
    if let Some(app) = crate::ssh_config::access_hostname_for(&target.host) {
        if crate::remote_access::access_status(&app).state == crate::remote_access::AccessState::NeedsLogin {
            return Err(AppError::Other(format!(
                "Cloudflare Access sign-in for {} has expired. Sign in, then retry.",
                target.host
            )));
        }
    }

    // Spawn a new master.
    let socket_path = socket_path_for(key);
    let ssh_target = format_ssh_target(target)?;
    // Only this app instance owns this path. A stale file must not count as authentication.
    match std::fs::remove_file(&socket_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    let mut cmd = std::process::Command::new("ssh").no_window();
    cmd.args([
        "-NM",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ControlPersist=no",
        // A quiet link (an idle chat stream) must not be dropped by NAT or Cloudflare unnoticed.
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        // A forward (`forward_sessiond`) re-binds its local socket after a reconnect; a file
        // left by the previous master must not make that bind fail.
        "-o",
        "StreamLocalBindUnlink=yes",
        "-S",
    ])
    .arg(&socket_path)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    if let Some(port) = target.port {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd.arg(&ssh_target);

    let mut child = cmd.spawn().map_err(AppError::Io)?;
    let stderr = Arc::new(Mutex::new(VecDeque::new()));
    let captured = Arc::clone(&stderr);
    let (done, stderr_done) = mpsc::channel();
    if let Some(mut pipe) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut chunk = [0_u8; 1024];
            while let Ok(count) = pipe.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                let mut tail = captured.lock().unwrap_or_else(|e| e.into_inner());
                tail.extend(&chunk[..count]);
                while tail.len() > 8192 {
                    tail.pop_front();
                }
            }
            let _ = done.send(());
        });
    }
    let mut handle = MasterHandle {
        socket_path: socket_path.clone(),
        process: child,
        stderr,
        stderr_done,
        stopped: false,
        sessiond_forward: None,
    };

    // Wait for the socket to appear — the master writes it after
    // authentication, so its presence means the connection is live.
    // Allow SSH its full 30 s handshake budget plus a small scheduling margin. Browser
    // authentication is handled before entering the picker, rather than inside this deadline.
    const MASTER_TIMEOUT: Duration = Duration::from_secs(35);
    let deadline = Instant::now() + MASTER_TIMEOUT;
    loop {
        if let Some(status) = handle.process.try_wait()? {
            handle.stop();
            let detail = handle.diagnostic();
            return Err(AppError::Other(format!(
                "SSH connection failed (target: {ssh_target}, status: {status}). {detail}"
            )));
        }
        if socket_path.exists() {
            break;
        }
        if Instant::now() >= deadline {
            handle.stop();
            let detail = handle.diagnostic();
            return Err(AppError::Other(format!(
                "SSH connection timed out after {} s (target: {ssh_target}). {detail}",
                MASTER_TIMEOUT.as_secs(),
            )));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    *guard = Some(handle);
    Ok(socket_path)
}

/// A slave `ssh` that rides `master` (never opens its own connection).
fn slave_ssh(master: &std::path::Path, port: Option<u16>) -> std::process::Command {
    let mut cmd = std::process::Command::new("ssh").no_window();
    cmd.args(["-o", "BatchMode=yes", "-o", "ControlMaster=no", "-S"]).arg(master);
    if let Some(port) = port {
        cmd.arg("-p").arg(port.to_string());
    }
    cmd
}

/// Where the Lotus host keeps its session daemon socket (`packages/host` → `sessiondDir`).
const REMOTE_SESSIOND_SOCKET: &str = "$HOME/.lotus/host-sessiond/sessiond.sock";

/// What the probe found on the machine. `socket` is the far path here.
struct SessiondProbe {
    socket: String,
    home: String,
    user: String,
    shell: String,
}

/// One line each: socket, home, user, shell. Anything short of an absolute socket path, an
/// absolute home and a user means no daemon.
fn parse_probe(stdout: &str) -> Option<SessiondProbe> {
    let mut lines = stdout.lines().map(str::trim);
    let socket = lines.next().filter(|p| p.starts_with('/'))?.to_string();
    let home = lines.next().filter(|h| h.starts_with('/'))?.to_string();
    let user = lines.next().filter(|u| !u.is_empty())?.to_string();
    let shell = lines
        .next()
        .filter(|s| s.starts_with('/'))
        .unwrap_or("/bin/sh")
        .to_string();
    Some(SessiondProbe { socket, home, user, shell })
}

/// The machine's session daemon socket (absolute) and login facts, or `None` when it runs none.
/// A forward needs an absolute path: ssh does not expand `~` or `$HOME` on the far side.
fn probe_remote_sessiond(
    master: &std::path::Path,
    port: Option<u16>,
    ssh_target: &str,
) -> Result<Option<SessiondProbe>, AppError> {
    const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
    let script = format!(
        "p=\"{REMOTE_SESSIOND_SOCKET}\"; [ -S \"$p\" ] || exit 0; printf '%s\\n' \"$p\" \"$HOME\" \"$(id -un)\" \"${{SHELL:-/bin/sh}}\""
    );
    let mut child = slave_ssh(master, port)
        .arg(ssh_target)
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(AppError::Io)?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::Other(format!(
                "Looking for the session daemon on {ssh_target} timed out"
            )));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        return Err(AppError::Other(format!(
            "Looking for the session daemon on {ssh_target} failed: {}",
            stderr.trim()
        )));
    }
    Ok(parse_probe(&stdout))
}

// ── Orphans ───────────────────────────────────────────────────────────────────

/// Stop SSH masters left behind by a Lotus that died without reaching `shutdown` — a crash, a
/// `kill`, a `tauri dev` restart. The master runs in its own process group, so nothing else ends
/// it; it outlives its owner (reparented to launchd) holding a connection. Seen 2026-11-24: one
/// such master from a dead instance still alive two hours later.
///
/// Each socket name carries its owner's pid; only sockets whose owner is gone are touched, so a
/// dev instance running beside the release app never stops the other's masters.
#[cfg(unix)]
pub fn reap_orphans() {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(owner) = socket_owner(&entry.file_name().to_string_lossy()) else {
            continue;
        };
        // kill(pid, 0) == 0 or EPERM means a process with that pid exists: leave it alone.
        let alive = owner == std::process::id()
            || unsafe { libc::kill(owner as libc::pid_t, 0) } == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if alive {
            continue;
        }
        // A forward is only a file once its master is gone: there is nothing to stop.
        if entry.file_name().to_string_lossy().starts_with(FORWARD_PREFIX) {
            let _ = std::fs::remove_file(entry.path());
            continue;
        }
        // `-O exit` talks to the socket only; the host argument is never resolved.
        let _ = std::process::Command::new("ssh")
            .no_window()
            .args(["-o", "BatchMode=yes", "-S"])
            .arg(entry.path())
            .args(["-O", "exit", "lotus-orphan"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = std::fs::remove_file(entry.path());
    }
}

#[cfg(not(unix))]
pub fn reap_orphans() {}

/// The pid in `lotus-ssh-<pid>-<hash>.sock` (or a `lotus-sd-` forward).
fn socket_owner(name: &str) -> Option<u32> {
    let rest = name
        .strip_prefix(SOCKET_PREFIX)
        .or_else(|| name.strip_prefix(FORWARD_PREFIX))?;
    rest.strip_suffix(".sock")?.split('-').next()?.parse().ok()
}

// ── Socket path ───────────────────────────────────────────────────────────────

/// Deterministic, uniquely-hashed socket path for `target`.
///
/// The hash avoids OS Unix-domain-socket path length limits (104 chars on
/// macOS, 108 on Linux). The `lotus-ssh-` prefix makes the file identifiable
/// if it lingers after a crash.
#[cfg(test)]
pub(crate) fn socket_path_for_target(target: &SshToolTarget) -> PathBuf {
    socket_path_for(&TransportKey::from(target))
}

fn socket_path_for(key: &TransportKey) -> PathBuf {
    socket_file(SOCKET_PREFIX, key)
}

/// The local end of `forward_sessiond`: same naming as the master socket, its own prefix.
fn forward_path_for(key: &TransportKey) -> PathBuf {
    socket_file(FORWARD_PREFIX, key)
}

const SOCKET_PREFIX: &str = "lotus-ssh-";
const FORWARD_PREFIX: &str = "lotus-sd-";

fn socket_file(prefix: &str, key: &TransportKey) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    key.hash(&mut hasher);
    let hash = hasher.finish();
    std::env::temp_dir().join(format!("{prefix}{}-{hash:016x}.sock", std::process::id()))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    struct FakeSsh {
        _dir: tempfile::TempDir,
        original_path: Option<std::ffi::OsString>,
    }

    #[cfg(unix)]
    impl FakeSsh {
        fn new(script: &str) -> Self {
            use std::os::unix::fs::PermissionsExt;
            let dir = tempfile::tempdir().unwrap();
            let ssh = dir.path().join("ssh");
            std::fs::write(&ssh, format!("#!/bin/sh\n{script}")).unwrap();
            std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o700)).unwrap();
            let original_path = std::env::var_os("PATH");
            std::env::set_var("PATH", dir.path());
            Self {
                _dir: dir,
                original_path,
            }
        }
    }

    #[cfg(unix)]
    impl Drop for FakeSsh {
        fn drop(&mut self) {
            match &self.original_path {
                Some(path) => std::env::set_var("PATH", path),
                None => std::env::remove_var("PATH"),
            }
        }
    }

    fn target(host: &str, user: Option<&str>, port: Option<u16>) -> SshToolTarget {
        SshToolTarget {
            host: host.into(),
            user: user.map(Into::into),
            port,
        }
    }

    #[test]
    fn a_socket_name_gives_back_its_owner_pid() {
        let own = socket_path_for_target(&target("host", Some("alwi"), Some(22)));
        assert_eq!(socket_owner(&own.file_name().unwrap().to_string_lossy()), Some(std::process::id()));
        assert_eq!(socket_owner("lotus-ssh-abc-00ff.sock"), None);
        assert_eq!(socket_owner("other-123-00ff.sock"), None);
    }

    #[cfg(unix)]
    #[test]
    fn reap_stops_only_masters_whose_owner_is_gone() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let calls = tempfile::NamedTempFile::new().unwrap();
        let _ssh = FakeSsh::new(&format!("echo \"$@\" >> '{}'\n", calls.path().display()));
        // A pid that existed and is now gone: a child we already waited on.
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        let orphan = std::env::temp_dir().join(format!("lotus-ssh-{dead}-00000000deadbeef.sock"));
        let mine = std::env::temp_dir().join(format!("lotus-ssh-{}-00000000cafef00d.sock", std::process::id()));
        std::fs::write(&orphan, "").unwrap();
        std::fs::write(&mine, "").unwrap();

        reap_orphans();

        let log = std::fs::read_to_string(calls.path()).unwrap();
        assert!(log.contains(&format!("{} -O exit", orphan.display())), "{log}");
        assert!(!log.contains("cafef00d"), "{log}");
        assert!(!orphan.exists());
        assert!(mine.exists());
        std::fs::remove_file(mine).unwrap();
    }

    #[test]
    fn socket_path_is_deterministic_for_same_target() {
        let a = socket_path_for_target(&target("myhost", Some("alwi"), Some(2222)));
        let b = socket_path_for_target(&target("myhost", Some("alwi"), Some(2222)));
        assert_eq!(a, b);
    }

    #[test]
    fn socket_path_differs_for_different_hosts() {
        let a = socket_path_for_target(&target("host-a", None, None));
        let b = socket_path_for_target(&target("host-b", None, None));
        assert_ne!(a, b);
    }

    #[test]
    fn socket_path_differs_for_different_users() {
        let a = socket_path_for_target(&target("host", Some("alwi"), None));
        let b = socket_path_for_target(&target("host", Some("bob"), None));
        assert_ne!(a, b);
    }

    #[test]
    fn socket_path_differs_for_different_ports() {
        let a = socket_path_for_target(&target("host", None, Some(22)));
        let b = socket_path_for_target(&target("host", None, Some(2222)));
        assert_ne!(a, b);
    }

    #[test]
    fn socket_path_is_in_temp_dir_and_has_lotus_prefix() {
        let path = socket_path_for_target(&target("host", None, None));
        assert!(path.starts_with(std::env::temp_dir()));
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("lotus-ssh-"));
        assert!(name.ends_with(".sock"));
    }

    #[test]
    fn socket_path_length_fits_within_unix_domain_socket_limit() {
        // macOS limit is 104, Linux is 108 — stay under 104.
        let path = socket_path_for_target(&target(
            "very-long-hostname-example.com",
            Some("username"),
            Some(2222),
        ));
        assert!(
            path.to_str().unwrap().len() <= 104,
            "socket path too long: {}",
            path.display()
        );
    }

    #[test]
    fn evict_is_noop_when_no_master_exists() {
        let transport = RemoteTransport::new();
        transport.evict(&target("host", None, None));
    }

    #[test]
    fn shutdown_with_no_masters_is_noop() {
        let transport = RemoteTransport::new();
        transport.shutdown();
    }

    #[test]
    fn key_normalises_host_to_lowercase_and_trims_whitespace() {
        let key_a = TransportKey::from(&target("  MyHost  ", Some("  Alwi  "), Some(22)));
        let key_b = TransportKey::from(&target("myhost", Some("alwi"), Some(22)));
        assert_eq!(key_a, key_b);
    }

    #[cfg(unix)]
    #[test]
    fn acquire_reports_the_ssh_error_without_waiting_for_the_deadline() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let _ssh = FakeSsh::new("printf 'Permission denied (publickey).\\n' >&2\nexit 255\n");
        let transport = RemoteTransport::new();
        let started = Instant::now();
        let result = transport.acquire(&target("lotus-test-auth-failure", None, None));
        let error = result.unwrap_err().to_string();
        assert!(error.contains("Permission denied (publickey)"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn acquire_accepts_a_master_that_authenticates_after_eight_seconds() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let _ssh = FakeSsh::new("while [ \"$1\" != -S ]; do shift; done\nshift\nexec /usr/bin/python3 -c 'import socket,sys,time; time.sleep(9); s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(); time.sleep(120)' \"$1\"\n");
        let transport = RemoteTransport::new();
        let target = target("lotus-test-delayed-master", None, None);
        let socket = transport.acquire(&target).unwrap();
        assert!(transport.has_master(&target));
        assert_eq!(transport.acquire(&target).unwrap(), socket);
        transport.shutdown();
        assert!(!socket.exists());
    }

    #[cfg(unix)]
    #[test]
    fn timeout_reaps_the_master_and_removes_its_socket() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let marker = tempfile::NamedTempFile::new().unwrap();
        let _ssh = FakeSsh::new(&format!(
            "echo $$ > '{}'\nexec /bin/sleep 120\n",
            marker.path().display()
        ));
        let transport = RemoteTransport::new();
        let target = target("lotus-test-stalled-master", None, None);
        let error = transport.acquire(&target).unwrap_err().to_string();
        let pid: i32 = std::fs::read_to_string(marker.path())
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(error.contains("timed out after 35 s"), "{error}");
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "stalled SSH process survived timeout"
        );
        assert!(!socket_path_for_target(&target).exists());
        assert!(!transport.has_master(&target));
    }

    #[cfg(unix)]
    #[test]
    fn failure_terminates_the_proxy_and_redacts_login_credentials() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let _ssh = FakeSsh::new("/bin/sleep 120 &\nprintf 'Proxy failed https://example.com/login?token=secret eyJsecret.payload.signature\\n' >&2\nexit 255\n");
        let transport = RemoteTransport::new();
        let started = Instant::now();
        let error = transport
            .acquire(&target("lotus-test-proxy-failure", None, None))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Proxy failed"), "{error}");
        assert!(!error.contains("secret"), "{error}");
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "proxy kept the diagnostic pipe open"
        );
    }

    /// One machine stuck at its login prompt — a lapsed Cloudflare Access session is the real case —
    /// used to hold the pool's only lock for up to 35 s, so every other machine waited on it too.
    #[cfg(unix)]
    #[test]
    fn a_stalled_host_does_not_hold_up_another_hosts_connection() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let _ssh = FakeSsh::new(
            "for arg; do last=$arg; done\ncase \"$last\" in *stalled*) /bin/sleep 3; exit 255;; esac\nprintf 'Permission denied (publickey).\\n' >&2\nexit 255\n",
        );
        let transport = Arc::new(RemoteTransport::new());
        let stalled = target("lotus-test-stalled-a", None, None);
        let connecting = {
            let transport = Arc::clone(&transport);
            let stalled = stalled.clone();
            std::thread::spawn(move || transport.acquire(&stalled))
        };
        std::thread::sleep(Duration::from_millis(300));

        let started = Instant::now();
        assert!(
            !transport.has_master(&stalled),
            "a handshake in progress is not a connection"
        );
        let error = transport
            .acquire(&target("lotus-test-other-b", None, None))
            .unwrap_err()
            .to_string();
        assert!(error.contains("Permission denied (publickey)"), "{error}");
        assert!(
            started.elapsed() < Duration::from_millis(1500),
            "waited {:?} behind another machine's handshake",
            started.elapsed()
        );
        assert!(connecting.join().unwrap().is_err());
    }

    #[test]
    fn a_probe_needs_a_socket_a_home_and_a_user() {
        let p = parse_probe("/h/.lotus/host-sessiond/sessiond.sock\n/h\nalwi\n/bin/zsh\n").unwrap();
        assert_eq!((p.home.as_str(), p.user.as_str(), p.shell.as_str()), ("/h", "alwi", "/bin/zsh"));
        // No shell reported: POSIX sh, as sshd would use.
        assert_eq!(parse_probe("/s.sock\n/h\nalwi\n").unwrap().shell, "/bin/sh");
        assert!(parse_probe("").is_none());
        assert!(parse_probe("/s.sock\n").is_none());
        assert!(parse_probe("motd text\n/h\nalwi\n").is_none());
    }

    #[test]
    fn a_forward_name_gives_back_its_owner_pid_and_differs_from_the_master() {
        let key = TransportKey::from(&target("host", Some("alwi"), Some(22)));
        let forward = forward_path_for(&key);
        let name = forward.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("lotus-sd-"), "{name}");
        assert_eq!(socket_owner(&name), Some(std::process::id()));
        assert_ne!(forward, socket_path_for(&key));
        assert!(forward.to_str().unwrap().len() <= 104);
    }

    /// A forward left by a dead Lotus is only a file: it is removed, and no `ssh -O exit` is sent
    /// for it (there is no master behind it to stop).
    #[cfg(unix)]
    #[test]
    fn reap_removes_an_orphan_forward_without_calling_ssh() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let calls = tempfile::NamedTempFile::new().unwrap();
        let _ssh = FakeSsh::new(&format!("echo \"$@\" >> '{}'\n", calls.path().display()));
        let mut child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead = child.id();
        child.wait().unwrap();
        let orphan = std::env::temp_dir().join(format!("lotus-sd-{dead}-00000000feedf00d.sock"));
        std::fs::write(&orphan, "").unwrap();

        reap_orphans();

        assert!(!orphan.exists());
        let log = std::fs::read_to_string(calls.path()).unwrap();
        assert!(!log.contains("feedf00d"), "{log}");
    }

    /// A fake `ssh` that plays a master (binds its `-S` socket), answers the daemon probe with
    /// `probe_answer`, and "forwards" by creating the `-L` local path. Every call is logged.
    #[cfg(unix)]
    fn fake_ssh_for_forward(log: &std::path::Path, probe_answer: &str) -> FakeSsh {
        FakeSsh::new(&format!(
            r#"echo "$@" >> '{log}'
case " $* " in
  *" -NM "*)
    while [ "$1" != -S ]; do shift; done; shift
    exec /usr/bin/python3 -c 'import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(); time.sleep(120)' "$1";;
  *" -O forward "*)
    prev=; for a; do [ "$prev" = -L ] && spec=$a; prev=$a; done
    : > "${{spec%%:*}}"; exit 0;;
  *) printf '{probe_answer}'; exit 0;;
esac
"#,
            log = log.display()
        ))
    }

    #[cfg(unix)]
    #[test]
    fn forward_sessiond_forwards_the_hosts_socket_once_per_master() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let log = tempfile::NamedTempFile::new().unwrap();
        let remote = "/home/dev/.lotus/host-sessiond/sessiond.sock";
        let _ssh = fake_ssh_for_forward(log.path(), &format!("{remote}\\n/home/dev\\ndev\\n/usr/bin/zsh\\n"));
        let transport = RemoteTransport::new();
        let target = target("lotus-test-forward", Some("dev"), None);

        let found = transport.forward_sessiond(&target).unwrap().expect("a forward");
        let local = found.socket.clone();
        assert!(local.exists());
        assert_eq!((found.home.as_str(), found.user.as_str(), found.shell.as_str()), ("/home/dev", "dev", "/usr/bin/zsh"));
        assert_eq!(transport.forward_sessiond(&target).unwrap(), Some(found));

        let calls = std::fs::read_to_string(log.path()).unwrap();
        let forwards: Vec<&str> = calls.lines().filter(|l| l.contains("-O forward")).collect();
        assert_eq!(forwards.len(), 1, "{calls}");
        assert!(forwards[0].contains(&format!("{}:{remote}", local.display())), "{calls}");
        assert!(forwards[0].contains("ControlMaster=no"), "{calls}");
        let master = calls.lines().find(|l| l.contains("-NM")).unwrap();
        assert!(master.contains("StreamLocalBindUnlink=yes"), "{master}");

        transport.shutdown();
        assert!(!local.exists(), "the forward outlived its master");
    }

    /// No socket on the machine (no Lotus host there) is `None`: the pane keeps plain `ssh -t`.
    #[cfg(unix)]
    #[test]
    fn forward_sessiond_is_none_on_a_machine_without_a_daemon() {
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let log = tempfile::NamedTempFile::new().unwrap();
        let _ssh = fake_ssh_for_forward(log.path(), "");
        let transport = RemoteTransport::new();
        let target = target("lotus-test-no-daemon", None, None);

        assert_eq!(transport.forward_sessiond(&target).unwrap(), None);
        let calls = std::fs::read_to_string(log.path()).unwrap();
        assert!(!calls.contains("-O forward"), "{calls}");
        transport.shutdown();
    }

    /// Run manually with LOTUS_SSH_SMOKE_TARGET and LOTUS_SSH_SMOKE_DIR after Access login.
    #[test]
    #[ignore = "requires an authenticated SSH host"]
    fn ssh_smoke_reads_a_remote_directory_through_the_master() {
        let host = std::env::var("LOTUS_SSH_SMOKE_TARGET").expect("set LOTUS_SSH_SMOKE_TARGET");
        let path = std::env::var("LOTUS_SSH_SMOKE_DIR").expect("set LOTUS_SSH_SMOKE_DIR");
        let target = target(&host, None, None);
        let transport = RemoteTransport::new();
        let entries =
            crate::fs_browse_ssh::list_dir_entries_ssh(target.clone(), path, Some(&transport))
                .unwrap();
        assert!(transport.has_master(&target));
        let socket = transport.acquire(&target).unwrap();
        assert_eq!(transport.acquire(&target).unwrap(), socket);
        println!(
            "Remote folder read succeeded: {} directories",
            entries.len()
        );
        transport.shutdown();
        assert!(!socket.exists());
    }
}
