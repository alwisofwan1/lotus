use super::*;
use crate::factory::check_trial::tests::fixture;
async fn settled(service: &CheckTrials) -> TrialSnapshot {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let result = service.status("o/r").await.unwrap();
            if result.result.status != TrialStatus::Running {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
#[tokio::test]
async fn consent_tokens_are_single_use_and_concurrent_trials_are_refused() {
    let root = fixture();
    let service = CheckTrials::new(root.path().join("trials"), HashMap::new());
    assert!(service.status("o/r").await.is_none());
    let preview = service
        .preview(root.path(), "o/r", "main", "sleep 30", true)
        .await
        .unwrap();
    assert!(!std::path::Path::new(&preview.worktree).exists());
    let other = service
        .preview(root.path(), "o/r", "main", "printf second", true)
        .await
        .unwrap();
    let started = service.start(&preview.id).unwrap();
    assert!(service.start(&preview.id).is_err());
    assert!(service.start(&other.id).is_err());
    assert!(service.cancel("another/repo", &preview.id).is_err());
    service.cancel("o/r", &started.preview.id).unwrap();
    assert_eq!(
        settled(&service).await.result.status,
        TrialStatus::Cancelled
    );
    service.shutdown().await;
}
#[tokio::test]
async fn many_previews_evict_old_receipts_without_blocking_new_reviews() {
    let root = fixture();
    let service = CheckTrials::new(root.path().join("trials"), HashMap::new());
    let first = service
        .preview(root.path(), "o/r", "main", "printf first", true)
        .await
        .unwrap();
    for _ in 0..16 {
        service
            .preview(root.path(), "o/r", "main", "printf newest", true)
            .await
            .unwrap();
    }
    assert!(service.start(&first.id).is_err());
    assert!(service.data.lock().unwrap().prepared.len() <= 16);
}
#[tokio::test]
async fn expired_consent_and_shutdown_cannot_start_new_checks() {
    let root = fixture();
    let service = CheckTrials::new(root.path().join("trials"), HashMap::new());
    let preview = service
        .preview(root.path(), "o/r", "main", "printf first", true)
        .await
        .unwrap();
    service
        .data
        .lock()
        .unwrap()
        .prepared
        .get_mut(&preview.id)
        .unwrap()
        .at -= Duration::from_secs(301);
    assert!(service.start(&preview.id).is_err());
    let preview = service
        .preview(root.path(), "o/r", "main", "printf ready; sleep 30", true)
        .await
        .unwrap();
    service.start(&preview.id).unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        while !service
            .status("o/r")
            .await
            .unwrap()
            .output
            .contains("ready")
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    service.shutdown().await;
    assert_eq!(
        service.status("o/r").await.unwrap().result.status,
        TrialStatus::Cancelled
    );
    assert!(!std::path::Path::new(&preview.worktree).exists());
    assert!(service
        .preview(root.path(), "o/r", "main", "printf no", true)
        .await
        .is_err());
}
#[tokio::test]
async fn status_redacts_known_secret_values_and_detects_revision_changes() {
    let root = fixture();
    let service = CheckTrials::new(
        root.path().join("trials"),
        HashMap::from([("TEST_API_KEY".into(), "fixture-secret-123".into())]),
    );
    let preview = service
        .preview(root.path(), "o/r", "main", "printf \"$TEST_API_KEY\"", true)
        .await
        .unwrap();
    service.start(&preview.id).unwrap();
    let result = settled(&service).await;
    assert_eq!(result.result.status, TrialStatus::Passed);
    assert!(result.output.contains("[redacted]"));
    assert!(!result.output.contains("fixture-secret-123"));
    assert_eq!(result.current_revision, Some(preview.revision));
    for args in [
        vec!["commit", "--allow-empty", "-m", "advance"],
        vec!["update-ref", "refs/remotes/origin/main", "HEAD"],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(root.path())
            .args(args)
            .output()
            .unwrap()
            .status
            .success());
    }
    let changed = service.status("o/r").await.unwrap();
    assert_ne!(
        changed.current_revision.as_deref(),
        Some(changed.preview.revision.as_str())
    );
    service.shutdown().await;
}
