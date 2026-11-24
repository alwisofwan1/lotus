//! Kept runs: each agent run an automation keeps gets a session id chosen up
//! front and recorded on its run, so the user can reopen the conversation in a
//! pane (`--resume`) — as bb opens a run's thread.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::agent::AgentSession;
use crate::store::Store;

/// Whether a conversation's transcript is still on disk, so a Follow-up Run can resume it.
/// The host answers from the agent's project folders; tests substitute it.
pub trait Transcripts: Send + Sync {
    fn exists(&self, cwd: &str, session_id: &str) -> bool;
}

/// What a run's row needs to reopen its conversation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSession {
    pub id: String,
    /// The folder the agent ran in. `--resume` only finds the session from here.
    pub cwd: String,
    /// The preset it ran as; the resume command is built from it.
    pub preset_id: String,
    /// The Lotus workspace it ran in as a pane; reopening goes back there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// Chooses where kept runs live and records each one before it starts.
pub struct SessionKeeper {
    store: Arc<Store>,
    /// Parent of the per-automation folders used when an automation names none.
    root: PathBuf,
}

impl SessionKeeper {
    pub fn new(store: Arc<Store>, root: PathBuf) -> Self {
        Self { store, root }
    }

    /// The folder an automation's runs use when it names none: its own, empty,
    /// so no project's `CLAUDE.md` or settings leak into the run.
    pub fn default_folder(&self, automation_id: &str) -> PathBuf {
        self.root.join(automation_id)
    }

    /// A new session for `run_id`, recorded before the agent starts so even a
    /// run that fails half-way can be reopened.
    pub fn start(
        &self,
        run_id: &str,
        automation_id: &str,
        preset_id: &str,
        folder: Option<&Path>,
        workspace_id: Option<&str>,
    ) -> AgentSession {
        let cwd = folder.map(Path::to_path_buf).unwrap_or_else(|| self.default_folder(automation_id));
        let session = AgentSession { id: uuid::Uuid::new_v4().to_string(), cwd, resume: false };
        let record = RunSession {
            id: session.id.clone(),
            cwd: session.cwd.to_string_lossy().into_owned(),
            preset_id: preset_id.to_string(),
            workspace_id: workspace_id.map(str::to_string),
        };
        if let Err(e) = self.store.set_run_session(run_id, &record) {
            // The run still happens; only reopening it is lost.
            eprintln!("[automation] could not record the session of run {run_id}: {e}");
        }
        session
    }

    /// A Follow-up Run of `asked`: the same place and preset, recorded on `run_id` too so it can
    /// be reopened. `resume`: continue that conversation; otherwise a new one in the same folder.
    pub fn follow(&self, run_id: &str, asked: &RunSession, resume: bool) -> (AgentSession, RunSession) {
        let id = if resume { asked.id.clone() } else { uuid::Uuid::new_v4().to_string() };
        let record = RunSession { id: id.clone(), ..asked.clone() };
        if let Err(e) = self.store.set_run_session(run_id, &record) {
            eprintln!("[automation] could not record the session of run {run_id}: {e}");
        }
        (AgentSession { id, cwd: PathBuf::from(&asked.cwd), resume }, record)
    }
}

/// Where a Follow-up Run of `asked_run_id` works (PLAN §8 Q7, Q17): the asking run's own session,
/// resumed while `transcripts` says its transcript exists, else a new one in the same place with
/// the same preset — recorded on `run_id`. An asking run that kept none: a new conversation in
/// the automation's own folder, as `preset_id`.
pub fn follow_session(
    store: &Store,
    keeper: &SessionKeeper,
    transcripts: Option<&dyn Transcripts>,
    run_id: &str,
    asked_run_id: &str,
    automation_id: &str,
    preset_id: &str,
) -> Result<(AgentSession, RunSession), String> {
    let asked = store.run_session(asked_run_id).map_err(|e| format!("could not read the asking run: {e}"))?;
    let Some(asked) = asked else {
        let session = keeper.start(run_id, automation_id, preset_id, None, None);
        let record = RunSession {
            id: session.id.clone(),
            cwd: session.cwd.to_string_lossy().into_owned(),
            preset_id: preset_id.to_string(),
            workspace_id: None,
        };
        return Ok((session, record));
    };
    // Resumed only when the transcript is known to exist; otherwise a new conversation in place.
    let resume = transcripts.is_some_and(|t| t.exists(&asked.cwd, &asked.id));
    Ok(keeper.follow(run_id, &asked, resume))
}

/// `~` or `~/…` → under `home`; anything else unchanged.
pub fn expand_home(path: &str, home: &Path) -> PathBuf {
    match path.strip_prefix('~') {
        Some("") => home.to_path_buf(),
        Some(rest) if rest.starts_with('/') => home.join(&rest[1..]),
        _ => PathBuf::from(path),
    }
}

/// A form's working folder, checked: absolute once `~` is expanded, and an
/// existing folder. `Ok(None)` when left empty. Errors name the field.
pub fn checked_workdir(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(raw) = raw.map(str::trim).filter(|w| !w.is_empty()) else { return Ok(None) };
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path = expand_home(raw, &home);
    if !path.is_absolute() {
        return Err(format!("working folder: {raw} is not a full path (start with / or ~)"));
    }
    if !path.is_dir() {
        return Err(format!("working folder: {} does not exist", path.display()));
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// A saved working folder, checked again when a run starts: it may have been
/// moved or deleted since the form was saved. `Ok(None)` when none is set.
pub fn existing_folder(saved: Option<&str>) -> Result<Option<PathBuf>, String> {
    match saved.map(str::trim).filter(|w| !w.is_empty()) {
        None => Ok(None),
        Some(dir) => {
            let path = PathBuf::from(dir);
            if path.is_absolute() && path.is_dir() {
                Ok(Some(path))
            } else {
                Err(format!("the working folder {dir} does not exist"))
            }
        }
    }
}
