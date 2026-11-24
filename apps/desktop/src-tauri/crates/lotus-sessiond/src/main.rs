//! `lotus-sessiond --socket <path>`: started by the app, detaches, serves until idle.

#[cfg(unix)]
mod imp {
    use lotus_sessiond::client::prepare_socket_dir;
    use lotus_sessiond::daemon::{serve, Config};
    use std::fs::OpenOptions;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::PathBuf;
    use std::time::Duration;

    const IDLE_TIMEOUT: Duration = Duration::from_secs(10 * 60);

    pub fn main() {
        let mut args = std::env::args().skip(1);
        let socket = match (args.next().as_deref(), args.next()) {
            (Some("--socket"), Some(p)) => PathBuf::from(p),
            _ => {
                eprintln!("usage: lotus-sessiond --socket <path>");
                std::process::exit(2);
            }
        };
        // `--detach` (the launchd job): the job's process forks the daemon and exits, then the
        // job is unloaded. launchd attributes a live job to the coalition that bootstrapped it,
        // and the Dock's quit kills those services (measured 2026-11-17); a finished, unloaded
        // job leaves nothing to attribute.
        if args.next().as_deref() == Some("--detach") {
            // Single-threaded here, so fork is safe.
            match unsafe { libc::fork() } {
                -1 => {}
                0 => {}
                _ => {
                    lotus_sessiond::client::launchd::unload_self();
                    std::process::exit(0);
                }
            }
        }
        if let Err(e) = run(&socket) {
            eprintln!("lotus-sessiond: {e}");
            std::process::exit(1);
        }
    }

    fn run(socket: &std::path::Path) -> std::io::Result<()> {
        // Own session: the app quitting (or its terminal closing) does not take us down.
        unsafe { libc::setsid() };
        let dir = socket.parent().unwrap_or(std::path::Path::new("/"));
        prepare_socket_dir(dir)?;

        // One daemon per socket. Two apps starting at once both spawn us; the loser leaves quietly
        // and its client connects to the winner. Held for the process's life.
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(socket.with_extension("lock"))?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Ok(());
        }
        // Holding the lock means any socket file left there is a dead daemon's.
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket)?;
        std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600))?;
        eprintln!(
            "lotus-sessiond {} serving {}",
            std::process::id(),
            socket.display()
        );

        let result = serve(
            listener,
            Config {
                idle_timeout: IDLE_TIMEOUT,
                allowed_uid: unsafe { libc::getuid() },
                client_queue: Config::DEFAULT_CLIENT_QUEUE,
            },
        );
        let _ = std::fs::remove_file(socket);
        drop(lock);
        result
    }
}

#[cfg(unix)]
fn main() {
    imp::main()
}

#[cfg(not(unix))]
fn main() {
    eprintln!("lotus-sessiond: Windows support is phase 4");
    std::process::exit(1);
}
