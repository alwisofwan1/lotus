use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use thiserror::Error;

const SCHEMA_VERSION: i64 = 3;
const SNAPSHOT_KEY: &str = "default";

#[derive(Debug, Error)]
pub enum CodeSpaceStoreError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("filesystem error: {0}")]
    Filesystem(#[from] std::io::Error),
    #[error("path error: {0}")]
    Path(String),
}

pub type CodeSpaceStoreResult<T> = Result<T, CodeSpaceStoreError>;

fn default_runtime_status() -> String {
    "idle".to_string()
}

fn default_workspace_schema_version() -> i64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
// `rename_all` names the variants ("file", "url"); `rename_all_fields` names their fields, which
// the frontend sends as `filePath`.
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum CodeSpaceWorkbenchTab {
    File {
        id: String,
        // Rows written by Rust before this fix used the field name as is.
        #[serde(alias = "file_path")]
        file_path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dirty: Option<bool>,
    },
    Url {
        id: String,
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSpaceStoredPane {
    pub id: String,
    pub cwd: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub pane_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_command: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_session_id: Option<String>,
    #[serde(default = "default_runtime_status")]
    pub runtime_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tabs: Option<Vec<CodeSpaceWorkbenchTab>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_tab_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_collapsed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_width: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    // (Slice 08) Terminal cell only. `#[serde(rename_all = "camelCase")]` on the struct already
    // maps each of these to the camelCase key the TS side sends (paneTitle, paneTitleUpdatedAt,
    // agentName, customDisplayName) — no per-field rename needed, matching every other field
    // here. `Option<T>` deserializes missing keys as `None` on its own (as the fields above
    // already rely on), so an old JSON blob without these keys stays backward-compatible with
    // no schema/migration bump.
    /// Auto-generated conversation title. Only ever written when `titleStatus === "ready"` on
    /// the TS side — see `workspace-metadata.ts`, which explains why (a crash mid-generation
    /// must not strand a pane in `generating` forever after restart).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_title: Option<String>,
    /// Epoch ms when `pane_title` was last refreshed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_title_updated_at: Option<i64>,
    /// Which agent conversation `pane_title` names (its transcript path). When the pane's agent
    /// starts another conversation the key changes, and the old title is no longer kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_title_session_key: Option<String>,
    /// System-allocated human name (`Nara`, `Bima`, …). Never recomputed — must survive a
    /// restart unchanged, unlike `agentAddress`/`legacyAgentAddresses`, which are re-derived
    /// every render from the live provider (see `workspace-metadata.ts:162-164`) and are
    /// deliberately NOT persisted here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// User-chosen rename, always wins over `agent_name` in `display_name`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_display_name: Option<String>,
    /// Chat cell only: which CodeChat conversation this pane shows.
    ///
    /// A reference, not the conversation — the messages live in the CodeChat SQLite store. A
    /// snapshot therefore never holds a stale copy of a thread, and an older build that does
    /// not know the `"chat"` pane type simply ignores this key: `Option<T>` deserializes a
    /// missing field as `None`, and the TS side degrades an unknown pane type to a terminal
    /// rather than dropping the pane. No schema bump, both directions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Chat cell on New Chat (beta, 07d): the chat runtime thread this pane runs instead. Same
    /// reference-only rule as `session_id`; `id` is None until the pane's first message.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<CodeSpaceStoredChatThread>,
    /// Browser cell only: the agent pane its element picks go to (plans/code-browser-redesign).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_pane_id: Option<String>,
    /// Terminal cell only: the Lotus Claude account the pane runs on (issues/07); `default`
    /// means `CLAUDE_CONFIG_DIR` unset, absent means the globally chosen account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_account: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CodeSpaceStoredChatThread {
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSpaceStoredWorkspace {
    pub id: String,
    pub label: String,
    pub color: String,
    pub cwd: String,
    #[serde(default = "default_workspace_schema_version")]
    pub schema_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_layout: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right_panel: Option<serde_json::Value>,
    pub rows: i64,
    pub cols: i64,
    #[serde(default)]
    pub row_fractions: Vec<f64>,
    #[serde(default)]
    pub col_fractions: Vec<f64>,
    #[serde(default)]
    pub cells: Vec<CodeSpaceStoredPane>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSpaceStoredSnapshot {
    #[serde(default)]
    pub workspaces: Vec<CodeSpaceStoredWorkspace>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused_cell_id: Option<String>,
    pub updated_at: i64,
}

pub fn database_path(app: &AppHandle) -> CodeSpaceStoreResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("codespace.sqlite3"))
        .map_err(|err| CodeSpaceStoreError::Path(err.to_string()))
}

pub fn open_app_store(app: &AppHandle) -> CodeSpaceStoreResult<Connection> {
    let path = database_path(app)?;
    open_store(&path)
}

pub fn open_store(path: &Path) -> CodeSpaceStoreResult<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let connection = Connection::open(path)?;
    apply_migrations(&connection)?;
    Ok(connection)
}

/// A workspace Lotus has seen, open or closed. Kept after the workspace closes so reopening the
/// same folder can reuse its id: Lotus Tasks and automations are keyed by workspace id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodeSpaceKnownWorkspace {
    pub id: String,
    pub label: String,
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<serde_json::Value>,
    /// When a snapshot last held it (epoch ms).
    pub last_seen_at: i64,
}

