pub mod error;
pub mod handlers;
pub mod state;
#[cfg(test)]
pub mod tests_support;

use axum::extract::{DefaultBodyLimit, State};
use axum::routing::{delete, get, patch, post};
use axum::Router;
use serde::Serialize;
use tower_http::cors::CorsLayer;

pub use state::ApiState;

/// Body cap for `POST /api/stt/transcribe`, in bytes of base64.
///
/// Dictation is short by nature: a minute of compressed phone audio is a few
/// hundred KB, and even a minute of 16 kHz PCM is under 2 MB before encoding. 8 MiB
/// leaves generous headroom while keeping a single request's memory bounded — the
/// provider's own 25 MB ceiling (`voice_http::MAX_AUDIO_BYTES`) is a limit on what
/// OpenAI accepts, not a limit worth accepting from the network.
const STT_BODY_LIMIT: usize = 8 * 1024 * 1024;

// ─── Health ───────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct HealthResponse {
    pub ok: bool,
    pub port: u16,
    pub version: &'static str,
}

async fn health(State(state): State<ApiState>) -> axum::Json<HealthResponse> {
    axum::Json(HealthResponse {
        ok: true,
        port: state.port,
        version: env!("CARGO_PKG_VERSION"),
    })
}

// ─── Router ───────────────────────────────────────────────────────────────────

/// The HTTP API port the server binds to.
pub const API_PORT: u16 = 9877;

