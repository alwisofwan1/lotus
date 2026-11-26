//! App side of `lotus-sessiond` (ADR-0067). On by default on macOS, `LOTUS_SESSIOND=0` turns it off;
//! any failure to reach the daemon means the in-process PTY path, never a broken terminal.
//!
//! One connection serves every session. A reader thread demultiplexes it: replies go to the
//! waiting `create`, output to each session's mirror (`lotus_pty::Pty::mirror`), `exited` ends
//! a mirror. When the connection drops — the daemon cut us loose as a stalled reader, or it
//! died — the reader reconnects (starting a daemon if none is left) and reattaches every mirror
//! from the last byte it holds. Readers of a session never notice: they read the mirror.

use lotus_pty::{CommandBuilder, OutputSink, OutputTail, Pty, Remote};
use lotus_sessiond::client::{connect_or_spawn, socket_path, ConnectError};
use lotus_sessiond::proto::*;
use std::collections::HashMap;
use std::io::{self, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

const SPAWN_WAIT: Duration = Duration::from_secs(2);
const CREATE_WAIT: Duration = Duration::from_secs(10);
const TERMINATE_WAIT: Duration = Duration::from_secs(5);
const RECONNECT_MAX_BACKOFF: Duration = Duration::from_secs(2);
/// A remote daemon is reached over SSH: each try can cost a handshake (and a Cloudflare Access
/// check), so it backs off further than a local socket that is only being restarted.
const REMOTE_FIRST_BACKOFF: Duration = Duration::from_secs(1);
const REMOTE_MAX_BACKOFF: Duration = Duration::from_secs(30);
const LIST_WAIT: Duration = Duration::from_secs(5);
/// `Link::next` of an adopted mirror until the daemon's drawn screen arrives: everything before
/// that screen is already in it, so no output is wanted until then.
const AWAITING_SCREEN: u64 = u64::MAX;

pub fn enabled() -> bool {
    // Not in tests: a `spawn_session` test would otherwise land in the developer's live daemon.
    let default = cfg!(target_os = "macos") && !cfg!(test);
    flag_on(std::env::var("LOTUS_SESSIOND").ok().as_deref(), default)
}

/// On by default on macOS (phase 6); Linux desktop waits for phase 4. `1`/`0` force it either way.
fn flag_on(value: Option<&str>, default: bool) -> bool {
    match value {
        Some("1") => true,
        Some("0") => false,
        _ => default,
    }
}

/// `LOTUS_SESSIOND_BIN`, else beside our own executable: `Contents/MacOS/` in the bundle
/// (`bundle.macOS.files`), `target/<profile>/` in dev (`scripts/build-sessiond.mjs`).
fn daemon_bin() -> PathBuf {
    if let Some(p) = std::env::var_os("LOTUS_SESSIOND_BIN") {
        return p.into();
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.join("lotus-sessiond")))
        .unwrap_or_else(|| PathBuf::from("lotus-sessiond"))
}

fn default_socket() -> PathBuf {
    socket_path(&crate::paths::lotus_state_dir(), unsafe { libc::getuid() })
}

static DAEMON: OnceLock<Option<Arc<Daemon>>> = OnceLock::new();

/// The daemon connection when `enabled()` and it could be reached on first use; `None`
/// (for the rest of this run) otherwise.
pub fn daemon() -> Option<Arc<Daemon>> {
    if !enabled() {
        return None;
    }
    DAEMON
        .get_or_init(|| Daemon::start(default_socket(), daemon_bin()))
        .clone()
}

/// One connection per remote machine, keyed by the caller (the SSH target). Each machine has its
/// own slot so a slow handshake to one never holds up another.
type RemoteSlot = Arc<Mutex<Option<Arc<Daemon>>>>;
static REMOTES: OnceLock<Mutex<HashMap<String, RemoteSlot>>> = OnceLock::new();

fn remotes() -> &'static Mutex<HashMap<String, RemoteSlot>> {
    REMOTES.get_or_init(Default::default)
}

/// The session daemon on machine `key`, connecting through `source` when there is no live link.
/// `None` = not reachable now, or the machine runs no daemon: the caller keeps the plain `ssh -t`
/// pane, so a machine without a Lotus host behaves exactly as before.
pub fn remote_daemon(key: &str, source: impl FnOnce() -> SocketSource) -> Option<Arc<Daemon>> {
    let slot = {
        let mut map = remotes().lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(map.entry(key.to_string()).or_default())
    };
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(daemon) = guard.as_ref() {
        return Some(Arc::clone(daemon));
    }
    let daemon = Daemon::start_remote(key.to_string(), source())?;
    *guard = Some(Arc::clone(&daemon));
    Some(daemon)
}

/// The live connection to `key`'s daemon, never a new one (letting go of a mirror needs no link
/// that is not already there).
pub fn connected_remote(key: &str) -> Option<Arc<Daemon>> {
    let slot = remotes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(key)
        .map(Arc::clone)?;
    let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().map(Arc::clone)
}

/// Which Lotus started a remote session: one id per state dir, so the dev and release apps on
/// this Mac, and a Lotus on another computer, never adopt or sweep each other's sessions on a
/// shared machine. Kept in `<state dir>/desktop-id`; made once.
pub fn desktop_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        if cfg!(test) {
            return "test-desktop".to_string();
        }
        let file = crate::paths::lotus_state_dir().join("desktop-id");
        if let Ok(existing) = std::fs::read_to_string(&file) {
            let existing = existing.trim();
            if !existing.is_empty() {
                return existing.to_string();
            }
        }
        let made = uuid::Uuid::new_v4().to_string();
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Err(e) = std::fs::write(&file, &made) {
            // Still unique for this run; the next run gets another id and leaves these alone.
            eprintln!("[sessiond] could not save {}: {e}", file.display());
        }
        made
    })
}

