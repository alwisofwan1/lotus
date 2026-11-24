//! Agent sessions as first-class rows (`plans/codecanvas-session-widget/`, Slice 01).
//!
//! Until now a live agent's session id lived as a single `resumeSessionId` field inside the node's
//! `data`, serialized into `codecanvas_snapshots.nodes_json`. That is enough to relaunch one
//! conversation and nothing else: deleting the node drops the only trace of the session, nothing can
//! be queried, and there is no title, activity time, or turn count to show. This table lifts the
//! session out of the node so a list can exist at all.
//!
//! **Two schema choices here are decisions, not defaults.**
//!
//! 1. **No foreign key to `codecanvas_projects`.** `close_project` DELETEs the project row
//!    (`codecanvas_store.rs`), and every other child table cascades off it. Closing a project is a
//!    light action — it removes the board from the rail — and it must not destroy conversations.
//!    `project_id` is derived deterministically from the root dir, so reopening the same folder
//!    brings the list straight back. See `issues/09-sesi-selamat-dari-close-project.md`.
//!
//! 2. **A partial UNIQUE index on `(project_id, provider_session_id)`.** Session-id capture works by
//!    diffing the CLI's transcript directory before and after launch, so two agents started in the
//!    same cwd can both pick up the same fresh id. This index is the storage-layer backstop that
//!    turns that race into a rejected write instead of one conversation filed under two nodes. The
//!    claiming logic itself is Slice 07; the index lands with the table so no migration is needed
//!    twice. See `issues/07-klaim-id-unik-per-proyek.md`.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::codecanvas_store::CodeCanvasStoreResult;

/// One agent conversation, owned by a project and (usually) hosted by a canvas node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeCanvasSessionRow {
    /// Lotus's own id, not the CLI's.
    pub id: String,
    pub project_id: String,
    /// The canvas node hosting this session. `None` once the node is deleted — the session stays.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub runner: String,
    /// The launch command, for a runner whose type cannot name it.
    ///
    /// `runner` is the TYPE, and every user-defined runner — grok, opencode, a second-account
    /// Claude — arrives as the single word `custom`. A node rebuilt from this row has nothing to
    /// launch without it: pressing "pasang" on such a row threw `custom runner requires a command`
    /// out of the render on 2026-09-12 (`plans/codecanvas-session-refactor/issues/03`). Rows
    /// written before this column existed keep `None`, and the dispatcher refuses them with a
    /// sentence rather than an exception.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_command: Option<String>,
    /// The id the CLI itself uses for this conversation. `None` until capture succeeds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_session_id: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    pub title: String,
    /// `auto` (derived from the first ask) or `manual` (renamed by a human).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_source: Option<String>,
    /// `live` | `resumable` | `no-resume` | `dead`. A cache about a process, never a durable fact —
    /// it is reconciled against the live PTY list when a canvas loads (Slice 08).
    pub status: String,
    /// `manual` | `graph-run` | `mcp`.
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_run_id: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub turn_count: i64,
    /// The last thing asked of this conversation, so the list can show what it is ABOUT.
    ///
    /// Rows written before this column existed keep `None` and simply show no preview line; there
    /// is nothing to backfill from, because the ask was never recorded anywhere durable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_prompt: Option<String>,
    /// Claude only: the account the node ran as (portable-accounts issues/07), so a node rebuilt
    /// from this row bills the same account. `None` = the chosen account.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub last_activity_at: i64,
    pub created_at: i64,
}

