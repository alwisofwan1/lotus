//! Google for automations, on the Tauri side (plans/google-connector PLAN
//! §2.1, slice 02).
//!
//! The sign-in logic is in the crate (`lotus_automation::google`); this file
//! owns one attempt's lifetime — the loopback port, the browser, cancel and
//! timeout — and the status line for Connectors. The refresh token goes to the
//! same secret store as Slack's. Who is connected (email, scopes; no secret)
//! is kept in a plain file, so drawing Connectors never reads the keychain.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use lotus_automation::google::api::{GoogleApi, Upload};
use lotus_automation::google::auth::{
    code_from_redirect, consent_url, exchange_code, forget_google_account, load_google_account, picked_from_redirect,
    picker_url, revoke, save_google_account, AccessKeeper, AccountSummary, GoogleAccount, OAuthClient, Pick, Pkce,
};
use lotus_automation::google::loopback::Loopback;
use lotus_automation::google::output::GoogleWriter;
use lotus_automation::google::{Endpoints, GoogleError};
use lotus_automation::secrets::{redact, SecretStore};
use lotus_automation::{Clock, SystemClock};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::automation_host::CHANGED_EVENT;
use crate::paths;

/// How long a sign-in may wait for the browser (PLAN §3 slice 02).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CANCELLED: &str = "Google sign-in was cancelled";

/// The Google line in Connectors. Never carries a token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoogleStatusView {
    /// `unavailable` | `not_connected` | `connecting` | `connected`
    pub state: String,
    pub email: Option<String>,
    pub scopes: Vec<String>,
    pub connected_at_ms: Option<i64>,
    /// Why Google is unavailable in this build.
    pub detail: Option<String>,
}

impl GoogleStatusView {
    fn new(state: &str) -> Self {
        Self { state: state.into(), email: None, scopes: vec![], connected_at_ms: None, detail: None }
    }
}

/// The Desktop client JSON from Google Cloud, next to the app's state
/// (`~/.lotus-dev/` for dev, `~/.lotus/` for release). Outside every repo.
fn client_file() -> std::path::PathBuf {
    paths::lotus_state_dir().join("google-oauth-client.json")
}

fn account_file() -> std::path::PathBuf {
    paths::lotus_state_dir().join("google-account.json")
}

/// Lotus's OAuth client: baked in at build time
/// (`LOTUS_GOOGLE_CLIENT_ID` / `LOTUS_GOOGLE_CLIENT_SECRET`), else read from
/// [`client_file`] (PLAN G4).
fn oauth_client() -> Result<OAuthClient, String> {
    if let (Some(id), Some(secret)) = (option_env!("LOTUS_GOOGLE_CLIENT_ID"), option_env!("LOTUS_GOOGLE_CLIENT_SECRET")) {
        return Ok(OAuthClient::new(id, secret));
    }
    let path = client_file();
    let json = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("this build has no Google client; put the Desktop client JSON at {}", path.display()),
        _ => format!("{}: {e}", path.display()),
    })?;
    OAuthClient::from_download(&json)
}

/// What the user chose in the Picker. For a sheet, also its tabs (in order) and the first tab's
/// header row, so the form starts from what the sheet already has.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedView {
    pub id: String,
    pub name: String,
    pub url: String,
    pub tabs: Vec<String>,
    pub columns: Vec<String>,
}

pub struct GoogleHost {
    secrets: Arc<dyn SecretStore>,
    /// Cancels the sign-in that is waiting for the browser, if any.
    pending: Mutex<Option<oneshot::Sender<()>>>,
    access: Arc<SharedAccess>,
    /// One "send again" at a time, so a double press cannot append twice.
    resending: tokio::sync::Mutex<()>,
}

/// The access token keeper of the connected account, built on first use (the
/// first read of the keychain) and dropped on every connect and disconnect.
struct SharedAccess {
    secrets: Arc<dyn SecretStore>,
    keeper: Mutex<Option<Arc<AccessKeeper>>>,
}

impl SharedAccess {
    fn api(&self) -> Result<GoogleApi, GoogleError> {
        let mut keeper = self.keeper.lock().unwrap_or_else(|p| p.into_inner());
        if keeper.is_none() {
            let client = oauth_client().map_err(GoogleError::Failed)?;
            let account = load_google_account(self.secrets.as_ref())
                .map_err(GoogleError::Failed)?
                .ok_or_else(|| GoogleError::Reconnect("Google is not connected; connect it in Connectors".into()))?;
            let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().unwrap_or_default();
            *keeper = Some(Arc::new(AccessKeeper::new(http, client, Endpoints::google(), account.refresh)));
        }
        Ok(GoogleApi::new(Arc::clone(keeper.as_ref().expect("set above"))))
    }

    fn reset(&self) {
        self.keeper.lock().unwrap_or_else(|p| p.into_inner()).take();
    }
}

/// Writes an `agent_prompt` result's Sheet and Drive outputs as the connected
/// user. Handed to the action at startup, before anyone connects, so it looks
/// the account up on every write.
pub struct HostGoogleWriter(Arc<SharedAccess>);

