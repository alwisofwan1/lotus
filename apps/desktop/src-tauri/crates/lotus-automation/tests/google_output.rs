//! Google as an `agent_prompt` output (plans/google-connector PLAN G9–G14):
//! rows to a Sheet and a report file to Drive, written by Lotus, never by the
//! agent; a failed write never fails the run and is sent again on its own.

mod common;

use std::sync::{Arc, Mutex};

use common::*;
use lotus_automation::agent_prompt::{new_agent_prompt_automation, AgentPromptAction, AgentPromptForm, DriveForm, SelfMessenger, SheetForm};
use lotus_automation::google::api::Upload;
use lotus_automation::google::output::{file_stem, resend, to_csv, DriveFormat, GoogleWriter};
use lotus_automation::google::GoogleError;
use lotus_automation::{BoxFuture, Engine, EngineConfig, NewAutomation, Registry, RunStatus, Spec, Submitted};
use serde_json::{json, Value};

#[derive(Default)]
struct Dm(Mutex<Vec<String>>);
impl SelfMessenger for Dm {
    fn dm_self(&self, text: &str) -> BoxFuture<Result<(), String>> {
        self.0.lock().unwrap().push(text.to_string());
        Box::pin(async { Ok(()) })
    }
}

/// One `append_rows` call: sheet, tab, rows.
type Append = (String, String, Vec<Vec<String>>);

/// Records every write; fails the sheet while `sheet_down` is set.
#[derive(Default)]
struct FakeGoogle {
    appends: Mutex<Vec<Append>>,
    files: Mutex<Vec<(String, String, String, Upload)>>,
    sheet_down: Mutex<Option<GoogleError>>,
}

impl GoogleWriter for FakeGoogle {
    fn append_rows(&self, id: &str, tab: &str, rows: &[Vec<String>]) -> BoxFuture<Result<String, GoogleError>> {
        let down = self.sheet_down.lock().unwrap().clone();
        if down.is_none() {
            self.appends.lock().unwrap().push((id.into(), tab.into(), rows.to_vec()));
        }
        let url = format!("https://docs.google.com/spreadsheets/d/{id}/edit");
        Box::pin(async move { down.map_or(Ok(url), Err) })
    }
    fn save_file(&self, folder: &str, name: &str, content: Vec<u8>, kind: Upload) -> BoxFuture<Result<String, GoogleError>> {
        self.files.lock().unwrap().push((folder.into(), name.into(), String::from_utf8(content).unwrap(), kind));
        Box::pin(async { Ok("https://docs.google.com/document/d/D1/edit".to_string()) })
    }
}

struct Setup {
    w: World,
    dm: Arc<Dm>,
    google: Arc<FakeGoogle>,
    engine: Engine,
    automation_id: String,
}

fn setup(config: Value, reply: Value, connected: bool) -> Setup {
    let w = world_with(open_pr(), Reply::Json(reply), Default::default());
    let dm = Arc::new(Dm::default());
    let google = Arc::new(FakeGoogle::default());
    let mut action = AgentPromptAction::new(w.github.clone(), w.agent.clone(), dm.clone());
    if connected {
        action = action.with_google(google.clone());
    }
    let engine = Engine::new(
        Arc::clone(&w.store),
        Registry::new().with_action(action),
        Arc::new(lotus_automation::SystemClock),
        EngineConfig { retry_delays: vec![], ..EngineConfig::default() },
    );
    let automation = w
        .store
        .create_automation(
            NewAutomation {
                name: "Daily service monitoring".into(),
                trigger: Spec::new("schedule", json!({ "cron": "0 9 * * 1-5", "timezone": "Asia/Jakarta" })),
                action: Spec::new("agent_prompt", config),
                outputs: vec![],
            },
            1,
        )
        .unwrap();
    Setup { w, dm, google, engine, automation_id: automation.id }
}

/// 2026-09-28 02:00 UTC = Monday 09:00 in Asia/Jakarta.
const MONDAY_0900_JAKARTA: i64 = 1_790_560_800_000;

async fn run(s: &Setup) -> lotus_automation::Run {
    let payload = json!({ "scheduled_at_ms": MONDAY_0900_JAKARTA });
    let Submitted::Started { run_id } = s.engine.submit(&s.automation_id, "schedule@1", payload).await.unwrap() else { panic!() };
    s.engine.drain().await;
    s.w.store.get_run(&run_id).unwrap().unwrap()
}

