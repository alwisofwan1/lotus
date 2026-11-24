use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::codecanvas_store::{CodeCanvasStoreError, CodeCanvasStoreResult};

const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub project_id: String,
    pub scope_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    pub importance: i64,
    pub tags: Vec<String>,
    pub metadata: Value,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub actor_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignment_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteMemoryInput {
    pub project_id: String,
    #[serde(default = "default_scope_kind")]
    pub scope_kind: String,
    #[serde(default)]
    pub scope_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub importance: Option<i64>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub actor_id: Option<String>,
    #[serde(default = "default_actor_kind")]
    pub actor_kind: String,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub assignment_key: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub now: Option<i64>,
}

fn default_scope_kind() -> String {
    "project".into()
}

fn default_source() -> String {
    "mcp".into()
}

fn default_actor_kind() -> String {
    "agent".into()
}

impl WriteMemoryInput {
    #[cfg(test)]
    pub fn minimal_project_note(project_id: &str, body: &str) -> Self {
        Self {
            project_id: project_id.into(),
            scope_kind: "project".into(),
            scope_id: None,
            kind: "note".into(),
            title: None,
            body: body.into(),
            summary: None,
            status: None,
            importance: None,
            tags: Vec::new(),
            metadata: Value::Object(Default::default()),
            source: "human".into(),
            actor_id: None,
            actor_kind: "human".into(),
            node_id: None,
            run_id: None,
            assignment_key: None,
            session_id: None,
            parent_id: None,
            idempotency_key: None,
            now: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListQuery {
    pub project_id: String,
    #[serde(default)]
    pub scope_kind: Option<String>,
    #[serde(default)]
    pub scope_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub assignment_key: Option<String>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchQuery {
    pub project_id: String,
    pub query: String,
    #[serde(default)]
    pub scope_kind: Option<String>,
    #[serde(default)]
    pub scope_id: Option<String>,
    #[serde(default)]
    pub node_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub assignment_key: Option<String>,
    #[serde(default)]
    pub kinds: Vec<String>,
    #[serde(default)]
    pub include_archived: bool,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResult {
    pub item: MemoryItem,
    pub rank: f64,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn invalid(message: impl Into<String>) -> CodeCanvasStoreError {
    CodeCanvasStoreError::Path(message.into())
}

fn clean(value: &str) -> String {
    value.trim().to_string()
}

fn clean_opt(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(clean)
        .filter(|value| !value.is_empty())
}

fn json_error(err: serde_json::Error) -> CodeCanvasStoreError {
    CodeCanvasStoreError::Path(err.to_string())
}

fn json_value(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn string_vec(raw: String) -> rusqlite::Result<Vec<String>> {
    serde_json::from_str(&raw).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
    })
}

fn limit(value: Option<i64>) -> i64 {
    value.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn fts_query(query: &str) -> String {
    query
        .split(|ch: char| !ch.is_alphanumeric())
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn read_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    Ok(MemoryItem {
        id: row.get(0)?,
        project_id: row.get(1)?,
        scope_kind: row.get(2)?,
        scope_id: row.get(3)?,
        kind: row.get(4)?,
        title: row.get(5)?,
        body: row.get(6)?,
        summary: row.get(7)?,
        status: row.get(8)?,
        importance: row.get(9)?,
        tags: string_vec(row.get(10)?)?,
        metadata: json_value(row.get(11)?)?,
        source: row.get(12)?,
        actor_id: row.get(13)?,
        actor_kind: row.get(14)?,
        node_id: row.get(15)?,
        run_id: row.get(16)?,
        assignment_key: row.get(17)?,
        session_id: row.get(18)?,
        parent_id: row.get(19)?,
        idempotency_key: row.get(20)?,
        created_at: row.get(21)?,
        updated_at: row.get(22)?,
        archived_at: row.get(23)?,
    })
}

fn select_columns() -> &'static str {
    "id, project_id, scope_kind, scope_id, kind, title, body, summary, status, importance,
     tags_json, metadata_json, source, actor_id, actor_kind, node_id, run_id, assignment_key,
     session_id, parent_id, idempotency_key, created_at, updated_at, archived_at"
}

fn select_columns_qualified(alias: &str) -> String {
    select_columns()
        .split(',')
        .map(|column| format!("{alias}.{}", column.trim()))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Tool-native memory sources. They are private/external and may be stale, so they may only enter
/// Lotus project memory through an explicit promotion — never a silent direct write.
const NATIVE_SOURCES: &[&str] = &["claude", "codex", "cursor", "claude-mem"];

/// Size ceilings for a single memory row. Memory is read on every agent spawn and returned whole to
/// the panel, so an unbounded write is a durable cost to every later read, not just to one row.
/// Generous enough that no realistic decision or rule hits them.
const MAX_BODY_CHARS: usize = 16_384;
const MAX_TITLE_CHARS: usize = 512;
const MAX_SUMMARY_CHARS: usize = 4_096;
const MAX_TAGS: usize = 16;
const MAX_TAG_CHARS: usize = 64;

fn validate_write(input: &WriteMemoryInput, allow_native: bool) -> CodeCanvasStoreResult<()> {
    for (label, value) in [
        ("project id", input.project_id.as_str()),
        ("scope kind", input.scope_kind.as_str()),
        ("kind", input.kind.as_str()),
        ("body", input.body.as_str()),
        ("source", input.source.as_str()),
        ("actor kind", input.actor_kind.as_str()),
    ] {
        if value.trim().is_empty() {
            return Err(invalid(format!("{label} is required")));
        }
    }
    for (label, value, max) in [
        ("body", Some(input.body.as_str()), MAX_BODY_CHARS),
        ("title", input.title.as_deref(), MAX_TITLE_CHARS),
        ("summary", input.summary.as_deref(), MAX_SUMMARY_CHARS),
    ] {
        let Some(value) = value else { continue };
        let length = value.chars().count();
        if length > max {
            return Err(invalid(format!(
                "{label} is {length} characters, over the {max} limit; store a summary and keep the detail in the repo"
            )));
        }
    }
    if input.tags.len() > MAX_TAGS {
        return Err(invalid(format!(
            "{} tags given, over the {MAX_TAGS} limit",
            input.tags.len()
        )));
    }
    if let Some(tag) = input
        .tags
        .iter()
        .find(|tag| tag.chars().count() > MAX_TAG_CHARS)
    {
        return Err(invalid(format!(
            "tag '{}' is over the {MAX_TAG_CHARS} character limit",
            &tag[..tag.len().min(24)]
        )));
    }
    if !allow_native && NATIVE_SOURCES.contains(&input.source.trim()) {
        return Err(invalid(format!(
            "source '{}' is tool-native memory; promote it explicitly instead of writing it directly",
            input.source.trim()
        )));
    }
    Ok(())
}

pub fn write_memory(
    connection: &Connection,
    input: &WriteMemoryInput,
) -> CodeCanvasStoreResult<MemoryItem> {
    write_memory_impl(connection, input, false)
}

/// Explicit human/agent action to promote tool-native (Claude/Codex/Cursor/claude-mem) context into
/// shared Lotus project memory. Forces `kind = external-context` and requires a native source, so
/// promotion is auditable and native memory is never silently synced.
pub fn promote_external_context(
    connection: &Connection,
    input: &WriteMemoryInput,
) -> CodeCanvasStoreResult<MemoryItem> {
    if !NATIVE_SOURCES.contains(&input.source.trim()) {
        return Err(invalid(
            "promote requires a native source: claude, codex, cursor, or claude-mem",
        ));
    }
    let promoted = WriteMemoryInput {
        kind: "external-context".to_string(),
        ..input.clone()
    };
    write_memory_impl(connection, &promoted, true)
}

fn write_memory_impl(
    connection: &Connection,
    input: &WriteMemoryInput,
    allow_native: bool,
) -> CodeCanvasStoreResult<MemoryItem> {
    validate_write(input, allow_native)?;
    if let Some(key) = clean_opt(&input.idempotency_key) {
        if let Some(existing) = get_by_idempotency_key(connection, &input.project_id, &key)? {
            return Ok(existing);
        }
    }
    let now = input.now.unwrap_or_else(now_ms);
    let item = MemoryItem {
        id: format!("mem-{}-{}", now, uuid::Uuid::new_v4()),
        project_id: clean(&input.project_id),
        scope_kind: clean(&input.scope_kind),
        scope_id: clean_opt(&input.scope_id),
        kind: clean(&input.kind),
        title: clean_opt(&input.title),
        body: clean(&input.body),
        summary: clean_opt(&input.summary),
        status: clean_opt(&input.status),
        importance: input.importance.unwrap_or(0),
        tags: input
            .tags
            .iter()
            .map(|tag| clean(tag))
            .filter(|tag| !tag.is_empty())
            .collect(),
        metadata: input.metadata.clone(),
        source: clean(&input.source),
        actor_id: clean_opt(&input.actor_id),
        actor_kind: clean(&input.actor_kind),
        node_id: clean_opt(&input.node_id),
        run_id: clean_opt(&input.run_id),
        assignment_key: clean_opt(&input.assignment_key),
        session_id: clean_opt(&input.session_id),
        parent_id: clean_opt(&input.parent_id),
        idempotency_key: clean_opt(&input.idempotency_key),
        created_at: now,
        updated_at: now,
        archived_at: None,
    };
    insert_item(connection, &item)?;
    Ok(item)
}

fn insert_item(connection: &Connection, item: &MemoryItem) -> CodeCanvasStoreResult<()> {
    let tags_json = serde_json::to_string(&item.tags).map_err(json_error)?;
    let metadata_json = serde_json::to_string(&item.metadata).map_err(json_error)?;
    // The FTS row is mirrored by the trg_codecanvas_memory_fts_ai trigger inside this same
    // statement's transaction, so search stays consistent without the caller touching FTS.
    connection.execute(
        "INSERT INTO codecanvas_memory_items
         (id, project_id, scope_kind, scope_id, kind, title, body, summary, status, importance,
          tags_json, metadata_json, source, actor_id, actor_kind, node_id, run_id, assignment_key,
          session_id, parent_id, idempotency_key, created_at, updated_at, archived_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                 ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
        params![
            item.id,
            item.project_id,
            item.scope_kind,
            item.scope_id,
            item.kind,
            item.title,
            item.body,
            item.summary,
            item.status,
            item.importance,
            tags_json,
            metadata_json,
            item.source,
            item.actor_id,
            item.actor_kind,
            item.node_id,
            item.run_id,
            item.assignment_key,
            item.session_id,
            item.parent_id,
            item.idempotency_key,
            item.created_at,
            item.updated_at,
            item.archived_at
        ],
    )?;
    Ok(())
}

fn get_by_idempotency_key(
    connection: &Connection,
    project_id: &str,
    key: &str,
) -> CodeCanvasStoreResult<Option<MemoryItem>> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM codecanvas_memory_items WHERE project_id = ?1 AND idempotency_key = ?2",
                select_columns()
            ),
            params![project_id, key],
            read_item,
        )
        .optional()
        .map_err(Into::into)
}

pub fn list_memory(
    connection: &Connection,
    query: &MemoryListQuery,
) -> CodeCanvasStoreResult<Vec<MemoryItem>> {
    if query.project_id.trim().is_empty() {
        return Err(invalid("project id is required"));
    }
    let kinds_json = serde_json::to_string(&query.kinds).map_err(json_error)?;
    let sql = format!(
        "SELECT {} FROM codecanvas_memory_items
         WHERE project_id = ?1
           AND (?2 OR archived_at IS NULL)
           AND (?3 IS NULL OR scope_kind = ?3)
           AND (?4 IS NULL OR scope_id = ?4)
           AND (?5 IS NULL OR node_id = ?5)
           AND (?6 IS NULL OR run_id = ?6)
           AND (?7 IS NULL OR assignment_key = ?7)
           AND (json_array_length(?8) = 0 OR kind IN (SELECT value FROM json_each(?8)))
         ORDER BY updated_at DESC, created_at DESC
         LIMIT ?9",
        select_columns()
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            query.project_id,
            query.include_archived,
            clean_opt(&query.scope_kind),
            clean_opt(&query.scope_id),
            clean_opt(&query.node_id),
            clean_opt(&query.run_id),
            clean_opt(&query.assignment_key),
            kinds_json,
            limit(query.limit),
        ],
        read_item,
    )?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn search_memory(
    connection: &Connection,
    query: &MemorySearchQuery,
) -> CodeCanvasStoreResult<Vec<MemorySearchResult>> {
    let text_query = fts_query(&query.query);
    if query.project_id.trim().is_empty() {
        return Err(invalid("project id is required"));
    }
    if text_query.is_empty() {
        return Ok(Vec::new());
    }
    let kinds_json = serde_json::to_string(&query.kinds).map_err(json_error)?;
    let sql = format!(
        "SELECT {}, bm25(codecanvas_memory_fts) AS rank
         FROM codecanvas_memory_fts
         JOIN codecanvas_memory_items ON codecanvas_memory_items.id = codecanvas_memory_fts.item_id
         WHERE codecanvas_memory_fts MATCH ?1
           AND codecanvas_memory_fts.project_id = ?2
           AND (?3 OR archived_at IS NULL)
           AND (?4 IS NULL OR scope_kind = ?4)
           AND (?5 IS NULL OR scope_id = ?5)
           AND (?6 IS NULL OR node_id = ?6)
           AND (?7 IS NULL OR run_id = ?7)
           AND (?8 IS NULL OR assignment_key = ?8)
           AND (json_array_length(?9) = 0 OR kind IN (SELECT value FROM json_each(?9)))
         ORDER BY rank ASC, updated_at DESC
         LIMIT ?10",
        select_columns_qualified("codecanvas_memory_items")
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(
        params![
            text_query,
            query.project_id,
            query.include_archived,
            clean_opt(&query.scope_kind),
            clean_opt(&query.scope_id),
            clean_opt(&query.node_id),
            clean_opt(&query.run_id),
            clean_opt(&query.assignment_key),
            kinds_json,
            limit(query.limit),
        ],
        |row| {
            Ok(MemorySearchResult {
                item: read_item(row)?,
                rank: row.get(24)?,
            })
        },
    )?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn archive_memory_item(
    connection: &Connection,
    project_id: &str,
    item_id: &str,
    archived_at: i64,
) -> CodeCanvasStoreResult<()> {
    connection.execute(
        "UPDATE codecanvas_memory_items
         SET archived_at = ?1, updated_at = ?1
         WHERE project_id = ?2 AND id = ?3",
        params![archived_at, project_id, item_id],
    )?;
    Ok(())
}

/// Undo for `archive_memory_item`. Clears `archived_at` so the row rejoins the hot set the panel and
/// the agent prompt read from.
pub fn restore_memory_item(
    connection: &Connection,
    project_id: &str,
    item_id: &str,
    now: i64,
) -> CodeCanvasStoreResult<()> {
    connection.execute(
        "UPDATE codecanvas_memory_items
         SET archived_at = NULL, updated_at = ?1
         WHERE project_id = ?2 AND id = ?3",
        params![now, project_id, item_id],
    )?;
    Ok(())
}

fn get_item_by_id(
    connection: &Connection,
    project_id: &str,
    item_id: &str,
) -> CodeCanvasStoreResult<Option<MemoryItem>> {
    connection
        .query_row(
            &format!(
                "SELECT {} FROM codecanvas_memory_items WHERE project_id = ?1 AND id = ?2",
                select_columns()
            ),
            params![project_id, item_id],
            read_item,
        )
        .optional()
        .map_err(Into::into)
}

/// Pinning is a tag, not an importance score: `RetentionPolicy` protects rows carrying `PINNED_TAG`
/// from auto-archiving. Existing tag order is preserved so pinning never reshuffles an item's tags.
pub fn set_memory_pinned(
    connection: &Connection,
    project_id: &str,
    item_id: &str,
    pinned: bool,
    now: i64,
) -> CodeCanvasStoreResult<MemoryItem> {
    let Some(item) = get_item_by_id(connection, project_id, item_id)? else {
        return Err(invalid(format!("memory item '{item_id}' not found")));
    };
    let mut tags: Vec<String> = item
        .tags
        .iter()
        .filter(|tag| tag.as_str() != PINNED_TAG)
        .cloned()
        .collect();
    if pinned {
        tags.push(PINNED_TAG.to_string());
    }
    let tags_json = serde_json::to_string(&tags).map_err(json_error)?;
    connection.execute(
        "UPDATE codecanvas_memory_items
         SET tags_json = ?1, updated_at = ?2
         WHERE project_id = ?3 AND id = ?4",
        params![tags_json, now, project_id, item_id],
    )?;
    Ok(MemoryItem {
        tags,
        updated_at: now,
        ..item
    })
}

// ── Retention / archive policy ────────────────────────────────────────────
// Keeps the hot retrieval path quiet without destroying audit history: durable kinds are never
// auto-archived, recent evidence/blocker history per assignment is protected, and everything else
// ages out by per-kind TTL. Archived rows stay searchable via `include_archived: true`.

const DAY_MS: i64 = 86_400_000;
const PINNED_TAG: &str = "pinned";
const NEVER_ARCHIVE_KINDS: &[&str] = &["decision", "constraint", "artifact", "external-context"];
const EVIDENCE_LIKE_KINDS: &[&str] = &["evidence", "handoff"];
const SHORT_TTL_KINDS: &[&str] = &["note", "status", "session", "answer", "question"];

#[derive(Debug, Clone)]
pub struct RetentionPolicy {
    pub now: i64,
    /// TTL for note/status/session/answer/question after last update.
    pub short_ttl_ms: i64,
    /// TTL for evidence/handoff after last update.
    pub evidence_ttl_ms: i64,
    /// Grace period after a blocker is marked resolved before it may be archived.
    pub blocker_grace_ms: i64,
    /// Importance at or above this is treated as pinned and never auto-archived.
    pub pin_importance: i64,
    /// Newest N evidence/handoff/blocker rows per assignment are always kept hot.
    pub keep_latest_per_assignment: usize,
}

impl RetentionPolicy {
    /// Conservative production defaults; callers may tune per-kind windows.
    pub fn with_now(now: i64) -> Self {
        Self {
            now,
            short_ttl_ms: 7 * DAY_MS,
            evidence_ttl_ms: 30 * DAY_MS,
            blocker_grace_ms: 3 * DAY_MS,
            pin_importance: 50,
            keep_latest_per_assignment: 3,
        }
    }
}

fn is_pinned(item: &MemoryItem, policy: &RetentionPolicy) -> bool {
    item.importance >= policy.pin_importance || item.tags.iter().any(|tag| tag == PINNED_TAG)
}

fn retention_group_key(item: &MemoryItem) -> String {
    item.assignment_key
        .clone()
        .or_else(|| item.run_id.clone())
        .or_else(|| item.node_id.clone())
        .unwrap_or_else(|| item.scope_kind.clone())
}

fn kind_bucket(kind: &str) -> Option<&'static str> {
    if EVIDENCE_LIKE_KINDS.contains(&kind) {
        Some("evidence")
    } else if kind == "blocker" {
        Some("blocker")
    } else {
        None
    }
}

/// Ids of the newest `keep_latest_per_assignment` evidence/handoff/blocker rows per
/// (bucket, assignment) group — protected from archival so recent history survives.
fn protected_latest_ids(items: &[MemoryItem], policy: &RetentionPolicy) -> HashSet<String> {
    let mut groups: HashMap<(&'static str, String), Vec<&MemoryItem>> = HashMap::new();
    for item in items {
        if item.archived_at.is_some() {
            continue;
        }
        if let Some(bucket) = kind_bucket(&item.kind) {
            groups
                .entry((bucket, retention_group_key(item)))
                .or_default()
                .push(item);
        }
    }
    let mut kept = HashSet::new();
    for group in groups.values_mut() {
        group.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then(b.created_at.cmp(&a.created_at))
        });
        for item in group.iter().take(policy.keep_latest_per_assignment) {
            kept.insert(item.id.clone());
        }
    }
    kept
}

/// Pure decision core: which item ids should be archived under `policy`. No SQL, fully unit-testable.
pub fn plan_retention(items: &[MemoryItem], policy: &RetentionPolicy) -> Vec<String> {
    let protected = protected_latest_ids(items, policy);
    items
        .iter()
        .filter(|item| {
            if item.archived_at.is_some() {
                return false;
            }
            if NEVER_ARCHIVE_KINDS.contains(&item.kind.as_str()) {
                return false;
            }
            if is_pinned(item, policy) {
                return false;
            }
            if protected.contains(&item.id) {
                return false;
            }
            match item.kind.as_str() {
                "blocker" => {
                    item.status.as_deref() == Some("resolved")
                        && item.updated_at + policy.blocker_grace_ms < policy.now
                }
                kind if EVIDENCE_LIKE_KINDS.contains(&kind) => {
                    item.updated_at + policy.evidence_ttl_ms < policy.now
                }
                kind if SHORT_TTL_KINDS.contains(&kind) => {
                    item.updated_at + policy.short_ttl_ms < policy.now
                }
                // Unknown kinds are kept — retention never guesses.
                _ => false,
            }
        })
        .map(|item| item.id.clone())
        .collect()
}

fn all_active_items(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Vec<MemoryItem>> {
    let sql = format!(
        "SELECT {} FROM codecanvas_memory_items
         WHERE project_id = ?1 AND archived_at IS NULL
         ORDER BY updated_at DESC, created_at DESC",
        select_columns()
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map(params![project_id], read_item)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Apply the retention policy: mark expired rows `archived_at = policy.now`. Returns count archived.
/// FTS rows are intentionally kept so archived history stays searchable with `include_archived`.
pub fn archive_expired_memory(
    connection: &Connection,
    project_id: &str,
    policy: &RetentionPolicy,
) -> CodeCanvasStoreResult<usize> {
    if project_id.trim().is_empty() {
        return Err(invalid("project id is required"));
    }
    let items = all_active_items(connection, project_id)?;
    let ids = plan_retention(&items, policy);
    if ids.is_empty() {
        return Ok(0);
    }
    let tx = connection.unchecked_transaction()?;
    for id in &ids {
        tx.execute(
            "UPDATE codecanvas_memory_items SET archived_at = ?1
             WHERE project_id = ?2 AND id = ?3 AND archived_at IS NULL",
            params![policy.now, project_id, id],
        )?;
    }
    tx.commit()?;
    Ok(ids.len())
}

// ── Collaboration mirror (Phase 4, additive dual-write) ───────────────────
// Collaboration evidence/blockers are mirrored into append-safe assignment-scoped memory rows
// alongside the legacy mailbox record, so they participate in project memory retrieval/search
// without the whole-mailbox-overwrite race. The legacy record stays authoritative during migration.

/// Build the memory row that mirrors a collaboration evidence/blocker event. Returns `None` when
/// there is nothing durable to record (blank body or missing scope), so callers can skip cleanly.
pub fn collaboration_mirror_input(
    project_id: &str,
    run_id: &str,
    assignee: &str,
    kind: &str,
    summary: &str,
    metadata: Value,
    message_id: Option<&str>,
) -> Option<WriteMemoryInput> {
    let project_id = project_id.trim();
    let run_id = run_id.trim();
    let assignee = assignee.trim();
    let body = summary.trim();
    if project_id.is_empty() || run_id.is_empty() || assignee.is_empty() || body.is_empty() {
        return None;
    }
    let status = if kind == "blocker" {
        Some("open".to_string())
    } else {
        None
    };
    Some(WriteMemoryInput {
        project_id: project_id.to_string(),
        scope_kind: "assignment".to_string(),
        scope_id: Some(format!("{run_id}:{assignee}")),
        kind: kind.to_string(),
        title: None,
        body: body.to_string(),
        summary: None,
        status,
        importance: None,
        tags: Vec::new(),
        metadata,
        source: "collaboration".to_string(),
        actor_id: Some(assignee.to_string()),
        actor_kind: "agent".to_string(),
        node_id: None,
        run_id: Some(run_id.to_string()),
        assignment_key: Some(assignee.to_string()),
        session_id: None,
        parent_id: None,
        idempotency_key: message_id.map(str::to_string),
        now: None,
    })
}

#[cfg(test)]
mod collaboration_mirror_tests {
    use super::*;

    #[test]
    fn maps_evidence_to_assignment_scoped_memory() {
        let input = collaboration_mirror_input(
            "p",
            "run-1",
            "mira",
            "evidence",
            "added regression test",
            serde_json::json!({ "files": ["a.rs"] }),
            Some("msg-1"),
        )
        .expect("evidence mirrors");
        assert_eq!(input.scope_kind, "assignment");
        assert_eq!(input.scope_id.as_deref(), Some("run-1:mira"));
        assert_eq!(input.kind, "evidence");
        assert_eq!(input.source, "collaboration");
        assert_eq!(input.run_id.as_deref(), Some("run-1"));
        assert_eq!(input.assignment_key.as_deref(), Some("mira"));
        assert_eq!(input.idempotency_key.as_deref(), Some("msg-1"));
        assert_eq!(input.status, None);
    }

    #[test]
    fn marks_blocker_open_and_skips_empty_or_unscoped() {
        let blocker = collaboration_mirror_input(
            "p",
            "run-1",
            "mira",
            "blocker",
            "stuck on auth",
            Value::Null,
            None,
        )
        .expect("blocker mirrors");
        assert_eq!(blocker.status.as_deref(), Some("open"));

        assert!(collaboration_mirror_input(
            "p",
            "run-1",
            "mira",
            "evidence",
            "   ",
            Value::Null,
            None
        )
        .is_none());
        assert!(
            collaboration_mirror_input("p", "", "mira", "evidence", "x", Value::Null, None)
                .is_none()
        );
    }
}

#[cfg(test)]
mod retention_tests {
    use super::*;

    fn item(id: &str, kind: &str, updated_at: i64) -> MemoryItem {
        MemoryItem {
            id: id.into(),
            project_id: "p".into(),
            scope_kind: "project".into(),
            scope_id: None,
            kind: kind.into(),
            title: None,
            body: "b".into(),
            summary: None,
            status: None,
            importance: 0,
            tags: Vec::new(),
            metadata: Value::Null,
            source: "mcp".into(),
            actor_id: None,
            actor_kind: "agent".into(),
            node_id: None,
            run_id: None,
            assignment_key: None,
            session_id: None,
            parent_id: None,
            idempotency_key: None,
            created_at: updated_at,
            updated_at,
            archived_at: None,
        }
    }

    fn policy(now: i64) -> RetentionPolicy {
        RetentionPolicy {
            now,
            short_ttl_ms: 100,
            evidence_ttl_ms: 500,
            blocker_grace_ms: 50,
            pin_importance: 50,
            keep_latest_per_assignment: 1,
        }
    }

    #[test]
    fn keeps_decisions_and_constraints_forever() {
        let items = vec![item("d", "decision", 0), item("c", "constraint", 0)];
        assert!(plan_retention(&items, &policy(1_000_000)).is_empty());
    }

    #[test]
    fn archives_short_ttl_when_expired_but_not_when_fresh() {
        let expired = vec![item("n", "note", 0), item("s", "status", 0)];
        let mut ids = plan_retention(&expired, &policy(200));
        ids.sort();
        assert_eq!(ids, vec!["n".to_string(), "s".to_string()]);

        let fresh = vec![item("n2", "note", 150)];
        assert!(plan_retention(&fresh, &policy(200)).is_empty());
    }

    #[test]
    fn keeps_pinned_items_by_importance_or_tag() {
        let mut by_importance = item("hi", "note", 0);
        by_importance.importance = 60;
        let mut by_tag = item("tag", "note", 0);
        by_tag.tags = vec![PINNED_TAG.to_string()];
        assert!(plan_retention(&[by_importance, by_tag], &policy(1_000_000)).is_empty());
    }

    #[test]
    fn keeps_unresolved_blockers_and_archives_older_resolved_ones() {
        let mk = |id: &str, updated: i64| {
            let mut b = item(id, "blocker", updated);
            b.status = Some("resolved".into());
            b.assignment_key = Some("mira".into());
            b
        };
        // Two resolved blockers in one assignment: newest protected, older aged out past grace.
        let resolved = vec![mk("old", 0), mk("newer", 10)];
        assert_eq!(
            plan_retention(&resolved, &policy(1000)),
            vec!["old".to_string()]
        );

        // Unresolved blockers are never archived regardless of age.
        let unresolved = vec![item("b1", "blocker", 0), item("b2", "blocker", 5)];
        assert!(plan_retention(&unresolved, &policy(1_000_000)).is_empty());
    }

    #[test]
    fn keeps_latest_evidence_per_assignment_but_archives_older_expired() {
        let mk = |id: &str, updated: i64| {
            let mut e = item(id, "evidence", updated);
            e.assignment_key = Some("mira".into());
            e
        };
        let items = vec![mk("e_old", 0), mk("e_mid", 100), mk("e_new", 200)];
        let mut ids = plan_retention(&items, &policy(1000));
        ids.sort();
        assert_eq!(ids, vec!["e_mid".to_string(), "e_old".to_string()]);
    }

    #[test]
    fn skips_already_archived_rows() {
        let mut archived = item("a", "note", 0);
        archived.archived_at = Some(5);
        assert!(plan_retention(&[archived], &policy(1000)).is_empty());
    }
}
