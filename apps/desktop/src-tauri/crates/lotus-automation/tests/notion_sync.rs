//! Keeping a Notion source fresh (plans/ticket-sources PLAN §2.4, §2.7, task "Ticket Sources 05"):
//! an incremental query with an overlapping window, a full re-read that drops trashed pages, and
//! the source health a failed sync leaves — always with the last good copy kept. Against a fake
//! Notion; no test here talks to Notion itself.

#[path = "google_fake/mod.rs"]
mod fake;

use fake::{FakeGoogle as FakeNotion, Reply};
use lotus_automation::notion::api::NotionApi;
use lotus_automation::notion::rows::NotionRow;
use lotus_automation::notion::schema::{DataSourceSchema, FieldMapping};
use lotus_automation::notion::sync::{sync_source, write_health, FieldProblem, LostAccess, SourceCopy, SourceHealth, SyncRequest, COPY_FORMAT};
use lotus_automation::notion::token::NotionToken;
use serde_json::json;

const TOKEN: &str = "ntn_4h3RkQ0000000000000000000000000000000000abcd";
const DS: &str = "248104cd-477e-80af-bc30-000bea2dd2a5";

/// 2026-09-29 10:00:30 UTC — half a minute past the minute, so a whole-minute timestamp from
/// Notion can fall before it.
const T: i64 = 1_790_676_030_000;
const MINUTE: i64 = 60_000;

async fn api(replies: Vec<Reply>) -> (FakeNotion, NotionApi) {
    let notion = FakeNotion::start(replies).await;
    let api = NotionApi::new(reqwest::Client::new(), &notion.base, NotionToken::parse(TOKEN).unwrap());
    (notion, api)
}

/// The board's fields as Notion describes them. `status_options` are its Status options' ids.
fn schema_json(status_options: &[&str]) -> serde_json::Value {
    let options: Vec<_> = status_options.iter().map(|id| json!({ "id": id, "name": id.to_uppercase(), "color": "default" })).collect();
    json!({
        "object": "data_source",
        "id": DS,
        "title": [{ "plain_text": "Orbit board" }],
        "properties": {
            "Name": { "id": "title", "name": "Name", "type": "title", "title": {} },
            "ID": { "id": "a%3Ab", "name": "ID", "type": "unique_id", "unique_id": { "prefix": "TKT" } },
            "Status": { "id": "st", "name": "Status", "type": "status", "status": {
                "options": options,
                "groups": [
                    { "id": "g1", "name": "To-do", "option_ids": [status_options[0]] },
                    { "id": "g2", "name": "In progress", "option_ids": [] },
                    { "id": "g3", "name": "Complete", "option_ids": status_options[1..].to_vec() }
                ]
            } }
        }
    })
}

fn schema() -> DataSourceSchema {
    DataSourceSchema::from_json(&schema_json(&["todo", "done"])).unwrap()
}

fn mapping() -> FieldMapping {
    schema().suggest_mapping()
}

fn described(status_options: &[&str]) -> Reply {
    Reply::json(200, schema_json(status_options))
}

fn page(id: &str, key: i64, title: &str, edited: &str) -> serde_json::Value {
    page_in(id, key, title, edited, "todo")
}

fn page_in(id: &str, key: i64, title: &str, edited: &str, status: &str) -> serde_json::Value {
    json!({
        "object": "page",
        "id": id,
        "url": format!("https://www.notion.so/{id}"),
        "created_time": "2026-09-01T10:00:00.000Z",
        "last_edited_time": edited,
        "properties": {
            "Name": { "id": "title", "type": "title", "title": [{ "plain_text": title }] },
            "ID": { "id": "a%3Ab", "type": "unique_id", "unique_id": { "number": key, "prefix": "TKT" } },
            "Status": { "id": "st", "type": "status", "status": { "id": status, "name": status } }
        }
    })
}

fn row(id: &str, key: i64, title: &str, edited: &str) -> NotionRow {
    NotionRow::from_page(&page(id, key, title, edited), &mapping()).unwrap()
}