fn config(sheet: bool, drive: Option<&str>) -> Value {
    let mut c = json!({
        "preset_id": "preset_alwi",
        "prompt": "Check every production service and report its health.",
        "dm_self": true,
    });
    if sheet {
        c["google_sheet"] = json!({ "spreadsheet_id": "SHEET1", "tab": "Daily", "columns": ["Date", "Service", "Status"] });
    }
    if let Some(format) = drive {
        c["google_drive"] = json!({ "folder_id": "FOLDER1", "format": format });
    }
    c
}

fn reply_with_rows() -> Value {
    json!({
        "text": "All up. checkout-api is slow.",
        "rows": [["2026-09-28", "checkout-api", "slow"], ["2026-09-28", "payments", "up"]]
    })
}

#[tokio::test]
async fn rows_go_to_the_sheet_and_the_report_to_drive_after_the_dm() {
    let s = setup(config(true, Some("google_doc")), reply_with_rows(), true);
    let run = run(&s).await;

    assert_eq!(run.status, RunStatus::Succeeded);
    assert_eq!(*s.dm.0.lock().unwrap(), vec!["All up. checkout-api is slow.".to_string()]);
    let appends = s.google.appends.lock().unwrap().clone();
    assert_eq!(appends.len(), 1);
    assert_eq!((appends[0].0.as_str(), appends[0].1.as_str()), ("SHEET1", "Daily"));
    assert_eq!(appends[0].2[0], vec!["2026-09-28", "checkout-api", "slow"]);
    let files = s.google.files.lock().unwrap().clone();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "FOLDER1");
    assert_eq!(files[0].1, "Daily service monitoring — 2026-09-28 09.00", "a Google Doc has no extension; the time is the run's planned one, in Jakarta");
    assert_eq!(files[0].2, "All up. checkout-api is slow.");
    assert_eq!(files[0].3, Upload::GoogleDoc);

    let draft = s.w.store.draft_for_run(&run.id).unwrap().unwrap();
    assert_eq!(draft.content["google"]["sheet"]["status"], "sent");
    assert_eq!(draft.content["google"]["sheet"]["url"], "https://docs.google.com/spreadsheets/d/SHEET1/edit");
    assert_eq!(draft.content["google"]["drive"]["status"], "sent");
    assert!(run.detail.as_deref().unwrap_or_default().contains("Google: sheet +2 rows, file saved"), "{:?}", run.detail);
}

