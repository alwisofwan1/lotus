use std::path::PathBuf;

use crate::error::AppError;
use crate::models::TeamConfig;

pub(crate) const TEAM_STATUS_ACTIVE: &str = "active";

pub(crate) fn status_for_exit_code(code: i32) -> &'static str {
    if code == 0 {
        "completed"
    } else {
        "failed"
    }
}

pub(crate) fn update_team_status_file(cfg_path: &PathBuf, status: &str) -> Result<(), AppError> {
    if let Some(mut cfg) = crate::json::read_json::<TeamConfig>(cfg_path) {
        cfg.status = status.to_string();
        crate::json::write_json(cfg_path, &cfg)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn team(status: &str) -> TeamConfig {
        TeamConfig {
            schema_version: None,
            id: "team-1".into(),
            name: "Team".into(),
            description: None,
            project: None,
            project_dir: None,
            display_mode: None,
            require_plan_approval: None,
            lead_model: None,
            created_at: "2026-06-05T00:00:00.000Z".into(),
            status: status.into(),
            members: vec![],
        }
    }

    #[test]
    fn exit_code_zero_completes_team_and_non_zero_fails_team() {
        assert_eq!(status_for_exit_code(0), "completed");
        assert_eq!(status_for_exit_code(1), "failed");
        assert_eq!(status_for_exit_code(-1), "failed");
    }

    #[test]
    fn update_team_status_file_preserves_config_and_rewrites_only_status() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("config.json");
        crate::json::write_json(&path, &team("idle")).expect("write config");

        update_team_status_file(&path, "active").expect("update status");

        let updated = crate::json::read_json::<TeamConfig>(&path).expect("read config");
        assert_eq!(updated.id, "team-1");
        assert_eq!(updated.name, "Team");
        assert_eq!(updated.status, "active");
    }
}