pub fn ensure_schema(connection: &Connection) -> CodeCanvasStoreResult<()> {
    connection.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS codecanvas_sessions (
          id                  TEXT PRIMARY KEY,
          project_id          TEXT NOT NULL,
          node_id             TEXT,
          runner              TEXT NOT NULL,
          provider_session_id TEXT,
          cwd                 TEXT NOT NULL,
          worktree_path       TEXT,
          title               TEXT NOT NULL,
          title_source        TEXT,
          status              TEXT NOT NULL,
          origin              TEXT NOT NULL DEFAULT 'manual',
          graph_run_id        TEXT,
          pinned              INTEGER NOT NULL DEFAULT 0,
          turn_count          INTEGER NOT NULL DEFAULT 0,
          last_activity_at    INTEGER NOT NULL,
          created_at          INTEGER NOT NULL,
          runner_command      TEXT,
          last_prompt         TEXT,
          account             TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_codecanvas_sessions_project
          ON codecanvas_sessions(project_id, last_activity_at DESC);
        CREATE INDEX IF NOT EXISTS idx_codecanvas_sessions_node
          ON codecanvas_sessions(node_id, last_activity_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_codecanvas_sessions_provider
          ON codecanvas_sessions(project_id, provider_session_id)
          WHERE provider_session_id IS NOT NULL;
        ",
    )?;
    // The table shipped before `runner_command` existed, so an installed copy needs the column
    // added rather than created.
    crate::codecanvas_store::ensure_column(connection, "codecanvas_sessions", "runner_command", "TEXT")?;
    crate::codecanvas_store::ensure_column(connection, "codecanvas_sessions", "last_prompt", "TEXT")?;
    crate::codecanvas_store::ensure_column(connection, "codecanvas_sessions", "account", "TEXT")?;
    Ok(())
}

fn row_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<CodeCanvasSessionRow> {
    Ok(CodeCanvasSessionRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        node_id: row.get(2)?,
        runner: row.get(3)?,
        provider_session_id: row.get(4)?,
        cwd: row.get(5)?,
        worktree_path: row.get(6)?,
        title: row.get(7)?,
        title_source: row.get(8)?,
        status: row.get(9)?,
        origin: row.get(10)?,
        graph_run_id: row.get(11)?,
        pinned: row.get::<_, i64>(12)? != 0,
        turn_count: row.get(13)?,
        last_activity_at: row.get(14)?,
        created_at: row.get(15)?,
        runner_command: row.get(16)?,
        last_prompt: row.get(17)?,
        account: row.get(18)?,
    })
}

const SELECT_COLUMNS: &str = "id, project_id, node_id, runner, provider_session_id, cwd, \
     worktree_path, title, title_source, status, origin, graph_run_id, pinned, turn_count, \
     last_activity_at, created_at, runner_command, last_prompt, account";

/// Every session recorded for a project, most recently active first.
pub fn list_sessions(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Vec<CodeCanvasSessionRow>> {
    let sql = format!(
        "SELECT {SELECT_COLUMNS} FROM codecanvas_sessions
         WHERE project_id = ?1 ORDER BY last_activity_at DESC"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params![project_id], |row| row_from(row))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// One session by id, or `None`.
#[cfg(test)]
pub fn get_session(
    connection: &Connection,
    id: &str,
) -> CodeCanvasStoreResult<Option<CodeCanvasSessionRow>> {
    let sql = format!("SELECT {SELECT_COLUMNS} FROM codecanvas_sessions WHERE id = ?1");
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query_map(params![id], |row| row_from(row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

/// Insert or replace a session. Fails when `provider_session_id` is already claimed by another
/// session in the same project — that rejection is the point of the unique index.
pub fn upsert_session(
    connection: &Connection,
    session: &CodeCanvasSessionRow,
) -> CodeCanvasStoreResult<()> {
    connection.execute(
        "INSERT INTO codecanvas_sessions
           (id, project_id, node_id, runner, provider_session_id, cwd, worktree_path, title,
            title_source, status, origin, graph_run_id, pinned, turn_count, last_activity_at, created_at,
            runner_command, last_prompt, account)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
         ON CONFLICT(id) DO UPDATE SET
           project_id = excluded.project_id,
           node_id = excluded.node_id,
           runner = excluded.runner,
           provider_session_id = excluded.provider_session_id,
           cwd = excluded.cwd,
           worktree_path = excluded.worktree_path,
           title = excluded.title,
           title_source = excluded.title_source,
           status = excluded.status,
           origin = excluded.origin,
           graph_run_id = excluded.graph_run_id,
           pinned = excluded.pinned,
           turn_count = excluded.turn_count,
           last_activity_at = excluded.last_activity_at,
           runner_command = excluded.runner_command,
           last_prompt = excluded.last_prompt,
           account = excluded.account",
        params![
            session.id,
            session.project_id,
            session.node_id,
            session.runner,
            session.provider_session_id,
            session.cwd,
            session.worktree_path,
            session.title,
            session.title_source,
            session.status,
            session.origin,
            session.graph_run_id,
            i64::from(session.pinned),
            session.turn_count,
            session.last_activity_at,
            session.created_at,
            session.runner_command,
            session.last_prompt,
            session.account,
        ],
    )?;
    Ok(())
}

pub fn delete_session(connection: &Connection, id: &str) -> CodeCanvasStoreResult<()> {
    connection.execute("DELETE FROM codecanvas_sessions WHERE id = ?1", params![id])?;
    Ok(())
}
