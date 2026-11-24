//! Google sign-in for a desktop app: loopback redirect + PKCE S256, scope
//! `drive.file` only (PLAN G1–G7). The request/response shapes are pure and
//! tested; the network calls are thin and tested against a fake server.
//!
//! Google treats a desktop client's secret as not secret, but it is still
//! sent only to the token endpoint and kept as a [`Secret`].

use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{Endpoints, GoogleError};
use crate::secrets::{Secret, SecretStore};

/// Files Lotus created or the user picked; nothing else in their Drive.
pub const SCOPE_DRIVE_FILE: &str = "https://www.googleapis.com/auth/drive.file";
/// `openid email` only to show which account is connected.
pub const SCOPES: &[&str] = &["openid", "email", SCOPE_DRIVE_FILE];

/// An access token this close to expiring is refreshed before use.
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

/// Lotus's own OAuth client (type Desktop app), baked into the build.
#[derive(Debug, Clone)]
pub struct OAuthClient {
    pub client_id: String,
    client_secret: Secret,
}

impl OAuthClient {
    pub fn new(client_id: &str, client_secret: &str) -> Self {
        Self { client_id: client_id.trim().to_string(), client_secret: Secret::new(client_secret.trim().to_string()) }
    }

    /// The JSON Google Cloud's "Download JSON" gives for a Desktop client
    /// (`{"installed": {"client_id", "client_secret", …}}`).
    pub fn from_download(json: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(json).map_err(|_| "the Google client file is not JSON".to_string())?;
        let c = &v["installed"];
        if c.is_null() {
            return Err("the Google client file is not for a Desktop app (no \"installed\" section)".into());
        }
        match (c["client_id"].as_str(), c["client_secret"].as_str()) {
            (Some(id), Some(secret)) if !id.trim().is_empty() && !secret.trim().is_empty() => Ok(Self::new(id, secret)),
            _ => Err("the Google client file has no client_id or client_secret".into()),
        }
    }
}

/// One sign-in attempt: the PKCE verifier and the `state` that ties the
/// redirect back to it. Never reused.
#[derive(Debug)]
pub struct Pkce {
    verifier: Secret,
    pub challenge: String,
    pub state: String,
}

impl Pkce {
    pub fn new() -> Self {
        let verifier = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        Self::from_parts(&verifier, &uuid::Uuid::new_v4().simple().to_string())
    }

    /// A fixed verifier and state, for tests.
    pub fn from_parts(verifier: &str, state: &str) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self { verifier: Secret::new(verifier.to_string()), challenge, state: state.to_string() }
    }
}

impl Default for Pkce {
    fn default() -> Self {
        Self::new()
    }
}

/// The Google consent page for this attempt. `redirect_uri` is the loopback
/// address Lotus listens on (`http://127.0.0.1:<port>`).
pub fn consent_url(client: &OAuthClient, endpoints: &Endpoints, redirect_uri: &str, pkce: &Pkce) -> String {
    let mut url = url::Url::parse(&endpoints.auth).expect("the auth endpoint is a valid URL");
    url.query_pairs_mut()
        .append_pair("client_id", &client.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &SCOPES.join(" "))
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &pkce.state)
        // A refresh token, and a new one on every connect (a reconnect after
        // Disconnect would otherwise get none).
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url.into()
}

/// The authorization code from the request Google's redirect made to the
/// loopback server (`/?state=…&code=…`).
pub fn code_from_redirect(target: &str, pkce: &Pkce) -> Result<String, GoogleError> {
    let url = url::Url::parse("http://127.0.0.1").and_then(|base| base.join(target)).map_err(|_| failed("an unreadable redirect"))?;
    let param = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if param("state").as_deref() != Some(pkce.state.as_str()) {
        return Err(failed("the sign-in reply does not match this attempt; press Connect again"));
    }
    if let Some(error) = param("error") {
        return Err(failed(if error == "access_denied" {
            "Google sign-in was cancelled".to_string()
        } else {
            format!("Google sign-in failed: {error}")
        }));
    }
    param("code").filter(|c| !c.is_empty()).ok_or_else(|| failed("Google sent no authorization code"))
}

/// What the Google Picker lets the user choose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    Sheet,
    Folder,
}

/// Google's own sign-in page with the Picker after it (PLAN G15, slice 05): the user chooses an
/// existing sheet or folder and Lotus gains `drive.file` access to exactly that one. Google allows
/// only `drive.file` here, not combined with any other scope, so no `openid email` (the connected
/// account's email is kept from the first sign-in).
pub fn picker_url(client: &OAuthClient, endpoints: &Endpoints, redirect_uri: &str, pkce: &Pkce, pick: Pick) -> String {
    let mut url = url::Url::parse(&endpoints.auth).expect("the auth endpoint is a valid URL");
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", &client.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", SCOPE_DRIVE_FILE)
            .append_pair("code_challenge", &pkce.challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &pkce.state)
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent")
            .append_pair("trigger_onepick", "true");
        match pick {
            Pick::Sheet => q.append_pair("mimetypes", "application/vnd.google-apps.spreadsheet"),
            Pick::Folder => q.append_pair("mimetypes", "application/vnd.google-apps.folder").append_pair("allow_folder_selection", "true"),
        };
    }
    url.into()
}

