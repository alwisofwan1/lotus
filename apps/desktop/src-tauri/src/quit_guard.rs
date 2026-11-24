//! What happens to agents in the session daemon when Lotus quits (ADR-0067, PHASE-3 step 6).
//!
//! macOS sends ⌘Q, Dock › Quit and logout straight to `terminate:`; Tauri never raises
//! `ExitRequested` for them (measured 2026-11-17), so the question is asked from the app
//! delegate's `applicationShouldTerminate:` (`macos_dock.rs`), which can still say no.
//!
//! - A system quit (logout, restart, shutdown: the Apple event carries a reason) never asks.
//! - A user quit with agents running and no saved choice is stopped, and the frontmost window
//!   asks; its answer comes back through [`answer`].
//! - On the final `Exit`, [`on_exit`] keeps or ends the daemon sessions.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::pty::{self, PtyState};

/// The event a window gets when a quit was stopped to ask about running agents.
pub const QUIT_AGENTS_EVENT: &str = "lotus://quit-agents-running";
/// The event a window gets when a quit was stopped because in-process agents would end with it.
pub const QUIT_AGENTS_WILL_STOP_EVENT: &str = "lotus://quit-agents-will-stop";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Choice {
    Keep,
    Stop,
}

#[derive(Serialize, Clone, Debug)]
pub struct RunningAgent {
    pub agent: String,
    pub cwd: String,
}

/// Decided for this quit; `None` until something decides, then [`on_exit`] reads it.
static DECIDED: Mutex<Option<Choice>> = Mutex::new(None);

fn decided() -> Option<Choice> {
    *DECIDED.lock().unwrap_or_else(|e| e.into_inner())
}

fn decide(choice: Choice) {
    *DECIDED.lock().unwrap_or_else(|e| e.into_inner()) = Some(choice);
}

fn choice_file() -> PathBuf {
    crate::paths::lotus_state_dir().join("quit-agents.json")
}

fn kept_file() -> PathBuf {
    crate::paths::lotus_state_dir().join("kept-agents.json")
}

/// The choice saved with "Remember my choice"; `None` = ask.
pub fn saved() -> Option<Choice> {
    crate::json::read_json::<Choice>(&choice_file())
}

pub fn save(choice: Option<Choice>) -> Result<(), crate::error::AppError> {
    match choice {
        Some(choice) => crate::json::write_json(&choice_file(), &choice),
        None => match std::fs::remove_file(choice_file()) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
            _ => Ok(()),
        },
    }
}

/// Only sessions in the daemon can outlive Lotus, so only they are worth asking about.
fn running_agents(app: &AppHandle) -> Vec<RunningAgent> {
    app.try_state::<PtyState>()
        .map(|state| {
            pty::daemon_agent_sessions(&state)
                .into_iter()
                .map(|(_, agent, cwd)| RunningAgent { agent, cwd })
                .collect()
        })
        .unwrap_or_default()
}

/// Agents running inside Lotus while the daemon was meant to hold them (enabled, unreachable).
/// Windows and Linux run in-process by design, so there they are not worth a warning.
fn stranded_agents(app: &AppHandle) -> Vec<RunningAgent> {
    #[cfg(unix)]
    let enabled = pty::sessiond_client::enabled();
    #[cfg(not(unix))]
    let enabled = false;
    if !enabled {
        return Vec::new();
    }
    app.try_state::<PtyState>()
        .map(|state| {
            pty::local_agent_sessions(&state)
                .into_iter()
                .map(|(agent, cwd)| RunningAgent { agent, cwd })
                .collect()
        })
        .unwrap_or_default()
}

