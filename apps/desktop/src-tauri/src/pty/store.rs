use super::*;

/// Per-window cap: a single window may hold this many live PTY sessions. Keeps
/// one window's behavior identical to the old single global cap while stopping
/// it from starving other windows — all windows share one global `PtyStore`, so
/// a global-only cap let a busy window block spawns in an idle one.
pub(super) const MAX_SESSIONS_PER_WINDOW: usize = 32;
/// Global machine-safety backstop across ALL windows (bounds total PTY/thread
/// count regardless of how many windows are open).
pub(super) const MAX_SESSIONS_TOTAL: usize = 128;

/// Pure capacity decision for a new session: returns the error message when a
/// spawn would exceed either the global or the per-window cap, else `None`. The
/// global cap is checked first so its message wins when both are exceeded.
/// Extracted from the store so it is unit-testable without spawning real PTYs.
pub(super) fn session_capacity_error(total_sessions: usize, window_sessions: usize) -> Option<String> {
    if total_sessions >= MAX_SESSIONS_TOTAL {
        return Some(format!(
            "max {MAX_SESSIONS_TOTAL} concurrent sessions reached across all windows"
        ));
    }
    if window_sessions >= MAX_SESSIONS_PER_WINDOW {
        return Some(format!(
            "max {MAX_SESSIONS_PER_WINDOW} concurrent sessions reached for this window"
        ));
    }
    None
}

/// Store-level capacity check: counts this window's live sessions + the global
/// total and defers to [`session_capacity_error`].
pub(super) fn check_session_capacity(store: &PtyStore, window_label: &str) -> Result<(), AppError> {
    let total = store.0.len();
    let window_sessions = store
        .0
        .values()
        .filter(|s| s.window_label == window_label)
        .count();
    match session_capacity_error(total, window_sessions) {
        Some(message) => Err(other(message)),
        None => Ok(()),
    }
}

pub fn list_all_sessions(state: &PtyState) -> Result<Vec<SessionInfo>, AppError> {
    let store = state.lock().map_err(|_| other("lock poisoned"))?;
    Ok(store
        .0
        .iter()
        .map(|(id, s)| {
            let started_ago_ms = s.pty.started_at.elapsed().as_millis() as u64;
            SessionInfo {
                id: id.clone(),
                cwd: s.cwd.clone(),
                silent_for_ms: silence_ms(started_ago_ms, s.pty.last_output_ms.load(Ordering::Relaxed)),
                started_ago_ms,
                idle: s.pty.is_shell_idle.load(Ordering::Relaxed),
                idle_trusted: s.pty.saw_idle_marker.load(Ordering::Relaxed),
                pid: s.pty.child_pid,
            }
        })
        .collect())
}

pub fn get_session_broadcast_tx(
    session_id: &str,
    state: &PtyState,
) -> Result<broadcast::Sender<String>, AppError> {
    let store = state.lock().map_err(|_| other("lock poisoned"))?;
    let session = store
        .0
        .get(session_id)
        .ok_or_else(|| other("session not found"))?;
    Ok(session.pty.broadcast_tx.clone())
}

/// A byte range of a session's output ring, `offset` clamped to what the ring still holds.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackChunk {
    pub text: String,
    pub offset: u64,
    pub total_bytes: u64,
}

pub fn read_scrollback(
    session_id: &str,
    offset: u64,
    len: usize,
    state: &PtyState,
) -> Result<ScrollbackChunk, AppError> {
    let tail_arc = {
        let store = state.lock().map_err(|_| other("lock poisoned"))?;
        let session = store
            .0
            .get(session_id)
            .ok_or_else(|| other("session not found"))?;
        Arc::clone(&session.pty.output_tail)
    };
    let tail = tail_arc.lock().map_err(|_| other("tail lock poisoned"))?;
    let (start, text) = tail.read_text(offset, len);
    Ok(ScrollbackChunk {
        text,
        offset: start,
        total_bytes: tail.total_bytes_seen,
    })
}

