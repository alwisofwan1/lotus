//! Changing a Notion ticket from Lotus (plans/ticket-sources PLAN S21, S32–S34, S41–S42, task
//! "Ticket Sources 09"): only in a Manage database, never while its fields changed, and only when
//! the field is still what the person saw. Against a fake Notion; no test here talks to Notion.

#[path = "google_fake/mod.rs"]
mod fake;

use fake::{FakeGoogle as FakeNotion, Reply};
use lotus_automation::notion::api::NotionApi;
use lotus_automation::notion::rows::NotionRow;
use lotus_automation::notion::schema::{DataSourceSchema, FieldMapping, FieldProblem};
use lotus_automation::notion::sync::SourceHealth;
use lotus_automation::notion::token::NotionToken;
use lotus_automation::notion::write::{create_ticket, trash_ticket, write_ticket, CreateRequest, Permission, TicketChange, TrashRequest, WriteBlocked, WriteOutcome, WriteRequest};
use serde_json::json;

const TOKEN: &str = "ntn_4h3RkQ0000000000000000000000000000000000abcd";
const DS: &str = "248104cd-477e-80af-bc30-000bea2dd2a5";
const PAGE: &str = "0a1b2c3d-0000-0000-0000-000000000001";

async fn api(replies: Vec<Reply>) -> (FakeNotion, NotionApi) {
    let notion = FakeNotion::start(replies).await;
    let api = NotionApi::new(reqwest::Client::new(), &notion.base, NotionToken::parse(TOKEN).unwrap());
    (notion, api)
}

fn mapping() -> FieldMapping {
    DataSourceSchema::from_json(&json!({
        "object": "data_source",
        "id": DS,
        "title": [{ "plain_text": "Orbit board" }],
        "properties": {
            "Name": { "id": "title", "name": "Name", "type": "title", "title": {} },
            "Status": { "id": "st", "name": "Status", "type": "status", "status": { "options": [], "groups": [] } },
            "Assignee": { "id": "pp", "name": "Assignee", "type": "people", "people": {} },
            "Tags": { "id": "tg", "name": "Tags", "type": "multi_select", "multi_select": { "options": [] } }
        }
    }))
    .unwrap()
    .suggest_mapping()
}

fn page(status: &str, edited: &str) -> serde_json::Value {
    json!({
        "object": "page",
        "id": PAGE,
        "url": "https://www.notion.so/p1",
        "created_time": "2026-09-01T10:00:00.000Z",
        "last_edited_time": edited,
        "parent": { "type": "data_source_id", "data_source_id": DS, "database_id": "d9824bdc-8445-4327-be8b-5b47500af6ce" },
        "properties": {
            "Name": { "id": "title", "type": "title", "title": [{ "plain_text": "One" }] },
            "Status": { "id": "st", "type": "status", "status": { "id": status, "name": status } },
            "Assignee": { "id": "pp", "type": "people", "people": [{ "object": "user", "id": "u1", "name": "Alwi" }] },
            "Tags": { "id": "tg", "type": "multi_select", "multi_select": [{ "name": "billing" }] }
        }
    })
}

fn seen() -> NotionRow {
    NotionRow::from_page(&page("todo", "2026-09-29T10:00:00.000Z"), &mapping()).unwrap()
}

fn request<'a>(seen: &'a NotionRow, change: TicketChange, permission: Permission, health: &'a SourceHealth, mapping: &'a FieldMapping) -> WriteRequest<'a> {
    WriteRequest { data_source_id: DS, mapping, permission, health, seen, change }
}

fn status(id: &str) -> TicketChange {
    TicketChange::Status(id.into())
}

// ── Refused before anything is sent ─────────────────────────────────────────

#[tokio::test]
async fn a_read_only_database_is_never_written_not_even_asked() {
    // A personal token can always write (S11), so it is Lotus that keeps Read only read only.
    let (notion, api) = api(vec![]).await;
    let (row, map) = (seen(), mapping());

    for change in [status("done"), TicketChange::Title("New".into()), TicketChange::Assignees(vec![]), TicketChange::Labels(vec![])] {
        let out = write_ticket(&api, request(&row, change, Permission::ReadOnly, &SourceHealth::Healthy, &map)).await;
        assert_eq!(out, Err(WriteBlocked::ReadOnly));
    }
    assert!(notion.seen().is_empty(), "no request of any kind");
}

