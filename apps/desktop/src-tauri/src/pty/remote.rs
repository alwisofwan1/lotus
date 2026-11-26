//! A pane on another machine whose process lives in that machine's `lotus-sessiond`, not under a
//! local `ssh -t` (plans/ssh-pane-durability, phase 2).
//!
//! Under `ssh -t` the agent is a child of the link: one dropped Cloudflare WebSocket sends it
//! SIGHUP and the work is gone. Here the agent is a child of the far daemon; this app only holds a
//! mirror over a forwarded Unix socket, and `sessiond_client` re-attaches it from the last byte
//! when the link comes back.

use super::sessiond_client::{self, Daemon, SocketSource};
use super::*;
use crate::remote_transport::RemoteSessiond;
use lotus_sessiond::proto::SessionInfo;
use std::sync::OnceLock;

/// Who the far process runs as. Comes from the machine itself (`RemoteTransport`'s probe): the
/// daemon there reads no environment of its own, so the client sends a complete one.
pub struct RemoteUser {
    pub home: String,
    pub user: String,
    pub shell: String,
}

impl From<&RemoteSessiond> for RemoteUser {
    fn from(r: &RemoteSessiond) -> Self {
        Self {
            home: r.home.clone(),
            user: r.user.clone(),
            shell: r.shell.clone(),
        }
    }
}

/// The same command line `ssh -t host <command>` would have handed the far login shell.
///
/// The environment is the small one a fresh sshd session starts with; the login shell the command
/// `exec`s builds the rest (`~/.local/bin` on PATH and so on), exactly as it does under ssh.
pub fn remote_command_builder(
    user: &RemoteUser,
    remote_command: &str,
    pane_id: Option<&str>,
) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(&user.shell);
    cmd.args(["-c", remote_command]);
    cmd.env_clear();
    cmd.env("HOME", &user.home);
    cmd.env("USER", &user.user);
    cmd.env("LOGNAME", &user.user);
    cmd.env("SHELL", &user.shell);
    cmd.env("PATH", "/usr/local/bin:/usr/bin:/bin");
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", "C.UTF-8");
    if let Some(id) = pane_id {
        cmd.env("LOTUS_PANE_ID", id);
    }
    cmd.cwd(&user.home);
    cmd
}

/// Starts the pane's command in `daemon` and keeps its mirror under a new session id.
#[allow(clippy::too_many_arguments)]
pub fn spawn_remote_session(
    daemon: &Arc<Daemon>,
    machine: &str,
    user: &RemoteUser,
    remote_command: &str,
    window_label: String,
    pane_id: Option<&str>,
    canvas_terminal_id: Option<String>,
    cols: u16,
    rows: u16,
    on_output: OutputSink,
    state: &PtyState,
) -> Result<String, AppError> {
    {
        let store = state.lock().map_err(|_| other("lock poisoned"))?;
        check_session_capacity(&store, &window_label)?;
    }
    let command = remote_command_builder(user, remote_command, pane_id);
    let (pty, id) = daemon
        .spawn(
            &command,
            canvas_terminal_id.clone(),
            &window_label,
            cols,
            rows,
            Some(on_output),
        )
        .map_err(|e| other(e.to_string()))?;
    eprintln!("[sessiond] {machine}: pane {pane_id:?} started {id}");
    insert(
        state,
        PtySession {
            pty,
            cwd: user.home.clone(),
            window_label,
            canvas_terminal_id,
            sizing: size_lease::Sizing::default(),
            daemon_id: Some(id),
            machine: Some(machine.to_string()),
        },
    )
}

