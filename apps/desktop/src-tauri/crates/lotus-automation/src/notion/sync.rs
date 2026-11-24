//! Keeping one Notion source fresh (PLAN §2.4, §2.7, task "Ticket Sources 05").
//!
//! There is no webhook — Notion's needs a public HTTPS endpoint (S23) — so the caller asks for a
//! sync every minute or so, and this decides what to ask Notion for: the rows edited since the last
//! sync (S24), or every row when the copy is due a full re-read (S25).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::api::{NotionApi, RowsRead};
use super::rows::NotionRow;
pub use super::schema::FieldProblem;
use super::schema::{DataSourceSchema, FieldMapping};
use super::NotionError;
use crate::secrets::redact;

/// How far before the last sync an incremental query reaches back. Notion rounds
/// `last_edited_time` down to the minute, so an edit just after a sync can carry a time before it;
/// two minutes also covers a little clock drift between here and Notion (S24).
pub const OVERLAP_MS: i64 = 2 * 60_000;

/// How often every row is read again, to notice pages moved to trash: a trashed page never comes
/// back from a query, and the query cannot filter on `in_trash` (S25). A proposal, not a measure.
pub const RECONCILE_EVERY_MS: i64 = 15 * 60_000;

/// What a [`SourceCopy`] on disk holds. A copy of an older format is read again in full, so no row
/// keeps missing a field that was added since (1: rows carry `assignee_ids`).
pub const COPY_FORMAT: u32 = 1;

/// A source's rows as last read, kept on disk as its last good copy (S28).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCopy {
    pub rows: Vec<NotionRow>,
    /// When the last sync that worked started.
    pub synced_at_ms: Option<i64>,
    /// When every row was last read, rather than only the edited ones.
    pub reconciled_at_ms: Option<i64>,
    /// False when Notion's result cap stopped the last full read before the last row.
    pub complete: bool,
    /// The board's fields as last read: its status options, and what the mapping is checked against.
    #[serde(default)]
    pub schema: Option<DataSourceSchema>,
    /// [`COPY_FORMAT`] when it was written; 0 for a copy from before there was one.
    #[serde(default)]
    pub format: u32,
}

/// What state a source is in after a sync (S40).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SourceHealth {
    Healthy,
    /// Notion could not be reached. The copy stays; Retry.
    Offline { message: String },
    /// Notion asked Lotus to slow down (429). Nothing is asked until `retry_at_ms` (S27).
    SlowedDown { retry_at_ms: i64 },
    /// Lotus can no longer read the database. The copy stays; the person must act.
    LostAccess { why: LostAccess },
    /// A mapped field is gone or is now another type (S19). The rows still show; status writes are
    /// paused until the fields are remapped.
    FieldsChanged { fields: Vec<FieldProblem> },
    /// Notion answered, but not with rows.
    Failed { message: String },
}

impl SourceHealth {
    /// Whether Lotus must not write a ticket's status now (S19). Every write — task "Ticket
    /// Sources 09" — asks this first.
    pub fn writes_paused(&self) -> bool {
        matches!(self, Self::FieldsChanged { .. })
    }

    fn after(error: NotionError, now_ms: i64) -> Self {
        let message = redact(&error.to_string());
        match error {
            NotionError::Offline(_) => Self::Offline { message },
            NotionError::RateLimited { retry_after, .. } => {
                Self::SlowedDown { retry_at_ms: now_ms + i64::try_from(retry_after.as_millis()).unwrap_or(i64::MAX / 2) }
            }
            NotionError::Reconnect(_) => Self::LostAccess { why: LostAccess::Token },
            NotionError::NotFound(_) => Self::LostAccess { why: LostAccess::Unshared },
            NotionError::Failed(_) => Self::Failed { message },
        }
    }
}

/// Why a source's access is lost, which decides what the person is asked to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LostAccess {
    /// 401: the token is wrong, expired or revoked — or none is kept. Reconnect.
    Token,
    /// 404: the database was unshared from the token, or moved to trash. How to share.
    Unshared,
}

/// One sync, as the caller asks for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncRequest {
    pub now_ms: i64,
    /// Read every row now, due or not — when the source is opened (S25).
    pub full: bool,
    /// Notion asked not to be asked before this; a sync before it asks nothing.
    pub not_before_ms: Option<i64>,
}

impl SyncRequest {
    pub fn at(now_ms: i64) -> Self {
        Self { now_ms, full: false, not_before_ms: None }
    }

    pub fn not_before(self, retry_at_ms: i64) -> Self {
        Self { not_before_ms: Some(retry_at_ms), ..self }
    }

