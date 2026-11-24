use lotus_automation::agent::{build_agent_command, CommandRefusal, Preset};
use serde_json::json;

fn preset(agent: &str, args: &str) -> Preset {
    Preset { agent: agent.into(), args: args.into(), ..Default::default() }
}

fn has_pair(args: &[String], flag: &str, value: &str) -> bool {
    args.windows(2).any(|w| w[0] == flag && w[1] == value)
}

#[test]
fn a_ccs_preset_runs_headless_with_no_tools_no_mcp_and_a_schema() {
    let schema = json!({ "type": "object" });
    let cmd = build_agent_command(&preset("ccs acme", "--dangerously-skip-permissions"), &schema).unwrap();

    assert_eq!(cmd.program, "ccs");
    assert_eq!(cmd.args[0], "acme", "the ccs profile comes first");
    assert!(cmd.args.contains(&"-p".to_string()));
    assert!(has_pair(&cmd.args, "--tools", ""), "{:?}", cmd.args);
    assert!(cmd.args.contains(&"--strict-mcp-config".to_string()));
    assert!(cmd.args.contains(&"--no-session-persistence".to_string()));
    assert!(has_pair(&cmd.args, "--output-format", "json"));
    assert!(has_pair(&cmd.args, "--json-schema", &schema.to_string()));
    assert!(!cmd.args.iter().any(|a| a.contains("dangerously")), "{:?}", cmd.args);
    assert_eq!(cmd.dropped, vec!["--dangerously-skip-permissions".to_string()]);
}

#[test]
fn only_the_model_flag_of_a_preset_survives() {
    let cmd = build_agent_command(
        &preset("claude", "--model opus --effort high --mcp-config ./x.json --allowedTools Bash --tools default"),
        &json!({}),
    )
    .unwrap();

    assert_eq!(cmd.program, "claude");
    assert!(has_pair(&cmd.args, "--model", "opus"));
    assert!(has_pair(&cmd.args, "--tools", ""), "our --tools \"\" wins");
    for gone in ["--effort", "--mcp-config", "./x.json", "--allowedTools", "Bash", "default"] {
        assert!(!cmd.args.iter().any(|a| a == gone), "{gone} leaked: {:?}", cmd.args);
    }
    assert_eq!(
        cmd.dropped,
        vec!["--effort high", "--mcp-config ./x.json", "--allowedTools Bash", "--tools default"]
    );
}

#[test]
fn the_equals_form_of_the_model_flag_is_understood() {
    let cmd = build_agent_command(&preset("claude", "--model=sonnet"), &json!({})).unwrap();
    assert!(has_pair(&cmd.args, "--model", "sonnet"));
}

#[test]
fn agents_that_cannot_run_tool_less_headless_are_refused() {
    for agent in ["codex", "gemini", "gh copilot", "opencode"] {
        let refusal = build_agent_command(&preset(agent, ""), &json!({})).unwrap_err();
        assert!(matches!(refusal, CommandRefusal::UnsupportedAgent(_)), "{agent}");
    }
}

#[test]
fn flags_smuggled_into_the_agent_field_are_refused() {
    let refusal = build_agent_command(&preset("claude --dangerously-skip-permissions", ""), &json!({})).unwrap_err();
    assert!(matches!(refusal, CommandRefusal::FlagInAgent(_)), "{refusal:?}");
}

#[test]
fn the_structured_output_of_a_headless_run_is_the_reply() {
    use lotus_automation::agent::parse_agent_output;
    let out = r#"{"type":"result","subtype":"success","is_error":false,"result":"done","structured_output":{"summary":"ok","comments":[]}}"#;
    assert_eq!(parse_agent_output(out).unwrap(), json!({ "summary": "ok", "comments": [] }));
}

#[test]
fn a_headless_run_that_errored_or_gave_no_structured_output_is_an_error() {
    use lotus_automation::agent::parse_agent_output;
    for out in [
        r#"{"type":"result","subtype":"error_max_structured_output_retries","is_error":true}"#,
        r#"{"type":"result","subtype":"success","is_error":false,"result":"plain text only"}"#,
        "not json at all",
    ] {
        assert!(parse_agent_output(out).is_err(), "{out}");
    }
}

