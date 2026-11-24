//! `/v1/automation`: the MCP tools `lotus_automation_*` (PLAN §2.5, slice 06).
//!
//! Two rules hold here whatever the agent sends:
//! - An agent an automation started (it carries `LOTUS_AUTOMATION_RUN`, which the
//!   sidecar forwards as [`AUTOMATION_RUN_HEADER`]) is refused outright (Q34).
//! - Nothing written here is ever switched on. `create` and `update` save the
//!   automation OFF; only the user's "Turn on" in the panel enables it.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tauri::Manager;

use crate::automation_host::AutomationRuntime;
use crate::mcp_ipc::{check_auth, SharedState};

const SKILL: &str = include_str!("../../scripts/lotus-automation-skill.md");

/// Writes the `lotus-automation` skill where Claude Code finds it, so any
/// agent (Bridge, a pane) knows the kinds and the "saved OFF" rule.
pub fn install_skill() -> std::io::Result<std::path::PathBuf> {
    let dir = crate::paths::claude_dir().join("skills").join("lotus-automation");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("SKILL.md");
    std::fs::write(&path, SKILL)?;
    Ok(path)
}

const SWARM_SKILL: &str = include_str!("../../scripts/lotus-swarm-skill.md");

/// Writes the `/swarm` skill (ADR-0066: delegate + verify, no Board) where both Chat agents find
/// it: Claude Code reads `~/.claude/skills`, Codex reads `~/.agents/skills`.
pub fn install_swarm_skill() -> std::io::Result<()> {
    let home = crate::paths::home_dir();
    for root in [crate::paths::claude_dir(), home.join(".agents")] {
        let dir = root.join("skills").join("swarm");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), SWARM_SKILL)?;
    }
    Ok(())
}

/// Sent by the sidecar when its process carries `LOTUS_AUTOMATION_RUN`.
pub const AUTOMATION_RUN_HEADER: &str = "x-lotus-automation-run";

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum AutomationRequest {
    List,
    Options,
    Create { automation: serde_json::Value },
    Update { id: String, automation: serde_json::Value },
    Delete { id: String },
}

fn refuse(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "ok": false, "error": message.into() }))).into_response()
}

fn done(result: Result<serde_json::Value, String>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(e) => refuse(StatusCode::BAD_REQUEST, e),
    }
}

pub async fn automation(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    if headers.contains_key(AUTOMATION_RUN_HEADER) {
        return refuse(
            StatusCode::FORBIDDEN,
            "automations cannot create, change or delete automations (this agent was started by one)",
        );
    }
    let request: AutomationRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, format!("request: {e}")),
    };
    let Some(app) = state.app_handle() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Lotus is still starting");
    };
    let Some(runtime) = app.try_state::<AutomationRuntime>() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "the automation engine did not start; see the Lotus log");
    };
    let proposal = |value| lotus_automation::authoring::parse_proposal(value);
    // Google outputs are readied first (connected? a "new" sheet made), as from the panel.
    let request = match request {
        AutomationRequest::Create { automation } => match google_ready(&runtime, automation).await {
            Ok(automation) => AutomationRequest::Create { automation },
            Err(e) => return done(Err(e)),
        },
        AutomationRequest::Update { id, automation } => match google_ready(&runtime, automation).await {
            Ok(automation) => AutomationRequest::Update { id, automation },
            Err(e) => return done(Err(e)),
        },
        other => other,
    };
    done(match request {
        AutomationRequest::List => runtime.list_automations().map(|all| serde_json::json!({ "ok": true, "automations": all })),
        AutomationRequest::Options => Ok(serde_json::json!({ "ok": true, "options": runtime.authoring_options().await })),
        AutomationRequest::Create { automation } => proposal(automation).and_then(|p| runtime.propose(p)).map(|created| {
            serde_json::json!({
                "ok": true,
                "automation": created,
                "next": "Saved OFF. Tell the user to review it and press Turn on in the Automation panel.",
            })
        }),
        AutomationRequest::Update { id, automation } => proposal(automation).and_then(|p| runtime.revise(&id, p)).map(|revised| {
            serde_json::json!({
                "ok": true,
                "automation": revised,
                "next": "Saved and switched OFF. The user turns it on again in the Automation panel.",
            })
        }),
        AutomationRequest::Delete { id } => runtime.delete_automation(&id).map(|deleted| serde_json::json!({ "ok": true, "deleted": deleted })),
    })
}

