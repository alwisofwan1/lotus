//! Finding the checkout of a PR's repository among the user's Lotus
//! workspaces, so a review's pane opens where the code is. bb looks only at
//! project roots (`resolveProjectId`, `plugins/github/server.ts`); Lotus also
//! looks one level down, because a workspace is often a parent folder holding
//! several repos (`acme-main/` with `acme-web/` and `acme-api/`).

use std::path::{Path, PathBuf};

/// A workspace that could hold the checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub workspace_id: String,
    pub cwd: PathBuf,
}

/// Where the checkout is: the workspace to open the pane in, and the folder.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub workspace_id: String,
    pub cwd: PathBuf,
    /// The folder's own repo, when it is only a namesake of the one asked for
    /// ([`find_checkout_or_namesake`]): a push from it lands in this repo, not
    /// that one, so the caller can tell the agent where a push would go.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub namesake: Option<String>,
}

/// The first of, in order: a workspace whose root is a checkout of `repo`; a
/// folder directly inside the `preferred` workspace (the automation's project)
/// that is one; a folder directly inside any other workspace that is one.
/// `repo_of` reads a folder's `origin` as `owner/name`; `children` lists a
/// folder's subfolders. Repos compare case-insensitively, as GitHub does.
pub fn find_checkout(
    repo: &str,
    candidates: &[Candidate],
    preferred: Option<&str>,
    repo_of: &dyn Fn(&Path) -> Option<String>,
    children: &dyn Fn(&Path) -> Vec<PathBuf>,
) -> Option<Found> {
    let is_it = |folder: &Path| repo_of(folder).is_some_and(|r| r.eq_ignore_ascii_case(repo));
    if let Some(c) = candidates.iter().find(|c| is_it(&c.cwd)) {
        return Some(Found { workspace_id: c.workspace_id.clone(), cwd: c.cwd.clone(), namesake: None });
    }
    let (first, rest): (Vec<&Candidate>, Vec<&Candidate>) =
        candidates.iter().partition(|c| preferred.is_some_and(|p| p == c.workspace_id));
    for c in first.into_iter().chain(rest) {
        if let Some(folder) = children(&c.cwd).into_iter().find(|child| is_it(child)) {
            return Some(Found { workspace_id: c.workspace_id.clone(), cwd: folder, namesake: None });
        }
    }
    None
}

/// [`find_checkout`], else the one folder whose repo has the same NAME under
/// another owner — a fork or a transferred repo, where an issue's
/// `donisapu/e-coursetradding` is checked out from `mapantekno/e-coursetradding`.
/// Only when exactly one folder has that name: two would be a guess. For
/// opening an agent on an issue, never for Factory, which pushes branches to
/// the repo it found and must not push to a namesake.
pub fn find_checkout_or_namesake(
    repo: &str,
    candidates: &[Candidate],
    preferred: Option<&str>,
    repo_of: &dyn Fn(&Path) -> Option<String>,
    children: &dyn Fn(&Path) -> Vec<PathBuf>,
) -> Option<Found> {
    if let Some(found) = find_checkout(repo, candidates, preferred, repo_of, children) {
        return Some(found);
    }
    let name = repo.rsplit('/').next().filter(|n| !n.is_empty())?;
    let same_name = |folder: &Path| {
        repo_of(folder).filter(|r| r.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(name)))
    };
    let mut found: Vec<Found> = Vec::new();
    for c in candidates {
        let folders = std::iter::once(c.cwd.clone()).chain(children(&c.cwd));
        for folder in folders {
            let Some(own) = same_name(&folder) else { continue };
            if !found.iter().any(|f| f.cwd == folder) {
                found.push(Found { workspace_id: c.workspace_id.clone(), cwd: folder, namesake: Some(own) });
            }
        }
    }
    if found.len() == 1 { found.pop() } else { None }
}

/// The real `children` for [`find_checkout`]: subfolders that hold a `.git`
/// (a folder, or a file for a worktree or submodule), sorted, hidden ones
/// skipped, so `repo_of` only runs git where there is a repository.
pub fn git_subfolders(folder: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(folder) else { return vec![] };
    let mut found: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.') || n == "node_modules"))
        .filter(|p| p.join(".git").exists())
        .collect();
    found.sort();
    found
}

#[cfg(test)]
mod git_subfolders_tests {
    use super::git_subfolders;

    #[test]
    fn sub_repos_are_git_folders_one_level_down_without_dot_folders_or_node_modules() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for name in ["front", "back", ".hidden", "node_modules", "plain"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        for name in ["front", "back", ".hidden", "node_modules"] {
            std::fs::create_dir_all(root.join(name).join(".git")).unwrap();
        }
        std::fs::create_dir_all(root.join("plain").join("deep").join(".git")).unwrap();
        // A worktree or submodule has a `.git` file.
        std::fs::create_dir_all(root.join("wt")).unwrap();
        std::fs::write(root.join("wt").join(".git"), "gitdir: x").unwrap();
        let names: Vec<String> =
            git_subfolders(root).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["back", "front", "wt"]);
    }
}
