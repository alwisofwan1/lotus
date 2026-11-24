//! Google sign-in (plans/google-connector PLAN G1–G7): consent URL, redirect,
//! code exchange, refresh, revoke, storage and redaction.

mod google_fake;

use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use google_fake::{FakeGoogle, Reply};
use lotus_automation::google::auth::{
    code_from_redirect, consent_url, exchange_code, forget_google_account, load_google_account, parse_grant, revoke,
    save_google_account, AccessKeeper, OAuthClient, Pkce, SCOPE_DRIVE_FILE,
};
use lotus_automation::google::{Endpoints, GoogleError};
use lotus_automation::secrets::{redact, SecretStore};
use serde_json::json;

const REDIRECT: &str = "http://127.0.0.1:53682";
const REFRESH: &str = "1//0gSECRETREFRESHtoken-abc_DEF";
const ACCESS: &str = "ya29.a0SECRETACCESS-token_xyz";

fn client() -> OAuthClient {
    OAuthClient::new("123-abc.apps.googleusercontent.com", "GOCSPX-desktop-secret")
}

fn id_token(email: &str) -> String {
    let part = |v: serde_json::Value| URL_SAFE_NO_PAD.encode(v.to_string());
    format!("{}.{}.sig", part(json!({"alg": "RS256"})), part(json!({"email": email, "email_verified": true})))
}

fn granted(scope: &str) -> Reply {
    Reply::json(
        200,
        json!({
            "access_token": ACCESS, "expires_in": 3599, "refresh_token": REFRESH,
            "scope": scope, "token_type": "Bearer", "id_token": id_token("you@company.com")
        }),
    )
}

