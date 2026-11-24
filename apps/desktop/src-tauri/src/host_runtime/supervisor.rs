//! Supervises the embedded host runtime process (`packages/host`).
//!
//! Lifecycle:
//!   - `start(cfg)` validates config, materialises the embedded executable,
//!     spawns it with the runtime's env vars, stores child handle — and **replaces a
//!     running child whose environment would now differ**, because every setting that
//!     matters to it is read from the environment once, at spawn.
//!   - `stop()` sends **SIGKILL** and reaps; idempotent — calling on idle is a no-op.
//!     (This said SIGTERM until 2026-09-08 and was wrong: `RealChild::kill` calls
//!     `std::process::Child::kill`, which is SIGKILL on Unix. Worth knowing, because it
//!     means the child never runs its shutdown path — it does not get to delete the
//!     admin advert it wrote, and it does not get to close sockets politely.)
//!   - `status()` reports `Idle | Running { pid } | Crashed { code }`.
//!
//! The spawner is abstracted behind a trait so unit tests can verify
//! orchestration logic (start/stop/status transitions, double-start
//! refusal, crash detection) without spawning the real runtime. Production
//! wiring uses `RealSpawner` which calls `std::process::Command`.

use crate::no_window::NoWindow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use super::config::HostRuntimeConfig;

/// Reported lifecycle state. Frontend polls this to drive the status
/// indicator in the settings UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HostRuntimeStatus {
    /// No child has been spawned (default after app start with bot
    /// disabled, or after a clean `stop()`).
    Idle,
    /// Child is alive.
    Running { pid: u32 },
    /// Child started but has since exited.
    Crashed {
        code: Option<i32>,
        last_lifetime_ms: u128,
    },
    /// `start()` refused — config rejected validation, no spawn attempted.
    Misconfigured { reasons: Vec<String> },
}

/// Thin abstraction over the real OS-level spawn. Lets tests replace
/// the spawn with a deterministic stub that captures the env / args
/// without exec'ing anything.
pub trait Spawner: Send + Sync + 'static {
    /// Spawn the materialized runtime executable with the given env. Returns an
    /// abstract child handle the supervisor can later kill / poll.
    fn spawn(
        &self,
        executable_path: &PathBuf,
        env: Vec<(String, String)>,
    ) -> std::io::Result<Box<dyn ChildHandle>>;
}

/// Abstract handle representing a spawned subprocess. Production uses
/// a wrapper around `std::process::Child`; tests use an in-memory stub.
pub trait ChildHandle: Send + Sync {
    fn id(&self) -> u32;
    /// `Ok(Some(code))` if exited, `Ok(None)` if still running.
    fn try_wait_exit(&mut self) -> std::io::Result<Option<i32>>;
    /// Best-effort terminate. Returns once the child is gone or after
    /// a short timeout.
    fn kill(&mut self) -> std::io::Result<()>;
}

// ─── Production spawner ──────────────────────────────────────────────────────

/// Real-process spawner that calls the embedded runtime executable directly.
pub struct RealSpawner;

impl Spawner for RealSpawner {
    fn spawn(
        &self,
        executable_path: &PathBuf,
        env: Vec<(String, String)>,
    ) -> std::io::Result<Box<dyn ChildHandle>> {
        let mut cmd = std::process::Command::new(executable_path).no_window();
        cmd.envs(env);
        cmd.stdin(std::process::Stdio::null());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        let mut child = cmd.spawn()?;
        // Draining these is not optional. See `drain_into_log`.
        if let Some(out) = child.stdout.take() {
            drain_into_log(out, "out");
        }
        if let Some(err) = child.stderr.take() {
            drain_into_log(err, "err");
        }
        Ok(Box::new(RealChild(child)))
    }
}

/// Forward one of the child's pipes to our own stderr, a line at a time.
///
/// **Why this exists, and why it is not merely tidy.** A piped stdio stream that
/// nobody reads is a deadlock with a delay fuse: the OS pipe buffer is finite
/// (16-64 KB on macOS), and once it fills, the child's next `write` blocks
/// forever. `packages/host` logs to stdout on every audited mutation
/// (`core/logger.ts` → `process.stdout.write`), so the fuse burns down in
/// proportion to how much the host is used.
///
/// The fast path to failure is `MobileAdapter.pushFleet`: with a phone connected
/// it polls every 3s and logs `mobile.fleet.poll_failed` on each failure, so a
/// Rust API that stops answering — exactly what a sleeping laptop produces —
/// emits ~120 bytes every 3 seconds until the buffer is full, then wedges the
/// host in **6 to 25 minutes** depending on the buffer size.
///
/// That failure is worse than a crash, because `try_wait_exit` still reports the
/// process as alive: `status()` says `Running { pid }` while the façade answers
/// nothing. Anyone testing macOS sleep (`issues/02`) would read the wedge as a
/// sleep or tailnet fault and chase the wrong layer.
///
/// Forwarding rather than discarding (`Stdio::null()`) keeps the host's audit
/// trail visible in the Rust dev terminal, which is where diagnostics for this
/// app are supposed to land.
fn drain_into_log<R: std::io::Read + Send + 'static>(stream: R, tag: &'static str) {
    std::thread::spawn(move || {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stream);
        for line in reader.lines() {
            match line {
                Ok(line) => eprintln!("[host-runtime/{tag}] {line}"),
                // A read error means the pipe is gone; the child is exiting.
                Err(_) => break,
            }
        }
    });
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    status.code().unwrap_or(-1)
}

