use super::*;

/// A PTY as the app holds it: the engine plus who owns it and who sizes it.
pub struct PtySession {
    pub pty: lotus_pty::Pty,
    pub cwd: String,
    pub window_label: String,
    pub canvas_terminal_id: Option<String>,
    /// Who sets this pane's size: the desktop's layout, or a phone holding a lease
    /// (`size_lease.rs`, ADR-6 addendum 2026-10-05).
    pub(super) sizing: size_lease::Sizing,
    /// The session's id in `lotus-sessiond` when it runs there (ADR-0067); `None` in-process.
    pub daemon_id: Option<String>,
    /// The machine whose daemon holds it (`sessiond_client::remote_daemon` key); `None` = this one.
    pub machine: Option<String>,
}

#[derive(Default)]
pub struct PtyStore(pub HashMap<String, PtySession>);

pub type PtyState = Arc<Mutex<PtyStore>>;

pub(crate) fn spawn_session(
    cwd: String,
    window_label: String,
    cols: u16,
    rows: u16,
    on_output: Option<OutputSink>,
    state: &PtyState,
    command_builder: CommandBuilder,
    canvas_terminal_id: Option<String>,
) -> Result<String, AppError> {
    // Check session limits before spawning (cheap early-out; re-checked under
    // lock after spawn to close the TOCTOU window).
    {
        let store = state.lock().map_err(|_| other("lock poisoned"))?;
        check_session_capacity(&store, &window_label)?;
    }

    // The one switch between the session daemon (ADR-0067) and an in-process PTY; everything
    // after reads the same `Pty` either way.
    #[cfg(unix)]
    let daemon = super::sessiond_client::daemon();
    #[cfg(not(unix))]
    let daemon: Option<()> = None;
    let (pty, daemon_id) = match daemon {
        #[cfg(unix)]
        Some(d) => d
            .spawn(
                &command_builder,
                canvas_terminal_id.clone(),
                &window_label,
                cols,
                rows,
                on_output,
            )
            .map(|(pty, id)| (pty, Some(id))),
        _ => lotus_pty::Pty::spawn(command_builder, cols, rows, on_output).map(|pty| (pty, None)),
    }
    .map_err(|e| other(e.to_string()))?;
    let session_id = Uuid::new_v4().to_string();
    let session = PtySession {
        pty,
        cwd,
        window_label,
        canvas_terminal_id,
        sizing: size_lease::Sizing::default(),
        daemon_id,
        machine: None,
    };

    {
        let mut store = state.lock().map_err(|_| other("lock poisoned"))?;
        if let Err(err) = check_session_capacity(&store, &session.window_label) {
            session.pty.kill();
            return Err(err);
        }
        store.0.insert(session_id.clone(), session);
    }

    Ok(session_id)
}

pub fn write_to_session(
    session_id: String,
    data: String,
    state: &PtyState,
) -> Result<(), AppError> {
    // Clone writer Arc then drop the main state lock before writing,
    // so one slow session doesn't block all others.
    let writer_arc = {
        let store = state.lock().map_err(|_| other("lock poisoned"))?;
        let session = store
            .0
            .get(&session_id)
            .ok_or_else(|| other("session not found"))?;
        Arc::clone(&session.pty.writer)
    };
    lotus_pty::write_chunked(&writer_arc, &data).map_err(AppError::Io)
}

/// A pane's session that outlived the page that started it (a restart or a reload, ADR-0067):
/// mirror it into this window and return its id. `None` when there is none to adopt, which is
/// always the case for in-process PTYs.
pub fn adopt_session(
    window_label: String,
    pane_id: &str,
    on_output: OutputSink,
    state: &PtyState,
) -> Result<Option<String>, AppError> {
    #[cfg(unix)]
    if let Some(d) = super::sessiond_client::daemon() {
        let listed = d.list().map_err(|e| other(e.to_string()))?;
        let Some(info) = listed
            .iter()
            .find(|s| s.owner.pane_id.as_deref() == Some(pane_id) && !d.mirrors(&s.id))
        else {
            return Ok(None);
        };
        let pty = d.adopt(info, Some(on_output)).map_err(|e| other(e.to_string()))?;
        let session_id = Uuid::new_v4().to_string();
        eprintln!("[sessiond] pane {pane_id} adopted {} as {session_id}", info.id);
        let session = PtySession {
            pty,
            cwd: info.cwd.clone().unwrap_or_default(),
            // The window that holds the pane now, not the one that started it.
            window_label,
            canvas_terminal_id: info.owner.canvas_terminal_id.clone(),
            sizing: size_lease::Sizing::default(),
            daemon_id: Some(info.id.clone()),
            machine: None,
        };
        state
            .lock()
            .map_err(|_| other("lock poisoned"))?
            .0
            .insert(session_id.clone(), session);
        return Ok(Some(session_id));
    }
    let _ = (window_label, pane_id, on_output, state);
    Ok(None)
}

/// After a window restored its panes: ends the daemon sessions it started for panes that no
/// longer exist. Sessions of other windows, of Canvas terminals and without a pane are left
/// alone. Returns how many were ended.
pub fn reconcile_sessions(window_label: &str, pane_ids: &[String]) -> Result<usize, AppError> {
    #[cfg(unix)]
    if let Some(d) = super::sessiond_client::daemon() {
        let listed = d.list().map_err(|e| other(e.to_string()))?;
        let mut ended = 0;
        for id in sessions_without_a_pane(&listed, window_label, pane_ids, |id| d.mirrors(id)) {
            eprintln!("[sessiond] its pane is gone; ending {id}");
            if d.kill(&id).is_ok() {
                ended += 1;
            }
        }
        return Ok(ended);
    }
    let _ = (window_label, pane_ids);
    Ok(0)
}

#[cfg(unix)]
fn sessions_without_a_pane(
    listed: &[lotus_sessiond::proto::SessionInfo],
    window_label: &str,
    pane_ids: &[String],
    mirrored: impl Fn(&str) -> bool,
) -> Vec<String> {
    listed
        .iter()
        .filter(|s| {
            let Some(pane) = s.owner.pane_id.as_deref() else { return false };
            s.owner.window_label == window_label
                && s.owner.canvas_terminal_id.is_none()
                && !pane_ids.iter().any(|p| p == pane)
                && !mirrored(&s.id)
        })
        .map(|s| s.id.clone())
        .collect()
}

#[cfg(all(test, unix))]
mod reconcile_tests {
    use super::sessions_without_a_pane;
    use lotus_sessiond::proto::{Owner, SessionInfo};

    fn info(id: &str, pane: Option<&str>, canvas: Option<&str>, window: &str) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            owner: Owner {
                pane_id: pane.map(Into::into),
                canvas_terminal_id: canvas.map(Into::into),
                window_label: window.into(),
            },
            cols: 80,
            rows: 24,
            total_bytes: 0,
            idle: true,
            started_ago_ms: 0,
            pid: None,
            cwd: None,
            tag: None,
        }
    }

    #[test]
    fn only_this_windows_pane_sessions_whose_pane_is_gone_are_ended() {
        let listed = [
            info("kept", Some("p1"), None, "main"),
            info("gone", Some("p2"), None, "main"),
            info("mirrored", Some("p3"), None, "main"),
            info("other-window", Some("p4"), None, "w2"),
            info("canvas", Some("p5"), Some("t5"), "main"),
            info("headless", None, None, "main"),
        ];
        let ended = sessions_without_a_pane(&listed, "main", &["p1".into()], |id| id == "mirrored");
        assert_eq!(ended, vec!["gone".to_string()]);
    }
}