fn results(pages: Vec<serde_json::Value>) -> Reply {
    Reply::json(200, json!({ "object": "list", "results": pages, "has_more": false, "next_cursor": null }))
}

/// A copy last synced and re-read in full at `at`, with the board's fields as they were then.
fn kept(rows: Vec<NotionRow>, at: i64) -> SourceCopy {
    SourceCopy { rows, synced_at_ms: Some(at), reconciled_at_ms: Some(at), complete: true, schema: Some(schema()), format: COPY_FORMAT }
}

fn titles(copy: &SourceCopy) -> Vec<&str> {
    copy.rows.iter().map(|r| r.title.as_str()).collect()
}

// ── The incremental query ───────────────────────────────────────────────────

#[tokio::test]
async fn an_edit_in_the_same_minute_as_the_last_sync_is_not_missed() {
    // Last sync at 10:00:30. An edit at 10:00:45 comes back from Notion as 10:00:00 — its minute —
    // which is BEFORE the last sync. A window that started at the last sync would never ask for it.
    let (notion, api) = api(vec![results(vec![
        page("p1", 1, "One, edited", "2026-09-29T10:00:00.000Z"),
        page("p3", 3, "Three, new", "2026-09-29T10:01:00.000Z"),
    ])])
    .await;
    let before = kept(
        vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z"), row("p2", 2, "Two", "2026-09-28T09:00:00.000Z")],
        T,
    );

    let synced = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + MINUTE)).await;

    let seen = notion.seen();
    assert_eq!(seen.len(), 1, "one incremental query, no full re-read");
    assert_eq!(seen[0].path(), format!("/v1/data_sources/{DS}/query"));
    assert_eq!(
        seen[0].json()["filter"],
        json!({ "timestamp": "last_edited_time", "last_edited_time": { "on_or_after": "2026-09-29T09:58:30.000Z" } }),
        "the window reaches two minutes before the last sync"
    );
    assert_eq!(synced.health, SourceHealth::Healthy);
    assert_eq!(titles(&synced.copy), vec!["One, edited", "Two", "Three, new"]);
    assert_eq!(synced.copy.synced_at_ms, Some(T + MINUTE));
    assert_eq!(synced.copy.reconciled_at_ms, Some(T), "an incremental sync is not a full re-read");
}

// ── The full re-read ────────────────────────────────────────────────────────

#[tokio::test]
async fn a_page_moved_to_trash_leaves_the_list_at_the_next_full_re_read() {
    // A trashed page never shows up in a query again — not even as "trashed" — so only a full
    // read notices it is gone. One is due fifteen minutes after the last.
    let (notion, api) = api(vec![results(vec![page("p1", 1, "One", "2026-09-28T09:00:00.000Z")]), described(&["todo", "done"])]).await;
    let before = kept(
        vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z"), row("p2", 2, "Two, trashed", "2026-09-28T09:00:00.000Z")],
        T,
    );

    let synced = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + 15 * MINUTE)).await;

    let seen = notion.seen();
    assert_eq!(seen.len(), 2, "every row, then the board's fields");
    assert_eq!(seen[0].json().get("filter"), None, "a full read asks for every row");
    assert_eq!((seen[1].method.as_str(), seen[1].path()), ("GET", format!("/v1/data_sources/{DS}").as_str()));
    assert_eq!(titles(&synced.copy), vec!["One"]);
    assert_eq!(synced.copy.reconciled_at_ms, Some(T + 15 * MINUTE));
    assert_eq!(synced.health, SourceHealth::Healthy);
}

#[tokio::test]
async fn opening_the_source_asks_for_a_full_re_read_even_when_one_is_not_due() {
    let (notion, api) = api(vec![results(vec![]), described(&["todo", "done"])]).await;
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let synced = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + MINUTE).full()).await;

    assert_eq!(notion.seen()[0].json().get("filter"), None);
    assert!(synced.copy.rows.is_empty());
}

// ── When a sync does not work, the last good copy stays ─────────────────────