#[tokio::test]
async fn the_agent_is_told_the_columns_and_the_schema_holds_it_to_them() {
    let s = setup(config(true, None), reply_with_rows(), true);
    run(&s).await;
    let seen = s.w.agent.seen.lock().unwrap();
    assert!(seen[0].prompt.contains(r#"exactly 3 values in this order: "Date", "Service", "Status""#), "{}", seen[0].prompt);
    let rows = &seen[0].schema["properties"]["rows"];
    assert_eq!((rows["items"]["minItems"].as_u64(), rows["items"]["maxItems"].as_u64()), (Some(3), Some(3)));
    assert_eq!(seen[0].schema["maxProperties"], 2);
}

#[tokio::test]
async fn a_row_of_the_wrong_length_fails_the_run_before_anything_is_written() {
    let bad = json!({ "text": "x", "rows": [["2026-09-28", "checkout-api"]] });
    let s = setup(config(true, Some("google_doc")), bad, true);
    let run = run(&s).await;
    assert_eq!(run.status, RunStatus::Failed);
    assert!(run.detail.as_deref().unwrap_or_default().contains("row 1: 2 cells, but the sheet has 3 columns"), "{:?}", run.detail);
    assert!(s.google.appends.lock().unwrap().is_empty() && s.google.files.lock().unwrap().is_empty());
    assert!(s.dm.0.lock().unwrap().is_empty(), "nothing is delivered from a bad result");
}

#[tokio::test]
async fn rows_are_refused_from_an_automation_without_a_sheet() {
    let s = setup(config(false, None), reply_with_rows(), true);
    assert_eq!(run(&s).await.status, RunStatus::Failed);
}

#[tokio::test]
async fn a_failed_sheet_write_keeps_the_run_and_is_sent_again_alone() {
    let s = setup(config(true, Some("google_doc")), reply_with_rows(), true);
    *s.google.sheet_down.lock().unwrap() = Some(GoogleError::Failed("append rows: the file was deleted or Lotus has no access to it".into()));
    let run = run(&s).await;

    assert_eq!(run.status, RunStatus::Succeeded, "a Google failure never fails the run (no retry, no second agent run)");
    assert_eq!(s.w.agent.seen.lock().unwrap().len(), 1);
    assert_eq!(s.dm.0.lock().unwrap().len(), 1, "the DM still went out");
    let draft = s.w.store.draft_for_run(&run.id).unwrap().unwrap();
    assert_eq!(draft.content["google"]["sheet"]["status"], "not_sent");
    assert!(draft.content["google"]["sheet"]["detail"].as_str().unwrap().contains("deleted or Lotus has no access"));
    assert_eq!(draft.content["google"]["drive"]["status"], "sent");
    assert!(run.detail.as_deref().unwrap_or_default().contains("sheet not sent"), "{:?}", run.detail);

    *s.google.sheet_down.lock().unwrap() = None;
    let google = resend(&s.w.store, Some(s.google.as_ref() as &dyn GoogleWriter), &draft.id).await.unwrap();
    assert_eq!(google["sheet"]["status"], "sent");
    assert_eq!(s.google.appends.lock().unwrap().len(), 1, "the rows went once");
    assert_eq!(s.google.files.lock().unwrap().len(), 1, "the file that already went was not saved again");
    assert_eq!(s.w.store.get_draft(&draft.id).unwrap().unwrap().content["google"]["sheet"]["status"], "sent", "kept");

    let again = resend(&s.w.store, Some(s.google.as_ref() as &dyn GoogleWriter), &draft.id).await.unwrap_err();
    assert!(again.contains("already went"), "{again}");
    assert_eq!(s.google.appends.lock().unwrap().len(), 1, "a second press adds nothing");
}

#[tokio::test]
async fn without_a_google_connection_the_outputs_wait_to_be_sent() {
    let s = setup(config(true, Some("markdown")), reply_with_rows(), false);
    let run = run(&s).await;
    assert_eq!(run.status, RunStatus::Succeeded);
    let draft = s.w.store.draft_for_run(&run.id).unwrap().unwrap();
    for key in ["sheet", "drive"] {
        assert_eq!(draft.content["google"][key]["status"], "not_sent", "{key}");
        assert_eq!(draft.content["google"][key]["reconnect"], true, "{key}");
    }
}

#[tokio::test]
async fn a_csv_report_is_the_rows_under_the_sheet_columns() {
    let s = setup(config(true, Some("csv")), reply_with_rows(), true);
    run(&s).await;
    let files = s.google.files.lock().unwrap().clone();
    assert_eq!(files[0].1, "Daily service monitoring — 2026-09-28 09.00.csv");
    assert_eq!(files[0].2, "Date,Service,Status\r\n2026-09-28,checkout-api,slow\r\n2026-09-28,payments,up\r\n");
    assert_eq!(files[0].3, Upload::Csv);
}

#[tokio::test]
async fn nothing_to_report_writes_nothing() {
    let s = setup(config(true, Some("google_doc")), json!({ "nothing_to_report": "all quiet" }), true);
    assert_eq!(run(&s).await.status, RunStatus::Skipped);
    assert!(s.google.appends.lock().unwrap().is_empty() && s.google.files.lock().unwrap().is_empty());
}

#[test]
fn csv_cells_are_quoted_and_never_start_a_formula() {
    let csv = to_csv(&["A".into(), "B".into()], &[vec!["=HYPERLINK(\"x\")".into(), "a, \"b\"\nc".into()]]);
    assert_eq!(csv, "A,B\r\n\"'=HYPERLINK(\"\"x\"\")\",\"a, \"\"b\"\"\nc\"\r\n");
}

#[test]
fn the_file_name_carries_the_date_and_time_in_the_automation_time_zone() {
    // 2026-09-27 20:00 UTC is already 03:00 on the 28th in Jakarta. A dot, not a colon: a colon
    // breaks the name once the file is downloaded to macOS or Windows.
    assert_eq!(file_stem("Daily / ops", 1_790_539_200_000, Some("Asia/Jakarta")), "Daily - ops — 2026-09-28 03.00");
    assert_eq!(file_stem("Daily", 1_790_539_200_000, None), "Daily — 2026-09-27 20.00");
}

fn form() -> AgentPromptForm {
    serde_json::from_value(json!({
        "prompt": "Check every production service.",
        "presetId": "preset_alwi",
        "days": ["mon", "tue", "wed", "thu", "fri"],
        "time": "09:00",
        "timezone": "Asia/Jakarta",
        "dmSelf": true,
        "googleSheet": { "spreadsheetId": " SHEET1 ", "tab": "Daily", "columns": ["Date", " Service ", "Status"] },
        "googleDrive": { "folderId": "FOLDER1", "format": "csv" }
    }))
    .unwrap()
}

#[test]
fn the_form_keeps_the_google_outputs_trimmed() {
    let new = new_agent_prompt_automation(form()).unwrap();
    assert_eq!(new.action.config["google_sheet"], json!({ "spreadsheet_id": "SHEET1", "tab": "Daily", "columns": ["Date", "Service", "Status"] }));
    assert_eq!(new.action.config["google_drive"], json!({ "folder_id": "FOLDER1", "format": "csv" }));
}

#[test]
fn the_form_refuses_google_outputs_that_cannot_work() {
    let with_sheet = |columns: Vec<&str>| AgentPromptForm {
        google_sheet: Some(SheetForm { spreadsheet_id: "S".into(), tab: "Daily".into(), columns: columns.into_iter().map(String::from).collect() }),
        ..form()
    };
    let cases = [
        ("name 1 to 26 columns", with_sheet(vec![])),
        ("named twice", with_sheet(vec!["Date", "date"])),
        ("has no name", with_sheet(vec!["Date", " "])),
        ("choose a sheet", AgentPromptForm { google_sheet: Some(SheetForm { spreadsheet_id: " ".into(), tab: "Daily".into(), columns: vec!["A".into()] }), ..form() }),
        ("needs the sheet's columns", AgentPromptForm { google_sheet: None, ..form() }),
        ("choose a folder", AgentPromptForm { google_drive: Some(DriveForm { folder_id: "".into(), format: DriveFormat::GoogleDoc }), ..form() }),
    ];
    for (why, bad) in cases {
        let err = new_agent_prompt_automation(bad).unwrap_err();
        assert!(err.contains(why), "{why}: {err}");
    }
}

mod ready_form {
    use lotus_automation::google::output::ready_form;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    fn form(sheet_id: &str) -> Value {
        json!({
            "name": "Daily service monitoring",
            "prompt": "Check every production service.",
            "presetId": "preset_alwi",
            "days": ["mon"], "time": "09:00", "timezone": "Asia/Jakarta",
            "googleSheet": { "spreadsheetId": sheet_id, "tab": "Daily", "columns": ["Date", " Status "] },
            "googleDrive": { "folderId": "root" }
        })
    }

    #[tokio::test]
    async fn a_new_sheet_is_made_on_save_named_after_the_automation() {
        let made = Mutex::new(vec![]);
        let mut f = form("new");
        ready_form("agent_prompt", &mut f, true, |name, tab, columns| {
            made.lock().unwrap().push((name, tab, columns));
            async { Ok("SHEET9".to_string()) }
        })
        .await
        .unwrap();
        assert_eq!(f["googleSheet"]["spreadsheetId"], "SHEET9");
        assert_eq!(*made.lock().unwrap(), vec![("Daily service monitoring".to_string(), "Daily".to_string(), vec!["Date".to_string(), "Status".to_string()])]);
    }

    #[tokio::test]
    async fn an_invalid_form_leaves_no_stray_sheet() {
        let mut f = form("new");
        f["time"] = json!("9am");
        let err = ready_form("agent_prompt", &mut f, true, |_, _, _| async { panic!("no sheet may be made") }).await.unwrap_err();
        assert!(err.contains("time"), "{err}");
        assert_eq!(f["googleSheet"]["spreadsheetId"], "new");
    }

    #[tokio::test]
    async fn google_outputs_need_google_connected() {
        let err = ready_form("agent_prompt", &mut form("SHEET1"), false, |_, _, _| async { panic!() }).await.unwrap_err();
        assert!(err.contains("connect Google in Connectors first"), "{err}");
        let mut plain = form("new");
        plain["googleSheet"] = Value::Null;
        plain["googleDrive"] = Value::Null;
        ready_form("agent_prompt", &mut plain, false, |_, _, _| async { panic!() }).await.unwrap();
    }

    #[tokio::test]
    async fn a_sheet_that_already_exists_is_kept() {
        let mut f = form("SHEET1");
        ready_form("agent_prompt", &mut f, true, |_, _, _| async { panic!("no new sheet") }).await.unwrap();
        assert_eq!(f["googleSheet"]["spreadsheetId"], "SHEET1");
        ready_form("pr_review", &mut form("new"), false, |_, _, _| async { panic!() }).await.unwrap();
    }
}
