//! Connecting Notion (plans/ticket-sources PLAN §2.2, task "Ticket Sources 03"): the pasted
//! token's shape, `users/me` against a fake Notion — exact path and headers — and where the token
//! is kept. No test here talks to Notion itself.

#[path = "google_fake/mod.rs"]
mod fake;

use std::collections::HashMap;
use std::sync::Mutex;

use fake::{FakeGoogle as FakeNotion, Reply};
use lotus_automation::notion::account::{
    forget_notion_token, load_notion_token, save_notion_token, NotionAccountSummary,
};
use lotus_automation::notion::api::{NotionApi, NotionIdentity};
use lotus_automation::notion::token::NotionToken;
use lotus_automation::notion::{NotionError, NOTION_VERSION};
use lotus_automation::secrets::{redact, SecretStore};
use serde_json::json;

const TOKEN: &str = "ntn_4h3RkQ0000000000000000000000000000000000abcd";
// Split so secret scanners do not read the fake legacy token as a real one.
const LEGACY: &str = concat!("secret", "_AbCdEf0123456789AbCdEf0123456789AbCdEf01234");

fn token() -> NotionToken {
    NotionToken::parse(TOKEN).unwrap()
}

async fn api(replies: Vec<Reply>) -> (FakeNotion, NotionApi) {
    let notion = FakeNotion::start(replies).await;
    let api = NotionApi::new(reqwest::Client::new(), &notion.base, token());
    (notion, api)
}

// ── The pasted token ─────────────────────────────────────────────────────────

#[test]
fn a_personal_token_and_an_older_integration_token_are_both_accepted() {
    assert!(NotionToken::parse(TOKEN).is_ok());
    assert!(NotionToken::parse(LEGACY).is_ok());
}

#[test]
fn pasted_whitespace_and_quotes_are_forgiven() {
    let pasted = format!("  \"{TOKEN}\"\n");
    assert_eq!(NotionToken::parse(&pasted).unwrap().secret().expose(), TOKEN);
}

#[test]
fn another_services_token_is_named_rather_than_just_refused() {
    let err = NotionToken::parse("xoxp-1234-5678-abcdef").unwrap_err();
    assert!(err.contains("a Slack user token"), "{err}");
    let err = NotionToken::parse("https://www.notion.so/my-integrations").unwrap_err();
    assert!(err.contains("a link"), "{err}");
    let err = NotionToken::parse("   ").unwrap_err();
    assert!(err.contains("empty"), "{err}");
}

#[test]
fn a_cut_off_token_is_called_incomplete() {
    let err = NotionToken::parse("ntn_abc").unwrap_err();
    assert!(err.contains("incomplete"), "{err}");
}

#[test]
fn the_token_never_prints() {
    let shown = format!("{:?}", token());
    assert!(!shown.contains("4h3RkQ"), "{shown}");
}

// ── users/me ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn me_sends_the_token_and_the_pinned_version_to_users_me() {
    let (notion, api) = api(vec![Reply::json(
        200,
        json!({ "object": "user", "id": "u1", "type": "person", "name": "Alwi", "person": { "email": "alwi@example.com" } }),
    )])
    .await;

    let who = api.me().await.unwrap();

    assert_eq!(who, NotionIdentity::Person { name: Some("Alwi".into()), email: Some("alwi@example.com".into()) });
    let seen = notion.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, "GET");
    assert_eq!(seen[0].path(), "/v1/users/me");
    assert_eq!(seen[0].header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(seen[0].header("notion-version"), Some(NOTION_VERSION));
}

#[tokio::test]
async fn an_integration_token_is_a_bot_that_names_its_workspace() {
    let (_notion, api) = api(vec![Reply::json(
        200,
        json!({ "object": "user", "type": "bot", "name": "Lotus", "bot": { "owner": { "type": "workspace", "workspace": true }, "workspace_name": "Initech" } }),
    )])
    .await;

    assert_eq!(api.me().await.unwrap(), NotionIdentity::Integration { name: Some("Lotus".into()), workspace: Some("Initech".into()) });
}

