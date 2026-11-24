//! The daemon: a table of PTY sessions served to clients over one Unix socket.
//!
//! Threads: one accept loop (also the idle clock), per client a reader and a writer, per session
//! the lotus-pty pipeline plus an input writer. Nothing a client does can block a session's
//! output: fan-out uses bounded `try_send`, and a client that falls behind is disconnected — it
//! reattaches from its last offset and sees the gap honestly.

use crate::proto::*;
use lotus_pty::{CommandBuilder, Pty};
use std::collections::HashMap;
use std::io;
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Config {
    /// Shut down once there have been no sessions and no clients for this long.
    pub idle_timeout: Duration,
    /// Only a peer with this uid is served (`getpeereid`, `SO_PEERCRED` on Linux).
    pub allowed_uid: u32,
    /// Frames queued for one client before it counts as stalled and is cut loose. Output is
    /// flushed about every 16 ms per session, so 1024 frames is ~17 s of a stalled reader on
    /// one busy session; the client then reattaches from its last offset.
    pub client_queue: usize,
}

impl Config {
    pub const DEFAULT_CLIENT_QUEUE: usize = 1024;
}

const ACCEPT_POLL: Duration = Duration::from_millis(20);

type Out = (Event, Vec<u8>);

struct ClientHandle {
    tx: SyncSender<Out>,
    stream: UnixStream,
}

/// Who gets a session's live output. `offset` counts bytes handed to the sink, which runs after
/// lotus-pty pushed them to the ring, so under this lock the ring holds at least `offset` bytes.
#[derive(Default)]
struct Fanout {
    offset: u64,
    subs: HashMap<u64, SyncSender<Out>>,
}

struct Session {
    pty: Mutex<Option<Pty>>,
    owner: Owner,
    cwd: Option<String>,
    tag: Option<String>,
    fanout: Arc<Mutex<Fanout>>,
    input: Mutex<Sender<Vec<u8>>>,
    /// While a `kill` is sweeping the tree, the exit hook leaves the code here instead of
    /// announcing it: the root dies first, and `exited` must mean the whole tree is gone.
    killing: Mutex<Killing>,
}

#[derive(Default)]
struct Killing {
    active: bool,
    code: Option<i32>,
}

struct Shared {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    clients: Mutex<HashMap<u64, ClientHandle>>,
    next_id: AtomicU64,
    allowed_uid: u32,
    client_queue: usize,
}

impl Shared {
    fn drop_client(&self, cid: u64) {
        if let Some(c) = self.clients.lock().unwrap().remove(&cid) {
            let _ = c.stream.shutdown(Shutdown::Both);
        }
        for s in self.sessions.lock().unwrap().values() {
            s.fanout.lock().unwrap().subs.remove(&cid);
        }
    }

    /// Never blocks: a client whose queue is full is cut loose.
    fn send(&self, cid: u64, tx: &SyncSender<Out>, out: Out) {
        if let Err(TrySendError::Full(_)) = tx.try_send(out) {
            if let Some(c) = self.clients.lock().unwrap().get(&cid) {
                let _ = c.stream.shutdown(Shutdown::Both);
            }
        }
    }

    fn broadcast(&self, out: Out) {
        let targets: Vec<(u64, SyncSender<Out>)> = self
            .clients
            .lock()
            .unwrap()
            .iter()
            .map(|(id, c)| (*id, c.tx.clone()))
            .collect();
        for (cid, tx) in targets {
            self.send(cid, &tx, out.clone());
        }
    }
}