/// PID of the direct child process backing a PTY session — the process Lotus
/// spawned into the pane: the user's shell, or the agent CLI itself for
/// direct-spawn agent panes. Used by `mcp_ipc::hook_stop` as the anchor for
/// nested-agent stop attribution (ancestor walks terminate at this pid).
/// Returns `None` when the session is unknown, a lock is poisoned, or the
/// platform cannot report a pid — callers treat `None` as "cannot attribute"
/// and fail open rather than dropping the stop signal.
pub fn session_child_pid(session_id: &str, state: &PtyState) -> Option<u32> {
    let store = state.lock().ok()?;
    store.0.get(session_id)?.pty.child_pid
}

/// Whether a PTY session is still in the store — **liveness, not attribution.**
///
/// Deliberately not [`session_child_pid`]`().is_some()`, which is the thing it
/// would be easy to reach for: that answers `None` both for a session that has
/// ended and for a live one whose platform cannot report a pid, and a caller
/// asking "is this still running" would read the second case as death. This one
/// answers only what it is named after.
///
/// The canvas roster (`mcp_ipc`) is the caller that needs it: a pane whose board
/// has been switched away from has no frontend left to vouch for it, so its live
/// session is the only remaining evidence it is running.
pub fn session_exists(session_id: &str, state: &PtyState) -> bool {
    match state.lock() {
        Ok(store) => store.0.contains_key(session_id),
        // A poisoned lock is not evidence of death. Saying "gone" here would drop
        // a running agent off every remote client on a transient fault.
        Err(_) => true,
    }
}

pub fn read_session_metrics(session_id: &str, state: &PtyState) -> Option<PtyOutputMetrics> {
    let tail_arc = {
        let store = state.lock().ok()?;
        let session = store.0.get(session_id)?;
        Arc::clone(&session.pty.output_tail)
    };
    let tail = tail_arc.lock().ok()?;
    Some(tail.metrics())
}

/// Every live session's cumulative output byte count, with the runner detected in its
/// banner. Fase 0 instrumentation (`plans/session-history-hardening/issues/01`).
///
/// Deliberately a snapshot of totals rather than a rate: the sampler that calls this owns
/// the previous values and computes the delta, so this stays a pure read and the interval
/// is the caller's business.
///
/// Locks are taken one session at a time and released immediately. A poisoned lock skips
/// that session rather than failing the sweep — a diagnostics pass must never be the thing
/// that takes down output streaming.
pub fn sample_output_totals(state: &PtyState) -> Vec<(String, u64, Option<String>)> {
    let tails: Vec<(String, Arc<Mutex<OutputTail>>)> = match state.lock() {
        Ok(store) => store
            .0
            .iter()
            .map(|(id, s)| (id.clone(), Arc::clone(&s.pty.output_tail)))
            .collect(),
        Err(_) => return Vec::new(),
    };
    tails
        .into_iter()
        .filter_map(|(id, tail_arc)| {
            let tail = tail_arc.lock().ok()?;
            Some((id, tail.total_bytes_seen, tail.detected_agent.clone()))
        })
        .collect()
}

/// Snapshot the trailing [`max_bytes`] of a PTY session's output. Returns an
/// empty string if the session is unknown — the caller (MCP endpoints) treats
/// that as "nothing to read yet" rather than an error.
pub fn read_output_tail(session_id: &str, max_bytes: usize, state: &PtyState) -> String {
    let tail_arc = {
        let store = match state.lock() {
            Ok(guard) => guard,
            Err(_) => return String::new(),
        };
        match store.0.get(session_id) {
            Some(s) => Arc::clone(&s.pty.output_tail),
            None => return String::new(),
        }
    };
    let snap = match tail_arc.lock() {
        Ok(tail) => tail.snapshot_tail(max_bytes),
        Err(_) => String::new(),
    };
    snap
}

/// The pane as it is drawn, or `None` when the session is unknown.
///
/// Never `read_output_tail` for anything that needs layout: that is the raw stream, and stripping
/// its escapes destroys the rows rather than revealing them (`issues/18`).
pub fn read_pane_screen(session_id: &str, state: &PtyState) -> Option<String> {
    let screen_arc = {
        let store = state.lock().ok()?;
        Arc::clone(&store.0.get(session_id)?.pty.screen)
    };
    let screen = screen_arc.lock().ok()?;
    Some(screen.contents())
}

