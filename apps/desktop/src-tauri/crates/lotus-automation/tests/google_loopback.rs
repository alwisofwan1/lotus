//! The loopback server Google redirects to, and the client file from Google
//! Cloud (plans/google-connector PLAN G3, G4).

use lotus_automation::google::auth::OAuthClient;
use lotus_automation::google::loopback::Loopback;
use lotus_automation::google::GoogleError;

#[tokio::test]
async fn the_redirect_is_handled_once_and_the_tab_is_told_the_outcome() {
    let loopback = Loopback::bind().await.unwrap();
    let base = loopback.redirect_uri();
    assert!(base.starts_with("http://127.0.0.1:"), "{base}");

    let server = tokio::spawn(loopback.receive(|target| async move {
        assert_eq!(target, "/?state=st4te&code=4%2F0Abc&scope=email");
        Ok("Connected as you@company.com".to_string())
    }));

    let http = reqwest::Client::new();
    let favicon = http.get(format!("{base}/favicon.ico")).send().await.unwrap();
    assert_eq!(favicon.status(), 404, "other requests do not end the wait");

    let tab = http.get(format!("{base}/?state=st4te&code=4%2F0Abc&scope=email")).send().await.unwrap();
    assert_eq!(tab.status(), 200);
    let page = tab.text().await.unwrap();
    assert!(page.contains("Lotus is connected to Google") && page.contains("Connected as you@company.com"), "{page}");

    assert_eq!(server.await.unwrap().unwrap(), "Connected as you@company.com");
}

#[tokio::test]
async fn a_failed_sign_in_is_shown_in_the_tab_escaped() {
    let loopback = Loopback::bind().await.unwrap();
    let base = loopback.redirect_uri();
    let server = tokio::spawn(loopback.receive(|_| async { Err(GoogleError::Failed("Google said <script>x</script>".into())) }));

    let page = reqwest::get(format!("{base}/?state=s&error=access_denied")).await.unwrap().text().await.unwrap();
    assert!(page.contains("Lotus is not connected"), "{page}");
    assert!(page.contains("&lt;script&gt;") && !page.contains("<script>"), "{page}");
    assert!(server.await.unwrap().is_err());
}

#[tokio::test]
async fn dropping_the_wait_closes_the_port() {
    let loopback = Loopback::bind().await.unwrap();
    let base = loopback.redirect_uri();
    let waiting = loopback.receive(|_| async { Ok(String::new()) });
    // A cancel or timeout drops the future.
    assert!(tokio::time::timeout(std::time::Duration::from_millis(50), waiting).await.is_err());
    assert!(reqwest::get(format!("{base}/?state=s&code=c")).await.is_err(), "nothing listens any more");
}

#[test]
fn the_desktop_client_file_from_google_cloud_is_read() {
    let file = r#"{"installed":{"client_id":"844-abc.apps.googleusercontent.com","project_id":"lotus-510006",
        "auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token",
        "client_secret":"GOCSPX-s3cret","redirect_uris":["http://localhost"]}}"#;
    let client = OAuthClient::from_download(file).unwrap();
    assert_eq!(client.client_id, "844-abc.apps.googleusercontent.com");
    assert!(!format!("{client:?}").contains("GOCSPX-s3cret"), "the secret never prints");

    let web = OAuthClient::from_download(r#"{"web":{"client_id":"x","client_secret":"y"}}"#).unwrap_err();
    assert!(web.contains("Desktop app"), "{web}");
    assert!(OAuthClient::from_download(r#"{"installed":{"client_id":"x"}}"#).is_err());
    assert!(OAuthClient::from_download("not json").is_err());
}
