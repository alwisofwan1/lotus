use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 1;
const MAX_SEARCH_LIMIT: i64 = 50;
const MAX_RECENT_TURNS_LIMIT: i64 = 200;

#[derive(Debug, Error)]
pub enum BridgeMemoryStoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("filesystem error: {0}")]
    Filesystem(#[from] std::io::Error),
    #[error("path error: {0}")]
    Path(String),
    #[error("invalid bridge memory record: {0}")]
    InvalidRecord(String),
}

pub type BridgeMemoryStoreResult<T> = Result<T, BridgeMemoryStoreError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeMemorySession {
    pub id: String,
    pub workspace_id: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeMemoryTurn {
    pub session_id: String,
    pub turn_id: String,
    pub workspace_id: String,
    pub role: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_json: Option<Value>,
    pub created_at: i64,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeMemorySearchHit {
    pub session_id: String,
    pub turn_id: String,
    pub workspace_id: String,
    pub role: String,
    pub text: String,
    pub rank: f64,
}

pub fn database_path(app: &AppHandle) -> BridgeMemoryStoreResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("bridge-memory.sqlite3"))
        .map_err(|err| BridgeMemoryStoreError::Path(err.to_string()))
}

pub fn open_app_store(app: &AppHandle) -> BridgeMemoryStoreResult<Connection> {
    let path = database_path(app)?;
    open_store(&path)
}

pub fn open_store(path: &Path) -> BridgeMemoryStoreResult<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let connection = Connection::open(path)?;
    apply_migrations(&connection)?;
    Ok(connection)
}

