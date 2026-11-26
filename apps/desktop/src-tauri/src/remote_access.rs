//! Cloudflare Access: is this machine signed in, and if not, open the login.
//!
//! **Why a machine needs this at all.** A host reached through
//! `ProxyCommand ... cloudflared access ssh --hostname %h` is not gated by an SSH key but by a
//! browser sign-in, and the session expires. When it has, `ssh` does not say so — it hangs and then
//! times out, which is indistinguishable from a dead machine (measured 2026-09-15: the folder picker
//! reported "did not create control socket within 8 s" for a host that was perfectly healthy).
//!
//! Asking `cloudflared` directly turns that guess into a fact, and the fact into a button.

use crate::no_window::NoWindow;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::collections::HashMap;
use std::sync::{mpsc, Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{other, AppError};

/// Where `cloudflared` may live. PATH first, then the two places Homebrew puts it — a GUI app does
/// not inherit a login shell's PATH, so "it works in my terminal" is not evidence it is findable
/// from here.
const CANDIDATES: &[&str] = &[
    "cloudflared",
    "/usr/local/bin/cloudflared",
    "/opt/homebrew/bin/cloudflared",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessState {
    /// A token exists — the machine is reachable as far as Access is concerned.
    SignedIn,
    /// No token. This is the one case with an obvious next step.
    NeedsLogin,
    /// `cloudflared` is not installed, so we cannot tell and must not pretend.
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    pub state: AccessState,
    /// The application asked about, echoed back so a caller can key results by it.
    pub hostname: String,
}

fn cloudflared_bin() -> Option<PathBuf> {
    for candidate in CANDIDATES {
        let path = PathBuf::from(candidate);
        if candidate.contains('/') {
            if path.exists() {
                return Some(path);
            }
            continue;
        }
        // A bare name: let the OS resolve it, but prove it runs rather than assuming PATH has it.
        if Command::new(candidate)
            .no_window()
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            return Some(path);
        }
    }
    None
}

/// Whether a Cloudflare Access token exists for `hostname`.
///
/// `cloudflared access token --app <hostname>` exits 0 with the token and exits non-zero with
/// "Unable to find token … Please run login command" when there is none — verified on this machine
/// 2026-09-15. It also exits non-zero when Cloudflare cannot be reached, so the failure text is
/// matched only to tell those two apart; see `state_from`.
pub fn access_status(hostname: &str) -> AccessStatus {
    let name = hostname.trim().to_string();
    let Some(bin) = cloudflared_bin() else {
        return AccessStatus {
            state: AccessState::Unavailable,
            hostname: name,
        };
    };

    let state = match Command::new(bin)
        .no_window()
        .args(["access", "token", "--app", &name])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
    {
        Ok(out) => state_from(out.status.success(), &String::from_utf8_lossy(&out.stderr)),
        Err(_) => AccessState::Unavailable,
    };

    AccessStatus {
        state,
        hostname: name,
    }
}

/// Exit 0 is signed in. A failure is "needs login" only when cloudflared says the token is missing.
///
/// The check first asks Cloudflare for the app's details, so a dropped network fails too, with
/// "failed to get app info: … tls/dial …" (seen 2026-11-24). Reading that as an expired sign-in
/// would make every ssh to the machine refuse on a Wi-Fi blip. A reworded message falls to
/// `Unavailable`, which lets ssh try as before rather than blocking it.
fn state_from(success: bool, stderr: &str) -> AccessState {
    if success {
        AccessState::SignedIn
    } else if stderr.contains("Unable to find token") {
        AccessState::NeedsLogin
    } else {
        AccessState::Unavailable
    }
}

/// How long to wait for `cloudflared` to print the sign-in URL.
///
/// It prints within a second in practice; the cap exists so a wedged binary cannot hold a worker
/// thread. Missing the URL is not a failure — the browser may already be open — so the caller gets
/// `None` and shows its fallback rather than an error.
const URL_WAIT: Duration = Duration::from_secs(8);

/// Start the Access sign-in for `hostname`, returning the URL it opened when it says one.
///
/// **Two things here were learned the hard way, both on 2026-09-15.**
///
/// 1. `cloudflared access login` takes a **URL**, not a hostname. Given a bare hostname it neither
///    opens a browser nor prints anything — it simply hangs, which from the operator's side looks
///    exactly like a button that does nothing. Three such processes were found alive after the
///    first attempt: the spawn had always worked; the argument was wrong.
/// 2. It launches the browser itself and offers no flag to suppress that, so this does not open a
///    second one. What it does do is capture the URL cloudflared prints, so the panel can offer it
///    when the automatic open fails — which is precisely the fallback cloudflared's own message
///    describes.
///
/// The child is left running on purpose: it holds the callback that receives the token, and it only
/// exits once the browser round trip completes.
///
/// **One login per application at a time.** Each click used to start another `cloudflared access
/// login`, each opening a tab and each waiting on its own callback forever; only the one whose tab
/// was used ever finished. While one is still waiting, a new request starts nothing and answers
/// [`Login::Pending`] with that login's URL, so the caller can show the same tab again.
pub fn access_login(hostname: &str) -> Result<Login, AppError> {
    let name = hostname.trim();
    if name.is_empty() {
        return Err(other("No Cloudflare Access application to sign in to."));
    }
    let key = access_url(name);
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(login) = pending.get(&key) {
        if login.started.elapsed() < LOGIN_MAX_AGE {
            return Ok(Login::Pending(login.url.lock().unwrap_or_else(|e| e.into_inner()).clone()));
        }
        // Its URL has likely expired: a stuck login must not block every later one.
        login.stop();
        pending.remove(&key);
    }
    let Some(bin) = cloudflared_bin() else {
        return Err(other(
            "cloudflared is not installed, so this machine's sign-in cannot be opened from here.",
        ));
    };

    let mut child = Command::new(bin)
        .no_window()
        .args(["access", "login", "--quiet", &key])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(AppError::Io)?;

    let Some(stdout) = child.stdout.take() else {
        return Ok(Login::Started(None));
    };

    let login = Arc::new(PendingLogin { url: Mutex::new(None), started: Instant::now(), pid: child.id() });
    pending.insert(key.clone(), Arc::clone(&login));
    drop(pending);

    let (tx, rx) = mpsc::channel::<String>();
    let mine = Arc::clone(&login);
    std::thread::spawn(move || {
        let mut url_sender = Some(tx);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(url) = line
                .split_whitespace()
                .find(|word| word.starts_with("https://"))
            {
                if let Some(sender) = url_sender.take() {
                    *mine.url.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.to_string());
                    let _ = sender.send(url.to_string());
                }
            }
            // Keep draining, including the final token output. Closing the pipe after the URL
            // can give cloudflared a broken pipe while it is completing the browser callback.
        }
        let _ = child.wait();
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if pending.get(&key).is_some_and(|entry| Arc::ptr_eq(entry, &mine)) {
            pending.remove(&key);
        }
    });

    Ok(Login::Started(rx.recv_timeout(URL_WAIT).ok()))
}

