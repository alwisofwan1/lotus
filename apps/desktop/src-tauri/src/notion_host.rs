//! Notion in Connectors, on the Tauri side (plans/ticket-sources PLAN §2.2,
//! task "Ticket Sources 03").
//!
//! The token checks and the REST client are in the crate
//! (`lotus_automation::notion`); this file keeps the connection. The token goes
//! to the same secret store as Slack's and Google's. Who it acts as — no
//! secret — is kept in a plain file, so drawing Connectors never reads the
//! keychain. Its own app state rather than part of the automation runtime:
//! ticket sources in Tasks use it, and they must work when automations do not.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lotus_automation::notion::account::{forget_notion_token, load_notion_token, save_notion_token, NotionAccountSummary};
use lotus_automation::notion::api::{NotionApi, PageMarkdown};
use lotus_automation::notion::schema::{DataSourceSchema, DataSourceSummary, FieldMapping};
use lotus_automation::notion::sync::{sync_source, write_health, LostAccess, SourceCopy, SourceHealth, SyncRequest, Synced};
use lotus_automation::notion::body::{write_body, BodyBlocked, BodyOutcome, BodyRequest};
use lotus_automation::notion::rows::NotionRow;
use lotus_automation::notion::token::NotionToken;
use lotus_automation::notion::write::{create_ticket, trash_ticket, write_ticket, CreateRequest, Permission, TicketChange, TrashRequest, WriteBlocked, WriteOutcome, WriteRequest};
use lotus_automation::notion::NOTION_API;
use lotus_automation::secrets::{redact, SecretStore};
use lotus_automation::{Clock, SystemClock};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::automation_host::CHANGED_EVENT;
use crate::paths;

/// The Notion line in Connectors. Never carries a token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionStatusView {
    /// `not_connected` | `connected`
    pub state: String,
    /// `personal` | `integration`, once connected.
    pub kind: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub workspace: Option<String>,
    pub connected_at_ms: Option<i64>,
}

impl NotionStatusView {
    fn not_connected() -> Self {
        Self { state: "not_connected".into(), kind: None, name: None, email: None, workspace: None, connected_at_ms: None }
    }

    fn from_summary(s: NotionAccountSummary) -> Self {
        Self {
            state: "connected".into(),
            kind: Some(s.kind),
            name: s.name,
            email: s.email,
            workspace: s.workspace,
            connected_at_ms: Some(s.connected_at_ms),
        }
    }
}

/// A database's schema, and the fields Lotus would read from it (PLAN S18).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DescribedSource {
    pub schema: DataSourceSchema,
    pub mapping: FieldMapping,
}

/// A ticket source after a sync: its rows — the last good copy whenever Notion could not be read, so
/// a source that fails never empties the list (PLAN S28) — and the state it is in (S40).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSync {
    #[serde(flatten)]
    pub copy: SourceCopy,
    pub health: SourceHealth,
}

fn account_file() -> std::path::PathBuf {
    paths::lotus_state_dir().join("notion-account.json")
}

/// The last good copy of one source's rows — Notion's and GitHub's alike. The id is Lotus's own, but it is still checked before it
/// becomes a file name.
pub(crate) fn cache_file(source_id: &str) -> Result<std::path::PathBuf, String> {
    if source_id.is_empty() || source_id.len() > 80 || !source_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("{source_id:?} is not a ticket source id"));
    }
    Ok(paths::lotus_state_dir().join("ticket-sources").join(format!("{source_id}.json")))
}

/// A Notion ticket for a Factory Run (#168): `properties` are `(name, value)`, sorted by name.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionTicketText {
    pub title: String,
    pub url: String,
    pub properties: Vec<(String, String)>,
    pub markdown: String,
    pub truncated: bool,
}