#[tokio::test]
async fn an_expired_or_revoked_token_asks_to_connect_again() {
    let (_notion, api) = api(vec![Reply::json(
        401,
        json!({ "object": "error", "status": 401, "code": "unauthorized", "message": "API token is invalid." }),
    )])
    .await;

    let err = api.me().await.unwrap_err();
    assert!(err.needs_reconnect(), "{err}");
}

#[tokio::test]
async fn one_rate_limit_is_waited_out_then_the_call_goes_through() {
    let (notion, api) = api(vec![
        Reply::json(429, json!({ "object": "error", "code": "rate_limited", "message": "slow down" })).with_header("Retry-After", "0"),
        Reply::json(200, json!({ "object": "user", "type": "person", "name": "Alwi", "person": {} })),
    ])
    .await;

    assert_eq!(api.me().await.unwrap(), NotionIdentity::Person { name: Some("Alwi".into()), email: None });
    assert_eq!(notion.seen().len(), 2);
}

#[tokio::test]
async fn another_error_says_what_notion_said() {
    let (_notion, api) = api(vec![Reply::json(
        400,
        json!({ "object": "error", "code": "missing_version", "message": "Notion-Version header failed validation" }),
    )])
    .await;

    match api.me().await.unwrap_err() {
        NotionError::Failed(message) => assert!(message.contains("missing_version"), "{message}"),
        other => panic!("expected a failed call, got {other:?}"),
    }
}

// ── Where it is kept ─────────────────────────────────────────────────────────

#[derive(Default)]
struct Memory(Mutex<HashMap<String, String>>);

impl SecretStore for Memory {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(name).cloned())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(name.into(), value.into());
        Ok(())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        self.0.lock().unwrap().remove(name);
        Ok(())
    }
}

#[test]
fn the_token_is_saved_read_back_and_forgotten() {
    let store = Memory::default();
    assert!(load_notion_token(&store).unwrap().is_none());

    save_notion_token(&store, &token()).unwrap();
    assert_eq!(load_notion_token(&store).unwrap().unwrap().secret().expose(), TOKEN);

    forget_notion_token(&store).unwrap();
    assert!(load_notion_token(&store).unwrap().is_none());
}

#[test]
fn the_summary_carries_who_it_is_and_never_the_token() {
    let person = NotionAccountSummary::new(&NotionIdentity::Person { name: Some("Alwi".into()), email: Some("a@x.com".into()) }, 7);
    assert_eq!(person.kind, "personal");
    assert_eq!(person.workspace, None);
    let bot = NotionAccountSummary::new(&NotionIdentity::Integration { name: None, workspace: Some("Initech".into()) }, 7);
    assert_eq!(bot.kind, "integration");
    assert_eq!(bot.workspace.as_deref(), Some("Initech"));

    let written = serde_json::to_string(&person).unwrap();
    assert!(!written.contains("ntn_"), "{written}");
    assert!(written.contains("connectedAtMs"), "{written}");
}

// ── Redaction ────────────────────────────────────────────────────────────────

#[test]
fn notion_tokens_are_masked_in_errors_and_logs() {
    let text = format!("Notion refused {TOKEN} and {LEGACY}.");
    let masked = redact(&text);
    assert!(!masked.contains("4h3RkQ"), "{masked}");
    assert!(!masked.contains("AbCdEf0123"), "{masked}");
    assert!(masked.contains("ntn_[redacted]"), "{masked}");
    assert!(masked.contains("secret_[redacted]."), "{masked}");
}

#[test]
fn an_ordinary_word_that_starts_with_secret_is_left_alone() {
    assert_eq!(redact("the secret_store could not be read"), "the secret_store could not be read");
}

// ── A database: its fields, and its rows (task "Ticket Sources 04") ─────────

use lotus_automation::notion::rows::NotionRow;
use lotus_automation::notion::schema::{DataSourceSchema, FieldMapping};

const DS: &str = "248104cd-477e-80af-bc30-000bea2dd2a5";

