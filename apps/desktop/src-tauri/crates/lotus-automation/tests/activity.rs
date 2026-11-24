use std::path::Path;

use lotus_automation::activity::describe_event;
use serde_json::{json, Value};

fn tool(name: &str, input: Value) -> Value {
    json!({ "type": "assistant", "message": { "content": [{ "type": "tool_use", "name": name, "input": input }] } })
}

#[test]
fn each_tool_call_reads_as_one_short_plain_step() {
    let cwd = Path::new("/work/acme-web");
    let cases = [
        (tool("Bash", json!({ "command": "gh pr diff 2506 -R acme/acme-web", "description": "Read the PR diff" })), "Read the PR diff"),
        (tool("Bash", json!({ "command": "git log -5 --oneline" })), "Ran `git log -5 --oneline`"),
        (tool("Read", json!({ "file_path": "/work/acme-web/src/app.ts" })), "Read src/app.ts"),
        (tool("Read", json!({ "file_path": "/elsewhere/notes.md" })), "Read /elsewhere/notes.md"),
        (tool("Grep", json!({ "pattern": "HubspotValueMapping", "path": "src" })), "Searched for `HubspotValueMapping`"),
        (tool("Glob", json!({ "pattern": "**/*.ts" })), "Looked for files `**/*.ts`"),
        (tool("Skill", json!({ "skill": "code-review" })), "Used the skill code-review"),
        (tool("WebSearch", json!({ "query": "hubspot api limits" })), "Searched the web for `hubspot api limits`"),
        (tool("mcp__context7__query-docs", json!({})), "Used context7: query-docs"),
        (tool("mcp__lotus-dev__lotus_automation_submit", json!({ "summary": "x" })), "Handed the result to Lotus"),
        (
            tool("mcp__lotus__lotus_github_read", json!({ "path": "/repos/acme/acme-api/pulls/3019/files?per_page=100" })),
            "Read GitHub acme-api#3019 files",
        ),
        (tool("mcp__lotus-dev__lotus_github_read", json!({ "path": "/repos/acme/acme-docs/pulls/388" })), "Read GitHub acme-docs#388"),
        (
            tool("mcp__lotus__lotus_github_read", json!({ "path": "/repos/acme/acme-docs/contents/architecture/api.md?ref=main" })),
            "Read GitHub acme-docs: architecture/api.md",
        ),
        (tool("mcp__lotus__lotus_github_read", json!({ "path": "/search/issues?q=x" })), "Read GitHub /search/issues"),
        (tool("mcp__lotus__lotus_notion_read", json!({ "reference": "TKT-1234" })), "Read Notion TKT-1234"),
        (tool("mcp__lotus__lotus_notion_read", json!({ "reference": "https://www.notion.so/x-1f2e" })), "Read a Notion page"),
        (tool("StructuredOutput", json!({ "summary": "x" })), "Wrote the result"),
        (tool("Task", json!({})), "Used Task"),
    ];
    for (event, want) in cases {
        assert_eq!(describe_event(&event, cwd), vec![want.to_string()], "{event}");
    }
}

#[test]
fn a_long_command_is_cut_to_one_line() {
    let long = format!("git show FETCH_HEAD:src/a.ts | sed -n 1,20p\n{}", "x".repeat(200));
    let steps = describe_event(&tool("Bash", json!({ "command": long })), Path::new("/"));
    assert!(steps[0].starts_with("Ran `git show FETCH_HEAD:src/a.ts | sed -n 1,20p"), "{steps:?}");
    assert!(!steps[0].contains('\n') && steps[0].chars().count() <= 100, "{steps:?}");
}

#[test]
fn thinking_text_tool_search_and_bookkeeping_are_not_steps() {
    let cwd = Path::new("/");
    for event in [
        json!({ "type": "system", "subtype": "init" }),
        json!({ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "" }] } }),
        json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "Found it." }] } }),
        tool("ToolSearch", json!({ "query": "select:x" })),
        json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "content": "ok" }] } }),
        json!({ "type": "result", "subtype": "success" }),
        json!("not an object"),
    ] {
        assert!(describe_event(&event, cwd).is_empty(), "{event}");
    }
}

#[test]
fn the_log_keeps_each_runs_latest_steps_for_a_few_recent_runs() {
    use lotus_automation::activity::{ActivityLog, Step};
    let log = ActivityLog::new(3, 2);
    for i in 0..5 {
        log.push("r1", i, format!("step {i}"));
    }
    assert_eq!(
        log.steps("r1"),
        vec![Step { at_ms: 2, text: "step 2".into() }, Step { at_ms: 3, text: "step 3".into() }, Step { at_ms: 4, text: "step 4".into() }],
        "the latest few steps of a run"
    );
    log.push("r2", 10, "a".into());
    log.push("r3", 11, "b".into());
    assert!(log.steps("r1").is_empty(), "the oldest run is forgotten first");
    assert_eq!(log.steps("r3").len(), 1);
    assert!(log.steps("unknown").is_empty());
}

#[test]
fn a_tool_the_read_only_run_refused_is_a_step_too_so_nobody_wonders_why() {
    let refused = json!({ "type": "user", "message": { "content": [{
        "type": "tool_result",
        "is_error": true,
        "content": "Permission to use Write has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* ..."
    }] } });
    assert_eq!(describe_event(&refused, Path::new("/")), vec!["Not allowed: Write (the run only reads)".to_string()]);
    let as_blocks = json!({ "type": "user", "message": { "content": [{
        "type": "tool_result", "is_error": true, "content": [{ "type": "text", "text": "Permission to use Bash has been denied because …" }]
    }] } });
    assert_eq!(describe_event(&as_blocks, Path::new("/")), vec!["Not allowed: Bash (the run only reads)".to_string()]);
    let other_error = json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "is_error": true, "content": "exit 1" }] } });
    assert!(describe_event(&other_error, Path::new("/")).is_empty());
}