fn apply_migrations(connection: &Connection) -> BridgeMemoryStoreResult<()> {
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bridge_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT,
          effort TEXT,
          title TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bridge_turns (
          session_id TEXT NOT NULL,
          turn_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          metadata_json TEXT,
          created_at INTEGER NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (session_id, turn_id),
          FOREIGN KEY (session_id) REFERENCES bridge_sessions(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_bridge_sessions_workspace_updated
          ON bridge_sessions(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_bridge_turns_session_position
          ON bridge_turns(session_id, position);
        CREATE INDEX IF NOT EXISTS idx_bridge_turns_workspace_created
          ON bridge_turns(workspace_id, created_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS bridge_turns_fts USING fts5(
          workspace_id UNINDEXED,
          session_id UNINDEXED,
          turn_id UNINDEXED,
          role UNINDEXED,
          text,
          tokenize='unicode61'
        );
        ",
    )?;

    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
        params![SCHEMA_VERSION, now_millis()],
    )?;

    Ok(())
}

pub fn upsert_session(
    connection: &mut Connection,
    session: &BridgeMemorySession,
) -> BridgeMemoryStoreResult<()> {
    validate_session(session)?;
    let transaction = connection.transaction()?;
    transaction.execute(
        "
        INSERT INTO bridge_sessions (
          id, workspace_id, provider, model, effort, title, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          provider = excluded.provider,
          model = excluded.model,
          effort = excluded.effort,
          title = excluded.title,
          updated_at = excluded.updated_at
        ",
        params![
            session.id,
            session.workspace_id,
            session.provider,
            session.model,
            session.effort,
            session.title,
            session.created_at,
            session.updated_at,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn append_turn(
    connection: &mut Connection,
    turn: &BridgeMemoryTurn,
) -> BridgeMemoryStoreResult<()> {
    validate_turn(turn)?;
    let metadata_json = turn
        .metadata_json
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;

    let transaction = connection.transaction()?;
    transaction.execute(
        "
        INSERT INTO bridge_turns (
          session_id, turn_id, workspace_id, role, text, metadata_json, created_at, position
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(session_id, turn_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          role = excluded.role,
          text = excluded.text,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at,
          position = excluded.position
        ",
        params![
            turn.session_id,
            turn.turn_id,
            turn.workspace_id,
            turn.role,
            turn.text,
            metadata_json,
            turn.created_at,
            turn.position,
        ],
    )?;
    transaction.execute(
        "DELETE FROM bridge_turns_fts WHERE session_id = ?1 AND turn_id = ?2",
        params![turn.session_id, turn.turn_id],
    )?;
    transaction.execute(
        "
        INSERT INTO bridge_turns_fts (workspace_id, session_id, turn_id, role, text)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ",
        params![
            turn.workspace_id,
            turn.session_id,
            turn.turn_id,
            turn.role,
            turn.text,
        ],
    )?;
    transaction.execute(
        "UPDATE bridge_sessions SET updated_at = MAX(updated_at, ?1) WHERE id = ?2",
        params![turn.created_at, turn.session_id],
    )?;
    transaction.commit()?;
    Ok(())
}

pub fn list_recent_turns(
    connection: &Connection,
    session_id: &str,
    limit: i64,
) -> BridgeMemoryStoreResult<Vec<BridgeMemoryTurn>> {
    let limit = clamp_limit(limit, MAX_RECENT_TURNS_LIMIT);
    if session_id.trim().is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let mut statement = connection.prepare(
        "
        SELECT session_id, turn_id, workspace_id, role, text, metadata_json, created_at, position
        FROM (
          SELECT session_id, turn_id, workspace_id, role, text, metadata_json, created_at, position
          FROM bridge_turns
          WHERE session_id = ?1
          ORDER BY position DESC, created_at DESC
          LIMIT ?2
        )
        ORDER BY position ASC, created_at ASC
        ",
    )?;

    let rows = statement.query_map(params![session_id, limit], bridge_memory_turn_from_row)?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(BridgeMemoryStoreError::Database)
}

pub fn search_turns(
    connection: &Connection,
    workspace_id: &str,
    query: &str,
    limit: i64,
) -> BridgeMemoryStoreResult<Vec<BridgeMemorySearchHit>> {
    let fts_query = build_fts_query(query);
    let limit = clamp_limit(limit, MAX_SEARCH_LIMIT);
    if workspace_id.trim().is_empty() || fts_query.is_empty() || limit == 0 {
        return Ok(Vec::new());
    }

    let mut statement = connection.prepare(
        "
        SELECT session_id, turn_id, workspace_id, role, text, bm25(bridge_turns_fts) AS rank
        FROM bridge_turns_fts
        WHERE bridge_turns_fts MATCH ?1
          AND workspace_id = ?2
        ORDER BY rank ASC
        LIMIT ?3
        ",
    )?;

    let rows = statement.query_map(params![fts_query, workspace_id, limit], |row| {
        Ok(BridgeMemorySearchHit {
            session_id: row.get(0)?,
            turn_id: row.get(1)?,
            workspace_id: row.get(2)?,
            role: row.get(3)?,
            text: row.get(4)?,
            rank: row.get(5)?,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(BridgeMemoryStoreError::Database)
}

fn bridge_memory_turn_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BridgeMemoryTurn> {
    let metadata_json = match row.get::<_, Option<String>>(5)? {
        Some(raw) => Some(serde_json::from_str(&raw).map_err(json_to_sql_error)?),
        None => None,
    };

    Ok(BridgeMemoryTurn {
        session_id: row.get(0)?,
        turn_id: row.get(1)?,
        workspace_id: row.get(2)?,
        role: row.get(3)?,
        text: row.get(4)?,
        metadata_json,
        created_at: row.get(6)?,
        position: row.get(7)?,
    })
}

fn validate_session(session: &BridgeMemorySession) -> BridgeMemoryStoreResult<()> {
    if session.id.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "session id is required".to_string(),
        ));
    }
    if session.workspace_id.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "workspace id is required".to_string(),
        ));
    }
    if session.provider.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "provider is required".to_string(),
        ));
    }
    Ok(())
}

fn validate_turn(turn: &BridgeMemoryTurn) -> BridgeMemoryStoreResult<()> {
    if turn.session_id.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "session id is required".to_string(),
        ));
    }
    if turn.turn_id.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "turn id is required".to_string(),
        ));
    }
    if turn.workspace_id.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "workspace id is required".to_string(),
        ));
    }
    if turn.role.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "role is required".to_string(),
        ));
    }
    if turn.text.trim().is_empty() {
        return Err(BridgeMemoryStoreError::InvalidRecord(
            "text is required".to_string(),
        ));
    }
    Ok(())
}

