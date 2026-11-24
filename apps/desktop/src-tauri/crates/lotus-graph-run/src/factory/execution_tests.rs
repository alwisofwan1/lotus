use super::*;
use std::os::unix::process::CommandExt;

#[test]
#[ignore = "child fixture used by the SIGKILL acceptance test"]
fn lease_child() {
    let root = std::path::PathBuf::from(std::env::var("FACTORY_EXECUTION_TEST_ROOT").unwrap());
    let journal = ExecutionJournal::acquire(&root, "crash-probe").unwrap();
    journal.handle().spawned(std::process::id()).unwrap();
    std::fs::write(root.join("ready"), "ready").unwrap();
    std::thread::sleep(std::time::Duration::from_secs(30));
}

#[test]
fn sigkill_leaves_durable_unknown_process_evidence_not_permission_to_replay() {
    let dir = tempfile::tempdir().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "factory::execution::tests::lease_child",
            "--exact",
            "--ignored",
            "--test-threads=1",
        ])
        .env("FACTORY_EXECUTION_TEST_ROOT", dir.path())
        .process_group(0)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while !dir.path().join("ready").exists() {
        assert!(std::time::Instant::now() < deadline && child.try_wait().unwrap().is_none());
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        ExecutionJournal::acquire(dir.path(), "crash-probe").is_err(),
        "a second process cannot take the lease"
    );
    child.kill().unwrap();
    child.wait().unwrap();
    let data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(journal_path(dir.path(), "crash-probe")).unwrap())
            .unwrap();
    let owner: ProcessIdentity = serde_json::from_value(data["owner"].clone()).unwrap();
    assert_eq!(owner.state(), ProcessState::Gone);
    assert!(retention_required(dir.path(), "crash-probe"));
    assert!(
        ExecutionJournal::acquire(dir.path(), "crash-probe").is_err(),
        "unacknowledged processes are not silently cleared"
    );
}

#[test]
fn cleanup_holds_its_lease_until_artifact_mutation_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let journal = ExecutionJournal::acquire(dir.path(), "run-1").unwrap();
    journal.record(Phase::Gate, Event::Done, 1, None).unwrap();
    drop(journal);
    let guard = cleanup_lease(dir.path(), "run-1").unwrap();
    assert!(ExecutionJournal::acquire(dir.path(), "run-1").is_err());
    drop(guard);
    assert!(ExecutionJournal::acquire(dir.path(), "run-1").is_ok());
}

#[test]
fn journal_is_durable_bounded_and_excludes_command_secrets() {
    let dir = tempfile::tempdir().unwrap();
    let journal = ExecutionJournal::acquire(dir.path(), "run-1").unwrap();
    journal
        .record(Phase::Implement, Event::Intent, 1, None)
        .unwrap();
    assert!(retention_required(dir.path(), "run-1"));
    let bytes = std::fs::read(journal_path(dir.path(), "run-1")).unwrap();
    let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(data["version"], 1);
    assert_eq!(data["events"][0]["event"], "intent");
    assert!(data["owner"]["start"].is_string());
    for _ in 0..80 {
        journal
            .record(Phase::Gate, Event::Done, 1, Some("a".repeat(40)))
            .unwrap();
    }
    let data: serde_json::Value =
        serde_json::from_slice(&std::fs::read(journal_path(dir.path(), "run-1")).unwrap()).unwrap();
    assert!(data["events"].as_array().unwrap().len() <= 64);
    assert_eq!(data["truncated"], true);
    assert!(data.get("env").is_none() && data.get("args").is_none());
}

#[test]
fn lease_excludes_a_second_writer_and_identity_reuse_is_not_owned() {
    let dir = tempfile::tempdir().unwrap();
    let journal = ExecutionJournal::acquire(dir.path(), "run-1").unwrap();
    assert!(ExecutionJournal::acquire(dir.path(), "run-1").is_err());
    let identity = ProcessIdentity::capture(std::process::id()).unwrap();
    assert_eq!(identity.state(), ProcessState::Matching);
    let forged = ProcessIdentity {
        start: "different-start".into(),
        ..identity
    };
    assert_eq!(forged.state(), ProcessState::Reused);
    drop(journal);
    let next = ExecutionJournal::acquire(dir.path(), "run-1");
    assert!(next.is_ok(), "{:?}", next.err());
}

#[test]
fn persistence_failure_does_not_advance_in_memory_or_follow_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let journal = ExecutionJournal::acquire(dir.path(), "run-1").unwrap();
    let path = journal_path(dir.path(), "run-1");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(journal
        .record(Phase::Implement, Event::Intent, 1, None)
        .is_err());
    std::fs::remove_dir(&path).unwrap();
    journal.record(Phase::Gate, Event::Done, 1, None).unwrap();
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(data["events"].as_array().unwrap().len(), 1);
    #[cfg(unix)]
    {
        let other = dir.path().join("private.txt");
        std::fs::write(&other, "do not replace").unwrap();
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&other, &path).unwrap();
        assert!(journal.record(Phase::Gate, Event::Done, 1, None).is_err());
        assert_eq!(std::fs::read_to_string(other).unwrap(), "do not replace");
    }
}

#[test]
fn unacknowledged_process_registration_blocks_reacquisition() {
    let dir = tempfile::tempdir().unwrap();
    let journal = ExecutionJournal::acquire(dir.path(), "run-1").unwrap();
    let handle = journal.handle();
    let mut child = std::process::Command::new("/bin/sh")
        .args(["-c", "exec /bin/sleep 30"])
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id();
    handle.spawned(pid).unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    drop(journal);
    assert!(ExecutionJournal::acquire(dir.path(), "run-1").is_err());
    assert!(
        handle.exited(pid).is_err(),
        "a stale handle cannot mutate a new epoch"
    );
    assert!(retention_required(dir.path(), "run-1"));
}
