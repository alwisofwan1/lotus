//! A timed-out agent takes its children with it: the agent runs in its own process group and a
//! guard kills the group when the run is dropped. Uses a fake `claude` on PATH.

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;

use lotus_automation::agent::{Access, AgentRequest, AgentRunner, AgentSession, CliAgentRunner, Preset, AgentProcessEvent};

#[tokio::test]
async fn process_evidence_is_acknowledged_before_prompt_delivery() {
    for reject in [false, true] {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin"); std::fs::create_dir(&bin).unwrap();
        let seen = tmp.path().join("prompt");
        let script = bin.join("claude");
        std::fs::write(&script, format!("#!/bin/sh\ncat > '{}'\nprintf '%s\\n' '{{\"structured_output\":{{}}}}'\n", seen.display())).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = events.clone();
        let runner = CliAgentRunner::new(Arc::new(|_: &str| Some(Preset { agent: "claude".into(), args: String::new(), ..Default::default() })), HashMap::from([("PATH".into(), format!("{}:/usr/bin:/bin", bin.display()))]))
            .with_process_events(Arc::new(move |event| {
                if reject { return Err("checkpoint unavailable".into()); }
                observed.lock().unwrap().push(event); Ok(())
            }));
        let request = AgentRequest { preset_id: "p".into(), prompt: "approved prompt".into(), schema: serde_json::json!({"type":"object"}), tools: vec![], access: Access::Full, session: Some(AgentSession { id: "s".into(), cwd: tmp.path().join("work"), resume: false }), workspace: None, repo: None, run_id: None, mcp_config: None, plugin_dirs: vec![] };
        let result = runner.run_metered(request).await.0;
        if reject {
            assert!(result.unwrap_err().contains("checkpoint unavailable"));
            assert!(std::fs::read_to_string(&seen).unwrap_or_default().is_empty());
        } else {
            assert!(result.is_ok(), "{result:?}");
            let events = events.lock().unwrap();
            assert!(matches!(events[0], AgentProcessEvent::Spawned(_)));
            assert!(matches!(events[1], AgentProcessEvent::Exited(_)));
            assert_eq!(events.len(), 2);
            assert_eq!(std::fs::read_to_string(&seen).unwrap(), "approved prompt");
        }
    }
}

#[tokio::test]
async fn dropping_a_run_kills_the_agents_background_children() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let pid_file = tmp.path().join("child.pid");
    let script = bin.join("claude");
    std::fs::write(&script, format!("#!/bin/sh\nsleep 60 &\necho $! > {}\nwait\n", pid_file.display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let env = HashMap::from([("PATH".to_string(), format!("{}:/usr/bin:/bin", bin.display()))]);
    let presets = Arc::new(|_: &str| Some(Preset { agent: "claude".into(), args: String::new(), ..Default::default() }));
    let runner = CliAgentRunner::new(presets, env);
    let request = AgentRequest {
        preset_id: "p".into(),
        prompt: "go".into(),
        schema: serde_json::json!({ "type": "object" }),
        tools: vec![],
        access: Access::Full,
        session: Some(AgentSession { id: "s1".into(), cwd: tmp.path().join("work"), resume: false }),
        workspace: None,
        repo: None,
        run_id: None,
        mcp_config: None,
        plugin_dirs: vec![],
    };
    let outcome = tokio::time::timeout(Duration::from_millis(800), runner.run_metered(request)).await;
    assert!(outcome.is_err(), "the fake agent never finishes");

    let pid: i32 = std::fs::read_to_string(&pid_file).expect("agent started its child").trim().parse().unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let alive = std::process::Command::new("kill").args(["-0", &pid.to_string()]).output().unwrap().status.success();
    assert!(!alive, "the agent's background child (pid {pid}) survived the timeout");
}

/// What the fake agent saw: its package-cache env and its `--settings`, one per line.
async fn caches_seen(run_tests: bool) -> (String, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap().keep();
    let bin = tmp.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let out = tmp.join("seen.txt");
    let script = bin.join("claude");
    std::fs::write(
        &script,
        format!("#!/bin/sh\necho \"npm=$npm_config_cache pip=$PIP_CACHE_DIR\" > {out}\necho \"secret=$SECRET_TOKEN git=$GIT_CONFIG_GLOBAL\" >> {out}\necho \"$@\" >> {out}\n", out = out.display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let env = HashMap::from([
        ("PATH".to_string(), format!("{}:/usr/bin:/bin", bin.display())),
        ("HOME".to_string(), tmp.display().to_string()),
        ("SECRET_TOKEN".to_string(), "s3cr3t".to_string()),
    ]);
    let presets = Arc::new(|_: &str| Some(Preset { agent: "claude".into(), args: String::new(), ..Default::default() }));
    let runner = CliAgentRunner::new(presets, env);
    let work = tmp.join("work");
    let request = AgentRequest {
        preset_id: "p".into(),
        prompt: "go".into(),
        schema: serde_json::json!({ "type": "object" }),
        tools: vec![],
        access: Access::ReadOnly { mcp_tools: vec![], github_account: None, run_tests },
        session: Some(AgentSession { id: "s1".into(), cwd: work.clone(), resume: false }),
        workspace: None,
        repo: None,
        run_id: None,
        mcp_config: None,
        plugin_dirs: vec![],
    };
    let _ = runner.run_metered(request).await;
    (std::fs::read_to_string(&out).expect("the fake agent ran"), work)
}

#[tokio::test]
async fn a_review_that_runs_tests_keeps_its_package_caches_in_the_working_folder() {
    let (seen, work) = caches_seen(true).await;
    let first = seen.lines().next().unwrap();
    assert_eq!(first, format!("npm={0}/.lotus-cache/npm pip={0}/.lotus-cache/pip", work.display()));
    assert!(seen.contains("registry.npmjs.org"), "the sandbox reaches the registry: {seen}");
    // The PR's code runs: no token from the user's environment, no ~/.gitconfig, home closed.
    assert!(seen.contains("secret= git=/dev/null"), "{seen}");
    assert!(seen.contains(&format!("\"allowRead\":[\"{}\"", work.display())), "{seen}");
    assert!(seen.contains(&format!("Read(/{}/**)", work.display())), "Read reaches the worktree only: {seen}");
    assert!(!seen.contains("Bash,Read,"), "{seen}");

    let (seen, _) = caches_seen(false).await;
    assert!(seen.starts_with("npm= pip=\n"), "off: no cache env: {seen}");
    assert!(!seen.contains("registry.npmjs.org"), "off: no registry: {seen}");
    assert!(seen.contains("secret=s3cr3t git="), "off: the environment as before: {seen}");
}
