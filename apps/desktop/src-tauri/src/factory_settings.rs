//! Desktop Factory configuration safety. Shared with admission so remove cannot race Start.
use rusqlite::Connection;
pub static CONFIG_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub fn ensure_idle(connection: &Connection, repo: &str) -> Result<(), String> {
    let mut stmt = connection.prepare("SELECT checkpoint_json FROM codecanvas_graph_runs WHERE status IN ('running','paused','waiting')").map_err(|_| "Cannot verify unfinished Factory runs")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|_| "Cannot verify unfinished Factory runs")?;
    for row in rows {
        let raw = row.map_err(|_| "Cannot read unfinished Factory runs")?;
        let json: serde_json::Value = serde_json::from_str(&raw).map_err(|_| {
            "An unfinished run cannot be read; resolve it before changing Factory configuration"
        })?;
        if let Some(factory) = json
            .pointer("/engine/factory")
            .filter(|value| !value.is_null())
        {
            let identity = factory
                .get("repo")
                .and_then(|v| v.as_str())
                .filter(|r| !r.is_empty())
                .ok_or("An unfinished Factory run has an invalid repository identity")?;
            if identity == repo {
                return Err("Finish or cancel this repository's unfinished Factory runs first, including paused or waiting runs".into());
            }
        }
    }
    Ok(())
}

async fn mutate<T: Send + 'static>(
    app: tauri::AppHandle,
    repo: String,
    action: impl FnOnce(lotus_graph_run::factory::kit::KitSources) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    use tauri::Manager;
    let _guard = CONFIG_LOCK.lock().await;
    if app
        .try_state::<crate::graph_run_host::GraphRunHost>()
        .is_none()
    {
        return Err("The Factory runtime is not ready".into());
    }
    if app.try_state::<lotus_graph_run::factory::check_trials::CheckTrials>().is_some_and(|trials| trials.is_running(&repo)) {
        return Err("Finish or cancel this repository's check trial before changing Factory configuration".into());
    }
    tokio::task::spawn_blocking(move || {
        let c = crate::codecanvas_store::open_app_store(&app)
            .map_err(|_| "Cannot open Factory run storage")?;
        ensure_idle(&c, &repo)?;
        action(crate::graph_run_host::factory_kit_sources())
    })
    .await
    .map_err(|_| "Factory configuration operation was interrupted".to_string())?
}

#[tauri::command]
pub async fn factory_check_suggestions(
    checkout: String,
) -> Result<Vec<lotus_graph_run::factory::settings::CheckSuggestion>, String> {
    tokio::task::spawn_blocking(move || {
        lotus_graph_run::factory::settings::suggest_checks(std::path::Path::new(&checkout))
    })
    .await
    .map_err(|_| "Check discovery was interrupted".to_string())?
}

#[tauri::command]
pub async fn factory_gate_save(
    app: tauri::AppHandle,
    checkout: String,
    repo: String,
    gate: String,
    private: bool,
) -> Result<lotus_graph_run::factory::FactoryDefinition, String> {
    let identity = repo.clone();
    mutate(app, repo, move |sources| {
        let dir = if private {
            sources.private_dir(&identity).ok_or("Invalid repository")?
        } else {
            checkout.into()
        };
        lotus_graph_run::factory::settings::save_gate(&dir, &gate, private)
    })
    .await
}

#[tauri::command]
pub async fn factory_private_remove(app: tauri::AppHandle, repo: String) -> Result<String, String> {
    let identity = repo.clone();
    mutate(app, repo, move |sources| {
        lotus_graph_run::factory::settings::archive_private(&sources, &identity)
    })
    .await
}

#[tauri::command]
pub async fn factory_private_restore(
    app: tauri::AppHandle,
    repo: String,
    recovery_id: String,
) -> Result<lotus_graph_run::factory::FactoryDefinition, String> {
    let identity = repo.clone();
    mutate(app, repo, move |sources| {
        lotus_graph_run::factory::settings::restore_private(&sources, &identity, &recovery_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unfinished_factory_runs_block_mutation_including_paused_and_waiting() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE codecanvas_graph_runs(status TEXT, checkpoint_json TEXT)")
            .unwrap();
        for state in ["running", "paused", "waiting"] {
            c.execute("DELETE FROM codecanvas_graph_runs", []).unwrap();
            c.execute(
                "INSERT INTO codecanvas_graph_runs VALUES (?1, ?2)",
                rusqlite::params![state, r#"{"engine":{"factory":{"repo":"acme/app"}}}"#],
            )
            .unwrap();
            assert!(ensure_idle(&c, "acme/app").is_err());
            assert!(ensure_idle(&c, "acme/other").is_ok());
        }
        c.execute("UPDATE codecanvas_graph_runs SET status='done'", [])
            .unwrap();
        assert!(ensure_idle(&c, "acme/app").is_ok());
        c.execute(
            "INSERT INTO codecanvas_graph_runs VALUES ('running','{\"engine\":{\"factory\":{}}}')",
            [],
        )
        .unwrap();
        assert!(
            ensure_idle(&c, "acme/app").is_err(),
            "malformed Factory identity fails closed"
        );
        c.execute("DELETE FROM codecanvas_graph_runs", []).unwrap();
        c.execute(
            "INSERT INTO codecanvas_graph_runs VALUES ('running','broken')",
            [],
        )
        .unwrap();
        assert!(
            ensure_idle(&c, "acme/app").is_err(),
            "unknown unfinished records fail closed"
        );
    }
}
