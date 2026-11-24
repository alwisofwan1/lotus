//! One PTY and the child behind it: spawn, the reader→flusher output pipeline, the output ring,
//! the rendered screen, and teardown of the whole process tree.
//!
//! No Tauri, no app policy (accounts, env, window labels, capacity): the app and, later,
//! `lotus-sessiond` build the `CommandBuilder` and keep their own store (ADR-0067).

pub mod agent_detect;
pub mod da_filter;
pub mod flusher;
pub mod output_tail;
pub mod process_tree;
pub mod screen;
pub mod size_lease;

pub use output_tail::{OutputTail, PtyOutputMetrics};
pub use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize};

use std::borrow::Cow;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;
use tokio::sync::broadcast;

/// Where output goes besides the ring and the broadcast; returns `true` once its receiver is gone.
pub type OutputSink = Box<dyn FnMut(Vec<u8>) -> bool + Send>;
/// Called once with the exit code, after the end marker reached the ring and the sink.
pub type ExitHook = Box<dyn FnOnce(i32) + Send>;

/// The far side of a [`Pty::mirror`]: the process lives elsewhere (the session daemon) and is
/// steered through this.
pub trait Remote: Send + Sync {
    fn resize(&self, cols: u16, rows: u16) -> io::Result<()>;
    /// Signals the process; returns at once.
    fn kill(&self);
    /// Ends the process tree and returns only once it is gone (or the far side gave up on it).
    fn terminate(&self);
}

enum Control {
    Local {
        master: Box<dyn MasterPty + Send>,
        killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
        /// Owns the OS process-tree boundary for this PTY. On Windows this is a
        /// kill-on-close Job Object; Unix performs an explicit descendant sweep.
        _process_tree_guard: process_tree::PtyProcessTreeGuard,
    },
    Remote {
        remote: Arc<dyn Remote>,
        size: Mutex<PtySize>,
    },
}

pub struct Pty {
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child_pid: Option<u32>,
    pub output_tail: Arc<Mutex<OutputTail>>,
    /// The same bytes as `output_tail`, but drawn. A TUI's layout lives in its cursor moves, so
    /// the raw stream cannot be turned back into rows after the fact (`issues/18`).
    pub screen: screen::SharedTerminalScreen,
    pub broadcast_tx: broadcast::Sender<String>,
    /// OSC 133 idle flag: `true` when the shell is at its prompt (PromptStart
    /// or CommandDone received), `false` while a command is running.
    /// Starts `true` because a fresh shell shows a prompt before any output.
    pub is_shell_idle: Arc<AtomicBool>,
    /// Whether an OSC 133 marker was ever observed on this session.
    ///
    /// `is_shell_idle` starts `true` and a runner spawned directly as the PTY child may never
    /// emit a marker at all, so without this the flag reads "idle" for the entire life of a
    /// hard-working agent. Anything deciding a session is abandoned has to know whether the
    /// signal it is reading was ever real.
    pub saw_idle_marker: Arc<AtomicBool>,
    /// When the PTY was created. Monotonic, so a clock change cannot make a session look stale.
    pub started_at: Instant,
    /// Milliseconds after `started_at` at which output was last seen. An atomic counter rather
    /// than a lock: this is written on the flusher's hot path, once per output burst.
    pub last_output_ms: Arc<AtomicU64>,
    control: Control,
}

/// What [`start_pipeline`] hands back: everything a reader of the session looks at.
struct Pipeline {
    output_tail: Arc<Mutex<OutputTail>>,
    screen: screen::SharedTerminalScreen,
    broadcast_tx: broadcast::Sender<String>,
    is_shell_idle: Arc<AtomicBool>,
    saw_idle_marker: Arc<AtomicBool>,
    started_at: Instant,
    last_output_ms: Arc<AtomicU64>,
}

/// Where a pipeline's bytes come from and how its end is learned.
struct Source {
    reader: Box<dyn Read + Send>,
    /// Device-attribute queries are answered here. `None` when someone upstream already
    /// answered them (a mirror: the daemon's own pipeline did).
    da_writer: Option<Arc<Mutex<Box<dyn Write + Send>>>>,
    /// Blocks until the process is gone; its exit code.
    wait: Box<dyn FnOnce() -> i32 + Send>,
    /// Whether to append `[Session ended:N]`. A mirror's stream already carries it.
    emit_marker: bool,
}

