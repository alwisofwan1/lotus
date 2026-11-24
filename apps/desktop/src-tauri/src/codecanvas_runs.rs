use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::codecanvas_store::{CodeCanvasStoreError, CodeCanvasStoreResult};

/// How many runs are retained per agent node (FIFO, newest kept).
const RUN_RETENTION: i64 = 20;

/// One captured agent run/turn (matches the TS AgentRunRecord shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRunRecordRow {
    pub id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub kind: String,
    pub outcome: String,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "endedAt")]
    pub ended_at: i64,
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    #[serde(
        rename = "graphRunId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub graph_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
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

pub fn list_agent_runs(
    connection: &Connection,
    agent_id: &str,
) -> CodeCanvasStoreResult<Vec<AgentRunRecordRow>> {
    let mut statement = connection.prepare(
        "SELECT id, agent_id, kind, outcome, started_at, ended_at, session_id, actions_json, summary, graph_run_id, usage_json
         FROM codecanvas_agent_runs WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![agent_id, RUN_RETENTION], |row| {
        let actions_json: String = row.get(7)?;
        let usage_json: Option<String> = row.get(10)?;
        Ok(AgentRunRecordRow {
            id: row.get(0)?,
            agent_id: row.get(1)?,
            kind: row.get(2)?,
            outcome: row.get(3)?,
            started_at: row.get(4)?,
            ended_at: row.get(5)?,
            session_id: row.get(6)?,
            graph_run_id: row.get(9)?,
            usage: usage_json.and_then(|s| serde_json::from_str(&s).ok()),
            actions: serde_json::from_str(&actions_json).unwrap_or_default(),
            summary: row.get(8)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn append_agent_run(
    connection: &Connection,
    record: &AgentRunRecordRow,
) -> CodeCanvasStoreResult<()> {
    let actions_json = serde_json::to_string(&record.actions).map_err(json_error)?;
    let usage_json = record
        .usage
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(json_error)?;
    connection.execute(
        "INSERT INTO codecanvas_agent_runs
           (id, agent_id, kind, outcome, started_at, ended_at, session_id, actions_json, summary, created_at, graph_run_id, usage_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO NOTHING",
        params![record.id, record.agent_id, record.kind, record.outcome, record.started_at,
            record.ended_at, record.session_id, actions_json, record.summary, now_ms(), record.graph_run_id, usage_json],
    )?;
    // Prune older runs beyond the retention cap for this agent.
    connection.execute(
        "DELETE FROM codecanvas_agent_runs WHERE agent_id = ?1 AND id NOT IN
           (SELECT id FROM codecanvas_agent_runs WHERE agent_id = ?1 ORDER BY created_at DESC LIMIT ?2)",
        params![record.agent_id, RUN_RETENTION],
    )?;
    Ok(())
}
