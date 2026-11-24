//! Changing one ticket's field in Notion (PLAN S21, S32–S34, S41–S42, task "Ticket Sources 09").
//!
//! Every write passes three checks before anything is sent, then one read:
//!
//! 1. The database is set to **Manage**. A personal access token can always write (S11), so it is
//!    Lotus — this function — that keeps a Read only database read only.
//! 2. The source is not in "Fields changed" (S42): a field that moved may not be the one it was.
//! 3. The field is mapped.
//! 4. Notion has no If-Match or version on `PATCH /v1/pages/{id}` (S32), so the page is read first,
//!    and the write goes ahead only when THIS field is still what the person saw. An edit elsewhere
//!    on the page does not block it: the PATCH sets only this one property. A small gap between
//!    that read and the PATCH remains, and is written down in the ADR (task "Ticket Sources 12").
//!
//! The PATCH is sent once. A 503 may already be saved, so it is never repeated; the page is read
//! again to see (S33).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::api::{notion_message, NotionApi};
use super::rows::NotionRow;
use super::schema::FieldMapping;
use super::sync::SourceHealth;
use super::NotionError;
use crate::secrets::redact;

/// What Lotus may change in a database (S21). Read only is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    #[default]
    ReadOnly,
    Manage,
}

/// One field's new value. Key (`unique_id`) and rollups are never here: Notion does not let them be
/// written (S41).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "field", content = "value", rename_all = "snake_case")]
pub enum TicketChange {
    Title(String),
    /// A status option id.
    Status(String),
    /// User ids.
    Assignees(Vec<String>),
    /// Option names; a new name becomes a new option in Notion.
    Labels(Vec<String>),
}

impl TicketChange {
    fn field(&self) -> &'static str {
        match self {
            Self::Title(_) => "title",
            Self::Status(_) => "status",
            Self::Assignees(_) => "assignee",
            Self::Labels(_) => "labels",
        }
    }

    fn property_id<'a>(&self, mapping: &'a FieldMapping) -> Option<&'a str> {
        match self {
            Self::Title(_) => mapping.title.as_deref(),
            Self::Status(_) => mapping.status.as_deref(),
            Self::Assignees(_) => mapping.assignee.as_deref(),
            Self::Labels(_) => mapping.labels.as_deref(),
        }
    }

    /// The property value, in Notion's shape (reference/patch-page).
    fn value(&self) -> Value {
        match self {
            Self::Title(title) => json!({ "title": [{ "type": "text", "text": { "content": title } }] }),
            Self::Status(id) => json!({ "status": { "id": id } }),
            Self::Assignees(ids) => json!({ "people": ids.iter().map(|id| json!({ "id": id })).collect::<Vec<_>>() }),
            Self::Labels(names) => json!({ "multi_select": names.iter().map(|n| json!({ "name": n })).collect::<Vec<_>>() }),
        }
    }

    /// This field on `row`, compared as the write would set it.
    fn same_as(&self, a: &NotionRow, b: &NotionRow) -> bool {
        match self {
            Self::Title(_) => a.title == b.title,
            Self::Status(_) => a.status == b.status,
            Self::Assignees(_) => a.assignee_ids == b.assignee_ids,
            Self::Labels(_) => a.labels == b.labels,
        }
    }

    /// Whether `row` already carries this change.
    fn is_on(&self, row: &NotionRow) -> bool {
        match self {
            Self::Title(title) => &row.title == title,
            Self::Status(id) => row.status.as_deref() == Some(id.as_str()),
            Self::Assignees(ids) => &row.assignee_ids == ids,
            Self::Labels(names) => &row.labels == names,
        }
    }
}

pub struct WriteRequest<'a> {
    /// The database the source reads. A page from any other is refused.
    pub data_source_id: &'a str,
    pub mapping: &'a FieldMapping,
    pub permission: Permission,
    /// The source's health after its last sync.
    pub health: &'a SourceHealth,
    /// The ticket as the person saw it when they made the change.
    pub seen: &'a NotionRow,
    pub change: TicketChange,
}

/// Why a write was not even tried. No request was sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "why", content = "field", rename_all = "snake_case")]
pub enum WriteBlocked {
    ReadOnly,
    FieldsChanged,
    NotMapped(String),
    /// A new ticket needs a title.
    NoTitle,
}

