//! Google as an `agent_prompt` output (plans/google-connector PLAN G9–G14):
//! rows appended to one Sheet, and/or one report file per run in a Drive
//! folder. The agent only returns data; this module writes it, through a
//! [`GoogleWriter`] port the app implements with the user's sign-in.
//!
//! Delivery never fails the run: a failed write is recorded as "not sent"
//! with its reason, and [`resend`] repeats only that write — never the agent,
//! so a retry can never add the same rows twice.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::api::{cell, Upload};
use super::GoogleError;
use crate::registry::BoxFuture;
use crate::store::Store;

/// A sheet id the app replaces with a sheet it creates when the automation is saved.
pub const NEW_SHEET: &str = "new";

/// Most rows one run may append.
pub const MAX_ROWS: usize = 500;
/// Most columns a sheet output may name (A–Z).
pub const MAX_COLUMNS: usize = 26;
/// Longest cell the agent may send.
const MAX_CELL_CHARS: usize = 1_000;

/// `google_sheet` in an `agent_prompt` config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SheetOutput {
    pub spreadsheet_id: String,
    /// The tab rows are appended to.
    pub tab: String,
    /// The columns every row has, in order. The agent's rows must match.
    pub columns: Vec<String>,
}

/// `google_drive` in an `agent_prompt` config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DriveOutput {
    pub folder_id: String,
    #[serde(default)]
    pub format: DriveFormat,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriveFormat {
    /// The result text, as a Google Doc.
    #[default]
    GoogleDoc,
    /// The result text, as a `.md` file.
    Markdown,
    /// The rows (with the sheet's columns as header), as a `.csv` file.
    Csv,
}

impl DriveFormat {
    fn upload(self) -> Upload {
        match self {
            Self::GoogleDoc => Upload::GoogleDoc,
            Self::Markdown => Upload::Markdown,
            Self::Csv => Upload::Csv,
        }
    }
}

/// What the app gives the action to write with: the connected user's Google.
pub trait GoogleWriter: Send + Sync {
    /// Appends rows; returns the sheet's URL.
    fn append_rows(&self, spreadsheet_id: &str, tab: &str, rows: &[Vec<String>]) -> BoxFuture<Result<String, GoogleError>>;
    /// Uploads a file into a folder; returns the file's URL.
    fn save_file(&self, folder_id: &str, name: &str, content: Vec<u8>, kind: Upload) -> BoxFuture<Result<String, GoogleError>>;
}

/// Checks a sheet output as the user configured it.
pub fn check_sheet(sheet: &SheetOutput) -> Result<SheetOutput, String> {
    let spreadsheet_id = sheet.spreadsheet_id.trim().to_string();
    if spreadsheet_id.is_empty() {
        return Err("google sheet: choose a sheet".into());
    }
    let tab = sheet.tab.trim().to_string();
    if tab.is_empty() {
        return Err("google sheet: name the tab rows go to".into());
    }
    let columns: Vec<String> = sheet.columns.iter().map(|c| c.trim().to_string()).collect();
    if columns.is_empty() || columns.len() > MAX_COLUMNS {
        return Err(format!("google sheet: name 1 to {MAX_COLUMNS} columns"));
    }
    if columns.iter().any(String::is_empty) {
        return Err("google sheet: a column has no name".into());
    }
    let mut seen = std::collections::HashSet::new();
    if let Some(dup) = columns.iter().find(|c| !seen.insert(c.to_lowercase())) {
        return Err(format!("google sheet: the column {dup:?} is named twice"));
    }
    Ok(SheetOutput { spreadsheet_id, tab, columns })
}

pub fn check_drive(drive: &DriveOutput, sheet: Option<&SheetOutput>) -> Result<DriveOutput, String> {
    let folder_id = drive.folder_id.trim().to_string();
    if folder_id.is_empty() {
        return Err("google drive: choose a folder".into());
    }
    if drive.format == DriveFormat::Csv && sheet.is_none() {
        return Err("google drive: a CSV file needs the sheet's columns; add a Google Sheet output or pick another format".into());
    }
    Ok(DriveOutput { folder_id, format: drive.format })
}

/// The `rows` part of the result schema: exactly `columns` strings per row.
pub fn rows_schema(columns: usize) -> Value {
    json!({
        "type": "array",
        "maxItems": MAX_ROWS,
        "items": {
            "type": "array",
            "minItems": columns,
            "maxItems": columns,
            "items": { "type": "string", "maxLength": MAX_CELL_CHARS }
        }
    })
}