fn start_pipeline(
    source: Source,
    cols: u16,
    rows: u16,
    mut on_output: Option<OutputSink>,
    on_exit: Option<ExitHook>,
) -> Pipeline {
    let Source {
        reader,
        da_writer,
        wait,
        emit_marker,
    } = source;
    let output_tail = Arc::new(Mutex::new(OutputTail::default()));
    let screen = Arc::new(Mutex::new(screen::TerminalScreen::new(rows, cols)));
    let (broadcast_tx, _) = broadcast::channel::<String>(1024);
    let is_shell_idle = Arc::new(AtomicBool::new(true));
    let saw_idle_marker = Arc::new(AtomicBool::new(false));
    let started_at = Instant::now();
    let last_output_ms = Arc::new(AtomicU64::new(0));

    let tail_for_thread = Arc::clone(&output_tail);
    let screen_for_thread = Arc::clone(&screen);
    let broadcast_for_thread = broadcast_tx.clone();
    let is_idle_for_thread = Arc::clone(&is_shell_idle);
    let saw_marker_for_thread = Arc::clone(&saw_idle_marker);
    let last_output_for_thread = Arc::clone(&last_output_ms);

    // Two-thread PTY pipeline (Terax-style):
    //   Reader thread  — blocking read() → SharedPtyPendingOutput (Mutex+Condvar)
    //   Flusher thread — PTY_OUTPUT_FLUSH_INTERVAL (16ms) coalesce window → sink + broadcast + OutputTail
    //
    // Burst coalescing is emergent: while the flusher is busy with a sink call,
    // the reader accumulates bytes in the shared buffer. The next condvar wake drains
    // everything as one batch, cutting IPC message count from O(reads/sec) to
    // O(max 250/sec) during heavy output (cat bigfile, builds, etc.).
    use flusher::{run_pty_flusher_loop, run_pty_reader, PtyOutputFlusher, PtyPendingOutput};

    let pending_output = Arc::new((
        Mutex::new(PtyPendingOutput {
            bytes: Vec::new(),
            ended: false,
        }),
        Condvar::new(),
    ));

    // Thread 1: PTY master → DA filter → shared pending buffer.
    // The DA filter intercepts device-attribute queries and writes replies back
    // to the PTY master via `da_writer` so TUI apps (vim, htop, claude CLI)
    // get capability responses even when the pane is hidden in another workspace.
    //
    // The reply never waits for the writer lock on this thread: a paste blocked on a full
    // tty input queue holds that lock until the program reads stdin, and the program may
    // first need its output drained — by this thread. So replies go, in order, to a writer
    // thread started on the first query and ended when the reader's sender drops.
    let pending_for_reader = Arc::clone(&pending_output);
    std::thread::spawn(move || {
        let mut da_tx: Option<std::sync::mpsc::Sender<Vec<u8>>> = None;
        run_pty_reader(reader, pending_for_reader, |reply| {
            let Some(writer_for_da) = da_writer.as_ref() else {
                return;
            };
            let tx = da_tx.get_or_insert_with(|| {
                let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
                let writer = Arc::clone(writer_for_da);
                std::thread::spawn(move || {
                    for reply in rx {
                        if let Ok(mut w) = writer.lock() {
                            let _ = w.write_all(&reply);
                            let _ = w.flush();
                        }
                    }
                });
                tx
            });
            let _ = tx.send(reply.to_vec());
        });
    });

    // Thread 2: shared buffer → 16ms burst coalescing → emit
    let pending_for_flusher = Arc::clone(&pending_output);
    let mut agent_detector = agent_detect::AgentDetector::new();
    let mut utf8_carry: Vec<u8> = Vec::new();
    std::thread::spawn(move || {
        run_pty_flusher_loop(
            pending_for_flusher,
            PtyOutputFlusher::new(),
            |data: Vec<u8>| {
                // Drawn here, on the way past, rather than replayed later: rendering a TAIL
                // would start mid-stream against a blank grid, and whether that lands on a
                // complete repaint depends on what the agent happened to redraw.
                // The tail is pushed under the screen lock so `screen_snapshot` can name
                // the exact offset the drawn screen stands at.
                if let Ok(mut screen) = screen_for_thread.lock() {
                    if let Ok(mut tail) = tail_for_thread.lock() {
                        tail.push_bytes(&data);
                    }
                    screen.push_bytes(&data);
                }
                // OSC 133 shell-integration: update idle flag from prompt/command markers.
                last_output_for_thread
                    .store(started_at.elapsed().as_millis() as u64, Ordering::Relaxed);
                agent_detector.observe(&data, |signal| {
                    // OSC 7501 is read by the app's output sink, which knows the pane.
                    if matches!(signal, agent_detect::AgentSignal::ProgramStatus(_)) {
                        return;
                    }
                    // Reaching here at all is the proof that this runner speaks OSC 133.
                    saw_marker_for_thread.store(true, Ordering::Relaxed);
                    is_idle_for_thread.store(signal.is_idle(), Ordering::Relaxed);
                });
                // Broadcast (SSE / API server) is text, decoded once here for every
                // subscriber. A character cut by the flush boundary waits (≤3 bytes) for
                // its rest instead of becoming U+FFFD; no subscribers, no decode.
                let joined: Cow<[u8]> = if utf8_carry.is_empty() {
                    Cow::Borrowed(&data)
                } else {
                    let mut v = std::mem::take(&mut utf8_carry);
                    v.extend_from_slice(&data);
                    Cow::Owned(v)
                };
                let cut = joined.len() - output_tail::unfinished_tail(&joined);
                if broadcast_for_thread.receiver_count() > 0 && cut > 0 {
                    let text = String::from_utf8_lossy(&joined[..cut]).into_owned();
                    let _ = broadcast_for_thread.send(text);
                }
                utf8_carry = joined[cut..].to_vec();
                if let Some(ref mut output) = on_output {
                    return output(data);
                }
                false
            },
        );
        // run_pty_flusher_loop returns only after ended=true (or the sink closed).
        // Wait for the child process and emit the session-end marker.
        let exit_code = wait();
        if emit_marker {
            let marker = format!("[Session ended:{exit_code}]\r\n");
            // Drawn as well, like xterm does, so `screen_snapshot` stays at its offset.
            if let Ok(mut screen) = screen_for_thread.lock() {
                if let Ok(mut tail) = tail_for_thread.lock() {
                    tail.push(&marker);
                }
                screen.push_bytes(marker.as_bytes());
            }
            let _ = broadcast_for_thread.send(marker.clone());
            if let Some(ref mut output) = on_output {
                output(marker.into_bytes());
            }
        }
        if let Some(on_exit) = on_exit {
            on_exit(exit_code);
        }
    });

    Pipeline {
        output_tail,
        screen,
        broadcast_tx,
        is_shell_idle,
        saw_idle_marker,
        started_at,
        last_output_ms,
    }
}