/// Every machine with a live daemon connection right now, by key.
pub fn connected_remotes() -> Vec<(String, Arc<Daemon>)> {
    let slots: Vec<(String, RemoteSlot)> = remotes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(k, v)| (k.clone(), Arc::clone(v)))
        .collect();
    slots
        .into_iter()
        .filter_map(|(key, slot)| {
            let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().map(|d| (key, Arc::clone(d)))
        })
        .collect()
}

/// Drops `daemon` from the registry, if it is still the one registered for its machine.
fn forget_remote(daemon: &Arc<Daemon>) {
    let Connector::Remote { label, .. } = &daemon.connector else {
        return;
    };
    let slot = remotes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(label)
        .map(Arc::clone);
    if let Some(slot) = slot {
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().is_some_and(|d| Arc::ptr_eq(d, daemon)) {
            *guard = None;
        }
    }
}

fn connect_at(socket: &Path, bin: &Path) -> Option<(UnixStream, u32)> {
    match connect_or_spawn(socket, bin, SPAWN_WAIT) {
        Ok(conn) => {
            eprintln!(
                "[sessiond] connected to pid {} at {}",
                conn.1,
                socket.display()
            );
            Some(conn)
        }
        Err(e) => {
            eprintln!(
                "[sessiond] {e} ({}); using in-process PTYs",
                socket.display()
            );
            None
        }
    }
}

/// The code a session ended with, handed from the reader thread to the mirror's waiter.
#[derive(Default)]
struct ExitSlot {
    code: Mutex<Option<i32>>,
    cv: Condvar,
}

impl ExitSlot {
    fn set(&self, code: i32) {
        *self.code.lock().unwrap_or_else(|e| e.into_inner()) = Some(code);
        self.cv.notify_all();
    }
    fn wait(&self, timeout: Duration) -> Option<i32> {
        let guard = self.code.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = self
            .cv
            .wait_timeout_while(guard, timeout, |c| c.is_none())
            .unwrap_or_else(|e| e.into_inner());
        *guard
    }
}

/// One mirror's end of the connection.
struct Link {
    feed: mpsc::Sender<Vec<u8>>,
    /// Absolute daemon offset of the next byte the mirror needs. Reattach starts here, and
    /// output below it (a replay overlapping what we hold) is dropped.
    next: u64,
    exit: Arc<ExitSlot>,
    /// An adopted mirror's tail, and the shift that makes it count in the session's own offsets
    /// (Pocket reads scrollback by offset). Whichever of the two the reader or `adopt` sets
    /// second applies the shift, under the links lock, so it lands exactly once.
    tail: Option<Arc<Mutex<OutputTail>>>,
    shift: Option<u64>,
}

impl Link {
    fn new(feed: mpsc::Sender<Vec<u8>>, next: u64, exit: &Arc<ExitSlot>) -> Self {
        Link {
            feed,
            next,
            exit: Arc::clone(exit),
            tail: None,
            shift: None,
        }
    }

    fn shift_tail(&mut self) {
        // The tail first: taking the shift before it is set would lose it (a screen that beat
        // `adopt` froze Pocket's poll, 1 run in 6).
        let Some(tail) = &self.tail else { return };
        if let Some(shift) = self.shift.take() {
            let mut t = tail.lock().unwrap_or_else(|e| e.into_inner());
            t.total_bytes_seen = t.total_bytes_seen.saturating_add(shift);
        }
    }
}

type CreateReply = Result<(String, Option<u32>), String>;

struct Pending {
    reply: mpsc::Sender<CreateReply>,
    link: Link,
}

#[derive(Default)]
struct Links {
    sessions: HashMap<String, Link>,
    /// Creates in flight, by `req`. The reader moves the link into `sessions` on `created`,
    /// before reading the next frame, so no output for the new session can miss it.
    pending: HashMap<u64, Pending>,
    /// `list` requests in flight, by `req`.
    lists: HashMap<u64, mpsc::Sender<Vec<SessionInfo>>>,
}

/// Where a remote daemon's socket is on this machine right now: a Unix socket forwarded over the
/// SSH pool's master (`RemoteTransport::forward_sessiond`). `Ok(None)` = the machine runs no
/// session daemon (no Lotus host there), which is a fallback, not an error.
pub type SocketSource = Box<dyn Fn() -> Result<Option<PathBuf>, String> + Send + Sync>;

/// How a [`Daemon`] reaches its daemon, the first time and after every lost connection.
pub enum Connector {
    /// This machine's daemon, started when nothing listens.
    Local { socket: PathBuf, bin: PathBuf },
    /// Another machine's daemon. Never started from here: it belongs to that machine's host.
    Remote { label: String, source: SocketSource },
}

impl Connector {
    fn connect(&self) -> Result<(UnixStream, u32), ConnectError> {
        match self {
            Connector::Local { socket, bin } => connect_or_spawn(socket, bin, SPAWN_WAIT),
            Connector::Remote { label, source } => match source() {
                Ok(Some(socket)) => lotus_sessiond::client::connect(&socket),
                Ok(None) => Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    format!("{label} runs no session daemon"),
                )
                .into()),
                Err(message) => Err(io::Error::other(message).into()),
            },
        }
    }

    fn backoff(&self) -> (Duration, Duration) {
        match self {
            Connector::Local { .. } => (Duration::from_millis(50), RECONNECT_MAX_BACKOFF),
            Connector::Remote { .. } => (REMOTE_FIRST_BACKOFF, REMOTE_MAX_BACKOFF),
        }
    }

    fn describe(&self) -> String {
        match self {
            Connector::Local { socket, .. } => socket.display().to_string(),
            Connector::Remote { label, .. } => label.clone(),
        }
    }

    fn is_remote(&self) -> bool {
        matches!(self, Connector::Remote { .. })
    }
}

