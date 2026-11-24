//! `/v1/factory/save-spec`: the MCP tool `lotus_factory_save_spec` (FI2, Brainstorm live).
//!
//! The agent the user grills with saves the spec it wrote onto the Factory Run waiting for it, as the
//! same fields the async spec agent returns; Lotus checks and renders it. Saving never starts the build: the run keeps waiting until the user presses
//! Approve in the Factory panel. An agent an automation started is refused.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use lotus_graph_run::{DecisionError, IntakeDecision, SpecDoc};
use serde::Deserialize;
use tauri::Manager;

use crate::graph_run_host::GraphRunHost;
use crate::mcp_automation::AUTOMATION_RUN_HEADER;
use crate::mcp_ipc::{check_auth, SharedState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveSpecRequest {
    run_id: String,
    spec: serde_json::Value,
}

/// The spec as Lotus renders it: the same fields the async spec agent returns. Markdown is refused
/// with what to send instead, so an agent still on the old form can correct itself.
fn spec_doc(spec: serde_json::Value) -> Result<SpecDoc, String> {
    if spec.is_string() {
        return Err("spec is an object now, not markdown: { goal, acceptance_criteria, out_of_scope, assumptions, test_plan, files, \
                    clarifications: [{ question, answer }] }. Lotus numbers the criteria and writes the markdown"
            .into());
    }
    serde_json::from_value(spec).map_err(|e| format!("spec: {e}"))
}

fn refuse(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "ok": false, "error": message.into() }))).into_response()
}

/// What the agent is told when the engine says no.
fn refusal(error: DecisionError) -> Response {
    match error {
        DecisionError::UnknownRun(_) => refuse(StatusCode::NOT_FOUND, "no Factory Run with that id"),
        DecisionError::NotWaiting | DecisionError::NotPaused => refuse(
            StatusCode::CONFLICT,
            "that Factory Run is not waiting for a spec: it was approved, aborted, or is working",
        ),
        DecisionError::Invalid(why) => refuse(StatusCode::BAD_REQUEST, why),
        DecisionError::Store(why) => refuse(StatusCode::INTERNAL_SERVER_ERROR, why),
    }
}

pub async fn save_spec(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    if headers.contains_key(AUTOMATION_RUN_HEADER) {
        return refuse(StatusCode::FORBIDDEN, "an agent an automation started cannot write a Factory spec");
    }
    let request: SaveSpecRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(e) => return refuse(StatusCode::BAD_REQUEST, format!("request: {e}")),
    };
    let doc = match spec_doc(request.spec) {
        Ok(doc) => doc,
        Err(why) => return refuse(StatusCode::BAD_REQUEST, why),
    };
    let Some(app) = state.app_handle() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Lotus is still starting");
    };
    let Some(host) = app.try_state::<GraphRunHost>() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "the graph run engine did not start; see the Lotus log");
    };
    match host.engine.decide(&request.run_id, IntakeDecision::SaveSpec(doc)).await {
        Ok(()) => Json(serde_json::json!({
            "ok": true,
            "next": "Saved on the run. The user reads it in the Factory panel and presses Approve; nothing is built before that.",
        }))
        .into_response(),
        Err(e) => refusal(e),
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
        let resp = save_spec(State(state), h, Json(body)).await;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8_lossy(&bytes).into_owned())
    }

    #[tokio::test]
    async fn a_wrong_secret_an_automation_agent_and_a_bad_body_are_refused_before_the_engine() {
        let mut wrong = HeaderMap::new();
        wrong.insert("authorization", "Bearer nope".parse().unwrap());
        let body = serde_json::json!({ "runId": "r", "spec": { "goal": "g", "acceptance_criteria": ["a"] } });
        assert_eq!(call(wrong, body.clone()).await.0, StatusCode::UNAUTHORIZED);

        let (status, text) = call(headers(&[(AUTOMATION_RUN_HEADER, "1")]), body.clone()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{text}");

        let (status, text) = call(headers(&[]), serde_json::json!({ "runId": "r" })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");
        assert!(text.contains("spec"), "{text}");
        let (status, _) = call(headers(&[]), serde_json::json!({ "runId": "r", "spec": body["spec"], "approve": true })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "an agent cannot sneak an approval in");

        let (status, text) = call(headers(&[]), serde_json::json!({ "runId": "r", "spec": "# Spec in markdown" })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(text.contains("not markdown") && text.contains("acceptance_criteria"), "{text}");
        let (status, text) = call(headers(&[]), serde_json::json!({ "runId": "r", "spec": { "goal": "g" } })).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{text}");

        // A good request with no app yet: refused, never half-done.
        assert_eq!(call(headers(&[]), body).await.0, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn each_engine_refusal_tells_the_agent_what_happened() {
        let status = |e| refusal(e).status();
        assert_eq!(status(DecisionError::UnknownRun("r".into())), StatusCode::NOT_FOUND);
        assert_eq!(status(DecisionError::NotWaiting), StatusCode::CONFLICT);
        assert_eq!(status(DecisionError::Invalid("the spec needs 1 to 65536 characters".into())), StatusCode::BAD_REQUEST);
    }
}
