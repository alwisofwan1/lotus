//! The Sheets and Drive calls an Automation output needs (PLAN G10, G11, G15):
//! append rows, create a sheet with a header, create a folder, upload a file.
//! Every call retries once after a 401 (with a fresh access token) and waits
//! out one 429/5xx, through the crate's one rate-limit rule.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::auth::AccessKeeper;
use super::GoogleError;
use crate::ratelimit::{with_rate_limit, Attempt};

/// Drive's limit for a single-request (multipart) upload.
pub const MAX_UPLOAD_BYTES: usize = 5 * 1024 * 1024;
/// Wait before retrying a 429/5xx that gave no `Retry-After`.
const DEFAULT_WAIT: Duration = Duration::from_secs(2);

const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
/// The folder id that means the top of the user's My Drive.
pub const MY_DRIVE: &str = "root";

/// What `values.append` reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Appended {
    /// e.g. `'Daily'!A201:F214`.
    pub range: String,
    pub rows: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spreadsheet {
    pub id: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub url: String,
}

/// How a report file lands in Drive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upload {
    /// Markdown converted to a Google Doc.
    GoogleDoc,
    /// Kept as a `.md` file.
    Markdown,
    /// Kept as a `.csv` file.
    Csv,
    /// CSV converted to a Google Sheet.
    GoogleSheet,
}

impl Upload {
    /// (content type sent, Drive type to convert to).
    fn types(self) -> (&'static str, Option<&'static str>) {
        match self {
            Self::GoogleDoc => ("text/markdown", Some("application/vnd.google-apps.document")),
            Self::Markdown => ("text/markdown", None),
            Self::Csv => ("text/csv", None),
            Self::GoogleSheet => ("text/csv", Some("application/vnd.google-apps.spreadsheet")),
        }
    }

    /// The file name Drive shows; converted files carry no extension.
    pub fn file_name(self, stem: &str) -> String {
        match self {
            Self::Markdown => format!("{stem}.md"),
            Self::Csv => format!("{stem}.csv"),
            Self::GoogleDoc | Self::GoogleSheet => stem.to_string(),
        }
    }
}

/// A cell as the agent wrote it, made safe for `USER_ENTERED`: text that
/// would start a formula (`=`, `+`, `@`, or `-` that is not a number) is
/// kept as text with a leading apostrophe, so outside data an agent quoted
/// can never run `=IMPORTXML(…)` in the user's sheet. Numbers and dates are
/// still parsed as Sheets would.
pub fn cell(value: &str) -> String {
    let formula = match value.chars().next() {
        Some('=' | '+' | '@') => true,
        Some('-') => value.trim().parse::<f64>().is_err(),
        _ => false,
    };
    if formula {
        format!("'{value}")
    } else {
        value.to_string()
    }
}

/// A whole tab in A1 notation: `'My tab'` (quotes doubled inside).
pub fn tab_range(tab: &str) -> String {
    format!("'{}'", tab.replace('\'', "''"))
}

/// The error message Google puts in a JSON error reply, if any.
fn google_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    v["error"]["message"].as_str().map(str::to_string)
}

/// Sheets and Drive as the connected user.
pub struct GoogleApi {
    access: Arc<AccessKeeper>,
}

impl GoogleApi {
    pub fn new(access: Arc<AccessKeeper>) -> Self {
        Self { access }
    }

    fn url(base: &str, segments: &[&str]) -> url::Url {
        let mut url = url::Url::parse(base).expect("Google endpoints are valid URLs");
        url.path_segments_mut().expect("Google endpoints have paths").extend(segments);
        url
    }