pub struct Daemon {
    connector: Connector,
    /// The write half; `None` while reconnecting.
    stream: Mutex<Option<UnixStream>>,
    links: Mutex<Links>,
    next_req: AtomicU64,
    /// Set by [`Daemon::retry_now`]: cuts a reconnect backoff short.
    wake: (Mutex<bool>, std::sync::Condvar),
}

/// A remote daemon link as a pane shows it (plans/ssh-pane-durability, phase 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkState {
    Connected,
    /// `attempt` 0 = just lost; `error` is why the last try failed.
    Reconnecting {
        attempt: u32,
        next_in_ms: u64,
        error: Option<String>,
    },
}

type LinkObserver = Box<dyn Fn(&str, &LinkState) + Send + Sync>;
static LINK_OBSERVER: OnceLock<LinkObserver> = OnceLock::new();

/// Called with a remote machine's key on every change of its link. Set once, by the app.
pub fn set_link_observer(observer: LinkObserver) {
    let _ = LINK_OBSERVER.set(observer);
}

impl Daemon {
    fn start(socket: PathBuf, bin: PathBuf) -> Option<Arc<Daemon>> {
        let (stream, _) = connect_at(&socket, &bin)?;
        Self::run(Connector::Local { socket, bin }, stream)
    }

    /// A daemon on another machine; `None` when it cannot be reached now (the caller falls back).
    pub fn start_remote(label: String, source: SocketSource) -> Option<Arc<Daemon>> {
        let connector = Connector::Remote { label, source };
        match connector.connect() {
            Ok((stream, pid)) => {
                eprintln!("[sessiond] connected to {} (pid {pid})", connector.describe());
                Self::run(connector, stream)
            }
            Err(e) => {
                eprintln!("[sessiond] {}: {e}", connector.describe());
                None
            }
        }
    }

    fn run(connector: Connector, stream: UnixStream) -> Option<Arc<Daemon>> {
        let write_half = stream.try_clone().ok()?;
        let daemon = Arc::new(Daemon {
            connector,
            stream: Mutex::new(Some(write_half)),
            links: Mutex::new(Links::default()),
            next_req: AtomicU64::new(1),
            wake: (Mutex::new(false), std::sync::Condvar::new()),
        });
        let reader = Arc::clone(&daemon);
        std::thread::Builder::new()
            .name("sessiond-reader".into())
            .spawn(move || reader.read_loop(stream))
            .ok()?;
        Some(daemon)
    }

    /// A session this app starts on another machine says so in its tag. That daemon belongs to
    /// the machine's Lotus host, which adopts every session whose tag carries a `sessionId`
    /// (`adoptableSessions` in packages/host); this one must never read as the host's own, so the
    /// key is deliberately not `sessionId`. A local session has no tag, as before.
    fn tag(&self, command: &CommandBuilder, canvas_terminal_id: Option<&str>) -> Option<String> {
        if !self.connector.is_remote() {
            return None;
        }
        let pane_id = command
            .get_env("LOTUS_PANE_ID")
            .map(|v| v.to_string_lossy().into_owned());
        Some(
            serde_json::json!({
                "origin": "desktop",
                "client": desktop_id(),
                "paneId": pane_id,
                "canvasTerminalId": canvas_terminal_id,
            })
            .to_string(),
        )
    }

