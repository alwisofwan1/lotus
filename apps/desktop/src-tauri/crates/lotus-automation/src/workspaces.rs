//! The user's Lotus workspaces (projects), as the frontend last reported
//! them. A run in a project works in that project's folder — for a PR review,
//! in the checkout of the PR's repository — whether or not a pane is opened.

use std::path::PathBuf;

use crate::checkout::Found;

/// Why a headless run in project `workspace_id` cannot start: Lotus does not
/// know that project's folder — it is not open in the window, is remote, or
/// the window has not reported its workspaces yet (just after launch). The
/// run fails, and a retry later usually finds it.
pub fn unknown_project(workspace_id: &str) -> String {
    format!("this automation's project ({workspace_id}) is not open in Lotus; open it in the sidebar, and the run will be retried")
}

pub trait Workspaces: Send + Sync {
    /// The folder of workspace `workspace_id`, when it is a local one.
    fn folder(&self, workspace_id: &str) -> Option<PathBuf>;
    /// The checkout of `repo` among the workspaces, `preferred` first (see
    /// [`crate::checkout::find_checkout`]).
    fn checkout(&self, repo: &str, preferred: Option<&str>) -> Option<Found>;
}
