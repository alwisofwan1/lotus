//! Task CRUD HTTP handlers — thin wrappers around `bridge_tasks`.
//!
//! Routes:
//!   GET    /api/tasks?workspaceId=&status=&page=&pageSize=
//!   POST   /api/tasks
//!   GET    /api/tasks/:id?workspaceId=
//!   PATCH  /api/tasks/:id
//!   DELETE /api/tasks/:id?workspaceId=   (sets status=cancelled)

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::api_server::state::ApiState;
use crate::bridge_tasks::{
    self, BridgeTask, BridgeTaskStatus, CreateBridgeTaskInput, TaskListFilter,
    UpdateBridgeTaskPatch,
};

const DEFAULT_PAGE_SIZE: usize = 10;
const MAX_PAGE_SIZE: usize = 100;

// ─── List tasks ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksQuery {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub status: Option<BridgeTaskStatus>,
    #[serde(default)]
    pub page: Option<usize>,
    #[serde(default)]
    pub page_size: Option<usize>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTasksResponse {
    pub items: Vec<BridgeTask>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

pub async fn list_tasks(
    State(_state): State<ApiState>,
    _: RequireAuth,
    Query(q): Query<ListTasksQuery>,
) -> Result<Json<ListTasksResponse>, ApiError> {
    let workspace_id = q.workspace_id.as_deref().unwrap_or("").trim().to_string();
    if workspace_id.is_empty() {
        return Err(ApiError::bad_request("workspaceId query param is required"));
    }

    let filter = TaskListFilter {
        status: q.status,
        assignee: None,
    };

    let all = bridge_tasks::list_tasks(&workspace_id, filter).map_err(|e| map_task_err(e))?;

    let total = all.len();
    let page = q.page.unwrap_or(1).max(1);
    let page_size = q
        .page_size
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let offset = (page - 1).saturating_mul(page_size);
    let items = all.into_iter().skip(offset).take(page_size).collect();

    Ok(Json(ListTasksResponse {
        items,
        total,
        page,
        page_size,
    }))
}

// ─── Create task ──────────────────────────────────────────────────────────────

pub async fn create_task(
    State(state): State<ApiState>,
    _: RequireAuth,
    Json(input): Json<CreateBridgeTaskInput>,
) -> Result<(StatusCode, Json<BridgeTask>), ApiError> {
    let task = match state.mcp_state.task_base_override() {
        Some(base) => bridge_tasks::create_task_in(&base, input),
        None => bridge_tasks::create_task(input),
    }
    .map_err(map_task_err)?;
    announce(&state, &task);
    Ok((StatusCode::CREATED, Json(task)))
}

// ─── Get task ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWorkspaceQuery {
    pub workspace_id: String,
}

pub async fn get_task(
    State(_state): State<ApiState>,
    _: RequireAuth,
    Path(task_id): Path<String>,
    Query(q): Query<TaskWorkspaceQuery>,
) -> Result<Json<BridgeTask>, ApiError> {
    let task = bridge_tasks::get_task(&q.workspace_id, &task_id)
        .map_err(map_task_err)?
        .ok_or_else(|| ApiError::not_found(format!("task {task_id}")))?;
    Ok(Json(task))
}

// ─── Patch task ───────────────────────────────────────────────────────────────

pub async fn patch_task(
    State(state): State<ApiState>,
    _: RequireAuth,
    Path(task_id): Path<String>,
    Query(q): Query<TaskWorkspaceQuery>,
    Json(patch): Json<UpdateBridgeTaskPatch>,
) -> Result<Json<BridgeTask>, ApiError> {
    let task = update(&state, &q.workspace_id, &task_id, patch)?;
    announce(&state, &task);
    Ok(Json(task))
}

// ─── Cancel task (DELETE) ─────────────────────────────────────────────────────

pub async fn cancel_task(
    State(state): State<ApiState>,
    _: RequireAuth,
    Path(task_id): Path<String>,
    Query(q): Query<TaskWorkspaceQuery>,
) -> Result<Json<BridgeTask>, ApiError> {
    let patch = UpdateBridgeTaskPatch {
        status: Some(BridgeTaskStatus::Cancelled),
        ..Default::default()
    };
    let task = update(&state, &q.workspace_id, &task_id, patch)?;
    announce(&state, &task);
    Ok(Json(task))
}

fn update(
    state: &ApiState,
    workspace_id: &str,
    task_id: &str,
    patch: UpdateBridgeTaskPatch,
) -> Result<BridgeTask, ApiError> {
    match state.mcp_state.task_base_override() {
        Some(base) => bridge_tasks::update_task_in(&base, workspace_id, task_id, patch),
        None => bridge_tasks::update_task(workspace_id, task_id, patch),
    }
    .map_err(map_task_err)
}

/// An agent's `curl` (the Task Dispatch completion callback, ADR 0021) writes through these routes,
/// so the tracker must hear it exactly as it hears an MCP write — otherwise it repaints only on
/// Refresh.
fn announce(state: &ApiState, task: &BridgeTask) {
    crate::mcp_ipc::announce_task_changed(&state.mcp_state, task);
}