async fn google_ready(runtime: &AutomationRuntime, mut automation: serde_json::Value) -> Result<serde_json::Value, String> {
    let kind = automation["kind"].as_str().unwrap_or_default().to_string();
    if let Some(form) = automation.get_mut("form") {
        runtime.google_prepare_form(&kind, form).await?;
    }
    Ok(automation)
}

/// `/v1/automation-submit`: the agent in a run's pane hands its result back
/// (the `lotus_automation_submit` tool). The one automation call a run's agent
/// may make, so [`AUTOMATION_RUN_HEADER`] is expected here, not refused. The
/// token is the run's session id: unguessable, and good for one waiting run.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SubmitRequest {
    token: String,
    result: serde_json::Value,
}

pub async fn automation_submit(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let request: SubmitRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, format!("request: {e}")),
    };
    if !request.result.is_object() {
        return refuse(StatusCode::BAD_REQUEST, "result: must be an object");
    }
    let Some(app) = state.app_handle() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Lotus is still starting");
    };
    let Some(runtime) = app.try_state::<AutomationRuntime>() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "the automation engine did not start; see the Lotus log");
    };
    match runtime.submit(&request.token, request.result) {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "next": "Submitted. Lotus shows it to the user in the Automation Inbox; they decide what is sent.",
        }))
        .into_response(),
        // A result that breaks the run's schema: the run still waits for a fixed one.
        Err(e) if e.starts_with(lotus_automation::pane::NOT_SUBMITTED) => refuse(StatusCode::BAD_REQUEST, e),
        Err(e) => refuse(StatusCode::NOT_FOUND, e),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GithubReadRequest {
    account: String,
    path: String,
    #[serde(default)]
    paginate: bool,
}