/// The rows as the agent sent them, checked against the columns. Missing
/// `rows` is no rows.
pub fn rows_from(reply: &Value, columns: &[String]) -> Result<Vec<Vec<String>>, String> {
    let Some(rows) = reply.get("rows") else { return Ok(vec![]) };
    let rows = rows.as_array().ok_or("rows must be a list of rows")?;
    if rows.len() > MAX_ROWS {
        return Err(format!("at most {MAX_ROWS} rows, got {}", rows.len()));
    }
    rows.iter()
        .enumerate()
        .map(|(i, row)| {
            let cells = row.as_array().ok_or_else(|| format!("row {}: must be a list of cells", i + 1))?;
            if cells.len() != columns.len() {
                return Err(format!("row {}: {} cells, but the sheet has {} columns ({})", i + 1, cells.len(), columns.len(), columns.join(", ")));
            }
            cells
                .iter()
                .map(|c| match c {
                    Value::String(s) if s.chars().count() <= MAX_CELL_CHARS => Ok(s.clone()),
                    Value::String(_) => Err(format!("row {}: a cell is over {MAX_CELL_CHARS} characters", i + 1)),
                    Value::Number(n) => Ok(n.to_string()),
                    Value::Bool(b) => Ok(b.to_string()),
                    Value::Null => Ok(String::new()),
                    _ => Err(format!("row {}: a cell must be text", i + 1)),
                })
                .collect()
        })
        .collect()
}

/// What the agent is told about the rows it must return.
pub fn rows_rules(sheet: &SheetOutput) -> String {
    format!(
        "Also send `rows` next to `text`: one list per item, each with exactly {} values in this order: {}. \
         Write plain values (no formulas); Lotus adds them to the end of the user's Google Sheet. Send an empty \
         list when there is nothing to add.\n",
        sheet.columns.len(),
        sheet.columns.iter().map(|c| format!("\"{c}\"")).collect::<Vec<_>>().join(", ")
    )
}

/// `Daily monitoring — 2026-09-28 09.00`: the run's time (a scheduled run's planned time, so a late
/// run keeps its slot's name) in the automation's time zone. A dot, not a colon: a colon breaks the
/// name once the file is downloaded to macOS or Windows.
pub fn file_stem(automation_name: &str, at_ms: i64, timezone: Option<&str>) -> String {
    use chrono::TimeZone;
    let tz: chrono_tz::Tz = timezone.and_then(|t| t.parse().ok()).unwrap_or(chrono_tz::UTC);
    let date = chrono::Utc
        .timestamp_millis_opt(at_ms)
        .single()
        .map(|at| at.with_timezone(&tz).format("%Y-%m-%d %H.%M").to_string())
        .unwrap_or_default();
    // Drive allows any name; a slash only reads badly.
    format!("{} — {date}", automation_name.replace('/', "-").trim())
}

/// RFC 4180 CSV with a header row. Cells that would start a formula stay text.
pub fn to_csv(columns: &[String], rows: &[Vec<String>]) -> String {
    let field = |v: &str| {
        let v = cell(v);
        if v.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", v.replace('"', "\"\""))
        } else {
            v
        }
    };
    std::iter::once(columns.to_vec())
        .chain(rows.iter().cloned())
        .map(|r| r.iter().map(|c| field(c)).collect::<Vec<_>>().join(","))
        .map(|line| line + "\r\n")
        .collect()
}

/// Where one output went: `{status: sent | not_sent, url?, detail?}`.
fn outcome(result: Result<String, GoogleError>, sent_detail: String) -> Value {
    match result {
        Ok(url) => json!({ "status": "sent", "url": url, "detail": sent_detail }),
        Err(e) => json!({
            "status": "not_sent",
            "detail": crate::secrets::redact(&e.to_string()),
            "reconnect": e.needs_reconnect(),
        }),
    }
}

/// Everything a Google write needs, kept in the result so [`resend`] can
/// repeat it later without the agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pending {
    pub sheet: Option<SheetOutput>,
    pub drive: Option<DriveOutput>,
    pub file_name: String,
    pub text: String,
    pub rows: Vec<Vec<String>>,
}

/// Writes every configured output; the value goes in the result as `google`.
pub async fn deliver(writer: Option<&dyn GoogleWriter>, job: &Pending) -> Value {
    let mut out = json!({ "job": job });
    if let Some(sheet) = &job.sheet {
        out["sheet"] = write_sheet(writer, sheet, &job.rows).await;
    }
    if let Some(drive) = &job.drive {
        out["drive"] = write_file(writer, drive, job).await;
    }
    out
}

async fn write_sheet(writer: Option<&dyn GoogleWriter>, sheet: &SheetOutput, rows: &[Vec<String>]) -> Value {
    let Some(writer) = writer else { return not_connected() };
    if rows.is_empty() {
        return json!({ "status": "sent", "detail": "no rows this time" });
    }
    let n = rows.len();
    outcome(
        writer.append_rows(&sheet.spreadsheet_id, &sheet.tab, rows).await,
        format!("+{n} row{}", if n == 1 { "" } else { "s" }),
    )
}