    fn send(&self, req: &Request, payload: &[u8]) -> io::Result<()> {
        let mut guard = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            Some(stream) => write_frame(stream, req, payload),
            None => Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "session daemon reconnecting",
            )),
        }
    }

    /// Starts `command` in the daemon and returns its mirror.
    pub fn spawn(
        self: &Arc<Self>,
        command: &CommandBuilder,
        canvas_terminal_id: Option<String>,
        window_label: &str,
        cols: u16,
        rows: u16,
        on_output: Option<OutputSink>,
    ) -> io::Result<(Pty, String)> {
        let tag = self.tag(command, canvas_terminal_id.as_deref());
        let spec = SpawnSpec {
            argv: command
                .get_argv()
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect(),
            env: command
                .iter_full_env_as_str()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            cwd: command.get_cwd().map(|c| c.to_string_lossy().into_owned()),
            cols,
            rows,
            owner: Owner {
                pane_id: command
                    .get_env("LOTUS_PANE_ID")
                    .map(|v| v.to_string_lossy().into_owned()),
                canvas_terminal_id,
                window_label: window_label.to_string(),
            },
            tag,
        };
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (reply_tx, reply_rx) = mpsc::channel();
        let (feed_tx, feed_rx) = mpsc::channel();
        let exit = Arc::new(ExitSlot::default());
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .insert(
                req,
                Pending {
                    reply: reply_tx,
                    link: Link::new(feed_tx, 0, &exit),
                },
            );
        let forget = || {
            self.links
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pending
                .remove(&req);
        };
        if let Err(e) = self.send(&Request::Create { req, spec }, b"") {
            forget();
            return Err(e);
        }
        // shortcut: a reply lost to a disconnect after the daemon spawned leaves that session
        // running unowned until step 5's adopt/reap sweeps it.
        let (id, pid) = match reply_rx.recv_timeout(CREATE_WAIT) {
            Ok(Ok(created)) => created,
            Ok(Err(message)) => return Err(io::Error::other(message)),
            Err(_) => {
                forget();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "session daemon did not answer create",
                ));
            }
        };
        let pty = self.mirror(id.clone(), feed_rx, exit, pid, cols, rows, on_output);
        Ok((pty, id))
    }

    /// Mirrors a session this app did not start in this run (it was started before a restart or
    /// a webview reload). The mirror opens with the daemon's drawn screen, then goes live.
    pub fn adopt(
        self: &Arc<Self>,
        info: &SessionInfo,
        on_output: Option<OutputSink>,
    ) -> io::Result<Pty> {
        let (feed_tx, feed_rx) = mpsc::channel();
        let exit = Arc::new(ExitSlot::default());
        {
            let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
            if links.sessions.contains_key(&info.id) {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!("{} is already mirrored", info.id),
                ));
            }
            links
                .sessions
                .insert(info.id.clone(), Link::new(feed_tx, AWAITING_SCREEN, &exit));
        }
        let attach = Request::Attach {
            id: info.id.clone(),
            from: AWAITING_SCREEN,
        };
        if let Err(e) = self.send(&attach, b"") {
            self.links
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .sessions
                .remove(&info.id);
            return Err(e);
        }
        let pty = self.mirror(
            info.id.clone(),
            feed_rx,
            exit,
            info.pid,
            info.cols,
            info.rows,
            on_output,
        );
        let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(link) = links.sessions.get_mut(&info.id) {
            link.tail = Some(Arc::clone(&pty.output_tail));
            link.shift_tail();
        }
        Ok(pty)
    }

    #[allow(clippy::too_many_arguments)]
    fn mirror(
        self: &Arc<Self>,
        id: String,
        feed: mpsc::Receiver<Vec<u8>>,
        exit: Arc<ExitSlot>,
        pid: Option<u32>,
        cols: u16,
        rows: u16,
        on_output: Option<OutputSink>,
    ) -> Pty {
        let session = Arc::new(RemoteSession {
            daemon: Arc::clone(self),
            id,
            exit: Arc::clone(&exit),
        });
        Pty::mirror(
            feed,
            Box::new(RemoteWriter(Arc::clone(&session))),
            session,
            // The feed closing means `exited` (or a lost session) was already recorded.
            Box::new(move || exit.wait(Duration::ZERO).unwrap_or(-1)),
            pid,
            cols,
            rows,
            on_output,
        )
    }

    /// The daemon's live sessions (a session being killed is not listed).
    pub fn list(&self) -> io::Result<Vec<SessionInfo>> {
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .lists
            .insert(req, tx);
        let sent = self.send(&Request::List { req }, b"");
        let got = sent.and_then(|()| {
            rx.recv_timeout(LIST_WAIT)
                .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "session daemon did not list"))
        });
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .lists
            .remove(&req);
        got
    }

    /// Whether this app already holds a mirror of daemon session `id`.
    pub fn mirrors(&self, id: &str) -> bool {
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .contains_key(id)
    }

    /// Lets go of a mirror and leaves the session running, for the next page to adopt. The
    /// mirror's feed closes without an end marker, so nothing tells its old page it ended.
    pub fn detach(&self, id: &str) {
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .remove(id);
        let _ = self.send(&Request::Detach { id: id.to_string() }, b"");
    }

    /// Ends a session this app does not mirror (an unclaimed one found at start).
    pub fn kill(&self, id: &str) -> io::Result<()> {
        self.send(&Request::Kill { id: id.to_string() }, b"")
    }

    fn read_loop(self: Arc<Self>, mut stream: UnixStream) {
        loop {
            while let Ok((event, payload)) = read_frame::<Event>(&mut stream) {
                self.on_event(event, payload);
            }
            *self.stream.lock().unwrap_or_else(|e| e.into_inner()) = None;
            {
                let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
                for (_, p) in links.pending.drain() {
                    let _ = p.reply.send(Err("session daemon disconnected".into()));
                }
                links.lists.clear();
            }
            // Nobody holds this client any more (the app's never goes; a test's does): a reconnect
            // would start a daemon no one uses, which then never idles out.
            if Arc::strong_count(&self) == 1 {
                return;
            }
            // A remote link with nothing on it is not worth an SSH handshake every 30 s: let it go,
            // and the next pane on that machine connects afresh.
            if self.connector.is_remote() && self.idle() {
                eprintln!("[sessiond] {}: connection lost with no sessions; closing", self.connector.describe());
                forget_remote(&self);
                return;
            }
            eprintln!("[sessiond] connection lost; reconnecting");
            self.report(LinkState::Reconnecting {
                attempt: 0,
                next_in_ms: 0,
                error: None,
            });
            stream = self.reconnect();
        }
    }

    /// Blocks until connected again, then reattaches every live mirror from its last byte.
    fn reconnect(&self) -> UnixStream {
        let (first, max) = self.connector.backoff();
        let mut backoff = first;
        let mut attempt = 0u32;
        // A "retry now" sent while the link was still up means nothing for this outage.
        *self.wake.0.lock().unwrap_or_else(|e| e.into_inner()) = false;
        loop {
            match self.connector.connect() {
                Ok((stream, pid)) => {
                    if let Ok(write_half) = stream.try_clone() {
                        *self.stream.lock().unwrap_or_else(|e| e.into_inner()) = Some(write_half);
                        let resume: Vec<(String, u64)> = self
                            .links
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .sessions
                            .iter()
                            .map(|(id, l)| (id.clone(), l.next))
                            .collect();
                        eprintln!(
                            "[sessiond] reconnected to pid {pid}; reattaching {}",
                            resume.len()
                        );
                        for (id, from) in resume {
                            // A daemon that no longer has it answers `error { id }` → lost.
                            let _ = self.send(&Request::Attach { id, from }, b"");
                        }
                        self.report(LinkState::Connected);
                        return stream;
                    }
                }
                Err(ConnectError::Version { daemon }) => {
                    eprintln!("[sessiond] daemon now speaks protocol {daemon}; mirrors are lost");
                    self.lose_all();
                }
                Err(e) => {
                    if self.connector.is_remote() {
                        eprintln!(
                            "[sessiond] {}: reconnect failed ({e}); next try in {} s",
                            self.connector.describe(),
                            backoff.as_secs()
                        );
                    }
                    attempt += 1;
                    self.report(LinkState::Reconnecting {
                        attempt,
                        next_in_ms: backoff.as_millis() as u64,
                        error: Some(e.to_string()),
                    });
                }
            }
            if self.sleep_unless_woken(backoff) {
                backoff = first;
            } else {
                backoff = (backoff * 2).min(max);
            }
        }
    }

    /// Tells the app's observer about a remote link; a local daemon's link is not a pane's concern.
    fn report(&self, state: LinkState) {
        if let (Connector::Remote { label, .. }, Some(observer)) = (&self.connector, LINK_OBSERVER.get()) {
            observer(label, &state);
        }
    }

    /// Sleeps `wait`, or less when [`Daemon::retry_now`] is called. `true` = woken early.
    fn sleep_unless_woken(&self, wait: Duration) -> bool {
        let (flag, cvar) = &self.wake;
        let guard = flag.lock().unwrap_or_else(|e| e.into_inner());
        let (mut guard, _) = cvar
            .wait_timeout_while(guard, wait, |woken| !*woken)
            .unwrap_or_else(|e| e.into_inner());
        std::mem::replace(&mut *guard, false)
    }

    /// Cuts the current reconnect wait short ("Retry now", or a sign-in that just finished).
    pub fn retry_now(&self) {
        let (flag, cvar) = &self.wake;
        *flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
        cvar.notify_all();
    }

    fn on_event(&self, event: Event, payload: Vec<u8>) {
        let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        match event {
            Event::Created { req, id, pid } => {
                if let Some(p) = links.pending.remove(&req) {
                    links.sessions.insert(id.clone(), p.link);
                    let _ = p.reply.send(Ok((id, pid)));
                }
            }
            Event::Error {
                req: Some(req),
                message,
                ..
            } => {
                if let Some(p) = links.pending.remove(&req) {
                    let _ = p.reply.send(Err(message));
                }
            }
            Event::Error {
                id: Some(id),
                message,
                ..
            } => {
                if let Some(link) = links.sessions.remove(&id) {
                    eprintln!("[sessiond] {message}: session lost");
                    lose(link);
                }
            }
            Event::Error { message, .. } => eprintln!("[sessiond] {message}"),
            Event::Output { id, offset } => {
                let Some(link) = links.sessions.get_mut(&id) else {
                    return;
                };
                let end = offset + payload.len() as u64;
                if end <= link.next {
                    return;
                }
                if offset > link.next {
                    // The daemon's ring no longer held what we missed while disconnected.
                    eprintln!(
                        "[sessiond] {id}: {} bytes of output lost while reconnecting",
                        offset - link.next
                    );
                }
                let skip = link.next.saturating_sub(offset) as usize;
                link.next = end;
                let _ = link.feed.send(payload[skip..].to_vec());
            }
            Event::Exited { id, code } => {
                if let Some(link) = links.sessions.remove(&id) {
                    link.exit.set(code);
                }
            }
            Event::Screen { id, total_bytes } => {
                // Only an adopted mirror asked for it; a resumed one already has those rows.
                if let Some(link) = links.sessions.get_mut(&id) {
                    if link.next == AWAITING_SCREEN {
                        link.next = total_bytes;
                        // The drawn screen sits just below `total_bytes`, so live output that
                        // follows it carries the session's offsets.
                        // shortcut: a session with less output than its drawn screen saturates
                        // to 0 and counts a little ahead; harmless, its offsets stay monotonic.
                        link.shift = Some(total_bytes.saturating_sub(payload.len() as u64));
                        link.shift_tail();
                        let _ = link.feed.send(payload);
                    }
                }
            }
            Event::Sessions { req, sessions } => {
                if let Some(tx) = links.lists.remove(&req) {
                    let _ = tx.send(sessions);
                }
            }
            // The app keeps its own screen; it never asks for a snapshot.
            Event::Hello { .. } | Event::Snapshot { .. } => {}
        }
    }

    fn idle(&self) -> bool {
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        links.sessions.is_empty() && links.pending.is_empty()
    }

    fn lose_all(&self) {
        let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        for (_, link) in links.sessions.drain() {
            lose(link);
        }
    }

    fn forget(&self, id: &str) {
        if let Some(link) = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .sessions
            .remove(id)
        {
            lose(link);
        }
    }
}