/// `applicationShouldTerminate:`. `system_reason` is the Apple event's quit reason, present
/// only for logout, restart and shutdown. True = quit now; false = stopped, a window asks.
pub fn should_terminate(app: &AppHandle, system_reason: Option<String>) -> bool {
    if let Some(choice) = decided() {
        eprintln!("[quit] already decided: {choice:?}");
        return true;
    }
    if let Some(reason) = system_reason {
        let choice = saved().unwrap_or(Choice::Stop);
        eprintln!("[quit] system quit ({reason}): {choice:?}");
        decide(choice);
        return true;
    }
    if crate::editor_unsaved::should_block_quit(app) {
        return false;
    }
    // A saved "Keep running" cannot be honoured for these, so this asks even when one is saved.
    let stranded = stranded_agents(app);
    if !stranded.is_empty() {
        eprintln!("[quit] user quit, {} in-process agent(s) would stop", stranded.len());
        return ask(app, QUIT_AGENTS_WILL_STOP_EVENT, &stranded);
    }
    let agents = running_agents(app);
    let decision = pick(agents.is_empty(), saved());
    eprintln!(
        "[quit] user quit, {} agent(s) in the daemon: {decision:?}",
        agents.len()
    );
    if let Some(choice) = decision {
        decide(choice);
        return true;
    }
    ask(app, QUIT_AGENTS_EVENT, &agents)
}

/// Brings the frontmost window up and has it ask. False = the quit waits for [`answer`].
fn ask(app: &AppHandle, event: &str, agents: &[RunningAgent]) -> bool {
    let window = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
        .or_else(|| app.webview_windows().into_values().next());
    let Some(window) = window else {
        // Nothing can ask: never hold the quit hostage.
        decide(Choice::Stop);
        return true;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    let _ = window.emit(event, agents);
    false
}

/// A user quit's outcome without asking: `None` means ask.
fn pick(no_agents: bool, saved: Option<Choice>) -> Option<Choice> {
    if no_agents {
        // Shells alone are not worth keeping; they end as they always did.
        Some(Choice::Stop)
    } else {
        saved
    }
}

/// The dialog's answer. `None` = Cancel: Lotus stays open.
pub fn answer(
    app: &AppHandle,
    choice: Option<Choice>,
    remember: bool,
) -> Result<(), crate::error::AppError> {
    let Some(choice) = choice else {
        return Ok(());
    };
    if remember {
        save(Some(choice))?;
    }
    decide(choice);
    request_quit(app);
    Ok(())
}

/// Quit through `terminate:` so every guard runs again (unsaved files, then agents).
pub fn request_quit(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.run_on_main_thread(|| {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                objc2_app_kit::NSApp(mtm).terminate(None);
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    app.exit(0);
}

/// `RunEvent::Exit`. Keep: daemon sessions are only let go of; otherwise all end.
/// A quit nothing decided (an update, `app.exit` elsewhere) uses the saved choice.
pub fn on_exit(state: &PtyState) {
    let choice = decided().or_else(saved).unwrap_or(Choice::Stop);
    if choice == Choice::Keep {
        let kept: Vec<String> = pty::daemon_agent_sessions(state)
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        let released = pty::release_all_sessions(state);
        eprintln!(
            "[quit] exit: let go of {released} session(s), {} agent(s) keep running",
            kept.len()
        );
        if !kept.is_empty() {
            let _ = crate::json::write_json(&kept_file(), &kept);
        }
    } else {
        let ended = pty::close_all_sessions(state);
        eprintln!("[quit] exit: ended {ended} session(s)");
    }
}

/// Once per start: how many agents kept at the last quit are still alive in the daemon.
pub fn take_kept_agents() -> usize {
    let Some(kept) = crate::json::read_json::<Vec<String>>(&kept_file()) else {
        return 0;
    };
    let _ = std::fs::remove_file(kept_file());
    #[cfg(unix)]
    if let Some(d) = pty::sessiond_client::daemon() {
        if let Ok(live) = d.list() {
            return kept
                .iter()
                .filter(|id| live.iter().any(|s| &s.id == *id))
                .count();
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_quit_asks_only_when_agents_run_and_nothing_is_saved() {
        assert_eq!(pick(true, None), Some(Choice::Stop));
        assert_eq!(pick(true, Some(Choice::Keep)), Some(Choice::Stop));
        assert_eq!(pick(false, Some(Choice::Keep)), Some(Choice::Keep));
        assert_eq!(pick(false, Some(Choice::Stop)), Some(Choice::Stop));
        assert_eq!(pick(false, None), None);
    }

    #[test]
    fn the_choice_is_saved_as_a_plain_word() {
        assert_eq!(serde_json::to_string(&Choice::Keep).unwrap(), "\"keep\"");
        assert_eq!(
            serde_json::from_str::<Choice>("\"stop\"").unwrap(),
            Choice::Stop
        );
    }
}