async fn write_file(writer: Option<&dyn GoogleWriter>, drive: &DriveOutput, job: &Pending) -> Value {
    let Some(writer) = writer else { return not_connected() };
    let content = match (drive.format, &job.sheet) {
        (DriveFormat::Csv, Some(sheet)) => to_csv(&sheet.columns, &job.rows),
        (DriveFormat::Csv, None) => return json!({ "status": "not_sent", "detail": "a CSV file needs the sheet's columns" }),
        _ => job.text.clone(),
    };
    let upload = drive.format.upload();
    let name = upload.file_name(&job.file_name);
    outcome(writer.save_file(&drive.folder_id, &name, content.into_bytes(), upload).await, name)
}

fn not_connected() -> Value {
    json!({ "status": "not_sent", "detail": "Google is not connected; connect it in Connectors, then send again", "reconnect": true })
}

/// One line for the run's detail: "Google: sheet +3 rows, file saved".
pub fn summary(google: &Value) -> Option<String> {
    let part = |key: &str, label: &str| {
        let v = &google[key];
        match v["status"].as_str() {
            Some("sent") if key == "sheet" => Some(format!("{label} {}", v["detail"].as_str().unwrap_or("sent"))),
            Some("sent") => Some(format!("{label} saved")),
            Some(_) => Some(format!("{label} not sent")),
            None => None,
        }
    };
    let parts: Vec<String> = [part("sheet", "sheet"), part("drive", "file")].into_iter().flatten().collect();
    (!parts.is_empty()).then(|| format!("Google: {}", parts.join(", ")))
}

/// Readies an `agent_prompt` form's Google outputs before it is saved (PLAN G15, G18), from the
/// panel or an agent alike. Google must be connected; a sheet id of [`NEW_SHEET`] becomes the id
/// `create(name, tab, columns)` returns — called only once the whole form is valid, so a refused
/// form never leaves a stray sheet in the user's Drive.
pub async fn ready_form<F, Fut>(kind: &str, form: &mut Value, connected: bool, create: F) -> Result<(), String>
where
    F: FnOnce(String, String, Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<String, String>>,
{
    let uses = |key: &str| form.get(key).is_some_and(|v| !v.is_null());
    if kind != "agent_prompt" || !(uses("googleSheet") || uses("googleDrive")) {
        return Ok(());
    }
    if !connected {
        return Err("google: connect Google in Connectors first".into());
    }
    if form["googleSheet"]["spreadsheetId"] != NEW_SHEET {
        return Ok(());
    }
    let mut probe = form.clone();
    probe["googleSheet"]["spreadsheetId"] = json!("pending");
    let checked: crate::agent_prompt::AgentPromptForm = serde_json::from_value(probe).map_err(|e| format!("form: {e}"))?;
    let new = crate::agent_prompt::new_agent_prompt_automation(checked)?;
    let sheet: SheetOutput = serde_json::from_value(new.action.config["google_sheet"].clone()).map_err(|e| e.to_string())?;
    let id = create(new.name, sheet.tab, sheet.columns).await?;
    form["googleSheet"]["spreadsheetId"] = json!(id);
    Ok(())
}

/// Repeats the Google writes of a result that did not go out, and only those.
/// Callers serialize resends of one result (the app holds a lock).
pub async fn resend(store: &Store, writer: Option<&dyn GoogleWriter>, draft_id: &str) -> Result<Value, String> {
    let draft = store.get_draft(draft_id).map_err(|e| e.to_string())?.ok_or("no such result")?;
    if draft.kind != "agent_prompt" {
        return Err("not a scheduled prompt's result".into());
    }
    let mut google = draft.content.get("google").cloned().filter(Value::is_object).ok_or("this result has no Google output")?;
    let job: Pending = serde_json::from_value(google["job"].clone()).map_err(|_| "this result's Google output is unreadable".to_string())?;
    let not_sent = |key: &str, g: &Value| g[key]["status"] == "not_sent";
    if !not_sent("sheet", &google) && !not_sent("drive", &google) {
        return Err("everything already went to Google".into());
    }
    if let (true, Some(sheet)) = (not_sent("sheet", &google), &job.sheet) {
        google["sheet"] = write_sheet(writer, sheet, &job.rows).await;
    }
    if let (true, Some(drive)) = (not_sent("drive", &google), &job.drive) {
        google["drive"] = write_file(writer, drive, &job).await;
    }
    let mut content = draft.content.clone();
    content["google"] = google.clone();
    store.update_result_content(draft_id, &content).map_err(|e| e.to_string())?;
    Ok(google)
}