/// What happened to a write that was tried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum WriteOutcome {
    /// Notion has the change. `row` is the ticket as Notion has it now.
    Saved { row: NotionRow },
    /// Someone changed this field since it was seen. Nothing was sent; `fresh` is Notion's version.
    Conflict { fresh: NotionRow },
    /// Notion refused it (403 `restricted_resource`, 400 `validation_error`, …): "Write refused" (S34).
    Refused { message: String },
    /// Notion answered 5xx, and reading the page again shows the change did not land. Not repeated.
    NotSaved { fresh: NotionRow, message: String },
    /// The PATCH went out, and whether Notion kept it could not be learned. Not repeated.
    Unknown { message: String },
}

pub async fn write_ticket(api: &NotionApi, request: WriteRequest<'_>) -> Result<WriteOutcome, WriteBlocked> {
    let WriteRequest { data_source_id, mapping, permission, health, seen, change } = request;
    if permission != Permission::Manage {
        return Err(WriteBlocked::ReadOnly);
    }
    if health.writes_paused() {
        return Err(WriteBlocked::FieldsChanged);
    }
    let Some(property) = change.property_id(mapping) else {
        return Err(WriteBlocked::NotMapped(change.field().into()));
    };
    Ok(match try_write(api, data_source_id, mapping, seen, &change, property).await {
        Ok(outcome) => outcome,
        Err(Stage::Before(error)) => WriteOutcome::Refused { message: redact(&error.to_string()) },
        Err(Stage::After(error)) => WriteOutcome::Unknown {
            message: format!(
                "Notion may have saved the change, but Lotus could not confirm it ({}). Reopen the ticket to see.",
                redact(&error.to_string())
            ),
        },
    })
}

/// Where a write stopped: before the PATCH was sent (nothing changed), or after (it may have).
enum Stage {
    Before(NotionError),
    After(NotionError),
}

async fn try_write(
    api: &NotionApi,
    data_source_id: &str,
    mapping: &FieldMapping,
    seen: &NotionRow,
    change: &TicketChange,
    property: &str,
) -> Result<WriteOutcome, Stage> {
    let page = api.page(&seen.page_id).await.map_err(Stage::Before)?;
    // The permission belongs to the source; the page must be in its database (checked on Notion's
    // own answer, not on what the caller says).
    if !same_id(page["parent"]["data_source_id"].as_str().unwrap_or_default(), data_source_id) {
        return Ok(WriteOutcome::Refused { message: "This page is not in this database.".into() });
    }
    let now = NotionRow::from_page(&page, mapping)
        .ok_or_else(|| Stage::Before(NotionError::Failed("Notion's page did not read as a ticket".into())))?;
    if !change.same_as(&now, seen) {
        return Ok(WriteOutcome::Conflict { fresh: now });
    }
    let (status, body) = match api.patch_page(&seen.page_id, json!({ "properties": { property: change.value() } })).await {
        Ok(answer) => answer,
        // Notion said no before doing anything: not saved.
        Err(error @ (NotionError::RateLimited { .. } | NotionError::Reconnect(_))) => return Err(Stage::Before(error)),
        // The request may have gone out: it may be saved.
        Err(error) => return Err(Stage::After(error)),
    };
    let after = |e| Stage::After(e);
    match status {
        200..=299 => Ok(match NotionRow::from_page(&body, mapping) {
            Some(row) => WriteOutcome::Saved { row },
            // Saved, but the answer did not read as a page: read it.
            None => WriteOutcome::Saved { row: read(api, mapping, &seen.page_id).await.map_err(after)? },
        }),
        500..=599 => {
            // Maybe saved (S33). Never repeated: read the page and say what it shows.
            let guidance = retry_guidance(&body);
            let fresh = read(api, mapping, &seen.page_id).await.map_err(after)?;
            Ok(if change.is_on(&fresh) {
                WriteOutcome::Saved { row: fresh }
            } else {
                let said = notion_message(&body.to_string()).unwrap_or_else(|| format!("HTTP {status}"));
                let message = [said, guidance].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
                WriteOutcome::NotSaved { fresh, message }
            })
        }
        _ => {
            let said = notion_message(&body.to_string()).unwrap_or_else(|| format!("HTTP {status}"));
            Ok(WriteOutcome::Refused { message: format!("Notion refused the change: {said}") })
        }
    }
}