/// Builds the axum Router.  Call once; keep the result alive as a background
/// task on Tauri's tokio runtime.
///
/// `ApiKey` is injected into every request's extension map so `RequireAuth`
/// (an axum extractor) can retrieve it without touching the typed `State`.
pub fn build_router(state: ApiState) -> Router {
    let api_key = (*state.api_key).clone();

    Router::new()
        // No auth — liveness probe
        .route("/health", get(health))
        // PTY session management
        .route("/api/sessions", get(handlers::sessions::list_sessions))
        .route("/api/sessions", post(handlers::sessions::create_session))
        // axum 0.7 uses matchit 0.7 — path parameter syntax is `:name`, not `{name}`.
        // (axum 0.8 introduces `{name}` via matchit 0.8.)
        .route(
            "/api/sessions/:id",
            delete(handlers::sessions::kill_session),
        )
        .route(
            "/api/sessions/:id/input",
            post(handlers::sessions::write_to_session),
        )
        .route("/api/sessions/:id/size", post(handlers::sessions::hold_size))
        .route(
            "/api/sessions/:id/size/release",
            post(handlers::sessions::release_size),
        )
        .route(
            "/api/sessions/:id/stream",
            get(handlers::sessions::stream_session_output),
        )
        // Agent / process management
        .route("/api/agent/spawn", post(handlers::agents::spawn_agent))
        .route(
            "/api/agent/spawn-pty",
            post(handlers::agents::spawn_agent_pty),
        )
        .route(
            "/api/agent/processes",
            get(handlers::agents::list_processes),
        )
        .route(
            "/api/agent/processes/:pid",
            delete(handlers::agents::kill_process),
        )
        // Fleet — read-only inspector (mutating endpoints land in a later slice)
        .route("/api/hook/drop", post(handlers::hooks::post_hook_drop))
        .route("/api/fleet", get(handlers::fleet::list_fleet))
        .route("/api/fleet/read", post(handlers::fleet::read_cell))
        .route(
            "/api/fleet/scrollback",
            post(handlers::fleet::read_scrollback),
        )
        .route("/api/fleet/dispatch", post(handlers::fleet::dispatch))
        .route("/api/fleet/close", post(handlers::fleet::close_cell))
        .route("/api/fleet/spawn", post(handlers::fleet::spawn_cell))
        // `:pane_id`, not `{pane_id}`: axum 0.7 uses colon syntax, and the brace
        // form matches literally, so the route silently 404s for every real pane.
        .route(
            "/api/fleet/:pane_id/transcript",
            get(handlers::fleet::read_transcript),
        )
        .route(
            "/api/fleet/:pane_id/permission",
            get(handlers::fleet::read_permission),
        )
        // Dictation — audio in, text out. Bodies here are orders of magnitude larger
        // than every other route, so the limit is raised for this one only: axum's
        // 2 MB default would reject a 90-second recording, and lifting it globally
        // would widen every other route with it.
        .route(
            "/api/stt/transcribe",
            post(handlers::stt::transcribe).layer(DefaultBodyLimit::max(STT_BODY_LIMIT)),
        )
        // Workspaces — grouping derived from the fleet snapshot
        .route(
            "/api/workspaces",
            get(handlers::workspaces::list_workspaces),
        )
        // Projects — the registry itself, so a project whose agents have all
        // ended is still reachable from a client (ADR-14). Not a synonym for the
        // route above: that one can only ever list what is running.
        .route("/api/projects", get(handlers::projects::list_projects))
        .route("/api/runners", get(handlers::runners::list_runners))
        // Task CRUD (bridge_tasks persistence)
        .route("/api/tasks", get(handlers::tasks::list_tasks))
        .route("/api/tasks", post(handlers::tasks::create_task))
        .route("/api/tasks/:id", get(handlers::tasks::get_task))
        .route("/api/tasks/:id", patch(handlers::tasks::patch_task))
        .route("/api/tasks/:id", delete(handlers::tasks::cancel_task))
        // Canvas Browser Node — agent-triggered WebView control + annotation pull
        .route("/api/browser/open", post(handlers::browser::open_browser))
        .route(
            "/api/browser/navigate",
            post(handlers::browser::navigate_browser),
        )
        .route(
            "/api/browser/snapshot",
            post(handlers::browser::snapshot_browser),
        )
        .route(
            "/api/browser/search",
            post(handlers::browser::search_browser),
        )
        .route(
            "/api/browser/action",
            post(handlers::browser::action_browser),
        )
        .route("/api/browser/logs", post(handlers::browser::logs_browser))
        .route(
            "/api/browser/annotation/latest",
            get(handlers::browser::get_latest_annotation),
        )
        // Music player wrapper — public localhost HTML so YouTube receives an HTTP Referer.
        .route(
            "/api/music/youtube-player",
            get(handlers::music::youtube_player),
        )
        // Canvas Browser Node — confined local-file serving for `file://` nodes.
        // Unauthenticated (WebView can't send Bearer); secured by per-node token
        // in the path + path re-confinement under the token's allowed root.
        .route(
            "/__local/:token/*path",
            get(handlers::local_files::serve_local_file),
        )
        // Proactive notifications — SSE stream of agent-stop / cell-stalled events
        .route(
            "/api/notifications/stream",
            get(handlers::notifications::stream_notifications),
        )
        // Bridge chat — per-message Claude subprocess (free chat UX)
        .route("/api/bridge/chat", post(handlers::bridge::chat))
        // Inject ApiKey into extensions so RequireAuth extractor can find it,
        // then apply CORS last so it wraps all routes.
        .layer(axum::Extension(api_key))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::sync::{Arc, Mutex};
    use tower::ServiceExt;

    use crate::api_auth::ApiKey;
    use crate::mcp_ipc::{McpFleetMember, McpIpcState};
    use crate::pty::{PtyState, PtyStore};

    fn test_state() -> ApiState {
        let (notification_tx, _) =
            tokio::sync::broadcast::channel(state::NOTIFICATION_CHANNEL_CAPACITY);
        ApiState {
            pty_state: Arc::new(Mutex::new(PtyStore::default())) as PtyState,
            api_key: Arc::new(ApiKey("test-key".to_string())),
            port: API_PORT,
            mcp_state: Arc::new(McpIpcState::new("test-secret".to_string())),
            notification_tx,
            browser_annotations: crate::canvas_browser::CanvasBrowserAnnotationStore::default(),
            browser_results: crate::canvas_browser::CanvasBrowserResultStore::default(),
            canvas_browser_policies:
                crate::canvas_browser_policy::CanvasBrowserPolicyStore::default(),
            canvas_browser_approval_modes:
                crate::canvas_browser_approval::CanvasBrowserApprovalModeStore::default(),
            canvas_browser_approval_gate:
                crate::canvas_browser_approval::CanvasBrowserApprovalGate::default(),
            canvas_browser_local_files:
                crate::canvas_browser_local_files::LocalFileServeStore::default(),
            transcripts: std::sync::Arc::new(std::sync::Mutex::new(
                crate::agent_hooks::TranscriptStore::new(),
            )),
            hook_sink: None,
            app_handle: None,
        }
    }

    fn fleet_member(pane_id: &str, workspace_id: &str, provider: &str) -> McpFleetMember {
        McpFleetMember {
            pane_id: pane_id.to_string(),
            agent_address: None,
            surface: None,
            runtime_id: None,
            team_id: None,
            member_id: None,
            address: None,
            workspace_label: None,
            fleet_schema_version: None,
            workspace_id: workspace_id.to_string(),
            cwd: "/tmp".to_string(),
            provider: provider.to_string(),
            display_name: format!("Cell {pane_id}"),
            legacy_aliases: vec![],
            aliases: vec![],
            status: "idle".to_string(),
            is_alive: true,
            last_output_preview: None,
            headline: None,
            session_id: None,
            can_reply: None,
            can_queue: None,
            mcp_tools_available: None,
            reports_steps: None,
            gating: None,
            runner_label: None,
        }
    }

    #[tokio::test]
    async fn serves_local_file_for_valid_token_without_auth() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let mut f = std::fs::File::create(dir.path().join("index.html")).unwrap();
        f.write_all(b"<h1>local</h1>").unwrap();

        let state = test_state();
        state
            .canvas_browser_local_files
            .register("tok", dir.path().to_path_buf());
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/__local/tok/index.html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let ct = resp
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        assert!(ct.contains("text/html"), "serves html content-type: {ct}");
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&bytes[..], b"<h1>local</h1>");
    }

    #[tokio::test]
    async fn local_file_unknown_token_is_404() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/__local/nope/index.html")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn local_file_traversal_is_404() {
        use std::io::Write;
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let mut f = std::fs::File::create(base.path().join("secret.txt")).unwrap();
        f.write_all(b"top secret").unwrap();

        let state = test_state();
        state
            .canvas_browser_local_files
            .register("tok", root.clone());
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/__local/tok/../secret.txt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_ne!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn health_returns_200_without_auth() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn list_sessions_returns_401_without_auth() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_sessions_returns_200_with_valid_auth() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    async fn post_size(path: &str, body: &str) -> StatusCode {
        build_router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(path)
                    .header("Authorization", "Bearer test-key")
                    .header("Content-Type", "application/json")
                    .body(Body::from(body.to_owned()))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    /// The phone's size routes are reached (ADR-6 addendum 2026-10-05): a zero size is refused
    /// by the handler, not 404'd by the router, and releasing a pane that is gone is a no-op.
    #[tokio::test]
    async fn size_routes_match_and_refuse_a_zero_size() {
        assert_eq!(
            post_size("/api/sessions/s-1/size", r#"{"cols":0,"rows":30}"#).await,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            post_size("/api/sessions/gone/size/release", r#"{"token":3}"#).await,
            StatusCode::OK
        );
    }

    /// Regression: routes using `{id}`/`{pid}` (axum 0.8 syntax) silently
    /// fail to match in axum 0.7 — every parameterized request returns a
    /// routing-level 404 with empty body. We assert the handler is actually
    /// reached by sending a DELETE for a non-existent session: the handler
    /// short-circuits to 204 (idempotent delete), which only happens if the
    /// route matched. A 404 here means the path syntax regressed.
    #[tokio::test]
    async fn parameterized_session_route_matches_real_id() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri("/api/sessions/some-uuid-that-does-not-exist")
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            resp.status(),
            StatusCode::NO_CONTENT,
            "expected handler-level 204; 404 means parameterized route did not match (axum path syntax regression)",
        );
    }

    fn hook_payload(
        pane: &str,
        event: &str,
        target: &str,
        ts: i64,
    ) -> crate::agent_hooks::DropPayload {
        crate::agent_hooks::DropPayload {
            version: 1,
            session_id: Some("s-1".into()),
            agent_type: "claude".into(),
            event: event.into(),
            status: "running".into(),
            title: "Bash".into(),
            body: String::new(),
            user_prompt: String::new(),
            tool_target: target.into(),
            lines_added: None,
            lines_removed: None,
            body_truncated: false,
            transcript_path: String::new(),
            cwd: "/tmp".into(),
            pid: None,
            agent_pid: None,
            pane_id: Some(pane.into()),
            timestamp: ts,
        }
    }

    async fn get_json(app: axum::Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let resp = app
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, json)
    }

    /// The hook says "waiting" but nothing readable is in the tail. `awaiting: true`
    /// with `prompt: null` is the honest answer, and the UI must send the operator
    /// to the terminal rather than show nothing.
    #[tokio::test]
    async fn permission_reports_awaiting_without_a_prompt_when_options_are_unreadable() {
        let state = test_state();
        state.mcp_state.record_hook_turn("p-1", "needs-input", 1);

        let (status, json) = get_json(build_router(state), "/api/fleet/p-1/permission").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["awaiting"], true);
        assert!(json["prompt"].is_null(), "got {json}");
    }

    /// No buttons for a cell that is not waiting, even if its scrollback still
    /// holds an old prompt. Pressing one would write a digit into a running agent.
    #[tokio::test]
    async fn permission_offers_nothing_when_the_hook_says_the_cell_is_not_waiting() {
        let state = test_state();
        state.mcp_state.record_hook_turn("p-1", "working", 1);

        let (_, json) = get_json(build_router(state), "/api/fleet/p-1/permission").await;

        assert_eq!(json["awaiting"], false);
        assert!(json["prompt"].is_null());
    }

    /// A read-back without a prompt would be a sentence about nothing, so the two
    /// travel together or not at all.
    #[tokio::test]
    async fn permission_omits_the_readback_when_there_is_no_prompt() {
        let state = test_state();
        state.mcp_state.record_hook_turn("p-1", "needs-input", 1);

        let (_, json) = get_json(build_router(state), "/api/fleet/p-1/permission").await;

        assert!(json["prompt"].is_null());
        assert!(json.get("readback").is_none(), "got {json}");
    }

    #[tokio::test]
    async fn permission_of_an_unknown_pane_is_not_awaiting_rather_than_a_404() {
        let (status, json) =
            get_json(build_router(test_state()), "/api/fleet/nope/permission").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["awaiting"], false);
    }

    #[tokio::test]
    async fn permission_requires_auth() {
        let resp = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/api/fleet/p-1/permission")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn transcript_returns_recorded_hook_events_oldest_first() {
        let state = test_state();
        {
            let mut store = state.transcripts.lock().unwrap();
            store.record(&hook_payload("p-1", "tool-pre", "rg TODO src/", 1));
            store.record(&hook_payload(
                "p-1",
                "tool-post",
                "rm src/legacy/shim.ts",
                2,
            ));
        }

        let (status, json) = get_json(build_router(state), "/api/fleet/p-1/transcript").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["paneId"], "p-1");
        assert_eq!(json["total"], 2);
        assert_eq!(json["entries"][0]["toolTarget"], "rg TODO src/");
        assert_eq!(json["entries"][1]["toolTarget"], "rm src/legacy/shim.ts");
    }

    /// A cell with no recorded events is normal, not an error: a `codex` cell emits
    /// no hooks at all, and 404 would make the phone render a fault where the truth
    /// is "nothing recorded here".
    #[tokio::test]
    async fn transcript_of_an_unknown_pane_is_an_empty_list_not_a_404() {
        let (status, json) =
            get_json(build_router(test_state()), "/api/fleet/nope/transcript").await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["total"], 0);
        assert_eq!(json["entries"], serde_json::json!([]));
    }

    // Audio is the one payload here that costs money to process, so an unauthenticated
    // caller must be turned away before a provider is ever reached.
    #[tokio::test]
    async fn scrollback_requires_auth() {
        let resp = build_router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/scrollback")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"paneId":"p-1","fromByte":0}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn scrollback_of_an_unknown_pane_is_404() {
        let resp = build_router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/scrollback")
                    .header("Authorization", "Bearer test-key")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"paneId":"nope","fromByte":0}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn transcribe_requires_auth() {
        let resp = build_router(test_state())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/stt/transcribe")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"audioBase64":"","mime":"audio/webm"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn transcript_requires_auth_like_every_other_fleet_route() {
        let resp = build_router(test_state())
            .oneshot(
                Request::builder()
                    .uri("/api/fleet/p-1/transcript")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    /// Pane ids reach this route from a phone, so the path segment must be decoded
    /// rather than matched literally.
    #[tokio::test]
    async fn transcript_decodes_a_percent_encoded_pane_id() {
        let state = test_state();
        state.transcripts.lock().unwrap().record(&hook_payload(
            "node/atlas 1",
            "tool-pre",
            "ls",
            1,
        ));

        let (status, json) = get_json(
            build_router(state),
            "/api/fleet/node%2Fatlas%201/transcript",
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(json["total"], 1, "got {json}");
    }

    #[tokio::test]
    async fn list_fleet_returns_authorized_paginated_members() {
        let state = test_state();
        state.mcp_state.replace_fleet(
            "w-test",
            vec![
                fleet_member("p-1", "ws-a", "claude"),
                fleet_member("p-2", "ws-a", "codex"),
                fleet_member("p-3", "ws-b", "claude"),
            ],
        );
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/fleet")
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let items = json.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 3);
        // Each item exposes paneId + agentType (mapped from provider)
        assert_eq!(items[0]["paneId"], "p-1");
        assert_eq!(items[0]["agentType"], "claude");
        assert_eq!(items[1]["agentType"], "codex");
    }

    #[tokio::test]
    async fn list_fleet_filters_by_workspace_id() {
        let state = test_state();
        state.mcp_state.replace_fleet(
            "w-test",
            vec![
                fleet_member("p-1", "ws-a", "claude"),
                fleet_member("p-2", "ws-b", "claude"),
            ],
        );
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/fleet?workspaceId=ws-a")
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let items = json.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["paneId"], "p-1");
    }

    #[tokio::test]
    async fn list_fleet_paginates_results() {
        let state = test_state();
        state.mcp_state.replace_fleet(
            "w-test",
            (0..25)
                .map(|i| fleet_member(&format!("p-{i}"), "ws", "claude"))
                .collect(),
        );
        let app = build_router(state);

        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/fleet?page=2&pageSize=10")
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let items = json.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 10);
        assert_eq!(items[0]["paneId"], "p-10");
        assert_eq!(json["page"], 2);
        assert_eq!(json["pageSize"], 10);
        assert_eq!(json["total"], 25);
    }

    #[tokio::test]
    async fn dispatch_returns_404_for_unknown_pane() {
        let state = test_state();
        state
            .mcp_state
            .replace_fleet("w-test", vec![fleet_member("p-1", "ws-a", "claude")]);
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/dispatch")
                    .header("Authorization", "Bearer test-key")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"paneId":"unknown","command":"ls"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn dispatch_returns_410_when_cell_has_no_session_id() {
        // Cell exists in fleet but has no live PTY session — treated as "Gone"
        // so the bot's withFocus helper clears the operator's stale paneId.
        let state = test_state();
        state
            .mcp_state
            .replace_fleet("w-test", vec![fleet_member("p-1", "ws-a", "claude")]);
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/dispatch")
                    .header("Authorization", "Bearer test-key")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"paneId":"p-1","command":"ls"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::GONE);
    }

    #[tokio::test]
    async fn dispatch_returns_401_without_auth() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/dispatch")
                    .body(Body::from(r#"{"paneId":"p-1","command":"ls"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn read_cell_returns_404_for_unknown_pane() {
        let state = test_state();
        state
            .mcp_state
            .replace_fleet("w-test", vec![fleet_member("p-1", "ws-a", "claude")]);
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/read")
                    .header("Authorization", "Bearer test-key")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"paneId":"unknown"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn read_cell_returns_empty_tail_when_session_id_missing() {
        // A fleet member registered without a runtime session id has no PTY
        // attached yet; the endpoint should succeed with an empty tail rather
        // than 404 (the cell exists, it just has no output yet).
        let state = test_state();
        state
            .mcp_state
            .replace_fleet("w-test", vec![fleet_member("p-1", "ws-a", "claude")]);
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/read")
                    .header("Authorization", "Bearer test-key")
                    .header("Content-Type", "application/json")
                    .body(Body::from(r#"{"paneId":"p-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["paneId"], "p-1");
        assert_eq!(json["tail"], "");
        assert_eq!(json["bytes"], 0);
    }

    #[tokio::test]
    async fn read_cell_returns_401_without_auth() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/read")
                    .body(Body::from(r#"{"paneId":"p-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_workspaces_groups_fleet_by_workspace_id() {
        let state = test_state();
        state.mcp_state.replace_fleet(
            "w-test",
            vec![
                fleet_member("p-1", "ws-a", "claude"),
                fleet_member("p-2", "ws-a", "codex"),
                fleet_member("p-3", "ws-b", "claude"),
            ],
        );
        let app = build_router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/workspaces")
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let items = json.get("items").and_then(|v| v.as_array()).unwrap();
        assert_eq!(items.len(), 2);
        // Sorted alphabetically by workspaceId for stable rendering.
        assert_eq!(items[0]["workspaceId"], "ws-a");
        assert_eq!(items[0]["cellCount"], 2);
        assert_eq!(items[1]["workspaceId"], "ws-b");
        assert_eq!(items[1]["cellCount"], 1);
    }

    #[tokio::test]
    async fn list_workspaces_returns_401_without_auth() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_fleet_returns_401_without_auth() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/fleet")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn list_sessions_returns_empty_array_on_fresh_store() {
        let app = build_router(test_state());
        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/sessions")
                    .header("Authorization", "Bearer test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let sessions: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
        assert!(sessions.is_empty());
    }

    // ── Hook drop over HTTP (tiket 08) ───────────────────────────────────────

    /// A sink that only records, so a test can ask "did the two paths do the same thing?"
    #[derive(Default)]
    struct RecordingSink(std::sync::Mutex<Vec<crate::agent_hooks::DropPayload>>);

    impl crate::agent_hooks::HookEventSink for RecordingSink {
        fn emit_hook(&self, payload: &crate::agent_hooks::DropPayload) {
            self.0.lock().unwrap_or_else(|e| e.into_inner()).push(payload.clone());
        }
    }

    fn hook_body(pane: &str) -> String {
        serde_json::json!({
            "version": 1,
            "sessionId": "sess-1",
            "agentType": "claude",
            "event": "stop",
            "status": "idle",
            "title": "Selesai",
            "body": "sudah saya kerjakan",
            "userPrompt": "tolong kerjakan",
            "paneId": pane,
            "cwd": "/srv/devbox/api",
            "pid": 1234,
            "agentPid": 1235,
            "timestamp": 1_700_000_000_000i64,
        })
        .to_string()
    }

    async fn post_hook(state: ApiState, body: String, auth: Option<&str>) -> axum::http::Response<Body> {
        let mut request = Request::builder().method("POST").uri("/api/hook/drop");
        if let Some(token) = auth {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        build_router(state)
            .oneshot(request.body(Body::from(body)).unwrap())
            .await
            .unwrap()
    }

    /// The claim this whole route rests on: a payload that arrives over HTTP reaches the sink
    /// exactly as one dropped on disk does. If these two ever diverge, a remote agent stops
    /// behaving like a local one and nothing else would say so.
    #[tokio::test]
    async fn a_hook_over_http_reaches_the_sink_exactly_as_a_dropped_file_does() {
        let sink = std::sync::Arc::new(RecordingSink::default());
        let mut state = test_state();
        state.hook_sink = Some(sink.clone() as std::sync::Arc<dyn crate::agent_hooks::HookEventSink>);

        let resp = post_hook(state, hook_body("pane-remote"), Some("test-key")).await;
        assert_eq!(resp.status(), StatusCode::OK);

        // The same bytes, through the file path's parser and the same sink.
        let dropped = crate::agent_hooks::parse_drop_payload(hook_body("pane-remote").as_bytes())
            .expect("drop parses");
        {
            use crate::agent_hooks::HookEventSink;
            sink.emit_hook(&dropped);
        }

        let seen = sink.0.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert_eq!(seen[0], seen[1], "HTTP and drop-file must produce an identical payload");
        assert_eq!(seen[0].pane_id.as_deref(), Some("pane-remote"));
    }

    #[tokio::test]
    async fn a_hook_without_the_bearer_is_refused() {
        let sink = std::sync::Arc::new(RecordingSink::default());
        let mut state = test_state();
        state.hook_sink = Some(sink.clone() as std::sync::Arc<dyn crate::agent_hooks::HookEventSink>);

        let resp = post_hook(state, hook_body("pane-1"), None).await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert!(sink.0.lock().unwrap().is_empty(), "nothing may reach the sink unauthenticated");
    }

    /// The body comes from a shell script on someone else's machine, so a malformed one is an
    /// expected input rather than a fault here — and the message has to name the problem, because
    /// the only person who can fix it is reading curl's output.
    #[tokio::test]
    async fn an_unreadable_hook_is_a_bad_request_not_a_server_fault() {
        let sink = std::sync::Arc::new(RecordingSink::default());
        let mut state = test_state();
        state.hook_sink = Some(sink.clone() as std::sync::Arc<dyn crate::agent_hooks::HookEventSink>);

        let resp = post_hook(state, "{\"version\":9,\"agentType\":\"claude\"}".to_string(), Some("test-key")).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(sink.0.lock().unwrap().is_empty());
    }

    /// Saying "hooks are not running" beats accepting the report and dropping it on the floor.
    #[tokio::test]
    async fn a_desktop_without_hooks_running_says_so() {
        let resp = post_hook(test_state(), hook_body("pane-1"), Some("test-key")).await;
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