    /// Sends the request `build` makes with an access token. `what` names the
    /// call in errors.
    async fn send<F>(&self, what: &str, build: F) -> Result<Value, GoogleError>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let http = &self.access.http;
        for attempt in 0..2 {
            let token = self.access.token().await?;
            let (build, token) = (&build, token.expose());
            let (status, body) = with_rate_limit(
                what,
                || async move {
                    let res = build(http, token)
                        .send()
                        .await
                        .map_err(|e| format!("{what}: Google could not be reached: {}", e.without_url()))?;
                    let status = res.status().as_u16();
                    if status == 429 || matches!(status, 500 | 502 | 503 | 504) {
                        let wait = res
                            .headers()
                            .get("retry-after")
                            .and_then(|h| h.to_str().ok())
                            .and_then(|s| s.trim().parse().ok())
                            .map(Duration::from_secs)
                            .unwrap_or(DEFAULT_WAIT);
                        return Ok(Attempt::Wait(wait));
                    }
                    let body = res.text().await.map_err(|e| format!("{what}: Google's reply was cut off: {}", e.without_url()))?;
                    Ok(Attempt::Done((status, body)))
                },
                tokio::time::sleep,
            )
            .await
            .map_err(GoogleError::Failed)?;
            match status {
                200..=299 if body.trim().is_empty() => return Ok(Value::Null),
                200..=299 => {
                    return serde_json::from_str(&body).map_err(|_| GoogleError::Failed(format!("{what}: Google's reply was unreadable")))
                }
                401 if attempt == 0 => self.access.forget_access().await,
                401 => return Err(GoogleError::Reconnect(format!("{what}: Google refused the sign-in; connect Google again"))),
                403 | 404 => {
                    let detail = google_message(&body).map(|m| format!(" ({m})")).unwrap_or_default();
                    return Err(GoogleError::Failed(format!(
                        "{what}: the file was deleted or Lotus has no access to it{detail}"
                    )));
                }
                _ => {
                    let detail = google_message(&body).unwrap_or_else(|| format!("HTTP {status}"));
                    return Err(GoogleError::Failed(format!("{what}: Google said {detail}")));
                }
            }
        }
        unreachable!("the second attempt always returns")
    }

    /// Adds `rows` after the last row of `tab`'s table, as new rows.
    pub async fn append_rows(&self, spreadsheet_id: &str, tab: &str, rows: &[Vec<String>]) -> Result<Appended, GoogleError> {
        let range = format!("{}:append", tab_range(tab));
        let mut url = Self::url(&self.access.endpoints.sheets, &["spreadsheets", spreadsheet_id, "values", &range]);
        url.query_pairs_mut()
            .append_pair("valueInputOption", "USER_ENTERED")
            .append_pair("insertDataOption", "INSERT_ROWS")
            .append_pair("includeValuesInResponse", "false");
        let values: Vec<Vec<String>> = rows.iter().map(|r| r.iter().map(|c| cell(c)).collect()).collect();
        let body = json!({ "majorDimension": "ROWS", "values": values });
        let v = self
            .send("append rows", |http, token| http.post(url.clone()).bearer_auth(token).json(&body))
            .await
            .map_err(|e| match e {
                // Sheets names a tab it cannot find only as an unparseable range.
                GoogleError::Failed(m) if m.contains("Unable to parse range") => {
                    GoogleError::Failed(format!("append rows: the sheet has no tab {tab:?}; pick the tab again in the automation's settings"))
                }
                other => other,
            })?;
        Ok(Appended {
            range: v["updates"]["updatedRange"].as_str().unwrap_or_default().to_string(),
            rows: v["updates"]["updatedRows"].as_u64().unwrap_or(0),
        })
    }

    /// The tab names of a spreadsheet, in order.
    pub async fn sheet_tabs(&self, spreadsheet_id: &str) -> Result<Vec<String>, GoogleError> {
        let mut url = Self::url(&self.access.endpoints.sheets, &["spreadsheets", spreadsheet_id]);
        url.query_pairs_mut().append_pair("fields", "sheets.properties.title");
        let v = self.send("read tabs", |http, token| http.get(url.clone()).bearer_auth(token)).await?;
        Ok(v["sheets"].as_array().into_iter().flatten().filter_map(|t| t["properties"]["title"].as_str().map(str::to_string)).collect())
    }

    /// Row 1 of a tab, trimmed and without blank cells: an existing sheet's columns.
    pub async fn header_row(&self, spreadsheet_id: &str, tab: &str) -> Result<Vec<String>, GoogleError> {
        let range = format!("{}!1:1", tab_range(tab));
        let url = Self::url(&self.access.endpoints.sheets, &["spreadsheets", spreadsheet_id, "values", &range]);
        let v = self.send("read header", |http, token| http.get(url.clone()).bearer_auth(token)).await?;
        Ok(v["values"][0]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| c.as_str().map(str::trim).filter(|c| !c.is_empty()).map(str::to_string))
            .collect())
    }

    /// A new spreadsheet with one tab and, when given, a header row.
    pub async fn create_spreadsheet(&self, title: &str, tab: &str, header: &[String]) -> Result<Spreadsheet, GoogleError> {
        let url = Self::url(&self.access.endpoints.sheets, &["spreadsheets"]);
        let body = json!({ "properties": { "title": title }, "sheets": [{ "properties": { "title": tab } }] });
        let v = self.send("create sheet", |http, token| http.post(url.clone()).bearer_auth(token).json(&body)).await?;
        let sheet = Spreadsheet {
            id: v["spreadsheetId"].as_str().ok_or_else(|| GoogleError::Failed("create sheet: Google sent no id".into()))?.to_string(),
            url: v["spreadsheetUrl"].as_str().unwrap_or_default().to_string(),
        };
        if !header.is_empty() {
            self.append_rows(&sheet.id, tab, &[header.to_vec()]).await?;
        }
        Ok(sheet)
    }

    /// A file's name and link, e.g. a sheet or folder the user just picked.
    pub async fn file(&self, id: &str) -> Result<DriveFile, GoogleError> {
        let mut url = Self::url(&self.access.endpoints.drive, &["files", id]);
        url.query_pairs_mut().append_pair("fields", "id,name,webViewLink");
        let v = self.send("read file", |http, token| http.get(url.clone()).bearer_auth(token)).await?;
        drive_file(&v, "read file")
    }

    /// A folder in `parent`, or at the top of My Drive.
    pub async fn create_folder(&self, name: &str, parent: Option<&str>) -> Result<DriveFile, GoogleError> {
        let mut url = Self::url(&self.access.endpoints.drive, &["files"]);
        url.query_pairs_mut().append_pair("fields", "id,name,webViewLink");
        let mut body = json!({ "name": name, "mimeType": FOLDER_MIME });
        if let Some(parent) = parent {
            body["parents"] = json!([parent]);
        }
        let v = self.send("create folder", |http, token| http.post(url.clone()).bearer_auth(token).json(&body)).await?;
        drive_file(&v, "create folder")
    }

    /// Uploads `content` into `folder_id` as `name`, in one request.
    pub async fn upload_file(&self, folder_id: &str, name: &str, content: &[u8], kind: Upload) -> Result<DriveFile, GoogleError> {
        if content.len() > MAX_UPLOAD_BYTES {
            return Err(GoogleError::Failed(format!(
                "upload file: {} KB is over the {} MB a report may be",
                content.len() / 1024,
                MAX_UPLOAD_BYTES / 1024 / 1024
            )));
        }
        let (content_type, convert_to) = kind.types();
        // `root` is the top of My Drive: Drive puts a file without parents there.
        let mut metadata = if folder_id == MY_DRIVE { json!({ "name": name }) } else { json!({ "name": name, "parents": [folder_id] }) };
        if let Some(target) = convert_to {
            metadata["mimeType"] = json!(target);
        }
        let (boundary, body) = multipart_related(&metadata, content_type, content);
        let mut url = Self::url(&self.access.endpoints.upload, &["files"]);
        url.query_pairs_mut().append_pair("uploadType", "multipart").append_pair("fields", "id,name,webViewLink");
        let v = self
            .send("upload file", |http, token| {
                http.post(url.clone())
                    .bearer_auth(token)
                    .header(reqwest::header::CONTENT_TYPE, format!("multipart/related; boundary={boundary}"))
                    .body(body.clone())
            })
            .await?;
        drive_file(&v, "upload file")
    }
}

fn drive_file(v: &Value, what: &str) -> Result<DriveFile, GoogleError> {
    Ok(DriveFile {
        id: v["id"].as_str().ok_or_else(|| GoogleError::Failed(format!("{what}: Google sent no id")))?.to_string(),
        name: v["name"].as_str().unwrap_or_default().to_string(),
        url: v["webViewLink"].as_str().unwrap_or_default().to_string(),
    })
}

/// A Drive `multipart/related` body: JSON metadata, then the content. The
/// boundary is fresh per upload and checked against the content.
pub fn multipart_related(metadata: &Value, content_type: &str, content: &[u8]) -> (String, Vec<u8>) {
    let boundary = loop {
        let b = format!("lotus-{}", uuid::Uuid::new_v4().simple());
        if !content.windows(b.len()).any(|w| w == b.as_bytes()) {
            break b;
        }
    };
    let mut body = Vec::with_capacity(content.len() + 256);
    body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n").as_bytes());
    body.extend_from_slice(format!("--{boundary}\r\nContent-Type: {content_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(content);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (boundary, body)
}
