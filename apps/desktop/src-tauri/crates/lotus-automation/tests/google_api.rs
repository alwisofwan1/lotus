//! Sheets and Drive calls (plans/google-connector PLAN G10, G11, G15),
//! checked against a fake Google for the exact URL, query and body.

mod google_fake;

use std::sync::Arc;

use google_fake::{FakeGoogle, Reply};
use lotus_automation::google::api::{cell, multipart_related, tab_range, GoogleApi, Upload};
use lotus_automation::google::auth::{AccessKeeper, OAuthClient};
use lotus_automation::google::Endpoints;
use serde_json::json;

fn token_reply(token: &str) -> Reply {
    Reply::json(200, json!({ "access_token": token, "expires_in": 3599 }))
}

async fn api(replies: Vec<Reply>) -> (FakeGoogle, GoogleApi) {
    let google = FakeGoogle::start(replies).await;
    let keychain_refresh = {
        use lotus_automation::secrets::SecretStore;
        struct One;
        impl SecretStore for One {
            fn get(&self, _: &str) -> Result<Option<String>, String> {
                Ok(Some(json!({ "refresh": "1//refresh", "email": null, "scopes": [], "connected_at_ms": 0 }).to_string()))
            }
            fn set(&self, _: &str, _: &str) -> Result<(), String> {
                Ok(())
            }
            fn delete(&self, _: &str) -> Result<(), String> {
                Ok(())
            }
        }
        lotus_automation::google::auth::load_google_account(&One).unwrap().unwrap().refresh
    };
    let keeper = AccessKeeper::new(reqwest::Client::new(), OAuthClient::new("id", "secret"), Endpoints::at(&google.base), keychain_refresh);
    (google, GoogleApi::new(Arc::new(keeper)))
}

fn rows(list: &[&[&str]]) -> Vec<Vec<String>> {
    list.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect()
}

#[test]
fn text_that_would_start_a_formula_stays_text() {
    assert_eq!(cell("=IMPORTXML(\"https://evil.example\",\"//a\")"), "'=IMPORTXML(\"https://evil.example\",\"//a\")");
    assert_eq!(cell("+1 555"), "'+1 555");
    assert_eq!(cell("@here"), "'@here");
    assert_eq!(cell("-- deploy failed"), "'-- deploy failed");
    assert_eq!(cell("-12.5"), "-12.5", "a negative number stays a number");
    assert_eq!(cell("820 ms"), "820 ms");
    assert_eq!(cell("2026-09-28"), "2026-09-28", "dates still parse as dates");
    assert_eq!(cell(""), "");
}

#[test]
fn a_tab_name_is_quoted_for_a1_notation() {
    assert_eq!(tab_range("Daily"), "'Daily'");
    assert_eq!(tab_range("Alwi's log"), "'Alwi''s log'");
}

#[tokio::test]
async fn rows_are_appended_as_new_rows_after_the_table() {
    let (google, api) = api(vec![
        token_reply("ya29.one"),
        Reply::json(200, json!({ "spreadsheetId": "SHEET1", "updates": { "updatedRange": "'Daily log'!A201:C202", "updatedRows": 2 } })),
    ])
    .await;

    let done = api
        .append_rows("SHEET1", "Daily log", &rows(&[&["2026-09-28", "checkout-api", "=HYPERLINK(\"x\")"], &["2026-09-28", "payments", "up"]]))
        .await
        .unwrap();

    assert_eq!((done.range.as_str(), done.rows), ("'Daily log'!A201:C202", 2));
    let req = &google.seen()[1];
    assert_eq!(req.method, "POST");
    assert_eq!(req.path(), "/v4/spreadsheets/SHEET1/values/'Daily%20log':append");
    assert_eq!(req.query("valueInputOption").as_deref(), Some("USER_ENTERED"));
    assert_eq!(req.query("insertDataOption").as_deref(), Some("INSERT_ROWS"));
    assert_eq!(req.query("includeValuesInResponse").as_deref(), Some("false"));
    assert_eq!(req.header("authorization"), Some("Bearer ya29.one"));
    assert_eq!(
        req.json(),
        json!({ "majorDimension": "ROWS", "values": [["2026-09-28", "checkout-api", "'=HYPERLINK(\"x\")"], ["2026-09-28", "payments", "up"]] })
    );
}