fn build_fts_query(query: &str) -> String {
    query
        .split(|ch: char| !ch.is_alphanumeric())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .take(16)
        .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn clamp_limit(limit: i64, max: i64) -> i64 {
    limit.clamp(0, max)
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn json_to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_turns_and_searches_them_with_fts5() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bridge-memory.sqlite3");
        let mut connection = open_store(&path).expect("open store");
        let session = BridgeMemorySession {
            id: "hist-1".to_string(),
            workspace_id: "ws-1".to_string(),
            provider: "codex-headless".to_string(),
            model: Some("gpt-5.5".to_string()),
            effort: None,
            title: Some("Daily report".to_string()),
            created_at: 10,
            updated_at: 10,
        };

        upsert_session(&mut connection, &session).expect("upsert session");
        append_turn(
            &mut connection,
            &BridgeMemoryTurn {
                session_id: "hist-1".to_string(),
                turn_id: "u1".to_string(),
                workspace_id: "ws-1".to_string(),
                role: "user".to_string(),
                text: "buat daily report dari commit hari ini".to_string(),
                metadata_json: None,
                created_at: 11,
                position: 0,
            },
        )
        .expect("append user turn");
        append_turn(
            &mut connection,
            &BridgeMemoryTurn {
                session_id: "hist-1".to_string(),
                turn_id: "a1".to_string(),
                workspace_id: "ws-1".to_string(),
                role: "assistant".to_string(),
                text: "report sedang saya cek".to_string(),
                metadata_json: Some(serde_json::json!({ "source": "bridge" })),
                created_at: 12,
                position: 1,
            },
        )
        .expect("append assistant turn");

        let turns = list_recent_turns(&connection, "hist-1", 10).expect("list turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].turn_id, "u1");
        assert_eq!(
            turns[1].metadata_json,
            Some(serde_json::json!({ "source": "bridge" }))
        );

        let hits = search_turns(&connection, "ws-1", "daily", 10).expect("search turns");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].turn_id, "u1");
    }

    #[test]
    fn appending_existing_turn_replaces_fts_document() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("bridge-memory.sqlite3");
        let mut connection = open_store(&path).expect("open store");
        upsert_session(
            &mut connection,
            &BridgeMemorySession {
                id: "hist-1".to_string(),
                workspace_id: "ws-1".to_string(),
                provider: "claude-headless".to_string(),
                model: None,
                effort: None,
                title: None,
                created_at: 10,
                updated_at: 10,
            },
        )
        .expect("upsert session");

        let mut turn = BridgeMemoryTurn {
            session_id: "hist-1".to_string(),
            turn_id: "a1".to_string(),
            workspace_id: "ws-1".to_string(),
            role: "assistant".to_string(),
            text: "daily report draft".to_string(),
            metadata_json: None,
            created_at: 11,
            position: 1,
        };
        append_turn(&mut connection, &turn).expect("append first");
        turn.text = "weekly report draft".to_string();
        append_turn(&mut connection, &turn).expect("append replacement");

        assert!(search_turns(&connection, "ws-1", "daily", 10)
            .expect("search old term")
            .is_empty());
        assert_eq!(
            search_turns(&connection, "ws-1", "weekly", 10)
                .expect("search new term")
                .len(),
            1
        );
    }

    #[test]
    fn search_query_is_sanitized_before_match() {
        let query = build_fts_query("daily: report OR commit?");
        assert_eq!(query, "\"daily\" \"report\" \"OR\" \"commit\"");
    }
}
