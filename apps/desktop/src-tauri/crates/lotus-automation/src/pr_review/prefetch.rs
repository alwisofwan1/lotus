//! Fetching a PR's head commit into its checkout before the review agent starts. Reviews of
//! different PRs run side by side in the same folder, and two `git fetch`es into one repository
//! at once can fail on its ref locks. Lotus fetches one at a time per checkout, so the agent finds
//! the commit there and need not fetch. Best effort: when it fails the agent fetches as before.
//!
//! With a worktree root (ADR-0052 §2) the review then gets its own worktree of that checkout at the
//! PR's head: the user's checkout is never the agent's folder, and the worktree is gone when the run
//! ends, however it ends.

use crate::no_window::NoWindow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use super::{repo_from_remote_url, PrRef};

/// How long one `git fetch` may take before it is given up.
const FETCH_TIMEOUT: Duration = Duration::from_secs(90);
/// Tries per fetch: a lock taken by a `git` outside Lotus is usually gone in a second.
const ATTEMPTS: u32 = 3;
/// How long `git worktree add` may take: a checkout of a big repository writes many files.
const WORKTREE_TIMEOUT: Duration = Duration::from_secs(120);

pub struct Prefetch {
    /// The user's login environment, so `git` finds their credentials as in a terminal.
    env: HashMap<String, String>,
    checkouts: Mutex<HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>>,
    /// Where review worktrees live; `None`: reviews run in the checkout itself.
    worktrees: Option<PathBuf>,
}

impl Prefetch {
    pub fn new(env: HashMap<String, String>) -> Self {
        Self { env, checkouts: Mutex::new(HashMap::new()), worktrees: None }
    }

    /// Gives each review its own worktree under `root` (see [`Prefetch::worktree`]).
    pub fn with_worktrees(self, root: PathBuf) -> Self {
        Self { worktrees: Some(root), ..self }
    }

    /// The folder `pr`'s reviews run in, the same for every round: `--resume` finds a
    /// conversation only from the folder it started in. `None` without a worktree root.
    pub fn worktree_path(&self, pr: &PrRef) -> Option<PathBuf> {
        let slug: String = pr.repo.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' { c } else { '-' }).collect();
        self.worktrees.as_ref().map(|root| root.join(format!("{slug}-{}", pr.number)))
    }

