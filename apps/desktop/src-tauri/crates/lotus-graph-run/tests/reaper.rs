//! F2a ac4: the reaper removes finished Factory worktrees and never removes on doubt.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use lotus_graph_run::factory::{
    branch_name, reap, reap_keeping, sidecar_path, worktree_path, DraftPr, PrState, PullRequests, Sidecar, SidecarRound,
    KEEP_UNPUSHED,
};
use lotus_graph_run::BoxFuture;

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).to_string()
}

struct Fixture {
    _tmp: tempfile::TempDir,
    checkout: PathBuf,
    origin: PathBuf,
    root: PathBuf,
}

fn fixture() -> Fixture {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let origin = base.join("origin.git");
    let checkout = base.join("checkout");
    let root = base.join("factory");
    std::fs::create_dir_all(&origin).unwrap();
    std::fs::create_dir_all(&checkout).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    git(&origin, &["init", "--bare", "-q", "-b", "main"]);
    git(&checkout, &["init", "-q", "-b", "main"]);
    git(&checkout, &["config", "user.email", "t@t"]);
    git(&checkout, &["config", "user.name", "t"]);
    std::fs::write(checkout.join("a.txt"), "a").unwrap();
    git(&checkout, &["add", "-A"]);
    git(&checkout, &["commit", "-q", "-m", "init"]);
    git(&checkout, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git(&checkout, &["push", "-q", "origin", "main"]);
    Fixture { _tmp: tmp, checkout, origin, root }
}

impl Fixture {
    /// A real worktree + sidecar for `run_id`; returns its branch.
    fn add_run(&self, run_id: &str, issue: u64) -> String {
        let branch = branch_name(issue, run_id);
        self.write_sidecar(run_id, &branch);
        let wt = worktree_path(&self.root, run_id);
        git(&self.checkout, &["worktree", "add", "-q", "-b", &branch, wt.to_str().unwrap(), "main"]);
        git(&self.checkout, &["push", "-q", "origin", &branch]);
        branch
    }

    /// A round of the PR that `original` opened: its own local branch, pushing to `pr_branch`.
    fn add_round(&self, run_id: &str, original: &str, round: u32, pr_branch: &str) -> String {
        let branch = branch_name(7, run_id);
        let wt = worktree_path(&self.root, run_id);
        git(&self.checkout, &["worktree", "add", "-q", "-b", &branch, wt.to_str().unwrap(), "main"]);
        let sc = Sidecar {
            graph_run_id: run_id.into(),
            repo: "o/r".into(),
            account: "acct".into(),
            checkout: self.checkout.clone(),
            branch: branch.clone(),
            attempts_done: 0,
            last_gate_output: None,
            worktree_ready: true,
            implement_started: true,
            revision: None,
            round: Some(SidecarRound { original: original.into(), round, pr_branch: pr_branch.into() }),
        };
        std::fs::write(sidecar_path(&self.root, run_id), serde_json::to_string(&sc).unwrap()).unwrap();
        branch
    }

    fn write_sidecar(&self, run_id: &str, branch: &str) {
        let sc = Sidecar {
            graph_run_id: run_id.into(),
            repo: "o/r".into(),
            account: "acct".into(),
            checkout: self.checkout.clone(),
            branch: branch.into(),
            attempts_done: 0,
            last_gate_output: None,
            worktree_ready: true,
            implement_started: false,
            revision: None,
            round: None,
        };
        std::fs::write(sidecar_path(&self.root, run_id), serde_json::to_string(&sc).unwrap()).unwrap();
    }

    fn branches(&self) -> String {
        git(&self.checkout, &["branch", "--list"])
    }

    fn remote_branches(&self) -> String {
        git(&self.origin, &["branch", "--list"])
    }
}

/// state per branch; a branch not listed errors.
struct FakePrs(HashMap<String, Result<PrState, String>>);

impl PullRequests for FakePrs {
    fn push_token(&self, _: &str) -> BoxFuture<Result<String, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn open_draft(&self, _: &str, _: DraftPr) -> BoxFuture<Result<String, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn state(&self, _: &str, _: &str, branch: &str) -> BoxFuture<Result<PrState, String>> {
        let r = self.0.get(branch).cloned().unwrap_or_else(|| Err("no answer".into()));
        Box::pin(async move { r })
    }
    fn issue_context(&self, _: &str, _: &str, _: u64) -> BoxFuture<Result<lotus_graph_run::factory::IssueContext, String>> {
        Box::pin(async { Err("unused".into()) })
    }
    fn prs_mentioning(&self, _: &str, _: &str, _: &str) -> BoxFuture<Result<Vec<lotus_graph_run::factory::LinkedPr>, String>> {
        Box::pin(async { Err("unused".into()) })
    }
}

fn prs(entries: &[(&str, Result<PrState, String>)]) -> FakePrs {
    FakePrs(entries.iter().map(|(b, s)| (b.to_string(), s.clone())).collect())
}

fn never_live(_: &str) -> bool {
    false
}

fn assert_removed(f: &Fixture, run_id: &str, branch: &str) {
    assert!(!worktree_path(&f.root, run_id).exists(), "worktree dir remains");
    assert!(!sidecar_path(&f.root, run_id).exists(), "sidecar remains");
    assert!(!f.branches().contains(branch), "local branch remains");
}

fn assert_kept(f: &Fixture, run_id: &str, branch: &str) {
    assert!(worktree_path(&f.root, run_id).exists(), "worktree dir gone");
    assert!(sidecar_path(&f.root, run_id).exists(), "sidecar gone");
    assert!(f.branches().contains(branch), "local branch gone");
}

#[tokio::test]
async fn ac4_merged_pr_removes_dir_local_branch_and_sidecar_but_not_remote() {
    let f = fixture();
    let b = f.add_run("run-merged-1", 7);
    let report = reap(&f.root, &prs(&[(&b, Ok(PrState::Merged))]), &never_live).await;
    assert_removed(&f, "run-merged-1", &b);
    assert!(f.remote_branches().contains(&b), "remote branch must stay");
    assert_eq!(report.removed, vec!["run-merged-1".to_string()]);
    assert!(report.kept.is_empty());
}

#[tokio::test]
async fn ac4_closed_pr_is_removed() {
    let f = fixture();
    let b = f.add_run("run-closed-1", 8);
    reap(&f.root, &prs(&[(&b, Ok(PrState::Closed))]), &never_live).await;
    assert_removed(&f, "run-closed-1", &b);
}

#[tokio::test]
async fn ac4_missing_pr_and_not_live_is_removed_once_kept_long_enough() {
    let f = fixture();
    let b = f.add_run("run-crash-1", 9);
    reap_keeping(&f.root, &prs(&[(&b, Ok(PrState::Missing))]), &never_live, std::time::Duration::ZERO).await;
    assert_removed(&f, "run-crash-1", &b);
}

/// Decision 3A (2026-10-06): a run that ended with no PR (a red Check, an abort) is never pushed,
/// so its worktree is the only copy of the agent's code. Kept for KEEP_UNPUSHED after it ended.
#[tokio::test]
async fn f2b_unpushed_run_is_kept_for_a_while_so_its_code_can_be_read() {
    let f = fixture();
    let b = f.add_run("run-red-1", 9);
    let report = reap(&f.root, &prs(&[(&b, Ok(PrState::Missing))]), &never_live).await;
    assert_eq!(report.kept, vec!["run-red-1".to_string()]);
    assert_kept(&f, "run-red-1", &b);
}

#[tokio::test]
async fn f2b_unpushed_run_older_than_the_keep_window_is_removed() {
    let f = fixture();
    let b = f.add_run("run-red-2", 9);
    let old = std::time::SystemTime::now() - KEEP_UNPUSHED - std::time::Duration::from_secs(3600);
    std::fs::File::options().write(true).open(sidecar_path(&f.root, "run-red-2")).unwrap().set_modified(old).unwrap();
    reap(&f.root, &prs(&[(&b, Ok(PrState::Missing))]), &never_live).await;
    assert_removed(&f, "run-red-2", &b);
}

#[tokio::test]
async fn f2b_merged_or_closed_pr_is_removed_at_once_whatever_its_age() {
    let f = fixture();
    let b = f.add_run("run-merged-2", 9);
    reap(&f.root, &prs(&[(&b, Ok(PrState::Merged))]), &never_live).await;
    assert_removed(&f, "run-merged-2", &b);
}

#[tokio::test]
async fn ac4_open_pr_is_kept() {
    let f = fixture();
    let b = f.add_run("run-open-1", 10);
    let report = reap(&f.root, &prs(&[(&b, Ok(PrState::Open))]), &never_live).await;
    assert_kept(&f, "run-open-1", &b);
    assert_eq!(report.kept, vec!["run-open-1".to_string()]);
}

#[tokio::test]
async fn ac4_live_run_is_kept_even_when_github_says_merged() {
    let f = fixture();
    let b = f.add_run("run-live-1", 11);
    reap(&f.root, &prs(&[(&b, Ok(PrState::Merged))]), &|id: &str| id == "run-live-1").await;
    assert_kept(&f, "run-live-1", &b);
}

#[tokio::test]
async fn ac4_sidecar_whose_dir_is_gone_is_pruned_and_deleted() {
    let f = fixture();
    let b = f.add_run("run-gone-1", 12);
    std::fs::remove_dir_all(worktree_path(&f.root, "run-gone-1")).unwrap();
    reap(&f.root, &prs(&[(&b, Ok(PrState::Open))]), &never_live).await;
    assert!(!sidecar_path(&f.root, "run-gone-1").exists());
    assert!(!git(&f.checkout, &["worktree", "list"]).contains("run-gone-1"), "worktree not pruned");
}

#[tokio::test]
async fn ac4_dir_without_sidecar_is_left_alone() {
    let f = fixture();
    let b = f.add_run("run-orphan-1", 13);
    std::fs::remove_file(sidecar_path(&f.root, "run-orphan-1")).unwrap();
    reap(&f.root, &prs(&[(&b, Ok(PrState::Merged))]), &never_live).await;
    assert!(worktree_path(&f.root, "run-orphan-1").exists());
    assert!(f.branches().contains(&b));
}

#[tokio::test]
async fn ac4_state_error_keeps_everything() {
    let f = fixture();
    let b = f.add_run("run-err-1", 14);
    let report = reap(&f.root, &prs(&[(&b, Err("rate limited".into()))]), &never_live).await;
    assert_kept(&f, "run-err-1", &b);
    assert_eq!(report.kept, vec!["run-err-1".to_string()]);
}

/// #147: the reaper is the one place that asks about a finished run's PR, so it reports how each
/// one ended, and the host writes that onto the run's record.
#[tokio::test]
async fn f147_the_report_says_which_prs_were_merged_or_closed() {
    let f = fixture();
    let merged = f.add_run("run-m", 1);
    let closed = f.add_run("run-c", 2);
    let open = f.add_run("run-o", 3);
    let report = reap(
        &f.root,
        &prs(&[(&merged, Ok(PrState::Merged)), (&closed, Ok(PrState::Closed)), (&open, Ok(PrState::Open))]),
        &never_live,
    )
    .await;
    assert_eq!(
        report.ended_prs,
        vec![("run-c".to_string(), lotus_graph_run::PrOutcome::Closed), ("run-m".to_string(), lotus_graph_run::PrOutcome::Merged)]
    );
}

#[test]
fn f147_the_outcome_is_written_once_onto_the_record() {
    use lotus_graph_run::factory::record_pr_outcome;
    use lotus_graph_run::{GraphRunRecord, MemoryRunStore, PrOutcome, RunStore};
    let raw = r#"{"id":"r1","projectId":"p","status":"completed","checkpoint":{"nodeIds":["factory"],"deps":[],"completed":{},"failed":[],"pending":[],"blocked":[],"engine":{"kind":"rust"}},"startedAt":1,"endedAt":2,"updatedAt":2}"#;
    let record: GraphRunRecord = serde_json::from_str(raw).unwrap();
    let store = MemoryRunStore::new();
    store.save(&record).unwrap();

    let changed = record_pr_outcome(&store, "r1", PrOutcome::Merged).unwrap();
    assert_eq!(changed.and_then(|r| r.checkpoint.engine).and_then(|e| e.pr), Some(PrOutcome::Merged));
    assert_eq!(store.get("r1").unwrap().unwrap().checkpoint.engine.unwrap().pr, Some(PrOutcome::Merged));
    // Already said: nothing to tell the screen.
    assert!(record_pr_outcome(&store, "r1", PrOutcome::Merged).unwrap().is_none());
    assert!(record_pr_outcome(&store, "gone", PrOutcome::Closed).unwrap().is_none());

    let json = serde_json::to_string(&store.get("r1").unwrap().unwrap()).unwrap();
    assert!(json.contains(r#""pr":"merged""#), "{json}");
}

#[tokio::test]
async fn cos6_while_the_pr_is_open_only_its_newest_rounds_worktree_is_kept() {
    let f = fixture();
    let pr = f.add_run("run-first", 7);
    let one = f.add_round("r1-round", "run-first", 1, &pr);
    let two = f.add_round("r2-round", "run-first", 2, &pr);
    // Only the PR's branch has a PR; a round's local branch has none of its own.
    let report = reap(&f.root, &prs(&[(&pr, Ok(PrState::Open))]), &never_live).await;
    assert_removed(&f, "run-first", &pr);
    assert_removed(&f, "r1-round", &one);
    assert_kept(&f, "r2-round", &two);
    assert!(f.remote_branches().contains(&pr), "the PR's branch stays on origin");
    assert_eq!(report.kept, vec!["r2-round".to_string()]);

    // A live older round is never touched.
    let three = f.add_round("r3-round", "run-first", 3, &pr);
    let live = |id: &str| id == "r2-round";
    reap(&f.root, &prs(&[(&pr, Ok(PrState::Open))]), &live).await;
    assert_kept(&f, "r2-round", &two);
    assert_kept(&f, "r3-round", &three);

    // Merged: the newest round goes too, and the outcome is the first run's.
    let report = reap(&f.root, &prs(&[(&pr, Ok(PrState::Merged))]), &never_live).await;
    assert_removed(&f, "r3-round", &three);
    assert!(report.ended_prs.iter().all(|(id, _)| id == "run-first"), "{:?}", report.ended_prs);
}