/// A network failure and a 5xx are short outages, worth one more try (CoS 3); a 4xx and the agent's
/// own errors are not. The result objects are what the claude CLI printed on 2026-10-13 with the
/// API pointed at a closed port and at a server answering 500.
#[test]
fn an_api_outage_is_a_transient_error_and_nothing_else_is() {
    use lotus_automation::agent::{is_transient_error, parse_agent_output};
    let refused = r#"{"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":null,"result":"API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)","type":"result","total_cost_usd":0}"#;
    let server = r#"{"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":500,"result":"API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment.","type":"result","total_cost_usd":0}"#;
    let denied = r#"{"is_error":true,"subtype":"success","terminal_reason":"api_error","api_error_status":401,"result":"API Error: 401 invalid x-api-key","type":"result"}"#;
    for out in [refused, server] {
        let error = parse_agent_output(out).unwrap_err();
        assert!(is_transient_error(&error), "{error}");
        assert!(error.contains("API Error:"), "the CLI's own words are kept: {error}");
    }
    let error = parse_agent_output(denied).unwrap_err();
    assert!(!is_transient_error(&error) && error.contains("401"), "{error}");
    for out in [r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#, "not json at all"] {
        assert!(!is_transient_error(&parse_agent_output(out).unwrap_err()), "{out}");
    }
}

#[test]
fn allowed_tools_are_passed_exactly_and_everything_else_stays_off() {
    use lotus_automation::agent::build_agent_command_with_tools;
    let tools = vec!["WebSearch".to_string(), "WebFetch".to_string()];
    let cmd = build_agent_command_with_tools(&preset("claude", ""), &json!({}), &tools).unwrap();

    assert!(has_pair(&cmd.args, "--tools", "WebSearch,WebFetch"), "{:?}", cmd.args);
    assert!(has_pair(&cmd.args, "--allowedTools", "WebSearch,WebFetch"), "{:?}", cmd.args);
    assert!(cmd.args.contains(&"--strict-mcp-config".to_string()));
    assert!(!cmd.args.iter().any(|a| a.contains("Bash") || a.contains("dangerously")));
}

#[test]
fn no_tools_means_the_empty_tool_list() {
    use lotus_automation::agent::build_agent_command_with_tools;
    let cmd = build_agent_command_with_tools(&preset("claude", ""), &json!({}), &[]).unwrap();
    assert!(has_pair(&cmd.args, "--tools", ""));
    assert!(!cmd.args.contains(&"--allowedTools".to_string()));
}

#[test]
fn a_tool_outside_the_allowed_set_is_refused() {
    use lotus_automation::agent::build_agent_command_with_tools;
    for tool in ["Bash", "Write", "Edit", "Read", "mcp__lotus__lotus_spawn_cell"] {
        let refusal = build_agent_command_with_tools(&preset("claude", ""), &json!({}), &[tool.to_string()]).unwrap_err();
        assert!(matches!(refusal, CommandRefusal::ToolNotAllowed(_)), "{tool}");
    }
}

#[test]
fn every_automation_agent_is_marked_so_lotus_tools_refuse_it() {
    // PLAN §2.5 Q34: an agent an automation runs must not create, change or
    // delete automations. The marker reaches any MCP server it could start.
    let cmd = build_agent_command(&preset("claude", ""), &json!({})).unwrap();
    assert!(
        cmd.env.contains(&(lotus_automation::agent::AUTOMATION_RUN_ENV.to_string(), "1".to_string())),
        "{:?}",
        cmd.env
    );
    assert_eq!(lotus_automation::agent::AUTOMATION_RUN_ENV, "LOTUS_AUTOMATION_RUN");
}

/// A full run is the preset as the user runs it (its permission flag
/// included), made headless and schema-bound under Lotus's session id.
#[test]
fn a_full_run_keeps_the_preset_flags_and_adds_only_headless_output_under_a_session() {
    use lotus_automation::agent::build_full_agent_command;
    let cmd = build_full_agent_command(&preset("ccs acme", "--dangerously-skip-permissions --model opus"), &json!({"type":"object"}), "S1")
        .unwrap();
    assert_eq!(cmd.program, "ccs");
    assert_eq!(
        cmd.args,
        [
            "acme", "--dangerously-skip-permissions", "--model", "opus", "-p", "--output-format", "stream-json", "--verbose", "--session-id", "S1",
            "--json-schema", "{\"type\":\"object\"}",
        ]
    );
    assert!(cmd.dropped.is_empty());
    assert!(!cmd.args.iter().any(|a| a == "--tools" || a == "--strict-mcp-config"), "nothing is taken away");
    assert_eq!(cmd.env, vec![("LOTUS_AUTOMATION_RUN".to_string(), "1".to_string())], "the recursion guard stays");
}