/// The process is gone with the daemon that held it: end the mirror the way an exit would look.
fn lose(link: Link) {
    let _ = link.feed.send(b"\r\n[Session ended:-1]\r\n".to_vec());
    link.exit.set(-1);
}

struct RemoteSession {
    daemon: Arc<Daemon>,
    id: String,
    exit: Arc<ExitSlot>,
}

impl Remote for RemoteSession {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        self.daemon.send(
            &Request::Resize {
                id: self.id.clone(),
                cols,
                rows,
            },
            b"",
        )
    }

    fn kill(&self) {
        let _ = self.daemon.send(
            &Request::Kill {
                id: self.id.clone(),
            },
            b"",
        );
    }

    /// The daemon ends the tree and then says `exited`; wait for that like a local terminate
    /// waits for the tree.
    fn terminate(&self) {
        self.kill();
        if self.exit.wait(TERMINATE_WAIT).is_none() {
            eprintln!(
                "[sessiond] {}: no exit after kill; dropping the mirror",
                self.id
            );
            self.daemon.forget(&self.id);
        }
    }
}

/// The mirror's stdin: each write is one `write` frame.
struct RemoteWriter(Arc<RemoteSession>);

impl Write for RemoteWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.daemon.send(
            &Request::Write {
                id: self.0.id.clone(),
            },
            buf,
        )?;
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Tells the windows that agents run inside Lotus this run; they ask [`take_fallback`] first.
pub const FALLBACK_EVENT: &str = "lotus://sessiond-fallback";
static FALLBACK_TAKEN: AtomicBool = AtomicBool::new(false);

/// True once per run, when the daemon is enabled but its first use fell back to in-process PTYs.
pub fn take_fallback() -> bool {
    enabled() && matches!(DAEMON.get(), Some(None)) && !FALLBACK_TAKEN.swap(true, Ordering::SeqCst)
}