struct RealChild(std::process::Child);

impl ChildHandle for RealChild {
    fn id(&self) -> u32 {
        self.0.id()
    }

    /// A signal death is reported as `128 + signal`, the shell's convention.
    ///
    /// This used to be `.and_then(|s| s.code())`, and `code()` is `None` for a
    /// signal — so a child the kernel SIGKILLed on exec (invalid code signature,
    /// 2026-10-04) read as **still running**, forever, and the settings UI could
    /// never say it had crashed.
    fn try_wait_exit(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self.0.try_wait()?.map(exit_code))
    }

    fn kill(&mut self) -> std::io::Result<()> {
        let _ = self.0.kill();
        let _ = self.0.wait();
        Ok(())
    }
}

// ─── Supervisor ──────────────────────────────────────────────────────────────

struct State {
    child: Option<Box<dyn ChildHandle>>,
    /// The environment the live child was spawned with.
    ///
    /// Kept because it is the only record of what the running process actually
    /// believes: every setting that matters to it — the bind address above all —
    /// reaches it as an env var read once at spawn, so the config on disk and the
    /// process can disagree indefinitely with nothing to notice.
    spawned_env: Option<Vec<(String, String)>>,
    started_at_ms: Option<u128>,
    last_exit_code: Option<i32>,
    last_lifetime_ms: Option<u128>,
    last_misconfig: Option<Vec<String>>,
}

pub struct Supervisor {
    spawner: Box<dyn Spawner>,
    executable_path: PathBuf,
    state: Mutex<State>,
}

/// Env vars the supervisor injects for the runtime child. `extras` come from
/// the desktop app (e.g. Lotus API URL + bearer for the in-process axum
/// server) and are merged with config-derived vars.
pub struct ExtraEnv {
    pub api_url: Option<String>,
    pub api_token: Option<String>,
    /// Rust's resolved state root (`~/.lotus` release, `~/.lotus-dev` dev). The
    /// child hardcodes `~/.lotus`, so without this dev and release share device
    /// credentials and Rust reads a directory the child never writes.
    pub state_dir: Option<String>,
    /// Shared secret for the child's loopback admin channel. `None` means the
    /// child starts no admin listener at all, which is the safe default: without
    /// a secret the channel would accept any local caller.
    pub admin_secret: Option<String>,
}

