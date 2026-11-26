use crate::no_window::NoWindow;
#[cfg(unix)]
mod orphan_reaper;
#[cfg(unix)]
pub mod sessiond_client;
#[cfg(unix)]
pub mod remote;
mod shell_integration;
pub(crate) use lotus_pty::{output_tail, process_tree, size_lease};
pub use lotus_pty::OutputSink;
mod command;
mod resolve;
mod session;
mod sizing;
mod store;
pub use command::*;
pub(crate) use resolve::*;
pub use session::*;
pub use sizing::*;
pub use store::*;

use portable_pty::CommandBuilder;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;

/// PTY output channel. Raw bytes (`ipc::Response`), never `Vec<u8>`: Tauri serialises a
/// `Vec<u8>` as a JSON number array (~3.5x the bytes, then parsed and copied in JS);
/// a raw body arrives as an ArrayBuffer, which `makePtyDecoder` already accepts.
pub type PtyOutputChannel = Channel<tauri::ipc::Response>;

pub(crate) fn channel_sink(channel: PtyOutputChannel) -> OutputSink {
    Box::new(move |data| channel.send(tauri::ipc::Response::new(data)).is_err())
}
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::error::{other, AppError};
use crate::models::SessionInfo;
use crate::paths;

/// Crate-visible so callers that must agree with the ring's size — the HTTP read cap, and
/// the tests that assert eviction — can derive it instead of restating a literal that goes
/// stale the moment the ring is resized.
pub(crate) use output_tail::OUTPUT_TAIL_BYTES;
pub use output_tail::{OutputTail, PtyOutputMetrics};

/// Serialises the tests that time real process deaths. The orphan reaper's end-to-end test runs
/// a CPU spinner; run beside `kill_session_terminates_descendant_processes` on a loaded machine
/// it made that test's 200 ms grace window miss 3 times in 18 runs (0 in 10 without it).
#[cfg(test)]
pub(crate) static PROCESS_KILL_TEST_LOCK: Mutex<()> = Mutex::new(());

pub fn create_session(
    cwd: String,
    window_label: String,
    pane_id: Option<String>,
    canvas_env: Option<CanvasPtyEnv>,
    claude_account: Option<String>,
    cols: u16,
    rows: u16,
    on_output: OutputSink,
    state: &PtyState,
) -> Result<String, AppError> {
    let resolved_cwd = resolve_session_cwd(&cwd);
    let canvas_terminal_id = canvas_env.as_ref().map(|env| env.terminal_id.clone());
    let mut builder = build_pty_shell_command(&resolved_cwd, pane_id.as_deref(), canvas_env.as_ref());
    with_account(&mut builder, claude_account.as_deref())?;
    spawn_session(
        resolved_cwd,
        window_label,
        cols,
        rows,
        Some(on_output),
        state,
        builder,
        canvas_terminal_id,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn create_command_session(
    cwd: String,
    window_label: String,
    pane_id: Option<String>,
    canvas_env: Option<CanvasPtyEnv>,
    command: Vec<String>,
    claude_account: Option<String>,
    cols: u16,
    rows: u16,
    on_output: OutputSink,
    state: &PtyState,
) -> Result<String, AppError> {
    let resolved_cwd = resolve_session_cwd(&cwd);
    let canvas_terminal_id = canvas_env.as_ref().map(|env| env.terminal_id.clone());
    let (command, claude_account) = legacy_ccs(command, claude_account, |id| crate::accounts::find(id).is_some());
    let mut command_builder = build_pty_command(
        &command,
        &resolved_cwd,
        pane_id.as_deref(),
        canvas_env.as_ref(),
    )?;
    with_account(&mut command_builder, claude_account.as_deref())?;
    spawn_session(
        resolved_cwd,
        window_label,
        cols,
        rows,
        Some(on_output),
        state,
        command_builder,
        canvas_terminal_id,
    )
}

pub fn create_headless_session(
    cwd: String,
    cols: u16,
    rows: u16,
    state: &PtyState,
) -> Result<String, AppError> {
    let resolved_cwd = resolve_session_cwd(&cwd);
    let builder = build_pty_shell_command(&resolved_cwd, None, None);
    spawn_session(
        resolved_cwd,
        "headless".to_string(),
        cols,
        rows,
        None,
        state,
        builder,
        None,
    )
}

pub fn create_headless_command_session(
    cwd: String,
    command: Vec<String>,
    cols: u16,
    rows: u16,
    state: &PtyState,
) -> Result<String, AppError> {
    let resolved_cwd = resolve_session_cwd(&cwd);
    let command_builder = build_pty_command(&command, &resolved_cwd, None, None)?;
    spawn_session(
        resolved_cwd,
        "headless".to_string(),
        cols,
        rows,
        None,
        state,
        command_builder,
        None,
    )
}

#[cfg(test)]
mod tests;
