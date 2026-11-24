//! Where run records live. The SQLite store writes the same `codecanvas_graph_runs` table the app
//! already has (`src/codecanvas_graph_runs.rs`), in the same row shape, so the UI's existing
//! `codecanvas_get_graph_run` / `codecanvas_list_graph_runs` read what this engine wrote.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::record::{Checkpoint, GraphRunRecord, RunStatus};

/// Runs kept per project, newest first (same rule as the app and the TS store).
pub const RUN_RETENTION: i64 = 20;

/// A row the retention rule never deletes: a completed Factory Run whose PR is still open. The
/// Chief of Staff watches that PR from this record, so deleting it would stop the watch without a
/// word (CoS 4). It goes once the PR is merged or closed. SQL over `checkpoint_json`, shared with
/// the app's own writer (`codecanvas_graph_runs.rs`).
pub const KEEPS_OPEN_FACTORY_PR: &str = "(status = 'completed'
    AND json_extract(checkpoint_json, '$.engine.factory') IS NOT NULL
    AND json_extract(checkpoint_json, '$.engine.pr') IS NULL
    AND COALESCE(json_extract(checkpoint_json, '$.engine.prWatch.phase'), '') NOT IN ('merged', 'closed')
    AND checkpoint_json LIKE '%/pull/%')";

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
}

pub trait RunStore: Send + Sync {
    /// Inserts or replaces the record.
    fn save(&self, record: &GraphRunRecord) -> Result<(), StoreError>;
    fn get(&self, id: &str) -> Result<Option<GraphRunRecord>, StoreError>;
    /// Every record whose status is `running`, `paused` or `waiting`, oldest first.
    fn list_unfinished(&self) -> Result<Vec<GraphRunRecord>, StoreError>;
    /// Every record whose status is `completed`, oldest first (the Chief of Staff watches their PRs).
    fn list_completed(&self) -> Result<Vec<GraphRunRecord>, StoreError>;
}

#[derive(Default)]
pub struct MemoryRunStore {
    records: Mutex<BTreeMap<String, GraphRunRecord>>,
}

impl MemoryRunStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn all(&self) -> Vec<GraphRunRecord> {
        self.records.lock().unwrap_or_else(|p| p.into_inner()).values().cloned().collect()
    }
}

impl RunStore for MemoryRunStore {
    fn save(&self, record: &GraphRunRecord) -> Result<(), StoreError> {
        self.records.lock().unwrap_or_else(|p| p.into_inner()).insert(record.id.clone(), record.clone());
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<GraphRunRecord>, StoreError> {
        Ok(self.records.lock().unwrap_or_else(|p| p.into_inner()).get(id).cloned())
    }

    fn list_unfinished(&self) -> Result<Vec<GraphRunRecord>, StoreError> {
        let mut out: Vec<_> = self
            .all()
            .into_iter()
            .filter(|r| matches!(r.status, RunStatus::Running | RunStatus::Paused | RunStatus::Waiting))
            .collect();
        out.sort_by_key(|r| r.started_at);
        Ok(out)
    }

    fn list_completed(&self) -> Result<Vec<GraphRunRecord>, StoreError> {
        let mut out: Vec<_> = self.all().into_iter().filter(|r| r.status == RunStatus::Completed).collect();
        out.sort_by_key(|r| r.started_at);
        Ok(out)
    }
}

pub struct SqliteRunStore {
    connection: Mutex<Connection>,
}

const COLUMNS: &str = "id, project_id, workflow_id, status, checkpoint_json, started_at, ended_at, updated_at";

impl SqliteRunStore {
    /// Opens the app's CodeCanvas database (or a test file). The table is created only when it is
    /// missing; in the app, `codecanvas_store` migrations own it (with its foreign key).
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let connection = Connection::open(path)?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS codecanvas_graph_runs (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               workflow_id TEXT,
               status TEXT NOT NULL,
               checkpoint_json TEXT NOT NULL,
               started_at INTEGER NOT NULL,
               ended_at INTEGER,
               updated_at INTEGER NOT NULL
             );",
        )?;
        Ok(Self { connection: Mutex::new(connection) })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.connection.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// A row this crate cannot read (unknown status, foreign checkpoint) is skipped, never fatal.
fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Option<GraphRunRecord>> {
    let status: String = row.get(3)?;
    let checkpoint: String = row.get(4)?;
    let (Some(status), Ok(checkpoint)) = (RunStatus::parse(&status), serde_json::from_str::<Checkpoint>(&checkpoint)) else {
        return Ok(None);
    };
    Ok(Some(GraphRunRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        workflow_id: row.get(2)?,
        status,
        checkpoint,
        started_at: row.get(5)?,
        ended_at: row.get(6)?,
        updated_at: row.get(7)?,
    }))
}

impl RunStore for SqliteRunStore {
    fn save(&self, record: &GraphRunRecord) -> Result<(), StoreError> {
        let checkpoint = serde_json::to_string(&record.checkpoint)?;
        let connection = self.lock();
        connection.execute(
            &format!(
                "INSERT INTO codecanvas_graph_runs ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   project_id = excluded.project_id, workflow_id = excluded.workflow_id,
                   status = excluded.status, checkpoint_json = excluded.checkpoint_json,
                   ended_at = excluded.ended_at, updated_at = excluded.updated_at"
            ),
            params![
                record.id,
                record.project_id,
                record.workflow_id,
                record.status.as_str(),
                checkpoint,
                record.started_at,
                record.ended_at,
                record.updated_at
            ],
        )?;
        connection.execute(
            &format!(
                "DELETE FROM codecanvas_graph_runs WHERE project_id = ?1 AND NOT {KEEPS_OPEN_FACTORY_PR} AND id NOT IN
                   (SELECT id FROM codecanvas_graph_runs WHERE project_id = ?1 ORDER BY started_at DESC LIMIT ?2)"
            ),
            params![record.project_id, RUN_RETENTION],
        )?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<GraphRunRecord>, StoreError> {
        let connection = self.lock();
        let mut statement = connection.prepare(&format!("SELECT {COLUMNS} FROM codecanvas_graph_runs WHERE id = ?1"))?;
        Ok(statement.query_row([id], read_row).optional()?.flatten())
    }

    fn list_unfinished(&self) -> Result<Vec<GraphRunRecord>, StoreError> {
        let connection = self.lock();
        let mut statement = connection.prepare(&format!(
            "SELECT {COLUMNS} FROM codecanvas_graph_runs WHERE status IN ('running', 'paused', 'waiting') ORDER BY started_at ASC"
        ))?;
        let rows = statement.query_map([], read_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect())
    }

    fn list_completed(&self) -> Result<Vec<GraphRunRecord>, StoreError> {
        let connection = self.lock();
        let mut statement =
            connection.prepare(&format!("SELECT {COLUMNS} FROM codecanvas_graph_runs WHERE status = 'completed' ORDER BY started_at ASC"))?;
        let rows = statement.query_map([], read_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().flatten().collect())
    }
}