    pub fn full(self) -> Self {
        Self { full: true, ..self }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Synced {
    pub copy: SourceCopy,
    pub health: SourceHealth,
    /// True when every row was read, not only the edited ones.
    pub full: bool,
    /// Requests this sync sent to Notion.
    pub requests: u32,
}

pub async fn sync_source(
    api: &NotionApi,
    data_source_id: &str,
    mapping: &FieldMapping,
    kept: Option<SourceCopy>,
    request: SyncRequest,
) -> Synced {
    let now = request.now_ms;
    if let Some(retry_at_ms) = request.not_before_ms.filter(|&at| now < at) {
        let health = SourceHealth::SlowedDown { retry_at_ms };
        return Synced { copy: kept.unwrap_or_default(), health, full: false, requests: 0 };
    }
    let api = api.never_waiting();
    let sent_before = api.requests_sent();
    let incremental = kept.as_ref().and_then(|kept| {
        let synced = kept.synced_at_ms?;
        let reconciled = kept.reconciled_at_ms?;
        (!request.full && kept.format >= COPY_FORMAT && now - reconciled < RECONCILE_EVERY_MS).then_some(synced)
    });
    let read = match incremental {
        Some(synced) => api.read_rows_edited_since(data_source_id, mapping, &iso(synced - OVERLAP_MS)).await,
        None => api.read_rows(data_source_id, mapping).await,
    };
    let full = incremental.is_none();
    let (copy, mut health) = match (read, kept) {
        (Ok(read), kept) => {
            let known = kept.as_ref().and_then(|k| k.schema.clone());
            // The fields are read again only when there is reason to: a full read, a page that no
            // longer fits the mapping, or a status Lotus has not seen (S20: follow Notion's options).
            let look = full || !read.fits || known.is_none() || has_unknown_status(&read, mapping, known.as_ref());
            let copy = match kept {
                Some(kept) if !full => merged(kept, read, now),
                _ => SourceCopy {
                    rows: read.rows,
                    synced_at_ms: Some(now),
                    reconciled_at_ms: Some(now),
                    complete: read.complete,
                    schema: known,
                    format: COPY_FORMAT,
                },
            };
            match look {
                false => (copy, SourceHealth::Healthy),
                true => match api.data_source(data_source_id).await {
                    Ok(schema) => (SourceCopy { schema: Some(schema), ..copy }, SourceHealth::Healthy),
                    // The rows are good: keep them, with the fields as last read. The next sync
                    // that has reason to looks at the fields again.
                    Err(error) => {
                        eprintln!("[notion] the rows were read, the fields were not: {}", redact(&error.to_string()));
                        (copy, SourceHealth::Healthy)
                    }
                },
            }
        }
        (Err(error), kept) => (kept.unwrap_or_default(), SourceHealth::after(error, now)),
    };
    // A field that stopped fitting stays said on every later sync, until it is remapped (S19).
    if health == SourceHealth::Healthy {
        let fields = copy.schema.as_ref().map(|schema| mapping.problems(schema)).unwrap_or_default();
        if !fields.is_empty() {
            health = SourceHealth::FieldsChanged { fields };
        }
    }
    Synced { copy, health, full, requests: api.requests_sent() - sent_before }
}

/// A status option on an edited row that the kept fields do not list.
fn has_unknown_status(read: &RowsRead, mapping: &FieldMapping, schema: Option<&DataSourceSchema>) -> bool {
    let Some(options) = mapping.status.as_deref().and_then(|id| schema?.property(id)?.status.as_ref()) else {
        return false;
    };
    read.rows.iter().filter_map(|row| row.status.as_deref()).any(|status| !options.options.iter().any(|o| o.id == status))
}

/// `kept` with the edited rows put in place of their old versions, and new ones added at the end.
fn merged(mut kept: SourceCopy, edited: RowsRead, now: i64) -> SourceCopy {
    for row in edited.rows {
        match kept.rows.iter_mut().find(|r| r.page_id == row.page_id) {
            Some(old) => *old = row,
            None => kept.rows.push(row),
        }
    }
    kept.synced_at_ms = Some(now);
    kept
}

/// A time as Notion's filters take it: `2026-09-29T09:58:30.000Z`.
fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// The health a write is checked against (S42). The last sync's answer alone is not enough: a sync
/// that was slowed down or offline after "Fields changed" says nothing about the fields, and must not
/// lift the pause. So the kept fields are checked too, every time.
pub fn write_health(last: Option<&SourceHealth>, kept: Option<&SourceCopy>, mapping: &FieldMapping) -> SourceHealth {
    if let Some(paused) = last.filter(|h| h.writes_paused()) {
        return paused.clone();
    }
    let fields = kept.and_then(|copy| copy.schema.as_ref()).map(|schema| mapping.problems(schema)).unwrap_or_default();
    if !fields.is_empty() {
        return SourceHealth::FieldsChanged { fields };
    }
    last.cloned().unwrap_or(SourceHealth::Healthy)
}
