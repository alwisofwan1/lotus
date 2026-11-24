//! A real run of the Google calls an automation makes, against the account
//! the dev app connected (plans/google-connector slice 04 → 07).
//!
//! Creates, in YOUR Drive: a sheet "Lotus smoke test" (tab `Daily`, a header,
//! two rows), a folder "Lotus smoke test", and in it a Google Doc (from
//! Markdown) and a CSV. Prints each URL. Delete them afterwards if you like.
//!
//! ```text
//! cargo run -p lotus-automation --example google_smoke
//! ```
//!
//! Reads `~/.lotus-dev/google-oauth-client.json` and the sign-in the dev app
//! saved in `~/.lotus-dev/dev-secrets.json`. Prints no token.

use std::sync::Arc;

use lotus_automation::google::api::{GoogleApi, Upload};
use lotus_automation::google::auth::{load_google_account, AccessKeeper, OAuthClient};
use lotus_automation::google::output::to_csv;
use lotus_automation::google::Endpoints;
use lotus_automation::secrets::FileStore;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::path::PathBuf::from(std::env::var("HOME")?).join(".lotus-dev");
    let client = OAuthClient::from_download(&std::fs::read_to_string(dir.join("google-oauth-client.json"))?)?;
    let store = FileStore::new(dir.join("dev-secrets.json"));
    let account = load_google_account(&store)?.ok_or("not connected: Connectors → Google → Connect with Google in the dev app first")?;
    println!("account: {}", account.email.as_deref().unwrap_or("(no email)"));

    let keeper = AccessKeeper::new(reqwest::Client::new(), client, Endpoints::google(), account.refresh);
    let api = GoogleApi::new(Arc::new(keeper));
    let columns: Vec<String> = ["Date", "Service", "Status", "Note"].map(String::from).to_vec();
    let rows = vec![
        vec!["2026-09-28".into(), "checkout-api".into(), "slow".into(), "p95 820 ms".into()],
        vec!["2026-09-28".into(), "payments".into(), "up".into(), "=1+1 must stay text".into()],
    ];

    let sheet = api.create_spreadsheet("Lotus smoke test", "Daily", &columns).await?;
    println!("sheet created: {}", sheet.url);
    let appended = api.append_rows(&sheet.id, "Daily", &rows).await?;
    println!("rows appended: {} at {}", appended.rows, appended.range);

    let folder = api.create_folder("Lotus smoke test", None).await?;
    println!("folder created: {}", folder.url);
    let doc = api
        .upload_file(&folder.id, &Upload::GoogleDoc.file_name("Lotus smoke test — report"), b"# All up\n\n- **checkout-api**: slow (p95 820 ms)\n- payments: up\n", Upload::GoogleDoc)
        .await?;
    println!("google doc (from markdown): {}", doc.url);
    let csv = api.upload_file(&folder.id, &Upload::Csv.file_name("Lotus smoke test — rows"), to_csv(&columns, &rows).as_bytes(), Upload::Csv).await?;
    println!("csv: {}", csv.url);
    println!("\nCheck: the sheet has the header and 2 rows, and \"=1+1 must stay text\" is text (not 2); the doc shows a heading and a bold word.");
    Ok(())
}