#[tokio::test]
async fn nothing_is_written_while_the_fields_changed() {
    let (notion, api) = api(vec![]).await;
    let (row, map) = (seen(), mapping());
    let health = SourceHealth::FieldsChanged { fields: vec![FieldProblem::missing("assignee")] };

    let out = write_ticket(&api, request(&row, TicketChange::Title("New".into()), Permission::Manage, &health, &map)).await;

    assert_eq!(out, Err(WriteBlocked::FieldsChanged), "every write stops, not only status (S42)");
    assert!(notion.seen().is_empty());
}

#[tokio::test]
async fn a_field_that_is_not_mapped_cannot_be_written() {
    let (notion, api) = api(vec![]).await;
    let row = seen();
    let map = FieldMapping { status: None, ..mapping() };

    let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    assert_eq!(out, Err(WriteBlocked::NotMapped("status".into())));
    assert!(notion.seen().is_empty());
}

// ── Checked before it is written ────────────────────────────────────────────

#[tokio::test]
async fn a_status_someone_else_changed_since_it_was_seen_is_refused_without_a_patch() {
    // Notion has no If-Match or version on PATCH (S32): Lotus reads the page first.
    let (notion, api) = api(vec![Reply::json(200, page("in_progress", "2026-09-29T10:05:00.000Z"))]).await;
    let (row, map) = (seen(), mapping());

    let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    let Ok(WriteOutcome::Conflict { fresh }) = out else { panic!("{out:?}") };
    assert_eq!(fresh.status.as_deref(), Some("in_progress"), "the version Notion has now, to show");
    let seen = notion.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].method.as_str(), seen[0].path()), ("GET", format!("/v1/pages/{PAGE}").as_str()));
}

#[tokio::test]
async fn an_edit_elsewhere_on_the_page_does_not_block_this_field() {
    // Someone edited the body: the page's time moved, the status did not. PATCH sets only the status.
    let (notion, api) = api(vec![
        Reply::json(200, page("todo", "2026-09-29T10:05:00.000Z")),
        Reply::json(200, page("done", "2026-09-29T10:06:00.000Z")),
    ])
    .await;
    let (row, map) = (seen(), mapping());

    let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    let Ok(WriteOutcome::Saved { row }) = out else { panic!("{out:?}") };
    assert_eq!(row.status.as_deref(), Some("done"));
    let seen = notion.seen();
    assert_eq!((seen[1].method.as_str(), seen[1].path()), ("PATCH", format!("/v1/pages/{PAGE}").as_str()));
    assert_eq!(seen[1].json(), json!({ "properties": { "st": { "status": { "id": "done" } } } }), "by property id");
}

#[tokio::test]
async fn each_field_is_sent_in_notions_shape() {
    let cases = [
        (TicketChange::Title("Renamed".into()), json!({ "title": { "title": [{ "type": "text", "text": { "content": "Renamed" } }] } })),
        (TicketChange::Assignees(vec!["u2".into()]), json!({ "pp": { "people": [{ "id": "u2" }] } })),
        (TicketChange::Labels(vec!["billing".into(), "backend".into()]), json!({ "tg": { "multi_select": [{ "name": "billing" }, { "name": "backend" }] } })),
    ];
    for (change, properties) in cases {
        let (notion, api) = api(vec![Reply::json(200, page("todo", "2026-09-29T10:00:00.000Z")), Reply::json(200, page("todo", "2026-09-29T10:06:00.000Z"))]).await;
        let (row, map) = (seen(), mapping());
        let out = write_ticket(&api, request(&row, change, Permission::Manage, &SourceHealth::Healthy, &map)).await;
        assert!(matches!(out, Ok(WriteOutcome::Saved { .. })), "{out:?}");
        assert_eq!(notion.seen()[1].json(), json!({ "properties": properties }));
    }
}

// ── When Notion does not say yes ────────────────────────────────────────────

