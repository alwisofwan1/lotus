//! `Prefetch` against real git repositories: a stand-in for GitHub (a local repo with a
//! `refs/pull/7/head`), reached through `insteadOf` so the checkout's origin still reads as GitHub.

use std::path::Path;
use std::process::Command;

use lotus_automation::pr_review::{PrRef, Prefetch};

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

struct Fixture {
    _dir: tempfile::TempDir,
    /// The workspace folder holding the checkout, as `acme-main/` holds its repos.
    workspace: std::path::PathBuf,
    checkout: std::path::PathBuf,
    pr_head: String,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let origin = dir.path().join("origin");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.email", "t@example.com"), ("user.name", "t")] {
        git(&origin, &["config", k, v]);
    }
    std::fs::write(origin.join("a.txt"), "one").unwrap();
    git(&origin, &["add", "."]);
    git(&origin, &["commit", "-q", "-m", "one"]);

    let workspace = dir.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    git(&workspace, &["clone", "-q", origin.to_str().unwrap(), "app"]);
    let checkout = workspace.join("app");
    git(&checkout, &["remote", "set-url", "origin", "https://github.com/acme/app.git"]);
    git(&checkout, &["config", &format!("url.{}.insteadOf", origin.display()), "https://github.com/acme/app.git"]);

    // The PR's head: only on GitHub's pull ref, never in the clone.
    git(&origin, &["checkout", "-q", "-b", "feature"]);
    std::fs::write(origin.join("a.txt"), "two").unwrap();
    git(&origin, &["commit", "-q", "-am", "two"]);
    let pr_head = git(&origin, &["rev-parse", "HEAD"]);
    git(&origin, &["update-ref", "refs/pull/7/head", &pr_head]);
    git(&origin, &["checkout", "-q", "main"]);
    git(&origin, &["branch", "-q", "-D", "feature"]);

    Fixture { _dir: dir, workspace, checkout, pr_head }
}

fn env() -> std::collections::HashMap<String, String> {
    std::env::vars().collect()
}

#[tokio::test]
async fn the_prs_head_is_fetched_into_its_checkout_inside_the_workspace() {
    let f = fixture();
    let pr = PrRef { repo: "Acme/App".into(), number: 7 };
    assert!(Command::new("git").arg("-C").arg(&f.checkout).args(["cat-file", "-e", &f.pr_head]).status().unwrap().code() != Some(0));

    let found = Prefetch::new(env()).commit(&f.workspace, &pr, &f.pr_head).await;

    assert_eq!(found.as_deref(), Some(f.checkout.as_path()));
    git(&f.checkout, &["cat-file", "-e", &format!("{}^{{commit}}", f.pr_head)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reviews_side_by_side_fetch_one_at_a_time_and_all_find_the_commit() {
    let f = fixture();
    let prefetch = std::sync::Arc::new(Prefetch::new(env()));
    let pr = PrRef { repo: "acme/app".into(), number: 7 };
    let tries: Vec<_> = (0..3)
        .map(|_| {
            let (prefetch, workspace, pr, sha) = (prefetch.clone(), f.workspace.clone(), pr.clone(), f.pr_head.clone());
            tokio::spawn(async move { prefetch.commit(&workspace, &pr, &sha).await })
        })
        .collect();
    for t in tries {
        assert_eq!(t.await.unwrap().as_deref(), Some(f.checkout.as_path()));
    }
}

#[tokio::test]
async fn no_checkout_of_the_repo_means_no_fetch() {
    let f = fixture();
    let pr = PrRef { repo: "acme/other".into(), number: 7 };
    assert_eq!(Prefetch::new(env()).commit(&f.workspace, &pr, &f.pr_head).await, None);
}

#[tokio::test]
async fn a_head_the_pull_ref_no_longer_points_at_is_not_reported_as_fetched() {
    let f = fixture();
    let pr = PrRef { repo: "acme/app".into(), number: 7 };
    assert_eq!(Prefetch::new(env()).commit(&f.workspace, &pr, "0123456789abcdef0123456789abcdef01234567").await, None);
}