#[tokio::test]
async fn a_refused_access_token_is_refreshed_once_and_the_call_repeated() {
    let (google, api) = api(vec![
        token_reply("ya29.stale"),
        Reply::json(401, json!({ "error": { "code": 401, "message": "Request had invalid authentication credentials." } })),
        token_reply("ya29.fresh"),
        Reply::json(200, json!({ "updates": { "updatedRange": "'Daily'!A2:A2", "updatedRows": 1 } })),
    ])
    .await;

    api.append_rows("S", "Daily", &rows(&[&["x"]])).await.unwrap();

    let seen = google.seen();
    assert_eq!(seen.iter().map(|s| s.path()).collect::<Vec<_>>(), vec!["/token", "/v4/spreadsheets/S/values/'Daily':append", "/token", "/v4/spreadsheets/S/values/'Daily':append"]);
    assert_eq!(seen[3].header("authorization"), Some("Bearer ya29.fresh"));
}

#[tokio::test]
async fn a_second_refusal_asks_the_user_to_reconnect() {
    let refused = || Reply::json(401, json!({ "error": { "code": 401, "message": "no" } }));
    let (_google, api) = api(vec![token_reply("ya29.a"), refused(), token_reply("ya29.b"), refused()]).await;
    let err = api.append_rows("S", "Daily", &rows(&[&["x"]])).await.unwrap_err();
    assert!(err.needs_reconnect(), "{err}");
}

#[tokio::test]
async fn one_rate_limit_is_waited_out() {
    let (google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(429, json!({ "error": { "code": 429, "message": "Quota exceeded" } })).with_header("Retry-After", "0"),
        Reply::json(200, json!({ "updates": { "updatedRange": "'Daily'!A2:A2", "updatedRows": 1 } })),
    ])
    .await;
    assert_eq!(api.append_rows("S", "Daily", &rows(&[&["x"]])).await.unwrap().rows, 1);
    assert_eq!(google.seen().len(), 3);
}

#[tokio::test]
async fn a_deleted_sheet_is_reported_in_words_the_user_can_act_on() {
    let (_google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(404, json!({ "error": { "code": 404, "message": "Requested entity was not found.", "status": "NOT_FOUND" } })),
    ])
    .await;
    let err = api.append_rows("GONE", "Daily", &rows(&[&["x"]])).await.unwrap_err();
    assert!(!err.needs_reconnect());
    assert!(err.to_string().contains("deleted or Lotus has no access"), "{err}");
    assert!(err.to_string().contains("Requested entity was not found."), "{err}");
}

#[tokio::test]
async fn a_new_sheet_gets_its_tab_and_header_row() {
    let (google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(200, json!({ "spreadsheetId": "NEW1", "spreadsheetUrl": "https://docs.google.com/spreadsheets/d/NEW1/edit" })),
        Reply::json(200, json!({ "updates": { "updatedRange": "'Daily'!A1:C1", "updatedRows": 1 } })),
    ])
    .await;

    let sheet = api.create_spreadsheet("Daily service monitoring — log", "Daily", &["Date".into(), "Service".into(), "Status".into()]).await.unwrap();

    assert_eq!((sheet.id.as_str(), sheet.url.as_str()), ("NEW1", "https://docs.google.com/spreadsheets/d/NEW1/edit"));
    let seen = google.seen();
    assert_eq!(seen[1].path(), "/v4/spreadsheets");
    assert_eq!(seen[1].json(), json!({ "properties": { "title": "Daily service monitoring — log" }, "sheets": [{ "properties": { "title": "Daily" } }] }));
    assert_eq!(seen[2].path(), "/v4/spreadsheets/NEW1/values/'Daily':append");
    assert_eq!(seen[2].json()["values"], json!([["Date", "Service", "Status"]]));
}

#[tokio::test]
async fn a_folder_is_created_where_asked() {
    let (google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(200, json!({ "id": "F1", "name": "Lotus reports", "webViewLink": "https://drive.google.com/drive/folders/F1" })),
    ])
    .await;
    let folder = api.create_folder("Lotus reports", Some("PARENT")).await.unwrap();
    assert_eq!(folder.url, "https://drive.google.com/drive/folders/F1");
    let req = &google.seen()[1];
    assert_eq!((req.path(), req.query("fields").as_deref()), ("/drive/v3/files", Some("id,name,webViewLink")));
    assert_eq!(req.json(), json!({ "name": "Lotus reports", "mimeType": "application/vnd.google-apps.folder", "parents": ["PARENT"] }));
}