fn saved_but_503() -> Reply {
    Reply::json(503, json!({
        "object": "error", "status": 503, "code": "service_unavailable",
        "message": "The change was saved, but the response could not be built in time. Read the object again instead of repeating the write.",
        "additional_data": { "retry_guidance": ["Read the object again to confirm the saved change.", "Do not repeat the write."] }
    }))
}

#[tokio::test]
async fn a_503_is_never_retried_blind_the_page_is_read_again_instead() {
    let (notion, api) = api(vec![
        Reply::json(200, page("todo", "2026-09-29T10:00:00.000Z")),
        saved_but_503(),
        Reply::json(200, page("done", "2026-09-29T10:06:00.000Z")),
    ])
    .await;
    let (row, map) = (seen(), mapping());

    let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    assert!(matches!(out, Ok(WriteOutcome::Saved { .. })), "the read shows the change was saved: {out:?}");
    let methods: Vec<_> = notion.seen().iter().map(|s| s.method.clone()).collect();
    assert_eq!(methods, vec!["GET", "PATCH", "GET"], "one PATCH, never two");
}

#[tokio::test]
async fn a_503_whose_change_did_not_land_says_so_with_notions_guidance() {
    let (notion, api) = api(vec![
        Reply::json(200, page("todo", "2026-09-29T10:00:00.000Z")),
        Reply::json(503, json!({ "object": "error", "status": 503, "code": "service_unavailable", "message": "Notion is unavailable, please try again later." })),
        Reply::json(200, page("todo", "2026-09-29T10:00:00.000Z")),
    ])
    .await;
    let (row, map) = (seen(), mapping());

    let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    let Ok(WriteOutcome::NotSaved { fresh, message }) = out else { panic!("{out:?}") };
    assert_eq!(fresh.status.as_deref(), Some("todo"));
    assert!(message.contains("unavailable"), "{message}");
    assert_eq!(notion.seen().iter().filter(|s| s.method == "PATCH").count(), 1);
}

#[tokio::test]
async fn a_refused_write_is_write_refused_and_nothing_is_applied() {
    for (status_code, code, message) in [
        (403, "restricted_resource", "API token does not have access to this resource."),
        (400, "validation_error", "body failed validation: Invalid status option."),
    ] {
        let (notion, api) = api(vec![
            Reply::json(200, page("todo", "2026-09-29T10:00:00.000Z")),
            Reply::json(status_code, json!({ "object": "error", "status": status_code, "code": code, "message": message })),
        ])
        .await;
        let (row, map) = (seen(), mapping());

        let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

        let Ok(WriteOutcome::Refused { message: said }) = out else { panic!("{out:?}") };
        assert!(said.contains(code) && said.contains(message), "{said}");
        assert_eq!(notion.seen().len(), 2, "no retry, no second read");
    }
}

#[test]
fn a_row_keeps_its_assignees_ids_so_they_can_be_written_back() {
    assert_eq!(seen().assignee_ids, vec!["u1".to_string()]);
    assert_eq!(seen().assignees, vec!["Alwi".to_string()]);
}