fn schema_json() -> serde_json::Value {
    json!({
        "object": "data_source",
        "id": DS,
        "title": [{ "plain_text": "Orbit board" }],
        "url": "https://www.notion.so/248104cd477e80afbc30000bea2dd2a5",
        "properties": {
            "Name": { "id": "title", "name": "Name", "type": "title", "title": {} },
            "ID": { "id": "a%3Ab", "name": "ID", "type": "unique_id", "unique_id": { "prefix": "TKT" } },
            "Status": { "id": "st%40t", "name": "Status", "type": "status", "status": {
                "options": [
                    { "id": "o-backlog", "name": "Backlog", "color": "default" },
                    { "id": "o-progress", "name": "In progress", "color": "blue" },
                    { "id": "o-released", "name": "Released", "color": "green" }
                ],
                "groups": [
                    { "id": "g-todo", "name": "To-do", "color": "gray", "option_ids": ["o-backlog"] },
                    { "id": "g-prog", "name": "In progress", "color": "blue", "option_ids": ["o-progress"] },
                    { "id": "g-done", "name": "Complete", "color": "green", "option_ids": ["o-released"] }
                ]
            } },
            "Assignee": { "id": "pp", "name": "Assignee", "type": "people", "people": {} },
            "Tags": { "id": "tg", "name": "Tags", "type": "multi_select", "multi_select": { "options": [] } },
            "Customer": { "id": "cust", "name": "Customer", "type": "relation", "relation": { "data_source_id": "other-ds", "type": "single_property" } },
            "Parent item": { "id": "par", "name": "Parent item", "type": "relation", "relation": { "data_source_id": DS, "type": "dual_property" } }
        }
    })
}

fn page(id: &str, created: &str, key: i64, title: &str) -> serde_json::Value {
    json!({
        "object": "page",
        "id": id,
        "url": format!("https://www.notion.so/{id}"),
        "created_time": created,
        "last_edited_time": created,
        "properties": {
            "Name": { "id": "title", "type": "title", "title": [{ "plain_text": title }] },
            "ID": { "id": "a%3Ab", "type": "unique_id", "unique_id": { "number": key, "prefix": "TKT" } },
            "Status": { "id": "st%40t", "type": "status", "status": { "id": "o-progress", "name": "In progress" } },
            "Assignee": { "id": "pp", "type": "people", "people": [{ "object": "user", "id": "u1", "name": "Alwi" }] },
            "Tags": { "id": "tg", "type": "multi_select", "multi_select": [{ "name": "billing" }, { "name": "backend" }] },
            "Parent item": { "id": "par", "type": "relation", "relation": [{ "id": "parent-page" }] }
        }
    })
}

#[test]
fn fields_are_found_by_type_and_kept_by_property_id() {
    let schema = DataSourceSchema::from_json(&schema_json()).unwrap();
    assert_eq!(schema.title, "Orbit board");
    let mapping = schema.suggest_mapping();
    assert_eq!(
        mapping,
        FieldMapping {
            title: Some("title".into()),
            key: Some("a%3Ab".into()),
            status: Some("st%40t".into()),
            assignee: Some("pp".into()),
            labels: Some("tg".into()),
            // The relation into THIS database, never the one to Customers.
            parent: Some("par".into()),
        }
    );
    let status = schema.property("st%40t").unwrap().status.as_ref().unwrap();
    assert_eq!(status.options.len(), 3);
    assert_eq!(status.groups[2].name, "Complete");
    assert_eq!(status.groups[2].option_ids, vec!["o-released".to_string()]);
}

#[test]
fn a_page_is_read_as_a_row_through_the_mapping() {
    let mapping = DataSourceSchema::from_json(&schema_json()).unwrap().suggest_mapping();
    let row = NotionRow::from_page(&page("p1", "2026-09-01T10:00:00.000Z", 1008, "Stripe webhook"), &mapping).unwrap();
    assert_eq!(row.page_id, "p1");
    assert_eq!(row.key.as_deref(), Some("TKT-1008"));
    assert_eq!(row.title, "Stripe webhook");
    assert_eq!(row.status.as_deref(), Some("o-progress"));
    assert_eq!(row.assignees, vec!["Alwi".to_string()]);
    assert_eq!(row.labels, vec!["billing".to_string(), "backend".to_string()]);
    assert_eq!(row.parents, vec!["parent-page".to_string()]);
}