/// A pane's session on `daemon`'s machine that outlived the page (or the app) that started it.
pub fn adopt_remote_session(
    daemon: &Arc<Daemon>,
    machine: &str,
    window_label: String,
    pane_id: &str,
    on_output: OutputSink,
    state: &PtyState,
) -> Result<Option<String>, AppError> {
    let listed = daemon.list().map_err(|e| other(e.to_string()))?;
    let Some(info) = find_pane_session(&listed, pane_id, sessiond_client::desktop_id(), |id| daemon.mirrors(id)) else {
        return Ok(None);
    };
    let pty = daemon
        .adopt(info, Some(on_output))
        .map_err(|e| other(e.to_string()))?;
    eprintln!("[sessiond] {machine}: pane {pane_id} adopted {}", info.id);
    insert(
        state,
        PtySession {
            pty,
            cwd: info.cwd.clone().unwrap_or_default(),
            window_label,
            canvas_terminal_id: info.owner.canvas_terminal_id.clone(),
            sizing: size_lease::Sizing::default(),
            daemon_id: Some(info.id.clone()),
            machine: Some(machine.to_string()),
        },
    )
    .map(Some)
}

/// Only a session this desktop started (tag `origin: desktop`) is a pane's: the machine's own
/// Lotus host keeps sessions of its own in the same daemon.
fn find_pane_session<'a>(
    listed: &'a [SessionInfo],
    pane_id: &str,
    client: &str,
    mirrored: impl Fn(&str) -> bool,
) -> Option<&'a SessionInfo> {
    listed.iter().find(|s| {
        s.owner.pane_id.as_deref() == Some(pane_id) && is_ours(s, client) && !mirrored(&s.id)
    })
}

/// Started by this Lotus: tag `origin: desktop` (never the machine host's own) and this app's
/// `client` id (never another Lotus sharing the machine: dev vs release, another computer).
fn is_ours(s: &SessionInfo, client: &str) -> bool {
    let Some(tag) = s
        .tag
        .as_deref()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
    else {
        return false;
    };
    tag.get("origin").and_then(|o| o.as_str()) == Some("desktop")
        && tag.get("client").and_then(|c| c.as_str()) == Some(client)
}

fn insert(state: &PtyState, session: PtySession) -> Result<String, AppError> {
    let session_id = Uuid::new_v4().to_string();
    let mut store = state.lock().map_err(|_| other("lock poisoned"))?;
    if let Err(err) = check_session_capacity(&store, &session.window_label) {
        session.pty.kill();
        return Err(err);
    }
    store.0.insert(session_id.clone(), session);
    Ok(session_id)
}

/// The connection to `machine`'s daemon, made through `source` when there is none. A new
/// connection first ends, in the background, the sessions whose pane is gone (see
/// [`note_restored_panes`]).
pub fn machine_daemon(machine: &str, source: impl FnOnce() -> SocketSource) -> Option<Arc<Daemon>> {
    let was_connected = sessiond_client::connected_remote(machine).is_some();
    let daemon = sessiond_client::remote_daemon(machine, source)?;
    if !was_connected {
        let (machine, sweep) = (machine.to_string(), Arc::clone(&daemon));
        let _ = std::thread::Builder::new()
            .name("sessiond-remote-sweep".into())
            .spawn(move || {
                sweep_orphans(&machine, &sweep);
            });
    }
    Some(daemon)
}

/// Each window's pane ids as its page last listed them (`reconcile_sessions`). Only a window in
/// here is swept: one whose page is still loading has not said which panes it has.
static RESTORED_PANES: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();

fn restored_panes() -> &'static Mutex<HashMap<String, Vec<String>>> {
    RESTORED_PANES.get_or_init(Default::default)
}

/// A window listed its panes: remember them, and end this desktop's sessions on every machine
/// connected now whose pane is gone. A machine connected later is swept as it connects. Ending
/// them is the point: a remote agent left without a pane spends quota and keeps editing files
/// where nobody sees it (an app quit with "Keep running", then the pane deleted). Returns how many
/// were ended.
pub fn note_restored_panes(window_label: &str, pane_ids: &[String]) -> usize {
    restored_panes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(window_label.to_string(), pane_ids.to_vec());
    sessiond_client::connected_remotes()
        .iter()
        .map(|(machine, daemon)| sweep_orphans(machine, daemon))
        .sum()
}