#[tokio::test]
async fn a_page_from_another_database_is_never_written_through_this_one() {
    // A Manage source's id with a page from somewhere else: the title id is `title` everywhere.
    let mut elsewhere = page("todo", "2026-09-29T10:00:00.000Z");
    elsewhere["parent"]["data_source_id"] = json!("99999999-0000-0000-0000-000000000000");
    let (notion, api) = api(vec![Reply::json(200, elsewhere)]).await;
    let (row, map) = (seen(), mapping());

    let out = write_ticket(&api, request(&row, TicketChange::Title("Hijacked".into()), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    assert!(matches!(out, Ok(WriteOutcome::Refused { .. })), "{out:?}");
    assert!(notion.seen().iter().all(|s| s.method == "GET"), "no PATCH");
}

#[tokio::test]
async fn when_the_read_after_a_5xx_fails_the_change_is_unknown_not_refused() {
    // The PATCH may have been saved; the page could not be read to see. Saying "refused" would be false.
    let (notion, api) = api(vec![
        Reply::json(200, page("todo", "2026-09-29T10:00:00.000Z")),
        saved_but_503(),
        Reply::json(404, json!({ "object": "error", "status": 404, "code": "object_not_found", "message": "gone" })),
    ])
    .await;
    let (row, map) = (seen(), mapping());

    let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    let Ok(WriteOutcome::Unknown { message }) = out else { panic!("{out:?}") };
    assert!(message.contains("may have saved"), "{message}");
    assert_eq!(notion.seen().iter().filter(|s| s.method == "PATCH").count(), 1);
}

#[tokio::test]
async fn a_patch_that_never_got_an_answer_is_unknown_too() {
    // Notion closed the connection mid-reply: the request went out, so it may be saved.
    let (_notion, api) = api(vec![
        Reply::json(200, page("todo", "2026-09-29T10:00:00.000Z")),
        Reply { status: 200, headers: vec![("Content-Length".into(), "999".into())], body: "{".into() },
        Reply::json(200, page("done", "2026-09-29T10:06:00.000Z")),
    ])
    .await;
    let (row, map) = (seen(), mapping());

    let out = write_ticket(&api, request(&row, status("done"), Permission::Manage, &SourceHealth::Healthy, &map)).await;

    assert!(!matches!(out, Ok(WriteOutcome::Refused { .. })), "never 'refused' once the PATCH was sent: {out:?}");
}

// ── Trash and Undo (task "Ticket Sources 14") ───────────────────────────────

fn trashed(yes: bool) -> serde_json::Value {
    let mut p = page("todo", "2026-09-29T10:10:00.000Z");
    p["in_trash"] = json!(yes);
    p
}

fn trash_request<'a>(permission: Permission, health: &'a SourceHealth, mapping: &'a FieldMapping, trash: bool) -> TrashRequest<'a> {
    TrashRequest { data_source_id: DS, mapping, permission, health, page_id: PAGE, trash }
}

#[tokio::test]
async fn moving_to_trash_is_one_patch_of_in_trash_never_a_delete() {
    // The API cannot delete a page for good (reference/trash-page); Lotus never asks.
    let (notion, api) = api(vec![Reply::json(200, trashed(false)), Reply::json(200, trashed(true))]).await;
    let map = mapping();

    let out = trash_ticket(&api, trash_request(Permission::Manage, &SourceHealth::Healthy, &map, true)).await;

    assert!(matches!(out, Ok(WriteOutcome::Saved { .. })), "{out:?}");
    let seen = notion.seen();
    assert_eq!(seen.iter().map(|s| s.method.as_str()).collect::<Vec<_>>(), vec!["GET", "PATCH"]);
    assert_eq!(seen[1].path(), format!("/v1/pages/{PAGE}"));
    assert_eq!(seen[1].json(), json!({ "in_trash": true }), "only the page itself: sub-tickets are not touched");
}

#[tokio::test]
async fn undo_restores_it_with_in_trash_false_and_hands_back_the_row() {
    let (notion, api) = api(vec![Reply::json(200, trashed(true)), Reply::json(200, trashed(false))]).await;
    let map = mapping();

    let out = trash_ticket(&api, trash_request(Permission::Manage, &SourceHealth::Healthy, &map, false)).await;

    let Ok(WriteOutcome::Saved { row }) = out else { panic!("{out:?}") };
    assert_eq!(row.page_id, PAGE, "the ticket, to put back in the list");
    assert_eq!(notion.seen()[1].json(), json!({ "in_trash": false }));
}

#[tokio::test]
async fn trash_is_refused_before_any_request_in_read_only_or_while_fields_changed() {
    let (notion, api) = api(vec![]).await;
    let map = mapping();
    let paused = SourceHealth::FieldsChanged { fields: vec![FieldProblem::missing("status")] };

    assert_eq!(trash_ticket(&api, trash_request(Permission::ReadOnly, &SourceHealth::Healthy, &map, true)).await, Err(WriteBlocked::ReadOnly));
    assert_eq!(trash_ticket(&api, trash_request(Permission::Manage, &paused, &map, true)).await, Err(WriteBlocked::FieldsChanged));
    assert!(notion.seen().is_empty());
}

#[tokio::test]
async fn a_page_from_another_database_is_never_trashed_through_this_one() {
    let mut elsewhere = trashed(false);
    elsewhere["parent"]["data_source_id"] = json!("99999999-0000-0000-0000-000000000000");
    let (notion, api) = api(vec![Reply::json(200, elsewhere)]).await;
    let map = mapping();

    let out = trash_ticket(&api, trash_request(Permission::Manage, &SourceHealth::Healthy, &map, true)).await;

    assert!(matches!(out, Ok(WriteOutcome::Refused { .. })), "{out:?}");
    assert!(notion.seen().iter().all(|s| s.method == "GET"));
}

#[tokio::test]
async fn a_503_on_trash_is_not_repeated_the_page_says_whether_it_landed() {
    let (notion, api) = api(vec![Reply::json(200, trashed(false)), saved_but_503(), Reply::json(200, trashed(true))]).await;
    let map = mapping();

    let out = trash_ticket(&api, trash_request(Permission::Manage, &SourceHealth::Healthy, &map, true)).await;

    assert!(matches!(out, Ok(WriteOutcome::Saved { .. })), "{out:?}");
    assert_eq!(notion.seen().iter().filter(|s| s.method == "PATCH").count(), 1);
}

// ── New tickets and sub-tickets (task "Ticket Sources 15") ──────────────────

const MAIN: &str = "0a1b2c3d-0000-0000-0000-00000000000a";

fn parent_mapping() -> FieldMapping {
    FieldMapping { parent: Some("par".into()), key: Some("a%3Ab".into()), ..mapping() }
}

fn created(key: i64) -> serde_json::Value {
    let mut p = page("todo", "2026-09-29T10:20:00.000Z");
    p["id"] = json!("0a1b2c3d-0000-0000-0000-0000000000f1");
    p["properties"]["ID"] = json!({ "id": "a%3Ab", "type": "unique_id", "unique_id": { "number": key, "prefix": "TKT" } });
    p["properties"]["Parent item"] = json!({ "id": "par", "type": "relation", "relation": [{ "id": MAIN }] });
    p
}

fn create_request<'a>(map: &'a FieldMapping, permission: Permission, health: &'a SourceHealth, parent: Option<&'a str>) -> CreateRequest<'a> {
    CreateRequest { data_source_id: DS, mapping: map, permission, health, title: "Tag webhook events", status: Some("todo"), parent }
}