/// Notion ids, with or without dashes, in any case.
fn same_id(a: &str, b: &str) -> bool {
    let plain = |id: &str| id.chars().filter(|c| *c != '-').collect::<String>().to_ascii_lowercase();
    !a.is_empty() && plain(a) == plain(b)
}

async fn read(api: &NotionApi, mapping: &FieldMapping, page_id: &str) -> Result<NotionRow, NotionError> {
    let page = api.page(page_id).await?;
    NotionRow::from_page(&page, mapping).ok_or_else(|| NotionError::Failed("Notion's page did not read as a ticket".into()))
}

/// `additional_data.retry_guidance`: a list of sentences, when Notion gives one.
fn retry_guidance(body: &Value) -> String {
    body["additional_data"]["retry_guidance"]
        .as_array()
        .map(|lines| lines.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// Moving a ticket to Notion's trash, or back out of it (PLAN S45–S46, task "Ticket Sources 14").
pub struct TrashRequest<'a> {
    /// The database the source reads. A page from any other is refused.
    pub data_source_id: &'a str,
    pub mapping: &'a FieldMapping,
    pub permission: Permission,
    pub health: &'a SourceHealth,
    pub page_id: &'a str,
    /// `true` moves it to trash; `false` is Undo.
    pub trash: bool,
}

/// `PATCH /v1/pages/{id}` with `in_trash` and nothing else — never a delete: Notion's API cannot
/// delete a page for good (reference/trash-page), and Lotus would not if it could. Only this page
/// moves; sub-tickets stay where they are (S46). The same checks as any write come first: Manage,
/// not during "Fields changed", and the page must be in this database. `Saved { row }` carries the
/// ticket as Notion has it, so Undo can put it back in the list.
pub async fn trash_ticket(api: &NotionApi, request: TrashRequest<'_>) -> Result<WriteOutcome, WriteBlocked> {
    let TrashRequest { data_source_id, mapping, permission, health, page_id, trash } = request;
    if permission != Permission::Manage {
        return Err(WriteBlocked::ReadOnly);
    }
    if health.writes_paused() {
        return Err(WriteBlocked::FieldsChanged);
    }
    Ok(match try_trash(api, data_source_id, mapping, page_id, trash).await {
        Ok(outcome) => outcome,
        Err(Stage::Before(error)) => WriteOutcome::Refused { message: redact(&error.to_string()) },
        Err(Stage::After(error)) => WriteOutcome::Unknown {
            message: format!(
                "Notion may have {} the ticket, but Lotus could not confirm it ({}). Check Notion's trash.",
                if trash { "trashed" } else { "restored" },
                redact(&error.to_string())
            ),
        },
    })
}

async fn try_trash(api: &NotionApi, data_source_id: &str, mapping: &FieldMapping, page_id: &str, trash: bool) -> Result<WriteOutcome, Stage> {
    let page = api.page(page_id).await.map_err(Stage::Before)?;
    if !same_id(page["parent"]["data_source_id"].as_str().unwrap_or_default(), data_source_id) {
        return Ok(WriteOutcome::Refused { message: "This page is not in this database.".into() });
    }
    let as_row = |page: &Value| {
        NotionRow::from_page(page, mapping).ok_or_else(|| Stage::After(NotionError::Failed("Notion's page did not read as a ticket".into())))
    };
    if page["in_trash"].as_bool() == Some(trash) {
        // Already where it was asked to go — by someone else, or by a first try whose answer was lost.
        return Ok(WriteOutcome::Saved { row: as_row(&page)? });
    }
    let (status, body) = match api.patch_page(page_id, json!({ "in_trash": trash })).await {
        Ok(answer) => answer,
        Err(error @ (NotionError::RateLimited { .. } | NotionError::Reconnect(_))) => return Err(Stage::Before(error)),
        Err(error) => return Err(Stage::After(error)),
    };
    match status {
        200..=299 => Ok(WriteOutcome::Saved { row: as_row(&body).or_else(|_| as_row(&page))? }),
        500..=599 => {
            // Maybe saved (S33): never repeated; the page says.
            let fresh = api.page(page_id).await.map_err(Stage::After)?;
            Ok(if fresh["in_trash"].as_bool() == Some(trash) {
                WriteOutcome::Saved { row: as_row(&fresh)? }
            } else {
                let said = notion_message(&body.to_string()).unwrap_or_else(|| format!("HTTP {status}"));
                let message = [said, retry_guidance(&body)].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ");
                WriteOutcome::NotSaved { fresh: as_row(&fresh)?, message }
            })
        }
        _ => {
            let said = notion_message(&body.to_string()).unwrap_or_else(|| format!("HTTP {status}"));
            Ok(WriteOutcome::Refused { message: format!("Notion refused the change: {said}") })
        }
    }
}

/// A new ticket, or a sub-ticket of `parent` (PLAN S47–S49, task "Ticket Sources 15").
pub struct CreateRequest<'a> {
    pub data_source_id: &'a str,
    pub mapping: &'a FieldMapping,
    pub permission: Permission,
    pub health: &'a SourceHealth,
    pub title: &'a str,
    /// The status option it starts in — the first of the To-do group (S47). `None` sets none.
    pub status: Option<&'a str>,
    /// The main ticket's page id, for a sub-ticket.
    pub parent: Option<&'a str>,
}