impl Supervisor {
    pub fn new(spawner: Box<dyn Spawner>, executable_path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            spawner,
            executable_path,
            state: Mutex::new(State {
                child: None,
                spawned_env: None,
                started_at_ms: None,
                last_exit_code: None,
                last_lifetime_ms: None,
                last_misconfig: None,
            }),
        })
    }

    /// Start the runtime, or reconcile the one already running against `cfg`.
    ///
    /// Refuses if the config is invalid. A live child is reused when it would be
    /// spawned with the same environment and **replaced when it would not** — see the
    /// comment on that branch for the bug that distinction fixes. Returns the resolved
    /// status on success.
    pub fn start(
        &self,
        cfg: &HostRuntimeConfig,
        extras: &ExtraEnv,
    ) -> std::io::Result<HostRuntimeStatus> {
        let problems = cfg.validate();
        if !problems.is_empty() {
            let mut state = self.state.lock().unwrap();
            state.last_misconfig = Some(problems.clone());
            return Ok(HostRuntimeStatus::Misconfigured { reasons: problems });
        }

        let env = build_env(cfg, extras);

        // Already running? Reuse it **only if it would be spawned the same way**.
        //
        // A live child cannot be handed a new environment, so a settings change that
        // only lives in env — the bind address, the state dir, the admin secret — needs
        // a replacement process or it does not happen at all. Returning `Running` for
        // any live child, which is what this did until 2026-09-08, meant moving Mobile
        // Access to another address wrote the new value to disk, left the old listener
        // in place, and reported green while the phone could no longer reach anything.
        //
        // The comparison is what keeps this from becoming an unconditional restart:
        // `apply()` runs on every save, and a save that changed nothing must not drop
        // the phone's socket.
        {
            let mut state = self.state.lock().unwrap();
            // Resolved first so the borrow on `state.child` ends before the arms below
            // need to replace it.
            let alive = match state.child.as_mut() {
                Some(child) => child.try_wait_exit()?.is_none().then(|| child.id()),
                None => None,
            };
            match alive {
                Some(pid) if same_env(state.spawned_env.as_deref().unwrap_or(&[]), &env) => {
                    return Ok(HostRuntimeStatus::Running { pid });
                }
                Some(_) => {
                    // Different environment: stop this one, then fall through and
                    // spawn its replacement.
                    if let Some(mut old) = state.child.take() {
                        let _ = old.kill();
                    }
                    if let Some(started) = state.started_at_ms.take() {
                        state.last_lifetime_ms = Some(now_ms().saturating_sub(started));
                    }
                }
                // Either nothing was running, or it exited — respawn either way.
                None => state.child = None,
            }
        }
        let child = self.spawner.spawn(&self.executable_path, env.clone())?;
        let pid = child.id();

        let mut state = self.state.lock().unwrap();
        state.child = Some(child);
        state.spawned_env = Some(env);
        state.started_at_ms = Some(now_ms());
        state.last_misconfig = None;
        Ok(HostRuntimeStatus::Running { pid })
    }

    /// Stop the runtime. Idempotent.
    pub fn stop(&self) -> std::io::Result<()> {
        let mut state = self.state.lock().unwrap();
        state.spawned_env = None;
        if let Some(mut child) = state.child.take() {
            let _ = child.kill();
            if let Some(start) = state.started_at_ms.take() {
                state.last_lifetime_ms = Some(now_ms().saturating_sub(start));
            }
        }
        Ok(())
    }

    /// Current state. Polls the child each call to flip Running →
    /// Crashed automatically without needing a background thread.
    pub fn status(&self) -> HostRuntimeStatus {
        let mut state = self.state.lock().unwrap();
        if let Some(reasons) = state.last_misconfig.clone() {
            if state.child.is_none() {
                return HostRuntimeStatus::Misconfigured { reasons };
            }
        }
        let Some(child) = state.child.as_mut() else {
            if let Some(code) = state.last_exit_code {
                return HostRuntimeStatus::Crashed {
                    code: Some(code),
                    last_lifetime_ms: state.last_lifetime_ms.unwrap_or(0),
                };
            }
            return HostRuntimeStatus::Idle;
        };

        match child.try_wait_exit() {
            Ok(None) => HostRuntimeStatus::Running { pid: child.id() },
            Ok(Some(code)) => {
                let lifetime = state
                    .started_at_ms
                    .take()
                    .map(|s| now_ms().saturating_sub(s))
                    .unwrap_or(0);
                state.child = None;
                state.last_exit_code = Some(code);
                state.last_lifetime_ms = Some(lifetime);
                HostRuntimeStatus::Crashed {
                    code: Some(code),
                    last_lifetime_ms: lifetime,
                }
            }
            Err(_) => {
                state.child = None;
                HostRuntimeStatus::Idle
            }
        }
    }
}

/// Whether two spawn environments would produce the same process.
///
/// Order-insensitive on purpose. `build_env` pushes in a fixed order today, so a plain
/// slice comparison would pass — and would turn any future reordering of those pushes
/// into a spurious restart of a healthy host, which is a failure nobody would connect
/// to the edit that caused it.
fn same_env(a: &[(String, String)], b: &[(String, String)]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut a: Vec<_> = a.to_vec();
    let mut b: Vec<_> = b.to_vec();
    a.sort();
    b.sort();
    a == b
}

/// Builds the child process environment.
///
/// The three Telegram variables this used to inject — `TELEGRAM_BOT_TOKEN`,
/// `ALLOWED_TELEGRAM_USER_IDS`, `LOTUS_MINIAPP_URL` — were removed on 2026-08-02
/// with the adapter itself (ADR-2). Device credentials deliberately do **not**
/// appear here: per ADR-5 the host issues and revokes them during pairing, so
/// passing them through the environment would put a long-lived secret in the
/// process table for no benefit.
fn build_env(cfg: &HostRuntimeConfig, extras: &ExtraEnv) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    if let Some(p) = &cfg.default_provider {
        env.push(("LOTUS_DEFAULT_PROVIDER".into(), p.clone()));
    }
    if let Some(a) = &cfg.bind_address {
        env.push(("LOTUS_MOBILE_BIND".into(), a.clone()));
    }
    if let Some(u) = &extras.api_url {
        env.push(("LOTUS_API_URL".into(), u.clone()));
    }
    if let Some(t) = &extras.api_token {
        env.push(("LOTUS_API_TOKEN".into(), t.clone()));
    }
    if let Some(d) = &extras.state_dir {
        env.push(("LOTUS_STATE_DIR".into(), d.clone()));
    }
    if let Some(s) = &extras.admin_secret {
        env.push(("LOTUS_MOBILE_ADMIN_SECRET".into(), s.clone()));
    }
    // Always set, never inherited. The child calls `loadEnv()` which reads a `.env`
    // from its cwd, and it inherits OUR cwd because the spawner sets none — so a
    // stray `.env` in whatever directory Lotus was launched from used to decide
    // which adapter the host ran. A leftover `ADAPTER=telegram` kills it outright
    // ("Unknown adapter"), which is how a smoke run found this. `loadEnv` does not
    // overwrite an existing variable, so setting it here is the whole fix.
    env.push(("ADAPTER".into(), "mobile".into()));
    env
}

