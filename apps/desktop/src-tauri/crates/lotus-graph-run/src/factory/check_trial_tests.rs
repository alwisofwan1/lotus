use super::*;
use std::process::Command;
fn git(root: &Path, args: &[&str]) {
    assert!(Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false"
        ])
        .args(args)
        .output()
        .unwrap()
        .status
        .success());
}
pub(in crate::factory) fn fixture() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    git(tmp.path(), &["init", "-b", "main"]);
    git(
        tmp.path(),
        &["config", "user.email", "test@example.invalid"],
    );
    git(tmp.path(), &["config", "user.name", "Test"]);
    std::fs::write(tmp.path().join("revision.txt"), "committed").unwrap();
    std::fs::write(
        tmp.path().join("checks.sh"),
        "#!/bin/sh\nprintf repo-check\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            tmp.path().join("checks.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
    }
    git(tmp.path(), &["add", "."]);
    git(tmp.path(), &["commit", "-m", "fixture"]);
    git(
        tmp.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    tmp
}
async fn plan(root: &Path, command: &str, shell: bool) -> TrialPlan {
    prepare(
        root,
        "o/r",
        "main",
        command,
        shell,
        &root.join("trials"),
        &HashMap::new(),
    )
    .await
    .unwrap()
}
async fn run(
    p: &TrialPlan,
    timeout: Duration,
    cancel: watch::Receiver<bool>,
    env: &HashMap<String, String>,
) -> TrialResult {
    execute(p, env, timeout, cancel, Arc::new(Mutex::new(Vec::new()))).await
}
#[tokio::test]
async fn preview_is_read_only_and_trial_uses_pinned_committed_files_not_dirty_checkout() {
    let root = fixture();
    let p = plan(
        root.path(),
        "test \"$(cat revision.txt)\" = committed && printf okay && touch artifact",
        true,
    )
    .await;
    assert!(!Path::new(&p.preview.worktree).exists());
    std::fs::write(root.path().join("revision.txt"), "dirty").unwrap();
    let (_, cancel) = watch::channel(false);
    let result = run(&p, Duration::from_secs(5), cancel, &HashMap::new()).await;
    assert_eq!(result.status, TrialStatus::Passed);
    assert_eq!(result.exit_code, Some(0));
    assert!(!root.path().join("artifact").exists());
    assert!(!Path::new(&p.preview.worktree).exists());
    assert_eq!(
        std::fs::read_to_string(root.path().join("revision.txt")).unwrap(),
        "dirty"
    );
}
#[tokio::test]
async fn refuses_nested_checkout_directories_instead_of_testing_in_a_different_working_directory() {
    let root = fixture();
    std::fs::create_dir(root.path().join("module")).unwrap();
    assert!(prepare(
        &root.path().join("module"),
        "o/r",
        "main",
        "printf okay",
        true,
        &root.path().join("trials"),
        &HashMap::new()
    )
    .await
    .is_err());
}
#[tokio::test]
async fn managed_git_operations_ignore_inherited_repository_overrides() {
    let root = fixture();
    let other = fixture();
    git(
        other.path(),
        &["commit", "--allow-empty", "-m", "different repo"],
    );
    git(
        other.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    let expected = plan(root.path(), "printf okay", true)
        .await
        .preview
        .revision;
    let env = HashMap::from([
        (
            "GIT_DIR".into(),
            other.path().join(".git").to_string_lossy().into_owned(),
        ),
        (
            "GIT_WORK_TREE".into(),
            other.path().to_string_lossy().into_owned(),
        ),
    ]);
    let selected = prepare(
        root.path(),
        "o/r",
        "main",
        "printf okay",
        true,
        &root.path().join("trials"),
        &env,
    )
    .await
    .unwrap();
    assert_eq!(selected.preview.revision, expected);
}
#[tokio::test]
async fn shell_mode_is_only_for_repositories_without_local_or_origin_policy() {
    let root = fixture();
    assert!(shell_mode(root.path(), "main", &HashMap::new())
        .await
        .unwrap());
    std::fs::create_dir_all(root.path().join(".lotus")).unwrap();
    std::fs::write(
        root.path().join(".lotus/factory.toml"),
        "gate = 'checks.sh'",
    )
    .unwrap();
    assert!(!shell_mode(root.path(), "main", &HashMap::new())
        .await
        .unwrap());
    git(root.path(), &["add", ".lotus"]);
    git(root.path(), &["commit", "-m", "policy"]);
    git(
        root.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    std::fs::remove_file(root.path().join(".lotus/factory.toml")).unwrap();
    assert!(!shell_mode(root.path(), "main", &HashMap::new())
        .await
        .unwrap());
}
#[tokio::test]
async fn refuses_a_moved_revision_before_execution() {
    let root = fixture();
    let p = plan(root.path(), "touch should-not-run", true).await;
    git(root.path(), &["commit", "--allow-empty", "-m", "advance"]);
    git(
        root.path(),
        &["update-ref", "refs/remotes/origin/main", "HEAD"],
    );
    let (_, cancel) = watch::channel(false);
    let result = run(&p, Duration::from_secs(5), cancel, &HashMap::new()).await;
    assert_eq!(result.status, TrialStatus::Failed);
    assert!(result.message.contains("changed"));
    assert!(!Path::new(&p.preview.worktree).exists());
}
#[tokio::test]
async fn repository_gate_is_a_contained_script_not_a_shell_command() {
    let root = fixture();
    assert!(prepare(
        root.path(),
        "o/r",
        "main",
        "../outside.sh",
        false,
        &root.path().join("trials"),
        &HashMap::new()
    )
    .await
    .is_err());
    let p = plan(root.path(), "checks.sh", false).await;
    let (_, cancel) = watch::channel(false);
    assert_eq!(
        run(&p, Duration::from_secs(5), cancel, &HashMap::new())
            .await
            .status,
        TrialStatus::Passed
    );
}
#[tokio::test]
async fn verdict_comes_from_exit_code_not_output_and_modified_sources_are_not_verified() {
    let root = fixture();
    for command in ["printf Passed; exit 7", "printf changed > revision.txt"] {
        let p = plan(root.path(), command, true).await;
        let (_, cancel) = watch::channel(false);
        assert_eq!(
            run(&p, Duration::from_secs(5), cancel, &HashMap::new())
                .await
                .status,
            TrialStatus::Failed
        );
    }
}
#[tokio::test]
async fn output_is_streamed_and_bounded() {
    let root = fixture();
    let p = plan(
        root.path(),
        "i=0; while [ $i -lt 2000 ]; do printf 0123456789; i=$((i+1)); done",
        true,
    )
    .await;
    let (_, cancel) = watch::channel(false);
    let output = Arc::new(Mutex::new(Vec::new()));
    assert_eq!(
        execute(
            &p,
            &HashMap::new(),
            Duration::from_secs(5),
            cancel,
            output.clone()
        )
        .await
        .status,
        TrialStatus::Passed
    );
    assert!(output.lock().unwrap().len() <= 16_384);
    assert!(!output.lock().unwrap().is_empty());
}
#[tokio::test]
async fn timeout_and_cancel_are_distinct_and_cancelled_children_cannot_keep_writing() {
    let root = fixture();
    let p = plan(root.path(), "sleep 30", true).await;
    let (_, cancel) = watch::channel(false);
    assert_eq!(
        run(&p, Duration::from_millis(50), cancel, &HashMap::new())
            .await
            .status,
        TrialStatus::TimedOut
    );
    let p = plan(
        root.path(),
        "(sleep 1; touch ../escaped-marker) & printf ready; wait",
        true,
    )
    .await;
    let output = Arc::new(Mutex::new(Vec::new()));
    let (sender, cancel) = watch::channel(false);
    let output_read = output.clone();
    let task = tokio::spawn(async move {
        execute(&p, &HashMap::new(), Duration::from_secs(5), cancel, output).await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        while !String::from_utf8_lossy(&output_read.lock().unwrap()).contains("ready") {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    sender.send(true).unwrap();
    assert_eq!(task.await.unwrap().status, TrialStatus::Cancelled);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert!(!root.path().join("trials/escaped-marker").exists());
}