#[test]
fn a_renamed_property_still_reads_because_the_mapping_is_by_id() {
    let mapping = DataSourceSchema::from_json(&schema_json()).unwrap().suggest_mapping();
    let mut renamed = page("p1", "2026-09-01T10:00:00.000Z", 1008, "Stripe webhook");
    let status = renamed["properties"]["Status"].take();
    renamed["properties"]["Stage"] = status;
    let row = NotionRow::from_page(&renamed, &mapping).unwrap();
    assert_eq!(row.status.as_deref(), Some("o-progress"));
}

#[tokio::test]
async fn search_asks_for_data_sources_only_and_skips_trashed_ones() {
    let (notion, api) = api(vec![Reply::json(
        200,
        json!({ "results": [
            { "object": "data_source", "id": DS, "title": [{ "plain_text": "Orbit board" }], "url": "https://www.notion.so/x" },
            { "object": "data_source", "id": "old", "title": [{ "plain_text": "Old board" }], "in_trash": true }
        ], "has_more": false, "next_cursor": null }),
    )])
    .await;

    let found = api.search_data_sources(" orbit ").await.unwrap();

    assert_eq!(found.len(), 1);
    assert_eq!(found[0].title, "Orbit board");
    let seen = &notion.seen()[0];
    assert_eq!((seen.method.as_str(), seen.path()), ("POST", "/v1/search"));
    assert_eq!(seen.json()["filter"], json!({ "property": "object", "value": "data_source" }));
    assert_eq!(seen.json()["query"], json!("orbit"));
}

#[tokio::test]
async fn the_schema_is_read_from_the_data_source() {
    let (notion, api) = api(vec![Reply::json(200, schema_json())]).await;
    let schema = api.data_source(DS).await.unwrap();
    assert_eq!(schema.properties.len(), 7);
    assert_eq!(notion.seen()[0].path(), format!("/v1/data_sources/{DS}"));
}

#[tokio::test]
async fn an_id_that_is_not_a_notion_id_is_never_put_in_a_path() {
    let (notion, api) = api(vec![]).await;
    assert!(api.data_source("../../v1/users").await.is_err());
    assert!(notion.seen().is_empty());
}

#[tokio::test]
async fn rows_are_read_page_by_page_in_created_order() {
    let mapping = DataSourceSchema::from_json(&schema_json()).unwrap().suggest_mapping();
    let (notion, api) = api(vec![
        Reply::json(200, json!({ "results": [page("p1", "2026-09-01T10:00:00.000Z", 1, "One")], "has_more": true, "next_cursor": "c2" })),
        Reply::json(200, json!({ "results": [page("p2", "2026-09-02T10:00:00.000Z", 2, "Two")], "has_more": false, "next_cursor": null })),
    ])
    .await;

    let read = api.read_rows(DS, &mapping).await.unwrap();

    assert!(read.complete);
    assert_eq!(read.rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["One", "Two"]);
    let seen = notion.seen();
    assert_eq!(seen[0].path(), format!("/v1/data_sources/{DS}/query"));
    assert_eq!(seen[0].json()["sorts"], json!([{ "timestamp": "created_time", "direction": "ascending" }]));
    assert_eq!(seen[0].json()["page_size"], json!(100));
    assert_eq!(seen[1].json()["start_cursor"], json!("c2"));
}

#[tokio::test]
async fn a_query_stopped_at_the_10000_cap_goes_on_from_the_last_row_without_doubles() {
    let mapping = DataSourceSchema::from_json(&schema_json()).unwrap().suggest_mapping();
    let (notion, api) = api(vec![
        Reply::json(200, json!({
            "results": [page("p1", "2026-09-01T10:00:00.000Z", 1, "One"), page("p2", "2026-09-02T10:00:00.000Z", 2, "Two")],
            "has_more": true, "next_cursor": "c",
            "request_status": { "type": "incomplete", "incomplete_reason": "query_result_limit_reached" }
        })),
        Reply::json(200, json!({
            "results": [page("p2", "2026-09-02T10:00:00.000Z", 2, "Two"), page("p3", "2026-09-03T10:00:00.000Z", 3, "Three")],
            "has_more": false, "next_cursor": null
        })),
    ])
    .await;

    let read = api.read_rows(DS, &mapping).await.unwrap();

    assert!(read.complete);
    assert_eq!(read.rows.iter().map(|r| r.page_id.as_str()).collect::<Vec<_>>(), vec!["p1", "p2", "p3"]);
    assert_eq!(
        notion.seen()[1].json()["filter"],
        json!({ "timestamp": "created_time", "created_time": { "on_or_after": "2026-09-02T10:00:00.000Z" } })
    );
}

