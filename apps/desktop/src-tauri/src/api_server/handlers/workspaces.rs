//! Workspace listing — derived from the current fleet snapshot.
//!
//! The Lotus desktop already knows what workspaces exist (each pane carries
//! a `workspace_id`); this handler just groups, sorts, and counts. No new
//! source of truth.

use std::collections::BTreeMap;

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::api_server::state::ApiState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSummary {
    pub workspace_id: String,
    pub cell_count: usize,
    /// Sorted unique providers (`["claude"]`, `["codex"]`, or `["claude","codex"]`).
    pub providers: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListWorkspacesResponse {
    pub items: Vec<WorkspaceSummary>,
}

/// `GET /api/workspaces` — workspaces grouped from the fleet snapshot.
pub async fn list_workspaces(
    State(state): State<ApiState>,
    _: RequireAuth,
) -> Result<Json<ListWorkspacesResponse>, ApiError> {
    let snapshot = state.mcp_state.fleet_snapshot();

    // BTreeMap preserves alphabetical workspace order in the response, which
    // gives operators a stable view between calls.
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for member in snapshot {
        grouped
            .entry(member.workspace_id)
            .or_default()
            .push(member.provider);
    }

    let items = grouped
        .into_iter()
        .map(|(workspace_id, providers)| {
            let mut unique: Vec<String> = providers;
            unique.sort();
            unique.dedup();
            WorkspaceSummary {
                cell_count: count_in_snapshot(&workspace_id, &state),
                workspace_id,
                providers: unique,
            }
        })
        .collect();

    Ok(Json(ListWorkspacesResponse { items }))
}

/// Re-counts members for a workspace from a fresh snapshot. Cheap on small
/// fleets; if fleets grow we can pre-compute counts in the grouping pass.
fn count_in_snapshot(workspace_id: &str, state: &ApiState) -> usize {
    state
        .mcp_state
        .fleet_snapshot()
        .iter()
        .filter(|m| m.workspace_id == workspace_id)
        .count()
}