/// The code and the picked file ids from the Picker's redirect.
pub fn picked_from_redirect(target: &str, pkce: &Pkce) -> Result<(String, Vec<String>), GoogleError> {
    let code = code_from_redirect(target, pkce)?;
    let url = url::Url::parse("http://127.0.0.1").and_then(|base| base.join(target)).map_err(|_| failed("an unreadable redirect"))?;
    let ids: Vec<String> = url
        .query_pairs()
        .find(|(k, _)| k == "picked_file_ids")
        .map(|(_, v)| v.split(',').map(str::trim).filter(|id| !id.is_empty()).map(str::to_string).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return Err(failed("nothing was picked; press Pick again and choose one"));
    }
    Ok((code, ids))
}

/// A short-lived token for API calls.
#[derive(Debug, Clone)]
pub struct AccessToken {
    pub token: Secret,
    pub expires_in: Duration,
}

/// A token endpoint reply.
#[derive(Debug, Clone)]
pub struct Grant {
    pub access: AccessToken,
    pub refresh: Option<Secret>,
    pub scopes: Vec<String>,
    pub email: Option<String>,
}

/// Parses a token endpoint reply. `invalid_grant` means the refresh token was
/// revoked, expired (7 days in Testing mode) or the password changed.
pub fn parse_grant(status: u16, body: &str) -> Result<Grant, GoogleError> {
    let v: Value = serde_json::from_str(body).map_err(|_| failed(format!("Google's token reply was unreadable (HTTP {status})")))?;
    if let Some(error) = v["error"].as_str() {
        return Err(match error {
            "invalid_grant" => GoogleError::Reconnect("Google access ended; connect Google again in Connectors".into()),
            "invalid_client" | "unauthorized_client" => failed("this Lotus build's Google client was refused"),
            _ => failed(format!("Google refused the token request: {error}")),
        });
    }
    let token = v["access_token"].as_str().filter(|t| !t.is_empty()).ok_or_else(|| failed("Google sent no access token"))?;
    Ok(Grant {
        access: AccessToken {
            token: Secret::new(token.to_string()),
            expires_in: Duration::from_secs(v["expires_in"].as_u64().unwrap_or(3600)),
        },
        refresh: v["refresh_token"].as_str().filter(|t| !t.is_empty()).map(|t| Secret::new(t.to_string())),
        scopes: v["scope"].as_str().unwrap_or_default().split_whitespace().map(str::to_string).collect(),
        email: v["id_token"].as_str().and_then(email_from_id_token),
    })
}

/// The `email` claim. The ID token came straight from Google's token endpoint
/// over TLS, so its signature need not be checked to trust it.
fn email_from_id_token(jwt: &str) -> Option<String> {
    let payload = URL_SAFE_NO_PAD.decode(jwt.split('.').nth(1)?.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&payload).ok()?;
    claims["email"].as_str().map(str::to_string)
}

/// A connected Google account: what is kept after sign-in.
#[derive(Debug, Clone)]
pub struct GoogleAccount {
    pub refresh: Secret,
    pub email: Option<String>,
    pub scopes: Vec<String>,
    pub connected_at_ms: i64,
}

impl GoogleAccount {
    pub fn summary(&self) -> AccountSummary {
        AccountSummary { email: self.email.clone(), scopes: self.scopes.clone(), connected_at_ms: self.connected_at_ms }
    }
}

/// Who is connected, without the token: kept in a plain file beside the app's
/// state so drawing Connectors never reads the keychain (each read can prompt).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub email: Option<String>,
    pub scopes: Vec<String>,
    pub connected_at_ms: i64,
}

/// Turns the code into a connected account. Refuses a grant without Drive
/// access: Google's consent screen lets the user untick it.
pub async fn exchange_code(
    http: &reqwest::Client,
    client: &OAuthClient,
    endpoints: &Endpoints,
    code: &str,
    redirect_uri: &str,
    pkce: &Pkce,
    now_ms: i64,
) -> Result<(GoogleAccount, AccessToken), GoogleError> {
    let (status, body) = post_form(
        http,
        &endpoints.token,
        &[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", &client.client_id),
            ("client_secret", client.client_secret.expose()),
            ("code_verifier", pkce.verifier.expose()),
        ],
    )
    .await?;
    let grant = parse_grant(status, &body)?;
    if !grant.scopes.iter().any(|s| s == SCOPE_DRIVE_FILE) {
        return Err(GoogleError::Reconnect(
            "Google did not give Drive access; connect again and leave “See, edit, create and delete only the specific Google Drive files you use with this app” ticked".into(),
        ));
    }
    let refresh = grant.refresh.ok_or_else(|| failed("Google sent no refresh token; press Connect again"))?;
    Ok((GoogleAccount { refresh, email: grant.email, scopes: grant.scopes, connected_at_ms: now_ms }, grant.access))
}