impl GoogleWriter for HostGoogleWriter {
    fn append_rows(&self, id: &str, tab: &str, rows: &[Vec<String>]) -> lotus_automation::BoxFuture<Result<String, GoogleError>> {
        let (api, id, tab, rows) = (self.0.api(), id.to_string(), tab.to_string(), rows.to_vec());
        Box::pin(async move {
            api?.append_rows(&id, &tab, &rows).await?;
            Ok(format!("https://docs.google.com/spreadsheets/d/{id}/edit"))
        })
    }

    fn save_file(&self, folder: &str, name: &str, content: Vec<u8>, kind: Upload) -> lotus_automation::BoxFuture<Result<String, GoogleError>> {
        let (api, folder, name) = (self.0.api(), folder.to_string(), name.to_string());
        Box::pin(async move { Ok(api?.upload_file(&folder, &name, &content, kind).await?.url) })
    }
}

impl GoogleHost {
    pub fn new() -> Self {
        let secrets: Arc<dyn SecretStore> = Arc::from(crate::automation_slack::secret_store());
        let access = Arc::new(SharedAccess { secrets: Arc::clone(&secrets), keeper: Mutex::new(None) });
        Self { secrets, pending: Mutex::new(None), access, resending: tokio::sync::Mutex::new(()) }
    }

    pub fn writer(&self) -> HostGoogleWriter {
        HostGoogleWriter(Arc::clone(&self.access))
    }

    /// A new sheet in My Drive with one tab and a header row, for an output.
    pub async fn create_sheet(&self, title: &str, tab: &str, columns: &[String]) -> Result<lotus_automation::google::api::Spreadsheet, String> {
        let api = self.access.api().map_err(|e| e.to_string())?;
        api.create_spreadsheet(title, tab, columns).await.map_err(|e| redact(&e.to_string()))
    }

    /// Sends a result's failed Google writes again, and only those.
    pub async fn resend(&self, store: &lotus_automation::Store, draft_id: &str, app: &AppHandle) -> Result<serde_json::Value, String> {
        let _one_at_a_time = self.resending.lock().await;
        let writer = self.writer();
        let google = lotus_automation::google::output::resend(store, Some(&writer), draft_id).await;
        let _ = app.emit(CHANGED_EVENT, ());
        google
    }