#[tokio::test]
async fn a_database_the_token_cannot_see_says_so() {
    let (_notion, api) = api(vec![Reply::json(404, json!({ "object": "error", "code": "object_not_found", "message": "Could not find" }))]).await;
    let err = api.data_source(DS).await.unwrap_err();
    assert!(!err.needs_reconnect());
    assert!(err.to_string().contains("cannot find it"), "{err}");
}

// ── A ticket's page (task "Ticket Sources 06") ──────────────────────────────

#[tokio::test]
async fn the_page_body_is_read_as_markdown_with_the_pinned_version() {
    let (notion, api) = api(vec![Reply::json(
        200,
        json!({ "object": "page_markdown", "id": "p1", "markdown": "## Description\n\nTag every event.", "truncated": false, "unknown_block_ids": [] }),
    )])
    .await;

    let page = api.page_markdown("0a1b2c3d-0000-0000-0000-000000000000").await.unwrap();

    assert_eq!(page.markdown, "## Description\n\nTag every event.");
    assert!(!page.truncated);
    let seen = &notion.seen()[0];
    assert_eq!((seen.method.as_str(), seen.path()), ("GET", "/v1/pages/0a1b2c3d-0000-0000-0000-000000000000/markdown"));
    assert_eq!(seen.header("notion-version"), Some(NOTION_VERSION));
}

#[tokio::test]
async fn a_cut_off_page_says_so_and_names_the_blocks_it_could_not_express() {
    let (_notion, api) = api(vec![Reply::json(
        200,
        json!({ "markdown": "Intro\n<unknown url=\"https://www.notion.so/x#b1\" alt=\"bookmark\"/>", "truncated": true, "unknown_block_ids": ["b1"] }),
    )])
    .await;

    let page = api.page_markdown("0a1b2c3d00000000000000000000000f").await.unwrap();

    assert!(page.truncated);
    assert_eq!(page.unknown_block_ids, vec!["b1".to_string()]);
}

#[test]
fn property_lines_reads_each_kind_an_agent_needs_and_leaves_out_title_and_empties() {
    use lotus_automation::notion::rows::property_lines;
    let page = serde_json::json!({ "properties": {
        "Name": { "id": "title", "type": "title", "title": [{ "plain_text": "Login" }] },
        "Status": { "id": "s", "type": "status", "status": { "id": "x", "name": "In progress" } },
        "Priority": { "id": "p", "type": "select", "select": { "name": "High" } },
        "Labels": { "id": "l", "type": "multi_select", "multi_select": [{ "name": "api" }, { "name": "ui" }] },
        "Assignee": { "id": "a", "type": "people", "people": [{ "id": "u", "name": "Sam" }] },
        "ID": { "id": "i", "type": "unique_id", "unique_id": { "prefix": "TKT", "number": 123 } },
        "Parent": { "id": "r", "type": "relation", "relation": [{ "id": "q" }] },
        "Due": { "id": "d", "type": "date", "date": { "start": "2026-10-09", "end": null } },
        "Points": { "id": "n", "type": "number", "number": 3.0 },
        "Notes": { "id": "t", "type": "rich_text", "rich_text": [] },
        "Empty select": { "id": "e", "type": "select", "select": null }
    }});
    let lines: Vec<String> = property_lines(&page).into_iter().map(|(k, v)| format!("{k}: {v}")).collect();
    assert_eq!(
        lines,
        [
            "Assignee: Sam",
            "Due: 2026-10-09",
            "ID: TKT-123",
            "Labels: api, ui",
            "Parent: 1 linked page",
            "Points: 3",
            "Priority: High",
            "Status: In progress",
        ]
    );
}
