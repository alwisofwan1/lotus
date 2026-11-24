use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codecanvas_store::{CodeCanvasStoreError, CodeCanvasStoreResult};

/// How many graph runs are retained per project (FIFO, newest kept).
const RUN_RETENTION: i64 = 20;

/// One persisted graph run (matches the TS GraphRunRecord shape). The checkpoint
/// is stored opaquely as JSON so the run-state schema can evolve without migrations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphRunRow {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(
        rename = "workflowId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workflow_id: Option<String>,
    pub status: String,
    pub checkpoint: Value,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "endedAt")]
    pub ended_at: Option<i64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

fn json_error(err: serde_json::Error) -> CodeCanvasStoreError {
    CodeCanvasStoreError::Path(err.to_string())
}

fn json_value(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<GraphRunRow> {
    let checkpoint: String = row.get(4)?;
    Ok(GraphRunRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        workflow_id: row.get(2)?,
        status: row.get(3)?,
        checkpoint: json_value(checkpoint)?,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn save_graph_run(connection: &Connection, record: &GraphRunRow) -> CodeCanvasStoreResult<()> {
    let checkpoint_json = serde_json::to_string(&record.checkpoint).map_err(json_error)?;
    connection.execute(
        "INSERT INTO codecanvas_graph_runs
           (id, project_id, workflow_id, status, checkpoint_json, started_at, ended_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           workflow_id = excluded.workflow_id,
           status = excluded.status,
           checkpoint_json = excluded.checkpoint_json,
           ended_at = excluded.ended_at,
           updated_at = excluded.updated_at",
        params![
            record.id,
            record.project_id,
            record.workflow_id,
            record.status,
            checkpoint_json,
            record.started_at,
            record.ended_at,
            record.updated_at
        ],
    )?;
    // A Factory Run whose PR is still open stays: the Chief of Staff watches the PR from it.
    connection.execute(
        &format!(
            "DELETE FROM codecanvas_graph_runs WHERE project_id = ?1 AND NOT {} AND id NOT IN
               (SELECT id FROM codecanvas_graph_runs WHERE project_id = ?1 ORDER BY started_at DESC LIMIT ?2)",
            lotus_graph_run::KEEPS_OPEN_FACTORY_PR
        ),
        params![record.project_id, RUN_RETENTION],
    )?;
    Ok(())
}

pub fn list_graph_runs(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Vec<GraphRunRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, workflow_id, status, checkpoint_json, started_at, ended_at, updated_at
         FROM codecanvas_graph_runs WHERE project_id = ?1 ORDER BY started_at DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![project_id, RUN_RETENTION], read_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn list_all_graph_runs(connection: &Connection) -> CodeCanvasStoreResult<Vec<GraphRunRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, workflow_id, status, checkpoint_json, started_at, ended_at, updated_at
         FROM codecanvas_graph_runs ORDER BY started_at DESC",
    )?;
    let rows = statement.query_map([], read_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_graph_run(
    connection: &Connection,
    id: &str,
) -> CodeCanvasStoreResult<Option<GraphRunRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, workflow_id, status, checkpoint_json, started_at, ended_at, updated_at
         FROM codecanvas_graph_runs WHERE id = ?1",
    )?;
    statement
        .query_row([id], read_row)
        .optional()
        .map_err(Into::into)
}