pub struct NotionHost {
    secrets: Box<dyn SecretStore>,
    /// Per source, when Notion said it may be asked again after a 429. In memory: after a restart
    /// the next sync asks once and learns it again.
    slowed_until: Mutex<HashMap<String, i64>>,
    /// Per source, the health its last sync left — what a write is checked against (S42).
    last_health: Mutex<HashMap<String, SourceHealth>>,
    /// Per source, held while its kept copy is read, changed and written back. A sync holds it
    /// across its request — it reads the copy before and writes it after — so a trash or a write
    /// that lands meanwhile is applied after the sync, never overwritten by it.
    copy_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl NotionHost {
    pub fn new() -> Self {
        Self { secrets: crate::automation_slack::secret_store(), slowed_until: Mutex::default(), last_health: Mutex::default(), copy_locks: Mutex::default() }
    }

    pub fn status(&self) -> NotionStatusView {
        match read_summary() {
            Some(summary) => NotionStatusView::from_summary(summary),
            None => NotionStatusView::not_connected(),
        }
    }

    /// Checks the pasted token with Notion (`users/me`) and keeps it only if Notion accepted it.
    pub async fn connect(&self, app: &AppHandle, pasted: &str) -> Result<NotionStatusView, String> {
        let token = NotionToken::parse(pasted)?;
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default();
        let identity = NotionApi::new(http, NOTION_API, token.clone()).me().await.map_err(|e| redact(&e.to_string()))?;
        save_notion_token(self.secrets.as_ref(), &token)?;
        write_summary(&NotionAccountSummary::new(&identity, SystemClock.now_ms()))?;
        let _ = app.emit(CHANGED_EVENT, ());
        Ok(self.status())
    }

    /// The API as the connected token. The keychain is read here, when Notion is actually used.
    fn api(&self) -> Result<NotionApi, String> {
        let token = load_notion_token(self.secrets.as_ref())?.ok_or("Notion is not connected; connect it in Connectors")?;
        let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap_or_default();
        Ok(NotionApi::new(http, NOTION_API, token))
    }

    pub async fn search(&self, query: &str) -> Result<Vec<DataSourceSummary>, String> {
        self.api()?.search_data_sources(query).await.map_err(|e| redact(&e.to_string()))
    }

    pub async fn describe(&self, data_source_id: &str) -> Result<DescribedSource, String> {
        let schema = self.api()?.data_source(data_source_id).await.map_err(|e| redact(&e.to_string()))?;
        let mapping = schema.suggest_mapping();
        Ok(DescribedSource { schema, mapping })
    }

    /// Syncs one source (PLAN S24–S28): the rows edited since the last sync, or every row when the
    /// copy is due a full re-read or `full` asks for one (the source was just opened). What worked
    /// is kept as the source's last good copy; what did not leaves that copy as it was.
    pub async fn sync_source(&self, source_id: &str, data_source_id: &str, mapping: &FieldMapping, full: bool) -> Result<SourceSync, String> {
        let path = cache_file(source_id)?;
        let lock = self.copy_lock(source_id);
        let _held = lock.lock().await;
        let kept = kept_copy(source_id);
        let now = SystemClock.now_ms();
        let mut request = SyncRequest::at(now);
        if full {
            request = request.full();
        }
        if let Some(&retry_at) = self.slowed().get(source_id) {
            request = request.not_before(retry_at);
        }
        let synced = match self.api() {
            Ok(api) => sync_source(&api, data_source_id, mapping, kept, request).await,
            // No token kept: the same state as one Notion no longer accepts.
            Err(_) => Synced {
                copy: kept.unwrap_or_default(),
                health: SourceHealth::LostAccess { why: LostAccess::Token },
                full: false,
                requests: 0,
            },
        };
        match synced.health {
            SourceHealth::SlowedDown { retry_at_ms } => self.slowed().insert(source_id.to_string(), retry_at_ms),
            _ => self.slowed().remove(source_id),
        };
        self.last_health.lock().unwrap_or_else(|p| p.into_inner()).insert(source_id.to_string(), synced.health.clone());
        if synced.requests > 0 {
            // One line per sync, for measuring what polling costs (task 05 ac7).
            eprintln!(
                "[notion] sync {source_id}: {} · {} request(s) · {} row(s) · {:?}",
                if synced.full { "full" } else { "incremental" },
                synced.requests,
                synced.copy.rows.len(),
                synced.health
            );
        }
        // The rows were read — also when a field stopped fitting, since the list still shows them.
        if matches!(synced.health, SourceHealth::Healthy | SourceHealth::FieldsChanged { .. }) {
            if let Err(e) = write_json(&path, &synced.copy) {
                // The rows are good; failing to keep a copy only costs the offline view.
                eprintln!("[notion] could not keep a copy of {source_id}: {e}");
            }
        }
        Ok(SourceSync { copy: synced.copy, health: synced.health })
    }

    fn copy_lock(&self, source_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.copy_locks.lock().unwrap_or_else(|p| p.into_inner()).entry(source_id.to_string()).or_default().clone()
    }

    fn slowed(&self) -> std::sync::MutexGuard<'_, HashMap<String, i64>> {
        self.slowed_until.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Changes one field of a ticket in Notion (task "Ticket Sources 09"). What Lotus may change is
    /// read HERE, from the source as settings keep it — never taken from the caller — and the source's
    /// health is the one its last sync left. The crate refuses before any request when either says no.
    pub async fn write_ticket(&self, source_id: &str, change: TicketChange, seen: NotionRow) -> Result<WriteOutcome, String> {
        let source = notion_source_settings(source_id)?;
        let health = self.health_of(source_id, &source.mapping);
        let api = self.api()?;
        let request = WriteRequest {
            data_source_id: &source.data_source_id,
            mapping: &source.mapping,
            permission: source.permission,
            health: &health,
            seen: &seen,
            change,
        };
        let outcome = match write_ticket(&api, request).await {
            Ok(outcome) => outcome,
            Err(blocked) => WriteOutcome::Refused { message: blocked_message(&blocked) },
        };
        // What Notion has now goes into the kept copy too, so the list shows it before the next sync.
        if let WriteOutcome::Saved { row } | WriteOutcome::Conflict { fresh: row } | WriteOutcome::NotSaved { fresh: row, .. } = &outcome {
            let lock = self.copy_lock(source_id);
            let _held = lock.lock().await;
            self.keep_row(source_id, row);
        }
        eprintln!("[notion] write {source_id}: {}", outcome_word(&outcome));
        Ok(outcome)
    }

    /// Moves a ticket to Notion's trash (`trash`), or back (Undo). Same checks as `write_ticket`: the
    /// permission and database come from settings, never from the caller.
    pub async fn trash_ticket(&self, source_id: &str, page_id: &str, trash: bool) -> Result<WriteOutcome, String> {
        let source = notion_source_settings(source_id)?;
        let health = self.health_of(source_id, &source.mapping);
        let api = self.api()?;
        let request = TrashRequest {
            data_source_id: &source.data_source_id,
            mapping: &source.mapping,
            permission: source.permission,
            health: &health,
            page_id,
            trash,
        };
        let outcome = match trash_ticket(&api, request).await {
            Ok(outcome) => outcome,
            Err(blocked) => WriteOutcome::Refused { message: blocked_message(&blocked) },
        };
        // The kept copy follows at once, so the list does not wait for the next full read (S45).
        if let WriteOutcome::Saved { row } = &outcome {
            let lock = self.copy_lock(source_id);
            let _held = lock.lock().await;
            self.keep_in_copy(source_id, row, !trash);
        }
        eprintln!("[notion] {} {source_id}: {}", if trash { "trash" } else { "restore" }, outcome_word(&outcome));
        Ok(outcome)
    }

    /// Creates a ticket — a sub-ticket of `parent` when given — in the source's database (S47–S49).
    /// It starts in the first To-do status of the fields last read. Same checks as every write.
    pub async fn create_ticket(&self, source_id: &str, title: &str, parent: Option<&str>) -> Result<WriteOutcome, String> {
        let source = notion_source_settings(source_id)?;
        // The main ticket comes from the caller: it must be a ticket on THIS board, as last read.
        if let Some(parent) = parent {
            if !kept_copy(source_id).is_some_and(|copy| copy.rows.iter().any(|row| row.page_id == parent)) {
                return Ok(WriteOutcome::Refused { message: "The main ticket is not on this board. Refresh and open it again.".into() });
            }
        }
        let health = self.health_of(source_id, &source.mapping);
        let status = kept_copy(source_id).and_then(|copy| copy.schema).and_then(|schema| schema.first_to_do(&source.mapping));
        let api = self.api()?;
        let request = CreateRequest {
            data_source_id: &source.data_source_id,
            mapping: &source.mapping,
            permission: source.permission,
            health: &health,
            title,
            status: status.as_deref(),
            parent,
        };
        let outcome = match create_ticket(&api, request).await {
            Ok(outcome) => outcome,
            Err(blocked) => WriteOutcome::Refused { message: blocked_message(&blocked) },
        };
        if let WriteOutcome::Saved { row } = &outcome {
            let lock = self.copy_lock(source_id);
            let _held = lock.lock().await;
            self.keep_in_copy(source_id, row, true);
        }
        eprintln!("[notion] create {source_id}: {}", outcome_word(&outcome));
        Ok(outcome)
    }

    /// Saves an edited page body (S43–S44): only the changed pieces, and only when the page is still
    /// what `seen` says. The permission comes from settings; the page must be on this board.
    pub async fn write_body(&self, source_id: &str, page_id: &str, seen: &str, markdown: &str) -> Result<BodyOutcome, String> {
        let source = notion_source_settings(source_id)?;
        if !kept_copy(source_id).is_some_and(|copy| copy.rows.iter().any(|row| row.page_id == page_id)) {
            return Ok(BodyOutcome::Refused { message: "This page is not on this board. Refresh and open it again.".into() });
        }
        let health = self.health_of(source_id, &source.mapping);
        let api = self.api()?;
        let request = BodyRequest { page_id, permission: source.permission, health: &health, seen, markdown };
        let outcome = match write_body(&api, request).await {
            Ok(outcome) => outcome,
            Err(blocked) => BodyOutcome::Refused {
                message: match blocked {
                    BodyBlocked::ReadOnly => "This database is Read only in Lotus. Set it to Manage to change tickets here.".into(),
                    BodyBlocked::FieldsChanged => "Changes are paused until the fields are remapped.".into(),
                    BodyBlocked::NotEditable => "This page has blocks Lotus cannot show. Edit its body in Notion.".into(),
                    BodyBlocked::Empty => "This page has no body yet. Add the first lines in Notion.".into(),
                },
            },
        };
        eprintln!(
            "[notion] body {source_id}: {}",
            match &outcome {
                BodyOutcome::Saved { .. } => "saved",
                BodyOutcome::Conflict { .. } => "conflict (changed in Notion since it was opened)",
                BodyOutcome::Refused { .. } => "refused",
                BodyOutcome::NotSaved { .. } => "not saved (not repeated)",
                BodyOutcome::Unknown { .. } => "unknown (sent, could not confirm; not repeated)",
            }
        );
        Ok(outcome)
    }

    /// `row` put in (`present`) or taken out of the source's kept copy.
    fn keep_in_copy(&self, source_id: &str, row: &NotionRow, present: bool) {
        let (Ok(path), Some(mut copy)) = (cache_file(source_id), kept_copy(source_id)) else { return };
        copy.rows.retain(|r| r.page_id != row.page_id);
        if present {
            copy.rows.push(row.clone());
        }
        if let Err(e) = write_json(&path, &copy) {
            eprintln!("[notion] could not keep a copy of {source_id}: {e}");
        }
    }

    /// The health a write is checked against: a pause from the last sync, or from the kept fields.
    fn health_of(&self, source_id: &str, mapping: &FieldMapping) -> SourceHealth {
        let last = self.last_health.lock().unwrap_or_else(|p| p.into_inner()).get(source_id).cloned();
        write_health(last.as_ref(), kept_copy(source_id).as_ref(), mapping)
    }

    fn keep_row(&self, source_id: &str, row: &NotionRow) {
        let (Ok(path), Some(mut copy)) = (cache_file(source_id), kept_copy(source_id)) else { return };
        match copy.rows.iter_mut().find(|r| r.page_id == row.page_id) {
            Some(old) => *old = row.clone(),
            None => return,
        }
        if let Err(e) = write_json(&path, &copy) {
            eprintln!("[notion] could not keep a copy of {source_id}: {e}");
        }
    }

    /// A ticket's page body, read when it is opened.
    pub async fn page_markdown(&self, page_id: &str) -> Result<PageMarkdown, String> {
        self.api()?.page_markdown(page_id).await.map_err(|e| redact(&e.to_string()))
    }

    /// A ticket as a Factory Run reads it (#168): its title, link, every property and its body.
    /// Read only; the run keeps this text, so a later edit in Notion does not change a run.
    pub async fn ticket_text(&self, page_id: &str) -> Result<NotionTicketText, String> {
        let api = self.api()?;
        let page = api.page(page_id).await.map_err(|e| redact(&e.to_string()))?;
        let body = api.page_markdown(page_id).await.map_err(|e| redact(&e.to_string()))?;
        let title = page["properties"]
            .as_object()
            .and_then(|props| props.values().find(|v| v["type"] == "title"))
            .and_then(|v| v["title"].as_array())
            .map(|items| items.iter().filter_map(|t| t["plain_text"].as_str()).collect::<String>())
            .unwrap_or_default();
        Ok(NotionTicketText {
            title: title.trim().to_string(),
            url: page["url"].as_str().unwrap_or_default().to_string(),
            properties: lotus_automation::notion::rows::property_lines(&page),
            markdown: body.markdown,
            truncated: body.truncated,
        })
    }

    /// `lotus_notion_read` (ADR-0052 §4): a PR review agent reads a ticket or spec by its link, its
    /// page id, or its key (`TKT-1234`, found in the synced databases' kept copies). Read only, with
    /// the connected token, which never leaves Lotus.
    pub async fn read_for_review(&self, reference: &str) -> Result<String, String> {
        use lotus_automation::notion::reference::{page_for_key, parse_ref, render_page, NotionRef};
        let page_id = match parse_ref(reference)? {
            NotionRef::Page(id) => id,
            NotionRef::Key(key) => page_for_key(&kept_copies(), &key)?,
        };
        let ticket = self.ticket_text(&page_id).await?;
        Ok(render_page(&ticket.title, &ticket.url, &ticket.properties, &ticket.markdown, ticket.truncated))
    }

    /// A page's `last_edited_time`, read BEFORE its body on a pull (PLAN S38): the body read after it
    /// holds at least that version, so a note stamped with it is never stamped newer than it is.
    pub async fn page_edited_time(&self, page_id: &str) -> Result<String, String> {
        let page = self.api()?.page(page_id).await.map_err(|e| redact(&e.to_string()))?;
        page["last_edited_time"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| "Notion's answer had no last_edited_time".to_string())
    }

    /// Removes a source's kept copy, when the source itself is removed.
    pub fn forget_source(&self, source_id: &str) -> Result<(), String> {
        match std::fs::remove_file(cache_file(source_id)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Forgets the token here. The token itself stays valid at Notion until it is revoked there.
    pub fn disconnect(&self, app: &AppHandle) -> Result<(), String> {
        forget_notion_token(self.secrets.as_ref())?;
        match std::fs::remove_file(account_file()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", account_file().display())),
        }
        let _ = app.emit(CHANGED_EVENT, ());
        Ok(())
    }
}

/// The kept copy of every synced Notion database (GitHub sources sit beside them; skipped).
fn kept_copies() -> Vec<SourceCopy> {
    let Ok(entries) = std::fs::read_dir(paths::lotus_state_dir().join("ticket-sources")) else { return vec![] };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("notion-") && n.ends_with(".json")))
        .filter_map(|p| serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok())
        .collect()
}

fn kept_copy(source_id: &str) -> Option<SourceCopy> {
    serde_json::from_str(&std::fs::read_to_string(cache_file(source_id).ok()?).ok()?).ok()
}

/// A Notion source as `~/.claude/settings.json` keeps it under `ticketSources` — the one place its
/// permission is decided (`ticket-source-settings.ts` writes it).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotionSourceSettings {
    data_source_id: String,
    mapping: FieldMapping,
    #[serde(default)]
    permission: Permission,
}