/// The pane's current width in columns, or `None` when the session is unknown.
///
/// A wrapped permission prompt cannot be put back together without it: rejoining a broken row
/// means knowing whether the break ate a space, and that answer comes from where the row ended
/// on screen (`issues/17`).
pub fn read_pane_columns(session_id: &str, state: &PtyState) -> Option<usize> {
    let store = state.lock().ok()?;
    let session = store.0.get(session_id)?;
    session.pty.size().ok().map(|size| size.cols as usize)
}

pub fn kill_session(session_id: String, state: &PtyState) -> Result<(), AppError> {
    let session = state
        .lock()
        .map_err(|_| other("lock poisoned"))?
        .0
        .remove(&session_id);
    if let Some(s) = session {
        // The command resolves only after the owned process tree is gone. The
        // frontend may close the window immediately after this returns, so a
        // detached cleanup worker would let TERM-ignoring descendants escape.
        terminate_session(s);
    }
    Ok(())
}

pub(super) fn terminate_session(s: PtySession) {
    s.pty.terminate();
}

/// Terminate a drained batch concurrently, but do not report completion until
/// every tree is gone. This keeps multi-pane close near one grace period rather
/// than multiplying 200 ms by the number of sessions.
pub(super) fn reap_sessions(sessions: Vec<PtySession>) {
    let workers: Vec<_> = sessions
        .into_iter()
        .map(|session| std::thread::spawn(move || terminate_session(session)))
        .collect();
    for worker in workers {
        let _ = worker.join();
    }
}

/// Kill every session in the store — the `RunEvent::Exit` path. Without it, quitting Lotus
/// only closed the PTY masters, and anything that ignored the resulting SIGHUP was reparented
/// to launchd and kept running — still billed to Lotus by macOS.
pub fn close_all_sessions(state: &PtyState) -> usize {
    let sessions: Vec<PtySession> = match state.lock() {
        Ok(mut store) => store.0.drain().map(|(_, session)| session).collect(),
        Err(_) => return 0,
    };
    let count = sessions.len();
    reap_sessions(sessions);
    count
}

/// Kill runaway processes a previous, uncleanly-exited Lotus left behind. Blocks for a few
/// seconds while it samples CPU; run it on a background thread.
#[cfg(unix)]
pub fn reap_stranded_orphans() -> usize {
    orphan_reaper::reap_stranded_orphans().len()
}

/// Kill every session owned by a single window — called on that window's webview
/// reload so stale PTY children cannot accumulate across hot-reloads or crashes,
/// WITHOUT touching sessions owned by other windows.
///
/// Multi-window safety: all windows share one process and one global `PtyStore`,
/// so a store-wide drain here would kill another window's live agent PTYs (e.g.
/// opening CodeSpace would freeze CodeCanvas's agents). Scoping by `window_label`
/// mirrors `list_sessions_for_window` and keeps each window's cleanup isolated.
/// Returns the number of sessions reaped.
/// A page of this window is (re)loading: its sessions lost their page. In-process PTYs die with
/// it; daemon sessions are only let go of, for the new page to adopt by pane (ADR-0067).
pub fn release_sessions_for_window(window_label: &str, state: &PtyState) -> Result<usize, AppError> {
    Ok(release(take_window_sessions(window_label, state)?))
}

/// Quit with "Keep running": every daemon session is let go of, in-process ones end.
pub fn release_all_sessions(state: &PtyState) -> usize {
    let sessions: Vec<PtySession> = match state.lock() {
        Ok(mut store) => store.0.drain().map(|(_, session)| session).collect(),
        Err(_) => return 0,
    };
    release(sessions)
}

/// Sessions running a detected agent: `(daemon id, agent, cwd)`, id `None` for an in-process one.
fn agent_sessions(state: &PtyState) -> Vec<(Option<String>, String, String)> {
    let Ok(store) = state.lock() else {
        return Vec::new();
    };
    store
        .0
        .values()
        .filter_map(|s| {
            let agent = s.pty.output_tail.lock().ok()?.detected_agent.clone()?;
            Some((s.daemon_id.clone(), agent, s.cwd.clone()))
        })
        .collect()
}