/// The window's page is reloading: its pane list is stale until the new page sends one.
pub fn forget_restored_panes(window_label: &str) {
    restored_panes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(window_label);
}

fn sweep_orphans(machine: &str, daemon: &Arc<Daemon>) -> usize {
    let windows: Vec<(String, Vec<String>)> = restored_panes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .map(|(w, p)| (w.clone(), p.clone()))
        .collect();
    if windows.is_empty() {
        return 0;
    }
    let listed = match daemon.list() {
        Ok(listed) => listed,
        Err(e) => {
            eprintln!("[sessiond] {machine}: could not list for the orphan sweep: {e}");
            return 0;
        }
    };
    let mut ended = 0;
    for (window, panes) in &windows {
        for id in orphans(&listed, window, panes, sessiond_client::desktop_id(), |id| daemon.mirrors(id)) {
            eprintln!("[sessiond] {machine}: its pane is gone; ending {id}");
            if daemon.kill(&id).is_ok() {
                ended += 1;
            }
        }
    }
    ended
}

/// This Lotus's sessions of `window` whose pane is gone.
fn orphans(
    listed: &[SessionInfo],
    window: &str,
    pane_ids: &[String],
    client: &str,
    mirrored: impl Fn(&str) -> bool,
) -> Vec<String> {
    let ours: Vec<SessionInfo> = listed.iter().filter(|s| is_ours(s, client)).cloned().collect();
    super::session::sessions_without_a_pane(&ours, window, pane_ids, mirrored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lotus_sessiond::proto::Owner;

    fn info(id: &str, pane: &str, tag: Option<&str>) -> SessionInfo {
        SessionInfo {
            id: id.into(),
            owner: Owner {
                pane_id: Some(pane.into()),
                canvas_terminal_id: None,
                window_label: "main".into(),
            },
            cols: 80,
            rows: 24,
            total_bytes: 0,
            idle: true,
            started_ago_ms: 0,
            pid: None,
            cwd: None,
            tag: tag.map(Into::into),
        }
    }

    #[test]
    fn a_pane_adopts_only_the_desktops_own_unmirrored_session() {
        let listed = [
            info("hosts", "p1", Some(r#"{"sessionId":"s1"}"#)),
            info("untagged", "p1", None),
            info("mirrored", "p1", Some(r#"{"origin":"desktop","client":"me"}"#)),
            info("other-pane", "p2", Some(r#"{"origin":"desktop","client":"me"}"#)),
            info("other-lotus", "p1", Some(r#"{"origin":"desktop","client":"dev"}"#)),
            info("no-client", "p1", Some(r#"{"origin":"desktop"}"#)),
            info("mine", "p1", Some(r#"{"origin":"desktop","client":"me","paneId":"p1"}"#)),
        ];
        let found = find_pane_session(&listed, "p1", "me", |id| id == "mirrored").map(|s| s.id.as_str());
        assert_eq!(found, Some("mine"));
    }

    #[test]
    fn the_sweep_ends_only_the_desktops_sessions_whose_pane_is_gone() {
        let mut listed = vec![
            info("kept", "p1", Some(r#"{"origin":"desktop","client":"me"}"#)),
            info("gone", "p2", Some(r#"{"origin":"desktop","client":"me"}"#)),
            info("hosts", "p3", Some(r#"{"sessionId":"s3"}"#)),
            info("untagged", "p4", None),
            info("mirrored", "p5", Some(r#"{"origin":"desktop","client":"me"}"#)),
            // Another Lotus on the same machine (the dev app, another computer): its pane is
            // simply not in this app's list, which must not read as "gone".
            info("other-lotus", "p7", Some(r#"{"origin":"desktop","client":"dev"}"#)),
        ];
        let mut other_window = info("other-window", "p6", Some(r#"{"origin":"desktop","client":"me"}"#));
        other_window.owner.window_label = "w2".into();
        listed.push(other_window);
        let ended = orphans(&listed, "main", &["p1".into()], "me", |id| id == "mirrored");
        assert_eq!(ended, vec!["gone".to_string()]);
    }

    #[test]
    fn the_far_process_gets_a_complete_small_environment_and_the_users_shell() {
        let user = RemoteUser {
            home: "/home/dev".into(),
            user: "dev".into(),
            shell: "/usr/bin/zsh".into(),
        };
        let cmd = remote_command_builder(&user, "cd '/srv' && exec claude", Some("pane-9"));
        let argv: Vec<String> = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(argv, ["/usr/bin/zsh", "-c", "cd '/srv' && exec claude"]);
        let env: HashMap<String, String> = cmd
            .iter_full_env_as_str()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/dev"));
        assert_eq!(env.get("LOGNAME").map(String::as_str), Some("dev"));
        assert_eq!(env.get("LOTUS_PANE_ID").map(String::as_str), Some("pane-9"));
        assert_eq!(env.get("TERM").map(String::as_str), Some("xterm-256color"));
        // Nothing of this Mac's environment crosses over: its PATH and HOME mean nothing there.
        assert!(!env.contains_key("TMPDIR"));
        assert!(env.len() <= 10, "{env:?}");
        assert_eq!(
            cmd.get_cwd()
                .map(|c| c.to_string_lossy().into_owned())
                .as_deref(),
            Some("/home/dev")
        );
    }

    /// Plan proof 1, at the Rust layer: a dropped SSH master pauses the pane, never ends it.
    /// `LOTUS_SSH_LIVE_TARGET=devbox-vps cargo test --lib live_ -- --ignored --nocapture`
    #[test]
    #[ignore = "requires an SSH host running a Lotus host"]
    fn live_a_killed_master_neither_ends_the_far_process_nor_loses_output() {
        use crate::cli_tools::SshToolTarget;
        use crate::remote_transport::RemoteTransport;
        use std::time::{Duration, Instant};

        let host = std::env::var("LOTUS_SSH_LIVE_TARGET").expect("set LOTUS_SSH_LIVE_TARGET");
        let target = SshToolTarget {
            host: host.clone(),
            user: None,
            port: None,
        };
        let transport = Arc::new(RemoteTransport::new());
        let found = transport
            .forward_sessiond(&target)
            .unwrap()
            .expect("no daemon on that host");
        let source_transport = Arc::clone(&transport);
        let source_target = target.clone();
        let machine = format!("live-test:{host}");
        let daemon = machine_daemon(&machine, move || {
            Box::new(move || {
                source_transport
                    .forward_sessiond(&source_target)
                    .map(|f| f.map(|f| f.socket))
                    .map_err(|e| e.to_string())
            })
        })
        .expect("daemon");

        let seen = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink_seen = Arc::clone(&seen);
        let sink: OutputSink = Box::new(move |data| {
            sink_seen.lock().unwrap().extend_from_slice(&data);
            false
        });
        let state: PtyState = Default::default();
        let script = "echo PID=$$; i=0; while [ $i -lt 40 ]; do echo tick-$i; i=$((i+1)); sleep 0.5; done; echo DONE";
        let id = spawn_remote_session(
            &daemon,
            &machine,
            &RemoteUser::from(&found),
            script,
            "test".into(),
            Some("live-pane"),
            None,
            80,
            24,
            sink,
            &state,
        )
        .unwrap();
        let text = || String::from_utf8_lossy(&seen.lock().unwrap()).replace("\r\n", "\n");
        let wait_for = |needle: &str, limit: Duration| {
            let start = Instant::now();
            while !text().contains(needle) {
                assert!(start.elapsed() < limit, "no {needle:?} in {:?}", text());
                std::thread::sleep(Duration::from_millis(100));
            }
        };
        wait_for("tick-3\n", Duration::from_secs(20));

        let master = transport.acquire(&target).unwrap();
        let check = std::process::Command::new("ssh")
            .args(["-S"])
            .arg(&master)
            .args(["-O", "check", &host])
            .output()
            .unwrap();
        let said = String::from_utf8_lossy(&check.stderr).into_owned();
        let pid: u32 = said
            .split("pid=")
            .nth(1)
            .and_then(|r| r.split(')').next())
            .and_then(|p| p.parse().ok())
            .unwrap_or_else(|| panic!("no master pid in {said:?}"));
        println!("killing master pid {pid} at {:?}", text().lines().last());
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        let dropped = Instant::now();

        wait_for("DONE", Duration::from_secs(90));
        println!("finished {:?} after the drop", dropped.elapsed());
        let out = text();
        assert_eq!(out.matches("PID=").count(), 1, "{out}");
        for i in 0..40 {
            assert_eq!(
                out.matches(&format!("tick-{i}\n")).count(),
                1,
                "tick-{i} in {out}"
            );
        }
        assert!(transport.acquire(&target).unwrap().exists());
        drop(id);
        transport.shutdown();
    }

    /// A session left behind (detached, its pane gone) is ended by the next pane list.
    /// `LOTUS_SSH_LIVE_TARGET=devbox-vps cargo test --lib live_ -- --ignored --nocapture`
    #[test]
    #[ignore = "requires an SSH host running a Lotus host"]
    fn live_a_session_whose_pane_is_gone_is_ended_by_the_sweep() {
        use crate::cli_tools::SshToolTarget;
        use crate::remote_transport::RemoteTransport;
        use std::time::{Duration, Instant};

        let host = std::env::var("LOTUS_SSH_LIVE_TARGET").expect("set LOTUS_SSH_LIVE_TARGET");
        let target = SshToolTarget {
            host: host.clone(),
            user: None,
            port: None,
        };
        let transport = Arc::new(RemoteTransport::new());
        let found = transport
            .forward_sessiond(&target)
            .unwrap()
            .expect("no daemon on that host");
        let (source_transport, source_target) = (Arc::clone(&transport), target.clone());
        let machine = format!("sweep-test:{host}");
        let daemon = machine_daemon(&machine, move || {
            Box::new(move || {
                source_transport
                    .forward_sessiond(&source_target)
                    .map(|f| f.map(|f| f.socket))
                    .map_err(|e| e.to_string())
            })
        })
        .expect("daemon");
        let state: PtyState = Default::default();
        let user = RemoteUser::from(&found);
        let sink = || -> OutputSink { Box::new(|_| false) };
        spawn_remote_session(
            &daemon,
            &machine,
            &user,
            "sleep 300",
            "sweep-win".into(),
            Some("pane-gone"),
            None,
            80,
            24,
            sink(),
            &state,
        )
        .unwrap();
        spawn_remote_session(
            &daemon,
            &machine,
            &user,
            "sleep 300",
            "sweep-win".into(),
            Some("pane-kept"),
            None,
            80,
            24,
            sink(),
            &state,
        )
        .unwrap();
        // The app quit with "Keep running": both are let go of, and both run on.
        release_sessions_for_window("sweep-win", &state).unwrap();
        let ids = |pane: &str| -> Vec<String> {
            daemon
                .list()
                .unwrap()
                .into_iter()
                .filter(|s| s.owner.pane_id.as_deref() == Some(pane))
                .map(|s| s.id)
                .collect()
        };
        assert_eq!(ids("pane-gone").len(), 1);

        let ended = note_restored_panes("sweep-win", &["pane-kept".into()]);
        assert_eq!(ended, 1);
        let start = Instant::now();
        while !ids("pane-gone").is_empty() {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "pane-gone still runs"
            );
            std::thread::sleep(Duration::from_millis(200));
        }
        let kept = ids("pane-kept");
        assert_eq!(
            kept.len(),
            1,
            "the session whose pane is still there must stay"
        );
        println!("ended pane-gone; pane-kept still runs as {}", kept[0]);
        // Clean up after ourselves.
        note_restored_panes("sweep-win", &[]);
        forget_restored_panes("sweep-win");
        transport.shutdown();
    }
}
