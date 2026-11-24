//! Notion's REST API, as the token's owner. Every request carries
//! `Authorization: Bearer <token>` and the pinned [`NOTION_VERSION`], waits out
//! one 429/5xx by the crate's one rate-limit rule (`ratelimit`: once, never
//! longer than [`MAX_WAIT`]), and turns a 401 into
//! [`NotionError::Reconnect`] — Notion answers an expired or revoked token
//! with `unauthorized` (research/notion-connector.md §8).

use std::collections::HashSet;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::rows::NotionRow;
use super::schema::{plain_text, DataSourceSchema, DataSourceSummary, FieldMapping};
use super::token::NotionToken;
use super::{NotionError, NOTION_VERSION};
use crate::ratelimit::{Attempt, MAX_WAIT};

/// Wait before retrying a 429/5xx that gave no `Retry-After`.
const DEFAULT_WAIT: Duration = Duration::from_secs(2);
/// Notion's largest page of results.
const PAGE_SIZE: u64 = 100;
/// A data source's rows, read in `created_time` order, restart from the last
/// one seen whenever a query hits Notion's 10,000-result cap (PLAN S26). This
/// many restarts is far more than any real board needs, and stops a loop if
/// Notion ever kept reporting the cap without moving forward.
const MAX_RESTARTS: usize = 50;

/// A page's body as Notion's markdown (PLAN S30–S31). Notion's own markup —
/// `<callout>`, `<details>`, `<unknown …/>` — is left in; the reader turns it
/// into plain markdown, and never renders any of it as HTML.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMarkdown {
    pub markdown: String,
    /// The page is over Notion's ~20,000-block limit, or some blocks could not be read.
    pub truncated: bool,
    /// Blocks the markdown could not express, shown as `<unknown …/>`.
    pub unknown_block_ids: Vec<String>,
}

/// Every row of a data source, and whether Notion let Lotus see them all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowsRead {
    pub rows: Vec<NotionRow>,
    /// False when the restarts ran out before the last row was read.
    pub complete: bool,
    /// False when some page no longer carries a mapped property with its type (PLAN S19).
    pub fits: bool,
}

/// Who a token acts as, from `GET /v1/users/me`.
///
/// A personal access token is a person, with a name and an email, and Notion
/// says nothing about its workspace. An integration token is a bot, and does
/// name its workspace (https://developers.notion.com/reference/get-self).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotionIdentity {
    Person { name: Option<String>, email: Option<String> },
    Integration { name: Option<String>, workspace: Option<String> },
}

#[derive(Clone)]
pub struct NotionApi {
    http: reqwest::Client,
    base: String,
    token: NotionToken,
    /// Longest rate limit slept through before answering [`NotionError::RateLimited`].
    max_wait: Duration,
    /// Requests sent through this API and its copies, for measuring what a sync costs (S27).
    sent: Arc<AtomicU32>,
}

impl NotionApi {
    /// `base` is [`super::NOTION_API`] in the app, a fake server in tests.
    pub fn new(http: reqwest::Client, base: &str, token: NotionToken) -> Self {
        Self { http, base: base.trim_end_matches('/').to_string(), token, max_wait: MAX_WAIT, sent: Arc::default() }
    }

    /// How many requests have been sent so far.
    pub fn requests_sent(&self) -> u32 {
        self.sent.load(Ordering::Relaxed)
    }

    /// This API, answering a rate limit at once instead of sleeping through it. A sync waits by not
    /// asking again until then, so it never holds a request open for a minute (PLAN S27).
    pub fn never_waiting(&self) -> Self {
        Self { max_wait: Duration::ZERO, ..self.clone() }
    }