    /// A worktree of `pr`'s checkout (found as [`Prefetch::commit`] finds it) at `sha`, at
    /// [`Prefetch::worktree_path`]. A leftover folder there is replaced. `None` without a worktree
    /// root, a checkout, or the commit; the caller then runs in the checkout as before. Dropping
    /// the returned guard removes the worktree.
    pub async fn worktree(&self, folder: &Path, pr: &PrRef, sha: &str) -> Option<Worktree> {
        let path = self.worktree_path(pr)?;
        let checkout = self.commit(folder, pr, sha).await?;
        let lock = self.lock(&checkout);
        let _one_at_a_time = lock.lock().await;
        // A run that crashed, or a resumed conversation's agent, may have left the folder behind.
        if path.exists() {
            remove_worktree(&self.env, &checkout, &path);
        }
        if let Some(parent) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("[automation] could not create {}: {e}", parent.display());
                return None;
            }
        }
        let target = path.to_string_lossy().into_owned();
        match self.git(&checkout, &["worktree", "add", "--detach", "--force", &target, sha], WORKTREE_TIMEOUT).await {
            Ok(_) => Some(Worktree { path, checkout, env: self.env.clone() }),
            Err(e) => {
                eprintln!("[automation] worktree of {}#{} at {}: {e}", pr.repo, pr.number, path.display());
                remove_worktree(&self.env, &checkout, &path);
                None
            }
        }
    }

    /// Removes every review worktree left under the root (a crash, a killed app) and prunes the
    /// checkouts they belonged to. Called once at start, before any review runs.
    pub fn sweep(&self) {
        let Some(root) = &self.worktrees else { return };
        let Ok(entries) = std::fs::read_dir(root) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            match owning_checkout(&path) {
                Some(checkout) => remove_worktree(&self.env, &checkout, &path),
                None => {
                    let _ = std::fs::remove_dir_all(&path);
                }
            }
        }
    }

    /// How many review worktrees exist now, and their size in bytes.
    pub fn worktree_usage(&self) -> (usize, u64) {
        let Some(Ok(entries)) = self.worktrees.as_ref().map(std::fs::read_dir) else { return (0, 0) };
        let dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        (dirs.len(), dirs.iter().map(|d| size_of(d)).sum())
    }

    /// The checkout of `pr`'s repository at or directly inside `folder`, once it holds `sha`.
    /// `None` when there is no such checkout or the commit could not be fetched.
    pub async fn commit(&self, folder: &Path, pr: &PrRef, sha: &str) -> Option<PathBuf> {
        let dir = self.checkout(folder, &pr.repo).await?;
        let lock = self.lock(&dir);
        let _one_at_a_time = lock.lock().await;
        if self.has(&dir, sha).await {
            return Some(dir);
        }
        let refspec = format!("pull/{}/head", pr.number);
        for attempt in 1..=ATTEMPTS {
            match self.git(&dir, &["fetch", "--no-tags", "--quiet", "origin", &refspec], FETCH_TIMEOUT).await {
                Ok(_) if self.has(&dir, sha).await => return Some(dir),
                // Fetched, yet not there: the PR moved on. Fetching again changes nothing.
                Ok(_) => return None,
                Err(e) => {
                    eprintln!("[automation] fetching {}#{} into {} (try {attempt}): {e}", pr.repo, pr.number, dir.display());
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
        None
    }

    /// The PR's diff as GitHub shows it (`git diff <base>...<head>`), taken from `checkout` (a
    /// review worktree's, or the pane's): GitHub's `.diff` refuses a PR over 20 000 lines or 300
    /// files (HTTP 406, ADR-0052 §1). Fetches the base branch first when `base_sha` is not there yet.
    pub async fn local_diff(&self, checkout: &Path, base_ref: &str, base_sha: &str, head_sha: &str) -> Result<String, String> {
        if base_sha.is_empty() {
            return Err("GitHub did not say which commit the pull request is based on".into());
        }
        {
            let lock = self.lock(checkout);
            let _one_at_a_time = lock.lock().await;
            if !self.has(checkout, base_sha).await {
                let branch = format!("refs/heads/{base_ref}");
                let mut tried = Vec::new();
                for refspec in [branch.as_str(), base_sha] {
                    if refspec.ends_with('/') {
                        continue;
                    }
                    match self.git(checkout, &["fetch", "--no-tags", "--quiet", "origin", refspec], FETCH_TIMEOUT).await {
                        Ok(_) if self.has(checkout, base_sha).await => break,
                        Ok(_) => tried.push(format!("{refspec}: fetched, base commit still missing")),
                        Err(e) => tried.push(format!("{refspec}: {e}")),
                    }
                }
                if !self.has(checkout, base_sha).await {
                    return Err(format!("could not fetch the base commit {base_sha} ({})", tried.join("; ")));
                }
            }
        }
        self.range_diff(checkout, base_sha, head_sha).await
    }

    /// A re-review's changes since the last reviewed head (`git diff <since>...<head>`, as GitHub's
    /// compare shows them), taken from `checkout` instead of GitHub's `.diff`, which refuses big
    /// ranges too. Fetches `since` by its sha when the checkout lacks it; `Err` when it still lacks
    /// it (a force-push may have dropped it): the caller then asks GitHub.
    pub async fn since_diff(&self, checkout: &Path, since_sha: &str, head_sha: &str) -> Result<String, String> {
        {
            let lock = self.lock(checkout);
            let _one_at_a_time = lock.lock().await;
            if !self.has(checkout, since_sha).await {
                let fetched = self.git(checkout, &["fetch", "--no-tags", "--quiet", "origin", since_sha], FETCH_TIMEOUT).await;
                if !self.has(checkout, since_sha).await {
                    let why = fetched.err().unwrap_or_else(|| "fetched, commit still missing".into());
                    return Err(format!("could not fetch the last reviewed commit {since_sha} ({why})"));
                }
            }
        }
        self.range_diff(checkout, since_sha, head_sha).await
    }

    async fn range_diff(&self, checkout: &Path, from: &str, head_sha: &str) -> Result<String, String> {
        let range = format!("{from}...{head_sha}");
        self.git(checkout, &["diff", "--no-color", "--no-ext-diff", "--find-renames", &range], WORKTREE_TIMEOUT)
            .await
            .map_err(|e| format!("git diff {range}: {e}"))
    }

    async fn checkout(&self, folder: &Path, repo: &str) -> Option<PathBuf> {
        let mut candidates = vec![folder.to_path_buf()];
        candidates.extend(crate::checkout::git_subfolders(folder));
        for dir in candidates {
            if !dir.join(".git").exists() {
                continue;
            }
            // The URL as configured, not as `insteadOf` rewrites it.
            let Ok(url) = self.git(&dir, &["config", "--get", "remote.origin.url"], Duration::from_secs(10)).await else { continue };
            if repo_from_remote_url(&url).is_some_and(|r| r.eq_ignore_ascii_case(repo)) {
                return Some(dir);
            }
        }
        None
    }

    async fn has(&self, dir: &Path, sha: &str) -> bool {
        self.git(dir, &["cat-file", "-e", &format!("{sha}^{{commit}}")], Duration::from_secs(10)).await.is_ok()
    }

    fn lock(&self, dir: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut checkouts = self.checkouts.lock().unwrap_or_else(|p| p.into_inner());
        checkouts.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = checkouts.get(dir).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        checkouts.insert(dir.to_path_buf(), Arc::downgrade(&lock));
        lock
    }

    async fn git(&self, dir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
        let run = tokio::process::Command::new("git")
            .no_window()
            .arg("-C")
            .arg(dir)
            .args(args)
            .env_clear()
            .envs(&self.env)
            // Never wait on a password prompt nobody sees.
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output();
        let out = tokio::time::timeout(timeout, run)
            .await
            .map_err(|_| format!("git {} timed out", args[0]))?
            .map_err(|e| format!("could not run git: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }
}

/// A review's worktree; removed (and its checkout pruned) when dropped, so every way a run ends —
/// a reply, an error, a timeout, a cancelled future — leaves nothing on disk.
#[derive(Debug)]
pub struct Worktree {
    path: PathBuf,
    checkout: PathBuf,
    env: HashMap<String, String>,
}

impl Worktree {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The checkout the worktree belongs to: where its objects live.
    pub fn checkout(&self) -> &Path {
        &self.checkout
    }
}

impl Drop for Worktree {
    fn drop(&mut self) {
        remove_worktree(&self.env, &self.checkout, &self.path);
    }
}

/// Removes the worktree at `path` of `checkout`, then the folder if git left it, then prunes the
/// checkout's record of it. Blocking: it runs in [`Drop`] and at start, and takes milliseconds.
fn remove_worktree(env: &HashMap<String, String>, checkout: &Path, path: &Path) {
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .no_window()
            .arg("-C")
            .arg(checkout)
            .args(args)
            .env_clear()
            .envs(env)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::null())
            .output()
    };
    let target = path.to_string_lossy().into_owned();
    let _ = git(&["worktree", "remove", "--force", "--force", &target]);
    if path.exists() {
        if let Err(e) = std::fs::remove_dir_all(path) {
            eprintln!("[automation] could not remove the review worktree {}: {e}", path.display());
        }
    }
    let _ = git(&["worktree", "prune"]);
}

/// The checkout a worktree folder belongs to, from its `.git` file
/// (`gitdir: <checkout>/.git/worktrees/<name>`).
fn owning_checkout(worktree: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(worktree.join(".git")).ok()?;
    let gitdir = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
    // <checkout>/.git/worktrees/<name> → <checkout>
    Some(gitdir.parent()?.parent()?.parent()?.to_path_buf())
}

fn size_of(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path).map_or(0, |entries| entries.flatten().map(|e| size_of(&e.path())).sum())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// An origin with a commit on `refs/pull/<n>/head` for each of `prs`, and a checkout of it whose
    /// remote reads as github.com/acme/app (rewritten to the local origin by `insteadOf`).
    /// Returns (tempdir, checkout, head sha per PR).
    fn world(prs: &[u64]) -> (tempfile::TempDir, PathBuf, Vec<String>) {
        let tmp = tempfile::tempdir().unwrap();
        let origin = tmp.path().join("origin");
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "-b", "main"]);
        git(&origin, &["config", "user.email", "t@t"]);
        git(&origin, &["config", "user.name", "t"]);
        std::fs::write(origin.join("a.txt"), "base\n").unwrap();
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", "base"]);
        let mut heads = Vec::new();
        for n in prs {
            git(&origin, &["checkout", "-q", "-b", &format!("pr{n}"), "main"]);
            std::fs::write(origin.join("a.txt"), format!("pr {n}\n")).unwrap();
            git(&origin, &["commit", "-qam", &format!("pr {n}")]);
            let sha = git(&origin, &["rev-parse", "HEAD"]);
            git(&origin, &["update-ref", &format!("refs/pull/{n}/head"), &sha]);
            heads.push(sha);
        }
        git(&origin, &["checkout", "-q", "main"]);
        let checkout = tmp.path().join("checkout");
        git(tmp.path(), &["clone", "-q", "--single-branch", "-b", "main", origin.to_str().unwrap(), "checkout"]);
        git(&checkout, &["remote", "set-url", "origin", "https://github.com/acme/app.git"]);
        git(&checkout, &["config", &format!("url.{}.insteadOf", origin.display()), "https://github.com/acme/app.git"]);
        (tmp, checkout, heads)
    }

    fn prefetch(tmp: &Path) -> Prefetch {
        let env: HashMap<String, String> = std::env::vars().collect();
        Prefetch::new(env).with_worktrees(tmp.join("review-worktrees"))
    }

    fn pr(n: u64) -> PrRef {
        PrRef { repo: "acme/app".into(), number: n }
    }

    fn listed(checkout: &Path) -> usize {
        git(checkout, &["worktree", "list", "--porcelain"]).lines().filter(|l| l.starts_with("worktree ")).count()
    }

    #[tokio::test]
    async fn the_diff_is_taken_locally_against_the_base_even_when_the_base_moved_on() {
        let (tmp, checkout, heads) = world(&[7]);
        let origin = tmp.path().join("origin");
        let base = git(&origin, &["rev-parse", "main"]);
        // The base branch gets a commit the checkout has not seen: three dots ignore it, as GitHub does.
        std::fs::write(origin.join("b.txt"), "later\n").unwrap();
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", "later on main"]);
        let later = git(&origin, &["rev-parse", "main"]);
        let prefetch = prefetch(tmp.path());
        let worktree = prefetch.worktree(&checkout, &pr(7), &heads[0]).await.expect("worktree");

        let diff = prefetch.local_diff(worktree.checkout(), "main", &later, &heads[0]).await.unwrap();
        assert!(diff.contains("+pr 7") && diff.contains("-base"), "{diff}");
        assert!(!diff.contains("b.txt"), "the base's own later commit is not the PR's change: {diff}");
        assert_eq!(prefetch.local_diff(worktree.checkout(), "main", &base, &heads[0]).await.unwrap(), diff);

        let missing = prefetch.local_diff(worktree.checkout(), "nope", "0123456789012345678901234567890123456789", &heads[0]).await;
        assert!(missing.unwrap_err().contains("could not fetch the base commit"));
    }

    /// GitHub's `.diff` refuses a PR this big (HTTP 406, over 20 000 lines); git has no such limit.
    #[tokio::test]
    async fn a_sixteen_thousand_line_pr_gets_its_whole_diff_locally() {
        let (tmp, checkout, _) = world(&[]);
        let origin = tmp.path().join("origin");
        let base = git(&origin, &["rev-parse", "main"]);
        git(&origin, &["checkout", "-q", "-b", "big", "main"]);
        let body: String = (0..400).map(|i| format!("line {i}\n")).collect();
        for f in 0..40 {
            std::fs::write(origin.join(format!("f{f}.txt")), &body).unwrap();
        }
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", "big"]);
        let head = git(&origin, &["rev-parse", "HEAD"]);
        git(&origin, &["update-ref", "refs/pull/9/head", &head]);
        let prefetch = prefetch(tmp.path());
        let worktree = prefetch.worktree(&checkout, &pr(9), &head).await.expect("worktree");

        let diff = super::super::Diff::parse(&prefetch.local_diff(worktree.checkout(), "main", &base, &head).await.unwrap());
        assert_eq!(diff.changed_lines(), 16_000);
        assert_eq!(diff.files().len(), 40);
    }

    /// A re-review of a 20 000+ line push: GitHub's compare `.diff` refuses it (HTTP 406), git does not.
    #[tokio::test]
    async fn a_rereview_of_a_huge_push_takes_its_since_diff_locally() {
        let (tmp, checkout, heads) = world(&[9]);
        let origin = tmp.path().join("origin");
        let since = heads[0].clone();
        git(&origin, &["checkout", "-q", "--detach", &since]);
        let body: String = (0..500).map(|i| format!("line {i}\n")).collect();
        for f in 0..42 {
            std::fs::write(origin.join(format!("big{f}.txt")), &body).unwrap();
        }
        git(&origin, &["add", "."]);
        git(&origin, &["commit", "-qm", "huge push"]);
        let head = git(&origin, &["rev-parse", "HEAD"]);
        git(&origin, &["update-ref", "refs/pull/9/head", &head]);
        let prefetch = prefetch(tmp.path());
        // The checkout has neither commit yet: the head comes with the PR, the last reviewed one by its sha.
        let dir = prefetch.commit(&checkout, &pr(9), &head).await.expect("the head is fetched");

        let diff = super::super::Diff::parse(&prefetch.since_diff(&dir, &since, &head).await.unwrap());
        assert_eq!(diff.changed_lines(), 21_000);
        assert_eq!(diff.files().len(), 42, "only what changed since the last review");

        // Gone from the history (a force-push): the caller asks GitHub instead.
        let gone = prefetch.since_diff(&dir, "0123456789012345678901234567890123456789", &head).await;
        assert!(gone.unwrap_err().contains("could not fetch the last reviewed commit"));
    }

    #[tokio::test]
    async fn a_review_worktree_sits_at_the_head_and_is_gone_after() {
        let (tmp, checkout, heads) = world(&[7]);
        let prefetch = prefetch(tmp.path());
        let tree = prefetch.worktree(&checkout, &pr(7), &heads[0]).await.expect("a worktree");
        assert_eq!(tree.path(), prefetch.worktree_path(&pr(7)).unwrap());
        assert_eq!(git(tree.path(), &["rev-parse", "HEAD"]), heads[0]);
        assert_eq!(std::fs::read_to_string(tree.path().join("a.txt")).unwrap(), "pr 7\n");
        // The user's checkout is untouched.
        assert_eq!(std::fs::read_to_string(checkout.join("a.txt")).unwrap(), "base\n");
        assert_eq!(prefetch.worktree_usage().0, 1);
        let path = tree.path().to_path_buf();
        drop(tree);
        assert!(!path.exists());
        assert_eq!(listed(&checkout), 1, "only the checkout itself is left");
        assert_eq!(prefetch.worktree_usage(), (0, 0));
    }

    #[tokio::test]
    async fn a_run_that_fails_or_times_out_leaves_nothing() {
        let (tmp, checkout, heads) = world(&[7]);
        let prefetch = prefetch(tmp.path());
        let path = prefetch.worktree_path(&pr(7)).unwrap();
        let failing = async {
            let _tree = prefetch.worktree(&checkout, &pr(7), &heads[0]).await.expect("a worktree");
            Err::<(), &str>("the review agent failed")
        };
        assert!(failing.await.is_err());
        assert!(!path.exists());
        let hanging = async {
            let _tree = prefetch.worktree(&checkout, &pr(7), &heads[0]).await.expect("a worktree");
            std::future::pending::<()>().await;
        };
        assert!(tokio::time::timeout(Duration::from_secs(5), hanging).await.is_err());
        assert!(!path.exists());
        assert_eq!(listed(&checkout), 1);
    }

    #[tokio::test]
    async fn a_later_round_gets_the_same_folder_even_over_a_leftover() {
        let (tmp, checkout, heads) = world(&[7]);
        let prefetch = prefetch(tmp.path());
        let first = prefetch.worktree(&checkout, &pr(7), &heads[0]).await.unwrap().path().to_path_buf();
        // A resumed conversation's agent recreates its folder empty; a crash leaves a whole worktree.
        std::fs::create_dir_all(&first).unwrap();
        std::fs::write(first.join("stray.txt"), "x").unwrap();
        let again = prefetch.worktree(&checkout, &pr(7), &heads[0]).await.expect("replaces the leftover");
        assert_eq!(again.path(), first);
        assert!(!again.path().join("stray.txt").exists());
        assert_eq!(git(again.path(), &["rev-parse", "HEAD"]), heads[0]);
    }

    #[tokio::test]
    async fn start_sweeps_leftover_worktrees_and_prunes_their_checkout() {
        let (tmp, checkout, heads) = world(&[7]);
        let prefetch = prefetch(tmp.path());
        let tree = prefetch.worktree(&checkout, &pr(7), &heads[0]).await.unwrap();
        let path = tree.path().to_path_buf();
        std::mem::forget(tree); // as if the app died mid-run
        std::fs::create_dir_all(tmp.path().join("review-worktrees/not-a-worktree")).unwrap();
        assert_eq!(listed(&checkout), 2);
        prefetch.sweep();
        assert!(!path.exists());
        assert_eq!(prefetch.worktree_usage(), (0, 0));
        assert_eq!(listed(&checkout), 1);
    }

    #[tokio::test]
    async fn two_prs_of_one_repository_get_worktrees_side_by_side() {
        let (tmp, checkout, heads) = world(&[7, 8]);
        let prefetch = prefetch(tmp.path());
        let (seven, eight) = (pr(7), pr(8));
        let (a, b) = tokio::join!(prefetch.worktree(&checkout, &seven, &heads[0]), prefetch.worktree(&checkout, &eight, &heads[1]));
        let (a, b) = (a.expect("pr 7"), b.expect("pr 8"));
        assert_ne!(a.path(), b.path());
        assert_eq!(std::fs::read_to_string(a.path().join("a.txt")).unwrap(), "pr 7\n");
        assert_eq!(std::fs::read_to_string(b.path().join("a.txt")).unwrap(), "pr 8\n");
        drop((a, b));
        assert_eq!(listed(&checkout), 1);
    }

    #[tokio::test]
    async fn no_root_means_no_worktree() {
        let (_tmp, checkout, heads) = world(&[7]);
        let plain = Prefetch::new(std::env::vars().collect());
        assert!(plain.worktree_path(&pr(7)).is_none());
        assert!(plain.worktree(&checkout, &pr(7), &heads[0]).await.is_none());
    }
}