/// What a sign-in request did. Either way the URL is the one cloudflared printed, when it did.
#[derive(Debug, PartialEq, Eq)]
pub enum Login {
    /// A new `cloudflared access login` started; it opens the browser itself.
    Started(Option<String>),
    /// One was already waiting for its browser round trip; nothing new was started.
    Pending(Option<String>),
}

struct PendingLogin {
    url: Mutex<Option<String>>,
    started: Instant,
    pid: u32,
}

impl PendingLogin {
    /// SIGTERM, not SIGKILL, so cloudflared gets the chance to clean up its token lock.
    fn stop(&self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(self.pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

/// How long a waiting login is reused. Matches the folder picker's wait for the token.
const LOGIN_MAX_AGE: Duration = Duration::from_secs(5 * 60);

/// Logins still waiting on their browser callback, by Access URL.
static PENDING: LazyLock<Mutex<HashMap<String, Arc<PendingLogin>>>> = LazyLock::new(Default::default);

/// `cloudflared access login` needs a URL; operators, `~/.ssh/config`, and our own token lookup all
/// speak bare hostnames. One place converts.
pub(crate) fn access_url(hostname: &str) -> String {
    let trimmed = hostname.trim().trim_end_matches('/');
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bare_hostname_becomes_the_url_the_login_subcommand_requires() {
        assert_eq!(
            access_url("ssh-alwi.example-vps.com"),
            "https://ssh-alwi.example-vps.com"
        );
        assert_eq!(access_url("  vps.example.com/ "), "https://vps.example.com");
    }

    #[test]
    fn a_url_that_is_already_a_url_is_left_alone() {
        assert_eq!(
            access_url("https://vps.example.com"),
            "https://vps.example.com"
        );
        assert_eq!(
            access_url("http://vps.example.com"),
            "http://vps.example.com"
        );
    }

    #[test]
    fn only_a_missing_token_reads_as_needing_a_sign_in() {
        assert_eq!(state_from(true, ""), AccessState::SignedIn);
        assert_eq!(
            state_from(false, "Unable to find token for provided application. Please run login command to generate token."),
            AccessState::NeedsLogin
        );
        assert_eq!(
            state_from(false, "failed to get app info: Head \"https://vps.example.com\": tls: failed to verify certificate"),
            AccessState::Unavailable
        );
        assert_eq!(state_from(false, "dial tcp: lookup vps.example.com: no such host"), AccessState::Unavailable);
    }

    #[test]
    fn an_empty_application_is_refused_before_anything_is_spawned() {
        assert!(access_login("   ").is_err());
    }

    #[test]
    fn a_status_always_names_the_application_it_answered_about() {
        let status = access_status("  example.internal  ");
        assert_eq!(status.hostname, "example.internal");
    }

    /// Whatever the answer is, it must be one of the three — never a guess dressed as a fact.
    #[test]
    fn a_status_is_one_of_the_three_states() {
        let status = access_status("definitely-not-an-access-app.invalid");
        assert!(matches!(
            status.state,
            AccessState::SignedIn | AccessState::NeedsLogin | AccessState::Unavailable
        ));
    }

    #[cfg(unix)]
    #[test]
    fn login_keeps_stdout_open_until_the_callback_process_finishes() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("cloudflared");
        let completed = dir.path().join("completed");
        std::fs::write(&bin, format!(
            "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\nprintf 'https://example.com/login\\n'\n/bin/sleep 0.2\nprintf 'private-token-output\\n' || exit 1\n/usr/bin/touch '{}'\n", completed.display()
        )).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let original = std::env::var_os("PATH");
        std::env::set_var("PATH", dir.path());
        let result = access_login("example.com");
        match original {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }
        assert_eq!(result.unwrap(), Login::Started(Some("https://example.com/login".into())));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !completed.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            completed.exists(),
            "login child lost its stdout before completing the callback"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_second_sign_in_reuses_the_login_still_waiting_instead_of_starting_another() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Instant;
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let (bin, spawns, release) = (dir.path().join("cloudflared"), dir.path().join("spawns"), dir.path().join("release"));
        // Like the real one: prints the URL, then waits for the browser (here: the release file).
        // Only `access login` is counted: PATH is process-wide, so the token checks other tests run
        // in parallel land here too. It also gives up once the temp dir is gone: a release file
        // written just before the dir is dropped can be missed, and the loop then outlived every
        // run as an orphan (45 of them from 40 parallel runs).
        std::fs::write(&bin, format!(
            "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\n[ \"$2\" = login ] || exit 1\necho x >> '{}'\nprintf 'https://reuse.example/login\\n'\nwhile [ ! -e '{}' ]; do [ -d '{}' ] || exit 1; /bin/sleep 0.05; done\n",
            spawns.display(), release.display(), dir.path().display()
        )).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let original = std::env::var_os("PATH");
        std::env::set_var("PATH", dir.path());
        let spawned = || std::fs::read_to_string(&spawns).map(|s| s.lines().count()).unwrap_or(0);
        let url = Some("https://reuse.example/login".to_string());

        let first = access_login("reuse.example").unwrap();
        let second = access_login("  reuse.example ").unwrap();
        let spawned_while_waiting = spawned();
        std::fs::write(&release, "").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while PENDING.lock().unwrap().contains_key("https://reuse.example") && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        std::fs::remove_file(&release).unwrap();
        let third = access_login("reuse.example").unwrap();
        let spawned_after = spawned();
        std::fs::write(&release, "").unwrap();
        // Let the third login end before the temp dir goes; stop it if it does not.
        let deadline = Instant::now() + Duration::from_secs(3);
        while PENDING.lock().unwrap().contains_key("https://reuse.example") && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        if let Some(login) = PENDING.lock().unwrap().remove("https://reuse.example") {
            login.stop();
        }
        match original {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }

        assert_eq!(first, Login::Started(url.clone()));
        assert_eq!(second, Login::Pending(url.clone()));
        assert_eq!(spawned_while_waiting, 1, "a second click started another cloudflared");
        assert_eq!(third, Login::Started(url), "a finished login must not block the next one");
        assert_eq!(spawned_after, 2);
    }

    #[cfg(unix)]
    #[test]
    fn a_login_waiting_past_its_max_age_is_stopped_and_replaced() {
        use std::os::unix::fs::PermissionsExt;
        let _lock = crate::paths::TEST_ENV_LOCK.lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("cloudflared");
        std::fs::write(&bin, "#!/bin/sh\n[ \"$1\" = --version ] && exit 0\n[ \"$2\" = login ] || exit 1\nprintf 'https://stale.example/new\\n'\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        // The stuck login: a live process that would wait forever.
        let mut stuck = Command::new("/bin/sleep").arg("60").spawn().unwrap();
        let old = Arc::new(PendingLogin {
            url: Mutex::new(Some("https://stale.example/old".into())),
            started: Instant::now() - LOGIN_MAX_AGE - Duration::from_secs(1),
            pid: stuck.id(),
        });
        PENDING.lock().unwrap().insert("https://stale.example".into(), old);
        let original = std::env::var_os("PATH");
        std::env::set_var("PATH", dir.path());
        let result = access_login("stale.example");
        match original {
            Some(path) => std::env::set_var("PATH", path),
            None => std::env::remove_var("PATH"),
        }

        assert_eq!(result.unwrap(), Login::Started(Some("https://stale.example/new".into())));
        let status = stuck.wait().unwrap();
        assert!(!status.success(), "the stuck login was not stopped");
    }
}