#[tokio::test]
async fn a_sub_ticket_is_created_in_this_database_with_its_parent_and_the_first_to_do_status() {
    let (notion, api) = api(vec![Reply::json(200, created(1013))]).await;
    let map = parent_mapping();

    let out = create_ticket(&api, create_request(&map, Permission::Manage, &SourceHealth::Healthy, Some(MAIN))).await;

    let Ok(WriteOutcome::Saved { row }) = out else { panic!("{out:?}") };
    assert_eq!(row.key.as_deref(), Some("TKT-1013"), "the key Notion gave, read from its answer");
    let seen = notion.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!((seen[0].method.as_str(), seen[0].path()), ("POST", "/v1/pages"));
    assert_eq!(
        seen[0].json(),
        json!({
            "parent": { "type": "data_source_id", "data_source_id": DS },
            "properties": {
                "title": { "title": [{ "type": "text", "text": { "content": "Tag webhook events" } }] },
                "st": { "status": { "id": "todo" } },
                "par": { "relation": [{ "id": MAIN }] }
            }
        })
    );
    assert!(seen[0].json()["properties"].get("a%3Ab").is_none(), "the key is never sent: Notion assigns it");
}

#[tokio::test]
async fn a_new_ticket_without_a_parent_has_no_relation() {
    let (notion, api) = api(vec![Reply::json(200, created(1014))]).await;
    let map = parent_mapping();

    let out = create_ticket(&api, create_request(&map, Permission::Manage, &SourceHealth::Healthy, None)).await;

    assert!(matches!(out, Ok(WriteOutcome::Saved { .. })), "{out:?}");
    assert!(notion.seen()[0].json()["properties"].get("par").is_none());
}