/// `Read` over chunks pushed from elsewhere; EOF once the sender is dropped.
struct ChannelReader {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    left: Vec<u8>,
    at: usize,
}

impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.at == self.left.len() {
            match self.rx.recv() {
                Ok(chunk) => {
                    self.left = chunk;
                    self.at = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.left.len() - self.at);
        out[..n].copy_from_slice(&self.left[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

impl Pty {
    /// Opens a PTY of `cols`×`rows` (80×24 when zero) and starts `command` in it.
    pub fn spawn(
        command: CommandBuilder,
        cols: u16,
        rows: u16,
        on_output: Option<OutputSink>,
    ) -> io::Result<Pty> {
        Self::spawn_with_exit(command, cols, rows, on_output, None)
    }

    /// [`Pty::spawn`], plus `on_exit` once the child is gone.
    pub fn spawn_with_exit(
        command: CommandBuilder,
        cols: u16,
        rows: u16,
        on_output: Option<OutputSink>,
        on_exit: Option<ExitHook>,
    ) -> io::Result<Pty> {
        let init_cols = if cols > 0 { cols } else { 80 };
        let init_rows = if rows > 0 { rows } else { 24 };

        let pair = portable_pty::native_pty_system()
            .openpty(PtySize {
                rows: init_rows,
                cols: init_cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(io::Error::other)?;

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(io::Error::other)?;
        let child_pid = child.process_id();
        let killer = child.clone_killer();
        let process_tree_guard = process_tree::PtyProcessTreeGuard::for_child_process(child_pid);

        let reader = pair.master.try_clone_reader().map_err(io::Error::other)?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(io::Error::other)?,
        ));
        let p = start_pipeline(
            Source {
                reader,
                da_writer: Some(Arc::clone(&writer)),
                wait: Box::new(move || {
                    child
                        .wait()
                        .ok()
                        .map(|status| status.exit_code() as i32)
                        .unwrap_or(-1)
                }),
                emit_marker: true,
            },
            init_cols,
            init_rows,
            on_output,
            on_exit,
        );
        Ok(Pty {
            writer,
            child_pid,
            output_tail: p.output_tail,
            screen: p.screen,
            broadcast_tx: p.broadcast_tx,
            is_shell_idle: p.is_shell_idle,
            saw_idle_marker: p.saw_idle_marker,
            started_at: p.started_at,
            last_output_ms: p.last_output_ms,
            control: Control::Local {
                master: pair.master,
                killer: Mutex::new(killer),
                _process_tree_guard: process_tree_guard,
            },
        })
    }

    /// A session whose process runs elsewhere (ADR-0067): `feed` carries its output, already
    /// DA-answered and ending in the end marker; the feed closing means the process is gone,
    /// and `wait` then gives its code. Readers see the same ring, screen, broadcast and agent
    /// flags as for a local PTY.
    #[allow(clippy::too_many_arguments)]
    pub fn mirror(
        feed: std::sync::mpsc::Receiver<Vec<u8>>,
        writer: Box<dyn Write + Send>,
        remote: Arc<dyn Remote>,
        wait: Box<dyn FnOnce() -> i32 + Send>,
        child_pid: Option<u32>,
        cols: u16,
        rows: u16,
        on_output: Option<OutputSink>,
    ) -> Pty {
        let cols = if cols > 0 { cols } else { 80 };
        let rows = if rows > 0 { rows } else { 24 };
        let p = start_pipeline(
            Source {
                reader: Box::new(ChannelReader {
                    rx: feed,
                    left: Vec::new(),
                    at: 0,
                }),
                da_writer: None,
                wait,
                emit_marker: false,
            },
            cols,
            rows,
            on_output,
            None,
        );
        Pty {
            writer: Arc::new(Mutex::new(writer)),
            child_pid,
            output_tail: p.output_tail,
            screen: p.screen,
            broadcast_tx: p.broadcast_tx,
            is_shell_idle: p.is_shell_idle,
            saw_idle_marker: p.saw_idle_marker,
            started_at: p.started_at,
            last_output_ms: p.last_output_ms,
            control: Control::Remote {
                remote,
                size: Mutex::new(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                }),
            },
        }
    }

    /// The size the program was last told.
    pub fn size(&self) -> io::Result<PtySize> {
        match &self.control {
            Control::Local { master, .. } => master.get_size().map_err(io::Error::other),
            Control::Remote { size, .. } => Ok(*size.lock().unwrap_or_else(|e| e.into_inner())),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        // The grid has to follow the pty, or every row it holds is measured against a width the
        // agent stopped drawing for.
        if let Ok(mut screen) = self.screen.lock() {
            screen.resize(rows, cols);
        }
        let new = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        match &self.control {
            Control::Local { master, .. } => master.resize(new).map_err(io::Error::other),
            Control::Remote { remote, size } => {
                remote.resize(cols, rows)?;
                *size.lock().unwrap_or_else(|e| e.into_inner()) = new;
                Ok(())
            }
        }
    }

    /// The drawn screen as bytes that redraw it (cursor and modes included), and the absolute
    /// output offset it stands at.
    pub fn screen_snapshot(&self) -> (u64, Vec<u8>) {
        let screen = self.screen.lock().unwrap_or_else(|e| e.into_inner());
        let offset = self
            .output_tail
            .lock()
            .map(|t| t.total_bytes_seen)
            .unwrap_or(0);
        (offset, screen.state_formatted())
    }

    /// Signals the direct child only; the PTY stays open until this value is dropped.
    pub fn kill(&self) {
        match &self.control {
            Control::Local { killer, .. } => {
                if let Ok(mut killer) = killer.lock() {
                    let _ = killer.kill();
                }
            }
            Control::Remote { remote, .. } => remote.kill(),
        }
    }

    /// Ends the whole process tree, then closes the PTY. Returns only once the tree is gone.
    pub fn terminate(self) {
        if let Control::Remote { remote, .. } = &self.control {
            remote.terminate();
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.child_pid {
            process_tree::terminate_process_tree(pid, std::time::Duration::from_millis(200));
        }
        self.kill();
        // Dropping self (including the master and Windows Job Object guard) closes
        // the PTY and releases the final platform process-tree ownership boundary.
    }
}

/// Writes `data` in pieces the tty will take ([`chunk_for_tty`]), flushing between them. Takes the
/// writer, not the [`Pty`], so a caller can clone it out of its store and release the store's lock
/// before a write that may block.
pub fn write_chunked(writer: &Mutex<Box<dyn Write + Send>>, data: &str) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("writer lock poisoned"))?;
    // The lock is held across the whole write so the pieces cannot interleave with another
    // writer's.
    for chunk in chunk_for_tty(data) {
        writer.write_all(chunk.as_bytes())?;
        writer.flush()?;
    }
    Ok(())
}

/// How much of one write a pty will take while a shell's line editor owns it.
///
/// Measured here 2026-09-12: in canonical mode a single write of 8 KB is accepted whole, but in
/// NON-canonical mode — the mode `zsh` puts the tty in for ZLE — the same write is cut to **1022
/// bytes**, and a 3 KB write into an interactive zsh never completes at all. 512 leaves headroom
/// below that measured ceiling.
pub const TTY_WRITE_CHUNK: usize = 512;

/// Split a write into pieces the tty will actually take, never mid-character.
///
/// A resume launch types its whole command — `claude --resume <id> --append-system-prompt '<~3 KB
/// persona>'` — into a shell. Sent as one write, the tail was dropped: the closing quote never
/// arrived and zsh sat at its continuation prompt with no CLI ever starting. A fresh launch spawns
/// argv instead and types nothing, which is why only "continue this session" was broken.
pub fn chunk_for_tty(data: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut rest = data;
    while !rest.is_empty() {
        if rest.len() <= TTY_WRITE_CHUNK {
            chunks.push(rest);
            break;
        }
        // Walk back to a character boundary so a multi-byte glyph is never split in half.
        let mut end = TTY_WRITE_CHUNK;
        while end > 0 && !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (head, tail) = rest.split_at(end);
        chunks.push(head);
        rest = tail;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A big paste into a program that is busy printing holds the writer lock while the tty
    /// input queue is full. If that program asks a DA query meanwhile, the reader must still
    /// drain output — otherwise the program blocks writing, never reads stdin, and the paste
    /// never finishes either.
    #[cfg(unix)]
    #[test]
    fn a_da_query_is_answered_on_the_programs_stdin() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "stty raw -echo; printf '\\033[c'; head -c 3 | od -An -c | tr -d ' '",
        ]);
        let pty = Pty::spawn(cmd, 80, 24, None).expect("spawn");
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let mut out = String::new();
        while !out.contains("[?") && Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
            out = pty.output_tail.lock().unwrap().snapshot_tail(256);
        }
        assert!(out.contains("033[?"), "no DA reply read: {out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_da_query_during_a_blocked_paste_does_not_deadlock() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "stty raw -echo; printf READY; sleep 0.5; printf '\\033[c'; \
             head -c 300000 /dev/zero | tr '\\0' x; head -c 65536 >/dev/null; printf DONE",
        ]);
        let pty = Pty::spawn(cmd, 80, 24, None).expect("spawn");
        let seen = |needle: &str| {
            pty.output_tail
                .lock()
                .unwrap()
                .snapshot_tail(64)
                .contains(needle)
        };
        // Canonical mode drops input past MAX_CANON, so paste only once the tty is raw.
        let ready_by = Instant::now() + std::time::Duration::from_secs(5);
        while !seen("READY") && Instant::now() < ready_by {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let writer = Arc::clone(&pty.writer);
        std::thread::spawn(move || write_chunked(&writer, &"y".repeat(65536)));
        let deadline = Instant::now() + std::time::Duration::from_secs(10);
        let mut done = false;
        while !done && Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
            done = seen("DONE");
        }
        assert!(done, "deadlocked: output stopped draining");
    }

    /// The flusher cuts output wherever a read happened to end, so a character can arrive in
    /// two flushes. Decoded per flush, each half became U+FFFD for every SSE subscriber.
    #[cfg(unix)]
    #[test]
    fn broadcast_keeps_a_character_split_across_flushes_whole() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sleep 0.3; printf '\\303'; sleep 0.3; printf '\\251'"]);
        let pty = Pty::spawn(cmd, 80, 24, None).expect("spawn");
        let mut rx = pty.broadcast_tx.subscribe();
        let mut got = String::new();
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        while !got.contains("[Session ended") && Instant::now() < deadline {
            match rx.try_recv() {
                Ok(text) => got.push_str(&text),
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(10)),
            }
        }
        assert!(got.starts_with("é"), "got {got:?}");
    }

    /// The daemon reports exit as its own event (ADR-0067 H4), so it needs the code, and only
    /// after the marker is in the ring: a client reattaching after `exited` must find it there.
    #[cfg(unix)]
    #[test]
    fn on_exit_gets_the_code_after_the_marker_is_in_the_ring() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "exit 3"]);
        let (tx, rx) = std::sync::mpsc::channel();
        let pty = Pty::spawn_with_exit(
            cmd,
            80,
            24,
            None,
            Some(Box::new(move |code| {
                let _ = tx.send(code);
            })),
        )
        .expect("spawn");
        let code = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("on_exit");
        assert_eq!(code, 3);
        assert!(pty
            .output_tail
            .lock()
            .unwrap()
            .snapshot_tail(64)
            .contains("[Session ended:3]"));
    }

    /// `screen_snapshot` names the byte offset the drawn screen stands at, so a client can draw
    /// it and then skip live output below that offset — no gap, no double-drawn bytes.
    #[cfg(unix)]
    #[test]
    fn screen_snapshot_offset_is_the_bytes_the_screen_has_drawn() {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "printf 'hello\\033[5;10Hthere'; sleep 5"]);
        let pty = Pty::spawn(cmd, 80, 24, None).expect("spawn");
        let deadline = Instant::now() + std::time::Duration::from_secs(5);
        let (mut offset, mut drawn) = pty.screen_snapshot();
        while offset < 21 && Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
            (offset, drawn) = pty.screen_snapshot();
        }
        assert_eq!(offset, pty.output_tail.lock().unwrap().total_bytes_seen);
        let mut parser = vt100::Parser::new(24, 80, 0);
        parser.process(&drawn);
        assert_eq!(parser.screen().contents_between(4, 9, 4, 14), "there");
        assert!(parser.screen().contents().starts_with("hello"));
        pty.terminate();
    }

    #[derive(Default)]
    struct FakeRemote {
        calls: Mutex<Vec<String>>,
    }
    impl Remote for FakeRemote {
        fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
            self.calls.lock().unwrap().push(format!("resize {cols}x{rows}"));
            Ok(())
        }
        fn kill(&self) {
            self.calls.lock().unwrap().push("kill".into());
        }
        fn terminate(&self) {
            self.calls.lock().unwrap().push("terminate".into());
        }
    }

    /// A mirror is fed a daemon's stream: every reader must see exactly those bytes, once,
    /// with no second end marker and no DA reply of its own.
    #[test]
    fn a_mirror_feeds_ring_screen_and_sink_from_its_feed_alone() {
        let (feed_tx, feed_rx) = std::sync::mpsc::channel();
        let (sink_tx, sink_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        let (code_tx, code_rx) = std::sync::mpsc::channel();
        let remote = Arc::new(FakeRemote::default());
        let written = Arc::new(Mutex::new(Vec::<u8>::new()));
        struct Rec(Arc<Mutex<Vec<u8>>>);
        impl Write for Rec {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let pty = Pty::mirror(
            feed_rx,
            Box::new(Rec(Arc::clone(&written))),
            remote.clone(),
            Box::new(move || {
                let _ = code_tx.send(());
                7
            }),
            Some(4242),
            80,
            24,
            Some(Box::new(move |b| sink_tx.send(b).is_err())),
        );
        let mut rx = pty.broadcast_tx.subscribe();
        feed_tx.send(b"hello \x1b[c".to_vec()).unwrap();
        feed_tx.send(b"world\r\n[Session ended:7]\r\n".to_vec()).unwrap();
        drop(feed_tx);
        code_rx.recv_timeout(std::time::Duration::from_secs(5)).expect("wait called on EOF");

        let want = "hello world\r\n[Session ended:7]\r\n";
        let mut sunk = Vec::new();
        while let Ok(b) = sink_rx.recv_timeout(std::time::Duration::from_millis(200)) {
            sunk.extend(b);
        }
        assert_eq!(String::from_utf8_lossy(&sunk), want, "no second marker");
        let tail = pty.output_tail.lock().unwrap().snapshot_tail(1024);
        assert_eq!(tail, want);
        assert!(pty.screen.lock().unwrap().contents().starts_with("hello world"));
        let mut text = String::new();
        while let Ok(t) = rx.try_recv() {
            text.push_str(&t);
        }
        assert_eq!(text, want);
        assert!(written.lock().unwrap().is_empty(), "a mirror must not answer DA");
        assert_eq!(pty.child_pid, Some(4242));

        pty.resize(100, 30).unwrap();
        assert_eq!((pty.size().unwrap().cols, pty.size().unwrap().rows), (100, 30));
        write_chunked(&pty.writer, "ls\r").unwrap();
        assert_eq!(written.lock().unwrap().as_slice(), b"ls\r");
        pty.kill();
        pty.terminate();
        assert_eq!(
            *remote.calls.lock().unwrap(),
            vec!["resize 100x30", "kill", "terminate"]
        );
    }

    /// Measured on this machine 2026-09-12: a pty in NON-canonical mode — the mode a shell's line
    /// editor puts it in — accepts about 1022 bytes per write, and a single 3 KB write into an
    /// interactive zsh never completes. A resume launch types a ~3 KB command (the persona rides in
    /// `--append-system-prompt`), which is why only "continue this session" broke: a fresh launch
    /// spawns argv and types nothing. Splitting is what keeps the tail from being lost.
    #[test]
    fn tty_chunks_never_exceed_the_line_editor_budget() {
        let data = "x".repeat(3000);
        let chunks = chunk_for_tty(&data);
        assert!(chunks.iter().all(|c| c.len() <= TTY_WRITE_CHUNK));
        assert_eq!(chunks.concat(), data);
    }

    /// A chunk boundary that lands mid-character would put invalid UTF-8 on the wire; the persona
    /// carries em dashes and arrows, so this is a real input, not a hypothetical one.
    #[test]
    fn tty_chunks_split_on_character_boundaries() {
        let data = "—".repeat(600); // 1800 bytes, 3 per char
        let chunks = chunk_for_tty(&data);
        assert!(chunks.len() > 1, "must actually split");
        assert!(chunks.iter().all(|c| c.len() <= TTY_WRITE_CHUNK));
        assert_eq!(chunks.concat(), data);
    }

    #[test]
    fn tty_writes_that_already_fit_are_left_alone() {
        assert_eq!(chunk_for_tty("ls -la\n"), vec!["ls -la\n"]);
        assert!(chunk_for_tty("").is_empty());
    }
}