fn now_ms() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc as StdArc;

    // ─── Stub spawner ────────────────────────────────────────────────────────

    struct FakeChild {
        pid: u32,
        exit_code: StdArc<Mutex<Option<i32>>>,
        killed: StdArc<Mutex<bool>>,
    }

    impl ChildHandle for FakeChild {
        fn id(&self) -> u32 {
            self.pid
        }
        fn try_wait_exit(&mut self) -> std::io::Result<Option<i32>> {
            Ok(*self.exit_code.lock().unwrap())
        }
        fn kill(&mut self) -> std::io::Result<()> {
            *self.killed.lock().unwrap() = true;
            *self.exit_code.lock().unwrap() = Some(143); // SIGTERM
            Ok(())
        }
    }

    struct FakeSpawner {
        next_pid: AtomicU32,
        spawn_count: StdArc<Mutex<u32>>,
        last_env: StdArc<Mutex<Vec<(String, String)>>>,
        next_exit_code: StdArc<Mutex<Option<i32>>>,
        next_kill: StdArc<Mutex<bool>>,
    }

    impl FakeSpawner {
        fn new() -> Self {
            Self {
                next_pid: AtomicU32::new(10_000),
                spawn_count: StdArc::new(Mutex::new(0)),
                last_env: StdArc::new(Mutex::new(Vec::new())),
                next_exit_code: StdArc::new(Mutex::new(None)),
                next_kill: StdArc::new(Mutex::new(false)),
            }
        }
    }

    impl Spawner for FakeSpawner {
        fn spawn(
            &self,
            _executable_path: &PathBuf,
            env: Vec<(String, String)>,
        ) -> std::io::Result<Box<dyn ChildHandle>> {
            *self.spawn_count.lock().unwrap() += 1;
            *self.last_env.lock().unwrap() = env;
            Ok(Box::new(FakeChild {
                pid: self.next_pid.fetch_add(1, Ordering::SeqCst),
                exit_code: StdArc::clone(&self.next_exit_code),
                killed: StdArc::clone(&self.next_kill),
            }))
        }
    }

    fn good_cfg() -> HostRuntimeConfig {
        HostRuntimeConfig {
            enabled: true,
            default_provider: Some("claude".into()),
            bind_address: Some("127.0.0.1:8787".into()),
        }
    }

    fn extras() -> ExtraEnv {
        ExtraEnv {
            api_url: None,
            api_token: None,
            state_dir: None,
            admin_secret: None,
        }
    }

    #[test]
    fn start_with_invalid_config_returns_misconfigured_and_does_not_spawn() {
        let spawner = StdArc::new(FakeSpawner::new());
        let count = StdArc::clone(&spawner.spawn_count);
        let sup = Supervisor::new(Box::new(unwrap_arc(spawner)), PathBuf::from("/x.mjs"));

        // A pasted URL where a bind address belongs — the one mistake
        // `validate()` still guards after the Telegram fields were removed.
        let bad = HostRuntimeConfig {
            enabled: true,
            bind_address: Some("http://127.0.0.1:8787".into()),
            ..Default::default()
        };
        let status = sup.start(&bad, &extras()).unwrap();
        assert!(matches!(status, HostRuntimeStatus::Misconfigured { .. }));
        assert_eq!(*count.lock().unwrap(), 0);
    }

    #[test]
    fn start_spawns_child_and_reports_running() {
        let spawner = StdArc::new(FakeSpawner::new());
        let count = StdArc::clone(&spawner.spawn_count);
        let sup = Supervisor::new(Box::new(unwrap_arc(spawner)), PathBuf::from("/x.mjs"));

        let status = sup.start(&good_cfg(), &extras()).unwrap();
        assert!(matches!(status, HostRuntimeStatus::Running { .. }));
        assert_eq!(*count.lock().unwrap(), 1);
        assert!(matches!(sup.status(), HostRuntimeStatus::Running { .. }));
    }

    #[test]
    fn double_start_does_not_spawn_twice() {
        let spawner = StdArc::new(FakeSpawner::new());
        let count = StdArc::clone(&spawner.spawn_count);
        let sup = Supervisor::new(Box::new(unwrap_arc(spawner)), PathBuf::from("/x.mjs"));

        sup.start(&good_cfg(), &extras()).unwrap();
        sup.start(&good_cfg(), &extras()).unwrap();
        assert_eq!(*count.lock().unwrap(), 1);
    }

    #[test]
    fn stop_kills_running_child_and_returns_to_idle() {
        let spawner = StdArc::new(FakeSpawner::new());
        let killed = StdArc::clone(&spawner.next_kill);
        let sup = Supervisor::new(Box::new(unwrap_arc(spawner)), PathBuf::from("/x.mjs"));

        sup.start(&good_cfg(), &extras()).unwrap();
        sup.stop().unwrap();

        assert!(*killed.lock().unwrap(), "kill not called on child");
        // After stop, status should be idle (no recorded exit code, no child).
        assert_eq!(sup.status(), HostRuntimeStatus::Idle);
    }

    #[test]
    fn stop_when_idle_is_a_no_op() {
        let spawner = StdArc::new(FakeSpawner::new());
        let sup = Supervisor::new(Box::new(unwrap_arc(spawner)), PathBuf::from("/x.mjs"));
        // Should not error.
        sup.stop().unwrap();
        sup.stop().unwrap();
        assert_eq!(sup.status(), HostRuntimeStatus::Idle);
    }

    #[test]
    fn status_flips_to_crashed_when_child_exits_unexpectedly() {
        let spawner = StdArc::new(FakeSpawner::new());
        let exit_code = StdArc::clone(&spawner.next_exit_code);
        let sup = Supervisor::new(Box::new(unwrap_arc(spawner)), PathBuf::from("/x.mjs"));

        sup.start(&good_cfg(), &extras()).unwrap();
        // Simulate the child crashing.
        *exit_code.lock().unwrap() = Some(1);

        match sup.status() {
            HostRuntimeStatus::Crashed { code, .. } => assert_eq!(code, Some(1)),
            other => panic!("expected Crashed, got {other:?}"),
        }
    }

    #[test]
    fn restart_after_crash_succeeds() {
        let spawner = StdArc::new(FakeSpawner::new());
        let count = StdArc::clone(&spawner.spawn_count);
        let exit_code = StdArc::clone(&spawner.next_exit_code);
        let sup = Supervisor::new(Box::new(unwrap_arc(spawner)), PathBuf::from("/x.mjs"));

        sup.start(&good_cfg(), &extras()).unwrap();
        *exit_code.lock().unwrap() = Some(2);
        // Status read flushes the dead child.
        let _ = sup.status();
        // Reset so the next spawn produces a "running" child.
        *exit_code.lock().unwrap() = None;

        let status = sup.start(&good_cfg(), &extras()).unwrap();
        assert!(matches!(status, HostRuntimeStatus::Running { .. }));
        assert_eq!(*count.lock().unwrap(), 2);
    }

    /// The three Telegram variables this used to assert on —
    /// `TELEGRAM_BOT_TOKEN`, `ALLOWED_TELEGRAM_USER_IDS`, `LOTUS_MINIAPP_URL` —
    /// were removed with the adapter (ADR-2). These two tests replace them.
    ///
    /// The bug this file existed with until 2026-09-08.
    ///
    /// The bind address reaches the child as `LOTUS_MOBILE_BIND`, an **environment
    /// variable read at spawn**, and a live process cannot be handed a new one. The old
    /// guard here returned `Running { pid }` for any live child, so moving Mobile Access
    /// from a LAN address to the tailnet wrote the new value to disk, left the process
    /// listening on the old one, and reported green. From the phone that is a host that
    /// simply stopped answering, with a settings screen insisting it is fine.
    #[test]
    fn changing_the_bind_address_respawns_rather_than_reporting_the_old_process() {
        let spawner = FakeSpawner::new();
        let count = StdArc::clone(&spawner.spawn_count);
        let env_seen = StdArc::clone(&spawner.last_env);
        let sup = Supervisor::new(Box::new(spawner), PathBuf::from("/bin/true"));

        let mut cfg = good_cfg();
        cfg.bind_address = Some("192.168.1.4:8787".into());
        let first = sup.start(&cfg, &extras()).unwrap();

        cfg.bind_address = Some("100.64.0.11:8787".into());
        let second = sup.start(&cfg, &extras()).unwrap();

        assert_eq!(
            *count.lock().unwrap(),
            2,
            "the child must be replaced, not reused"
        );
        let env: std::collections::HashMap<_, _> =
            env_seen.lock().unwrap().clone().into_iter().collect();
        assert_eq!(env.get("LOTUS_MOBILE_BIND").unwrap(), "100.64.0.11:8787");
        assert_ne!(first, second, "a new process means a new pid");
    }

    /// The other half, and the reason the fix is a comparison rather than an
    /// unconditional restart: `apply()` runs on every settings save, and a save that
    /// changed nothing must not drop the phone's socket.
    #[test]
    fn an_unchanged_config_still_leaves_the_running_child_alone() {
        let spawner = FakeSpawner::new();
        let count = StdArc::clone(&spawner.spawn_count);
        let sup = Supervisor::new(Box::new(spawner), PathBuf::from("/bin/true"));

        let cfg = good_cfg();
        let first = sup.start(&cfg, &extras()).unwrap();
        let second = sup.start(&cfg, &extras()).unwrap();

        assert_eq!(*count.lock().unwrap(), 1);
        assert_eq!(first, second);
    }

    /// Config is not the only input to the environment. `extras` carries the admin
    /// secret and the state dir, and a change there is just as invisible to a live
    /// child as a change to the bind address.
    #[test]
    fn a_changed_extra_env_respawns_too() {
        let spawner = FakeSpawner::new();
        let count = StdArc::clone(&spawner.spawn_count);
        let sup = Supervisor::new(Box::new(spawner), PathBuf::from("/bin/true"));

        let cfg = good_cfg();
        sup.start(&cfg, &extras()).unwrap();
        sup.start(
            &cfg,
            &ExtraEnv {
                api_url: None,
                api_token: None,
                state_dir: Some("/tmp/elsewhere".into()),
                admin_secret: None,
            },
        )
        .unwrap();

        assert_eq!(*count.lock().unwrap(), 2);
    }

    /// `packages/host` resolves its own state directory as a hardcoded `~/.lotus`, while Rust
    /// uses `~/.lotus-dev` under `debug_assertions`. Left alone the two disagree in dev, so a
    /// dev host writes device credentials into the release directory and anything Rust
    /// advertises there is invisible to it. The env var is how the disagreement is settled:
    /// Rust decides.
    #[test]
    fn build_env_passes_the_state_dir_so_dev_and_release_do_not_share_credentials() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            default_provider: None,
            bind_address: None,
        };
        let extras = ExtraEnv {
            api_url: None,
            api_token: None,
            state_dir: Some("/Users/x/.lotus-dev".into()),
            admin_secret: None,
        };

        let env = build_env(&cfg, &extras);

        assert!(
            env.contains(&("LOTUS_STATE_DIR".into(), "/Users/x/.lotus-dev".into())),
            "state dir must reach the child, else it falls back to ~/.lotus: {env:?}"
        );
    }

    /// Absent rather than empty: an empty value would read as "use the empty
    /// path" at the child's config boundary, where a missing key falls back.
    #[test]
    fn build_env_omits_the_state_dir_when_none() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            default_provider: None,
            bind_address: None,
        };
        let extras = ExtraEnv {
            api_url: None,
            api_token: None,
            state_dir: None,
            admin_secret: None,
        };

        let env = build_env(&cfg, &extras);

        assert!(
            !env.iter().any(|(k, _)| k == "LOTUS_STATE_DIR"),
            "unset must mean absent, not empty: {env:?}"
        );
    }

    #[test]
    fn build_env_passes_provider_bind_address_and_api_overrides() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            default_provider: Some("codex".into()),
            bind_address: Some("100.64.0.2:8787".into()),
        };
        let extras = ExtraEnv {
            api_url: Some("http://127.0.0.1:9123".into()),
            api_token: Some("bearer-xyz".into()),
            state_dir: Some("/Users/x/.lotus-dev".into()),
            admin_secret: None,
        };
        let env = build_env(&cfg, &extras);
        let map: std::collections::HashMap<_, _> = env.into_iter().collect();
        assert_eq!(map.get("LOTUS_DEFAULT_PROVIDER").unwrap(), "codex");
        assert_eq!(map.get("LOTUS_MOBILE_BIND").unwrap(), "100.64.0.2:8787");
        assert_eq!(map.get("LOTUS_API_URL").unwrap(), "http://127.0.0.1:9123");
        assert_eq!(map.get("LOTUS_API_TOKEN").unwrap(), "bearer-xyz");
    }

    #[test]
    fn build_env_omits_optional_keys_when_unset() {
        let cfg = HostRuntimeConfig {
            enabled: true,
            default_provider: None,
            bind_address: None,
        };
        let env = build_env(
            &cfg,
            &ExtraEnv {
                api_url: None,
                api_token: None,
                state_dir: None,
                admin_secret: None,
            },
        );
        // `ADAPTER` is deliberately unconditional (see the test above), so what this
        // guards is that nothing OPTIONAL sneaks in as an empty value.
        let optional: Vec<&(String, String)> = env.iter().filter(|(k, _)| k != "ADAPTER").collect();
        assert!(
            optional.is_empty(),
            "nothing optional is configured, so nothing optional is injected: {optional:?}"
        );
    }

    /// Every credential the child is allowed to receive, named here on purpose.
    /// The guard below fails on anything credential-shaped that is not listed, so
    /// adding one is a deliberate edit rather than something that slips through.
    const ALLOWED_CREDENTIAL_KEYS: &[&str] = &[
        // Bearer for our own loopback axum server.
        "LOTUS_API_TOKEN",
        // Loopback-only admin channel secret, regenerated on every start. It
        // grants no more than the settings UI already has, and the alternative
        // is an unauthenticated control channel open to any local process.
        "LOTUS_MOBILE_ADMIN_SECRET",
    ];

    /// Guards the ADR-5 decision that device credentials never travel through
    /// the child's environment: a secret in the process table is readable by any
    /// local process, and the host issues these itself during pairing.
    #[test]
    fn build_env_never_carries_a_credential_like_key() {
        // "SECRET", "KEY" and "PASSWORD" belong here as much as "TOKEN" does. The
        // first version of this guard checked only TOKEN, which would have waved
        // an admin secret straight through while still reading as protection.
        const CREDENTIAL_SHAPES: &[&str] = &["TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY"];

        let env = build_env(&good_cfg(), &extras());
        for (key, _) in &env {
            let k = key.to_ascii_uppercase();
            let shaped = CREDENTIAL_SHAPES.iter().any(|s| k.contains(s))
                || k.split('_').any(|seg| seg == "KEY");
            assert!(
                !shaped || ALLOWED_CREDENTIAL_KEYS.contains(&k.as_str()),
                "credential-shaped key not in ALLOWED_CREDENTIAL_KEYS: {key}. \
                 If the child genuinely needs it, add it there and say why."
            );
            assert!(
                !k.contains("TELEGRAM"),
                "Telegram variable resurfaced: {key}"
            );
        }
    }

    /// Reproduced live: the child's `loadEnv()` resolves `.env` against its cwd,
    /// which it inherits from us, so a leftover `ADAPTER=telegram` in the launch
    /// directory made the host exit with "Unknown adapter" before serving anything.
    /// The parent has to decide, exactly like `LOTUS_STATE_DIR`.
    #[test]
    fn build_env_always_names_the_adapter_so_a_stray_dotenv_cannot_pick_one() {
        let env = build_env(&good_cfg(), &extras());

        assert!(
            env.contains(&("ADAPTER".into(), "mobile".into())),
            "the child must not be left to infer this: {env:?}"
        );
    }

    /// The child needs the secret to authenticate the desktop, and there is no
    /// safer channel: it is a loopback-only shared secret, regenerated per start,
    /// and it grants no more than the settings UI already has.
    #[test]
    fn build_env_passes_the_admin_secret_and_the_guard_allows_it_deliberately() {
        let extras = ExtraEnv {
            api_url: None,
            api_token: None,
            state_dir: None,
            admin_secret: Some("f".repeat(64)),
        };

        let env = build_env(&good_cfg(), &extras);

        assert!(
            env.contains(&("LOTUS_MOBILE_ADMIN_SECRET".into(), "f".repeat(64))),
            "without it the child starts no admin listener: {env:?}"
        );
        assert!(
            ALLOWED_CREDENTIAL_KEYS.contains(&"LOTUS_MOBILE_ADMIN_SECRET"),
            "the credential guard must list this on purpose, not tolerate it by accident"
        );
    }

    /// The guard is only worth having if it can fail, and a guard that silently
    /// stopped matching would look identical to a clean env. This pins the
    /// matcher itself rather than the current env contents.
    #[test]
    fn credential_guard_actually_matches_credential_shapes() {
        const CREDENTIAL_SHAPES: &[&str] = &["TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY"];
        let shaped = |key: &str| -> bool {
            let k = key.to_ascii_uppercase();
            CREDENTIAL_SHAPES.iter().any(|s| k.contains(s)) || k.split('_').any(|seg| seg == "KEY")
        };

        for key in [
            "LOTUS_MOBILE_ADMIN_SECRET",
            "LOTUS_API_TOKEN",
            "SOME_API_KEY",
            "DB_PASSWORD",
        ] {
            assert!(shaped(key), "{key} should be seen as credential-shaped");
        }
        for key in [
            "LOTUS_STATE_DIR",
            "LOTUS_MOBILE_BIND",
            "LOTUS_KEYBOARD_MODE",
        ] {
            assert!(
                !shaped(key),
                "{key} is not a credential and must not trip the guard"
            );
        }
    }

    /// Pins the exact JSON the frontend receives. `#[serde(rename_all)]` on an
    /// enum renames variants, not the fields inside them, so `last_lifetime_ms`
    /// stays snake_case while the variant tag is snake_case too. A TypeScript
    /// type written from the Rust field names alone would guess camelCase and
    /// read `undefined` forever, silently.
    #[test]
    fn status_json_shape_is_pinned_for_the_frontend() {
        let json = |s: &HostRuntimeStatus| serde_json::to_string(s).unwrap();

        assert_eq!(json(&HostRuntimeStatus::Idle), r#"{"kind":"idle"}"#);
        assert_eq!(
            json(&HostRuntimeStatus::Running { pid: 42 }),
            r#"{"kind":"running","pid":42}"#
        );
        assert_eq!(
            json(&HostRuntimeStatus::Crashed {
                code: Some(1),
                last_lifetime_ms: 900,
            }),
            r#"{"kind":"crashed","code":1,"last_lifetime_ms":900}"#
        );
        assert_eq!(
            json(&HostRuntimeStatus::Misconfigured {
                reasons: vec!["bad port".into()]
            }),
            r#"{"kind":"misconfigured","reasons":["bad port"]}"#
        );
    }

    /// Helper: turn an `Arc<T>` whose only owner is the test back into
    /// the owned `T`. Lets us pass a monitorable spawner into the
    /// supervisor while keeping refs on the test side.
    fn unwrap_arc<T>(arc: StdArc<T>) -> T
    where
        T: Spawner + Sized,
    {
        StdArc::try_unwrap(arc)
            .map_err(|_| ())
            .expect("spawner had extra refs")
    }

    // ─── RealSpawner: pipe draining ──────────────────────────────────────────
    //
    // These exercise `RealSpawner`, which every other test in this file avoids
    // on purpose. That avoidance is exactly how an unread pipe survived here:
    // `FakeSpawner` has no pipes, so no amount of stub coverage can catch it.
    // A real child that outlives its own pipe buffer is the only witness.

    /// Write an executable shell script that floods stdout, then exits 0.
    #[cfg(unix)]
    fn write_flooding_script(dir: &std::path::Path, lines: usize, stream: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("flood.sh");
        let redirect = if stream == "err" { " 1>&2" } else { "" };
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\ni=0\nwhile [ $i -lt {lines} ]; do\n\
                 echo \"{pad}\"{redirect}\ni=$((i+1))\ndone\nexit 0\n",
                pad = "x".repeat(60),
            ),
        )
        .expect("write script");
        let mut perms = std::fs::metadata(&path).expect("stat script").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).expect("chmod script");
        path
    }

    /// Poll until the child exits, or give up. Returns the exit code.
    #[cfg(unix)]
    fn wait_for_exit(child: &mut Box<dyn ChildHandle>, budget: std::time::Duration) -> Option<i32> {
        let deadline = std::time::Instant::now() + budget;
        while std::time::Instant::now() < deadline {
            match child.try_wait_exit() {
                Ok(Some(code)) => return Some(code),
                Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
                Err(_) => return None,
            }
        }
        None
    }

    /// 4000 x ~61 bytes is ~244 KB, several times any plausible pipe buffer, so
    /// an undrained child cannot finish. Before the drain existed this hung
    /// until the timeout; the assertion message is written for whoever sees it
    /// regress.
    #[cfg(unix)]
    #[test]
    fn real_spawner_drains_stdout_so_a_chatty_child_can_finish() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = write_flooding_script(dir.path(), 4000, "out");

        let mut child = RealSpawner
            .spawn(&script, vec![])
            .expect("spawn flooding script");

        assert_eq!(
            wait_for_exit(&mut child, std::time::Duration::from_secs(20)),
            Some(0),
            "child never exited: its stdout pipe filled and blocked its writes, \
             which is the deadlock `drain_into_log` exists to prevent"
        );
    }

    /// stderr is piped too, so it has the identical failure mode and needs its
    /// own witness rather than an assumption that one drain covers both.
    #[cfg(unix)]
    #[test]
    fn real_spawner_drains_stderr_too() {
        let dir = tempfile::tempdir().expect("tempdir");
        let script = write_flooding_script(dir.path(), 4000, "err");

        let mut child = RealSpawner
            .spawn(&script, vec![])
            .expect("spawn flooding script");

        assert_eq!(
            wait_for_exit(&mut child, std::time::Duration::from_secs(20)),
            Some(0),
            "child never exited: its stderr pipe filled and blocked its writes"
        );
    }

    /// What the kernel does to a host with a broken code signature. `code()` is
    /// `None` for this, and reading that as "still running" is what kept the UI
    /// from ever saying the host had crashed.
    #[cfg(unix)]
    #[test]
    fn real_spawner_reports_a_signal_death_as_an_exit() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let script = dir.path().join("die.sh");
        std::fs::write(&script, "#!/bin/sh\nkill -9 $$\n").expect("write script");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut child = RealSpawner.spawn(&script, vec![]).expect("spawn");

        assert_eq!(
            wait_for_exit(&mut child, std::time::Duration::from_secs(10)),
            Some(137),
        );
    }
}