#[test]
fn a_full_run_drops_preset_flags_that_would_fight_lotus_over_the_session_or_output() {
    use lotus_automation::agent::build_full_agent_command;
    let cmd = build_full_agent_command(
        &preset("claude", "-p --output-format text --resume abc --no-session-persistence --verbose --output-format=stream-json"),
        &json!({}),
        "S2",
    )
    .unwrap();
    assert_eq!(cmd.dropped, ["-p", "--output-format text", "--resume abc", "--no-session-persistence", "--output-format=stream-json"]);
    assert_eq!(cmd.args.iter().filter(|a| *a == "--output-format").count(), 1);
    assert!(cmd.args.contains(&"--verbose".to_string()));
}

#[test]
fn a_full_run_is_refused_for_an_agent_that_cannot_run_headless() {
    use lotus_automation::agent::build_full_agent_command;
    assert!(build_full_agent_command(&preset("codex", ""), &json!({}), "S").is_err());
    assert!(build_full_agent_command(&preset("claude --yolo", ""), &json!({}), "S").is_err());
}

#[test]
fn a_kept_sealed_run_names_its_session_instead_of_discarding_it() {
    use lotus_automation::agent::build_sealed_agent_command;
    let cmd = build_sealed_agent_command(&preset("claude", ""), &json!({}), &[], Some("S3")).unwrap();
    assert!(cmd.args.windows(2).any(|w| w == ["--session-id", "S3"]));
    assert!(!cmd.args.contains(&"--no-session-persistence".to_string()));
    assert!(cmd.args.windows(2).any(|w| w == ["--tools", ""]), "still tool-less");
}

#[test]
fn the_resume_command_is_the_preset_resuming_the_session() {
    use lotus_automation::agent::resume_command;
    assert_eq!(resume_command(&preset("ccs acme", "--dangerously-skip-permissions"), "S4"), "ccs acme --dangerously-skip-permissions --resume S4");
    assert_eq!(resume_command(&preset("claude", ""), "S5"), "claude --resume S5");
}

/// Seen live 2026-09-25: ccs printed a status line on stdout before the JSON.
#[test]
fn a_status_line_a_wrapper_prints_before_the_result_is_skipped() {
    use lotus_automation::agent::parse_agent_output;
    let out = "[OK] Synchronized marketplace registry paths\n{\"type\":\"result\",\"is_error\":false,\"structured_output\":{\"text\":\"lotus-smoke-42\\n\"}}\n";
    assert_eq!(parse_agent_output(out).unwrap(), json!({ "text": "lotus-smoke-42\n" }));
    assert!(parse_agent_output("[OK] nothing else\n").is_err());
    assert!(parse_agent_output("{\"is_error\":true,\"subtype\":\"error_max_turns\"}").unwrap_err().contains("error_max_turns"));
}

fn fence() -> lotus_automation::agent::ReviewFence {
    let config = json!({"mcpServers": {"context7": {"command": "c7"}, "lotus": {"command": "bun"}}});
    lotus_automation::agent::ReviewFence::new(&["mcp__context7".to_string()], &config, "lotus", Some("alwisofwan1")).unwrap()
}