/// `POST /v1/pages` under this data source with the title, the starting status and, for a
/// sub-ticket, the Parent relation. The key (`unique_id`) is never sent: Notion assigns it and it
/// comes back in the answer (S22). The same gate as any write first. Sent once: after a 503 the new
/// page's id, when Notion gives it, is read instead of creating again (S33); without one the outcome
/// is `Unknown`, never a second POST.
pub async fn create_ticket(api: &NotionApi, request: CreateRequest<'_>) -> Result<WriteOutcome, WriteBlocked> {
    let CreateRequest { data_source_id, mapping, permission, health, title, status, parent } = request;
    if permission != Permission::Manage {
        return Err(WriteBlocked::ReadOnly);
    }
    if health.writes_paused() {
        return Err(WriteBlocked::FieldsChanged);
    }
    let title = title.trim();
    if title.is_empty() {
        return Err(WriteBlocked::NoTitle);
    }
    let Some(title_id) = mapping.title.as_deref() else {
        return Err(WriteBlocked::NotMapped("title".into()));
    };
    let mut properties = serde_json::Map::new();
    properties.insert(title_id.into(), TicketChange::Title(title.into()).value());
    if let (Some(status_id), Some(option)) = (mapping.status.as_deref(), status) {
        properties.insert(status_id.into(), TicketChange::Status(option.into()).value());
    }
    if let Some(parent) = parent {
        let Some(parent_id) = mapping.parent.as_deref() else {
            return Err(WriteBlocked::NotMapped("parent".into()));
        };
        properties.insert(parent_id.into(), json!({ "relation": [{ "id": parent }] }));
    }
    let body = json!({ "parent": { "type": "data_source_id", "data_source_id": data_source_id }, "properties": properties });

    let as_row = |page: &Value| NotionRow::from_page(page, mapping);
    let unknown = |why: String| WriteOutcome::Unknown {
        message: format!("Notion may have created the ticket, but Lotus could not confirm it ({why}). Refresh before adding it again."),
    };
    let (status, answer) = match api.post_page(body).await {
        Ok(answer) => answer,
        Err(error @ (NotionError::RateLimited { .. } | NotionError::Reconnect(_))) => {
            return Ok(WriteOutcome::Refused { message: redact(&error.to_string()) })
        }
        Err(error) => return Ok(unknown(redact(&error.to_string()))),
    };
    Ok(match status {
        200..=299 => match as_row(&answer) {
            Some(row) => WriteOutcome::Saved { row },
            None => unknown("its answer did not read as a ticket".into()),
        },
        500..=599 => match answer["additional_data"]["committed_resource_id"].as_str() {
            // Created: read it by the id Notion named.
            Some(id) => match api.page(id).await.ok().as_ref().and_then(as_row) {
                Some(row) => WriteOutcome::Saved { row },
                None => unknown(format!("it named page {id}, which could not be read")),
            },
            None => unknown(notion_message(&answer.to_string()).unwrap_or_else(|| format!("HTTP {status}"))),
        },
        _ => {
            let said = notion_message(&answer.to_string()).unwrap_or_else(|| format!("HTTP {status}"));
            WriteOutcome::Refused { message: format!("Notion refused the new ticket: {said}") }
        }
    })
}
