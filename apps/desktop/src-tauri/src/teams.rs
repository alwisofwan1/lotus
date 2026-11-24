use crate::error::AppError;
use crate::json::collect_json_entries;
use crate::models::TeamConfig;
use crate::paths::{tasks_dir, teams_dir};

pub fn list_teams() -> Vec<TeamConfig> {
    collect_json_entries(&teams_dir(), |e| e.path().join("config.json"))
        .into_iter()
        .filter(|t: &TeamConfig| !t.id.is_empty())
        .collect()
}

pub fn get_team(id: String) -> Option<TeamConfig> {
    crate::json::read_json(&teams_dir().join(&id).join("config.json"))
}

pub fn delete_team(id: String) -> Result<(), AppError> {
    let team_path = teams_dir().join(&id);
    if team_path.exists() {
        std::fs::remove_dir_all(&team_path).map_err(AppError::Io)?;
    }
    let tasks_path = tasks_dir().join(&id);
    if tasks_path.exists() {
        std::fs::remove_dir_all(&tasks_path).map_err(AppError::Io)?;
    }
    Ok(())
}
