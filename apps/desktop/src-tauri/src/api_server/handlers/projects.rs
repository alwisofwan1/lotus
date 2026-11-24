//! Project listing — read straight from the CodeCanvas project registry.
//!
//! Deliberately **not** derived from the fleet snapshot, which is the whole
//! reason this handler exists next to `workspaces.rs` rather than inside it.
//! `/api/workspaces` groups the panes that are running right now, so a project
//! whose agents were all closed cannot appear there by construction — its
//! `cellCount` would be zero and there is nothing to group. That made a project
//! unreachable from Lotus Pocket the moment its last agent ended, which is
//! exactly the situation the phone exists for (ADR-14, `plans/lotus-pocket`).
//!
//! The registry is the same table the desktop's own project menu reads through
//! `codecanvas_get_index`, so the two lists cannot disagree about what exists.
//!
//! `workspaceId` is emitted as `canvas:<projectId>` — the identical key
//! `canvas-fleet.ts` stamps on every cell it pushes. A client joins projects to
//! cells on that string alone; handing out the bare project id here would force
//! it to guess the pairing, and a guess is what made the phone print the wrong
//! project name in the first place.

use axum::extract::State;
use axum::Json;
use serde::Serialize;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::api_server::state::ApiState;
use crate::codecanvas_store;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    /// `canvas:<projectId>` — joins to `FleetMember::workspace_id`.
    pub workspace_id: String,
    /// The operator's alias when set, otherwise the root directory's last
    /// segment. Never the opaque id: a client that has to fall back to the id
    /// is a client showing `cp_2c7308855b8de2c9` to a human.
    pub name: String,
    pub path: String,
    pub last_opened_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectsResponse {
    pub items: Vec<ProjectSummary>,
}

/// `GET /api/projects` — every project this desktop knows, running or not.
pub async fn list_projects(
    State(state): State<ApiState>,
    _: RequireAuth,
) -> Result<Json<ListProjectsResponse>, ApiError> {
    // No app handle means no user data directory to resolve, which is the case
    // in headless tests. An empty list is the honest answer there: this desktop
    // is not holding a registry, as opposed to holding an empty one.
    let Some(app) = state.app_handle.as_ref() else {
        return Ok(Json(ListProjectsResponse { items: Vec::new() }));
    };

    let connection = codecanvas_store::open_app_store(app)
        .map_err(|e| ApiError::internal(format!("project store unavailable: {e}")))?;
    let index = codecanvas_store::get_index(&connection)
        .map_err(|e| ApiError::internal(format!("project registry unreadable: {e}")))?;

    let items = index
        .projects
        .into_iter()
        .map(|meta| ProjectSummary {
            workspace_id: format!("canvas:{}", meta.id),
            name: project_name(meta.alias.as_deref(), &meta.root_dir),
            path: meta.root_dir,
            last_opened_at: meta.last_opened_at,
        })
        .collect();

    Ok(Json(ListProjectsResponse { items }))
}

/// Alias wins; otherwise the trailing path segment; otherwise the raw root.
///
/// Mirrors `projectDisplayName` in `recent-projects.ts` on purpose — the phone
/// and the desktop menu must name a project identically, and two independent
/// implementations of "what is this called" is how they start to differ.
fn project_name(alias: Option<&str>, root_dir: &str) -> String {
    if let Some(alias) = alias.map(str::trim).filter(|a| !a.is_empty()) {
        return alias.to_string();
    }
    root_dir
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
        .next_back()
        .unwrap_or(root_dir)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alias_wins_when_the_operator_set_one() {
        assert_eq!(project_name(Some("Lotus"), "/Users/op/code/lotus"), "Lotus");
    }

    #[test]
    fn falls_back_to_the_directory_name() {
        assert_eq!(
            project_name(None, "/Users/op/experiments/terax-ai"),
            "terax-ai"
        );
    }

    #[test]
    fn a_blank_alias_is_not_a_name() {
        assert_eq!(project_name(Some("   "), "/Users/op/code/lotus"), "lotus");
    }

    #[test]
    fn a_trailing_separator_does_not_produce_an_empty_name() {
        assert_eq!(project_name(None, "/Users/op/code/lotus/"), "lotus");
    }
}