/// ADR-0052 §3 (revised 2026-10-08): a headless review may run anything, but inside the Claude
/// Code sandbox, holding no token, with only the user's own settings. It reads GitHub only through
/// Lotus's `lotus_github_read`, as the automation's account. The preset keeps only `--model`.
#[test]
fn a_headless_review_runs_sandboxed_without_a_token_and_reads_github_through_lotus() {
    use lotus_automation::agent::{build_read_only_agent_command, review_settings, REVIEW_DENIED_TOOLS, REVIEW_TOOLS};
    let cmd = build_read_only_agent_command(
        &preset(
            "ccs acme",
            "--dangerously-skip-permissions --permission-mode auto --settings x.json --add-dir / --model opus",
        ),
        &json!({"type":"object"}),
        "S1",
        &fence(),
    )
    .unwrap();
    assert_eq!(cmd.program, "ccs");
    let allowed = format!("{},mcp__context7,mcp__lotus__lotus_github_read,mcp__lotus__lotus_notion_read", REVIEW_TOOLS.join(","));
    let servers = json!({"mcpServers": {
        "context7": {"command": "c7"},
        "lotus": {"command": "bun", "env": {"LOTUS_REVIEW_GH_ACCOUNT": "alwisofwan1", "LOTUS_PROFILE_KEY": "lotus"}},
    }})
    .to_string();
    let settings = review_settings(false, &[]).to_string();
    let denied = REVIEW_DENIED_TOOLS.join(",");
    assert_eq!(
        cmd.args,
        [
            "acme", "--model", "opus", "-p", "--output-format", "stream-json", "--verbose", "--session-id", "S1",
            "--permission-mode", "dontAsk", "--allowedTools", allowed.as_str(), "--disallowedTools", denied.as_str(),
            "--setting-sources", "user", "--settings", settings.as_str(),
            "--strict-mcp-config", "--mcp-config", servers.as_str(),
            "--json-schema", "{\"type\":\"object\"}",
        ]
    );
    assert_eq!(
        cmd.dropped,
        ["--dangerously-skip-permissions", "--permission-mode auto", "--settings x.json", "--add-dir /"]
    );
    // The reviewer's own CLAUDE.md files, rules and memory stay out: they are not the team's rules.
    assert_eq!(
        cmd.env,
        [
            ("LOTUS_AUTOMATION_RUN", "1"),
            ("CLAUDE_CODE_DISABLE_CLAUDE_MDS", "1"),
            ("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()))
    );
    for inherited in ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"] {
        assert!(cmd.unset.iter().any(|k| k == inherited), "{inherited}");
    }
}

/// The values proven live on 2026-10-08 (plans/pr-review-large-diff/CHECKPOINTS.md, 02).
#[test]
fn the_review_sandbox_hides_secrets_and_reaches_no_host() {
    let settings = lotus_automation::agent::review_settings(false, &[]);
    assert_eq!(settings["sandbox"]["enabled"], true);
    assert_eq!(settings["sandbox"]["allowUnsandboxedCommands"], false);
    assert_eq!(settings["sandbox"]["failIfUnavailable"], true);
    assert!(settings["sandbox"].get("enableWeakerNetworkIsolation").is_none(), "no gh in the sandbox, so no need");
    assert_eq!(settings["sandbox"]["network"]["allowedDomains"], json!([]), "GitHub comes through Lotus");
    let hidden = json!(["~/.lotus", "~/.lotus-dev", "~/.config/gh", "~/.ssh", "~/Library/Keychains"]);
    assert_eq!(settings["sandbox"]["filesystem"]["denyRead"], hidden);
    assert_eq!(
        settings["permissions"]["deny"],
        json!(["Read(~/.lotus/**)", "Read(~/.lotus-dev/**)", "Read(~/.config/gh/**)", "Read(~/.ssh/**)", "Read(~/Library/Keychains/**)"])
    );
}

#[test]
fn a_review_starts_only_the_mcp_servers_its_tools_name() {
    use lotus_automation::agent::mcp_servers_for;
    let config = json!({"mcpServers": {"lotus": {"command": "bun"}, "context7": {"url": "u"}, "pencil": {"command": "p"}}});
    let tools = ["mcp__lotus__lotus_list_fleet".to_string(), "mcp__context7".to_string(), "mcp__missing__x".to_string()];
    assert_eq!(
        mcp_servers_for(&tools, &config),
        json!({"mcpServers": {"lotus": {"command": "bun"}, "context7": {"url": "u"}}})
    );
    assert_eq!(mcp_servers_for(&[], &config), json!({"mcpServers": {}}));
}

#[test]
fn a_review_that_reads_github_needs_the_lotus_server_and_one_that_does_not_starts_none() {
    use lotus_automation::agent::ReviewFence;
    let without = json!({"mcpServers": {"context7": {"url": "u"}}});
    let err = ReviewFence::new(&[], &without, "lotus-dev", Some("alwisofwan1")).unwrap_err();
    assert!(err.contains("lotus-dev") && err.contains("restart Lotus"), "{err}");
    let quiet = ReviewFence::new(&[], &without, "lotus-dev", None).unwrap();
    assert_eq!((quiet.mcp_servers, quiet.tools), (json!({"mcpServers": {}}), vec![]));
}

#[test]
fn only_mcp_tool_names_can_be_allowed_to_a_read_only_run() {
    use lotus_automation::agent::check_mcp_tool;
    for ok in ["mcp__context7", "mcp__claude_ai_Slack__slack_read_thread", "mcp__plugin_claude-mem_mcp-search__search"] {
        assert!(check_mcp_tool(ok).is_ok(), "{ok}");
    }
    for bad in ["Bash", "Edit", "mcp__", "mcp__x y", "mcp__x,Bash", "mcp__x(*)", "context7"] {
        assert!(check_mcp_tool(bad).is_err(), "{bad}");
    }
}

/// Reopening a review resumes a conversation that read other people's text:
/// it stays read-only, asking in the pane for anything off its list.
#[test]
fn reopening_a_read_only_run_resumes_it_without_the_preset_permission_flags() {
    use lotus_automation::agent::{read_only_resume_command, READ_ONLY_TOOLS};
    let line =
        read_only_resume_command(&preset("ccs acme", "--dangerously-skip-permissions --model opus"), "S1", &["mcp__context7".into()])
            .unwrap();
    assert_eq!(
        line,
        format!(
            "CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 ccs acme --model opus --permission-mode manual \
             --allowedTools '{},mcp__context7' --resume S1",
            READ_ONLY_TOOLS.join(",")
        )
    );
}

#[test]
fn a_streamed_run_ends_with_the_result_line_which_carries_the_reply() {
    use lotus_automation::agent::parse_agent_output;
    let out = concat!(
        "[OK] Synchronized marketplace registry paths\n",
        "{\"type\":\"system\",\"subtype\":\"init\"}\n",
        "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Glob\",\"input\":{}}]}}\n",
        "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"structured_output\":{\"text\":\"ok\"}}\n",
    );
    assert_eq!(parse_agent_output(out).unwrap(), json!({ "text": "ok" }));
}

/// PLAN §8 Q20, ADR-0040 §5: a review's Follow-up Run resumes its conversation headless and just
/// as read-only as the review was — the same flags, `--resume` in place of `--session-id`.
#[test]
fn a_read_only_follow_up_resumes_the_conversation_with_the_same_permissions() {
    use lotus_automation::agent::{build_read_only_agent_command, build_read_only_resume_command};
    let preset = preset("ccs acme", "--dangerously-skip-permissions --permission-mode auto --model opus");
    let schema = json!({"type":"object"});
    let fresh = build_read_only_agent_command(&preset, &schema, "S1", &fence()).unwrap();
    let resumed = build_read_only_resume_command(&preset, &schema, "S1", &fence()).unwrap();

    let expected: Vec<String> = fresh.args.iter().map(|a| if a == "--session-id" { "--resume".into() } else { a.clone() }).collect();
    assert_eq!(resumed.args, expected);
    assert!(!resumed.args.iter().any(|a| a.contains("dangerously")), "{:?}", resumed.args);
    assert_eq!((resumed.env, resumed.dropped, resumed.unset), (fresh.env, fresh.dropped, fresh.unset));
}

/// The price of a run is read from the same result object as the reply, so a
/// failed run still has a cost (ADR-0049 §5e: every attempt counts).
#[test]
fn the_cost_of_a_run_is_read_from_its_result_line() {
    use lotus_automation::agent::parse_agent_cost;
    let ok = r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.4321,"structured_output":{"a":1}}"#;
    assert_eq!(parse_agent_cost(ok), Some(0.4321));
    let failed = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"total_cost_usd":1.5}"#;
    assert_eq!(parse_agent_cost(failed), Some(1.5));
    let no_structured = r#"{"type":"result","subtype":"success","is_error":false,"result":"text","total_cost_usd":0.07}"#;
    assert_eq!(parse_agent_cost(no_structured), Some(0.07));
}