#[tokio::test]
async fn a_network_error_keeps_the_copy_and_says_offline() {
    // Nothing listens on port 9 here: the request never reaches anything.
    let api = NotionApi::new(reqwest::Client::new(), "http://127.0.0.1:9", NotionToken::parse(TOKEN).unwrap());
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let synced = sync_source(&api, DS, &mapping(), Some(before.clone()), SyncRequest::at(T + MINUTE)).await;

    assert_eq!(synced.copy, before, "nothing kept is lost or marked as synced");
    assert!(matches!(synced.health, SourceHealth::Offline { .. }), "{:?}", synced.health);
}

fn rate_limited(retry_after: &str) -> Reply {
    Reply::json(429, json!({ "object": "error", "status": 429, "code": "rate_limited", "message": "slow down" }))
        .with_header("Retry-After", retry_after)
}

#[tokio::test]
async fn a_rate_limit_longer_than_a_minute_is_waited_out_by_not_asking_until_then() {
    // Notion's workspace budget is shared, and its Retry-After can be more than 60 s (S27).
    let (notion, api) = api(vec![rate_limited("90"), results(vec![page("p1", 1, "One, edited", "2026-09-29T10:02:00.000Z")])]).await;
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let limited = sync_source(&api, DS, &mapping(), Some(before.clone()), SyncRequest::at(T + MINUTE)).await;

    assert_eq!(limited.health, SourceHealth::SlowedDown { retry_at_ms: T + MINUTE + 90_000 });
    assert_eq!(limited.copy, before);
    assert_eq!(notion.seen().len(), 1, "a sync never sleeps through a rate limit");

    // A minute later — still inside the 90 s — the sync does not ask at all.
    let waiting = sync_source(&api, DS, &mapping(), Some(before.clone()), SyncRequest::at(T + 2 * MINUTE).not_before(T + MINUTE + 90_000)).await;
    assert_eq!(waiting.health, SourceHealth::SlowedDown { retry_at_ms: T + MINUTE + 90_000 });
    assert_eq!(notion.seen().len(), 1);

    // Once it has passed, it asks again, and the source is healthy.
    let after = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + 3 * MINUTE).not_before(T + MINUTE + 90_000)).await;
    assert_eq!(after.health, SourceHealth::Healthy);
    assert_eq!(titles(&after.copy), vec!["One, edited"]);
    assert_eq!(notion.seen().len(), 2);
    assert_eq!(after.requests, 1, "each sync counts only its own requests");
}

#[tokio::test]
async fn a_short_rate_limit_is_not_slept_through_either() {
    let (notion, api) = api(vec![rate_limited("5")]).await;

    let synced = sync_source(&api, DS, &mapping(), None, SyncRequest::at(T)).await;

    assert_eq!(synced.health, SourceHealth::SlowedDown { retry_at_ms: T + 5_000 });
    assert_eq!(notion.seen().len(), 1);
}

#[tokio::test]
async fn a_token_notion_no_longer_accepts_is_lost_access_that_asks_to_reconnect() {
    // An expired or revoked token answers 401 `unauthorized` (S12).
    let (_notion, api) = api(vec![Reply::json(401, json!({ "object": "error", "status": 401, "code": "unauthorized", "message": "API token is invalid." }))]).await;
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let synced = sync_source(&api, DS, &mapping(), Some(before.clone()), SyncRequest::at(T + MINUTE)).await;

    assert_eq!(synced.health, SourceHealth::LostAccess { why: LostAccess::Token });
    assert_eq!(synced.copy, before);
}

#[tokio::test]
async fn a_database_no_longer_shared_is_lost_access_that_says_how_to_share() {
    // Unshared, or the database itself moved to trash: 404 `object_not_found`.
    let (_notion, api) = api(vec![Reply::json(404, json!({ "object": "error", "status": 404, "code": "object_not_found", "message": "Could not find data source" }))]).await;
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let synced = sync_source(&api, DS, &mapping(), Some(before.clone()), SyncRequest::at(T + MINUTE)).await;

    assert_eq!(synced.health, SourceHealth::LostAccess { why: LostAccess::Unshared });
    assert_eq!(synced.copy, before);
}

