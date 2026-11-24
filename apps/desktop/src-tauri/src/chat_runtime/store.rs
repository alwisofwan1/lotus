//! Append-only SQLite store for chat threads and their ThreadEvents.
//!
//! Rust owns `seq`: the bridge numbers events per bridge session, which restarts at 1 after a crash
//! or a resume, so the store assigns the thread-wide order. Events are kept as JSON; the runtime only
//! peeks at a few fields. Text deltas are deleted once their turn completes — the completed item
//! carries the full text — so a long thread does not keep one row per streamed token.

use std::collections::HashSet;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use super::changes::{Phase, Snapshot};

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadRecord {
    pub id: String,
    pub cwd: String,
    pub model: Option<String>,
    pub permission_mode: String,
    /// Which agent runs the thread: "claude", "codex" (#286) or "api" (#288). Fixed for the thread's life.
    pub runner: String,
    /// The model-registry provider an "api" thread talks to (#288); None for the other runners.
    pub provider: Option<String>,
    /// Codex's reasoning effort; None = the model's own default.
    pub effort: Option<String>,
    /// Provider session to resume when the thread's session restarts.
    pub provider_session_id: Option<String>,
    /// The ccs Claude account the thread runs on (subscription-usage step 4); None = the one
    /// picked in the usage popover, else Claude's default login.
    pub account: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The first line of the first message (#287); None until one is sent.
    pub title: Option<String>,
    /// The CodeChat session this thread was imported from (#290); None for threads made here.
    pub imported_from: Option<String>,
    /// Put away in the rail's Archived drawer (#291).
    pub archived: bool,
    /// When it was pinned to the top of the rail; None = not pinned. Also orders the Pinned section.
    pub pinned_at: Option<i64>,
    /// When the last turn ended (Command Rail): with `last_read_at`, whether it has news for you.
    pub last_turn_ended_at: Option<i64>,
    /// When the thread was last opened, or watched while a turn ended.
    pub last_read_at: Option<i64>,
    /// Not stored: when the running turn started, while this Lotus run drives one.
    pub turn_started_at: Option<i64>,
    /// Not stored: "working" or "waiting" while this Lotus run drives it, else None.
    pub status: Option<&'static str>,
    /// Not stored: a remote thread's stream trouble, "reconnecting" or "down"; None = fine or local.
    pub link: Option<&'static str>,
    /// The thread that delegated this one (`lotus_chat_delegate`); None for a thread you started.
    pub parent_id: Option<String>,
    /// The SSH machine whose Lotus Host runs this thread (plans/chat-remote-host); None = this Mac.
    pub machine: Option<RemoteMachine>,
    /// The agent's Agent Handle in this thread (ADR-0068), picked by the frontend from the Name Pool
    /// when the thread is first opened; None until then.
    pub agent_name: Option<String>,
}

/// Where a remote thread runs, and how far its stream has been read.
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMachine {
    pub host: String,
    #[serde(default)]
    pub user: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    /// The host's project the agent runs in (`/v1/chat-cell/spawn` takes a workspace, not a path).
    pub workspace_id: String,
    /// The host's headless cell, once the first message spawned it.
    #[serde(default)]
    pub pane_id: Option<String>,
    /// The last SSE id read (`<bootId>:<cursor>`), to resume from.
    #[serde(default)]
    pub cursor: Option<String>,
}

impl RemoteMachine {
    pub fn target(&self) -> crate::cli_tools::SshToolTarget {
        crate::cli_tools::SshToolTarget { host: self.host.clone(), user: self.user.clone(), port: self.port }
    }
}

/// Turns finished since a time, across every thread (#287, the start screen's "Today" line).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub turns: u64,
    pub duration_ms: u64,
    pub tokens: u64,
}

const TITLE_CHARS: usize = 80;

/// The first non-empty line of a message, cut to a rail row.
pub(super) fn title_of(text: &str) -> Option<String> {
    // A handoff seed (`ChatRuntime::handoff_seed`) is context, not the user's words.
    let text = match text.strip_prefix("<lotus-handoff ").and_then(|rest| rest.split_once("</lotus-handoff>")) {
        Some((_, own)) => own,
        None => text,
    };
    let line = text.lines().map(str::trim).find(|l| !l.is_empty())?;
    Some(line.chars().take(TITLE_CHARS).collect())
}

/// What the frontend receives: `ThreadEventEnvelope` in `src/modules/chat/domain/thread-event.ts`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub thread_id: String,
    pub seq: u64,
    pub at: i64,
    pub event: Value,
}

pub struct Store {
    conn: Connection,
}

pub fn event_type(event: &Value) -> &str {
    event.get("type").and_then(Value::as_str).unwrap_or("")
}

