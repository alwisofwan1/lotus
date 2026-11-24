use std::collections::HashMap;
use std::path::{Path, PathBuf};

use lotus_automation::checkout::{find_checkout, find_checkout_or_namesake, git_subfolders, Candidate, Found};

fn ws(id: &str, cwd: &str) -> Candidate {
    Candidate { workspace_id: id.into(), cwd: PathBuf::from(cwd) }
}

/// The user's machine as measured 2026-09-25: the orbit workspace is
/// `acme-main`, which holds the front and back repos as subfolders.
fn machine() -> (HashMap<PathBuf, String>, HashMap<PathBuf, Vec<PathBuf>>) {
    let origins = HashMap::from([
        (PathBuf::from("/w/acme-main"), "acme/acme-main".to_string()),
        (PathBuf::from("/w/acme-main/acme-web"), "acme/acme-web".to_string()),
        (PathBuf::from("/w/acme-main/acme-api"), "acme/acme-api".to_string()),
        (PathBuf::from("/w/lotus"), "alwisofwan1/lotus".to_string()),
        (PathBuf::from("/w/front-alone"), "acme/acme-web".to_string()),
    ]);
    let children = HashMap::from([(
        PathBuf::from("/w/acme-main"),
        vec![PathBuf::from("/w/acme-main/acme-api"), PathBuf::from("/w/acme-main/acme-web")],
    )]);
    (origins, children)
}

fn find(repo: &str, candidates: &[Candidate], preferred: Option<&str>) -> Option<Found> {
    let (origins, children) = machine();
    find_checkout(
        repo,
        candidates,
        preferred,
        &|p: &Path| origins.get(p).cloned(),
        &|p: &Path| children.get(p).cloned().unwrap_or_default(),
    )
}

#[test]
fn a_pr_of_a_repo_inside_the_project_opens_in_that_subfolder_of_the_same_workspace() {
    let rail = [ws("ws-lotus", "/w/lotus"), ws("ws-orbit", "/w/acme-main")];
    assert_eq!(
        find("acme/acme-web", &rail, Some("ws-orbit")),
        Some(Found { workspace_id: "ws-orbit".into(), cwd: "/w/acme-main/acme-web".into(), namesake: None })
    );
    assert_eq!(find("acme/acme-api", &rail, Some("ws-orbit")).unwrap().cwd, PathBuf::from("/w/acme-main/acme-api"));
}

#[test]
fn a_workspace_that_is_the_checkout_itself_wins_over_a_subfolder() {
    let rail = [ws("ws-orbit", "/w/acme-main"), ws("ws-front", "/w/front-alone")];
    assert_eq!(find("acme/acme-web", &rail, Some("ws-orbit")).unwrap().workspace_id, "ws-front");
}

#[test]
fn case_does_not_matter_and_no_checkout_means_none() {
    let rail = [ws("ws-orbit", "/w/acme-main")];
    assert!(find("Acme/Acme-Web", &rail, None).is_some());
    assert_eq!(find("acme/acme-infra", &rail, Some("ws-orbit")), None);
}

#[test]
fn only_subfolders_holding_a_repository_are_looked_into() {
    let root = tempfile::tempdir().unwrap();
    for (name, git) in [("acme-web", true), ("docs", false), (".hidden", true), ("node_modules", true)] {
        std::fs::create_dir_all(root.path().join(name)).unwrap();
        if git {
            std::fs::create_dir_all(root.path().join(name).join(".git")).unwrap();
        }
    }
    std::fs::create_dir_all(root.path().join("worktree")).unwrap();
    std::fs::write(root.path().join("worktree/.git"), "gitdir: /elsewhere").unwrap();
    let found: Vec<String> =
        git_subfolders(root.path()).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(found, ["acme-web", "worktree"]);
}

/// Measured 2026-10-17: issue `donisapu/e-coursetradding#18`, checked out at
/// `clients/flow-trader` from `mapantekno/e-coursetradding`.
#[test]
fn an_issue_opens_in_the_one_checkout_of_a_namesake_repo_and_factory_still_does_not() {
    let origins = HashMap::from([
        (PathBuf::from("/w/flow-trader"), "mapantekno/e-coursetradding".to_string()),
        (PathBuf::from("/w/lotus"), "alwisofwan1/lotus".to_string()),
        (PathBuf::from("/w/demo/lotus"), "someone/lotus".to_string()),
    ]);
    let children = HashMap::from([(PathBuf::from("/w/demo"), vec![PathBuf::from("/w/demo/lotus")])]);
    let rail = [ws("ws-demo", "/w/demo"), ws("ws-flow", "/w/flow-trader"), ws("ws-lotus", "/w/lotus")];
    let repo_of = |p: &Path| origins.get(p).cloned();
    let children_of = |p: &Path| children.get(p).cloned().unwrap_or_default();

    assert_eq!(find_checkout("donisapu/e-coursetradding", &rail, None, &repo_of, &children_of), None);
    assert_eq!(
        find_checkout_or_namesake("donisapu/e-coursetradding", &rail, None, &repo_of, &children_of),
        // It names the folder's own repo: a push from there lands in mapantekno's, not donisapu's.
        Some(Found {
            workspace_id: "ws-flow".into(),
            cwd: "/w/flow-trader".into(),
            namesake: Some("mapantekno/e-coursetradding".into()),
        })
    );
    // The owner's own checkout still wins over a namesake, and is not one.
    let own = find_checkout_or_namesake("alwisofwan1/lotus", &rail, None, &repo_of, &children_of).unwrap();
    assert_eq!((own.cwd, own.namesake), (PathBuf::from("/w/lotus"), None));
    // Two namesakes and no exact match: no guess.
    assert_eq!(find_checkout_or_namesake("other/lotus", &rail, None, &repo_of, &children_of), None);
}