    pub fn status(&self) -> GoogleStatusView {
        if let Err(detail) = oauth_client() {
            return GoogleStatusView { detail: Some(detail), ..GoogleStatusView::new("unavailable") };
        }
        if self.pending.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
            return GoogleStatusView::new("connecting");
        }
        match read_summary() {
            Some(s) => GoogleStatusView {
                email: s.email,
                scopes: s.scopes,
                connected_at_ms: Some(s.connected_at_ms),
                ..GoogleStatusView::new("connected")
            },
            None => GoogleStatusView::new("not_connected"),
        }
    }

    /// One trip through the browser: opens `url`, waits (at most [`CONNECT_TIMEOUT`]) for the
    /// redirect to `loopback`, and runs `handle` on it; the tab shows what `handle` said. A second
    /// Connect or Pick cancels the first.
    async fn through_browser<F, Fut>(&self, app: &AppHandle, url: &str, loopback: Loopback, handle: F) -> Result<(), String>
    where
        F: FnOnce(String) -> Fut,
        Fut: std::future::Future<Output = Result<String, GoogleError>>,
    {
        let (cancel, cancelled) = oneshot::channel();
        if let Some(previous) = self.pending.lock().unwrap_or_else(|p| p.into_inner()).replace(cancel) {
            let _ = previous.send(());
        }
        let _ = app.emit(CHANGED_EVENT, ());
        if let Err(e) = open_in_browser(app, url) {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).take();
            let _ = app.emit(CHANGED_EVENT, ());
            return Err(format!("Lotus could not open your browser: {e}"));
        }

        let outcome = tokio::select! {
            done = tokio::time::timeout(CONNECT_TIMEOUT, loopback.receive(handle)) => match done {
                Ok(result) => result.map(|_| ()).map_err(|e| e.to_string()),
                Err(_) => Err("Google sign-in timed out after 5 minutes; try again".to_string()),
            },
            _ = cancelled => Err(CANCELLED.to_string()),
        };

        // Only this attempt's own cancel is dropped: a newer one keeps its own.
        if outcome.as_ref().err().map(String::as_str) != Some(CANCELLED) {
            self.pending.lock().unwrap_or_else(|p| p.into_inner()).take();
        }
        let _ = app.emit(CHANGED_EVENT, ());
        outcome.map_err(|e| redact(&e))
    }

    /// Opens Google's consent page in the browser and saves the account it returns.
    pub async fn connect(&self, app: &AppHandle) -> Result<GoogleStatusView, String> {
        let client = oauth_client()?;
        let endpoints = Endpoints::google();
        let loopback = Loopback::bind().await.map_err(|e| e.to_string())?;
        let redirect = loopback.redirect_uri();
        let pkce = Pkce::new();
        let url = consent_url(&client, &endpoints, &redirect, &pkce);
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default();
        let (secrets, http, client, endpoints, redirect, pkce) = (self.secrets.as_ref(), &http, &client, &endpoints, &redirect, &pkce);
        self.access.reset();
        self.through_browser(app, &url, loopback, |target| async move {
            let code = code_from_redirect(&target, pkce)?;
            let (account, _access) =
                exchange_code(http, client, endpoints, &code, redirect, pkce, SystemClock.now_ms()).await?;
            save_google_account(secrets, &account).map_err(GoogleError::Failed)?;
            write_summary(&account.summary()).map_err(GoogleError::Failed)?;
            Ok(match &account.email {
                Some(email) => format!("Connected as {email}."),
                None => "Connected.".to_string(),
            })
        })
        .await?;
        Ok(self.status())
    }

    /// Google's Picker (slice 05): the user chooses an existing sheet or folder in the browser, and
    /// Lotus gains `drive.file` access to it. Each Picker grant comes with a new refresh token; the
    /// saved one is replaced by it (Google keeps at most 100 per account and client and silently
    /// drops the oldest, so an old saved one could die), keeping the account's email.
    pub async fn pick(&self, app: &AppHandle, pick: Pick) -> Result<PickedView, String> {
        let saved = read_summary().ok_or("google: connect Google in Connectors first")?;
        let client = oauth_client()?;
        let endpoints = Endpoints::google();
        let loopback = Loopback::bind().await.map_err(|e| e.to_string())?;
        let redirect = loopback.redirect_uri();
        let pkce = Pkce::new();
        let url = picker_url(&client, &endpoints, &redirect, &pkce, pick);
        let http = reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap_or_default();
        let picked: Mutex<Option<PickedView>> = Mutex::new(None);
        let (secrets, access, http, client, endpoints, redirect, pkce, picked_ref, saved) =
            (self.secrets.as_ref(), &self.access, &http, &client, &endpoints, &redirect, &pkce, &picked, &saved);
        self.through_browser(app, &url, loopback, |target| async move {
            let (code, ids) = picked_from_redirect(&target, pkce)?;
            let (fresh, _access) = exchange_code(http, client, endpoints, &code, redirect, pkce, SystemClock.now_ms()).await?;
            let account = GoogleAccount {
                refresh: fresh.refresh,
                email: saved.email.clone(),
                scopes: saved.scopes.clone(),
                connected_at_ms: saved.connected_at_ms,
            };
            save_google_account(secrets, &account).map_err(GoogleError::Failed)?;
            access.reset();
            let api = access.api()?;
            let file = api.file(&ids[0]).await?;
            let (tabs, columns) = if pick == Pick::Sheet {
                let tabs = api.sheet_tabs(&file.id).await?;
                // An empty or unreadable header only means the form keeps its own columns.
                let columns = match tabs.first() {
                    Some(tab) => api.header_row(&file.id, tab).await.unwrap_or_default(),
                    None => vec![],
                };
                (tabs, columns)
            } else {
                (vec![], vec![])
            };
            let said = format!("Picked “{}”.", file.name);
            *picked_ref.lock().unwrap_or_else(|p| p.into_inner()) =
                Some(PickedView { id: file.id, name: file.name, url: file.url, tabs, columns });
            Ok(said)
        })
        .await?;
        picked.into_inner().unwrap_or_else(|p| p.into_inner()).ok_or_else(|| "Google sent no picked file".to_string())
    }

    /// Stops a sign-in that is waiting for the browser.
    pub fn cancel_connect(&self, app: &AppHandle) {
        if let Some(pending) = self.pending.lock().unwrap_or_else(|p| p.into_inner()).take() {
            let _ = pending.send(());
        }
        let _ = app.emit(CHANGED_EVENT, ());
    }

    /// Ends the grant at Google (best effort), then forgets the account here.
    pub async fn disconnect(&self, app: &AppHandle) -> Result<(), String> {
        if let Some(account) = load_google_account(self.secrets.as_ref())? {
            let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default();
            if let Err(e) = revoke(&http, &Endpoints::google(), &account.refresh).await {
                // Still forgotten here; the user can remove Lotus at myaccount.google.com/permissions.
                eprintln!("[automation] Google revoke: {}", redact(&e.to_string()));
            }
        }
        self.access.reset();
        forget_google_account(self.secrets.as_ref())?;
        match std::fs::remove_file(account_file()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("{}: {e}", account_file().display())),
        }
        let _ = app.emit(CHANGED_EVENT, ());
        Ok(())
    }
}

#[allow(deprecated)]
fn open_in_browser(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell().open(url, None).map_err(|e| e.to_string())
}

fn read_summary() -> Option<AccountSummary> {
    serde_json::from_str(&std::fs::read_to_string(account_file()).ok()?).ok()
}

fn write_summary(summary: &AccountSummary) -> Result<(), String> {
    let path = account_file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string(summary).map_err(|e| e.to_string())?).map_err(|e| format!("{}: {e}", path.display()))
}