#[derive(Default)]
struct MemoryKeychain(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryKeychain {
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
fn the_pkce_challenge_is_the_rfc_7636_s256_value() {
    // RFC 7636 Appendix B.
    let pkce = Pkce::from_parts("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "s");
    assert_eq!(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert!(!format!("{pkce:?}").contains("dBjftJeZ"), "the verifier never prints");
}

#[test]
fn every_attempt_gets_its_own_verifier_and_state() {
    let (a, b) = (Pkce::new(), Pkce::new());
    assert_ne!(a.state, b.state);
    assert_ne!(a.challenge, b.challenge);
}

#[test]
fn the_consent_url_asks_only_for_drive_file_with_pkce_and_a_refresh_token() {
    let pkce = Pkce::from_parts("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "st4te");
    let url = url::Url::parse(&consent_url(&client(), &Endpoints::google(), REDIRECT, &pkce)).unwrap();
    let q: HashMap<String, String> = url.query_pairs().into_owned().collect();

    assert_eq!(url.as_str().split('?').next(), Some("https://accounts.google.com/o/oauth2/v2/auth"));
    assert_eq!(q["scope"], format!("openid email {SCOPE_DRIVE_FILE}"), "no sensitive or restricted scope");
    assert_eq!(q["client_id"], "123-abc.apps.googleusercontent.com");
    assert_eq!(q["redirect_uri"], REDIRECT);
    assert_eq!(q["response_type"], "code");
    assert_eq!(q["code_challenge"], "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    assert_eq!(q["code_challenge_method"], "S256");
    assert_eq!(q["state"], "st4te");
    assert_eq!((q["access_type"].as_str(), q["prompt"].as_str()), ("offline", "consent"));
    assert!(!q.contains_key("client_secret"), "the secret goes to the token endpoint only");
}

#[test]
fn the_redirect_gives_the_code_only_for_this_attempt() {
    let pkce = Pkce::from_parts("v", "st4te");
    assert_eq!(code_from_redirect("/?state=st4te&code=4%2F0Abc&scope=email", &pkce).unwrap(), "4/0Abc");

    let other = code_from_redirect("/?state=someone-else&code=4/0Abc", &pkce).unwrap_err();
    assert!(other.to_string().contains("does not match"), "{other}");

    let cancelled = code_from_redirect("/?state=st4te&error=access_denied", &pkce).unwrap_err();
    assert_eq!(cancelled, GoogleError::Failed("Google sign-in was cancelled".into()));

    assert!(code_from_redirect("/?state=st4te", &pkce).is_err(), "no code");
}

#[test]
fn a_revoked_refresh_token_asks_the_user_to_reconnect() {
    let err = parse_grant(400, r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#).unwrap_err();
    assert!(err.needs_reconnect(), "{err}");
    assert!(err.to_string().contains("connect Google again"), "{err}");

    let other = parse_grant(401, r#"{"error":"invalid_client"}"#).unwrap_err();
    assert!(!other.needs_reconnect());
}

#[tokio::test]
async fn the_code_is_exchanged_with_the_verifier_and_the_account_is_kept_in_the_keychain() {
    let google = FakeGoogle::start(vec![granted(&format!("openid {SCOPE_DRIVE_FILE} https://www.googleapis.com/auth/userinfo.email"))]).await;
    let pkce = Pkce::from_parts("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "st4te");
    let http = reqwest::Client::new();

    let (account, access) =
        exchange_code(&http, &client(), &Endpoints::at(&google.base), "4/0Abc", REDIRECT, &pkce, 1_790_000_000_000).await.unwrap();

    let seen = google.seen();
    assert_eq!(seen.len(), 1);
    let req = &seen[0];
    assert_eq!((req.method.as_str(), req.path()), ("POST", "/token"));
    assert_eq!(req.header("content-type"), Some("application/x-www-form-urlencoded"));
    for (k, v) in [
        ("grant_type", "authorization_code"),
        ("code", "4/0Abc"),
        ("redirect_uri", REDIRECT),
        ("client_id", "123-abc.apps.googleusercontent.com"),
        ("client_secret", "GOCSPX-desktop-secret"),
        ("code_verifier", "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ] {
        assert_eq!(req.form(k).as_deref(), Some(v), "{k}");
    }
    assert_eq!(account.email.as_deref(), Some("you@company.com"));
    assert_eq!(account.refresh.expose(), REFRESH);
    assert_eq!(access.token.expose(), ACCESS);
    assert!(!format!("{account:?} {access:?}").contains("SECRET"), "tokens never print");

    let keychain = MemoryKeychain::default();
    save_google_account(&keychain, &account).unwrap();
    let loaded = load_google_account(&keychain).unwrap().unwrap();
    assert_eq!((loaded.refresh.expose(), loaded.email.as_deref(), loaded.connected_at_ms), (REFRESH, Some("you@company.com"), 1_790_000_000_000));
    assert!(!keychain.0.lock().unwrap()["google-tokens"].contains(ACCESS), "access tokens are never stored");
    forget_google_account(&keychain).unwrap();
    assert!(load_google_account(&keychain).unwrap().is_none());
}

#[tokio::test]
async fn a_grant_without_drive_access_is_refused() {
    // Google's consent screen lets the user untick the Drive box.
    let google = FakeGoogle::start(vec![granted("openid https://www.googleapis.com/auth/userinfo.email")]).await;
    let err = exchange_code(&reqwest::Client::new(), &client(), &Endpoints::at(&google.base), "c", REDIRECT, &Pkce::new(), 0)
        .await
        .unwrap_err();
    assert!(err.needs_reconnect() && err.to_string().contains("Drive access"), "{err}");
}

#[tokio::test]
async fn the_access_token_is_reused_until_it_nearly_expires() {
    let google = FakeGoogle::start(vec![
        Reply::json(200, json!({ "access_token": "ya29.first", "expires_in": 3599 })),
        Reply::json(200, json!({ "access_token": "ya29.second", "expires_in": 30 })),
        Reply::json(200, json!({ "access_token": "ya29.third", "expires_in": 3599 })),
    ])
    .await;
    let http = reqwest::Client::new();
    let refresh = load_refresh();
    let keeper = AccessKeeper::new(http, client(), Endpoints::at(&google.base), refresh);

    assert_eq!(keeper.token().await.unwrap().expose(), "ya29.first");
    assert_eq!(keeper.token().await.unwrap().expose(), "ya29.first", "cached");
    keeper.forget_access().await;
    assert_eq!(keeper.token().await.unwrap().expose(), "ya29.second", "a 401 forces a refresh");
    assert_eq!(keeper.token().await.unwrap().expose(), "ya29.third", "30 s left is too close to expiry");

    let seen = google.seen();
    assert_eq!(seen.len(), 3);
    assert_eq!(seen[0].form("grant_type").as_deref(), Some("refresh_token"));
    assert_eq!(seen[0].form("refresh_token").as_deref(), Some(REFRESH));
    assert_eq!(seen[0].form("client_secret").as_deref(), Some("GOCSPX-desktop-secret"));
}

#[tokio::test]
async fn revoking_an_access_google_already_forgot_still_counts_as_done() {
    let google = FakeGoogle::start(vec![
        Reply::json(200, json!({})),
        Reply::json(400, json!({ "error": "invalid_token", "error_description": "Token expired or revoked" })),
        Reply::json(503, json!({})),
    ])
    .await;
    let (http, endpoints, token) = (reqwest::Client::new(), Endpoints::at(&google.base), load_refresh());
    revoke(&http, &endpoints, &token).await.unwrap();
    revoke(&http, &endpoints, &token).await.unwrap();
    assert!(revoke(&http, &endpoints, &token).await.is_err());
    let seen = google.seen();
    assert_eq!((seen[0].path(), seen[0].form("token").as_deref()), ("/revoke", Some(REFRESH)));
}

#[test]
fn google_tokens_are_masked_in_errors_and_notifications() {
    let text = format!("refresh {REFRESH} failed; access {ACCESS}. See https://oauth2.googleapis.com/token");
    let masked = redact(&text);
    assert!(!masked.contains("SECRET"), "{masked}");
    assert!(masked.contains("1//[redacted]") && masked.contains("ya29.[redacted]."), "prefix and the sentence's period stay: {masked}");
    assert!(masked.contains("https://oauth2.googleapis.com/token"), "URLs are not tokens: {masked}");
    assert_eq!(redact("v1//path and xoxp-abc"), "v1//path and xoxp-[redacted]");
}

fn load_refresh() -> lotus_automation::secrets::Secret {
    let keychain = MemoryKeychain::default();
    keychain
        .set("google-tokens", &json!({ "refresh": REFRESH, "email": null, "scopes": [], "connected_at_ms": 0 }).to_string())
        .unwrap();
    load_google_account(&keychain).unwrap().unwrap().refresh
}

mod picker {
    use super::*;
    use lotus_automation::google::auth::{picked_from_redirect, picker_url, Pick};

    #[test]
    fn the_picker_asks_for_drive_file_alone_and_filters_what_can_be_picked() {
        let pkce = Pkce::from_parts("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "st4te");
        let q = |pick| -> HashMap<String, String> {
            url::Url::parse(&picker_url(&client(), &Endpoints::google(), REDIRECT, &pkce, pick)).unwrap().query_pairs().into_owned().collect()
        };
        let sheet = q(Pick::Sheet);
        // Google: the Picker allows only drive.file, and it cannot be combined with another scope.
        assert_eq!(sheet["scope"], SCOPE_DRIVE_FILE);
        assert_eq!((sheet["trigger_onepick"].as_str(), sheet["prompt"].as_str()), ("true", "consent"));
        assert_eq!(sheet["mimetypes"], "application/vnd.google-apps.spreadsheet");
        assert!(!sheet.contains_key("allow_folder_selection"));
        assert_eq!((sheet["code_challenge_method"].as_str(), sheet["state"].as_str()), ("S256", "st4te"));

        let folder = q(Pick::Folder);
        assert_eq!(folder["mimetypes"], "application/vnd.google-apps.folder");
        assert_eq!(folder["allow_folder_selection"], "true");
    }

    #[test]
    fn the_picked_file_comes_back_with_the_code() {
        let pkce = Pkce::from_parts("v", "st4te");
        let (code, ids) = picked_from_redirect("/?state=st4te&code=4%2F0Ab&scope=https://www.googleapis.com/auth/drive.file&picked_file_ids=1Abc%2C2Def", &pkce).unwrap();
        assert_eq!((code.as_str(), ids), ("4/0Ab", vec!["1Abc".to_string(), "2Def".to_string()]));

        let none = picked_from_redirect("/?state=st4te&code=4%2F0Ab", &pkce).unwrap_err();
        assert!(none.to_string().contains("nothing was picked"), "{none}");
        assert!(picked_from_redirect("/?state=other&code=c&picked_file_ids=1", &pkce).is_err(), "another attempt's reply");
    }
}
