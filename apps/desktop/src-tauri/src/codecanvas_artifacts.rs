use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::codecanvas_store::CodeCanvasStoreResult;

/// How many artifacts are retained per project (FIFO, newest kept) — the footprint guard.
const ARTIFACT_RETENTION: i64 = 200;

/// One named artifact on a Context Node's bus (matches the TS ContextArtifact shape).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRow {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "busNodeId")]
    pub bus_node_id: String,
    pub key: String,
    pub value: String,
    pub producer: String,
    pub version: i64,
    #[serde(rename = "graphRunId")]
    pub graph_run_id: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ArtifactRow> {
    Ok(ArtifactRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        bus_node_id: row.get(2)?,
        key: row.get(3)?,
        value: row.get(4)?,
        producer: row.get(5)?,
        version: row.get(6)?,
        graph_run_id: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

pub fn save_artifact(connection: &Connection, record: &ArtifactRow) -> CodeCanvasStoreResult<()> {
    connection.execute(
        "INSERT INTO codecanvas_artifacts
           (id, project_id, bus_node_id, key, value, producer, version, graph_run_id, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(project_id, bus_node_id, key) DO UPDATE SET
           value = excluded.value,
           producer = excluded.producer,
           version = excluded.version,
           graph_run_id = excluded.graph_run_id,
           updated_at = excluded.updated_at",
        params![
            record.id,
            record.project_id,
            record.bus_node_id,
            record.key,
            record.value,
            record.producer,
            record.version,
            record.graph_run_id,
            record.updated_at
        ],
    )?;
    connection.execute(
        "DELETE FROM codecanvas_artifacts WHERE project_id = ?1 AND id NOT IN
           (SELECT id FROM codecanvas_artifacts WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT ?2)",
        params![record.project_id, ARTIFACT_RETENTION],
    )?;
    Ok(())
}

/// Fetch a single artifact by its primary-key `id`. Returns `None` when no
/// such artifact exists. Currently exercised only by the store tests — no
/// production caller yet, so it is test-gated until a get-by-id command needs
/// it; remove the gate when wiring that command.
#[cfg(test)]
pub fn get_artifact(
    connection: &Connection,
    id: &str,
) -> CodeCanvasStoreResult<Option<ArtifactRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, bus_node_id, key, value, producer, version, graph_run_id, updated_at
         FROM codecanvas_artifacts WHERE id = ?1",
    )?;
    let mut rows = statement.query_map(params![id], read_row)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn list_artifacts(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Vec<ArtifactRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, bus_node_id, key, value, producer, version, graph_run_id, updated_at
         FROM codecanvas_artifacts WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![project_id, ARTIFACT_RETENTION], read_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}
