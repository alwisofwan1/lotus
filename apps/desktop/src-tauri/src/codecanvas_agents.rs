use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::codecanvas_store::{CodeCanvasStoreError, CodeCanvasStoreResult};

/// Reusable agent template, managed in Canvas Settings and shared across projects.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDefinitionRecord {
    pub id: String,
    pub name: String,
    pub role: Option<String>,
    pub model: String,
    pub prompt: String,
    #[serde(rename = "appliedSkills", default)]
    pub applied_skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(
        rename = "permissionMode",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_mode: Option<String>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn json_error(err: serde_json::Error) -> CodeCanvasStoreError {
    CodeCanvasStoreError::Path(err.to_string())
}

pub fn list_agents(connection: &Connection) -> CodeCanvasStoreResult<Vec<AgentDefinitionRecord>> {
    let mut statement = connection.prepare(
        "SELECT id, name, role, model, prompt, applied_skills_json, effort, permission_mode, updated_at
         FROM codecanvas_agents ORDER BY updated_at DESC, name ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let skills_json: String = row.get(5)?;
        Ok(AgentDefinitionRecord {
            id: row.get(0)?,
            name: row.get(1)?,
            role: row.get(2)?,
            model: row.get(3)?,
            prompt: row.get(4)?,
            applied_skills: serde_json::from_str(&skills_json).unwrap_or_default(),
            effort: row.get(6)?,
            permission_mode: row.get(7)?,
            updated_at: row.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn save_agent(
    connection: &Connection,
    def: &AgentDefinitionRecord,
) -> CodeCanvasStoreResult<AgentDefinitionRecord> {
    let skills_json = serde_json::to_string(&def.applied_skills).map_err(json_error)?;
    let updated_at = now_ms();
    connection.execute(
        "INSERT INTO codecanvas_agents (id, name, role, model, prompt, applied_skills_json, effort, permission_mode, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, role = excluded.role, model = excluded.model,
           prompt = excluded.prompt, applied_skills_json = excluded.applied_skills_json,
           effort = excluded.effort, permission_mode = excluded.permission_mode, updated_at = excluded.updated_at",
        params![def.id, def.name, def.role, def.model, def.prompt, skills_json, def.effort, def.permission_mode, updated_at],
    )?;
    Ok(AgentDefinitionRecord {
        updated_at,
        ..def.clone()
    })
}

pub fn delete_agent(connection: &Connection, id: &str) -> CodeCanvasStoreResult<()> {
    connection.execute("DELETE FROM codecanvas_agents WHERE id = ?1", [id])?;
    Ok(())
}