/// Serves until idle shutdown. The caller binds the socket (path, permissions) first.
pub fn serve(listener: UnixListener, config: Config) -> io::Result<()> {
    listener.set_nonblocking(true)?;
    let shared = Arc::new(Shared {
        sessions: Mutex::new(HashMap::new()),
        clients: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
        allowed_uid: config.allowed_uid,
        client_queue: config.client_queue,
    });
    let mut idle_since: Option<Instant> = None;
    loop {
        match listener.accept() {
            Ok((stream, _)) => {
                idle_since = None;
                let shared = Arc::clone(&shared);
                std::thread::spawn(move || serve_client(shared, stream));
                continue;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
            Err(e) => return Err(e),
        }
        let idle =
            shared.sessions.lock().unwrap().is_empty() && shared.clients.lock().unwrap().is_empty();
        if !idle {
            idle_since = None;
        } else if idle_since.get_or_insert_with(Instant::now).elapsed() >= config.idle_timeout {
            return Ok(());
        }
        std::thread::sleep(ACCEPT_POLL);
    }
}

fn serve_client(shared: Arc<Shared>, mut stream: UnixStream) {
    if stream.set_nonblocking(false).is_err()
        || crate::client::peer_uid(&stream).ok() != Some(shared.allowed_uid)
    {
        return;
    }
    match read_frame::<Request>(&mut stream) {
        Ok((Request::Hello { proto }, _)) => {
            let hello = Event::Hello {
                proto: PROTO_VERSION,
                daemon_pid: std::process::id(),
                features: FEATURES.iter().map(|f| f.to_string()).collect(),
            };
            if write_frame(&mut stream, &hello, b"").is_err() || proto != PROTO_VERSION {
                return;
            }
        }
        _ => return,
    }
    let Ok(write_half) = stream.try_clone() else {
        return;
    };
    let Ok(handle_stream) = stream.try_clone() else {
        return;
    };

    let cid = shared.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::sync_channel::<Out>(shared.client_queue);
    shared.clients.lock().unwrap().insert(
        cid,
        ClientHandle {
            tx: tx.clone(),
            stream: handle_stream,
        },
    );
    std::thread::spawn(move || {
        let mut w = write_half;
        for (event, payload) in rx {
            if write_frame(&mut w, &event, &payload).is_err() {
                let _ = w.shutdown(Shutdown::Both);
                break;
            }
        }
    });

    while let Ok((req, payload)) = read_frame::<Request>(&mut stream) {
        handle(&shared, cid, &tx, req, payload);
    }
    shared.drop_client(cid);
}

fn find(shared: &Shared, id: &str) -> Option<Arc<Session>> {
    shared.sessions.lock().unwrap().get(id).cloned()
}

fn handle(shared: &Arc<Shared>, cid: u64, tx: &SyncSender<Out>, req: Request, payload: Vec<u8>) {
    let reply = |out: Out| shared.send(cid, tx, out);
    let unknown = |id: &str| {
        (
            Event::Error {
                req: None,
                id: Some(id.to_string()),
                message: format!("no session {id}"),
            },
            Vec::new(),
        )
    };
    match req {
        Request::Hello { .. } => {}
        Request::Create { req, spec } => create(shared, cid, tx, req, spec),
        Request::Write { id } => match find(shared, &id) {
            Some(s) => {
                let _ = s.input.lock().unwrap().send(payload);
            }
            None => reply(unknown(&id)),
        },
        Request::Resize { id, cols, rows } => match find(shared, &id) {
            Some(s) => {
                if let Some(pty) = s.pty.lock().unwrap().as_ref() {
                    let _ = pty.resize(cols, rows);
                }
            }
            None => reply(unknown(&id)),
        },
        Request::Kill { id } => {
            let session = find(shared, &id);
            let pty = session.as_ref().and_then(|s| s.pty.lock().unwrap().take());
            match (session, pty) {
                (Some(session), Some(pty)) => {
                    session.killing.lock().unwrap().active = true;
                    let shared = Arc::clone(shared);
                    std::thread::spawn(move || {
                        pty.terminate();
                        // The tree is gone. Announce the code the hook kept; if the hook has
                        // not run yet, it announces it itself.
                        let mut k = session.killing.lock().unwrap();
                        k.active = false;
                        if let Some(code) = k.code.take() {
                            drop(k);
                            shared.broadcast((Event::Exited { id, code }, Vec::new()));
                        }
                    });
                }
                _ => reply(unknown(&id)),
            }
        }
        Request::List { req } => {
            let sessions = shared
                .sessions
                .lock()
                .unwrap()
                .iter()
                .filter_map(|(id, s)| {
                    let guard = s.pty.lock().unwrap();
                    let pty = guard.as_ref()?;
                    let size = pty.size().ok()?;
                    let total_bytes = pty.output_tail.lock().unwrap().total_bytes_seen;
                    Some(SessionInfo {
                        id: id.clone(),
                        owner: s.owner.clone(),
                        cols: size.cols,
                        rows: size.rows,
                        total_bytes,
                        idle: pty.is_shell_idle.load(Ordering::Relaxed),
                        started_ago_ms: pty.started_at.elapsed().as_millis() as u64,
                        pid: pty.child_pid,
                        cwd: s.cwd.clone(),
                        tag: s.tag.clone(),
                    })
                })
                .collect();
            reply((Event::Sessions { req, sessions }, Vec::new()));
        }
        Request::Attach { id, from } => match find(shared, &id) {
            Some(s) => attach(shared, cid, tx, &id, &s, from, true),
            None => reply(unknown(&id)),
        },
        Request::Snapshot { req, id } => match find(shared, &id) {
            Some(s) => {
                let guard = s.pty.lock().unwrap();
                let Some(pty) = guard.as_ref() else {
                    return reply(unknown(&id));
                };
                let size = pty.size().unwrap_or_default();
                let text = pty
                    .screen
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contents();
                drop(guard);
                reply((
                    Event::Snapshot {
                        req,
                        id,
                        cols: size.cols,
                        rows: size.rows,
                    },
                    text.into_bytes(),
                ));
            }
            None => reply(unknown(&id)),
        },
        Request::Detach { id } => {
            if let Some(s) = find(shared, &id) {
                s.fanout.lock().unwrap().subs.remove(&cid);
            }
        }
    }
}

/// Screen first, then the ring from `from`, then live — all queued under the fan-out lock, so
/// the sink cannot slip a live chunk in between. The screen may stand past the replay's end
/// (bytes in flight to the sink); a client drawing the screen skips output below its offset.
fn attach(
    shared: &Shared,
    cid: u64,
    tx: &SyncSender<Out>,
    id: &str,
    s: &Session,
    from: u64,
    with_screen: bool,
) {
    let mut fanout = s.fanout.lock().unwrap();
    let guard = s.pty.lock().unwrap();
    let Some(pty) = guard.as_ref() else { return };
    if with_screen {
        let (total_bytes, screen) = pty.screen_snapshot();
        shared.send(
            cid,
            tx,
            (
                Event::Screen {
                    id: id.into(),
                    total_bytes,
                },
                screen,
            ),
        );
    }
    let from = from.min(fanout.offset);
    let (start, bytes) = pty
        .output_tail
        .lock()
        .unwrap()
        .read_range(from, (fanout.offset - from) as usize);
    if !bytes.is_empty() {
        shared.send(
            cid,
            tx,
            (
                Event::Output {
                    id: id.into(),
                    offset: start,
                },
                bytes,
            ),
        );
    }
    fanout.subs.insert(cid, tx.clone());
}

fn create(shared: &Arc<Shared>, cid: u64, tx: &SyncSender<Out>, req: u64, spec: SpawnSpec) {
    let fail = |message: String| {
        shared.send(
            cid,
            tx,
            (
                Event::Error {
                    req: Some(req),
                    id: None,
                    message,
                },
                Vec::new(),
            ),
        )
    };
    let Some(program) = spec.argv.first() else {
        return fail("empty argv".into());
    };
    let mut cmd = CommandBuilder::new(program);
    cmd.args(&spec.argv[1..]);
    cmd.env_clear();
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    // The orphan reaper treats a session whose owner pid is dead as abandoned.
    cmd.env("LOTUS_PTY_OWNER_PID", std::process::id().to_string());
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }

    let id = format!(
        "{}-{}",
        std::process::id(),
        shared.next_id.fetch_add(1, Ordering::Relaxed)
    );
    let fanout = Arc::new(Mutex::new(Fanout::default()));
    let sink_fanout = Arc::clone(&fanout);
    let sink_shared = Arc::downgrade(shared);
    let sink_id = id.clone();
    let sink = Box::new(move |bytes: Vec<u8>| {
        let mut f = sink_fanout.lock().unwrap();
        let offset = f.offset;
        f.offset += bytes.len() as u64;
        if let Some(shared) = sink_shared.upgrade() {
            for (cid, sub) in &f.subs {
                let event = Event::Output {
                    id: sink_id.clone(),
                    offset,
                };
                shared.send(*cid, sub, (event, bytes.clone()));
            }
        }
        false // never stop the flusher: the ring and screen must keep up with nobody attached
    });
    let exit_shared = Arc::downgrade(shared);
    let exit_id = id.clone();
    let on_exit = Box::new(move |code: i32| {
        let Some(shared) = exit_shared.upgrade() else {
            return;
        };
        let session = shared.sessions.lock().unwrap().remove(&exit_id);
        if let Some(s) = &session {
            let mut k = s.killing.lock().unwrap();
            if k.active {
                k.code = Some(code);
                return;
            }
        }
        shared.broadcast((Event::Exited { id: exit_id, code }, Vec::new()));
        // Dropped off this thread's stack: it is the session's own flusher thread.
        drop(session);
    });

    // Held across spawn so a child that exits at once cannot reach the exit hook before it is
    // in the table, and so `created` is queued before that `exited`.
    let mut sessions = shared.sessions.lock().unwrap();
    let pty = match Pty::spawn_with_exit(cmd, spec.cols, spec.rows, Some(sink), Some(on_exit)) {
        Ok(pty) => pty,
        Err(e) => {
            drop(sessions);
            return fail(e.to_string());
        }
    };
    let (input_tx, input_rx) = mpsc::channel::<Vec<u8>>();
    let writer = Arc::clone(&pty.writer);
    // A paste into a busy program blocks until it reads stdin; it must not block this client.
    std::thread::spawn(move || {
        for bytes in input_rx {
            if lotus_pty::write_chunked(&writer, &String::from_utf8_lossy(&bytes)).is_err() {
                break;
            }
        }
    });
    let pid = pty.child_pid;
    let session = Arc::new(Session {
        pty: Mutex::new(Some(pty)),
        owner: spec.owner,
        cwd: spec.cwd,
        tag: spec.tag,
        fanout,
        input: Mutex::new(input_tx),
        killing: Mutex::default(),
    });
    sessions.insert(id.clone(), Arc::clone(&session));
    shared.send(
        cid,
        tx,
        (
            Event::Created {
                req,
                id: id.clone(),
                pid,
            },
            Vec::new(),
        ),
    );
    // Still under the table lock: a child that exits at once cannot announce `exited` before
    // its creator holds every byte it printed (`echo hi; exit` would otherwise lose `hi`).
    attach(shared, cid, tx, &id, &session, 0, false);
}