/// `/v1/github-read`: the MCP tool `lotus_github_read`, a PR review agent's only way to GitHub
/// (ADR-0052 §3, revised 2026-10-08). Lotus runs `GET <path>` with the gh login the automation acts
/// as, outside the agent's sandbox; the agent never holds a token. GET changes nothing on GitHub.
pub async fn github_read(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let request: GithubReadRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, format!("request: {e}")),
    };
    let Some(app) = state.app_handle() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Lotus is still starting");
    };
    let Some(runtime) = app.try_state::<AutomationRuntime>() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "the automation engine did not start; see the Lotus log");
    };
    match runtime.github_read(&request.account, &request.path, request.paginate).await {
        Ok(body) => Json(serde_json::json!({ "ok": true, "body": body })).into_response(),
        Err(e) => refuse(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(serde::Deserialize)]
struct NotionReadRequest {
    reference: String,
}

/// `/v1/notion-read`: the MCP tool `lotus_notion_read` (ADR-0052 §4). Lotus reads the page with the
/// connected Notion token, outside the agent's sandbox; the agent never holds it. Never a write.
pub async fn notion_read(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let request: NotionReadRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, format!("request: {e}")),
    };
    let Some(app) = state.app_handle() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Lotus is still starting");
    };
    let Some(notion) = app.try_state::<crate::notion_host::NotionHost>() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Notion is not available in this Lotus");
    };
    match notion.read_for_review(&request.reference).await {
        Ok(body) => Json(serde_json::json!({ "ok": true, "body": body })).into_response(),
        Err(e) => refuse(StatusCode::BAD_REQUEST, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn headers(extra: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer tok".parse().unwrap());
        for (k, v) in extra {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    async fn call(h: HeaderMap, body: serde_json::Value) -> (StatusCode, String) {
        let state: SharedState = Arc::new(crate::mcp_ipc::McpIpcState::new("tok".into()));
        let resp = automation(State(state), h, Json(body)).await;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[test]
    fn the_skill_names_every_kind_and_the_off_rule() {
        for kind in lotus_automation::authoring::KINDS {
            assert!(SKILL.contains(&format!("`{kind}`")), "skill misses {kind}");
        }
        assert!(SKILL.starts_with("---\nname: lotus-automation\n"));
        assert!(SKILL.contains("saved OFF"));
        for tool in ["options", "list", "create", "update", "delete"] {
            assert!(SKILL.contains(&format!("lotus_automation_{tool}")), "skill misses {tool}");
        }
    }

    #[test]
    fn the_skill_teaches_the_fields_and_habits_the_engine_relies_on() {
        // C14: list first, and an update resends what it does not change.
        let list = SKILL.find("1. Call `lotus_automation_list`").expect("list is step 1");
        let options = SKILL.find("2. Call `lotus_automation_options`").expect("options is step 2");
        assert!(list < options);
        assert!(SKILL.contains("send **every field again, unchanged**"));
        // G8: the prompt is rewritten and shown in full before saving.
        assert!(SKILL.contains("## Writing the prompt") && SKILL.contains("**full\n   prompt text**"));
        // G9: what options now returns, and the project the agent may set.
        for field in ["`timezone`", "`projects`", "`mcpServers`", "`slack.warning`", "`workspaceId`"] {
            assert!(SKILL.contains(field), "skill misses {field}");
        }
        // Tasks 2 and 3: the run contract the prompt should lean on.
        for field in ["`severity`", "`nothing_to_report`", "`mcpTools`", "Automation Ask"] {
            assert!(SKILL.contains(field), "skill misses {field}");
        }
    }

    #[tokio::test]
    async fn an_agent_started_by_an_automation_is_refused_before_anything_runs() {
        let (status, body) =
            call(headers(&[(AUTOMATION_RUN_HEADER, "1")]), serde_json::json!({ "action": "create", "automation": {} })).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(body.contains("automations cannot create"), "{body}");
    }

    #[tokio::test]
    async fn the_guard_holds_for_reads_too() {
        let (status, _) = call(headers(&[(AUTOMATION_RUN_HEADER, "1")]), serde_json::json!({ "action": "list" })).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn a_missing_secret_is_refused() {
        let (status, _) = call(HeaderMap::new(), serde_json::json!({ "action": "list" })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn an_unknown_action_is_refused_by_name() {
        let (status, body) = call(headers(&[]), serde_json::json!({ "action": "enable", "id": "x" })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("enable"), "{body}");
    }

    #[tokio::test]
    async fn there_is_no_way_to_switch_an_automation_on_from_here() {
        let (status, body) =
            call(headers(&[]), serde_json::json!({ "action": "update", "id": "x", "automation": {}, "enabled": true })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(body.contains("enabled"), "{body}");
    }

    async fn submit(h: HeaderMap, body: serde_json::Value) -> (StatusCode, String) {
        let state: SharedState = Arc::new(crate::mcp_ipc::McpIpcState::new("tok".into()));
        let resp = automation_submit(State(state), h, Json(body)).await;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn a_run_agent_may_submit_its_result_the_one_automation_call_it_is_allowed() {
        // Past the guard: without a running app this stops at "still starting", not at 403.
        let (status, body) =
            submit(headers(&[(AUTOMATION_RUN_HEADER, "1")]), serde_json::json!({ "token": "t", "result": { "text": "x" } })).await;
        assert_ne!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    }

    #[tokio::test]
    async fn a_submit_needs_the_secret_a_token_and_an_object() {
        let (status, _) = submit(HeaderMap::new(), serde_json::json!({ "token": "t", "result": {} })).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = submit(headers(&[]), serde_json::json!({ "result": {} })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = submit(headers(&[]), serde_json::json!({ "token": "t", "result": "text" })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
}