#[test]
fn the_cost_skips_status_lines_and_takes_the_last_object() {
    use lotus_automation::agent::parse_agent_cost;
    let out = "[OK] Synchronized marketplace registry paths\n{\"type\":\"system\",\"total_cost_usd\":9.0}\n{\"type\":\"result\",\"is_error\":false,\"total_cost_usd\":0.25}\n";
    assert_eq!(parse_agent_cost(out), Some(0.25));
}

#[test]
fn no_cost_field_or_no_json_is_no_cost() {
    use lotus_automation::agent::parse_agent_cost;
    assert_eq!(parse_agent_cost(r#"{"type":"result","is_error":false}"#), None);
    assert_eq!(parse_agent_cost(r#"{"type":"result","total_cost_usd":"cheap"}"#), None);
    assert_eq!(parse_agent_cost("not json at all"), None);
    assert_eq!(parse_agent_cost(""), None);
}

#[tokio::test]
async fn a_runner_without_metering_reports_no_cost() {
    use lotus_automation::agent::{Access, AgentRequest, AgentRunner};
    struct Plain;
    impl AgentRunner for Plain {
        fn run(&self, _r: AgentRequest) -> lotus_automation::BoxFuture<Result<serde_json::Value, String>> {
            Box::pin(async { Ok(json!({ "ok": true })) })
        }
    }
    let request = AgentRequest {
        preset_id: "p".into(),
        prompt: String::new(),
        schema: json!({}),
        tools: vec![],
        access: Access::Sealed,
        session: None,
        workspace: None,
        repo: None,
        run_id: None,
        mcp_config: None,
        plugin_dirs: vec![],
    };
    let (reply, cost) = Plain.run_metered(request).await;
    assert_eq!(reply.unwrap(), json!({ "ok": true }));
    assert_eq!(cost, None);
}

/// A review that reads GitHub cannot start without Lotus's MCP server in the CLI's config: it
/// would run blind. It fails before any agent starts, naming what to do.
#[tokio::test]
async fn a_review_without_the_lotus_mcp_server_fails_before_the_agent_starts() {
    use lotus_automation::agent::{Access, AgentRequest, AgentRunner, CliAgentRunner, Preset};
    use std::sync::Arc;
    let lookup = Arc::new(|_: &str| Some(Preset { agent: "claude".into(), args: String::new(), ..Default::default() }));
    let env = std::collections::HashMap::from([("PATH".to_string(), String::new())]);
    let runner = CliAgentRunner::new(lookup, env).with_review_mcp("/nope/.claude.json".into(), "lotus-dev");
    let message = runner
        .run(AgentRequest {
            preset_id: "p".into(),
            prompt: "x".into(),
            schema: json!({"type":"object"}),
            tools: vec![],
            access: Access::ReadOnly { mcp_tools: vec![], github_account: Some("alwisofwan1".into()), run_tests: false },
            session: None,
            workspace: None,
            repo: None,
            run_id: None,
            mcp_config: None,
            plugin_dirs: vec![],
        })
        .await
        .unwrap_err();
    assert!(message.contains("lotus-dev") && message.contains("restart Lotus"), "{message}");
}

/// FI4: a Factory agent's kit replaces every MCP config (the preset's, a fence's) with its own
/// file under `--strict-mcp-config`, and loads its skills plugin.
#[test]
fn a_kit_replaces_every_mcp_config_and_adds_its_plugins() {
    use lotus_automation::agent::{build_full_agent_command, with_kit, Preset};
    use std::path::{Path, PathBuf};
    let preset = Preset {
        agent: "claude".into(),
        args: "--model opus --mcp-config /home/a.json /home/b.json --strict-mcp-config --mcp-config=/home/c.json --verbose".into(),
        ..Default::default()
    };
    let cmd = build_full_agent_command(&preset, &json!({}), "s").unwrap();
    let cmd = with_kit(cmd, Some(Path::new("/kit/mcp.json")), &[PathBuf::from("/kit/plugin")]);
    let line = cmd.args.join(" ");
    assert!(!line.contains("/home/"), "the preset's servers are gone: {line}");
    assert_eq!(cmd.args.iter().filter(|a| *a == "--strict-mcp-config").count(), 1, "{line}");
    assert!(line.contains("--strict-mcp-config --mcp-config /kit/mcp.json") && line.contains("--plugin-dir /kit/plugin"), "{line}");
    assert!(line.contains("--model opus"), "other flags stay: {line}");

    // No kit: nothing changes.
    let plain = build_full_agent_command(&preset, &json!({}), "s").unwrap();
    assert_eq!(with_kit(plain.clone(), None, &[]), plain);
}

/// The test-run switch opens the package registries only (ADR-0052 §6, proven live 2026-10-08).
#[test]
fn a_review_that_runs_tests_reaches_the_registries_and_nothing_else() {
    use lotus_automation::agent::{review_settings, TEST_CACHE_ENV};
    let on = review_settings(true, &["/w".to_string()]);
    assert_eq!(on["sandbox"]["network"]["allowedDomains"], json!(["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"]));
    // The PR's code runs and npm can publish: the whole home folder is closed but for the scope.
    assert_eq!(on["sandbox"]["filesystem"]["denyRead"][0], "~");
    assert_eq!(on["sandbox"]["filesystem"]["allowRead"], json!(["/w"]));
    // Everything else is the same fence: secrets hidden, no command outside the sandbox.
    let mut off = review_settings(false, &[]);
    off["sandbox"]["network"]["allowedDomains"] = on["sandbox"]["network"]["allowedDomains"].clone();
    off["sandbox"]["filesystem"] = on["sandbox"]["filesystem"].clone();
    assert_eq!(on, off);
    // The sandbox refuses ~/.npm: every cache lives in the working folder.
    assert!(TEST_CACHE_ENV.iter().all(|(_, rel)| rel.starts_with(".lotus-cache/")));
    assert!(TEST_CACHE_ENV.iter().any(|(k, _)| *k == "npm_config_cache"));
    assert!(TEST_CACHE_ENV.iter().any(|(k, _)| *k == "PIP_CACHE_DIR"));
}

/// What a review that runs tests may read: its worktree, the checkout's git folder, the toolchains
/// in the home folder — an install whole, any other folder only itself (2026-10-08).
#[test]
fn a_review_that_runs_tests_reads_only_its_worktree_its_git_folder_and_toolchains() {
    use lotus_automation::agent::test_read_scope;
    let tmp = tempfile::tempdir().unwrap();
    let home = tmp.path().join("home");
    let wt = home.join(".lotus-review-worktrees/acme-app-7");
    std::fs::create_dir_all(&wt).unwrap();
    std::fs::write(wt.join(".git"), format!("gitdir: {}/work/app/.git/worktrees/acme-app-7\n", home.display())).unwrap();
    let h = home.display();
    let path = format!("{h}/.local/share/mise/installs/node/24.14.1/bin:{h}/.cargo/bin:/usr/bin:/opt/homebrew/bin:{h}/.bun/bin:{h}/.cargo/bin");
    assert_eq!(
        test_read_scope(&wt, &path, &home),
        [
            wt.display().to_string(),
            format!("{h}/work/app/.git"),
            format!("{h}/.local/share/mise/installs/node/24.14.1"),
            format!("{h}/.cargo/bin"),
            format!("{h}/.bun/bin"),
        ]
    );
}

#[test]
fn a_preset_the_host_marked_unavailable_refuses_with_its_reason() {
    let mut p = preset("claude", "");
    p.unavailable = Some("the Claude account \"gone\" is not on this machine".into());
    let err = build_agent_command(&p, &json!({})).unwrap_err();
    assert!(matches!(err, CommandRefusal::Unavailable(_)));
    assert!(err.to_string().contains("gone"));
}

#[test]
fn an_agent_ref_carries_model_effort_and_account_and_refuses_shell_text() {
    use lotus_automation::agent::{parse_agent_ref, set_flag, AgentChoice};
    assert_eq!(parse_agent_ref("p1").unwrap(), ("p1", AgentChoice::default()));
    let (id, c) = parse_agent_ref("p1?model=claude-opus-4[1m]&effort=high&account=acme").unwrap();
    assert_eq!(id, "p1");
    assert_eq!(c.model.as_deref(), Some("claude-opus-4[1m]"));
    assert_eq!(c.effort.as_deref(), Some("high"));
    assert_eq!(c.account.as_deref(), Some("acme"));
    for bad in ["p?model=a b", "p?model=$(x)", "p?effort=a'b", "p?color=red", "p?model"] {
        assert!(parse_agent_ref(bad).is_err(), "{bad}");
    }
    assert_eq!(set_flag("--effort=low -v", "--effort", "high"), "-v --effort high");
}