fn notion_source_settings(source_id: &str) -> Result<NotionSourceSettings, String> {
    let path = paths::claude_dir().join("settings.json");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let settings: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let entry = settings["ticketSources"]
        .as_array()
        .and_then(|sources| sources.iter().find(|s| s["kind"] == "notion" && s["id"] == source_id))
        .ok_or_else(|| format!("{source_id} is not a Notion ticket source"))?;
    serde_json::from_value(entry.clone()).map_err(|e| format!("{source_id}: {e}"))
}

fn blocked_message(blocked: &WriteBlocked) -> String {
    match blocked {
        WriteBlocked::ReadOnly => "This database is Read only in Lotus. Set it to Manage to change tickets here.".into(),
        WriteBlocked::FieldsChanged => "Changes are paused until the fields are remapped.".into(),
        WriteBlocked::NotMapped(field) => format!("No Notion field is mapped to {field}."),
        WriteBlocked::NoTitle => "A new ticket needs a title.".into(),
    }
}

fn outcome_word(outcome: &WriteOutcome) -> &'static str {
    match outcome {
        WriteOutcome::Saved { .. } => "saved",
        WriteOutcome::Conflict { .. } => "conflict (changed in Notion since it was seen)",
        WriteOutcome::Refused { .. } => "refused",
        WriteOutcome::NotSaved { .. } => "not saved (5xx, not repeated)",
        WriteOutcome::Unknown { .. } => "unknown (sent, could not confirm; not repeated)",
    }
}

fn read_summary() -> Option<NotionAccountSummary> {
    serde_json::from_str(&std::fs::read_to_string(account_file()).ok()?).ok()
}

fn write_summary(summary: &NotionAccountSummary) -> Result<(), String> {
    write_json(&account_file(), summary)
}

pub(crate) fn write_json<T: Serialize>(path: &std::path::Path, value: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, serde_json::to_string(value).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))
}