#[tokio::test]
async fn a_503_that_created_the_page_is_read_by_its_id_never_created_twice() {
    // reference/request-limits: after a create that answered 503, `committed_resource_id` is the new page.
    let committed = Reply::json(503, json!({
        "object": "error", "status": 503, "code": "service_unavailable",
        "message": "The change was saved, but the response could not be built in time.",
        "additional_data": { "committed_resource_id": "0a1b2c3d-0000-0000-0000-0000000000f1", "retry_guidance": ["Read the object again.", "Do not repeat the write."] }
    }));
    let (notion, api) = api(vec![committed, Reply::json(200, created(1013))]).await;
    let map = parent_mapping();

    let out = create_ticket(&api, create_request(&map, Permission::Manage, &SourceHealth::Healthy, Some(MAIN))).await;

    let Ok(WriteOutcome::Saved { row }) = out else { panic!("{out:?}") };
    assert_eq!(row.key.as_deref(), Some("TKT-1013"));
    let methods: Vec<_> = notion.seen().iter().map(|s| (s.method.clone(), s.path().to_string())).collect();
    assert_eq!(methods, vec![("POST".into(), "/v1/pages".into()), ("GET".into(), "/v1/pages/0a1b2c3d-0000-0000-0000-0000000000f1".into())]);
}

#[tokio::test]
async fn a_503_that_names_no_page_is_unknown_and_not_repeated() {
    let (notion, api) = api(vec![Reply::json(503, json!({ "object": "error", "status": 503, "code": "service_unavailable", "message": "Notion is unavailable" }))]).await;
    let map = parent_mapping();

    let out = create_ticket(&api, create_request(&map, Permission::Manage, &SourceHealth::Healthy, None)).await;

    let Ok(WriteOutcome::Unknown { message }) = out else { panic!("{out:?}") };
    assert!(message.contains("may have created"), "{message}");
    assert_eq!(notion.seen().len(), 1, "one POST, never two");
}

#[tokio::test]
async fn nothing_is_created_in_read_only_or_while_fields_changed_or_without_a_parent_field() {
    let (notion, api) = api(vec![]).await;
    let map = parent_mapping();
    let paused = SourceHealth::FieldsChanged { fields: vec![FieldProblem::missing("status")] };

    assert_eq!(create_ticket(&api, create_request(&map, Permission::ReadOnly, &SourceHealth::Healthy, None)).await, Err(WriteBlocked::ReadOnly));
    assert_eq!(create_ticket(&api, create_request(&map, Permission::Manage, &paused, None)).await, Err(WriteBlocked::FieldsChanged));
    let no_parent = mapping();
    assert_eq!(
        create_ticket(&api, create_request(&no_parent, Permission::Manage, &SourceHealth::Healthy, Some(MAIN))).await,
        Err(WriteBlocked::NotMapped("parent".into()))
    );
    let mut blank = create_request(&map, Permission::Manage, &SourceHealth::Healthy, None);
    blank.title = "   ";
    assert_eq!(create_ticket(&api, blank).await, Err(WriteBlocked::NoTitle));
    assert!(notion.seen().is_empty());
}

#[test]
fn a_new_ticket_starts_in_the_first_status_of_the_to_do_group() {
    let schema = DataSourceSchema::from_json(&json!({
        "object": "data_source", "id": DS, "title": [],
        "properties": {
            "Name": { "id": "title", "name": "Name", "type": "title", "title": {} },
            "Status": { "id": "st", "name": "Status", "type": "status", "status": {
                "options": [{ "id": "done", "name": "Done" }, { "id": "backlog", "name": "Backlog" }, { "id": "todo", "name": "Todo" }],
                "groups": [
                    { "id": "g3", "name": "Complete", "option_ids": ["done"] },
                    { "id": "g1", "name": "To-do", "option_ids": ["backlog", "todo"] }
                ]
            } }
        }
    }))
    .unwrap();
    assert_eq!(schema.first_to_do(&schema.suggest_mapping()), Some("backlog".into()), "by the group, not the list order");
    assert_eq!(schema.first_to_do(&FieldMapping { status: None, ..schema.suggest_mapping() }), None);
}