/// The events still in the conversation: a `thread/rewound` marker (an edited message) drops its
/// turn and everything after it, up to the marker. Kept in the store, so nothing is lost.
pub fn live(envelopes: Vec<Envelope>) -> Vec<Envelope> {
    let mut kept: Vec<Envelope> = Vec::with_capacity(envelopes.len());
    for envelope in envelopes {
        if event_type(&envelope.event) == "thread/rewound" {
            let turn = &envelope.event["turnId"];
            if let Some(start) = kept.iter().position(|e| event_type(&e.event) == "turn/started" && &e.event["turnId"] == turn) {
                kept.truncate(start);
            }
            continue;
        }
        kept.push(envelope);
    }
    kept
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::init(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn init(conn: Connection) -> Result<Self, String> {
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "chat store schema {version} is newer than this Lotus ({SCHEMA_VERSION})"
            ));
        }
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS chat_threads (
               id TEXT PRIMARY KEY,
               cwd TEXT NOT NULL,
               model TEXT,
               permission_mode TEXT NOT NULL,
               provider_session_id TEXT,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS chat_events (
               thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
               seq INTEGER NOT NULL,
               at INTEGER NOT NULL,
               kind TEXT NOT NULL,
               event TEXT NOT NULL,
               PRIMARY KEY (thread_id, seq)
             ) WITHOUT ROWID;
             -- Folder snapshots for the Changes drawer (#281); additive, so the version stays.
             CREATE TABLE IF NOT EXISTS chat_snapshots (
               thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
               seq INTEGER NOT NULL,
               phase TEXT NOT NULL,
               tree TEXT NOT NULL,
               PRIMARY KEY (thread_id, seq, phase)
             ) WITHOUT ROWID;
             -- CodeChat sessions whose imported thread was deleted (#291), so Import never brings one back.
             CREATE TABLE IF NOT EXISTS chat_deleted_imports (codechat_id TEXT PRIMARY KEY) WITHOUT ROWID;
             PRAGMA user_version = 1;",
        )
        .map_err(|e| e.to_string())?;
        // Runner and effort (#286); additive, so the version stays. Older threads ran on Claude.
        let has_runner: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'runner'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_runner {
            conn.execute_batch(
                "ALTER TABLE chat_threads ADD COLUMN runner TEXT NOT NULL DEFAULT 'claude';
                 ALTER TABLE chat_threads ADD COLUMN effort TEXT;",
            )
            .map_err(|e| e.to_string())?;
        }
        // Title (#287); additive too. Older threads stay untitled and show their folder.
        let has_title: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'title'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_title {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN title TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // Provider of an "api" thread (#288); additive too.
        let has_provider: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'provider'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_provider {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN provider TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // CodeChat session an imported thread came from (#290); additive too.
        let has_imported_from: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'imported_from'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_imported_from {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN imported_from TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // Archived flag (#291); additive too.
        let has_archived: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'archived'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_archived {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;")
                .map_err(|e| e.to_string())?;
        }
        // Read state for the Command Rail; additive too. Old threads start read, so an upgrade
        // does not fill Ready.
        let has_read: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'last_read_at'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_read {
            conn.execute_batch(
                "ALTER TABLE chat_threads ADD COLUMN last_turn_ended_at INTEGER;
                 ALTER TABLE chat_threads ADD COLUMN last_read_at INTEGER;",
            )
            .map_err(|e| e.to_string())?;
        }
        // The thread's Claude account (subscription-usage step 4); additive, old threads are NULL.
        let has_account: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'account'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_account {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN account TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // Pin (plans/chat-thread-pin); additive, old threads are unpinned.
        let has_pinned: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'pinned_at'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_pinned {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN pinned_at INTEGER;")
                .map_err(|e| e.to_string())?;
        }
        // Where the title came from (plans/chat-auto-title); additive too. NULL = the first
        // message's line or none yet, 'ai', 'user' (a rename), 'imported'.
        let has_title_source: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'title_source'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_title_source {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN title_source TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // Delegation (mockups/chat-delegation.html); additive, old threads have no parent.
        let has_parent: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'parent_id'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_parent {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN parent_id TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // Fork from a turn (mockups/chat-fork-turn.html): where a fork's first session branches off.
        let has_fork_at: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'fork_at'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_fork_at {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN fork_at TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // Chat on a VPS (plans/chat-remote-host): the machine a thread runs on, as JSON.
        let has_machine: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'machine'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_machine {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN machine TEXT;")
                .map_err(|e| e.to_string())?;
        }
        // Agent Handle (plans/agent-naming slice 05); additive, old threads get one when opened.
        let has_agent_name: bool = conn
            .query_row(
                "SELECT COUNT(*) > 0 FROM pragma_table_info('chat_threads') WHERE name = 'agent_name'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !has_agent_name {
            conn.execute_batch("ALTER TABLE chat_threads ADD COLUMN agent_name TEXT;")
                .map_err(|e| e.to_string())?;
        }
        Ok(Self { conn })
    }

    pub fn create_thread(&self, record: &ThreadRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO chat_threads (id, cwd, model, permission_mode, provider_session_id, created_at, updated_at, runner, effort, title, provider, imported_from, account, parent_id, machine)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    record.id,
                    record.cwd,
                    record.model,
                    record.permission_mode,
                    record.provider_session_id,
                    record.created_at,
                    record.updated_at,
                    record.runner,
                    record.effort,
                    record.title,
                    record.provider,
                    record.imported_from,
                    record.account,
                    record.parent_id,
                    record.machine.as_ref().map(|m| serde_json::to_string(m).unwrap_or_default()),
                ],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn thread(&self, id: &str) -> Result<Option<ThreadRecord>, String> {
        self.conn
            .query_row(
                "SELECT id, cwd, model, permission_mode, provider_session_id, created_at, updated_at, runner, effort, title, provider, imported_from, archived, last_turn_ended_at, last_read_at, account, pinned_at, parent_id, machine, agent_name
                 FROM chat_threads WHERE id = ?1",
                [id],
                row_to_thread,
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn list_threads(&self) -> Result<Vec<ThreadRecord>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, cwd, model, permission_mode, provider_session_id, created_at, updated_at, runner, effort, title, provider, imported_from, archived, last_turn_ended_at, last_read_at, account, pinned_at, parent_id, machine, agent_name
                 FROM chat_threads ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], row_to_thread)
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Appends one event and returns its envelope. Also remembers the provider session id, so a
    /// restarted session resumes the same conversation, and a picked model, so it starts on it.
    pub fn append(&mut self, thread_id: &str, at: i64, event: Value) -> Result<Envelope, String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let seq: u64 = tx
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_events WHERE thread_id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO chat_events (thread_id, seq, at, kind, event) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![thread_id, seq, at, event_type(&event), event.to_string()],
        )
        .map_err(|e| e.to_string())?;
        let session_id = (event_type(&event) == "session/configured")
            .then(|| event.get("providerSessionId").and_then(Value::as_str))
            .flatten();
        let model = (event_type(&event) == "session/modelChanged")
            .then(|| event.get("model").and_then(Value::as_str))
            .flatten();
        let effort = (event_type(&event) == "session/modelChanged")
            .then(|| event.get("effort").and_then(Value::as_str))
            .flatten();
        let account = (event_type(&event) == "session/accountChanged")
            .then(|| event.get("account").and_then(Value::as_str))
            .flatten();
        let permission = (event_type(&event) == "session/permissionChanged")
            .then(|| event.get("mode").and_then(Value::as_str))
            .flatten();
        let ended = (event_type(&event) == "turn/completed").then_some(at);
        let title = (event_type(&event) == "turn/started")
            .then(|| event.pointer("/input/text").and_then(Value::as_str).and_then(title_of))
            .flatten();
        tx.execute(
            "UPDATE chat_threads SET updated_at = ?2, provider_session_id = COALESCE(?3, provider_session_id),
             model = COALESCE(?4, model), effort = COALESCE(?5, effort), title = COALESCE(title, ?6),
             last_turn_ended_at = COALESCE(?7, last_turn_ended_at), account = COALESCE(?8, account),
             permission_mode = COALESCE(?9, permission_mode),
             fork_at = CASE WHEN ?3 IS NOT NULL AND ?3 IS NOT provider_session_id THEN NULL ELSE fork_at END
             WHERE id = ?1",
            params![thread_id, at, session_id, model, effort, title, ended, account, permission],
        )
        .map_err(|e| e.to_string())
        // A deleted thread's late events (#291) are dropped, not kept as orphans.
        .and_then(|n| if n == 1 { Ok(()) } else { Err(format!("unknown thread {thread_id}")) })?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Envelope {
            thread_id: thread_id.to_string(),
            seq,
            at,
            event,
        })
    }

    pub fn stats_since(&self, since: i64) -> Result<Stats, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT event FROM chat_events WHERE kind = 'turn/completed' AND at >= ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([since], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut stats = Stats::default();
        for row in rows {
            let event: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?).unwrap_or(Value::Null);
            let n = |pointer: &str| event.pointer(pointer).and_then(Value::as_u64).unwrap_or(0);
            stats.turns += 1;
            stats.duration_ms += n("/usage/durationMs");
            stats.tokens += n("/usage/inputTokens") + n("/usage/outputTokens");
        }
        Ok(stats)
    }

    /// Input and output tokens over every finished turn of these chats.
    pub fn tokens_of(&self, ids: &[String]) -> Result<(u64, u64), String> {
        let mut stmt = self
            .conn
            .prepare("SELECT event FROM chat_events WHERE thread_id = ?1 AND kind = 'turn/completed'")
            .map_err(|e| e.to_string())?;
        let (mut input, mut output) = (0, 0);
        for id in ids {
            for row in stmt.query_map([id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())? {
                let event: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?).unwrap_or(Value::Null);
                let n = |pointer: &str| event.pointer(pointer).and_then(Value::as_u64).unwrap_or(0);
                input += n("/usage/inputTokens");
                output += n("/usage/outputTokens");
            }
        }
        Ok((input, output))
    }

    /// The `chat-attachments/<id>` folders named by one chat's events, or by every chat's. A fork
    /// copies its original's events, so it names the original's folder too.
    pub fn attachment_dirs_named(&self, thread_id: Option<&str>) -> Result<HashSet<String>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT event FROM chat_events WHERE (?1 IS NULL OR thread_id = ?1) AND instr(event, 'chat-attachments') > 0")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([thread_id], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
        let mut out = HashSet::new();
        for row in rows {
            super::attachments::named_dirs(&row.map_err(|e| e.to_string())?, &mut out);
        }
        Ok(out)
    }

    pub fn events_after(&self, thread_id: &str, after_seq: u64) -> Result<Vec<Envelope>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, at, event FROM chat_events WHERE thread_id = ?1 AND seq > ?2 ORDER BY seq")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![thread_id, after_seq], |row| {
                Ok((
                    row.get::<_, u64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, at, json) = row.map_err(|e| e.to_string())?;
            let event =
                serde_json::from_str(&json).map_err(|e| format!("event {thread_id}#{seq}: {e}"))?;
            out.push(Envelope {
                thread_id: thread_id.to_string(),
                seq,
                at,
                event,
            });
        }
        Ok(out)
    }

    pub fn last_seq(&self, thread_id: &str) -> Result<u64, String> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM chat_events WHERE thread_id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn add_snapshot(&self, thread_id: &str, snapshot: &Snapshot) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO chat_snapshots (thread_id, seq, phase, tree)
                 SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM chat_threads WHERE id = ?1)",
                params![thread_id, snapshot.seq, snapshot.phase.as_str(), snapshot.tree],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    pub fn snapshots(&self, thread_id: &str) -> Result<Vec<Snapshot>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT seq, phase, tree FROM chat_snapshots WHERE thread_id = ?1 ORDER BY seq")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([thread_id], |row| {
                Ok(Snapshot {
                    seq: row.get(0)?,
                    phase: if row.get::<_, String>(1)? == "after" { Phase::After } else { Phase::Before },
                    tree: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Whether a CodeChat session was imported already (#290), or imported and then deleted (#291).
    pub fn is_imported(&self, codechat_id: &str) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM chat_threads WHERE imported_from = ?1)
                     OR EXISTS (SELECT 1 FROM chat_deleted_imports WHERE codechat_id = ?1)",
                [codechat_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())
    }

    /// Adds a whole thread with its history in one transaction (#290), so a failed import leaves
    /// nothing behind and the next one retries it.
    pub fn import_thread(&mut self, record: &ThreadRecord, events: &[(i64, Value)]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO chat_threads (id, cwd, model, permission_mode, provider_session_id, created_at, updated_at, runner, effort, title, provider, imported_from, title_source)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, NULL, ?10, 'imported')",
            params![
                record.id,
                record.cwd,
                record.model,
                record.permission_mode,
                record.created_at,
                record.updated_at,
                record.runner,
                record.effort,
                record.title,
                record.imported_from
            ],
        )
        .map_err(|e| e.to_string())?;
        for (seq, (at, event)) in events.iter().enumerate() {
            tx.execute(
                "INSERT INTO chat_events (thread_id, seq, at, kind, event) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![record.id, seq as u64 + 1, at, event_type(event), event.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Renames a thread (#291). An empty name goes back to the first message's line.
    /// A remote thread's machine after its cell spawned or its stream moved on.
    pub fn set_machine(&self, thread_id: &str, machine: &RemoteMachine) -> Result<(), String> {
        let json = serde_json::to_string(machine).map_err(|e| e.to_string())?;
        self.conn
            .execute("UPDATE chat_threads SET machine = ?2 WHERE id = ?1", params![thread_id, json])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Marks `thread_id` as delegated by `parent_id` (set once, when the child is made).
    pub fn set_parent(&self, thread_id: &str, parent_id: &str) -> Result<(), String> {
        self.conn
            .execute("UPDATE chat_threads SET parent_id = ?2 WHERE id = ?1", params![thread_id, parent_id])
            .map_err(|e| e.to_string())
            .and_then(|n| if n == 1 { Ok(()) } else { Err(format!("unknown thread {thread_id}")) })
    }

    /// Where a fork's next session branches off the original's; `None` once it runs on its own.
    pub fn fork_at(&self, thread_id: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT fork_at FROM chat_threads WHERE id = ?1", [thread_id], |row| row.get(0))
            .optional()
            .map(Option::flatten)
            .map_err(|e| e.to_string())
    }

    /// Puts the thread back on an earlier session (an edited message): `None`, `None` = a fresh one.
    pub fn set_session(&self, thread_id: &str, session: Option<&str>, fork_at: Option<&str>) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE chat_threads SET provider_session_id = ?2, fork_at = ?3 WHERE id = ?1",
                params![thread_id, session, fork_at],
            )
            .map_err(|e| e.to_string())
            .and_then(|n| if n == 1 { Ok(()) } else { Err(format!("unknown thread {thread_id}")) })
    }

    pub fn set_fork_at(&self, thread_id: &str, fork_at: &str) -> Result<(), String> {
        self.conn
            .execute("UPDATE chat_threads SET fork_at = ?2 WHERE id = ?1", params![thread_id, fork_at])
            .map_err(|e| e.to_string())
            .and_then(|n| if n == 1 { Ok(()) } else { Err(format!("unknown thread {thread_id}")) })
    }

    pub fn rename(&self, thread_id: &str, title: &str) -> Result<(), String> {
        let typed = title_of(title).is_some();
        let title = match title_of(title) {
            Some(title) => Some(title),
            None => self
                .conn
                .query_row(
                    "SELECT event FROM chat_events WHERE thread_id = ?1 AND kind = 'turn/started' ORDER BY seq LIMIT 1",
                    [thread_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .and_then(|json| serde_json::from_str::<Value>(&json).ok())
                .and_then(|event| event.pointer("/input/text").and_then(Value::as_str).and_then(title_of)),
        };
        // A typed name is the user's; cleared, the title is the first message's line again.
        let sql = "UPDATE chat_threads SET title = ?2, title_source = CASE WHEN ?3 THEN 'user' END WHERE id = ?1";
        match self.conn.execute(sql, params![thread_id, title, typed]).map_err(|e| e.to_string())? {
            1 => Ok(()),
            _ => Err(format!("unknown thread {thread_id}")),
        }
    }

    /// Whether the next message is the thread's first words, so its title is still to be made:
    /// no title yet, and none typed or imported.
    pub fn needs_title(&self, thread_id: &str) -> Result<bool, String> {
        self.conn
            .query_row(
                "SELECT title IS NULL AND title_source IS NULL FROM chat_threads WHERE id = ?1",
                [thread_id],
                |row| row.get(0),
            )
            .optional()
            .map(|v| v.unwrap_or(false))
            .map_err(|e| e.to_string())
    }

    /// A regenerated title: asked for, so it replaces any title, a rename too.
    pub fn set_generated_title(&self, thread_id: &str, title: &str) -> Result<(), String> {
        let sql = "UPDATE chat_threads SET title = ?2, title_source = 'ai' WHERE id = ?1";
        match self.conn.execute(sql, params![thread_id, title]).map_err(|e| e.to_string())? {
            1 => Ok(()),
            _ => Err(format!("unknown thread {thread_id}")),
        }
    }

    /// Puts a generated title over the first message's line; never over a rename or an import.
    /// One statement, so a rename landing meanwhile always wins. Returns whether it was applied.
    pub fn apply_generated_title(&self, thread_id: &str, title: &str) -> Result<bool, String> {
        self.conn
            .execute(
                "UPDATE chat_threads SET title = ?2, title_source = 'ai' WHERE id = ?1 AND title_source IS NULL",
                params![thread_id, title],
            )
            .map(|n| n == 1)
            .map_err(|e| e.to_string())
    }

    /// Archiving also unpins, so an unarchived thread does not come back pinned.
    pub fn set_archived(&self, thread_id: &str, archived: bool) -> Result<(), String> {
        self.update_thread(
            thread_id,
            "UPDATE chat_threads SET archived = ?2, pinned_at = CASE WHEN ?2 THEN NULL ELSE pinned_at END WHERE id = ?1",
            archived,
        )
    }

    /// Pins at `at`, or unpins with None.
    pub fn set_pinned(&self, thread_id: &str, at: Option<i64>) -> Result<(), String> {
        self.update_thread(thread_id, "UPDATE chat_threads SET pinned_at = ?2 WHERE id = ?1", at)
    }

    /// Moves a thread to another folder (a fork into its own worktree).
    pub fn set_agent_name(&self, thread_id: &str, name: &str) -> Result<(), String> {
        match self.conn.execute("UPDATE chat_threads SET agent_name = ?2 WHERE id = ?1", params![thread_id, name.trim()]).map_err(|e| e.to_string())? {
            0 => Err(format!("no chat {thread_id}")),
            _ => Ok(()),
        }
    }

    pub fn set_cwd(&self, thread_id: &str, cwd: &str) -> Result<(), String> {
        self.update_thread(thread_id, "UPDATE chat_threads SET cwd = ?2 WHERE id = ?1", cwd)
    }

    pub fn mark_read(&self, thread_id: &str, at: i64) -> Result<(), String> {
        self.update_thread(thread_id, "UPDATE chat_threads SET last_read_at = ?2 WHERE id = ?1", at)
    }

    fn update_thread(&self, thread_id: &str, sql: &str, value: impl rusqlite::ToSql) -> Result<(), String> {
        match self.conn.execute(sql, params![thread_id, value]).map_err(|e| e.to_string())? {
            1 => Ok(()),
            _ => Err(format!("unknown thread {thread_id}")),
        }
    }

    /// Deletes a thread with its history and snapshots (#291). An imported one is remembered, so a
    /// later CodeChat import does not bring it back.
    pub fn delete_thread(&mut self, thread_id: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO chat_deleted_imports (codechat_id)
             SELECT imported_from FROM chat_threads WHERE id = ?1 AND imported_from IS NOT NULL",
            [thread_id],
        )
        .map_err(|e| e.to_string())?;
        for sql in [
            "DELETE FROM chat_events WHERE thread_id = ?1",
            "DELETE FROM chat_snapshots WHERE thread_id = ?1",
            "DELETE FROM chat_threads WHERE id = ?1",
        ] {
            tx.execute(sql, [thread_id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Drops the text deltas of a finished turn (from its first event on). Its completed items
    /// already hold the full text. Call it after appending the turn's completion: then the highest
    /// seq is never a delta, so no seq is ever handed out twice.
    pub fn compact_turn(&self, thread_id: &str, from_seq: u64) -> Result<(), String> {
        self.conn
            .execute(
                "DELETE FROM chat_events WHERE thread_id = ?1 AND seq >= ?2 AND kind = 'item/delta'",
                params![thread_id, from_seq],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn row_to_thread(row: &rusqlite::Row<'_>) -> rusqlite::Result<ThreadRecord> {
    Ok(ThreadRecord {
        id: row.get(0)?,
        cwd: row.get(1)?,
        model: row.get(2)?,
        permission_mode: row.get(3)?,
        provider_session_id: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        runner: row.get(7)?,
        effort: row.get(8)?,
        title: row.get(9)?,
        provider: row.get(10)?,
        imported_from: row.get(11)?,
        archived: row.get(12)?,
        last_turn_ended_at: row.get(13)?,
        last_read_at: row.get(14)?,
        account: row.get(15)?,
        pinned_at: row.get(16)?,
        turn_started_at: None,
        status: None,
        link: None,
        parent_id: row.get(17)?,
        machine: row
            .get::<_, Option<String>>(18)?
            .and_then(|json| serde_json::from_str(&json).ok()),
        agent_name: row.get(19)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thread(id: &str) -> ThreadRecord {
        ThreadRecord {
            id: id.into(),
            cwd: "/w".into(),
            model: None,
            permission_mode: "default".into(),
            runner: "claude".into(),
            provider: None,
            effort: None,
            provider_session_id: None,
            account: None,
            created_at: 1,
            updated_at: 1,
            title: None,
            imported_from: None,
            archived: false,
            pinned_at: None,
            last_turn_ended_at: None,
            last_read_at: None,
            turn_started_at: None,
            status: None,
            link: None,
            parent_id: None,
            machine: None,
            agent_name: None,
        }
    }

    #[test]
    fn keeps_a_thread_agent_name() {
        let store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().agent_name, None, "named when first opened");
        store.set_agent_name("a", " Kirana ").unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().agent_name.as_deref(), Some("Kirana"));
        assert!(store.set_agent_name("gone", "Bima").is_err());
    }

    #[test]
    fn names_the_attachment_folders_each_chat_uses() {
        let (own, staged) = ("0837d63e-57f8-485e-8660-9f0a5892cc5c", "194def46-768b-4941-afff-904d6d3a99b0");
        let mut store = Store::in_memory();
        for id in ["a", "b"] {
            store.create_thread(&thread(id)).unwrap();
        }
        let message = |dir: &str| json!({"type": "user/message", "attachments": [{"path": format!("/s/chat-attachments/{dir}/x.png")}]});
        store.append("a", 1, message(own)).unwrap();
        store.append("b", 1, message(staged)).unwrap();
        assert_eq!(store.attachment_dirs_named(Some("b")).unwrap(), HashSet::from([staged.to_string()]));
        assert_eq!(store.attachment_dirs_named(None).unwrap(), HashSet::from([own.to_string(), staged.to_string()]));
    }

    #[test]
    fn a_delegated_thread_keeps_its_parent() {
        let store = Store::in_memory();
        store.create_thread(&thread("lead")).unwrap();
        store.create_thread(&thread("child")).unwrap();
        store.set_parent("child", "lead").unwrap();
        assert_eq!(store.thread("child").unwrap().unwrap().parent_id.as_deref(), Some("lead"));
        assert_eq!(store.thread("lead").unwrap().unwrap().parent_id, None);
        assert!(store.set_parent("gone", "lead").is_err());
    }

    #[test]
    fn an_account_switch_is_kept_on_the_thread() {
        let mut store = Store::in_memory();
        store.create_thread(&ThreadRecord { account: Some("initech".into()), ..thread("a") }).unwrap();
        store.append("a", 2, json!({"type": "session/accountChanged", "account": "acme"})).unwrap();
        store.append("a", 3, json!({"type": "turn/started", "turnId": "t", "input": null})).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().account.as_deref(), Some("acme"));
    }

    #[test]
    fn a_permission_switch_is_kept_on_the_thread() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        store.append("a", 2, json!({"type": "session/permissionChanged", "mode": "bypassPermissions", "label": "Allow everything"})).unwrap();
        store.append("a", 3, json!({"type": "turn/started", "turnId": "t", "input": null})).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().permission_mode, "bypassPermissions");
    }

    #[test]
    fn titles_a_thread_from_its_first_message_once() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        let started = |text: &str| json!({"type": "turn/started", "turnId": "t", "input": {"text": text, "clientRequestId": "c"}});
        store.append("a", 2, started("\n  Fix the login test\nit fails since Monday")).unwrap();
        store.append("a", 3, started("And the signup one")).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().title.as_deref(), Some("Fix the login test"));
        store.create_thread(&thread("b")).unwrap();
        store.append("b", 2, started(&"é".repeat(200))).unwrap();
        assert_eq!(store.thread("b").unwrap().unwrap().title.unwrap().chars().count(), TITLE_CHARS);
    }

    #[test]
    fn counts_turns_time_and_tokens_since_a_time() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        let done = |ms: u64| json!({"type": "turn/completed", "turnId": "t", "status": "completed", "error": null,
            "usage": {"inputTokens": 100, "outputTokens": 20, "costUsd": null, "durationMs": ms}});
        store.append("a", 5, done(1000)).unwrap();
        store.append("a", 10, done(2000)).unwrap();
        store.append("a", 11, json!({"type": "turn/completed", "turnId": "t", "status": "failed", "error": "x", "usage": null})).unwrap();
        assert_eq!(store.stats_since(10).unwrap(), Stats { turns: 2, duration_ms: 2000, tokens: 120 });
        assert_eq!(store.tokens_of(&["a".into(), "nobody".into()]).unwrap(), (200, 40));
    }

    #[test]
    fn numbers_events_per_thread_and_replays_after_a_seq() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        store.create_thread(&thread("b")).unwrap();
        for n in 0..3 {
            store
                .append("a", n, json!({"type": "item/delta", "n": n}))
                .unwrap();
        }
        assert_eq!(
            store
                .append("b", 9, json!({"type": "turn/started"}))
                .unwrap()
                .seq,
            1
        );
        let seqs: Vec<u64> = store
            .events_after("a", 1)
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(seqs, vec![2, 3]);
    }

    #[test]
    fn remembers_the_provider_session_for_resume() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        store
            .append(
                "a",
                5,
                json!({"type": "session/configured", "providerSessionId": "s1"}),
            )
            .unwrap();
        store
            .append(
                "a",
                6,
                json!({"type": "session/configured", "providerSessionId": null}),
            )
            .unwrap();
        let record = store.thread("a").unwrap().unwrap();
        assert_eq!(record.provider_session_id.as_deref(), Some("s1"));
        assert_eq!(record.updated_at, 6);
    }

    #[test]
    fn remembers_a_picked_model_for_the_next_start() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        store
            .append(
                "a",
                5,
                json!({"type": "session/modelChanged", "model": "sonnet", "label": "Sonnet 5.5"}),
            )
            .unwrap();
        store
            .append("a", 6, json!({"type": "session/configured", "model": "claude-opus-5-5"}))
            .unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().model.as_deref(), Some("sonnet"));
    }

    #[test]
    fn remembers_a_picked_effort_and_keeps_it_when_a_switch_has_none() {
        let mut store = Store::in_memory();
        store.create_thread(&ThreadRecord { runner: "codex".into(), ..thread("a") }).unwrap();
        let switch = |effort: Option<&str>| {
            let mut event = json!({"type": "session/modelChanged", "model": "gpt-6.1-sol", "label": "GPT-6.1-Sol"});
            if let Some(effort) = effort {
                event["effort"] = json!(effort);
            }
            event
        };
        store.append("a", 5, switch(Some("high"))).unwrap();
        store.append("a", 6, switch(None)).unwrap();
        let record = store.thread("a").unwrap().unwrap();
        assert_eq!((record.runner.as_str(), record.effort.as_deref()), ("codex", Some("high")));
    }

    #[test]
    fn a_store_from_before_runners_gets_them_with_claude_for_old_threads() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE chat_threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, model TEXT,
               permission_mode TEXT NOT NULL, provider_session_id TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
             INSERT INTO chat_threads VALUES ('old', '/w', NULL, 'default', NULL, 1, 1);
             -- CodeChat sessions whose imported thread was deleted (#291), so Import never brings one back.
             CREATE TABLE IF NOT EXISTS chat_deleted_imports (codechat_id TEXT PRIMARY KEY) WITHOUT ROWID;
             PRAGMA user_version = 1;",
        )
        .unwrap();
        let store = Store::init(conn).unwrap();
        let old = store.thread("old").unwrap().unwrap();
        assert_eq!((old.runner.as_str(), old.effort), ("claude", None));
    }

    #[test]
    fn compaction_keeps_seq_order_and_never_reuses_a_seq() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        store
            .append("a", 0, json!({"type": "turn/started"}))
            .unwrap();
        store.append("a", 0, json!({"type": "item/delta"})).unwrap();
        store
            .append("a", 0, json!({"type": "item/completed"}))
            .unwrap();
        store.compact_turn("a", 1).unwrap();
        let kinds: Vec<String> = store
            .events_after("a", 0)
            .unwrap()
            .iter()
            .map(|e| event_type(&e.event).to_string())
            .collect();
        assert_eq!(kinds, vec!["turn/started", "item/completed"]);
        assert_eq!(
            store
                .append("a", 0, json!({"type": "turn/completed"}))
                .unwrap()
                .seq,
            4
        );
    }

    #[test]
    fn a_generated_title_replaces_the_first_line_but_never_a_rename() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        assert!(store.needs_title("a").unwrap());
        store.append("a", 2, json!({"type": "turn/started", "turnId": "t", "input": {"text": "tolong cek test login"}})).unwrap();
        assert!(!store.needs_title("a").unwrap(), "only the first message makes a title");
        assert!(store.apply_generated_title("a", "Perbaiki test login").unwrap());
        assert!(!store.apply_generated_title("a", "Again").unwrap(), "made once");
        assert_eq!(store.thread("a").unwrap().unwrap().title.as_deref(), Some("Perbaiki test login"));

        store.create_thread(&thread("b")).unwrap();
        store.rename("b", "Mine").unwrap();
        assert!(!store.needs_title("b").unwrap());
        assert!(!store.apply_generated_title("b", "Generated").unwrap(), "a rename always wins");
        assert_eq!(store.thread("b").unwrap().unwrap().title.as_deref(), Some("Mine"));
        store.rename("b", " ").unwrap();
        assert_eq!(store.thread("b").unwrap().unwrap().title, None, "cleared: back to the first line, none yet");
        assert!(store.needs_title("b").unwrap());

        // The model answered before the bridge reported the turn: the first line does not undo it.
        store.create_thread(&thread("c")).unwrap();
        assert!(store.apply_generated_title("c", "Early").unwrap());
        store.append("c", 2, json!({"type": "turn/started", "turnId": "t", "input": {"text": "the first message"}})).unwrap();
        assert_eq!(store.thread("c").unwrap().unwrap().title.as_deref(), Some("Early"));
    }

    #[test]
    fn a_regenerated_title_replaces_even_a_rename() {
        let store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        store.rename("a", "Mine").unwrap();
        store.set_generated_title("a", "Regenerated").unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().title.as_deref(), Some("Regenerated"));
        assert!(!store.needs_title("a").unwrap());
        assert!(store.set_generated_title("gone", "x").is_err());
    }

    #[test]
    fn an_imported_title_is_never_regenerated() {
        let mut store = Store::in_memory();
        store.import_thread(&ThreadRecord { title: None, imported_from: Some("cc1".into()), ..thread("a") }, &[]).unwrap();
        assert!(!store.needs_title("a").unwrap());
        assert!(!store.apply_generated_title("a", "Generated").unwrap());
    }

    #[test]
    fn renames_archives_and_deletes_a_thread() {
        let mut store = Store::in_memory();
        store.create_thread(&ThreadRecord { imported_from: Some("cc1".into()), ..thread("a") }).unwrap();
        store.append("a", 2, json!({"type": "turn/started", "turnId": "t", "input": {"text": "Fix the login test"}})).unwrap();
        store.rename("a", "  Login  ").unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().title.as_deref(), Some("Login"));
        store.rename("a", " ").unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().title.as_deref(), Some("Fix the login test"));
        store.set_pinned("a", Some(7)).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().pinned_at, Some(7));
        store.set_archived("a", true).unwrap();
        let archived = store.thread("a").unwrap().unwrap();
        assert!(archived.archived);
        assert_eq!(archived.pinned_at, None, "archiving unpins");
        store.set_pinned("a", Some(8)).unwrap();
        store.set_archived("a", false).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().pinned_at, Some(8), "unarchiving keeps a pin");
        store.set_pinned("a", None).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().pinned_at, None);
        assert!(store.set_pinned("nope", Some(1)).is_err());
        store.delete_thread("a").unwrap();
        assert!(store.thread("a").unwrap().is_none());
        assert!(store.events_after("a", 0).unwrap().is_empty());
        assert!(store.is_imported("cc1").unwrap());
        assert!(store.append("a", 3, json!({"type": "turn/completed"})).is_err());
        assert!(store.events_after("a", 0).unwrap().is_empty());
        assert!(store.rename("a", "x").is_err());
    }

    #[test]
    fn remembers_when_a_turn_ended_and_when_it_was_read() {
        let mut store = Store::in_memory();
        store.create_thread(&thread("a")).unwrap();
        store.append("a", 2, json!({"type": "turn/started", "turnId": "t", "input": null})).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().last_turn_ended_at, None);
        store.append("a", 5, json!({"type": "turn/completed", "turnId": "t"})).unwrap();
        store.append("a", 6, json!({"type": "session/ended", "error": null})).unwrap();
        let record = store.thread("a").unwrap().unwrap();
        assert_eq!((record.last_turn_ended_at, record.last_read_at), (Some(5), None));
        store.mark_read("a", 7).unwrap();
        assert_eq!(store.thread("a").unwrap().unwrap().last_read_at, Some(7));
        assert!(store.mark_read("missing", 7).is_err());
    }

    #[test]
    fn refuses_a_newer_schema() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", 99).unwrap();
        assert!(Store::init(conn).err().unwrap().contains("newer"));
    }
}