    /// Data sources the token can see whose title matches `query` (empty = all),
    /// for "Add a Notion database" (PLAN S17). One page of results is enough
    /// for a picker; typing narrows it.
    pub async fn search_data_sources(&self, query: &str) -> Result<Vec<DataSourceSummary>, NotionError> {
        let mut body = json!({
            "filter": { "property": "object", "value": "data_source" },
            "page_size": PAGE_SIZE,
        });
        if !query.trim().is_empty() {
            body["query"] = json!(query.trim());
        }
        let found = self.send("search your databases", reqwest::Method::POST, "/v1/search", Some(body)).await?;
        Ok(found["results"]
            .as_array()
            .map(|results| {
                results
                    .iter()
                    .filter(|r| r["object"].as_str() == Some("data_source") && r["in_trash"].as_bool() != Some(true))
                    .filter_map(|r| {
                        Some(DataSourceSummary {
                            id: r["id"].as_str()?.to_string(),
                            title: plain_text(&r["title"]),
                            url: r["url"].as_str().map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// A data source's properties, with its status options and groups.
    pub async fn data_source(&self, id: &str) -> Result<DataSourceSchema, NotionError> {
        let path = format!("/v1/data_sources/{}", segment(id)?);
        let v = self.send("read the database's fields", reqwest::Method::GET, &path, None).await?;
        DataSourceSchema::from_json(&v).map_err(NotionError::Failed)
    }

    /// Every row of a data source, as tickets through `mapping`.
    ///
    /// Sorted by `created_time` so a query stopped by the 10,000 cap can go on
    /// from the last row it saw (`created_time` on or after it); rows seen twice
    /// at that boundary are kept once.
    pub async fn read_rows(&self, id: &str, mapping: &FieldMapping) -> Result<RowsRead, NotionError> {
        self.query_rows(id, mapping, None).await
    }

    /// The rows edited on or after `since` (an ISO 8601 time), for an incremental sync (PLAN S24).
    /// Notion rounds `last_edited_time` down to the minute, so the caller widens the window.
    pub async fn read_rows_edited_since(&self, id: &str, mapping: &FieldMapping, since: &str) -> Result<RowsRead, NotionError> {
        let edited = json!({ "timestamp": "last_edited_time", "last_edited_time": { "on_or_after": since } });
        self.query_rows(id, mapping, Some(edited)).await
    }

    async fn query_rows(&self, id: &str, mapping: &FieldMapping, only: Option<Value>) -> Result<RowsRead, NotionError> {
        let path = format!("/v1/data_sources/{}/query", segment(id)?);
        let mut rows = Vec::new();
        let mut seen = HashSet::new();
        let mut fits = true;
        let mut from: Option<String> = None;

        for _ in 0..MAX_RESTARTS {
            let mut cursor: Option<String> = None;
            let mut capped = false;
            loop {
                let mut body = json!({
                    "page_size": PAGE_SIZE,
                    "sorts": [{ "timestamp": "created_time", "direction": "ascending" }],
                });
                let restart = from.as_ref().map(|from| json!({ "timestamp": "created_time", "created_time": { "on_or_after": from } }));
                match (&only, restart) {
                    (Some(only), Some(restart)) => body["filter"] = json!({ "and": [only, restart] }),
                    (Some(filter), None) => body["filter"] = filter.clone(),
                    (None, Some(filter)) => body["filter"] = filter,
                    (None, None) => {}
                }
                if let Some(cursor) = &cursor {
                    body["start_cursor"] = json!(cursor);
                }
                let page = self.send("read the database's tickets", reqwest::Method::POST, &path, Some(body)).await?;
                for result in page["results"].as_array().into_iter().flatten() {
                    if result["object"].as_str() != Some("page") {
                        continue;
                    }
                    fits &= mapping.fits_page(result);
                    if let Some(row) = NotionRow::from_page(result, mapping) {
                        if seen.insert(row.page_id.clone()) {
                            rows.push(row);
                        }
                    }
                }
                if page["request_status"]["incomplete_reason"].as_str() == Some("query_result_limit_reached") {
                    capped = true;
                    break;
                }
                match page["next_cursor"].as_str() {
                    Some(next) if page["has_more"].as_bool() == Some(true) => cursor = Some(next.to_string()),
                    _ => break,
                }
            }
            if !capped {
                return Ok(RowsRead { rows, complete: true, fits });
            }
            let last = rows.last().map(|r| r.created_time.clone()).filter(|t| !t.is_empty());
            if last.is_none() || last == from {
                // No progress since the last restart: stop rather than ask the same question forever.
                break;
            }
            from = last;
        }
        Ok(RowsRead { rows, complete: false, fits })
    }

    /// A page's body, read when a ticket is opened (never kept with the list).
    pub async fn page_markdown(&self, page_id: &str) -> Result<PageMarkdown, NotionError> {
        let path = format!("/v1/pages/{}/markdown", segment(page_id)?);
        let v = self.send("read the ticket's page", reqwest::Method::GET, &path, None).await?;
        Ok(PageMarkdown {
            markdown: v["markdown"].as_str().unwrap_or_default().to_string(),
            truncated: v["truncated"].as_bool().unwrap_or(false),
            unknown_block_ids: v["unknown_block_ids"]
                .as_array()
                .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        })
    }

    /// Who this token acts as. The call Connect makes to prove a token works.
    pub async fn me(&self) -> Result<NotionIdentity, NotionError> {
        let user = self.send("read who the token acts as", reqwest::Method::GET, "/v1/users/me", None).await?;
        let name = text(&user["name"]);
        match user["type"].as_str() {
            Some("person") => Ok(NotionIdentity::Person { name, email: text(&user["person"]["email"]) }),
            Some("bot") => Ok(NotionIdentity::Integration { name, workspace: text(&user["bot"]["workspace_name"]) }),
            _ => Err(NotionError::Failed("Notion answered with a user Lotus does not recognise".into())),
        }
    }

    async fn send(&self, what: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, NotionError> {
        let (status, body) = self.answer(what, method, path, body).await?;
        match status {
            200..=299 => serde_json::from_str(&body).map_err(|_| NotionError::Failed(format!("{what}: Notion's reply was unreadable"))),
            404 => Err(NotionError::NotFound(format!(
                "{what}: Notion cannot find it, or this token cannot see it. It may have been moved to trash or unshared"
            ))),
            401 => Err(NotionError::Reconnect(
                "Notion did not accept this token: it is wrong, expired or revoked. Make a new one and connect again".into(),
            )),
            _ => {
                let detail = notion_message(&body).unwrap_or_else(|| format!("HTTP {status}"));
                Err(NotionError::Failed(format!("{what}: Notion said {detail}")))
            }
        }
    }

    /// Notion's answer, whatever its status: a 429 (and, when waiting is allowed, a 5xx) is waited
    /// out once by the crate's rule; everything else comes back as it is.
    async fn answer(&self, what: &str, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<(u16, String), NotionError> {
        let mut attempt = 0;
        loop {
            attempt += 1;
            match self.attempt(what, &method, path, &body).await? {
                Attempt::Done(reply) => return Ok(reply),
                Attempt::Wait(wait) if wait > self.max_wait || attempt > 1 => {
                    let message = format!("{what}: Notion asked Lotus to slow down; try again in {} s", wait.as_secs());
                    return Err(NotionError::RateLimited { retry_after: wait, message });
                }
                Attempt::Wait(wait) => tokio::time::sleep(wait).await,
            }
        }
    }

    /// A page as Notion has it now, before a write compares it with what the person saw (S32).
    pub async fn page(&self, page_id: &str) -> Result<Value, NotionError> {
        let path = format!("/v1/pages/{}", segment(page_id)?);
        self.send("read the ticket", reqwest::Method::GET, &path, None).await
    }

    /// `PATCH /v1/pages/{id}`, sent ONCE: never retried on a 5xx, because a write that answered 503
    /// may already be saved (research: "Retry a write that returns 503"). The status and body come
    /// back as Notion sent them, for the caller to read `additional_data.retry_guidance`.
    pub async fn patch_page(&self, page_id: &str, body: Value) -> Result<(u16, Value), NotionError> {
        let path = format!("/v1/pages/{}", segment(page_id)?);
        let (status, text) = self.never_waiting().answer("change the ticket", reqwest::Method::PATCH, &path, Some(body)).await?;
        if status == 401 {
            return Err(NotionError::Reconnect(
                "Notion did not accept this token: it is wrong, expired or revoked. Make a new one and connect again".into(),
            ));
        }
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// `PATCH /v1/pages/{id}/markdown`, sent ONCE (a 5xx may be saved): the status and body as sent.
    pub async fn patch_markdown(&self, page_id: &str, body: Value) -> Result<(u16, Value), NotionError> {
        let path = format!("/v1/pages/{}/markdown", segment(page_id)?);
        let (status, text) = self.never_waiting().answer("change the ticket's page", reqwest::Method::PATCH, &path, Some(body)).await?;
        if status == 401 {
            return Err(NotionError::Reconnect(
                "Notion did not accept this token: it is wrong, expired or revoked. Make a new one and connect again".into(),
            ));
        }
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// `POST /v1/pages`, sent ONCE, like [`Self::patch_page`]: a create is not idempotent, and one
    /// that answered 503 may already exist (its id is then in `additional_data.committed_resource_id`).
    pub async fn post_page(&self, body: Value) -> Result<(u16, Value), NotionError> {
        let (status, text) = self.never_waiting().answer("create the ticket", reqwest::Method::POST, "/v1/pages", Some(body)).await?;
        if status == 401 {
            return Err(NotionError::Reconnect(
                "Notion did not accept this token: it is wrong, expired or revoked. Make a new one and connect again".into(),
            ));
        }
        Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
    }

    /// One request. A 429 or 5xx asks to come back later: `Retry-After`, or [`DEFAULT_WAIT`].
    async fn attempt(&self, what: &str, method: &reqwest::Method, path: &str, body: &Option<Value>) -> Result<Attempt<(u16, String)>, NotionError> {
        let url = format!("{}{path}", self.base);
        let mut request = self.http.request(method.clone(), &url).bearer_auth(self.token.secret().expose()).header("Notion-Version", NOTION_VERSION);
        if let Some(body) = body {
            request = request.json(body);
        }
        self.sent.fetch_add(1, Ordering::Relaxed);
        let res = request
            .send()
            .await
            .map_err(|e| NotionError::Offline(format!("{what}: Notion could not be reached: {}", e.without_url())))?;
        let status = res.status().as_u16();
        // A 5xx is waited out once when waiting is allowed; otherwise it is an answer, not a rate limit.
        if status == 429 || (!self.max_wait.is_zero() && matches!(status, 500 | 502 | 503 | 504)) {
            let wait = res
                .headers()
                .get("retry-after")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| s.trim().parse().ok())
                .map(Duration::from_secs)
                .unwrap_or(DEFAULT_WAIT);
            return Ok(Attempt::Wait(wait));
        }
        let body = res.text().await.map_err(|e| NotionError::Offline(format!("{what}: Notion's reply was cut off: {}", e.without_url())))?;
        Ok(Attempt::Done((status, body)))
    }
}

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// Notion's error body is `{ "object": "error", "code": …, "message": … }`.
pub(crate) fn notion_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    let message = v["message"].as_str()?;
    Some(match v["code"].as_str() {
        Some(code) => format!("{code}: {message}"),
        None => message.to_string(),
    })
}

/// A Notion id as one URL path segment. Ids are UUIDs, with or without dashes;
/// anything else is refused rather than pasted into a path.
fn segment(id: &str) -> Result<String, NotionError> {
    let id = id.trim();
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        Ok(id.to_string())
    } else {
        Err(NotionError::Failed(format!("{id:?} is not a Notion id")))
    }
}
