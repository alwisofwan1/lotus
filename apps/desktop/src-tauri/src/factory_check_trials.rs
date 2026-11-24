//! Narrow main-webview IPC for explicitly confirmed Factory check trials.
use lotus_graph_run::factory::{
    check_trial::{shell_mode, TrialPreview},
    check_trials::{CheckTrials, TrialSnapshot},
};
use tauri::Manager;
fn trials(app: &tauri::AppHandle) -> Result<tauri::State<'_, CheckTrials>, String> {
    app.try_state::<CheckTrials>()
        .ok_or("Factory check trials are not ready. Restart the desktop app.".into())
}
#[tauri::command]
pub async fn factory_check_preview(
    app: tauri::AppHandle,
    checkout: String,
    repo: String,
    base: String,
    command: String,
) -> Result<TrialPreview, String> {
    if !cfg!(unix) {
        return Err("Try checks currently requires macOS or Linux process-group support".into());
    }
    if crate::graph_run_host::factory_kit_sources()
        .private_dir(&repo)
        .is_none()
    {
        return Err("Choose a valid owner/name repository".into());
    }
    let path = std::path::Path::new(&checkout);
    let shell = shell_mode(path, &base, crate::shell_env::user_login_env()).await?;
    trials(&app)?
        .preview(path, &repo, &base, &command, shell)
        .await
}
#[tauri::command]
pub async fn factory_check_start(
    app: tauri::AppHandle,
    preview_id: String,
) -> Result<TrialSnapshot, String> {
    let _guard = crate::factory_settings::CONFIG_LOCK.lock().await;
    let service = trials(&app)?;
    let repo = service.planned_repo(&preview_id)?;
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let c = crate::codecanvas_store::open_app_store(&handle)
            .map_err(|_| "Cannot verify unfinished Factory runs")?;
        crate::factory_settings::ensure_idle(&c, &repo)
    })
    .await
    .map_err(|_| "Check trial admission was interrupted")??;
    service.start(&preview_id)
}
#[tauri::command]
pub async fn factory_check_status(
    app: tauri::AppHandle,
    checkout: String,
    repo: String,
    base: String,
) -> Result<Option<TrialSnapshot>, String> {
    let mut result = trials(&app)?.status(&repo).await;
    if let Some(snapshot) = &mut result {
        snapshot.current_revision = lotus_graph_run::factory::check_trial::revision(
            std::path::Path::new(&checkout),
            &base,
            crate::shell_env::user_login_env(),
        )
        .await
        .ok();
    }
    Ok(result)
}
#[tauri::command]
pub fn factory_check_cancel(app: tauri::AppHandle, repo: String, id: String) -> Result<(), String> {
    trials(&app)?.cancel(&repo, &id)
}
