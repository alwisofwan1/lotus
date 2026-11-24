//! The daemon over a real Unix socket (PHASE-3 step 2). Spawns real processes: run unsandboxed.
#![cfg(unix)]

use lotus_sessiond::daemon::{serve, Config};
use lotus_sessiond::proto::*;
use std::io;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

fn uid() -> u32 {
    unsafe { libc::getuid() }
}

fn start_with(config: Config) -> (PathBuf, JoinHandle<io::Result<()>>) {
    static N: AtomicU32 = AtomicU32::new(0);
    let path = std::env::temp_dir().join(format!(
        "sd-{}-{}.sock",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path).unwrap();
    (path, std::thread::spawn(move || serve(listener, config)))
}

fn start() -> PathBuf {
    start_with(Config {
        idle_timeout: Duration::from_secs(600),
        allowed_uid: uid(),
        client_queue: Config::DEFAULT_CLIENT_QUEUE,
    })
    .0
}

struct Client(UnixStream);

impl Client {
    fn connect(path: &PathBuf) -> Client {
        let s = UnixStream::connect(path).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut c = Client(s);
        c.send(
            &Request::Hello {
                proto: PROTO_VERSION,
            },
            b"",
        );
        match c.recv().0 {
            Event::Hello {
                proto,
                daemon_pid,
                features,
            } => {
                assert_eq!(proto, PROTO_VERSION);
                assert_eq!(daemon_pid, std::process::id());
                assert_eq!(features, vec!["snapshot".to_string()]);
            }
            other => panic!("expected hello, got {other:?}"),
        }
        c
    }
    fn send(&mut self, r: &Request, payload: &[u8]) {
        write_frame(&mut self.0, r, payload).unwrap();
    }
    fn recv(&mut self) -> (Event, Vec<u8>) {
        read_frame(&mut self.0).unwrap()
    }
    fn create(&mut self, argv: &[&str]) -> String {
        let spec = SpawnSpec {
            argv: argv.iter().map(|s| s.to_string()).collect(),
            env: vec![
                ("TERM".into(), "xterm-256color".into()),
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("HOME".into(), std::env::temp_dir().display().to_string()),
            ],
            cwd: Some(std::env::temp_dir().display().to_string()),
            cols: 80,
            rows: 24,
            owner: Owner {
                pane_id: Some("pane-1".into()),
                canvas_terminal_id: None,
                window_label: "main".into(),
            },
            tag: Some(r#"{"provider":"claude"}"#.into()),
        };
        self.send(&Request::Create { req: 1, spec }, b"");
        loop {
            match self.recv().0 {
                Event::Created { req: 1, id, .. } => return id,
                Event::Error { message, .. } => panic!("create failed: {message}"),
                _ => {}
            }
        }
    }
    /// Attaches and returns (screen offset, screen bytes); output follows as `Output` events.
    fn attach(&mut self, id: &str, from: u64) -> (u64, Vec<u8>) {
        self.send(
            &Request::Attach {
                id: id.into(),
                from,
            },
            b"",
        );
        loop {
            match self.recv() {
                (
                    Event::Screen {
                        id: got,
                        total_bytes,
                    },
                    p,
                ) if got == id => return (total_bytes, p),
                (Event::Error { message, .. }, _) => panic!("attach failed: {message}"),
                _ => {}
            }
        }
    }
    /// Collects output of `id` until `until` holds for the bytes so far, starting at `from`.
    /// Asserts every chunk continues exactly where the last one ended.
    fn read_output(
        &mut self,
        id: &str,
        mut next: u64,
        until: impl Fn(&[u8]) -> bool,
    ) -> (u64, Vec<u8>) {
        let mut got = Vec::new();
        while !until(&got) {
            if let (Event::Output { id: of, offset }, p) = self.recv() {
                if of == id {
                    assert_eq!(
                        offset, next,
                        "gap or duplicate at {offset}, expected {next}"
                    );
                    next += p.len() as u64;
                    got.extend_from_slice(&p);
                }
            }
        }
        (next, got)
    }
}

fn ticks(bytes: &[u8]) -> Vec<u64> {
    String::from_utf8_lossy(bytes)
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter_map(|w| w.strip_prefix("tick")?.parse().ok())
        .collect()
}

/// The spike, as a test: a session keeps printing while no client is attached, and a second
/// client resuming from the first one's offset sees every tick exactly once.
#[test]
fn reattach_from_an_offset_continues_without_gap_or_duplicate() {
    let path = start();
    let mut a = Client::connect(&path);
    let id = a.create(&[
        "/bin/sh",
        "-c",
        "i=0; while :; do echo tick$i; i=$((i+1)); sleep 0.01; done",
    ]);
    let (end_a, out_a) = a.read_output(&id, 0, |b| ticks(b).len() >= 5);
    drop(a);
    std::thread::sleep(Duration::from_millis(300)); // ticks keep coming with nobody attached

    let mut b = Client::connect(&path);
    b.attach(&id, end_a);
    let (_, out_b) = b.read_output(&id, end_a, |b| ticks(b).len() >= 40);

    let mut all = out_a;
    all.extend_from_slice(&out_b);
    let seen = ticks(&all);
    let want: Vec<u64> = (0..seen.len() as u64).collect();
    assert_eq!(seen, want);
}

/// A full-screen program drawn while nobody watched is still on the screen at attach.
#[test]
fn a_tui_screen_is_drawn_without_any_client_attached() {
    let file = std::env::temp_dir().join(format!("sd-vi-{}.txt", std::process::id()));
    std::fs::write(&file, "alpha line\nbeta line\n").unwrap();
    let path = start();
    let id = Client::connect(&path).create(&["/usr/bin/vi", file.to_str().unwrap()]);
    std::thread::sleep(Duration::from_millis(800)); // creator gone: nobody is attached

    let mut c = Client::connect(&path);

    let (offset, screen) = c.attach(&id, u64::MAX);
    assert!(offset > 0);
    let mut parser = vt100::Parser::new(24, 80, 0);
    parser.process(&screen);
    let text = parser.screen().contents();
    assert!(
        text.contains("alpha line") && text.contains("beta line"),
        "{text}"
    );

    // The same screen as plain rows, which is what a permission prompt is read from.
    c.send(
        &Request::Snapshot {
            req: 5,
            id: id.clone(),
        },
        b"",
    );
    let (rows, size) = loop {
        match c.recv() {
            (
                Event::Snapshot {
                    req: 5, cols, rows, ..
                },
                p,
            ) => break (p, (cols, rows)),
            _ => continue,
        }
    };
    let rows = String::from_utf8(rows).unwrap();
    assert_eq!(size, (80, 24));
    assert!(
        rows.lines().next().unwrap().starts_with("alpha line"),
        "{rows}"
    );
    assert!(
        !rows.contains('\x1b') && !rows.lines().any(|l| l.ends_with(' ')),
        "{rows:?}"
    );

    c.send(&Request::Kill { id: id.clone() }, b"");
    let _ = std::fs::remove_file(file);
}

#[test]
fn write_reaches_stdin_and_kill_ends_in_exited() {
    let path = start();
    let mut c = Client::connect(&path);
    let id = c.create(&["/bin/cat"]);
    c.send(&Request::Write { id: id.clone() }, b"ping\r");
    c.read_output(&id, 0, |b| {
        String::from_utf8_lossy(b).matches("ping").count() >= 2
    });

    c.send(&Request::Kill { id: id.clone() }, b"");
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        assert!(Instant::now() < deadline, "no exited");
        if let (Event::Exited { id: got, .. }, _) = c.recv() {
            assert_eq!(got, id);
            break;
        }
    }
    c.send(&Request::List { req: 9 }, b"");
    loop {
        if let (Event::Sessions { req: 9, sessions }, _) = c.recv() {
            assert!(sessions.iter().all(|s| s.id != id));
            break;
        }
    }
}

#[test]
fn exit_is_announced_to_a_client_that_never_attached() {
    let path = start();
    let mut watcher = Client::connect(&path);
    let id = Client::connect(&path).create(&["/bin/sh", "-c", "sleep 0.3; exit 4"]);
    loop {
        if let (Event::Exited { id: got, code }, _) = watcher.recv() {
            assert_eq!((got, code), (id, 4));
            break;
        }
    }
}

/// The creator is attached by `create` itself: a program that prints and exits at once loses
/// nothing, and `exited` comes after its last byte.
#[test]
fn a_program_that_exits_at_once_reaches_its_creator_whole() {
    let path = start();
    let mut c = Client::connect(&path);
    let id = c.create(&["/bin/sh", "-c", "echo hi; exit 3"]);
    let mut got = Vec::new();
    let code = loop {
        match c.recv() {
            (Event::Output { id: of, offset }, p) if of == id => {
                assert_eq!(offset, got.len() as u64);
                got.extend(p);
            }
            (Event::Exited { id: of, code }, _) if of == id => break code,
            _ => {}
        }
    };
    assert_eq!(code, 3);
    assert_eq!(String::from_utf8_lossy(&got), "hi\r\n[Session ended:3]\r\n");
}

#[test]
fn a_request_about_an_unknown_session_names_it() {
    let path = start();
    let mut c = Client::connect(&path);
    c.send(
        &Request::Attach {
            id: "gone".into(),
            from: 0,
        },
        b"",
    );
    match c.recv().0 {
        Event::Error { id, req: None, .. } => assert_eq!(id.as_deref(), Some("gone")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn list_describes_live_sessions_and_resize_takes() {
    let path = start();
    let mut c = Client::connect(&path);
    let id = c.create(&["/bin/sleep", "30"]);
    c.send(
        &Request::Resize {
            id: id.clone(),
            cols: 100,
            rows: 30,
        },
        b"",
    );
    c.send(&Request::List { req: 2 }, b"");
    let s = loop {
        if let (Event::Sessions { req: 2, sessions }, _) = c.recv() {
            break sessions.into_iter().find(|s| s.id == id).expect("listed");
        }
    };
    assert_eq!((s.cols, s.rows), (100, 30));
    assert_eq!(s.owner.pane_id.as_deref(), Some("pane-1"));
    // What a restarted host needs to adopt it: where it runs and its own metadata.
    assert_eq!(s.cwd, Some(std::env::temp_dir().display().to_string()));
    assert_eq!(s.tag.as_deref(), Some(r#"{"provider":"claude"}"#));
    c.send(&Request::Kill { id }, b"");
}

#[test]
fn the_child_is_stamped_with_the_daemons_pid_as_owner() {
    let path = start();
    let mut c = Client::connect(&path);
    let id = c.create(&["/bin/sh", "-c", "echo owner=$LOTUS_PTY_OWNER_PID; sleep 30"]);
    let want = format!("owner={}", std::process::id());
    c.read_output(&id, 0, |b| String::from_utf8_lossy(b).contains(&want));
    c.send(&Request::Kill { id }, b"");
}

#[test]
fn a_wrong_protocol_version_is_answered_then_closed() {
    let path = start();
    let mut s = UnixStream::connect(&path).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    write_frame(&mut s, &Request::Hello { proto: 99 }, b"").unwrap();
    let (e, _): (Event, _) = read_frame(&mut s).unwrap();
    assert!(matches!(
        e,
        Event::Hello {
            proto: PROTO_VERSION,
            ..
        }
    ));
    assert!(read_frame::<Event>(&mut s).is_err());
}

#[test]
fn a_peer_with_another_uid_is_dropped_unanswered() {
    let (path, _) = start_with(Config {
        idle_timeout: Duration::from_secs(600),
        allowed_uid: uid() + 1,
        client_queue: Config::DEFAULT_CLIENT_QUEUE,
    });
    let mut s = UnixStream::connect(&path).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let _ = write_frame(
        &mut s,
        &Request::Hello {
            proto: PROTO_VERSION,
        },
        b"",
    );
    let err = read_frame::<Event>(&mut s).unwrap_err();
    assert_ne!(
        err.kind(),
        io::ErrorKind::WouldBlock,
        "connection was kept open"
    );
}

#[test]
fn idle_shutdown_waits_for_no_sessions_and_no_clients() {
    let (path, handle) = start_with(Config {
        idle_timeout: Duration::from_millis(300),
        allowed_uid: uid(),
        client_queue: Config::DEFAULT_CLIENT_QUEUE,
    });
    let mut c = Client::connect(&path);
    let id = c.create(&["/bin/sleep", "30"]);
    drop(c);
    std::thread::sleep(Duration::from_millis(800));
    assert!(!handle.is_finished(), "quit with a session alive");

    let mut c = Client::connect(&path);
    c.send(&Request::Kill { id }, b"");
    loop {
        if let (Event::Exited { .. }, _) = c.recv() {
            break;
        }
    }
    std::thread::sleep(Duration::from_millis(800));
    assert!(!handle.is_finished(), "quit with a client connected");
    drop(c);

    let deadline = Instant::now() + Duration::from_secs(3);
    while !handle.is_finished() {
        assert!(Instant::now() < deadline, "never shut down");
        std::thread::sleep(Duration::from_millis(50));
    }
    handle.join().unwrap().unwrap();
}

/// A client that stops reading is cut loose rather than holding up the session's output; it
/// must reconnect and reattach from its last offset (the app mirror's job, PHASE-3 step 4).
#[test]
fn a_client_that_stops_reading_is_disconnected_and_the_session_runs_on() {
    let (path, _) = start_with(Config {
        idle_timeout: Duration::from_secs(600),
        allowed_uid: uid(),
        client_queue: 16, // ~0.3 s of one flooding session
    });
    let mut slow = Client::connect(&path);
    let id = slow.create(&["/usr/bin/yes", "flood"]);
    std::thread::sleep(Duration::from_secs(2)); // not reading: kernel buffer, then queue, fill

    let deadline = Instant::now() + Duration::from_secs(10);
    let err = loop {
        assert!(
            Instant::now() < deadline,
            "still connected: never cut loose"
        );
        if let Err(e) = read_frame::<Event>(&mut slow.0) {
            break e;
        }
    };
    assert_ne!(err.kind(), io::ErrorKind::WouldBlock, "never disconnected");

    let mut fresh = Client::connect(&path);
    fresh.send(&Request::List { req: 3 }, b"");
    let total = loop {
        if let (Event::Sessions { req: 3, sessions }, _) = fresh.recv() {
            break sessions
                .iter()
                .find(|s| s.id == id)
                .expect("still alive")
                .total_bytes;
        }
    };
    assert!(total > 1_000_000, "session stalled at {total} bytes");
    fresh.send(&Request::Kill { id }, b"");
}

/// `exited` after `kill` is the app's "the tree is gone": the root dies at once, but a
/// descendant ignoring TERM must already be dead by the time it is announced.
#[test]
fn exited_after_kill_means_the_whole_tree_is_gone() {
    let path = start();
    let mut c = Client::connect(&path);
    let pid_file = std::env::temp_dir().join(format!("sd-tree-{}", std::process::id()));
    let _ = std::fs::remove_file(&pid_file);
    let script = format!(
        "nohup /bin/sh -c 'trap \"\" TERM HUP; while :; do /bin/sleep 1; done' </dev/null >/dev/null 2>&1 & echo $! > {}; wait",
        pid_file.display()
    );
    let id = c.create(&["/bin/sh", "-c", &script]);
    let deadline = Instant::now() + Duration::from_secs(5);
    let descendant: i32 = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|s| s.trim().parse().ok())
        {
            break pid;
        }
        assert!(Instant::now() < deadline, "no descendant");
        std::thread::sleep(Duration::from_millis(20));
    };
    std::thread::sleep(Duration::from_millis(100)); // its trap is installed

    c.send(&Request::Kill { id: id.clone() }, b"");
    loop {
        if let (Event::Exited { id: got, .. }, _) = c.recv() {
            assert_eq!(got, id);
            break;
        }
    }
    // A killed process is a zombie until launchd reaps it; `ps` tells the two apart.
    let stat = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &descendant.to_string()])
        .output()
        .unwrap();
    let alive = stat.status.success()
        && !String::from_utf8_lossy(&stat.stdout)
            .trim()
            .starts_with('Z');
    unsafe { libc::kill(descendant, libc::SIGKILL) };
    let _ = std::fs::remove_file(&pid_file);
    assert!(!alive, "descendant {descendant} outlived exited");
}