#[test]
fn health_reaches_the_screen_as_one_tagged_shape() {
    assert_eq!(serde_json::to_value(SourceHealth::Healthy).unwrap(), json!({ "state": "healthy" }));
    assert_eq!(
        serde_json::to_value(SourceHealth::SlowedDown { retry_at_ms: 5 }).unwrap(),
        json!({ "state": "slowed_down", "retryAtMs": 5 })
    );
    assert_eq!(
        serde_json::to_value(SourceHealth::LostAccess { why: LostAccess::Unshared }).unwrap(),
        json!({ "state": "lost_access", "why": "unshared" })
    );
}

// ── The board's fields (task "Ticket Sources 08") ──────────────────────────

#[tokio::test]
async fn a_renamed_field_changes_nothing_because_the_mapping_is_by_id() {
    // "Status" renamed to "Stage": same id, same type. A full read looks at the fields again.
    let mut renamed = schema_json(&["todo", "done"]);
    let mut status = renamed["properties"].as_object_mut().unwrap().remove("Status").unwrap();
    status["name"] = json!("Stage");
    renamed["properties"]["Stage"] = status;
    let (_notion, api) = api(vec![results(vec![page("p1", 1, "One", "2026-09-29T10:00:00.000Z")]), Reply::json(200, renamed)]).await;

    let synced = sync_source(&api, DS, &mapping(), None, SyncRequest::at(T)).await;

    assert_eq!(synced.health, SourceHealth::Healthy);
    assert_eq!(synced.copy.rows[0].status.as_deref(), Some("todo"));
}

#[tokio::test]
async fn a_mapped_field_removed_in_notion_is_fields_changed_and_the_list_stays() {
    // Status deleted in Notion. The query still answers; its pages just no longer carry it.
    let mut gone = schema_json(&["todo", "done"]);
    gone["properties"].as_object_mut().unwrap().remove("Status");
    let mut edited = page("p1", 1, "One, edited", "2026-09-29T10:01:00.000Z");
    edited["properties"].as_object_mut().unwrap().remove("Status");
    let (notion, api) = api(vec![results(vec![edited]), Reply::json(200, gone)]).await;
    let before = kept(
        vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z"), row("p2", 2, "Two", "2026-09-28T09:00:00.000Z")],
        T,
    );

    let synced = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + MINUTE)).await;

    assert_eq!(notion.seen().len(), 2, "a page without a mapped field makes the sync look at the fields");
    assert_eq!(synced.health, SourceHealth::FieldsChanged { fields: vec![FieldProblem::missing("status")] });
    assert_eq!(titles(&synced.copy), vec!["One, edited", "Two"], "tickets still show");
    assert!(synced.health.writes_paused(), "status writes stop until the field is remapped");
}

#[tokio::test]
async fn a_mapped_field_that_changed_type_is_fields_changed() {
    // Status turned into a plain select: same id, another type.
    let mut retyped = schema_json(&["todo", "done"]);
    retyped["properties"]["Status"] = json!({ "id": "st", "name": "Status", "type": "select", "select": { "options": [] } });
    let (_notion, api) = api(vec![results(vec![]), Reply::json(200, retyped)]).await;

    let synced = sync_source(&api, DS, &mapping(), None, SyncRequest::at(T)).await;

    assert_eq!(synced.health, SourceHealth::FieldsChanged { fields: vec![FieldProblem::retyped("status", "select")] });
}

#[tokio::test]
async fn a_new_status_option_in_notion_is_followed_without_a_remap() {
    // Someone added "Blocked" to the board. The edited ticket carries it, so the fields are read
    // again in the same sync, and the new option is known from then on.
    let (notion, api) = api(vec![
        results(vec![page_in("p1", 1, "One", "2026-09-29T10:01:00.000Z", "blocked")]),
        described(&["todo", "blocked", "done"]),
    ])
    .await;
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let synced = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + MINUTE)).await;

    assert_eq!(notion.seen().len(), 2);
    assert_eq!(synced.health, SourceHealth::Healthy);
    let status = synced.copy.schema.as_ref().and_then(|s| s.property("st")).and_then(|p| p.status.as_ref()).unwrap();
    assert_eq!(status.options.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(), vec!["todo", "blocked", "done"]);
}

