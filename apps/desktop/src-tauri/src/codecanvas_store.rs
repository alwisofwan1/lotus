use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use thiserror::Error;

const STATE_KEY: &str = "default";

#[derive(Debug, Error)]
pub enum CodeCanvasStoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("path error: {0}")]
    Path(String),
    #[error("project root is empty")]
    EmptyRoot,
}

pub type CodeCanvasStoreResult<T> = Result<T, CodeCanvasStoreError>;

/// Which machine a project's `root_dir` lives on.
///
/// Mirrors `CodeSpaceStoredWorkspaceLocation` in `src/lib/tauri/codespace.ts` on purpose: CodeSpace
/// has carried this shape since the SSH right panel shipped, and a second spelling of "where" would
/// be one more place to decide whether two targets are the same machine.
///
/// The remote working directory is **not** carried here — it is `root_dir`, exactly as a local
/// project's path is. A project is a directory; this says whose directory.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CodeCanvasProjectLocation {
    Local,
    #[serde(rename_all = "camelCase")]
    Ssh {
        host: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        user: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        port: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        label: Option<String>,
    },
}

impl Default for CodeCanvasProjectLocation {
    fn default() -> Self {
        Self::Local
    }
}

pub const LOCAL_LOCATION_KEY: &str = "local";

impl CodeCanvasProjectLocation {
    /// The identity two projects are compared by — the string the UNIQUE index is half of.
    ///
    /// Normalised the same way `remote_transport::TransportKey` normalises a target (trim, lowercase
    /// host and user), so "the same machine" means the same thing to the connection pool and to the
    /// project list. A machine reached as `Root@Host` and as `root@host` is one machine in both.
    pub fn key(&self) -> String {
        match self {
            Self::Local => LOCAL_LOCATION_KEY.to_string(),
            Self::Ssh {
                host, user, port, ..
            } => {
                let host = host.trim().to_ascii_lowercase();
                let user = user
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_ascii_lowercase);
                let mut key = String::from("ssh:");
                if let Some(user) = user {
                    key.push_str(&user);
                    key.push('@');
                }
                key.push_str(&host);
                if let Some(port) = port {
                    key.push(':');
                    key.push_str(&port.to_string());
                }
                key
            }
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeCanvasProjectMeta {
    pub id: String,
    #[serde(rename = "rootDir")]
    pub root_dir: String,
    pub alias: Option<String>,
    pub position: i64,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
    #[serde(rename = "lastOpenedAt")]
    pub last_opened_at: i64,
    /// Absent on every row written before the VPS connector; read back as `Local`.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub location: Option<CodeCanvasProjectLocation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeCanvasProjectSnapshot {
    #[serde(flatten)]
    pub meta: CodeCanvasProjectMeta,
    pub nodes: Value,
    pub edges: Value,
    #[serde(rename = "terminalCounter")]
    pub terminal_counter: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodeCanvasProjectIndex {
    pub projects: Vec<CodeCanvasProjectMeta>,
    #[serde(rename = "activeProjectId")]
    pub active_project_id: Option<String>,
}

pub fn database_path(app: &AppHandle) -> CodeCanvasStoreResult<PathBuf> {
    // dev/release share one app_data_dir (same bundle identifier), so the filename
    // carries the profile split — mirrors ~/.lotus-dev vs ~/.lotus. Keeps a `tauri dev`
    // debugging session from mutating the canvas data of the bundled release build.
    let file = if crate::paths::is_dev_profile() {
        "codecanvas-dev.sqlite3"
    } else {
        "codecanvas.sqlite3"
    };
    app.path()
        .app_data_dir()
        .map(|path| path.join(file))
        .map_err(|err| CodeCanvasStoreError::Path(err.to_string()))
}

pub fn open_app_store(app: &AppHandle) -> CodeCanvasStoreResult<Connection> {
    open_store(&database_path(app)?)
}

pub fn open_store(path: &Path) -> CodeCanvasStoreResult<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let connection = Connection::open(path)?;
    apply_migrations(&connection)?;
    Ok(connection)
}

fn apply_migrations(connection: &Connection) -> CodeCanvasStoreResult<()> {
    connection.execute_batch(
        "
        -- WAL lets one writer proceed alongside readers; busy_timeout makes concurrent agent
        -- writers wait for the write lock instead of failing immediately with SQLITE_BUSY. The app
        -- opens a fresh connection per Tauri/MCP call, so these per-connection pragmas run each open.
        PRAGMA journal_mode = WAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS codecanvas_projects (
          id TEXT PRIMARY KEY,
          root_dir TEXT NOT NULL,
          alias TEXT,
          position INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL,
          location_key TEXT NOT NULL DEFAULT 'local',
          location_json TEXT,
          UNIQUE(location_key, root_dir)
        );
        CREATE TABLE IF NOT EXISTS codecanvas_state (
          key TEXT PRIMARY KEY,
          active_project_id TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS codecanvas_snapshots (
          project_id TEXT PRIMARY KEY,
          schema_version INTEGER NOT NULL DEFAULT 1,
          nodes_json TEXT NOT NULL,
          edges_json TEXT NOT NULL,
          terminal_counter INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(project_id) REFERENCES codecanvas_projects(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS codecanvas_agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          role TEXT,
          model TEXT NOT NULL,
          prompt TEXT NOT NULL,
          applied_skills_json TEXT NOT NULL DEFAULT '[]',
          effort TEXT,
          permission_mode TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS codecanvas_agent_runs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          outcome TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER NOT NULL,
          session_id TEXT,
          actions_json TEXT NOT NULL DEFAULT '[]',
          summary TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_codecanvas_agent_runs_agent ON codecanvas_agent_runs(agent_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_codecanvas_projects_position ON codecanvas_projects(position);
        CREATE TABLE IF NOT EXISTS codecanvas_graph_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          status TEXT NOT NULL,
          checkpoint_json TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(project_id) REFERENCES codecanvas_projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_codecanvas_graph_runs_project ON codecanvas_graph_runs(project_id, started_at);
        CREATE TABLE IF NOT EXISTS codecanvas_artifacts (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          bus_node_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          producer TEXT NOT NULL,
          version INTEGER NOT NULL,
          graph_run_id TEXT,
          updated_at INTEGER NOT NULL,
          UNIQUE(project_id, bus_node_id, key),
          FOREIGN KEY(project_id) REFERENCES codecanvas_projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_codecanvas_artifacts_project ON codecanvas_artifacts(project_id, updated_at);
        CREATE TABLE IF NOT EXISTS codecanvas_note_assets (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          original_name TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(project_id) REFERENCES codecanvas_projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_codecanvas_note_assets_project ON codecanvas_note_assets(project_id, created_at);
        CREATE TABLE IF NOT EXISTS codecanvas_collaboration_records (
          project_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY(project_id, run_id, kind),
          FOREIGN KEY(project_id) REFERENCES codecanvas_projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_codecanvas_collaboration_project ON codecanvas_collaboration_records(project_id, updated_at);
        CREATE TABLE IF NOT EXISTS codecanvas_memory_items (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          scope_kind TEXT NOT NULL,
          scope_id TEXT,
          kind TEXT NOT NULL,
          title TEXT,
          body TEXT NOT NULL,
          summary TEXT,
          status TEXT,
          importance INTEGER NOT NULL DEFAULT 0,
          tags_json TEXT NOT NULL DEFAULT '[]',
          metadata_json TEXT NOT NULL DEFAULT '{}',
          source TEXT NOT NULL,
          actor_id TEXT,
          actor_kind TEXT NOT NULL,
          node_id TEXT,
          run_id TEXT,
          assignment_key TEXT,
          session_id TEXT,
          parent_id TEXT,
          idempotency_key TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived_at INTEGER,
          FOREIGN KEY(project_id) REFERENCES codecanvas_projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_codecanvas_memory_project_updated
          ON codecanvas_memory_items(project_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_codecanvas_memory_scope
          ON codecanvas_memory_items(project_id, scope_kind, scope_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_codecanvas_memory_run
          ON codecanvas_memory_items(project_id, run_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_codecanvas_memory_assignment
          ON codecanvas_memory_items(project_id, run_id, assignment_key, updated_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_codecanvas_memory_idempotency
          ON codecanvas_memory_items(project_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        CREATE VIRTUAL TABLE IF NOT EXISTS codecanvas_memory_fts USING fts5(
          project_id UNINDEXED,
          item_id UNINDEXED,
          title,
          body,
          summary,
          tokenize='unicode61'
        );
        -- Keep the FTS index in lockstep with the source rows in the same transaction as the
        -- write/delete. Triggers make FTS an invariant of the table instead of the caller's job,
        -- so cascade deletes (project close/delete) can never orphan FTS rows.
        CREATE TRIGGER IF NOT EXISTS trg_codecanvas_memory_fts_ai
          AFTER INSERT ON codecanvas_memory_items
        BEGIN
          INSERT INTO codecanvas_memory_fts (project_id, item_id, title, body, summary)
          VALUES (new.project_id, new.id, new.title, new.body, new.summary);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_codecanvas_memory_fts_ad
          AFTER DELETE ON codecanvas_memory_items
        BEGIN
          DELETE FROM codecanvas_memory_fts WHERE item_id = old.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_codecanvas_memory_fts_au
          AFTER UPDATE OF title, body, summary ON codecanvas_memory_items
        BEGIN
          UPDATE codecanvas_memory_fts
             SET title = new.title, body = new.body, summary = new.summary
           WHERE item_id = old.id;
        END;
        ",
    )?;
    // Session rows live in their own module because two of their schema choices are decisions with
    // reasons attached (no cascade off the project, a partial unique index on the provider id).
    crate::codecanvas_sessions::ensure_schema(connection)?;
    ensure_column(connection, "codecanvas_agents", "effort", "TEXT")?;
    ensure_column(connection, "codecanvas_agents", "permission_mode", "TEXT")?;
    // Links a node-run to the graph run that drove it (null for ad-hoc single-node runs).
    ensure_column(connection, "codecanvas_agent_runs", "graph_run_id", "TEXT")?;
    // Token/cost accounting captured from the stream-json result event.
    ensure_column(connection, "codecanvas_agent_runs", "usage_json", "TEXT")?;
    ensure_column(connection, "codecanvas_graph_runs", "workflow_id", "TEXT")?;
    migrate_projects_to_located(connection)?;
    Ok(())
}

/// Give `codecanvas_projects` a machine, and move UNIQUE off the bare path onto `(machine, path)`.
///
/// **Why this is a table rebuild and not an `ensure_column`.** The columns alone would be an
/// `ALTER TABLE`, but the constraint is the point: `root_dir TEXT NOT NULL UNIQUE` means two VPS
/// that both keep a repo at `/root/app` cannot both be projects, and the failure is a constraint
/// violation at save time rather than anything an operator could read. SQLite cannot drop a UNIQUE
/// constraint in place, so the table is rebuilt.
///
/// **The trap this function exists to step around.** `apply_migrations` runs `PRAGMA foreign_keys =
/// ON`, and `codecanvas_snapshots`, `codecanvas_graph_runs` and `codecanvas_artifacts` all hold
/// `REFERENCES codecanvas_projects(id) ON DELETE CASCADE`. Dropping the old table with foreign keys
/// enabled would cascade — every saved board on this machine, deleted by a migration. Foreign keys
/// are therefore switched off around the swap (SQLite refuses the pragma inside a transaction, so
/// it sits outside), and `foreign_key_check` verifies afterwards that nothing was orphaned.
///
/// Ids are deliberately unchanged for local projects: `project_id_for` hashes the bare path when the
/// machine is local, so every existing row keeps the id its snapshot is filed under.
fn migrate_projects_to_located(connection: &Connection) -> CodeCanvasStoreResult<()> {
    if has_column(connection, "codecanvas_projects", "location_key")? {
        return Ok(());
    }

    connection.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let outcome = rebuild_projects_table(connection);
    connection.execute_batch("PRAGMA foreign_keys = ON;")?;
    outcome?;

    let orphans: i64 = connection
        .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);
    if orphans > 0 {
        return Err(CodeCanvasStoreError::Path(format!(
            "project migration left {orphans} orphaned rows"
        )));
    }
    Ok(())
}

fn rebuild_projects_table(connection: &Connection) -> CodeCanvasStoreResult<()> {
    connection.execute_batch(
        "
        BEGIN IMMEDIATE;
        CREATE TABLE codecanvas_projects_located (
          id TEXT PRIMARY KEY,
          root_dir TEXT NOT NULL,
          alias TEXT,
          position INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL,
          location_key TEXT NOT NULL DEFAULT 'local',
          location_json TEXT,
          UNIQUE(location_key, root_dir)
        );
        INSERT INTO codecanvas_projects_located
          (id, root_dir, alias, position, updated_at, last_opened_at, location_key, location_json)
        SELECT id, root_dir, alias, position, updated_at, last_opened_at, 'local', NULL
        FROM codecanvas_projects;
        DROP TABLE codecanvas_projects;
        ALTER TABLE codecanvas_projects_located RENAME TO codecanvas_projects;
        CREATE INDEX IF NOT EXISTS idx_codecanvas_projects_position ON codecanvas_projects(position);
        COMMIT;
        ",
    )
    .map_err(|error| {
        let _ = connection.execute_batch("ROLLBACK;");
        error
    })?;
    Ok(())
}

fn has_column(
    connection: &Connection,
    table: &str,
    column: &str,
) -> CodeCanvasStoreResult<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn ensure_column(
    connection: &Connection,
    table: &str,
    column: &str,
    ty: &str,
) -> CodeCanvasStoreResult<()> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    connection.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"), [])?;
    Ok(())
}

pub fn get_index(connection: &Connection) -> CodeCanvasStoreResult<CodeCanvasProjectIndex> {
    Ok(CodeCanvasProjectIndex {
        projects: list_project_meta(connection)?,
        active_project_id: active_project_id(connection)?,
    })
}

/// Open (or create) a project on this machine. The local path every existing caller already takes.
#[cfg(test)]
pub fn open_project(
    connection: &Connection,
    root_dir: &str,
) -> CodeCanvasStoreResult<CodeCanvasProjectSnapshot> {
    open_project_at(connection, root_dir, &CodeCanvasProjectLocation::Local)
}

/// Open (or create) a project on a named machine.
///
/// Two machines may hold the same path, so the row is keyed by `(location_key, root_dir)` — the
/// same pair the UNIQUE index enforces — and so is the id.
pub fn open_project_at(
    connection: &Connection,
    root_dir: &str,
    location: &CodeCanvasProjectLocation,
) -> CodeCanvasStoreResult<CodeCanvasProjectSnapshot> {
    let root = normalize_root_dir(root_dir)?;
    let location_key = location.key();
    let location_json = location_json_for(location)?;
    let id = project_id_for(&location_key, &root);
    let now = now_ms();
    let position = connection.query_row(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM codecanvas_projects",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    connection.execute(
        "INSERT INTO codecanvas_projects (id, root_dir, alias, position, updated_at, last_opened_at, location_key, location_json)
         VALUES (?1, ?2, NULL, ?3, ?4, ?4, ?5, ?6)
         ON CONFLICT(location_key, root_dir) DO UPDATE SET last_opened_at = excluded.last_opened_at, updated_at = excluded.updated_at",
        params![id, root, position, now, location_key, location_json],
    )?;
    set_active_project(connection, Some(&id))?;
    load_project(connection, &id)?.ok_or(CodeCanvasStoreError::Database(
        rusqlite::Error::QueryReturnedNoRows,
    ))
}

pub fn load_project(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Option<CodeCanvasProjectSnapshot>> {
    let Some(meta) = get_project_meta(connection, project_id)? else {
        return Ok(None);
    };
    let snapshot = connection.query_row(
        "SELECT nodes_json, edges_json, terminal_counter FROM codecanvas_snapshots WHERE project_id = ?1",
        [project_id],
        |row| {
            let nodes: String = row.get(0)?;
            let edges: String = row.get(1)?;
            Ok((json_value(nodes)?, json_value(edges)?, row.get(2)?))
        },
    ).optional()?;
    let (nodes, edges, terminal_counter) =
        snapshot.unwrap_or((Value::Array(vec![]), Value::Array(vec![]), 0));
    Ok(Some(CodeCanvasProjectSnapshot {
        meta,
        nodes,
        edges,
        terminal_counter,
    }))
}

pub fn save_project(
    connection: &Connection,
    snapshot: &CodeCanvasProjectSnapshot,
) -> CodeCanvasStoreResult<()> {
    let now = now_ms();
    connection.execute(
        "INSERT INTO codecanvas_projects (id, root_dir, alias, position, updated_at, last_opened_at, location_key, location_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET root_dir = excluded.root_dir, alias = excluded.alias, updated_at = excluded.updated_at, location_key = excluded.location_key, location_json = excluded.location_json",
        params![
            snapshot.meta.id,
            snapshot.meta.root_dir,
            snapshot.meta.alias,
            snapshot.meta.position,
            now,
            snapshot.meta.last_opened_at,
            snapshot.meta.location.clone().unwrap_or_default().key(),
            location_json_for(&snapshot.meta.location.clone().unwrap_or_default())?
        ],
    )?;
    connection.execute(
        "INSERT INTO codecanvas_snapshots (project_id, schema_version, nodes_json, edges_json, terminal_counter, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_id) DO UPDATE SET nodes_json = excluded.nodes_json, edges_json = excluded.edges_json,
           terminal_counter = excluded.terminal_counter, updated_at = excluded.updated_at",
        params![snapshot.meta.id, snapshot.nodes.to_string(), snapshot.edges.to_string(), snapshot.terminal_counter, now],
    )?;
    Ok(())
}

pub fn save_collaboration_record(
    connection: &Connection,
    project_id: &str,
    run_id: &str,
    kind: &str,
    payload: &Value,
) -> CodeCanvasStoreResult<()> {
    let trimmed_run = run_id.trim();
    let trimmed_kind = kind.trim();
    if trimmed_run.is_empty() || trimmed_kind.is_empty() {
        return Err(CodeCanvasStoreError::Path(
            "collaboration run id and kind are required".into(),
        ));
    }
    connection.execute(
        "INSERT INTO codecanvas_collaboration_records (project_id, run_id, kind, payload_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(project_id, run_id, kind) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at",
        params![project_id, trimmed_run, trimmed_kind, payload.to_string(), now_ms()],
    )?;
    Ok(())
}

pub fn load_collaboration_record(
    connection: &Connection,
    project_id: &str,
    run_id: &str,
    kind: &str,
) -> CodeCanvasStoreResult<Option<Value>> {
    connection.query_row(
        "SELECT payload_json FROM codecanvas_collaboration_records WHERE project_id = ?1 AND run_id = ?2 AND kind = ?3",
        params![project_id, run_id, kind],
        |row| {
            let payload: String = row.get(0)?;
            json_value(payload)
        },
    ).optional().map_err(CodeCanvasStoreError::Database)
}

pub fn rename_project(
    connection: &Connection,
    project_id: &str,
    alias: Option<String>,
) -> CodeCanvasStoreResult<()> {
    connection.execute(
        "UPDATE codecanvas_projects SET alias = ?1, updated_at = ?2 WHERE id = ?3",
        params![alias.filter(|v| !v.trim().is_empty()), now_ms(), project_id],
    )?;
    Ok(())
}

pub fn close_project(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<CodeCanvasProjectIndex> {
    let closed_position = get_project_meta(connection, project_id)?.map(|m| m.position);
    connection.execute(
        "DELETE FROM codecanvas_projects WHERE id = ?1",
        [project_id],
    )?;
    if active_project_id(connection)?.as_deref() == Some(project_id) {
        let fallback = fallback_active_project(connection, closed_position)?;
        set_active_project(connection, fallback.as_deref())?;
    }
    get_index(connection)
}

pub fn set_active_project(
    connection: &Connection,
    project_id: Option<&str>,
) -> CodeCanvasStoreResult<()> {
    connection.execute(
        "INSERT INTO codecanvas_state (key, active_project_id, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET active_project_id = excluded.active_project_id, updated_at = excluded.updated_at",
        params![STATE_KEY, project_id, now_ms()],
    )?;
    Ok(())
}

fn list_project_meta(connection: &Connection) -> CodeCanvasStoreResult<Vec<CodeCanvasProjectMeta>> {
    let mut statement = connection.prepare(
        "SELECT id, root_dir, alias, position, updated_at, last_opened_at, location_json FROM codecanvas_projects ORDER BY position ASC, updated_at ASC",
    )?;
    let rows = statement.query_map([], project_meta_from_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn get_project_meta(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Option<CodeCanvasProjectMeta>> {
    connection.query_row(
        "SELECT id, root_dir, alias, position, updated_at, last_opened_at, location_json FROM codecanvas_projects WHERE id = ?1",
        [project_id],
        project_meta_from_row,
    ).optional().map_err(Into::into)
}

fn active_project_id(connection: &Connection) -> CodeCanvasStoreResult<Option<String>> {
    connection
        .query_row(
            "SELECT active_project_id FROM codecanvas_state WHERE key = ?1",
            [STATE_KEY],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|value| value.flatten())
        .map_err(Into::into)
}

fn fallback_active_project(
    connection: &Connection,
    closed_position: Option<i64>,
) -> CodeCanvasStoreResult<Option<String>> {
    let Some(position) = closed_position else {
        return Ok(None);
    };
    let next = connection
        .query_row(
            "SELECT id FROM codecanvas_projects WHERE position > ?1 ORDER BY position ASC LIMIT 1",
            [position],
            |row| row.get(0),
        )
        .optional()?;
    if next.is_some() {
        return Ok(next);
    }
    connection
        .query_row(
            "SELECT id FROM codecanvas_projects WHERE position < ?1 ORDER BY position DESC LIMIT 1",
            [position],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn project_meta_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodeCanvasProjectMeta> {
    let location_json: Option<String> = row.get(6)?;
    Ok(CodeCanvasProjectMeta {
        id: row.get(0)?,
        root_dir: row.get(1)?,
        alias: row.get(2)?,
        position: row.get(3)?,
        updated_at: row.get(4)?,
        last_opened_at: row.get(5)?,
        location: location_json
            .as_deref()
            .map(serde_json::from_str::<CodeCanvasProjectLocation>)
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    6,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?
            .or(Some(CodeCanvasProjectLocation::Local)),
    })
}

/// `NULL` for a local project: the column is what a row written before this feature already says,
/// so a local project reads and writes identically either way.
fn location_json_for(
    location: &CodeCanvasProjectLocation,
) -> CodeCanvasStoreResult<Option<String>> {
    if location.is_local() {
        return Ok(None);
    }
    serde_json::to_string(location)
        .map(Some)
        .map_err(|error| CodeCanvasStoreError::Path(error.to_string()))
}

fn normalize_root_dir(root_dir: &str) -> CodeCanvasStoreResult<String> {
    let raw = root_dir.trim();
    if raw.is_empty() {
        return Err(CodeCanvasStoreError::EmptyRoot);
    }
    let trimmed = raw.trim_end_matches(['/', '\\']);
    Ok(if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    })
}

/// Stable project id for a path on a machine.
///
/// A local project hashes the bare path, exactly as it did before machines existed — every project
/// already on disk must keep the id its snapshot rows are filed under, or the migration would orphan
/// every board. A remote project mixes the machine in, so `/root/app` on two VPS are two projects.
fn project_id_for(location_key: &str, root_dir: &str) -> String {
    if location_key == LOCAL_LOCATION_KEY {
        return hash_id(root_dir);
    }
    hash_id(&format!("{location_key}\u{0}{root_dir}"))
}

fn hash_id(root_dir: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in root_dir.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("cp_{hash:016x}")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn json_value(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}