// ─── Error conversion ─────────────────────────────────────────────────────────

fn map_task_err(e: bridge_tasks::BridgeTaskError) -> ApiError {
    use bridge_tasks::BridgeTaskError::*;
    match e {
        NotFound(id) => ApiError::not_found(format!("task {id}")),
        MissingWorkspaceId | MissingTitle | MissingGoal | TitleTooLong(_) | GoalTooLong(_)
        | KnowledgeTooLong(_) | SameWorkspace | WorkspaceOpen(_) => ApiError::bad_request(e.to_string()),
        Persist(p) => ApiError::internal(p.to_string()),
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::{delete, get, patch, post};
    use axum::Router;
    use serde_json::Value;
    use std::sync::Arc;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use std::sync::Mutex;

    use crate::api_auth::ApiKey;
    use crate::api_server::state::ApiState;
    use crate::mcp_ipc::McpIpcState;
    use crate::notification_event::NotificationEvent;
    use crate::pty::{PtyState, PtyStore};

    fn test_router(dir: &TempDir) -> Router {
        let _ = dir;
        let state = test_state();
        Router::new()
            .route("/api/tasks", get(list_tasks))
            .route("/api/tasks", post(create_task))
            .route("/api/tasks/:id", get(get_task))
            .route("/api/tasks/:id", patch(patch_task))
            .route("/api/tasks/:id", delete(cancel_task))
            .layer(axum::Extension((*state.api_key).clone()))
            .with_state(state)
    }

    fn test_state() -> ApiState {
        let pty_state: PtyState = Arc::new(Mutex::new(PtyStore::default()));
        let api_key = Arc::new(ApiKey("test-secret-key".to_string()));
        let mcp_state = Arc::new(McpIpcState::new("test-ipc-secret".to_string()));
        let (notification_tx, _) = tokio::sync::broadcast::channel::<NotificationEvent>(16);
        ApiState {
            pty_state,
            api_key,
            port: crate::api_server::API_PORT,
            mcp_state,
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
            transcripts: Arc::new(Mutex::new(crate::agent_hooks::TranscriptStore::new())),
            hook_sink: None,
            app_handle: None,
        }
    }

    fn auth_header() -> (&'static str, &'static str) {
        ("authorization", "Bearer test-secret-key")
    }

    async fn body_json(resp: axum::response::Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    // ── list_tasks requires workspaceId ──────────────────────────────────────

    #[tokio::test]
    async fn list_tasks_missing_workspace_id_returns_400() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/tasks")
                    .header(auth_header().0, auth_header().1)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    // ── list_tasks returns empty list for unknown workspace ───────────────────

    #[tokio::test]
    async fn list_tasks_empty_workspace_returns_empty_list() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/tasks?workspaceId=ws-new")
                    .header(auth_header().0, auth_header().1)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        let body = body_json(resp).await;
        assert_eq!(body["total"], 0);
        assert!(body["items"].as_array().unwrap().is_empty());
    }

    // ── create_task returns 201 and the created task ──────────────────────────

    #[tokio::test]
    async fn create_task_returns_201_with_task_id() {
        let dir = tempfile::tempdir().unwrap();

        // Use the *_in helpers to bypass the global tasks_dir().
        let task = bridge_tasks::create_task_in(
            dir.path(),
            CreateBridgeTaskInput {
                source: None,
                workspace_id: "ws-test".into(),
                team_id: None,
                title: "Write tests".into(),
                goal: "Achieve 100% coverage".into(),
                knowledge: None,
                assignees: vec![],
                subtasks: vec![],
                due_date: None,
                status: None,
                priority: None,
            },
        )
        .unwrap();

        assert!(task.id.starts_with("task_"));
        assert_eq!(task.workspace_id, "ws-test");
        assert_eq!(task.title, "Write tests");
    }

    // ── get_task returns 404 for unknown id ───────────────────────────────────

    #[tokio::test]
    async fn get_task_unknown_id_returns_404() {
        let dir = tempfile::tempdir().unwrap();
        let app = test_router(&dir);

        let resp = app
            .oneshot(
                Request::builder()
                    .uri("/api/tasks/task_does_not_exist?workspaceId=ws-test")
                    .header(auth_header().0, auth_header().1)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    // ── patch_task updates status ─────────────────────────────────────────────

    #[tokio::test]
    async fn patch_task_updates_status_via_bridge_tasks_in() {
        let dir = tempfile::tempdir().unwrap();

        let created = bridge_tasks::create_task_in(
            dir.path(),
            CreateBridgeTaskInput {
                source: None,
                workspace_id: "ws-test".into(),
                team_id: None,
                title: "My task".into(),
                goal: "Do stuff".into(),
                knowledge: None,
                assignees: vec![],
                subtasks: vec![],
                due_date: None,
                status: None,
                priority: None,
            },
        )
        .unwrap();

        let patched = bridge_tasks::update_task_in(
            dir.path(),
            "ws-test",
            &created.id,
            UpdateBridgeTaskPatch {
                status: Some(BridgeTaskStatus::InProgress),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(patched.status, BridgeTaskStatus::InProgress);
    }

    // ── cancel_task (DELETE) sets status=cancelled via bridge_tasks_in ────────

    #[tokio::test]
    async fn cancel_task_sets_status_cancelled() {
        let dir = tempfile::tempdir().unwrap();

        let created = bridge_tasks::create_task_in(
            dir.path(),
            CreateBridgeTaskInput {
                source: None,
                workspace_id: "ws-test".into(),
                team_id: None,
                title: "Cancel me".into(),
                goal: "Be cancelled".into(),
                knowledge: None,
                assignees: vec![],
                subtasks: vec![],
                due_date: None,
                status: None,
                priority: None,
            },
        )
        .unwrap();

        let cancelled = bridge_tasks::update_task_in(
            dir.path(),
            "ws-test",
            &created.id,
            UpdateBridgeTaskPatch {
                status: Some(BridgeTaskStatus::Cancelled),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(cancelled.status, BridgeTaskStatus::Cancelled);
    }

    // ── pagination works ──────────────────────────────────────────────────────

    #[tokio::test]
    async fn list_tasks_pagination_via_in_helpers() {
        let dir = tempfile::tempdir().unwrap();

        for i in 0..5 {
            bridge_tasks::create_task_in(
                dir.path(),
                CreateBridgeTaskInput {
                    source: None,
                    workspace_id: "ws-pg".into(),
                    team_id: None,
                    title: format!("Task {i}"),
                    goal: format!("Goal {i}"),
                    knowledge: None,
                    assignees: vec![],
                    subtasks: vec![],
                    due_date: None,
                    status: None,
                    priority: None,
                },
            )
            .unwrap();
        }

        let page1 =
            bridge_tasks::list_tasks_in(dir.path(), "ws-pg", TaskListFilter::default()).unwrap();
        assert_eq!(page1.len(), 5);

        // status filter
        bridge_tasks::update_task_in(
            dir.path(),
            "ws-pg",
            &page1[0].id,
            UpdateBridgeTaskPatch {
                status: Some(BridgeTaskStatus::Complete),
                ..Default::default()
            },
        )
        .unwrap();

        let complete_only = bridge_tasks::list_tasks_in(
            dir.path(),
            "ws-pg",
            TaskListFilter {
                status: Some(BridgeTaskStatus::Complete),
                assignee: None,
            },
        )
        .unwrap();
        assert_eq!(complete_only.len(), 1);
    }

    // ── an agent's curl repaints the tracker ──────────────────────────────────

    /// The router over `state`, with tasks stored under `dir` instead of the real home.
    fn router_over(state: &ApiState, dir: &TempDir) -> Router {
        state.mcp_state.set_task_base_for_tests(dir.path().to_path_buf());
        Router::new()
            .route("/api/tasks/:id", patch(patch_task))
            .route("/api/tasks/:id", delete(cancel_task))
            .layer(axum::Extension((*state.api_key).clone()))
            .with_state(state.clone())
    }

    fn seed_task(dir: &TempDir) -> BridgeTask {
        bridge_tasks::create_task_in(
            dir.path(),
            CreateBridgeTaskInput {
                source: None,
                workspace_id: "ws-test".into(),
                team_id: None,
                title: "Agent task".into(),
                goal: "Hand it back".into(),
                knowledge: None,
                assignees: vec![],
                subtasks: vec![],
                due_date: None,
                status: None,
                priority: None,
            },
        )
        .unwrap()
    }

    fn changed_events(state: &ApiState) -> Vec<Value> {
        state
            .mcp_state
            .emitted_for_tests()
            .into_iter()
            .filter(|(event, _)| event == "tasks://changed")
            .map(|(_, payload)| payload)
            .collect()
    }

    #[tokio::test]
    async fn patch_with_workspace_id_announces_the_change() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        let task = seed_task(&dir);

        let resp = router_over(&state, &dir)
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/tasks/{}?workspaceId=ws-test", task.id))
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"status":"in-review"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["status"], "in-review");
        assert_eq!(
            changed_events(&state),
            vec![serde_json::json!({ "workspaceId": "ws-test", "taskId": task.id })]
        );
    }

    #[tokio::test]
    async fn patch_without_workspace_id_is_refused_and_announces_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        let task = seed_task(&dir);

        let resp = router_over(&state, &dir)
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/api/tasks/{}", task.id))
                    .header(auth_header().0, auth_header().1)
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"status":"in-review"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert!(changed_events(&state).is_empty());
    }

    #[tokio::test]
    async fn delete_announces_the_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let state = test_state();
        let task = seed_task(&dir);

        let resp = router_over(&state, &dir)
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/tasks/{}?workspaceId=ws-test", task.id))
                    .header(auth_header().0, auth_header().1)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["status"], "cancelled");
        assert_eq!(changed_events(&state).len(), 1);
    }
}