#[tokio::test]
async fn a_report_is_uploaded_into_the_folder_and_converted_to_a_google_doc() {
    let (google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(200, json!({ "id": "D1", "name": "Daily service monitoring — 2026-09-28", "webViewLink": "https://docs.google.com/document/d/D1/edit" })),
    ])
    .await;
    let name = Upload::GoogleDoc.file_name("Daily service monitoring — 2026-09-28");

    let file = api.upload_file("F1", &name, "# All up\n\n- checkout-api: 820 ms".as_bytes(), Upload::GoogleDoc).await.unwrap();

    assert_eq!(file.id, "D1");
    let req = &google.seen()[1];
    assert_eq!((req.path(), req.query("uploadType").as_deref()), ("/upload/drive/v3/files", Some("multipart")));
    let content_type = req.header("content-type").unwrap();
    let boundary = content_type.strip_prefix("multipart/related; boundary=").expect(content_type);
    let body = req.text();
    let parts: Vec<&str> = body.split(&format!("--{boundary}")).collect();
    assert_eq!(parts.len(), 4, "preamble, metadata, content, closing: {body}");
    let (meta_head, meta) = parts[1].split_once("\r\n\r\n").unwrap();
    assert!(meta_head.contains("application/json"));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(meta.trim()).unwrap(),
        json!({ "name": "Daily service monitoring — 2026-09-28", "parents": ["F1"], "mimeType": "application/vnd.google-apps.document" })
    );
    let (content_head, content) = parts[2].split_once("\r\n\r\n").unwrap();
    assert!(content_head.contains("Content-Type: text/markdown"));
    assert_eq!(content, "# All up\n\n- checkout-api: 820 ms\r\n");
    assert_eq!(parts[3], "--\r\n");
}

#[tokio::test]
async fn a_report_over_five_megabytes_is_refused_before_any_request() {
    let (google, api) = api(vec![]).await;
    let err = api.upload_file("F1", "big", &vec![b'a'; 5 * 1024 * 1024 + 1], Upload::Markdown).await.unwrap_err();
    assert!(err.to_string().contains("5 MB"), "{err}");
    assert!(google.seen().is_empty());
}

#[test]
fn kept_files_carry_their_extension_and_converted_ones_do_not() {
    assert_eq!(Upload::Markdown.file_name("r"), "r.md");
    assert_eq!(Upload::Csv.file_name("r"), "r.csv");
    assert_eq!(Upload::GoogleSheet.file_name("r"), "r");
}

#[test]
fn the_multipart_boundary_never_appears_in_the_content() {
    let (boundary, body) = multipart_related(&json!({ "name": "x" }), "text/csv", b"a,b\n1,2");
    assert!(boundary.starts_with("lotus-"));
    assert_eq!(String::from_utf8(body).unwrap().matches(&boundary).count(), 3);
}

#[tokio::test]
async fn a_picked_file_is_named_and_linked() {
    let (google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(200, json!({ "id": "S7", "name": "Ops log", "webViewLink": "https://docs.google.com/spreadsheets/d/S7/edit" })),
    ])
    .await;
    let file = api.file("S7").await.unwrap();
    assert_eq!((file.name.as_str(), file.url.as_str()), ("Ops log", "https://docs.google.com/spreadsheets/d/S7/edit"));
    let req = &google.seen()[1];
    assert_eq!((req.method.as_str(), req.path(), req.query("fields").as_deref()), ("GET", "/drive/v3/files/S7", Some("id,name,webViewLink")));
}

#[tokio::test]
async fn a_picked_sheet_is_read_for_its_tabs_and_header() {
    let (google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(200, json!({ "sheets": [{ "properties": { "title": "Sheet1" } }, { "properties": { "title": "Old" } }] })),
        Reply::json(200, json!({ "range": "'Sheet1'!1:1", "values": [["Date", "Item", " Status ", ""]] })),
    ])
    .await;
    assert_eq!(api.sheet_tabs("S7").await.unwrap(), vec!["Sheet1", "Old"]);
    assert_eq!(api.header_row("S7", "Sheet1").await.unwrap(), vec!["Date", "Item", "Status"], "trimmed, blanks dropped");
    let seen = google.seen();
    assert_eq!((seen[1].path(), seen[1].query("fields").as_deref()), ("/v4/spreadsheets/S7", Some("sheets.properties.title")));
    assert_eq!(seen[2].path(), "/v4/spreadsheets/S7/values/'Sheet1'!1:1");
}

#[tokio::test]
async fn a_missing_tab_is_named_in_the_error() {
    let (_google, api) = api(vec![
        token_reply("ya29.a"),
        Reply::json(400, json!({ "error": { "code": 400, "message": "Unable to parse range: 'Daily'", "status": "INVALID_ARGUMENT" } })),
    ])
    .await;
    let err = api.append_rows("S7", "Daily", &rows(&[&["x"]])).await.unwrap_err();
    assert!(err.to_string().contains("the sheet has no tab \"Daily\""), "{err}");
}