#[tokio::test]
async fn an_ordinary_edit_does_not_read_the_fields_again() {
    let (notion, api) = api(vec![results(vec![page("p1", 1, "One, edited", "2026-09-29T10:01:00.000Z")])]).await;
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let synced = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + MINUTE)).await;

    assert_eq!(notion.seen().len(), 1, "still one request a minute");
    assert_eq!(synced.health, SourceHealth::Healthy);
}

#[test]
fn only_fields_changed_pauses_writes() {
    assert!(!SourceHealth::Healthy.writes_paused());
    assert!(!SourceHealth::Offline { message: "x".into() }.writes_paused());
    assert!(SourceHealth::FieldsChanged { fields: vec![FieldProblem::missing("status")] }.writes_paused());
    assert_eq!(
        serde_json::to_value(SourceHealth::FieldsChanged { fields: vec![FieldProblem::retyped("status", "select")] }).unwrap(),
        json!({ "state": "fields_changed", "fields": [{ "field": "status", "nowKind": "select" }] })
    );
}

#[tokio::test]
async fn when_only_reading_the_fields_fails_the_rows_read_are_still_kept() {
    // The full read worked; the extra request for the board's fields was rate limited. The rows
    // are good and are kept, with the fields as they were.
    let (_notion, api) = api(vec![results(vec![page("p1", 1, "One, edited", "2026-09-29T10:00:00.000Z")]), rate_limited("30")]).await;
    let before = kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T);

    let synced = sync_source(&api, DS, &mapping(), Some(before), SyncRequest::at(T + MINUTE).full()).await;

    assert_eq!(synced.health, SourceHealth::Healthy);
    assert_eq!(titles(&synced.copy), vec!["One, edited"]);
    assert_eq!(synced.copy.reconciled_at_ms, Some(T + MINUTE));
    assert_eq!(synced.copy.schema, Some(schema()));
}

// ── What a write is checked against (task "Ticket Sources 09") ──────────────

#[test]
fn a_later_failed_sync_does_not_lift_fields_changed_for_writes() {
    // "Fields changed", then a sync that was slowed down: the fields are still wrong.
    let mut gone = schema_json(&["todo", "done"]);
    gone["properties"].as_object_mut().unwrap().remove("Status");
    let copy = SourceCopy { schema: Some(DataSourceSchema::from_json(&gone).unwrap()), ..kept(vec![], T) };
    let slowed = SourceHealth::SlowedDown { retry_at_ms: T + MINUTE };

    let health = write_health(Some(&slowed), Some(&copy), &mapping());

    assert!(health.writes_paused(), "{health:?}");
    assert!(!write_health(Some(&slowed), Some(&kept(vec![], T)), &mapping()).writes_paused(), "fields fine: not paused");
    assert!(write_health(Some(&SourceHealth::FieldsChanged { fields: vec![] }), None, &mapping()).writes_paused());
}

#[tokio::test]
async fn a_copy_kept_before_rows_carried_every_field_is_read_again_in_full() {
    // Rows saved before assignee ids were kept would offer the wrong assignees until a full read.
    let (notion, api) = api(vec![results(vec![page("p1", 1, "One", "2026-09-28T09:00:00.000Z")]), described(&["todo", "done"])]).await;
    let old = SourceCopy { format: 0, ..kept(vec![row("p1", 1, "One", "2026-09-28T09:00:00.000Z")], T) };

    let synced = sync_source(&api, DS, &mapping(), Some(old), SyncRequest::at(T + MINUTE)).await;

    assert!(synced.full);
    assert_eq!(notion.seen()[0].json().get("filter"), None);
    assert_eq!(synced.copy.format, COPY_FORMAT);
}