fn apply_migrations(connection: &Connection) -> CodeSpaceStoreResult<()> {
    connection.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS codespace_snapshot (
          key TEXT PRIMARY KEY,
          active_workspace_id TEXT,
          focused_cell_id TEXT,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS codespace_workspaces (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          color TEXT NOT NULL,
          cwd TEXT NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          rows INTEGER NOT NULL,
          cols INTEGER NOT NULL,
          row_fractions_json TEXT NOT NULL,
          col_fractions_json TEXT NOT NULL,
          position INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS codespace_panes (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          cwd TEXT NOT NULL,
          pane_json TEXT,
          runtime_session_id TEXT,
          runtime_status TEXT NOT NULL,
          agent_command TEXT,
          position INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (workspace_id) REFERENCES codespace_workspaces(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS codespace_known_workspaces (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          cwd TEXT NOT NULL,
          location_json TEXT,
          last_seen_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_codespace_workspaces_position ON codespace_workspaces(position);
        CREATE INDEX IF NOT EXISTS idx_codespace_panes_workspace_position ON codespace_panes(workspace_id, position);
        ",
    )?;

    if !column_exists(connection, "codespace_workspaces", "location_json")? {
        connection.execute(
            "ALTER TABLE codespace_workspaces ADD COLUMN location_json TEXT",
            [],
        )?;
    }

    if !column_exists(connection, "codespace_workspaces", "schema_version")? {
        connection.execute(
            "ALTER TABLE codespace_workspaces ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }

    if !column_exists(connection, "codespace_workspaces", "pane_layout_json")? {
        connection.execute(
            "ALTER TABLE codespace_workspaces ADD COLUMN pane_layout_json TEXT",
            [],
        )?;
    }

    if !column_exists(connection, "codespace_workspaces", "right_panel_json")? {
        connection.execute(
            "ALTER TABLE codespace_workspaces ADD COLUMN right_panel_json TEXT",
            [],
        )?;
    }

    if !column_exists(connection, "codespace_panes", "pane_json")? {
        connection.execute("ALTER TABLE codespace_panes ADD COLUMN pane_json TEXT", [])?;
    }

    connection.execute(
        "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
        params![SCHEMA_VERSION, now_millis()],
    )?;

    Ok(())
}

pub fn load_snapshot(
    connection: &Connection,
) -> CodeSpaceStoreResult<Option<CodeSpaceStoredSnapshot>> {
    let metadata = connection.query_row(
        "
        SELECT active_workspace_id, focused_cell_id, updated_at
        FROM codespace_snapshot
        WHERE key = ?1
        ",
        params![SNAPSHOT_KEY],
        |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    );

    let (active_workspace_id, focused_cell_id, updated_at) = match metadata {
        Ok(value) => value,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(err) => return Err(CodeSpaceStoreError::Database(err)),
    };

    let mut workspace_statement = connection.prepare(
        "
        SELECT
          id,
          label,
          color,
          cwd,
          schema_version,
          rows,
          cols,
          row_fractions_json,
          col_fractions_json,
          location_json,
          pane_layout_json,
          right_panel_json
        FROM codespace_workspaces
        ORDER BY position ASC
        ",
    )?;
    let workspace_rows = workspace_statement.query_map([], |row| {
        let row_fractions_json: String = row.get(7)?;
        let col_fractions_json: String = row.get(8)?;
        let location_json: Option<String> = row.get(9)?;
        let pane_layout_json: Option<String> = row.get(10)?;
        let right_panel_json: Option<String> = row.get(11)?;
        Ok(CodeSpaceStoredWorkspace {
            id: row.get(0)?,
            label: row.get(1)?,
            color: row.get(2)?,
            cwd: row.get(3)?,
            schema_version: row.get(4)?,
            rows: row.get(5)?,
            cols: row.get(6)?,
            row_fractions: serde_json::from_str(&row_fractions_json).map_err(json_to_sql_error)?,
            col_fractions: serde_json::from_str(&col_fractions_json).map_err(json_to_sql_error)?,
            location: location_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(json_to_sql_error)?,
            pane_layout: pane_layout_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(json_to_sql_error)?,
            right_panel: right_panel_json
                .as_deref()
                .map(serde_json::from_str)
                .transpose()
                .map_err(json_to_sql_error)?,
            cells: Vec::new(),
        })
    })?;

    let mut workspaces = workspace_rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(CodeSpaceStoreError::Database)?;

    for workspace in &mut workspaces {
        workspace.cells = load_panes_for_workspace(connection, &workspace.id)?;
    }

    Ok(Some(CodeSpaceStoredSnapshot {
        workspaces,
        active_workspace_id,
        focused_cell_id,
        updated_at,
    }))
}

pub fn save_snapshot(
    connection: &mut Connection,
    snapshot: &CodeSpaceStoredSnapshot,
) -> CodeSpaceStoreResult<()> {
    let transaction = connection.transaction()?;
    let updated_at = if snapshot.updated_at > 0 {
        snapshot.updated_at
    } else {
        now_millis()
    };

    transaction.execute("DELETE FROM codespace_panes", [])?;
    transaction.execute("DELETE FROM codespace_workspaces", [])?;

    transaction.execute(
        "
        INSERT INTO codespace_snapshot (
          key,
          active_workspace_id,
          focused_cell_id,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4)
        ON CONFLICT(key) DO UPDATE SET
          active_workspace_id = excluded.active_workspace_id,
          focused_cell_id = excluded.focused_cell_id,
          updated_at = excluded.updated_at
        ",
        params![
            SNAPSHOT_KEY,
            snapshot.active_workspace_id,
            snapshot.focused_cell_id,
            updated_at,
        ],
    )?;

    for (workspace_position, workspace) in snapshot.workspaces.iter().enumerate() {
        transaction.execute(
            "
            INSERT INTO codespace_workspaces (
              id,
              label,
              color,
              cwd,
              schema_version,
              rows,
              cols,
              row_fractions_json,
              col_fractions_json,
              location_json,
              pane_layout_json,
              right_panel_json,
              position,
              updated_at
            )
            VALUES (
              ?1,
              ?2,
              ?3,
              ?4,
              ?5,
              ?6,
              ?7,
              ?8,
              ?9,
              ?10,
              ?11,
              ?12,
              ?13,
              ?14
            )
            ",
            params![
                workspace.id,
                workspace.label,
                workspace.color,
                workspace.cwd,
                workspace.schema_version,
                workspace.rows,
                workspace.cols,
                serde_json::to_string(&workspace.row_fractions)?,
                serde_json::to_string(&workspace.col_fractions)?,
                workspace
                    .location
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                workspace
                    .pane_layout
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                workspace
                    .right_panel
                    .as_ref()
                    .map(serde_json::to_string)
                    .transpose()?,
                workspace_position as i64,
                updated_at,
            ],
        )?;

        // Never deleted: a closed workspace must stay findable by its folder.
        transaction.execute(
            "
            INSERT INTO codespace_known_workspaces (id, label, cwd, location_json, last_seen_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(id) DO UPDATE SET
              label = excluded.label,
              cwd = excluded.cwd,
              location_json = excluded.location_json,
              last_seen_at = excluded.last_seen_at
            ",
            params![
                workspace.id,
                workspace.label,
                workspace.cwd,
                workspace.location.as_ref().map(serde_json::to_string).transpose()?,
                updated_at,
            ],
        )?;

        for (pane_position, pane) in workspace.cells.iter().enumerate() {
            transaction.execute(
                "
                INSERT INTO codespace_panes (
                  id,
                  workspace_id,
                  cwd,
                  pane_json,
                  runtime_session_id,
                  runtime_status,
                  agent_command,
                  position,
                  updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ",
                params![
                    pane.id,
                    workspace.id,
                    pane.cwd,
                    serde_json::to_string(pane)?,
                    pane.runtime_session_id,
                    pane.runtime_status,
                    pane.agent_command,
                    pane_position as i64,
                    updated_at,
                ],
            )?;
        }
    }

    transaction.commit()?;
    Ok(())
}

/// Every workspace any snapshot has held, most recently seen first.
pub fn load_known_workspaces(connection: &Connection) -> CodeSpaceStoreResult<Vec<CodeSpaceKnownWorkspace>> {
    let mut statement = connection.prepare(
        "SELECT id, label, cwd, location_json, last_seen_at FROM codespace_known_workspaces ORDER BY last_seen_at DESC, id ASC",
    )?;
    let rows = statement.query_map([], |row| {
        let location_json: Option<String> = row.get(3)?;
        Ok(CodeSpaceKnownWorkspace {
            id: row.get(0)?,
            label: row.get(1)?,
            cwd: row.get(2)?,
            location: location_json.as_deref().map(serde_json::from_str).transpose().map_err(json_to_sql_error)?,
            last_seen_at: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(CodeSpaceStoreError::Database)
}

/// The folder of every open workspace and every pane in one (Settings › Worktrees: "in use").
pub fn open_folders(connection: &Connection) -> CodeSpaceStoreResult<Vec<String>> {
    let mut statement = connection.prepare("SELECT cwd FROM codespace_workspaces UNION SELECT cwd FROM codespace_panes")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(CodeSpaceStoreError::Database)
}

fn load_panes_for_workspace(
    connection: &Connection,
    workspace_id: &str,
) -> CodeSpaceStoreResult<Vec<CodeSpaceStoredPane>> {
    let mut statement = connection.prepare(
        "
        SELECT id, cwd, runtime_session_id, runtime_status, agent_command, pane_json
        FROM codespace_panes
        WHERE workspace_id = ?1
        ORDER BY position ASC
        ",
    )?;
    let rows = statement.query_map(params![workspace_id], |row| {
        let pane_json: Option<String> = row.get(5)?;
        if let Some(serialized) = pane_json {
            return serde_json::from_str::<CodeSpaceStoredPane>(&serialized)
                .map_err(json_to_sql_error);
        }

        Ok(CodeSpaceStoredPane {
            id: row.get(0)?,
            cwd: row.get(1)?,
            pane_type: Some("terminal".to_string()),
            terminal_command: None,
            runtime_session_id: row.get(2)?,
            runtime_status: row.get(3)?,
            agent_command: row.get(4)?,
            url: None,
            zoom: None,
            title: None,
            root_dir: None,
            tabs: None,
            active_tab_id: None,
            sidebar_collapsed: None,
            sidebar_width: None,
            team_id: None,
            mode: None,
            pane_title: None,
            pane_title_updated_at: None,
            pane_title_session_key: None,
            agent_name: None,
            custom_display_name: None,
            session_id: None,
            thread: None,
            linked_pane_id: None,
            claude_account: None,
        })
    })?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(CodeSpaceStoreError::Database)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn json_to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> CodeSpaceStoreResult<bool> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend sends `filePath` (`src/lib/tauri/codespace.ts`). `rename_all` on an enum
    /// renames the variants only, so the field was read as `file_path` and every save with an
    /// open file tab failed with "missing field `file_path`".
    #[test]
    fn workbench_file_tab_reads_the_frontend_camel_case_shape() {
        let json = r#"{"kind":"file","id":"file:/r/a.ts","filePath":"/r/a.ts","dirty":true}"#;
        let tab: CodeSpaceWorkbenchTab = serde_json::from_str(json).expect("file tab parses");
        assert_eq!(
            tab,
            CodeSpaceWorkbenchTab::File {
                id: "file:/r/a.ts".into(),
                file_path: "/r/a.ts".into(),
                dirty: Some(true),
            }
        );
        let written = serde_json::to_value(&tab).expect("file tab serializes");
        assert_eq!(written["filePath"], "/r/a.ts");
    }

    /// M1.1: the chat pane type, and the promise that a snapshot only ever holds a REFERENCE to
    /// a conversation. See `plans/unified-workspace-shell/PLAN.md`.
    #[test]
    fn chat_pane_round_trips_its_session_reference() {
        let json = r#"{"id":"pane-chat","cwd":"/tmp/project","type":"chat","sessionId":"session-7"}"#;
        let pane: CodeSpaceStoredPane = serde_json::from_str(json).expect("chat pane parses");

        assert_eq!(pane.pane_type.as_deref(), Some("chat"));
        assert_eq!(pane.session_id.as_deref(), Some("session-7"));

        let encoded = serde_json::to_string(&pane).expect("chat pane serializes");
        assert!(encoded.contains("\"sessionId\":\"session-7\""));
    }

    /// 07d: a new-chat pane keeps its thread reference, including "no thread yet".
    #[test]
    fn chat_pane_round_trips_its_thread_reference() {
        let json = r#"{"id":"p","cwd":"/w","type":"chat","sessionId":"","thread":{"id":null}}"#;
        let pane: CodeSpaceStoredPane = serde_json::from_str(json).expect("chat pane parses");
        assert_eq!(pane.thread, Some(CodeSpaceStoredChatThread { id: None, title: None }));

        let json = r#"{"id":"p","cwd":"/w","type":"chat","sessionId":"","thread":{"id":"t1","title":"Fix it"}}"#;
        let pane: CodeSpaceStoredPane = serde_json::from_str(json).expect("chat pane parses");
        let encoded = serde_json::to_string(&pane).expect("chat pane serializes");
        assert!(encoded.contains(r#""thread":{"id":"t1","title":"Fix it"}"#));
    }

    /// A snapshot written before the chat pane existed must still load, and must not start
    /// growing a key it never had.
    #[test]
    fn pane_written_before_chat_existed_still_loads() {
        let json = r#"{"id":"pane-1","cwd":"/tmp/project","type":"terminal"}"#;
        let pane: CodeSpaceStoredPane = serde_json::from_str(json).expect("legacy pane parses");

        assert!(pane.session_id.is_none());
        let encoded = serde_json::to_string(&pane).expect("legacy pane serializes");
        assert!(!encoded.contains("sessionId"));
    }

    /// The other direction: a pane type this build has never heard of is carried through rather
    /// than refused, so an older build cannot lose a newer build's pane.
    #[test]
    fn unknown_pane_type_is_carried_not_rejected() {
        let json = r#"{"id":"pane-x","cwd":"/tmp/project","type":"simulator","sessionId":"s1"}"#;
        let pane: CodeSpaceStoredPane = serde_json::from_str(json).expect("unknown type parses");

        assert_eq!(pane.pane_type.as_deref(), Some("simulator"));
        assert_eq!(pane.session_id.as_deref(), Some("s1"));
    }

    fn test_database_path(name: &str) -> PathBuf {
        let unique = format!(
            "lotus-codespace-store-{name}-{}-{}.sqlite3",
            std::process::id(),
            now_millis()
        );
        std::env::temp_dir().join(unique)
    }

    fn sample_snapshot() -> CodeSpaceStoredSnapshot {
        CodeSpaceStoredSnapshot {
            active_workspace_id: Some("workspace-1".to_string()),
            focused_cell_id: Some("pane-2".to_string()),
            updated_at: 1000,
            workspaces: vec![CodeSpaceStoredWorkspace {
                id: "workspace-1".to_string(),
                label: "Project".to_string(),
                color: "#4F8CFF".to_string(),
                cwd: "/tmp/project".to_string(),
                schema_version: 3,
                location: Some(serde_json::json!({ "kind": "local", "cwd": "/tmp/project" })),
                pane_layout: Some(serde_json::json!({ "mode": "focus", "focusCellId": "pane-2" })),
                right_panel: Some(serde_json::json!({
                    "mode": "editor",
                    "collapsed": false,
                    "width": 640,
                    "browser": {
                        "id": "workspace-1:right-browser",
                        "cwd": "/tmp/project",
                        "type": "browser",
                        "url": "https://example.com",
                        "zoom": 1
                    },
                    "editor": {
                        "id": "workspace-1:right-workbench",
                        "cwd": "/tmp/project",
                        "type": "workbench",
                        "rootDir": "/tmp/project",
                        "tabs": [],
                        "activeTabId": null,
                        "sidebarCollapsed": false,
                        "sidebarWidth": 206
                    }
                })),
                rows: 1,
                cols: 2,
                row_fractions: vec![1.0],
                col_fractions: vec![0.4, 0.6],
                cells: vec![
                    CodeSpaceStoredPane {
                        id: "pane-1".to_string(),
                        cwd: "/tmp/project".to_string(),
                        pane_type: Some("terminal".to_string()),
                        terminal_command: None,
                        runtime_session_id: Some("runtime-1".to_string()),
                        runtime_status: "live".to_string(),
                        agent_command: Some("claude".to_string()),
                        url: None,
                        zoom: None,
                        title: None,
                        root_dir: None,
                        tabs: None,
                        active_tab_id: None,
                        sidebar_collapsed: None,
                        sidebar_width: None,
                        team_id: None,
                        mode: None,
                        pane_title: None,
                        pane_title_updated_at: None,
                        pane_title_session_key: None,
                        agent_name: None,
                        custom_display_name: None,
            session_id: None,
            thread: None,
            linked_pane_id: None,
            claude_account: None,
                    },
                    CodeSpaceStoredPane {
                        id: "pane-2".to_string(),
                        cwd: "/tmp/project".to_string(),
                        pane_type: Some("terminal".to_string()),
                        terminal_command: None,
                        runtime_session_id: None,
                        runtime_status: "detached".to_string(),
                        agent_command: Some("codex".to_string()),
                        url: None,
                        zoom: None,
                        title: None,
                        root_dir: None,
                        tabs: None,
                        active_tab_id: None,
                        sidebar_collapsed: None,
                        sidebar_width: None,
                        team_id: None,
                        mode: None,
                        pane_title: None,
                        pane_title_updated_at: None,
                        pane_title_session_key: None,
                        agent_name: None,
                        custom_display_name: None,
            session_id: None,
            thread: None,
            linked_pane_id: None,
            claude_account: None,
                    },
                ],
            }],
        }
    }

    #[test]
    fn roundtrips_codespace_snapshot() -> CodeSpaceStoreResult<()> {
        let path = test_database_path("roundtrip");
        let mut connection = open_store(&path)?;
        let snapshot = sample_snapshot();

        save_snapshot(&mut connection, &snapshot)?;

        let stored = load_snapshot(&connection)?.expect("snapshot should exist");
        assert_eq!(stored, snapshot);

        let _ = fs::remove_file(path);
        Ok(())
    }

    #[test]
    fn replacing_snapshot_removes_stale_workspaces_and_panes() -> CodeSpaceStoreResult<()> {
        let path = test_database_path("replace");
        let mut connection = open_store(&path)?;
        save_snapshot(&mut connection, &sample_snapshot())?;

        let next = CodeSpaceStoredSnapshot {
            active_workspace_id: None,
            focused_cell_id: None,
            updated_at: 2000,
            workspaces: vec![],
        };
        save_snapshot(&mut connection, &next)?;

        let stored = load_snapshot(&connection)?.expect("snapshot should exist");
        assert_eq!(stored, next);

        let pane_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM codespace_panes", [], |row| row.get(0))?;
        let workspace_count: i64 =
            connection.query_row("SELECT COUNT(*) FROM codespace_workspaces", [], |row| {
                row.get(0)
            })?;
        assert_eq!(pane_count, 0);
        assert_eq!(workspace_count, 0);

        let _ = fs::remove_file(path);
        Ok(())
    }

    /// A closed workspace leaves the snapshot, but its identity stays known, so the same folder
    /// can get the same id back — and with it its Lotus Tasks and automations.
    #[test]
    fn a_closed_workspace_is_still_known_by_its_folder() -> CodeSpaceStoreResult<()> {
        let path = test_database_path("known");
        let mut connection = open_store(&path)?;
        save_snapshot(&mut connection, &sample_snapshot())?;
        save_snapshot(
            &mut connection,
            &CodeSpaceStoredSnapshot { active_workspace_id: None, focused_cell_id: None, updated_at: 2000, workspaces: vec![] },
        )?;

        let known = load_known_workspaces(&connection)?;
        assert_eq!(
            known,
            vec![CodeSpaceKnownWorkspace {
                id: "workspace-1".to_string(),
                label: "Project".to_string(),
                cwd: "/tmp/project".to_string(),
                location: Some(serde_json::json!({ "kind": "local", "cwd": "/tmp/project" })),
                last_seen_at: 1000,
            }]
        );

        let _ = fs::remove_file(path);
        Ok(())
    }

    // (Slice 08) The four identity fields TS already sent but Rust silently dropped:
    // paneTitle, paneTitleUpdatedAt, agentName, customDisplayName.
    #[test]
    fn pane_identity_fields_survive_a_json_roundtrip() {
        let pane = CodeSpaceStoredPane {
            id: "pane-1".to_string(),
            cwd: "/tmp/project".to_string(),
            pane_type: Some("terminal".to_string()),
            terminal_command: None,
            runtime_session_id: None,
            runtime_status: "live".to_string(),
            agent_command: Some("claude".to_string()),
            url: None,
            zoom: None,
            title: None,
            root_dir: None,
            tabs: None,
            active_tab_id: None,
            sidebar_collapsed: None,
            sidebar_width: None,
            team_id: None,
            mode: None,
            pane_title: Some("Refactor the login flow".to_string()),
            pane_title_updated_at: Some(1_726_000_000_000),
            pane_title_session_key: None,
            agent_name: Some("Nara".to_string()),
            custom_display_name: Some("Reviewer".to_string()),
            session_id: None,
            thread: None,
            linked_pane_id: None,
            claude_account: Some("hss".to_string()),
        };

        let json = serde_json::to_string(&pane).expect("serialize");
        // The wire key is camelCase (rename_all on the struct), matching what TS sends.
        assert!(json.contains("\"paneTitle\""));
        assert!(json.contains("\"paneTitleUpdatedAt\""));
        assert!(json.contains("\"agentName\""));
        assert!(json.contains("\"customDisplayName\""));
        assert!(json.contains("\"claudeAccount\":\"hss\""));

        let restored: CodeSpaceStoredPane = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored, pane);
    }

    // This is the proof of backward compatibility the brief asks for: an old row, saved
    // before slice 08, has none of these four keys at all. It must still deserialize
    // cleanly to `None` — not error — with no schema/migration bump.
    #[test]
    fn old_json_without_the_four_new_keys_still_deserializes_as_none() {
        let old_json = r#"{
            "id": "pane-1",
            "cwd": "/tmp/project",
            "type": "terminal",
            "runtimeStatus": "live",
            "agentCommand": "claude"
        }"#;

        let pane: CodeSpaceStoredPane =
            serde_json::from_str(old_json).expect("pre-slice-08 JSON should still parse");
        assert_eq!(pane.pane_title, None);
        assert_eq!(pane.pane_title_updated_at, None);
        assert_eq!(pane.agent_name, None);
        assert_eq!(pane.custom_display_name, None);
    }
}