/// Daemon sessions running a detected agent: `(daemon id, agent, cwd)`.
pub fn daemon_agent_sessions(state: &PtyState) -> Vec<(String, String, String)> {
    agent_sessions(state)
        .into_iter()
        .filter_map(|(id, agent, cwd)| Some((id?, agent, cwd)))
        .collect()
}

/// In-process sessions running a detected agent: `(agent, cwd)`. They end when Lotus quits.
pub fn local_agent_sessions(state: &PtyState) -> Vec<(String, String)> {
    agent_sessions(state)
        .into_iter()
        .filter(|(id, _, _)| id.is_none())
        .map(|(_, agent, cwd)| (agent, cwd))
        .collect()
}

/// Detaches daemon sessions (they run on) and reaps in-process ones.
fn release(sessions: Vec<PtySession>) -> usize {
    let count = sessions.len();
    let (remote, local): (Vec<_>, Vec<_>) = sessions.into_iter().partition(|s| s.daemon_id.is_some());
    #[cfg(unix)]
    for s in &remote {
        let daemon = match s.machine.as_deref() {
            Some(machine) => super::sessiond_client::connected_remote(machine),
            None => super::sessiond_client::daemon(),
        };
        if let Some(d) = daemon {
            d.detach(s.daemon_id.as_deref().unwrap_or_default());
        }
    }
    drop(remote);
    reap_sessions(local);
    count
}

fn take_window_sessions(window_label: &str, state: &PtyState) -> Result<Vec<PtySession>, AppError> {
    let mut store = state.lock().map_err(|_| other("lock poisoned"))?;
    let ids: Vec<String> = store
        .0
        .iter()
        .filter(|(_, s)| s.window_label == window_label)
        .map(|(id, _)| id.clone())
        .collect();
    Ok(ids.into_iter().filter_map(|id| store.0.remove(&id)).collect())
}

pub fn close_sessions_for_window(window_label: &str, state: &PtyState) -> Result<usize, AppError> {
    let sessions: Vec<PtySession> = {
        let mut store = state.lock().map_err(|_| other("lock poisoned"))?;
        let ids: Vec<String> = store
            .0
            .iter()
            .filter(|(_, s)| s.window_label == window_label)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| store.0.remove(&id))
            .collect()
    };
    let count = sessions.len();
    reap_sessions(sessions);
    Ok(count)
}

/// How long a session has been silent, given its age and when output was last seen.
///
/// Saturating on purpose. The two readings are taken a moment apart and are not written under a
/// common lock, so `last_output_ms` can legitimately be a hair AHEAD of the age sampled just
/// before it. Wrapping that subtraction would report a session that spoke microseconds ago as
/// silent for 584 million years, and anything reaping on staleness would kill it instantly.
pub fn silence_ms(started_ago_ms: u64, last_output_ms: u64) -> u64 {
    started_ago_ms.saturating_sub(last_output_ms)
}

pub fn list_sessions_for_window(
    window_label: &str,
    state: &PtyState,
) -> Result<Vec<SessionInfo>, AppError> {
    let store = state.lock().map_err(|_| other("lock poisoned"))?;
    Ok(store
        .0
        .iter()
        .filter(|(_, s)| s.window_label == window_label)
        .map(|(id, s)| {
            let started_ago_ms = s.pty.started_at.elapsed().as_millis() as u64;
            SessionInfo {
                id: id.clone(),
                cwd: s.cwd.clone(),
                silent_for_ms: silence_ms(started_ago_ms, s.pty.last_output_ms.load(Ordering::Relaxed)),
                started_ago_ms,
                idle: s.pty.is_shell_idle.load(Ordering::Relaxed),
                idle_trusted: s.pty.saw_idle_marker.load(Ordering::Relaxed),
                pid: s.pty.child_pid,
            }
        })
        .collect())
}