/// Step-3 probe kept for the setup hook: connects (starting the daemon) without spawning.
/// A window mounted before this ends learns of a fallback from [`FALLBACK_EVENT`].
pub fn warm_up(app: tauri::AppHandle) {
    if daemon().is_none() {
        use tauri::Emitter;
        let _ = app.emit(FALLBACK_EVENT, ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    /// A daemon left over from an older app answers with its own protocol: we must neither use it
    /// nor start a second one on its socket.
    #[test]
    fn a_daemon_of_another_version_means_in_process() {
        let dir = std::env::temp_dir().join(format!("sdapp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
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
        assert!(connect_at(&socket, Path::new("/nonexistent")).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unset_takes_the_platform_default_and_either_value_forces_it() {
        for default in [true, false] {
            assert_eq!(flag_on(None, default), default);
            assert_eq!(flag_on(Some(""), default), default);
            assert!(flag_on(Some("1"), default));
            assert!(!flag_on(Some("0"), default));
        }
    }

    #[test]
    fn no_daemon_binary_means_in_process() {
        let socket = std::env::temp_dir().join(format!("sdapp-none-{}/s.sock", std::process::id()));
        assert!(connect_at(&socket, Path::new("/nonexistent/lotus-sessiond")).is_none());
    }

    /// The real daemon binary: `LOTUS_SESSIOND_BIN`, else `target/<profile>/lotus-sessiond` beside
    /// this test's `deps/`. `None` (test skipped, loudly) when it was never built.
    fn built_daemon() -> Option<PathBuf> {
        if let Some(p) = std::env::var_os("LOTUS_SESSIOND_BIN") {
            return Some(p.into());
        }
        let bin = std::env::current_exe()
            .ok()?
            .parent()?
            .parent()?
            .join("lotus-sessiond");
        if bin.exists() {
            Some(bin)
        } else {
            eprintln!("SKIPPED: run `cargo build -p lotus-sessiond` first");
            None
        }
    }

    /// A test socket and the guard that ends its daemon when the test ends, even on a panic. The
    /// daemon idles out only with no sessions and no clients, so without it every run left one
    /// daemon per test alive (5 per run, measured 2026-11-20).
    fn short_socket(tag: &str) -> (PathBuf, Reap) {
        let dir = PathBuf::from(format!("/tmp/sdr-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let socket = dir.join("s.sock");
        (socket.clone(), Reap(socket))
    }

    struct Reap(PathBuf);

    impl Drop for Reap {
        fn drop(&mut self) {
            let _ = std::process::Command::new("pkill")
                .arg("-f")
                .arg(format!("lotus-sessiond --socket {}", self.0.display()))
                .status();
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    type Collected = (Arc<Mutex<Vec<u8>>>, OutputSink);

    fn collector() -> Collected {
        let out = Arc::new(Mutex::new(Vec::new()));
        let sink_out = Arc::clone(&out);
        let sink: OutputSink = Box::new(move |b| {
            sink_out.lock().unwrap().extend(b);
            false
        });
        (out, sink)
    }

    fn wait_for(out: &Mutex<Vec<u8>>, needle: &str) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            let text = String::from_utf8_lossy(&out.lock().unwrap()).into_owned();
            if text.contains(needle) {
                return text;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no {needle:?} in {text:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn sh(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", script]);
        // `remote_transport`'s FakeSsh swaps the process PATH for a dir holding only `ssh`, and
        // a CommandBuilder copies the env when made: run beside it, `sleep` was not found.
        cmd.env("PATH", "/usr/bin:/bin");
        cmd
    }

    /// The daemon cutting us loose (a stalled reader) looks like this from our side: the
    /// connection ends mid-output. The mirror must come back on its own and hold every line
    /// exactly once, in order.
    #[test]
    fn a_dropped_connection_resumes_the_mirror_without_gaps_or_repeats() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("drop");
        let d = Daemon::start(socket, bin).expect("daemon");
        let (out, sink) = collector();
        let script = "i=1; while [ $i -le 300 ]; do echo line$i; i=$((i+1)); sleep 0.005; done";
        let (_pty, _) = d
            .spawn(&sh(script), None, "main", 80, 24, Some(sink))
            .unwrap();

        wait_for(&out, "line40\r\n");
        d.stream
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .shutdown(std::net::Shutdown::Both)
            .unwrap();
        let text = wait_for(&out, "[Session ended:");

        let lines: Vec<&str> = text
            .split("\r\n")
            .filter(|l| l.starts_with("line"))
            .collect();
        let want: Vec<String> = (1..=300).map(|i| format!("line{i}")).collect();
        assert_eq!(lines, want);
        assert!(text.ends_with("[Session ended:0]\r\n"), "{text:?}");
    }

    /// The daemon dying takes its sessions along. The next daemon does not know the session,
    /// so the mirror ends as lost (-1) instead of hanging.
    #[test]
    fn a_dead_daemon_ends_its_mirrors_as_lost() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("dead");
        let (_, first) = connect_or_spawn(&socket, &bin, SPAWN_WAIT).expect("first daemon");
        let d = Daemon::start(socket, bin).expect("daemon");
        let (out, sink) = collector();
        let (pty, _) = d
            .spawn(&sh("echo up; sleep 30"), None, "main", 80, 24, Some(sink))
            .unwrap();
        wait_for(&out, "up\r\n");

        unsafe { libc::kill(first as i32, libc::SIGKILL) };
        let text = wait_for(&out, "[Session ended:");
        assert!(text.ends_with("[Session ended:-1]\r\n"), "{text:?}");
        drop(pty);
    }

    fn pane(script: &str, pane_id: &str) -> CommandBuilder {
        let mut cmd = sh(script);
        cmd.env("LOTUS_PANE_ID", pane_id);
        cmd
    }

    /// A restarted app (a second connection) finds the pane's session by `pane_id` and mirrors
    /// it: the drawn screen first, then live output and input both ways.
    #[test]
    fn a_new_app_adopts_a_panes_session_with_its_screen() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("adopt");
        let first = Daemon::start(socket.clone(), bin.clone()).expect("first app");
        let (out1, sink1) = collector();
        let (_old, id) = first
            .spawn(
                // 400 bytes of no-op SGR first: a real session has more output than its screen.
                &pane(
                    "i=0; while [ $i -lt 100 ]; do printf '\\033[0m'; i=$((i+1)); done; printf 'alpha\\nbeta\\n'; exec cat",
                    "pane-7",
                ),
                None,
                "main",
                80,
                24,
                Some(sink1),
            )
            .unwrap();
        wait_for(&out1, "beta\r\n");

        let second = Daemon::start(socket, bin).expect("second app");
        let listed = second.list().unwrap();
        let info = listed
            .iter()
            .find(|s| s.owner.pane_id.as_deref() == Some("pane-7"))
            .expect("listed by pane");
        assert_eq!(info.id, id);
        assert!(!second.mirrors(&id));
        let (out2, sink2) = collector();
        let pty = second.adopt(info, Some(sink2)).unwrap();
        assert!(second.mirrors(&id));
        wait_for(&out2, "beta");
        let screen = pty.screen.lock().unwrap().contents();
        assert!(
            screen.contains("alpha") && screen.contains("beta"),
            "{screen}"
        );

        lotus_pty::write_chunked(&pty.writer, "ping\r").unwrap();
        wait_for(&out2, "ping\r\n");
        wait_for(&out1, "ping\r\n");
        // Pocket reads scrollback by absolute offset, so the adopted mirror counts from where
        // the session is, not from 0 (smoke 5).
        let total = |p: &Pty| p.output_tail.lock().unwrap().total_bytes_seen;
        assert_eq!(
            total(&pty),
            total(&_old),
            "adopted offsets must match the session's"
        );
        assert!(
            second.adopt(info, None).is_err(),
            "a session already mirrored must not get a second mirror"
        );
        first.kill(&id).unwrap();
        wait_for(&out2, "[Session ended:");
    }

    /// Smoke 5 headless: a Pocket-style poller (absolute offsets, like host `output-tail.ts`)
    /// keeps its offset across an app restart and gets the adopted session's new output from it.
    #[test]
    fn a_pocket_poll_resumes_across_an_adopt_without_a_gap() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("poll");
        let first = Daemon::start(socket.clone(), bin.clone()).expect("first app");
        let (out1, sink1) = collector();
        // 1.2 KB, then a clear: the session's stream is far longer than its drawn screen.
        let script = "i=0; while [ $i -lt 30 ]; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\\n'; i=$((i+1)); done; printf '\\033[2J\\033[Hready\\n'; exec cat";
        let (old, id) = first
            .spawn(&pane(script, "pane-p"), None, "main", 80, 24, Some(sink1))
            .unwrap();
        wait_for(&out1, "ready");
        let poll = |p: &Pty, from: u64| p.output_tail.lock().unwrap().read_text(from, 256 * 1024);
        let mut next = 0;
        loop {
            let (at, text) = poll(&old, next);
            if text.is_empty() {
                break;
            }
            next = at + text.len() as u64;
        }
        assert!(next > 1200, "caught up at {next}");
        first.detach(&id);
        drop(old);

        let second = Daemon::start(socket, bin).expect("restarted app");
        let info = second
            .list()
            .unwrap()
            .into_iter()
            .find(|s| s.owner.pane_id.as_deref() == Some("pane-p"))
            .expect("listed by pane");
        let (out2, sink2) = collector();
        let pty = second.adopt(&info, Some(sink2)).unwrap();
        wait_for(&out2, "ready");
        lotus_pty::write_chunked(&pty.writer, "after\r").unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut seen = String::new();
        while !seen.contains("after") {
            let (at, text) = poll(&pty, next);
            if !text.is_empty() {
                assert_eq!(at, next, "a false gap: asked {next}, got {at}");
                next = at + text.len() as u64;
                seen.push_str(&text);
            }
            assert!(
                std::time::Instant::now() < deadline,
                "poller froze at {next}; got {seen:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        second.kill(&id).unwrap();
    }

    /// A page reload lets go of a mirror and the next page adopts the same session.
    #[test]
    fn a_detached_session_runs_on_and_is_adopted_again() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("detach");
        let d = Daemon::start(socket, bin).expect("daemon");
        let (_, sink) = collector();
        let (old, id) = d
            .spawn(
                &pane("exec cat", "pane-9"),
                None,
                "main",
                80,
                24,
                Some(sink),
            )
            .unwrap();
        d.detach(&id);
        drop(old);
        assert!(!d.mirrors(&id));

        let info = d
            .list()
            .unwrap()
            .into_iter()
            .find(|s| s.id == id)
            .expect("still running after detach");
        let (out, sink) = collector();
        let pty = d.adopt(&info, Some(sink)).unwrap();
        lotus_pty::write_chunked(&pty.writer, "again\r").unwrap();
        wait_for(&out, "again\r\n");
        d.kill(&id).unwrap();
    }

    // ── Remote (a machine's daemon over an SSH forward) ──────────────────────────────────────

    /// A source that hands out `socket` and counts how often it was asked: every ask is one
    /// connect, the first one and each reconnect.
    fn counting_source(socket: PathBuf) -> (Arc<std::sync::atomic::AtomicUsize>, SocketSource) {
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&asked);
        let source: SocketSource = Box::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(Some(socket.clone()))
        });
        (asked, source)
    }

    /// The SSH link dropping mid-output is the case this whole path exists for (the agent in a
    /// pane died with its `ssh -t`, 2026-11-26). The mirror must reconnect through its source
    /// and hold every line exactly once, in order.
    #[test]
    fn a_dropped_remote_link_reconnects_through_its_source_without_gaps() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("rdrop");
        connect_or_spawn(&socket, &bin, SPAWN_WAIT).expect("the machine's daemon");
        let (asked, source) = counting_source(socket);
        let d = Daemon::start_remote("test-machine".into(), source).expect("remote daemon");
        let (out, sink) = collector();
        let script = "i=1; while [ $i -le 300 ]; do echo line$i; i=$((i+1)); sleep 0.01; done";
        let (_pty, _) = d
            .spawn(&sh(script), None, "main", 80, 24, Some(sink))
            .unwrap();

        wait_for(&out, "line40\r\n");
        d.stream
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .shutdown(std::net::Shutdown::Both)
            .unwrap();
        let text = wait_for(&out, "[Session ended:");

        let lines: Vec<&str> = text
            .split("\r\n")
            .filter(|l| l.starts_with("line"))
            .collect();
        let want: Vec<String> = (1..=300).map(|i| format!("line{i}")).collect();
        assert_eq!(lines, want);
        assert!(text.ends_with("[Session ended:0]\r\n"), "{text:?}");
        assert!(asked.load(Ordering::SeqCst) >= 2, "never reconnected through the source");
    }

    /// "Retry now" in a pane must not wait out a 30 s backoff.
    #[test]
    fn retry_now_cuts_a_reconnect_wait_short() {
        let d = Arc::new(Daemon {
            connector: Connector::Remote {
                label: "retry-test".into(),
                source: Box::new(|| Ok(None)),
            },
            stream: Mutex::new(None),
            links: Mutex::new(Links::default()),
            next_req: AtomicU64::new(1),
            wake: (Mutex::new(false), std::sync::Condvar::new()),
        });
        let sleeper = Arc::clone(&d);
        let started = std::time::Instant::now();
        let waiting = std::thread::spawn(move || sleeper.sleep_unless_woken(Duration::from_secs(30)));
        std::thread::sleep(Duration::from_millis(100));
        d.retry_now();
        assert!(waiting.join().unwrap(), "not woken");
        assert!(started.elapsed() < Duration::from_secs(5));
        // Without a wake it sleeps the whole wait and says so.
        assert!(!d.sleep_unless_woken(Duration::from_millis(50)));
    }

    /// A machine without a Lotus host has no daemon: that is the plain `ssh -t` pane, not an error,
    /// and nothing is left registered for it.
    #[test]
    fn a_machine_without_a_daemon_is_a_fallback_not_a_connection() {
        let key = format!("no-daemon-{}", std::process::id());
        let got = remote_daemon(&key, || Box::new(|| Ok(None)));
        assert!(got.is_none());
        let slot = remotes().lock().unwrap().get(&key).map(Arc::clone).unwrap();
        assert!(slot.lock().unwrap().is_none());
    }

    /// The far daemon belongs to that machine's host, which adopts any session whose tag carries a
    /// `sessionId` (`adoptableSessions`). A pane's session must say it is the desktop's instead.
    #[test]
    fn a_remote_session_is_tagged_as_the_desktops_not_the_hosts() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("rtag");
        connect_or_spawn(&socket, &bin, SPAWN_WAIT).expect("the machine's daemon");
        let (_, source) = counting_source(socket);
        let d = Daemon::start_remote("test-machine".into(), source).expect("remote daemon");
        let (_pty, id) = d
            .spawn(&pane("sleep 5", "pane-r1"), Some("term-r1".into()), "main", 80, 24, None)
            .unwrap();

        let info = d.list().unwrap().into_iter().find(|s| s.id == id).expect("listed");
        let tag: serde_json::Value = serde_json::from_str(info.tag.as_deref().unwrap()).unwrap();
        assert_eq!(tag["origin"], "desktop");
        assert_eq!(tag["client"], desktop_id());
        assert_eq!(tag["paneId"], "pane-r1");
        assert_eq!(tag["canvasTerminalId"], "term-r1");
        assert!(tag.get("sessionId").is_none(), "{tag}");
        d.kill(&id).unwrap();
    }

    /// A local session keeps no tag, exactly as before this change.
    #[test]
    fn a_local_session_has_no_tag() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("ltag");
        let d = Daemon::start(socket, bin).expect("daemon");
        let (_pty, id) = d.spawn(&pane("sleep 5", "pane-l1"), None, "main", 80, 24, None).unwrap();
        let info = d.list().unwrap().into_iter().find(|s| s.id == id).expect("listed");
        assert_eq!(info.tag, None);
        d.kill(&id).unwrap();
    }

    /// With no session on it, a lost remote link is let go instead of retried forever (each try
    /// would be an SSH handshake), and the next pane on that machine connects afresh.
    #[test]
    fn a_lost_remote_link_with_no_sessions_is_let_go() {
        let Some(bin) = built_daemon() else { return };
        let (socket, _reap) = short_socket("ridle");
        connect_or_spawn(&socket, &bin, SPAWN_WAIT).expect("the machine's daemon");
        let key = format!("idle-machine-{}", std::process::id());
        let (asked, source) = counting_source(socket);
        let d = remote_daemon(&key, move || source).expect("remote daemon");
        assert_eq!(asked.load(Ordering::SeqCst), 1);
        d.stream
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .shutdown(std::net::Shutdown::Both)
            .unwrap();

        let slot = remotes().lock().unwrap().get(&key).map(Arc::clone).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while slot.lock().unwrap().is_some() {
            assert!(std::time::Instant::now() < deadline, "idle remote link was kept");
            std::thread::sleep(Duration::from_millis(20));
        }
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(asked.load(Ordering::SeqCst), 1, "an idle link was reconnected");
    }
}
