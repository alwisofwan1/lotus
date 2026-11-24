//! Localhost route that serves confined local files for `file://` browser nodes.
//!
//! The child WebView cannot attach a Bearer header, so — like `/health` and the
//! youtube-player wrapper — this route is unauthenticated. Its security comes from
//! the unguessable per-node token in the path plus re-confinement of the path tail
//! under the token's allowed root (`resolve_served_path`). Actual byte serving,
//! MIME detection, and `Range` handling are delegated to tower-http's `ServeFile`.

use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::api_server::ApiState;
use crate::canvas_browser_local_files::resolve_served_path;

/// `GET /__local/:token/*path` — serve a confined local file.
pub async fn serve_local_file(
    State(state): State<ApiState>,
    Path((token, tail)): Path<(String, String)>,
    request: Request,
) -> Response {
    let Some(root) = state.canvas_browser_local_files.root_for(&token) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(file) = resolve_served_path(&root, &tail) else {
        // Any confinement violation or missing file is an indistinguishable 404 —
        // never leak whether a path exists outside the allowed root.
        return StatusCode::NOT_FOUND.into_response();
    };
    match ServeFile::new(file).oneshot(request).await {
        Ok(response) => response.map(axum::body::Body::new).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}