/// A new access token from the refresh token.
pub async fn refresh_access(
    http: &reqwest::Client,
    client: &OAuthClient,
    endpoints: &Endpoints,
    refresh: &Secret,
) -> Result<AccessToken, GoogleError> {
    let (status, body) = post_form(
        http,
        &endpoints.token,
        &[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.expose()),
            ("client_id", &client.client_id),
            ("client_secret", client.client_secret.expose()),
        ],
    )
    .await?;
    parse_grant(status, &body).map(|g| g.access)
}

/// Ends the grant at Google. A token Google no longer knows counts as done.
pub async fn revoke(http: &reqwest::Client, endpoints: &Endpoints, token: &Secret) -> Result<(), GoogleError> {
    let (status, body) = post_form(http, &endpoints.revoke, &[("token", token.expose())]).await?;
    let unknown = status == 400 && body.contains("invalid_token");
    if (200..300).contains(&status) || unknown {
        Ok(())
    } else {
        Err(failed(format!("Google did not revoke the access (HTTP {status})")))
    }
}

async fn post_form(http: &reqwest::Client, url: &str, form: &[(&str, &str)]) -> Result<(u16, String), GoogleError> {
    let res = http.post(url).form(form).send().await.map_err(|e| failed(format!("Google could not be reached: {}", e.without_url())))?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(|e| failed(format!("Google's reply was cut off: {}", e.without_url())))?;
    Ok((status, body))
}

fn failed(message: impl Into<String>) -> GoogleError {
    GoogleError::Failed(message.into())
}

/// The keychain entry. One account per Lotus (PLAN G6).
const GOOGLE_TOKENS: &str = "google-tokens";

#[derive(serde::Serialize, serde::Deserialize)]
struct StoredGoogle {
    refresh: String,
    email: Option<String>,
    scopes: Vec<String>,
    connected_at_ms: i64,
}

pub fn save_google_account(store: &dyn SecretStore, account: &GoogleAccount) -> Result<(), String> {
    let stored = StoredGoogle {
        refresh: account.refresh.expose().to_string(),
        email: account.email.clone(),
        scopes: account.scopes.clone(),
        connected_at_ms: account.connected_at_ms,
    };
    store.set(GOOGLE_TOKENS, &serde_json::to_string(&stored).map_err(|e| e.to_string())?)
}

pub fn load_google_account(store: &dyn SecretStore) -> Result<Option<GoogleAccount>, String> {
    let Some(json) = store.get(GOOGLE_TOKENS)? else { return Ok(None) };
    let s: StoredGoogle = serde_json::from_str(&json).map_err(|_| "the saved Google sign-in is unreadable".to_string())?;
    Ok(Some(GoogleAccount { refresh: Secret::new(s.refresh), email: s.email, scopes: s.scopes, connected_at_ms: s.connected_at_ms }))
}

pub fn forget_google_account(store: &dyn SecretStore) -> Result<(), String> {
    store.delete(GOOGLE_TOKENS)
}

/// Hands out a valid access token, refreshing it only when it is about to
/// expire or Google refused it. One refresh at a time.
pub struct AccessKeeper {
    pub(crate) http: reqwest::Client,
    pub(crate) endpoints: Endpoints,
    client: OAuthClient,
    refresh: Secret,
    cached: tokio::sync::Mutex<Option<(Secret, Instant)>>,
}

impl AccessKeeper {
    pub fn new(http: reqwest::Client, client: OAuthClient, endpoints: Endpoints, refresh: Secret) -> Self {
        Self { http, endpoints, client, refresh, cached: tokio::sync::Mutex::new(None) }
    }

    /// Starts with the access token a sign-in just returned.
    pub fn with_access(self, access: AccessToken) -> Self {
        let cached = Some((access.token, Instant::now() + access.expires_in));
        Self { cached: tokio::sync::Mutex::new(cached), ..self }
    }

    pub async fn token(&self) -> Result<Secret, GoogleError> {
        let mut cached = self.cached.lock().await;
        if let Some((token, until)) = cached.as_ref() {
            if Instant::now() + EXPIRY_MARGIN < *until {
                return Ok(token.clone());
            }
        }
        let fresh = refresh_access(&self.http, &self.client, &self.endpoints, &self.refresh).await?;
        *cached = Some((fresh.token.clone(), Instant::now() + fresh.expires_in));
        Ok(fresh.token)
    }

    /// Drops the cached token after Google answered 401 with it.
    pub async fn forget_access(&self) {
        *self.cached.lock().await = None;
    }
}
