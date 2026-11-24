use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    pub name: String,
    pub agent_id: String,
    pub agent_type: String,
    pub model: Option<String>,
    pub role: Option<String>,
    pub status: Option<String>,
    pub pid: Option<u32>,
    pub runner: Option<String>,
    pub runner_command: Option<String>,
    pub prompt: Option<String>,
    pub applied_skills: Option<Vec<String>>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TeamConfig {
    pub id: String,
    pub name: String,
    /// Shape of this file on disk. `None` means it was written before member `prompt`, `effort`,
    /// `applied_skills` and `permission_mode` were persisted; the frontend migrates those on load
    /// (see `services/team-config-migration.ts`). Kept on the struct so a write does not drop the
    /// stamp and undo the migration on every save.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema_version: Option<u32>,
    pub description: Option<String>,
    pub project: Option<String>,
    pub project_dir: Option<String>,
    pub display_mode: Option<String>,
    pub require_plan_approval: Option<bool>,
    pub lead_model: Option<String>,
    pub created_at: String,
    pub status: String,
    pub members: Vec<TeamMember>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_git_repo: bool,
    pub has_package_json: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMeta {
    pub id: String,
    pub path: String,
    pub name: String,
    pub last_used: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub team_id: Option<String>,
    pub project_dir: Option<String>,
    pub started_at: String,
    pub cmd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub name: String,
    pub role: String,
    pub model: String,
    pub prompt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub name: String,
    pub project: Option<String>,
    pub project_dir: Option<String>,
    pub goal: Option<String>,
    pub display_mode: Option<String>,
    pub require_plan_approval: Option<bool>,
    pub lead_model: Option<String>,
    pub agents: Vec<AgentConfig>,
    pub tasks: Option<Vec<String>>,
    pub dry_run: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub ok: bool,
    pub team_id: String,
    pub pid: Option<u32>,
    pub log_file: String,
    pub work_dir: String,
    pub shell_cmd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPtyResult {
    pub ok: bool,
    pub team_id: String,
    pub session_id: String,
    pub work_dir: String,
    pub shell_cmd: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub cwd: String,
    /// Milliseconds since this session last produced output. The primary staleness signal:
    /// unlike the idle flag below it is always observable, whatever the runner does.
    pub silent_for_ms: u64,
    /// Milliseconds since the PTY was created. Guards a still-booting runner, which has
    /// produced neither output nor a prompt marker and is otherwise indistinguishable
    /// from a stale one.
    pub started_ago_ms: u64,
    /// OSC 133 view of the shell: at its prompt, or running a command.
    pub idle: bool,
    /// Whether `idle` reflects a marker actually observed. `false` means the runner never
    /// emitted OSC 133, so the flag is only its initial default and carries no information.
    /// A directly-spawned agent CLI commonly never emits one, and treating its default
    /// "idle" as evidence would mean reporting hard-working agents as abandoned.
    pub idle_trusted: bool,
    pub pid: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoStatus {
    pub repo_root: String,
    pub branch: String,
    pub has_changes: bool,
    pub staged_count: u32,
    pub unstaged_count: u32,
    pub untracked_count: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A team config as written before 2026-09-09: no `schemaVersion` key at all.
    const V0_CONFIG: &str = r#"{
        "id": "team_feature_dev_01",
        "name": "Feature Development",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "status": "idle",
        "members": [
            { "name": "Reviewer", "agentId": "agent-reviewer", "agentType": "specialist" }
        ]
    }"#;

    #[test]
    fn reads_a_config_written_before_the_version_field_existed() {
        let config: TeamConfig = serde_json::from_str(V0_CONFIG).expect("v0 config must still load");
        assert_eq!(config.schema_version, None);
    }

    #[test]
    fn keeps_the_version_through_a_write_so_a_migration_is_not_undone() {
        let mut config: TeamConfig = serde_json::from_str(V0_CONFIG).unwrap();
        config.schema_version = Some(1);

        let written = serde_json::to_string(&config).unwrap();
        assert!(written.contains("\"schemaVersion\":1"), "written: {written}");

        let reread: TeamConfig = serde_json::from_str(&written).unwrap();
        assert_eq!(reread.schema_version, Some(1));
    }
}
