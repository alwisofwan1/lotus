mod no_window;
#[cfg(test)]
mod acl_manifest_tests;
mod agent_hooks;
mod agent_models;
mod bug_report;
mod api_auth;
mod api_server;
mod automation_host;
mod automation_google;
mod automation_slack;
mod bridge_chat;
mod bridge_memory_store;
mod bridge_task_feedback;
mod bridge_tasks;
mod vault_ticket_edit;
mod vault_tickets;
mod vault_watcher;
mod voice_duck;
mod agent_done_sound;
mod nav_guard;
mod editor_watcher;
mod git_graph;
mod worktree_cleanup;
mod browser_helper;
mod browser_mcp;
mod canvas_browser;
mod canvas_browser_approval;
mod canvas_browser_local_files;
mod canvas_browser_policy;
mod canvas_browser_screenshot;
mod canvas_browser_snapshot;
mod canvas_templates;
mod canvas_themes;
mod agent_catalog;
mod cli_detect;
mod cli_tools;
mod cli_updates;
mod codecanvas_agents;
mod codecanvas_artifacts;
mod codecanvas_graph_runs;
mod factory_host;
mod factory_settings;
mod factory_check_trials;
mod graph_run_host;
mod codecanvas_memory;
mod codecanvas_note_assets;
mod codecanvas_runs;
mod codecanvas_sessions;
mod codecanvas_store;
#[cfg(test)]
mod codecanvas_store_tests;
mod chat_runtime;
mod agent_cli;
mod browser_preview;
mod project_files;
mod codespace_git;
mod codespace_git_ssh;
mod codespace_store;
mod codex_hooks;
mod editor_backup;
mod editor_encoding;
mod editor_lsp;
mod editor_search;
mod editor_fs;
mod editor_fs_ssh;
mod editor_unsaved;
mod editor_opener;
mod error;
mod fs_browse;
mod fs_browse_ssh;
mod remote_access;
mod remote_hooks;
mod remote_lotus_host;
mod managed_host;
mod remote_host_link;
mod remote_usage;
mod remote_accounts;
mod remote_tunnel;
mod host_runtime;
mod json;
mod launch;
mod launch_prompt;
mod launch_status;
#[cfg(target_os = "macos")]
mod macos_dock;
mod quit_guard;
mod mcp_automation;
mod mcp_canvas_memory;
mod mcp_factory;
mod mcp_notes;
mod notes;
mod notes_write;
mod mcp_config;
mod mcp_health;
mod mcp_ipc;
mod mcp_keeper;
mod mcp_telemetry;
mod migrations;
mod model_registry;
mod models;
mod nl_model;
mod nl_runtime;
mod notification_event;
mod notion_host;
mod github_issues_host;
mod pane_title;
mod paths;
mod permission_prompt;
mod permission_prompt_wrap;
#[cfg(test)]
mod terminal_screen;
mod processes;
mod pty;
mod remote_capability;
mod remote_error;
mod remote_transport;
mod runners;
mod s2s_providers;
mod s2s_stream;
mod session_diagnostics;
mod settings;
mod shell_env;
mod accounts;
mod account_context;
mod ccs_migration;
mod usage;
mod skills;
mod smart_convert;
mod ssh_config;
mod ssh_control_socket;
mod ssh_error_hints;
mod stt_decoder_context;
mod stt_providers;
mod stt_stream;
mod tasks_persist;
mod teams;
mod terminal_file_drop;
mod terminal_file_drop_inspect;
#[cfg(test)]
mod terminal_file_drop_tests;
mod time;
mod trust_reconciler;
mod tts_providers;
mod tts_runtime;
mod voice_http;
mod webview_panes;
mod windowing;
mod youtube_meta;

use std::net::TcpListener;
use std::sync::{Arc, Mutex};

pub use error::AppError;
pub use pty::PtyState;

/// System Settings › Privacy › Microphone. The one non-web link `open_external_link` accepts —
/// Voice settings' "Open Privacy" fix; never arbitrary app schemes.
const MAC_MIC_PRIVACY_URL: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

fn external_link_allowed(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    url == MAC_MIC_PRIVACY_URL
        || ["http://", "https://", "mailto:", "tel:"]
            .iter()
            .any(|prefix| lower.starts_with(prefix))
}

#[cfg(test)]
mod external_link_tests {
    use super::*;

    #[test]
    fn allows_web_links_and_only_the_microphone_privacy_pane() {
        assert!(external_link_allowed("https://lotus.dev"));
        assert!(external_link_allowed("mailto:a@b.c"));
        assert!(external_link_allowed(MAC_MIC_PRIVACY_URL));
        assert!(!external_link_allowed(
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera"
        ));
        assert!(!external_link_allowed("file:///etc/passwd"));
    }
}

// ─── HTTP API helpers ─────────────────────────────────────────────────────────

const API_PORT_ENV: &str = "LOTUS_API_PORT";
const API_PORT_FALLBACK_ATTEMPTS: u16 = 20;

#[derive(Clone)]
pub struct ApiServerEndpoint {
    pub base_url: String,
}

/// Writes `~/.lotus/api-server.json` so that lotus-remote (and any other local
/// client) can discover the port and API key file without hardcoding either.
///
/// Path moved out of `~/.claude/` so Lotus doesn't squat on Claude CLI's
/// config dir; api_auth + lotus-remote both consult `~/.lotus/` first and
/// fall back to the legacy `~/.claude/` location for installs that
/// predate the move.
fn write_api_server_discovery(api_key: &api_auth::ApiKey, port: u16) {
    let lotus_dir = paths::lotus_state_dir();
    let _ = std::fs::create_dir_all(&lotus_dir);
    let key_path = lotus_dir.join("api-server.key");
    let discovery = serde_json::json!({
        "port": port,
        "keyFile": key_path.to_string_lossy(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    let _ = json::write_json(&lotus_dir.join("api-server.json"), &discovery);
    eprintln!(
        "[lotus-api] HTTP API server ready on 127.0.0.1:{} — key: {}",
        port,
        api_key
            .as_str()
            .get(..8)
            .map(|p| format!("{p}..."))
            .unwrap_or_default()
    );
}

fn requested_api_port() -> (u16, bool) {
    match std::env::var(API_PORT_ENV) {
        Ok(raw) => match raw.parse::<u16>() {
            Ok(port) if port > 0 => (port, true),
            _ => {
                eprintln!(
                    "[lotus-api] Ignoring invalid {API_PORT_ENV}={raw:?}; using default {}",
                    api_server::API_PORT
                );
                (api_server::API_PORT, false)
            }
        },
        Err(_) => (api_server::API_PORT, false),
    }
}

fn bind_api_listener() -> std::io::Result<(TcpListener, u16)> {
    let (preferred_port, explicit) = requested_api_port();
    let attempts = if explicit {
        1
    } else {
        API_PORT_FALLBACK_ATTEMPTS
    };
    let mut last_error = None;

    for offset in 0..attempts {
        let Some(port) = preferred_port.checked_add(offset) else {
            break;
        };
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => {
                listener.set_nonblocking(true)?;
                if port != preferred_port {
                    eprintln!(
                        "[lotus-api] Port {preferred_port} already in use; using 127.0.0.1:{port}"
                    );
                }
                return Ok((listener, port));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && !explicit => {
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AddrInUse,
            format!(
                "no available Lotus API port in range {}..{}",
                preferred_port,
                preferred_port.saturating_add(API_PORT_FALLBACK_ATTEMPTS.saturating_sub(1))
            ),
        )
    }))
}

pub type McpIpcSharedState = Arc<mcp_ipc::McpIpcState>;

#[derive(Default)]
pub struct McpIpcRuntime {
    handle: Mutex<Option<mcp_ipc::McpIpcHandle>>,
    bound_port: Mutex<Option<u16>>,
}

impl McpIpcRuntime {
    fn set_handle(&self, handle: mcp_ipc::McpIpcHandle) {
        *self
            .bound_port
            .lock()
            .expect("mcp ipc runtime mutex poisoned") = Some(handle.port);
        *self.handle.lock().expect("mcp ipc runtime mutex poisoned") = Some(handle);
    }

    fn take_handle(&self) -> Option<mcp_ipc::McpIpcHandle> {
        self.handle
            .lock()
            .expect("mcp ipc runtime mutex poisoned")
            .take()
    }

    pub fn bound_port(&self) -> Option<u16> {
        *self
            .bound_port
            .lock()
            .expect("mcp ipc runtime mutex poisoned")
    }
}

// ─── Tauri commands ───────────────────────────────────────────────────────────
//
// All #[tauri::command] functions live in this submodule to avoid the E0255
// re-export collision introduced in tauri-macros 2.5.5 with Rust 1.88+.
// Each command delegates to the corresponding domain module.

/// Where a remote process reaches this desktop, and the bearer it must present.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LotusApiCredentials {
    pub port: u16,
    pub key: String,
}

/// What the picker needs to know about a machine before anybody clicks it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineReadiness {
    /// A live SSH master already exists for this target.
    pub connected: bool,
    /// Present only for hosts reached through Cloudflare Access.
    pub access: Option<remote_access::AccessStatus>,
}

/// Where CodeChat kept its history. CodeChat is gone (07p); the chat's importer still reads it.
fn codechat_database_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map(|path| path.join("codechat.sqlite3"))
        .map_err(|err| err.to_string())
}

pub mod commands {
    use super::*;
    use tauri::{ipc::Channel, Manager, State, Window};
    use tauri_plugin_shell::ShellExt;

    // ── PTY sessions ──────────────────────────────────────────────────────────

    #[tauri::command]
    pub async fn create_session(
        window: Window,
        cwd: String,
        pane_id: Option<String>,
        canvas_terminal_id: Option<String>,
        claude_account: Option<String>,
        cols: u16,
        rows: u16,
        on_output: pty::PtyOutputChannel,
        state: State<'_, PtyState>,
        api_key_state: State<'_, std::sync::Arc<crate::api_auth::ApiKey>>,
        api_endpoint: State<'_, crate::ApiServerEndpoint>,
        mcp: State<'_, McpIpcSharedState>,
    ) -> Result<String, AppError> {
        let on_output = pane_output_sink(on_output, pane_id.as_deref(), &mcp);
        let canvas_env = canvas_terminal_id.map(|tid| pty::CanvasPtyEnv {
            terminal_id: tid,
            api_url: api_endpoint.base_url.clone(),
            api_key: api_key_state.inner().0.clone(),
        });
        pty::create_session(
            cwd,
            window.label().to_string(),
            pane_id,
            canvas_env,
            claude_account,
            cols,
            rows,
            on_output,
            &state,
        )
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn create_command_session(
        window: Window,
        cwd: String,
        pane_id: Option<String>,
        canvas_terminal_id: Option<String>,
        command: Vec<String>,
        claude_account: Option<String>,
        cols: u16,
        rows: u16,
        on_output: pty::PtyOutputChannel,
        state: State<'_, PtyState>,
        api_key_state: State<'_, std::sync::Arc<crate::api_auth::ApiKey>>,
        api_endpoint: State<'_, crate::ApiServerEndpoint>,
        mcp: State<'_, McpIpcSharedState>,
    ) -> Result<String, AppError> {
        let on_output = pane_output_sink(on_output, pane_id.as_deref(), &mcp);
        let canvas_env = canvas_terminal_id.map(|tid| pty::CanvasPtyEnv {
            terminal_id: tid,
            api_url: api_endpoint.base_url.clone(),
            api_key: api_key_state.inner().0.clone(),
        });
        pty::create_command_session(
            cwd,
            window.label().to_string(),
            pane_id,
            canvas_env,
            command,
            claude_account,
            cols,
            rows,
            on_output,
            &state,
        )
    }

    #[tauri::command]
    pub fn write_to_session(
        session_id: String,
        data: String,
        state: State<'_, PtyState>,
    ) -> Result<(), AppError> {
        // Only the desktop's own terminal calls this command, so a person typing here is the
        // touch that takes the pane's size back from a phone (ADR-6 addendum 2026-10-05).
        pty::note_desktop_input(&session_id, &data, &state);
        pty::write_to_session(session_id, data, &state)
    }

    #[tauri::command]
    pub fn resize_session(
        session_id: String,
        cols: u16,
        rows: u16,
        state: State<'_, PtyState>,
    ) -> Result<(), AppError> {
        pty::resize_session(session_id, cols, rows, &state)
    }

    #[tauri::command]
    pub fn kill_session(session_id: String, state: State<'_, PtyState>) -> Result<(), AppError> {
        pty::kill_session(session_id, &state)
    }

    /// Kill the invoking window's PTY sessions — called on that window's webview
    /// reload/init to prevent stale processes from accumulating across
    /// hot-reloads. Scoped by window label so it never touches another window's
    /// live sessions (all windows share one global `PtyStore`).
    #[tauri::command]
    pub fn close_window_sessions(
        window: Window,
        state: State<'_, PtyState>,
    ) -> Result<usize, AppError> {
        pty::close_sessions_for_window(window.label(), &state)
    }

    /// A pane looking for its session after a restart or reload (ADR-0067). `null` = start one.
    #[tauri::command]
    pub async fn adopt_session(
        window: Window,
        pane_id: String,
        on_output: pty::PtyOutputChannel,
        state: State<'_, PtyState>,
        mcp: State<'_, McpIpcSharedState>,
    ) -> Result<Option<String>, AppError> {
        pty::adopt_session(
            window.label().to_string(),
            &pane_id,
            pane_output_sink(on_output, Some(&pane_id), &mcp),
            &state,
        )
    }

    /// A pane's output channel, read on the way past for OSC 7501 program status.
    fn pane_output_sink(
        on_output: pty::PtyOutputChannel,
        pane_id: Option<&str>,
        mcp: &McpIpcSharedState,
    ) -> pty::OutputSink {
        let sink = pty::channel_sink(on_output);
        match pane_id {
            Some(id) => Arc::clone(mcp).program_status_sink(id.to_string(), sink),
            None => sink,
        }
    }

    /// Once a window restored its panes: ends the sessions whose pane is gone.
    /// The quit dialog's answer; `choice` null = Cancel.
    #[tauri::command]
    pub fn quit_with_agents(
        app: tauri::AppHandle,
        choice: Option<crate::quit_guard::Choice>,
        remember: bool,
    ) -> Result<(), AppError> {
        crate::quit_guard::answer(&app, choice, remember)
    }

    /// Settings: the saved quit choice; null = ask.
    #[tauri::command]
    pub fn get_quit_choice() -> Option<crate::quit_guard::Choice> {
        crate::quit_guard::saved()
    }

    #[tauri::command]
    pub fn set_quit_choice(choice: Option<crate::quit_guard::Choice>) -> Result<(), AppError> {
        crate::quit_guard::save(choice)
    }

    /// Once per start: agents kept at the last quit that are still running.
    #[tauri::command]
    pub async fn take_kept_agents() -> usize {
        tauri::async_runtime::spawn_blocking(crate::quit_guard::take_kept_agents)
            .await
            .unwrap_or(0)
    }

    /// True once per run when the session service could not be reached (#301 phase 6 toast).
    #[tauri::command]
    pub fn take_sessiond_fallback() -> bool {
        #[cfg(unix)]
        return pty::sessiond_client::take_fallback();
        #[cfg(not(unix))]
        false
    }

    #[tauri::command]
    pub async fn reconcile_sessions(window: Window, pane_ids: Vec<String>) -> Result<usize, AppError> {
        pty::reconcile_sessions(window.label(), &pane_ids)
    }

    #[tauri::command]
    pub fn list_sessions(
        window: Window,
        state: State<'_, PtyState>,
    ) -> Result<Vec<models::SessionInfo>, AppError> {
        pty::list_sessions_for_window(window.label(), &state)
    }

    #[tauri::command]
    pub fn read_scrollback(
        session_id: String,
        offset: u64,
        len: usize,
        state: State<'_, PtyState>,
    ) -> Result<pty::ScrollbackChunk, AppError> {
        pty::read_scrollback(&session_id, offset, len, &state)
    }

    // ── Teams ─────────────────────────────────────────────────────────────────

    #[tauri::command]
    pub fn list_teams() -> Vec<models::TeamConfig> {
        teams::list_teams()
    }

    #[tauri::command]
    pub fn get_team(id: String) -> Option<models::TeamConfig> {
        teams::get_team(id)
    }

    // ── CodeCanvas Artisan Theme Engine (ADR-0023, Phase 3) ──
    #[tauri::command]
    pub fn list_canvas_themes() -> Vec<serde_json::Value> {
        canvas_themes::list_canvas_themes()
    }

    #[tauri::command]
    pub fn save_canvas_theme(
        spec: serde_json::Value,
    ) -> Result<canvas_themes::SaveCanvasThemeResult, AppError> {
        canvas_themes::save_canvas_theme(spec)
    }

    #[tauri::command]
    pub fn read_canvas_theme_asset(
        theme_id: String,
        rel: String,
    ) -> Result<canvas_themes::CanvasThemeAsset, AppError> {
        canvas_themes::read_canvas_theme_asset(theme_id, rel)
    }

    #[tauri::command]
    pub fn canvas_theme_asset_path(theme_id: String, rel: String) -> Result<String, AppError> {
        canvas_themes::canvas_theme_asset_path(theme_id, rel)
    }

    #[tauri::command]
    pub fn delete_team(id: String) -> Result<(), AppError> {
        teams::delete_team(id)
    }

    // ── Settings ──────────────────────────────────────────────────────────────

    #[tauri::command]
    pub fn get_settings() -> serde_json::Value {
        settings::get_settings()
    }

    #[derive(serde::Serialize)]
    pub struct AgentHooksHealthDto {
        scripts_installed: bool,
        stop_hook_registered: bool,
        notification_hook_registered: bool,
    }

    #[tauri::command]
    pub fn get_agent_hooks_health() -> AgentHooksHealthDto {
        let scripts_installed = mcp_config::agent_notify_index_path()
            .map(|p| p.exists())
            .unwrap_or(false);
        let s = settings::get_settings();
        AgentHooksHealthDto {
            scripts_installed,
            stop_hook_registered: settings::hooks_has_agent_notify(&s, "Stop"),
            notification_hook_registered: settings::hooks_has_agent_notify(&s, "Notification"),
        }
    }

    #[tauri::command]
    pub fn save_settings(settings: serde_json::Value) -> Result<(), AppError> {
        settings::save_settings(settings)
    }

    // ── FS / directory browser ────────────────────────────────────────────────

    #[tauri::command]
    pub fn get_homedir() -> String {
        fs_browse::get_homedir()
    }

    #[tauri::command]
    pub fn list_dir_entries(browse_path: String) -> Vec<models::DirEntry> {
        fs_browse::list_dir_entries(browse_path)
    }

    /// Child directories of a path on another machine, each flagged as a git repo / node project.
    ///
    /// The remote twin of `list_dir_entries`, and the folder picker's only question over SSH.
    ///
    /// **`async` is load-bearing, not decoration.** A synchronous `#[tauri::command]` runs on the
    /// main thread, and this one can block for the full 35 s that `RemoteTransport` waits for an SSH
    /// master's control socket — which froze the entire window while the folder picker spun
    /// (observed 2026-09-15 against a host whose Cloudflare Access session had lapsed). Declaring it
    /// async moves it onto the async runtime's pool, so the picker can paint its progress and the
    /// rest of the canvas keeps running while the machine is asked.
    #[tauri::command]
    pub async fn list_dir_entries_ssh(
        target: cli_tools::SshToolTarget,
        browse_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<Vec<models::DirEntry>, AppError> {
        fs_browse_ssh::list_dir_entries_ssh(target, browse_path, Some(transport.inner()))
    }

    /// Async + `spawn_blocking`: a sync command runs on the main thread, and reading, checking
    /// and serialising a 10 MB file there froze the whole window.
    #[tauri::command]
    pub async fn editor_read_file(
        path: String,
        allow_large: Option<bool>,
    ) -> Result<editor_fs::EditorReadFileResult, AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            editor_fs::editor_read_file(path, allow_large.unwrap_or(false))
        })
            .await
            .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// A file's times and size without reading it, for the cards under a chat reply.
    #[tauri::command]
    pub async fn editor_stat_file(path: String) -> Result<editor_fs::EditorFileStat, AppError> {
        tauri::async_runtime::spawn_blocking(move || editor_fs::editor_stat_file(path))
            .await
            .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// The end of a file too large to read whole (a log), for the Chat Files drawer.
    #[tauri::command]
    pub async fn editor_read_file_tail(
        path: String,
        lines: usize,
    ) -> Result<editor_fs::EditorReadFileResult, AppError> {
        tauri::async_runtime::spawn_blocking(move || editor_fs::editor_read_file_tail(path, lines))
            .await
            .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// Raw bytes for the media viewer, as an ArrayBuffer (no JSON/base64 round trip). Async so a
    /// large video is read off the main thread.
    #[tauri::command]
    pub async fn editor_read_file_bytes(path: String) -> Result<tauri::ipc::Response, AppError> {
        let bytes =
            tauri::async_runtime::spawn_blocking(move || editor_fs::editor_read_file_bytes(path))
                .await
                .map_err(|err| AppError::Other(err.to_string()))??;
        Ok(tauri::ipc::Response::new(bytes))
    }

    /// How many files this window holds unsaved; ⌘Q asks first while any window holds some.
    #[tauri::command]
    pub fn editor_report_unsaved(window: tauri::Window, count: u32) {
        crate::editor_unsaved::report(window.label(), count);
    }

    /// Hot exit: keep a copy of an unsaved buffer (`data`, JSON from the webview) under `key`.
    #[tauri::command]
    pub async fn editor_backup_write(key: String, data: String) -> Result<(), AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::editor_backup::write(&crate::editor_backup::backups_dir(), &key, data)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// The copy kept under `key`, if any.
    #[tauri::command]
    pub async fn editor_backup_read(key: String) -> Result<Option<String>, AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::editor_backup::read(&crate::editor_backup::backups_dir(), &key)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// The buffer was saved, reverted or discarded: its copy goes.
    #[tauri::command]
    pub async fn editor_backup_delete(key: String) -> Result<(), AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::editor_backup::delete(&crate::editor_backup::backups_dir(), &key)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// Find in files under a local root. `search_id` lets a newer search cancel this one.
    #[tauri::command]
    pub async fn editor_search(
        root: String,
        query: crate::editor_search::EditorSearchQuery,
        search_id: String,
    ) -> Result<crate::editor_search::EditorSearchResult, AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::editor_search::search_local(&root, &query, &search_id)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// Find in files on an SSH host: `rg` there, or `grep`.
    #[tauri::command]
    pub async fn editor_search_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        query: crate::editor_search::EditorSearchQuery,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<crate::editor_search::EditorSearchResult, AppError> {
        // A search can run for seconds; this worker thread is handed off while it does.
        tokio::task::block_in_place(|| {
            editor_fs_ssh::editor_search_ssh(target, remote_cwd, query, Some(transport.inner()))
        })
    }

    /// Stops the local search running under `search_id`.
    #[tauri::command]
    pub fn editor_search_cancel(search_id: String) {
        crate::editor_search::cancel(&search_id);
    }

    /// Which language server a file gets, where it is installed, and the folder it serves.
    #[tauri::command]
    pub async fn editor_lsp_resolve(
        server_id: String,
        file_path: String,
        root_dir: String,
    ) -> Result<crate::editor_lsp::LspResolution, AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::editor_lsp::resolve_local(&server_id, &file_path, &root_dir)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// As `editor_lsp_resolve`, on the SSH host.
    #[tauri::command]
    pub async fn editor_lsp_resolve_ssh(
        target: cli_tools::SshToolTarget,
        server_id: String,
        file_path: String,
        root_dir: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<crate::editor_lsp::LspResolution, AppError> {
        tokio::task::block_in_place(|| {
            crate::editor_lsp::resolve_ssh(&target, &server_id, &file_path, &root_dir, Some(transport.inner()))
        })
    }

    /// Starts a server a resolve found; its messages arrive on `on_event`. Returns the session id.
    #[tauri::command]
    pub async fn editor_lsp_start(
        command: String,
        project_root: String,
        on_event: Channel<crate::editor_lsp::LspEvent>,
    ) -> Result<String, AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::editor_lsp::start_local(&command, &project_root, on_event)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
    }

    /// As `editor_lsp_start`, on the SSH host, through the workspace's connection.
    #[tauri::command]
    pub async fn editor_lsp_start_ssh(
        target: cli_tools::SshToolTarget,
        command: String,
        project_root: String,
        on_event: Channel<crate::editor_lsp::LspEvent>,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<String, AppError> {
        tokio::task::block_in_place(|| {
            crate::editor_lsp::start_ssh(&target, &command, &project_root, on_event, Some(transport.inner()))
        })
    }

    /// One JSON-RPC message to the server.
    #[tauri::command]
    pub async fn editor_lsp_send(session_id: String, message: String) -> Result<(), AppError> {
        tauri::async_runtime::spawn_blocking(move || crate::editor_lsp::send(&session_id, &message))
            .await
            .map_err(|err| AppError::Other(err.to_string()))?
    }

    #[tauri::command]
    pub fn editor_lsp_stop(session_id: String) {
        crate::editor_lsp::stop(&session_id);
    }

    /// The window's answer to a stopped quit: quit and lose the unsaved edits.
    #[tauri::command]
    pub fn editor_quit_discarding(app: tauri::AppHandle) {
        crate::editor_unsaved::quit_discarding(&app);
    }

    #[tauri::command]
    pub async fn editor_write_file(
        path: String,
        content: String,
        expected_mtime: Option<i64>,
        encoding: Option<String>,
    ) -> Result<editor_fs::EditorWriteFileResult, AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            editor_fs::editor_write_file(path, content, expected_mtime, encoding)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
    }

    #[tauri::command]
    pub fn editor_create_file(
        root: String,
        relative_path: String,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs::editor_create_file(root, relative_path)
    }

    #[tauri::command]
    pub fn editor_create_directory(
        root: String,
        relative_path: String,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs::editor_create_directory(root, relative_path)
    }

    #[tauri::command]
    pub fn editor_delete_entry(
        root: String,
        relative_path: String,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs::editor_delete_entry(root, relative_path)
    }

    #[tauri::command]
    pub fn editor_trash_entry(
        root: String,
        relative_path: String,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs::editor_trash_entry(root, relative_path)
    }

    #[tauri::command]
    pub fn editor_rename_entry(
        root: String,
        from_relative_path: String,
        to_relative_path: String,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs::editor_rename_entry(root, from_relative_path, to_relative_path)
    }

    /// Show the entry selected in Finder (Explorer on Windows). Local workspaces only.
    #[tauri::command]
    pub fn editor_reveal_entry(root: String, relative_path: String) -> Result<(), AppError> {
        let path = editor_fs::resolve_workspace_entry(&root, &relative_path)?;
        crate::codecanvas_note_assets::reveal_path(&path, true).map_err(AppError::Other)
    }

    #[tauri::command]
    pub fn editor_list_files(
        root: String,
        max_depth: Option<u32>,
    ) -> Result<Vec<String>, AppError> {
        editor_fs::editor_list_files(root, max_depth)
    }

    #[tauri::command]
    pub async fn editor_index_files(root: String) -> Result<editor_fs::EditorFileIndex, AppError> {
        tauri::async_runtime::spawn_blocking(move || editor_fs::editor_index_files(root))
            .await
            .map_err(|err| AppError::Other(format!("File index task crashed: {err}")))?
    }

    #[tauri::command]
    pub async fn editor_list_entries(
        root: String,
        max_depth: Option<u32>,
    ) -> Result<Vec<editor_fs::EditorListEntry>, AppError> {
        // A sync command runs on the main thread; walking a large tree there froze the window.
        tauri::async_runtime::spawn_blocking(move || editor_fs::editor_list_entries(root, max_depth))
            .await
            .map_err(|err| AppError::Other(format!("File listing task crashed: {err}")))?
    }

    #[tauri::command]
    pub async fn ssh_resolve_remote_cwd(
        target: cli_tools::SshToolTarget,
        hint: Option<String>,
    ) -> Result<String, AppError> {
        cli_tools::ssh_resolve_remote_cwd(target, hint)
    }

    #[tauri::command]
    pub async fn editor_read_file_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        relative_path: String,
        allow_large: Option<bool>,
        transport: State<'_, remote_transport::RemoteTransport>,
        capability_store: State<'_, remote_capability::RemoteCapabilityStore>,
    ) -> Result<editor_fs::EditorReadFileResult, AppError> {
        let stat_variant = capability_store.get(&target).map(|p| p.stat_variant);
        editor_fs_ssh::editor_read_file_ssh(
            target,
            remote_cwd,
            relative_path,
            allow_large.unwrap_or(false),
            Some(transport.inner()),
            stat_variant,
        )
    }

    #[tauri::command]
    pub async fn editor_read_file_bytes_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        relative_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<tauri::ipc::Response, AppError> {
        let bytes = editor_fs_ssh::editor_read_file_bytes_ssh(
            target,
            remote_cwd,
            relative_path,
            Some(transport.inner()),
        )?;
        Ok(tauri::ipc::Response::new(bytes))
    }

    #[tauri::command]
    pub async fn editor_list_entries_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        max_depth: Option<u32>,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<Vec<editor_fs::EditorListEntry>, AppError> {
        editor_fs_ssh::editor_list_entries_ssh(
            target,
            remote_cwd,
            max_depth,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn editor_write_file_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        relative_path: String,
        content: String,
        expected_mtime: Option<i64>,
        encoding: Option<String>,
        transport: State<'_, remote_transport::RemoteTransport>,
        capability_store: State<'_, remote_capability::RemoteCapabilityStore>,
    ) -> Result<editor_fs::EditorWriteFileResult, AppError> {
        let stat_variant = capability_store.get(&target).map(|p| p.stat_variant);
        editor_fs_ssh::editor_write_file_ssh(
            target,
            remote_cwd,
            relative_path,
            content,
            expected_mtime,
            encoding,
            Some(transport.inner()),
            stat_variant,
        )
    }

    #[tauri::command]
    pub fn terminal_file_drop_inspect_paths(
        paths: Vec<String>,
    ) -> Result<Vec<terminal_file_drop_inspect::InspectedDropPath>, AppError> {
        terminal_file_drop_inspect::inspect_paths(paths)
    }

    #[tauri::command]
    pub async fn terminal_file_drop_upload_ssh_batch(
        job_id: String,
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        files: Vec<terminal_file_drop::UploadFile>,
        uploads: State<'_, terminal_file_drop::TerminalFileDropUploads>,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<terminal_file_drop::UploadBatchResult, AppError> {
        terminal_file_drop::upload_ssh_batch(
            job_id,
            target,
            remote_cwd,
            files,
            uploads.inner(),
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub fn terminal_file_drop_cancel_upload(
        job_id: String,
        uploads: State<'_, terminal_file_drop::TerminalFileDropUploads>,
    ) -> Result<(), AppError> {
        terminal_file_drop::cancel_upload(job_id, uploads.inner());
        Ok(())
    }

    #[tauri::command]
    pub async fn editor_create_file_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        relative_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs_ssh::editor_create_file_ssh(
            target,
            remote_cwd,
            relative_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn editor_create_directory_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        relative_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs_ssh::editor_create_directory_ssh(
            target,
            remote_cwd,
            relative_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn editor_delete_entry_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        relative_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs_ssh::editor_delete_entry_ssh(
            target,
            remote_cwd,
            relative_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn editor_rename_entry_ssh(
        target: cli_tools::SshToolTarget,
        remote_cwd: String,
        from_relative_path: String,
        to_relative_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<editor_fs::EditorCreateEntryResult, AppError> {
        editor_fs_ssh::editor_rename_entry_ssh(
            target,
            remote_cwd,
            from_relative_path,
            to_relative_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub fn list_projects() -> Vec<models::ProjectMeta> {
        fs_browse::list_projects()
    }

    /// The last assistant line of a Claude session, for a dormant agent card (Session Widget,
    /// Slice 04). `None` when that transcript is not on disk.
    #[tauri::command]
    pub fn read_claude_session_tail(
        cwd: String,
        session_id: String,
        max_chars: Option<usize>,
    ) -> Option<String> {
        fs_browse::read_claude_session_tail(cwd, session_id, max_chars.unwrap_or(240))
    }

    #[tauri::command]
    pub fn get_claude_session_title(cwd: String) -> Option<String> {
        fs_browse::get_claude_session_title(cwd)
    }

    #[tauri::command]
    pub fn list_claude_sessions(cwd: String) -> Vec<String> {
        fs_browse::list_claude_sessions(cwd)
    }

    #[tauri::command]
    pub fn list_ssh_hosts() -> Result<Vec<ssh_config::SshConfigHost>, AppError> {
        ssh_config::list_ssh_hosts()
    }

    /// Whether a machine is ready to be used, without opening a connection to find out.
    ///
    /// Two cheap facts, never a probe: is there already a live SSH master for this target, and —
    /// when the host is reached through Cloudflare Access — is there a valid Access token. A picker
    /// that tested reachability for every row would spend an operator's first seconds proving
    /// something they did not ask about, and would do it on the very hosts that are slow.
    #[tauri::command]
    pub async fn machine_readiness(
        target: cli_tools::SshToolTarget,
        access_hostname: Option<String>,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<MachineReadiness, AppError> {
        let connected = transport.has_master(&target);
        // `cloudflared access token` makes a network round trip (~1 s): keep it off the async
        // workers, since the folder picker polls this while a browser sign-in is open.
        let access = match access_hostname.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
            Some(name) => Some(
                tokio::task::spawn_blocking(move || remote_access::access_status(&name))
                    .await
                    .map_err(|e| AppError::Other(format!("access status check panicked: {e}")))?,
            ),
            None => None,
        };
        Ok(MachineReadiness { connected, access })
    }

    /// Where a process on another machine should call this desktop back, and with what.
    ///
    /// Read from the discovery file this app writes for itself, so a dev instance beside a release
    /// one reports its own port rather than the other's. The key is the same bearer every other
    /// route takes; it travels to the remote as **session environment only** — never written to a
    /// file on that machine — which is what `remoteEnvAssignments` exists to carry.
    #[tauri::command]
    pub fn lotus_api_credentials() -> Result<LotusApiCredentials, AppError> {
        let dir = paths::lotus_state_dir();
        let raw = std::fs::read_to_string(dir.join("api-server.json"))
            .map_err(|_| AppError::Other("the desktop API has not started yet".to_string()))?;
        let value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|error| AppError::Other(error.to_string()))?;
        let port = value
            .get("port")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| AppError::Other("the desktop API has not bound a port".to_string()))?;
        let key = std::fs::read_to_string(dir.join("api-server.key"))
            .map_err(|error| AppError::Io(error))?
            .trim()
            .to_string();
        Ok(LotusApiCredentials { port, key })
    }

    /// The transcript ids recorded for a cwd **on another machine**, newest first.
    ///
    /// The remote twin of `list_claude_sessions`. The slug is derived by the same pure function, so
    /// the two can never disagree about which directory a cwd maps to.
    #[tauri::command]
    pub async fn list_claude_sessions_ssh(
        target: cli_tools::SshToolTarget,
        cwd: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<Vec<String>, AppError> {
        fs_browse_ssh::list_claude_sessions_ssh(target, cwd, Some(transport.inner()))
    }

    /// The newest assistant line of a transcript on another machine, for a dormant card.
    #[tauri::command]
    pub async fn read_claude_session_tail_ssh(
        target: cli_tools::SshToolTarget,
        cwd: String,
        session_id: String,
        max_chars: Option<usize>,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<Option<String>, AppError> {
        fs_browse_ssh::read_claude_session_tail_ssh(
            target,
            cwd,
            session_id,
            max_chars.unwrap_or(240),
            Some(transport.inner()),
        )
    }

    /// Open the way home for a machine: `ssh -R` pointing its loopback at this desktop's.
    ///
    /// Idempotent — asking twice returns the tunnel that is already up rather than starting a
    /// second one, so every surface that needs it can simply ask.
    #[tauri::command]
    pub async fn machine_tunnel_open(
        target: cli_tools::SshToolTarget,
        tunnel: State<'_, remote_tunnel::RemoteTunnel>,
    ) -> Result<remote_tunnel::TunnelStatus, AppError> {
        let ports = remote_tunnel::local_ports();
        tunnel.open(&target, ports)
    }

    /// What the way home is doing right now, asked of the process rather than remembered.
    #[tauri::command]
    pub async fn machine_tunnel_status(
        target: cli_tools::SshToolTarget,
        tunnel: State<'_, remote_tunnel::RemoteTunnel>,
    ) -> Result<remote_tunnel::TunnelStatus, AppError> {
        Ok(tunnel.status(&target))
    }

    /// Close the way home for a machine. Safe when none is open.
    #[tauri::command]
    pub async fn machine_tunnel_close(
        target: cli_tools::SshToolTarget,
        tunnel: State<'_, remote_tunnel::RemoteTunnel>,
    ) -> Result<remote_tunnel::TunnelStatus, AppError> {
        Ok(tunnel.close(&target))
    }

    /// Forget what we know about a machine and ask it again — the popover's "Cek ulang mesin".
    ///
    /// The probe answers from a five-minute cache, so a CLI installed on the machine a minute ago is
    /// invisible until this runs. It does not reinstall the hook: that is a write on the far side,
    /// and the tunnel's own retry already does it when the way home reopens (board 22, D3).
    #[tauri::command]
    pub async fn machine_recheck(
        target: cli_tools::SshToolTarget,
        transport: State<'_, remote_transport::RemoteTransport>,
        capability_store: State<'_, remote_capability::RemoteCapabilityStore>,
    ) -> Result<remote_capability::RemoteCapabilityProfile, AppError> {
        capability_store.evict(&target);
        remote_capability::probe_workspace(target, transport.inner(), capability_store.inner())
    }

    /// Let go of a machine on purpose — the popover's "Putuskan" (screen 09).
    ///
    /// Closes the way home and the pooled master the tool commands share. Terminals are untouched:
    /// each runs its own ssh with multiplexing off, so a shell already open stays alive.
    #[tauri::command]
    pub async fn machine_disconnect(
        target: cli_tools::SshToolTarget,
        tunnel: State<'_, remote_tunnel::RemoteTunnel>,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<remote_tunnel::TunnelStatus, AppError> {
        let status = tunnel.close(&target);
        transport.evict(&target);
        Ok(status)
    }

    /// Teach a machine to report its agents home, by putting the hook script and its settings there.
    ///
    /// Called once per machine when the way home opens, because that is the moment both halves are
    /// true: the tunnel exists for the report to travel through, and the operator has just asked for
    /// this machine. Idempotent — a machine already set up costs one round trip and writes nothing.
    #[tauri::command]
    pub async fn machine_install_hooks(
        target: cli_tools::SshToolTarget,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<remote_hooks::RemoteHookInstall, AppError> {
        remote_hooks::install_remote_hooks(target, Some(transport.inner()))
    }

    // ── Adopting a Lotus Host that is already there ───────────────────────────

    /// What the Standalone Host on a machine is running, or that it runs none.
    ///
    /// `available: false` is the ordinary answer for most machines and is not an error — the whole
    /// point of this feature being optional is that a machine without a host shows no trace of it.
    #[tauri::command]
    pub async fn machine_host_fleet(
        target: cli_tools::SshToolTarget,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<remote_lotus_host::RemoteHostFleet, AppError> {
        remote_lotus_host::remote_host_fleet(target, Some(transport.inner()))
    }

    /// Whether Lotus installed a host on this machine, someone installed one by hand, or none.
    #[tauri::command]
    pub async fn managed_host_status(
        app: tauri::AppHandle,
        target: cli_tools::SshToolTarget,
    ) -> Result<managed_host::ManagedHostStatus, AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            let transport = app.state::<remote_transport::RemoteTransport>();
            managed_host::status(target, Some(transport.inner()))
        })
        .await
        .map_err(|e| crate::error::other(e.to_string()))?
    }

    /// One Managed Host install/update step (download, check, install, start, health, restore, remove).
    #[tauri::command]
    pub async fn managed_host_step(
        app: tauri::AppHandle,
        target: cli_tools::SshToolTarget,
        step: String,
        version: String,
    ) -> Result<(), AppError> {
        tauri::async_runtime::spawn_blocking(move || {
            let transport = app.state::<remote_transport::RemoteTransport>();
            managed_host::step(target, step, version, Some(transport.inner()))
        })
        .await
        .map_err(|e| crate::error::other(e.to_string()))?
    }

    /// One round trip over the machine's long-lived host link: how it went, and how long it took.
    #[tauri::command]
    pub async fn machine_host_link_check(
        target: cli_tools::SshToolTarget,
        links: State<'_, std::sync::Arc<remote_host_link::HostLinks>>,
    ) -> Result<serde_json::Value, AppError> {
        let started = std::time::Instant::now();
        let (status, _, route) = links
            .post(&target, "/v1/list-fleet", &serde_json::json!({}))
            .await?;
        Ok(serde_json::json!({ "status": status, "route": route, "ms": started.elapsed().as_millis() as u64 }))
    }

    /// The projects that machine's Lotus Host holds (`{id, name, path}`); `id` is a chat's workspace.
    #[tauri::command]
    pub async fn machine_host_projects(
        target: cli_tools::SshToolTarget,
        links: State<'_, std::sync::Arc<remote_host_link::HostLinks>>,
    ) -> Result<serde_json::Value, AppError> {
        match links.get(&target, "/api/projects").await? {
            (200, list) => Ok(list),
            (status, body) => Err(AppError::Other(format!("{}'s Lotus Host answered {status}: {body}", target.host))),
        }
    }

    /// One folder level from that machine's Lotus Host (`GET /api/fs`), or its roots when `path` is
    /// None. The host decides what may be seen (its browse roots), not this app.
    #[tauri::command]
    pub async fn machine_host_browse(
        target: cli_tools::SshToolTarget,
        path: Option<String>,
        links: State<'_, std::sync::Arc<remote_host_link::HostLinks>>,
    ) -> Result<serde_json::Value, AppError> {
        let query = match path.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => format!("/api/fs?path={}", percent_encoding::utf8_percent_encode(p, percent_encoding::NON_ALPHANUMERIC)),
            None => "/api/fs".to_string(),
        };
        match links.get(&target, &query).await? {
            (200, page) => Ok(page),
            (status, body) => Err(AppError::Other(format!("{}'s Lotus Host answered {status}: {}", target.host, body["error"].as_str().unwrap_or(&body.to_string())))),
        }
    }

    /// Make a folder on that machine a host project (`POST /api/projects`), so a chat can start there.
    #[tauri::command]
    pub async fn machine_host_add_project(
        target: cli_tools::SshToolTarget,
        path: String,
        links: State<'_, std::sync::Arc<remote_host_link::HostLinks>>,
    ) -> Result<serde_json::Value, AppError> {
        match links.post(&target, "/api/projects", &serde_json::json!({ "path": path })).await? {
            (201, project, _) => Ok(project),
            (status, body, _) => Err(AppError::Other(format!("{}'s Lotus Host answered {status}: {}", target.host, body["error"].as_str().unwrap_or(&body.to_string())))),
        }
    }

    /// Send a prompt to a cell that machine's host owns.
    #[tauri::command]
    pub async fn machine_host_dispatch(
        target: cli_tools::SshToolTarget,
        pane_id: String,
        command: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        remote_lotus_host::remote_host_dispatch(target, pane_id, command, Some(transport.inner()))
    }

    /// The turns of a cell that machine's host runs without a terminal.
    ///
    /// Only headless cells have one. A `tui` cell's bytes come over ssh from its tmux session,
    /// which is a different thing entirely — and asking for this on one answers with an error
    /// rather than an empty page, so a caller cannot mistake the two.
    #[tauri::command]
    pub async fn machine_host_conversation(
        target: cli_tools::SshToolTarget,
        pane_id: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<serde_json::Value, AppError> {
        remote_lotus_host::remote_host_conversation(target, pane_id, Some(transport.inner()))
    }

    /// Open the Cloudflare Access sign-in for a machine.
    ///
    /// Returns the URL cloudflared opened, when it says one, so the panel can offer it if the
    /// browser did not come up. `null` is not a failure — the browser may well be open.
    #[tauri::command]
    pub async fn machine_access_login(app: tauri::AppHandle, hostname: String) -> Result<Option<String>, AppError> {
        // Blocks up to 8 s waiting for the URL: off the async workers.
        let login = tokio::task::spawn_blocking(move || remote_access::access_login(&hostname))
            .await
            .map_err(|e| AppError::Other(format!("access login panicked: {e}")))??;
        match login {
            remote_access::Login::Started(url) => Ok(url),
            // The waiting login keeps the callback; show its tab again rather than start another.
            remote_access::Login::Pending(url) => {
                if let Some(url) = url.as_deref() {
                    #[allow(deprecated)]
                    let _ = app.shell().open(url, None);
                }
                Ok(url)
            }
        }
    }

    // ── Native child webview panes ───────────────────────────────────────────

    #[tauri::command]
    pub fn webview_create(
        app: tauri::AppHandle,
        window: Window,
        label: String,
        url: String,
        bounds: webview_panes::WebviewPaneBounds,
    ) -> Result<(), AppError> {
        webview_panes::webview_create(&app, &window, &label, &url, bounds)
    }

    #[tauri::command]
    pub fn webview_set_bounds(
        app: tauri::AppHandle,
        window: Window,
        label: String,
        bounds: webview_panes::WebviewPaneBounds,
    ) -> Result<(), AppError> {
        webview_panes::webview_set_bounds(&app, &window, &label, bounds)
    }

    #[tauri::command]
    pub fn webview_navigate(
        app: tauri::AppHandle,
        window: Window,
        label: String,
        url: String,
    ) -> Result<(), AppError> {
        webview_panes::webview_navigate(&app, &window, &label, &url)
    }

    #[tauri::command]
    pub fn webview_reload(
        app: tauri::AppHandle,
        window: Window,
        label: String,
    ) -> Result<(), AppError> {
        webview_panes::webview_reload(&app, &window, &label)
    }

    #[tauri::command]
    pub fn webview_back(
        app: tauri::AppHandle,
        window: Window,
        label: String,
    ) -> Result<(), AppError> {
        webview_panes::webview_back(&app, &window, &label)
    }

    #[tauri::command]
    pub fn webview_forward(
        app: tauri::AppHandle,
        window: Window,
        label: String,
    ) -> Result<(), AppError> {
        webview_panes::webview_forward(&app, &window, &label)
    }

    #[tauri::command]
    pub fn webview_set_visible(
        app: tauri::AppHandle,
        window: Window,
        label: String,
        visible: bool,
    ) -> Result<(), AppError> {
        webview_panes::webview_set_visible(&app, &window, &label, visible)
    }

    #[tauri::command]
    pub fn webview_destroy(
        app: tauri::AppHandle,
        window: Window,
        label: String,
    ) -> Result<(), AppError> {
        webview_panes::webview_destroy(&app, &window, &label)
    }

    // ── Processes ─────────────────────────────────────────────────────────────

    #[tauri::command]
    pub fn list_processes() -> Vec<models::ProcessInfo> {
        processes::list_processes()
    }

    #[tauri::command]
    pub fn kill_process(pid: u32) -> Result<(), AppError> {
        processes::kill_process(pid)
    }

    // ── Runners (ADR-0027 Phase 2) ────────────────────────────────────────────

    #[tauri::command]
    pub fn list_runners() -> Result<runners::RunnerRegistry, AppError> {
        runners::list_runners()
    }

    #[tauri::command]
    pub fn get_runner(id: String) -> Result<Option<runners::RunnerInfo>, AppError> {
        runners::get_runner(id)
    }

    /// Both mutators drop every cached SSH capability profile, and that is not housekeeping.
    ///
    /// A profile records which runners a machine has, answered against the runner list as it stood
    /// when the probe ran. Adding a custom runner widens that list (see
    /// `remote_capability::probed_runners`), so every cached answer is now missing a question —
    /// and a runner the profile does not mention is filtered out of ⌘K as "not on that machine".
    /// Without this, a runner you just defined stays invisible on remote projects until restart.
    #[tauri::command]
    pub fn save_runner_config(
        id: String,
        config: runners::RunnerConfig,
        capability_store: State<'_, remote_capability::RemoteCapabilityStore>,
    ) -> Result<(), AppError> {
        runners::save_runner_config(id, config)?;
        capability_store.evict_all();
        Ok(())
    }

    #[tauri::command]
    pub fn delete_runner_config(
        id: String,
        capability_store: State<'_, remote_capability::RemoteCapabilityStore>,
    ) -> Result<(), AppError> {
        runners::delete_runner_config(id)?;
        capability_store.evict_all();
        Ok(())
    }

    // ── Launch ────────────────────────────────────────────────────────────────

    #[tauri::command]
    pub async fn spawn_claude(
        config: models::LaunchConfig,
    ) -> Result<models::LaunchResult, AppError> {
        launch::spawn_claude(config)
    }

    // ── Smart Convert ────────────────────────────────────────────────────────

    /// One-shot provider CLI invocation that converts raw note content into a
    /// structured task JSON string. Supports Claude and Codex providers.
    #[tauri::command]
    pub async fn smart_convert_note(
        content: String,
        model: String,
        provider: Option<String>,
    ) -> Result<String, AppError> {
        smart_convert::smart_convert_note(content, model, provider).await
    }

    // ── Pane title generation ────────────────────────────────────────────────

    #[tauri::command]
    pub async fn generate_pane_title(
        request: pane_title::GeneratePaneTitleRequest,
        pty_state: tauri::State<'_, pty::PtyState>,
        transcripts: tauri::State<'_, Arc<std::sync::Mutex<agent_hooks::TranscriptStore>>>,
        mcp_state: tauri::State<'_, McpIpcSharedState>,
    ) -> Result<pane_title::GeneratePaneTitleResult, AppError> {
        pane_title::generate_pane_title(request, &pty_state, &transcripts, &mcp_state).await
    }

    /// What a pane's agent calls its conversation, read from its transcript. Cheap: no model
    /// call, so the frontend may ask at the end of every turn.
    #[tauri::command]
    pub fn pane_agent_title(
        pane_id: String,
        transcripts: tauri::State<'_, Arc<std::sync::Mutex<agent_hooks::TranscriptStore>>>,
        mcp_state: tauri::State<'_, McpIpcSharedState>,
    ) -> Option<pane_title::PaneAgentTitle> {
        pane_title::pane_agent_title(&pane_id, &transcripts, &mcp_state)
    }

    #[tauri::command]
    pub fn pty_session_metrics(
        session_id: String,
        pty_state: tauri::State<'_, pty::PtyState>,
    ) -> Option<pty::PtyOutputMetrics> {
        pty::read_session_metrics(&session_id, &pty_state)
    }

    #[tauri::command]
    pub fn agent_cli_stage_images(
        attachments: Vec<agent_cli::ImageAttachment>,
    ) -> Result<agent_cli::StagedImageAttachments, AppError> {
        agent_cli::stage_image_attachments(attachments).map_err(AppError::Other)
    }

    #[tauri::command]
    pub fn agent_cli_cleanup_temp_dir(temp_dir: String) -> Result<(), AppError> {
        agent_cli::cleanup_temp_dir(temp_dir).map_err(AppError::Other)
    }

    // ── Skills ────────────────────────────────────────────────────────────

    #[tauri::command]
    pub async fn list_skills(
        project_path: Option<String>,
    ) -> Result<Vec<skills::SkillEntry>, AppError> {
        skills::list_skills(project_path)
    }

    #[tauri::command]
    pub async fn create_skill(
        name: String,
        description: String,
        content: String,
        scope: String,
        project_path: Option<String>,
    ) -> Result<(), AppError> {
        skills::create_skill(name, description, content, scope, project_path)
    }

    #[tauri::command]
    pub async fn import_skill_from_url(
        url: String,
        scope: String,
        project_path: Option<String>,
    ) -> Result<(), AppError> {
        skills::import_skill_from_url(url, scope, project_path)
    }

    // ── Canvas git ────────────────────────────────────────────────────────────

    #[tauri::command]
    pub async fn list_git_worktrees(
        path: String,
    ) -> Result<Vec<codespace_git::WorktreeEntry>, AppError> {
        codespace_git::list_git_worktrees(path)
    }

    #[tauri::command]
    pub async fn create_git_worktree(
        repo_path: String,
        branch: String,
        worktree_path: String,
    ) -> Result<codespace_git::WorktreeEntry, AppError> {
        codespace_git::create_git_worktree(repo_path, branch, worktree_path)
    }

    #[tauri::command]
    pub async fn remove_git_worktree(
        repo_path: String,
        worktree_path: String,
    ) -> Result<(), AppError> {
        codespace_git::remove_git_worktree(repo_path, worktree_path)
    }

    #[tauri::command]
    pub async fn validate_worktree_branches(
        repo_path: String,
        branches: Vec<String>,
    ) -> Result<Vec<String>, AppError> {
        codespace_git::validate_worktree_branches(repo_path, branches)
    }

    #[tauri::command]
    pub async fn resolve_repo_head_branch(repo_path: String) -> Result<String, AppError> {
        codespace_git::resolve_repo_head_branch(repo_path)
    }

    // ── Canvas git, on another machine ────────────────────────────────────────
    //
    // Siblings of the five above, not replacements: a board on this machine keeps taking the local
    // path, and the frontend picks between them by the project's location.

    #[tauri::command]
    pub async fn list_git_worktrees_ssh(
        target: cli_tools::SshToolTarget,
        path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<Vec<codespace_git::WorktreeEntry>, AppError> {
        codespace_git_ssh::list_git_worktrees_ssh(target, path, Some(transport.inner()))
    }

    #[tauri::command]
    pub async fn create_git_worktree_ssh(
        target: cli_tools::SshToolTarget,
        repo_path: String,
        branch: String,
        worktree_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<codespace_git::WorktreeEntry, AppError> {
        codespace_git_ssh::create_git_worktree_ssh(
            target,
            repo_path,
            branch,
            worktree_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn remove_git_worktree_ssh(
        target: cli_tools::SshToolTarget,
        repo_path: String,
        worktree_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::remove_git_worktree_ssh(
            target,
            repo_path,
            worktree_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn validate_worktree_branches_ssh(
        target: cli_tools::SshToolTarget,
        repo_path: String,
        branches: Vec<String>,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<Vec<String>, AppError> {
        codespace_git_ssh::validate_worktree_branches_ssh(
            target,
            repo_path,
            branches,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn resolve_repo_head_branch_ssh(
        target: cli_tools::SshToolTarget,
        repo_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<String, AppError> {
        codespace_git_ssh::resolve_repo_head_branch_ssh(target, repo_path, Some(transport.inner()))
    }

    /// Every uncommitted tracked change in a remote repo — what the agent diff panel shows.
    #[tauri::command]
    pub async fn git_diff_ssh(
        target: cli_tools::SshToolTarget,
        project_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<String, AppError> {
        codespace_git_ssh::codespace_git_uncommitted_diff_ssh(
            target,
            project_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn open_new_window(
        app: tauri::AppHandle,
        route: Option<String>,
    ) -> Result<(), String> {
        windowing::create_app_window(&app, route.as_deref())
            .map(|_| ())
            .map_err(|err| err.to_string())
    }

    #[tauri::command]
    pub fn show_window_menu(
        window: tauri::WebviewWindow,
        menu: String,
        x: f64,
        y: f64,
    ) -> Result<(), String> {
        windowing::show_window_menu(&window, &menu, x, y)
    }

    #[tauri::command]
    pub fn open_external_link(app: tauri::AppHandle, url: String) -> Result<(), AppError> {
        if !crate::external_link_allowed(&url) {
            return Err(AppError::Other(format!("Unsupported external link: {url}")));
        }

        #[allow(deprecated)]
        app.shell()
            .open(url, None)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn open_path_reference(
        app: tauri::AppHandle,
        path: String,
        cwd: String,
        _line: Option<u32>,
        _column: Option<u32>,
    ) -> Result<(), AppError> {
        let resolved = editor_opener::resolve_path(&cwd, &path)?;

        #[allow(deprecated)]
        app.shell()
            .open(resolved.to_string_lossy().into_owned(), None)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn open_path_in_editor(
        app: tauri::AppHandle,
        path: String,
        cwd: String,
        line: Option<u32>,
        column: Option<u32>,
    ) -> Result<(), AppError> {
        let settings = settings::get_settings();
        let preference = editor_opener::preference_from_settings(&settings);
        let resolved = editor_opener::resolve_path(&cwd, &path)?;
        let spec =
            editor_opener::build_launch_spec(preference, &resolved, line, column, Some(&settings));

        if spec.use_system_open {
            #[allow(deprecated)]
            return app
                .shell()
                .open(spec.program, None)
                .map_err(|err| AppError::Other(err.to_string()));
        }

        editor_opener::open_in_editor(&spec).or_else(|_| {
            #[allow(deprecated)]
            app.shell()
                .open(resolved.to_string_lossy().into_owned(), None)
                .map_err(|err| AppError::Other(err.to_string()))
        })
    }

    #[tauri::command]
    pub fn get_editor_availability() -> editor_opener::EditorAvailability {
        editor_opener::available_editors()
    }

    #[tauri::command]
    pub fn get_cli_tool_availability(tool_ids: Vec<String>) -> Vec<cli_tools::CliToolAvailability> {
        cli_tools::get_cli_tool_availability(tool_ids)
    }

    #[tauri::command]
    pub fn detect_installed_clis() -> Vec<cli_detect::DetectedCli> {
        cli_detect::detect_installed_clis()
    }

    /// Settings › Agents › Locate…: point a known CLI at a binary detection missed (`None` forgets it).
    #[tauri::command]
    pub fn set_cli_path(id: String, path: Option<String>) -> Result<(), String> {
        cli_detect::set_cli_path(&id, path)
    }

    /// Settings › Updates: installed agent CLIs with their current and published versions.
    #[tauri::command]
    pub async fn cli_update_status() -> Result<Vec<cli_updates::CliUpdateStatus>, String> {
        tauri::async_runtime::spawn_blocking(cli_updates::status).await.map_err(|e| e.to_string())
    }

    /// Run one CLI's updater; output and the verified result arrive on `on_event`.
    #[tauri::command]
    pub async fn cli_update_run(id: String, on_event: Channel<cli_updates::CliUpdateEvent>) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || cli_updates::run(&id, |event| { let _ = on_event.send(event); }))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn get_ssh_cli_tool_availability(
        target: cli_tools::SshToolTarget,
        tool_ids: Vec<String>,
    ) -> Result<Vec<cli_tools::CliToolAvailability>, AppError> {
        cli_tools::get_ssh_cli_tool_availability(target, tool_ids)
    }

    #[tauri::command]
    pub async fn get_ssh_git_repo_root(
        target: cli_tools::SshToolTarget,
        remote_cwd: Option<String>,
    ) -> Result<Option<String>, AppError> {
        cli_tools::get_ssh_git_repo_root(target, remote_cwd)
    }

    #[tauri::command]
    pub async fn ssh_probe_workspace(
        target: cli_tools::SshToolTarget,
        transport: State<'_, remote_transport::RemoteTransport>,
        capability_store: State<'_, remote_capability::RemoteCapabilityStore>,
    ) -> Result<remote_capability::RemoteCapabilityProfile, AppError> {
        remote_capability::probe_workspace(target, transport.inner(), capability_store.inner())
    }

    // ── Chat runtime (new Chat module, plans/chat-runtime) ──────────────

    #[tauri::command]
    pub fn chat_thread_create(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        cwd: String,
        model: Option<String>,
        permission_mode: Option<String>,
        runner: Option<String>,
        effort: Option<String>,
        provider: Option<String>,
        id: Option<String>,
    ) -> Result<crate::chat_runtime::ThreadRecord, String> {
        runtime.create_thread(&cwd, model, permission_mode, runner, effort, provider, id)
    }

    /// A chat whose agent runs in the Lotus Host on an SSH machine (plans/chat-remote-host).
    #[tauri::command]
    pub fn chat_thread_create_remote(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        machine: crate::chat_runtime::RemoteMachine,
        cwd: String,
        model: Option<String>,
        permission_mode: Option<String>,
        runner: Option<String>,
        effort: Option<String>,
        id: Option<String>,
    ) -> Result<crate::chat_runtime::ThreadRecord, String> {
        runtime.create_remote_thread(machine, &cwd, model, permission_mode, runner, effort, id)
    }

    /// Reconnect a remote chat's stream now (the thread's Retry).
    #[tauri::command]
    pub async fn chat_remote_retry(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
    ) -> Result<(), String> {
        runtime.retry_remote(&thread_id).await
    }

    #[tauri::command]
    pub async fn chat_api_models(
        base_url: String,
        api_key: Option<String>,
        provider_id: Option<String>,
    ) -> Result<Vec<String>, String> {
        crate::chat_runtime::ChatRuntime::api_models(&base_url, api_key.as_deref(), provider_id.as_deref()).await
    }

    #[tauri::command]
    pub fn chat_stats(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        since: i64,
    ) -> Result<crate::chat_runtime::Stats, String> {
        runtime.stats_since(since)
    }

    /// Settings' "Import CodeChat history" (#290); `dry_run` only counts what would be imported.
    #[tauri::command]
    pub fn chat_import_codechat(
        app: tauri::AppHandle,
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        dry_run: bool,
    ) -> Result<crate::chat_runtime::ImportReport, String> {
        let path = super::codechat_database_path(&app)?;
        runtime.import_codechat(&path, dry_run)
    }

    #[tauri::command]
    pub fn chat_threads_list(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
    ) -> Result<Vec<crate::chat_runtime::ThreadRecord>, String> {
        runtime.list_threads()
    }

    #[tauri::command]
    pub async fn chat_send(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        text: String,
        client_request_id: String,
        attachments: Option<Vec<crate::chat_runtime::Attachment>>,
    ) -> Result<(), String> {
        runtime
            .send(&thread_id, &text, &client_request_id, attachments.unwrap_or_default())
            .await
    }

    #[tauri::command]
    pub fn chat_attachment_save_pasted(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        name: String,
        mime_type: Option<String>,
        data_base64: String,
    ) -> Result<crate::chat_runtime::Attachment, String> {
        runtime.save_pasted(&thread_id, &name, mime_type, &data_base64)
    }

    /// Copies one attachment to a remote chat's machine (ADR-0069).
    #[tauri::command]
    pub async fn chat_attachment_upload(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        attachment: crate::chat_runtime::Attachment,
        progress: tauri::ipc::Channel<u8>,
    ) -> Result<crate::chat_runtime::Attachment, String> {
        let progress = std::sync::Arc::new(move |percent| {
            let _ = progress.send(percent);
        });
        runtime.upload_attachment(&thread_id, attachment, progress).await
    }

    #[tauri::command]
    pub async fn chat_attachment_preview(path: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || crate::chat_runtime::attachment_preview(&path))
            .await
            .map_err(|e| e.to_string())?
    }

    // Workbench Changes (#281): git in the thread's folder, plus what the chat knows about whose
    // edit is whose. Blocking git, so off the async runtime.
    #[tauri::command]
    pub async fn chat_changes(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
    ) -> Result<crate::chat_runtime::Changes, String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.changes(&thread_id))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn chat_change_diff(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        path: String,
        ignore_whitespace: Option<bool>,
    ) -> Result<String, String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.change_diff(&thread_id, &path, ignore_whitespace.unwrap_or(false)))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn chat_changes_commit(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        paths: Vec<String>,
        message: String,
    ) -> Result<String, String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.commit_changes(&thread_id, &paths, &message))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn chat_fork(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        turn_id: String,
    ) -> Result<crate::chat_runtime::ThreadRecord, String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.fork(&thread_id, &turn_id))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn chat_rewind(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        turn_id: String,
    ) -> Result<(), String> {
        runtime.rewind(&thread_id, &turn_id).await
    }

    #[tauri::command]
    pub async fn chat_fork_worktree(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
    ) -> Result<crate::chat_runtime::ThreadRecord, String> {
        runtime.fork_to_worktree(&thread_id).await
    }

    #[tauri::command]
    pub async fn chat_child_discard(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
    ) -> Result<String, String> {
        runtime.discard_child(&thread_id).await
    }

    /// Settings › Worktrees: where to look and what is in use. Folders of open workspaces and panes,
    /// every workspace Lotus has seen, every chat's folder and every live cell's (Canvas included).
    fn worktree_sources(
        app: &tauri::AppHandle,
        fleet: Vec<String>,
        chats: &crate::chat_runtime::ChatRuntime,
    ) -> crate::worktree_cleanup::Sources {
        let store = codespace_store::open_app_store(app).map_err(|e| e.to_string());
        let open = store.as_ref().map_err(Clone::clone).and_then(|c| codespace_store::open_folders(c).map_err(|e| e.to_string()));
        let known = store.as_ref().map_err(Clone::clone).and_then(|c| codespace_store::load_known_workspaces(c).map_err(|e| e.to_string()));
        let chat_folders: Vec<String> = match chats.list_threads() {
            Ok(threads) => threads.into_iter().map(|t| t.cwd).collect(),
            Err(e) => {
                eprintln!("[worktree-cleanup] chats not read: {e}");
                Vec::new()
            }
        };
        if let Err(e) = &open {
            eprintln!("[worktree-cleanup] workspaces not read: {e}");
        }
        let open = open.unwrap_or_default();
        let in_use: Vec<std::path::PathBuf> = open.iter().chain(&fleet).chain(&chat_folders).map(Into::into).collect();
        let folders = known.unwrap_or_default().into_iter().map(|w| w.cwd.into()).chain(in_use.iter().cloned()).collect();
        crate::worktree_cleanup::Sources { folders, in_use }
    }

    fn worktree_roots() -> crate::worktree_cleanup::Roots {
        crate::worktree_cleanup::Roots::from_state_dir(&crate::paths::lotus_state_dir())
    }

    fn fleet_folders(mcp: &McpIpcSharedState) -> Vec<String> {
        mcp.fleet_snapshot().into_iter().map(|m| m.cwd).collect()
    }

    #[tauri::command]
    pub async fn worktree_cleanup_list(
        app: tauri::AppHandle,
        mcp: State<'_, McpIpcSharedState>,
        chats: State<'_, crate::chat_runtime::ChatRuntime>,
    ) -> Result<Vec<crate::worktree_cleanup::Worktree>, String> {
        let (fleet, chats) = (fleet_folders(&mcp), chats.inner().clone());
        tauri::async_runtime::spawn_blocking(move || {
            crate::worktree_cleanup::scan(&worktree_sources(&app, fleet, &chats), &worktree_roots(), true)
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// `discard`: also a worktree with work (the row's second click). Re-checked here, never trusted.
    #[tauri::command]
    pub async fn worktree_cleanup_remove(
        app: tauri::AppHandle,
        mcp: State<'_, McpIpcSharedState>,
        chats: State<'_, crate::chat_runtime::ChatRuntime>,
        paths: Vec<String>,
        discard: bool,
    ) -> Result<Vec<crate::worktree_cleanup::Removal>, String> {
        let (fleet, chats) = (fleet_folders(&mcp), chats.inner().clone());
        tauri::async_runtime::spawn_blocking(move || {
            crate::worktree_cleanup::remove(&worktree_sources(&app, fleet, &chats), &worktree_roots(), &paths, discard, false)
        })
        .await
        .map_err(|e| e.to_string())
    }

    /// The auto rule (off by default; the frontend calls this only when it is on).
    #[tauri::command]
    pub async fn worktree_cleanup_auto(
        app: tauri::AppHandle,
        mcp: State<'_, McpIpcSharedState>,
        chats: State<'_, crate::chat_runtime::ChatRuntime>,
        days: u32,
    ) -> Result<Vec<crate::worktree_cleanup::Removal>, String> {
        let (fleet, chats) = (fleet_folders(&mcp), chats.inner().clone());
        tauri::async_runtime::spawn_blocking(move || {
            crate::worktree_cleanup::auto(&worktree_sources(&app, fleet, &chats), &worktree_roots(), days)
        })
        .await
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn worktree_cleanup_log() -> Vec<crate::worktree_cleanup::LogEntry> {
        crate::worktree_cleanup::read_log(&worktree_roots().log)
    }

    #[tauri::command]
    pub async fn chat_merge_child(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
    ) -> Result<String, String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.merge_child(&thread_id))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn chat_changes_undo(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        paths: Vec<String>,
    ) -> Result<(), String> {
        let runtime = runtime.inner().clone();
        tauri::async_runtime::spawn_blocking(move || runtime.undo_changes(&thread_id, &paths))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn chat_interrupt(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String) -> Result<(), String> {
        runtime.interrupt(&thread_id).await
    }

    #[tauri::command]
    pub async fn chat_models_list(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        runner: Option<String>,
    ) -> Result<serde_json::Value, String> {
        runtime.list_models(runner.as_deref().unwrap_or("claude")).await
    }

    #[tauri::command]
    pub async fn chat_commands_list(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        runner: String,
        cwd: String,
    ) -> Result<serde_json::Value, String> {
        runtime.list_commands(&runner, &cwd).await
    }

    #[tauri::command]
    pub async fn chat_set_model(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        model: String,
        effort: Option<String>,
        label: String,
    ) -> Result<(), String> {
        runtime.set_model(&thread_id, &model, effort.as_deref(), &label).await
    }

    #[tauri::command]
    pub async fn chat_set_account(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        account: String,
    ) -> Result<(), String> {
        runtime.set_account(&thread_id, &account).await
    }

    #[tauri::command]
    pub async fn chat_set_permission_mode(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        mode: String,
        label: String,
    ) -> Result<(), String> {
        runtime.set_permission_mode(&thread_id, &mode, &label).await
    }

    #[tauri::command]
    pub async fn chat_thread_stop(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String) -> Result<(), String> {
        runtime.stop_thread(&thread_id).await
    }

    #[tauri::command]
    pub fn chat_thread_rename(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String, title: String) -> Result<(), String> {
        runtime.rename_thread(&thread_id, &title)
    }

    #[tauri::command]
    pub fn chat_thread_set_agent_name(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String, name: String) -> Result<(), String> {
        runtime.set_agent_name(&thread_id, &name)
    }

    /// Locks a chat to the app's approvals (the Live Voice assistant brain). One way: never cleared.
    #[tauri::command]
    pub fn chat_thread_set_strict_permissions(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String) -> Result<(), String> {
        runtime.set_strict_permissions(&thread_id)
    }

    #[tauri::command]
    pub async fn chat_thread_warm(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String) -> Result<(), String> {
        runtime.warm(&thread_id).await
    }

    #[tauri::command]
    pub async fn chat_thread_regenerate_title(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String) -> Result<String, String> {
        runtime.regenerate_title(&thread_id).await
    }

    #[tauri::command]
    pub fn chat_handoff_seed(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String, to: String) -> Result<String, String> {
        runtime.handoff_seed(&thread_id, &to)
    }

    #[tauri::command]
    pub async fn chat_thread_archive(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String, archived: bool) -> Result<(), String> {
        runtime.archive_thread(&thread_id, archived).await
    }

    #[tauri::command]
    pub fn chat_thread_pin(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String, pinned: bool) -> Result<(), String> {
        runtime.pin_thread(&thread_id, pinned)
    }

    #[tauri::command]
    pub fn chat_thread_mark_read(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String) -> Result<(), String> {
        runtime.mark_read(&thread_id)
    }

    #[tauri::command]
    pub async fn chat_thread_delete(runtime: State<'_, crate::chat_runtime::ChatRuntime>, thread_id: String) -> Result<(), String> {
        runtime.delete_thread(&thread_id).await
    }

    #[tauri::command]
    pub async fn chat_resolve_interaction(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        interaction_id: String,
        decision: crate::chat_runtime::Decision,
    ) -> Result<(), String> {
        runtime.resolve_interaction(&thread_id, &interaction_id, decision).await
    }

    /// `replayed_through`: the last seq of the stored history sent before this returned. Channel
    /// messages and the command's reply reach the webview by separate paths, in no fixed order, so
    /// the webview waits for this seq to know the replay is complete and draws the thread once.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ChatSubscribed {
        subscription_id: u64,
        replayed_through: u64,
    }

    #[tauri::command]
    pub fn chat_subscribe(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        thread_id: String,
        after_seq: u64,
        on_event: Channel<crate::chat_runtime::Envelope>,
    ) -> Result<ChatSubscribed, String> {
        // The replay runs inside `subscribe`, so the highest seq sent by the time it returns covers
        // it. A live event racing in just after only raises the mark, and that event arrives too.
        let sent = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(after_seq));
        let mark = std::sync::Arc::clone(&sent);
        let subscription_id = runtime.subscribe(
            &thread_id,
            after_seq,
            Box::new(move |envelope| {
                mark.fetch_max(envelope.seq, std::sync::atomic::Ordering::Relaxed);
                on_event.send(envelope.clone()).is_ok()
            }),
        )?;
        Ok(ChatSubscribed { subscription_id, replayed_through: sent.load(std::sync::atomic::Ordering::Relaxed) })
    }

    #[tauri::command]
    pub async fn usage_snapshot() -> Vec<crate::usage::UsageAccount> {
        crate::usage::snapshot().await
    }

    #[tauri::command]
    pub fn usage_use_account(account: Option<String>, provider: Option<crate::accounts::Provider>) -> Result<(), String> {
        match provider.unwrap_or_default() {
            crate::accounts::Provider::Claude => crate::usage::set_claude_account(account),
            crate::accounts::Provider::Codex => crate::usage::set_codex_account(account),
        }
    }

    /// Usage of the machines with an SSH connection open now, plus the last numbers of the others.
    #[tauri::command]
    pub async fn usage_remote(app: tauri::AppHandle) -> Result<Vec<crate::remote_usage::MachineUsage>, AppError> {
        tauri::async_runtime::spawn_blocking(move || crate::remote_usage::snapshot(app.state::<remote_transport::RemoteTransport>().inner()))
            .await
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Another machine's Claude accounts, by the `target` key `usage_remote` reports.
    #[tauri::command]
    pub async fn remote_accounts_list(app: tauri::AppHandle, target: String) -> Result<serde_json::Value, String> {
        tauri::async_runtime::spawn_blocking(move || crate::remote_accounts::list(app.state::<remote_transport::RemoteTransport>().inner(), &target))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn remote_account_create(app: tauri::AppHandle, target: String, name: String, isolated: Option<bool>) -> Result<serde_json::Value, String> {
        tauri::async_runtime::spawn_blocking(move || {
            crate::remote_accounts::create(app.state::<remote_transport::RemoteTransport>().inner(), &target, &name, isolated.unwrap_or(false))
        })
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn remote_account_remove(app: tauri::AppHandle, target: String, id: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || crate::remote_accounts::remove(app.state::<remote_transport::RemoteTransport>().inner(), &target, &id))
            .await
            .map_err(|e| e.to_string())?
    }

    /// That machine's own default account; `None` goes back to its default login. Usage there re-reads it.
    #[tauri::command]
    pub async fn remote_account_default(app: tauri::AppHandle, target: String, id: Option<String>) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || crate::remote_accounts::set_default(app.state::<remote_transport::RemoteTransport>().inner(), &target, id.as_deref()))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn remote_ccs_migration(app: tauri::AppHandle, target: String, action: String) -> Result<serde_json::Value, String> {
        tauri::async_runtime::spawn_blocking(move || crate::remote_accounts::migrate_ccs(app.state::<remote_transport::RemoteTransport>().inner(), &target, &action))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn accounts_list(provider: Option<crate::accounts::Provider>) -> Result<Vec<crate::accounts::AccountView>, String> {
        // One `/usr/bin/security` call per account: off the main thread.
        tauri::async_runtime::spawn_blocking(move || crate::accounts::views(provider.unwrap_or_default())).await.map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn account_create(name: String, isolated: Option<bool>, provider: Option<crate::accounts::Provider>) -> Result<crate::accounts::AccountView, String> {
        let provider = provider.unwrap_or_default();
        let account = crate::accounts::create(provider, &name, isolated.unwrap_or(false))?;
        Ok(crate::accounts::view(provider, &account, &crate::accounts::in_use_dir(provider), false))
    }

    /// Deletes a Lotus-made account; hides a ccs/env one, or with `purge` deletes a ccs folder too.
    /// Never the default for new work (`accounts::remove_in`). Off the main thread: a ccs folder
    /// can hold gigabytes of history.
    #[tauri::command]
    pub async fn account_remove(id: String, purge: Option<bool>, provider: Option<crate::accounts::Provider>) -> Result<(), String> {
        let provider = provider.unwrap_or_default();
        tauri::async_runtime::spawn_blocking(move || {
            // The usage cache is keyed by Claude account id; a Codex account has no entry there.
            if let (crate::accounts::Provider::Claude, crate::accounts::Removal::Deleted(_)) =
                (provider, crate::accounts::remove(provider, &id, purge.unwrap_or(false))?)
            {
                crate::usage::forget(&id);
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub fn account_unhide(id: String, provider: Option<crate::accounts::Provider>) -> Result<(), String> {
        crate::accounts::unhide(provider.unwrap_or_default(), &id)
    }

    /// Antigravity's one login on this Mac, or null when `agy` is not installed.
    #[tauri::command]
    pub async fn antigravity_login() -> Result<Option<crate::accounts::SingleLogin>, String> {
        tauri::async_runtime::spawn_blocking(crate::accounts::antigravity_login).await.map_err(|e| e.to_string())
    }

    /// What deleting an account's folder would hit: processes on it, chats only it holds.
    #[tauri::command]
    pub async fn account_removal_check(id: String, provider: Option<crate::accounts::Provider>) -> Result<crate::accounts::RemovalCheck, String> {
        tauri::async_runtime::spawn_blocking(move || crate::accounts::removal_check(provider.unwrap_or_default(), &id)).await.map_err(|e| e.to_string())?
    }

    /// Moving off ccs (issues/08): the plan, or null when this machine has no `~/.ccs`.
    #[tauri::command]
    pub fn ccs_migration_plan() -> Option<crate::ccs_migration::Plan> {
        crate::ccs_migration::plan()
    }

    /// Backs `~/.ccs` up (minutes for a few GB), then merges and re-points: off the main thread.
    #[tauri::command]
    pub async fn ccs_migration_run() -> Result<crate::ccs_migration::Plan, String> {
        tauri::async_runtime::spawn_blocking(crate::ccs_migration::run).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn ccs_migration_remove_mcp() -> Result<Vec<crate::ccs_migration::McpEntry>, String> {
        crate::ccs_migration::remove_mcp().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn chat_auth_get(runtime: State<'_, crate::chat_runtime::ChatRuntime>) -> Result<crate::chat_runtime::AuthView, String> {
        runtime.auth().view()
    }

    #[tauri::command]
    pub fn chat_auth_save_key(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        key: String,
    ) -> Result<crate::chat_runtime::AuthView, String> {
        runtime.auth().save_key(&key)
    }

    #[tauri::command]
    pub fn chat_auth_remove_key(runtime: State<'_, crate::chat_runtime::ChatRuntime>) -> Result<crate::chat_runtime::AuthView, String> {
        runtime.auth().remove_key()
    }

    #[tauri::command]
    pub fn chat_auth_set_mode(
        runtime: State<'_, crate::chat_runtime::ChatRuntime>,
        mode: crate::chat_runtime::AuthMode,
    ) -> Result<crate::chat_runtime::AuthView, String> {
        runtime.auth().set_mode(mode)
    }

    #[tauri::command]
    pub fn chat_unsubscribe(runtime: State<'_, crate::chat_runtime::ChatRuntime>, subscription_id: u64) {
        runtime.unsubscribe(subscription_id)
    }

    // ── Headless agent CLI runs (Canvas, Smart Convert, Tasks) ───────────────────────────────────────────────

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn agent_cli_run(
        run_id: String,
        prompt: String,
        agent_id: String,
        command: Vec<String>,
        parser: String,
        model: String,
        effort: String,
        flash: bool,
        provider_session_id: Option<String>,
        image_attachments: Vec<agent_cli::ImageAttachment>,
        image_paths: Option<Vec<String>>,
        dangerously_skip_permissions: bool,
        cwd: Option<String>,
        on_chunk: Channel<String>,
    ) -> Result<(), String> {
        agent_cli::run(
            run_id,
            prompt,
            agent_id,
            command,
            parser,
            model,
            effort,
            flash,
            provider_session_id,
            image_attachments,
            image_paths,
            dangerously_skip_permissions,
            cwd,
            on_chunk,
        )
    }

    #[tauri::command]
    pub fn agent_cli_cancel(run_id: String) -> Result<bool, String> {
        agent_cli::cancel(run_id)
    }

    #[tauri::command]
    pub fn agent_cli_availability(
        command: Vec<String>,
        probe_auth: Option<bool>,
    ) -> agent_cli::Availability {
        agent_cli::availability(command, probe_auth.unwrap_or(true))
    }

    /// The models an agent CLI itself reports (`agent_models.rs`); `None` = fall back to the catalog.
    /// Blocking: Claude is asked through a short-lived process.
    #[tauri::command]
    pub async fn list_agent_models(agent_id: String) -> Option<Vec<crate::agent_models::AgentModel>> {
        tauri::async_runtime::spawn_blocking(move || crate::agent_models::list_agent_models(&agent_id))
            .await
            .ok()
            .flatten()
    }

    #[tauri::command]
    pub fn agent_cli_models(
        agent_id: String,
        command: Vec<String>,
    ) -> agent_cli::DiscoveredModels {
        agent_cli::discover_models(agent_id, command)
    }

    #[tauri::command]
    pub fn browser_preview_open_window(
        app: tauri::AppHandle,
        url: String,
    ) -> Result<browser_preview::BrowserPreview, AppError> {
        browser_preview::open_browser_preview(&app, &url)
    }

    #[tauri::command]
    pub fn browser_preview_open(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
        url: String,
        bounds: browser_preview::BrowserPreviewBounds,
        root: Option<String>,
    ) -> Result<browser_preview::BrowserPreview, AppError> {
        browser_preview::open_embedded_browser_preview(
            &app,
            &window,
            slot.as_deref(),
            &url,
            bounds,
            root.as_deref(),
        )
    }

    #[tauri::command]
    pub async fn browser_preview_reachable(url: String) -> &'static str {
        browser_preview::browser_preview_reachable(url).await
    }

    #[tauri::command]
    pub fn browser_preview_sync_bounds(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
        bounds: browser_preview::BrowserPreviewBounds,
    ) -> Result<(), AppError> {
        browser_preview::sync_embedded_browser_preview_bounds(&app, &window, slot.as_deref(), bounds)
    }

    #[tauri::command]
    pub fn browser_preview_close(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
    ) -> Result<(), AppError> {
        browser_preview::close_embedded_browser_preview(&app, &window, slot.as_deref())
    }

    #[tauri::command]
    pub fn browser_preview_set_visible(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
        visible: bool,
    ) -> Result<(), AppError> {
        browser_preview::set_embedded_browser_preview_visible(&app, &window, slot.as_deref(), visible)
    }

    #[tauri::command]
    pub async fn browser_preview_capture(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
        crop: Option<crate::canvas_browser_screenshot::CanvasBrowserScreenshotCropRect>,
    ) -> Result<String, AppError> {
        browser_preview::capture_embedded_browser_preview(&app, &window, slot.as_deref(), crop).await
    }

    #[tauri::command]
    pub fn browser_preview_reload(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
    ) -> Result<(), AppError> {
        browser_preview::reload_embedded_browser_preview(&app, &window, slot.as_deref())
    }

    #[tauri::command]
    pub fn browser_preview_go_back(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
    ) -> Result<(), AppError> {
        browser_preview::go_back_embedded_browser_preview(&app, &window, slot.as_deref())
    }

    #[tauri::command]
    pub fn browser_preview_go_forward(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
    ) -> Result<(), AppError> {
        browser_preview::go_forward_embedded_browser_preview(&app, &window, slot.as_deref())
    }

    #[tauri::command]
    pub fn browser_preview_start_annotation(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
    ) -> Result<(), AppError> {
        browser_preview::start_embedded_browser_annotation_mode(&app, &window, slot.as_deref())
    }

    #[tauri::command]
    pub fn browser_preview_stop_annotation(
        app: tauri::AppHandle,
        window: tauri::Window,
        slot: Option<String>,
    ) -> Result<(), AppError> {
        browser_preview::stop_embedded_browser_annotation_mode(&app, &window, slot.as_deref())
    }

    #[tauri::command]
    pub fn browser_preview_emit_annotation(
        app: tauri::AppHandle,
        window: tauri::Window,
        webview: tauri::Webview,
        payload: String,
    ) -> Result<(), AppError> {
        browser_preview::emit_embedded_browser_annotation(&app, &window, &webview, payload)
    }

    // ── Canvas Browser WebView commands ──────────────────────────────────

    #[tauri::command]
    pub fn open_canvas_browser(
        app: tauri::AppHandle,
        window: tauri::Window,
        terminal_id: String,
        url: String,
        allowed_root: Option<String>,
        bounds: canvas_browser::CanvasBrowserBounds,
    ) -> Result<canvas_browser::CanvasBrowserOpenResult, AppError> {
        canvas_browser::open_canvas_browser(
            &app,
            &window,
            &terminal_id,
            &url,
            allowed_root.map(std::path::PathBuf::from),
            bounds,
        )
    }

    #[tauri::command]
    pub fn close_canvas_browser(
        app: tauri::AppHandle,
        terminal_id: String,
    ) -> Result<(), AppError> {
        canvas_browser::close_canvas_browser(&app, &terminal_id)
    }

    #[tauri::command]
    pub fn navigate_canvas_browser(
        app: tauri::AppHandle,
        terminal_id: String,
        url: String,
        allowed_root: Option<String>,
    ) -> Result<(), AppError> {
        canvas_browser::navigate_canvas_browser(
            &app,
            &terminal_id,
            &url,
            allowed_root.map(std::path::PathBuf::from),
        )
    }

    #[tauri::command]
    pub fn sync_canvas_browser_bounds(
        app: tauri::AppHandle,
        terminal_id: String,
        bounds: canvas_browser::CanvasBrowserBounds,
    ) -> Result<(), AppError> {
        canvas_browser::sync_canvas_browser_bounds(&app, &terminal_id, bounds)
    }

    #[tauri::command]
    pub fn reload_canvas_browser(
        app: tauri::AppHandle,
        terminal_id: String,
    ) -> Result<(), AppError> {
        canvas_browser::reload_canvas_browser(&app, &terminal_id)
    }

    #[tauri::command]
    pub fn is_canvas_browser_open(app: tauri::AppHandle, terminal_id: String) -> bool {
        canvas_browser::is_canvas_browser_open(&app, &terminal_id)
    }

    #[tauri::command]
    pub fn get_canvas_browser_status(
        app: tauri::AppHandle,
        terminal_id: String,
    ) -> canvas_browser::CanvasBrowserStatus {
        canvas_browser::canvas_browser_status(&app, &terminal_id)
    }

    #[tauri::command]
    pub fn history_canvas_browser(
        app: tauri::AppHandle,
        terminal_id: String,
        delta: i32,
    ) -> Result<(), AppError> {
        canvas_browser::history_canvas_browser(&app, &terminal_id, delta)
    }

    /// Set the origin allowlist policy for a browser node. Human-controlled from
    /// the node UI — deliberately NOT exposed on the agent-facing HTTP API so an
    /// agent (or injected page) cannot widen its own guardrail.
    #[tauri::command]
    pub fn set_canvas_browser_policy(
        app: tauri::AppHandle,
        terminal_id: String,
        policy: crate::canvas_browser_policy::CanvasBrowserPolicy,
    ) -> Result<(), AppError> {
        app.state::<crate::canvas_browser_policy::CanvasBrowserPolicyStore>()
            .set(&terminal_id, policy);
        Ok(())
    }

    #[tauri::command]
    pub fn get_canvas_browser_policy(
        app: tauri::AppHandle,
        terminal_id: String,
    ) -> Result<crate::canvas_browser_policy::CanvasBrowserPolicy, AppError> {
        Ok(app
            .state::<crate::canvas_browser_policy::CanvasBrowserPolicyStore>()
            .get(&terminal_id))
    }

    /// Set a node's write-action approval mode (Auto/Ask). Human-controlled from
    /// the node UI; never exposed to the agent HTTP API.
    #[tauri::command]
    pub fn set_canvas_browser_approval_mode(
        app: tauri::AppHandle,
        terminal_id: String,
        mode: crate::canvas_browser_approval::ApprovalMode,
    ) -> Result<(), AppError> {
        app.state::<crate::canvas_browser_approval::CanvasBrowserApprovalModeStore>()
            .set(&terminal_id, mode);
        Ok(())
    }

    #[tauri::command]
    pub fn get_canvas_browser_approval_mode(
        app: tauri::AppHandle,
        terminal_id: String,
    ) -> Result<crate::canvas_browser_approval::ApprovalMode, AppError> {
        Ok(app
            .state::<crate::canvas_browser_approval::CanvasBrowserApprovalModeStore>()
            .get(&terminal_id))
    }

    /// Human decision on a pending write action (from the approval chip). Returns
    /// whether the action was still pending. This is the ONLY way an `Ask`-mode
    /// write is released — deliberately a Tauri command, not an agent HTTP route.
    #[tauri::command]
    pub fn resolve_canvas_browser_action(
        app: tauri::AppHandle,
        request_id: String,
        approve: bool,
    ) -> Result<bool, AppError> {
        use crate::canvas_browser_approval::ApprovalDecision;
        let decision = if approve {
            ApprovalDecision::Approve
        } else {
            ApprovalDecision::Deny
        };
        Ok(app
            .state::<crate::canvas_browser_approval::CanvasBrowserApprovalGate>()
            .resolve(&request_id, decision))
    }

    #[tauri::command]
    pub fn focus_canvas_main_webview(app: tauri::AppHandle) -> Result<(), AppError> {
        canvas_browser::focus_canvas_main_webview(&app)
    }

    #[tauri::command]
    pub fn start_canvas_browser_annotation_mode(
        app: tauri::AppHandle,
        terminal_id: String,
    ) -> Result<(), AppError> {
        canvas_browser::start_canvas_browser_annotation_mode(&app, &terminal_id)
    }

    #[tauri::command]
    pub fn stop_canvas_browser_annotation_mode(
        app: tauri::AppHandle,
        terminal_id: String,
    ) -> Result<(), AppError> {
        canvas_browser::stop_canvas_browser_annotation_mode(&app, &terminal_id)
    }

    #[tauri::command]
    pub fn emit_canvas_browser_annotation(
        app: tauri::AppHandle,
        terminal_id: String,
        payload: String,
    ) -> Result<(), AppError> {
        canvas_browser::emit_canvas_browser_annotation(&app, &terminal_id, payload)
    }

    /// IPC command the injected snapshot/search/action script calls to deliver its
    /// result (slice I1). Granted to `canvas-browser-*` webviews by the
    /// `canvas-browser-annotation` capability; only accepts tool-result payloads.
    #[tauri::command]
    pub fn emit_canvas_browser_tool_result(
        app: tauri::AppHandle,
        terminal_id: String,
        payload: String,
    ) -> Result<(), AppError> {
        canvas_browser::emit_canvas_browser_tool_result(&app, &terminal_id, payload)
    }

    /// Verify-first instrumentation (Slice 0): relays a frontend-formatted
    /// `[canvas][annotation-trace] ...` line into this process's stderr, so a
    /// live repro can be read from the one Rust dev terminal instead of also
    /// opening the WebView DevTools console. Main-app webview only.
    /// Mute the Mac's sound output while dictating (true) and put it back after (false).
    #[tauri::command]
    pub fn voice_mute_other_audio(on: bool) {
        crate::voice_duck::request(on);
    }

    /// Play an Agent-Done Alert sound natively; an error means "use the webview's audio instead".
    #[tauri::command]
    pub fn voice_play_agent_done_sound(id: String) -> Result<(), String> {
        crate::agent_done_sound::play(&id)
    }

    #[tauri::command]
    pub fn log_canvas_browser_annotation_trace(line: String) {
        canvas_browser::log_canvas_browser_annotation_trace(&line);
    }

    /// Main-app webview only — invoked AFTER an annotation's text context already
    /// delivered via the nav-scheme path, so screenshot capture never depends on the
    /// annotated (often remote-origin) child webview's own IPC capability grant.
    #[tauri::command]
    pub async fn capture_canvas_browser_annotation_screenshot(
        app: tauri::AppHandle,
        terminal_id: String,
        crop_rect: Option<crate::canvas_browser_screenshot::CanvasBrowserScreenshotCropRect>,
    ) -> Result<String, AppError> {
        canvas_browser::capture_canvas_browser_annotation_screenshot(&app, &terminal_id, crop_rect)
            .await
    }

    // ── CodeCanvas SQLite project store ────────────────────────────────

    fn codecanvas_note_assets_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> {
        let db_path =
            codecanvas_store::database_path(app).map_err(|err| AppError::Other(err.to_string()))?;
        let app_data_dir = db_path
            .parent()
            .ok_or_else(|| AppError::Other("CodeCanvas app data directory not found".into()))?;
        Ok(codecanvas_note_assets::assets_root(app_data_dir))
    }

    #[tauri::command]
    pub fn codecanvas_get_index(
        app: tauri::AppHandle,
    ) -> Result<codecanvas_store::CodeCanvasProjectIndex, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_store::get_index(&connection).map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_open_project(
        app: tauri::AppHandle,
        root_dir: String,
        location: Option<codecanvas_store::CodeCanvasProjectLocation>,
    ) -> Result<codecanvas_store::CodeCanvasProjectSnapshot, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let location = location.unwrap_or_default();
        let snapshot = codecanvas_store::open_project_at(&connection, &root_dir, &location)
            .map_err(|err| AppError::Other(err.to_string()))?;
        // Opening a project (always a user-initiated folder pick) is the trust signal:
        // pre-trust the normalized root in each agent CLI's native config so headless
        // dispatch never trips the workspace-trust gate (ADR 0032). Fail-open.
        //
        // Local projects only. A remote project's root is a path on the OTHER machine, and
        // pre-trusting it here would either name a directory that does not exist on this one or,
        // worse, a different directory that happens to share the path.
        if location.is_local() {
            trust_reconciler::reconcile_workspace_trust(std::path::Path::new(
                &snapshot.meta.root_dir,
            ));
        }
        Ok(snapshot)
    }

    #[tauri::command]
    pub fn codecanvas_load_project(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<Option<codecanvas_store::CodeCanvasProjectSnapshot>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let snapshot = codecanvas_store::load_project(&connection, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))?;
        // Loading an existing project (e.g. boot-restore of the active project) also
        // counts as a user-trusted workspace — reconcile here too, not just on first
        // open, so known projects don't slip through the trust gate (ADR 0032). Fail-open.
        if let Some(snapshot) = &snapshot {
            trust_reconciler::reconcile_workspace_trust(std::path::Path::new(
                &snapshot.meta.root_dir,
            ));
        }
        Ok(snapshot)
    }

    /// Park a live agent's system prompt on disk and hand back its path.
    ///
    /// The typed launch path reads it back with `"$(cat …)"` instead of carrying ~3 KB inline. That
    /// is not a style choice: measured 2026-09-12, a command that long fills the tty's input queue,
    /// and the line discipline then rings the bell for every further character and discards it —
    /// the closing quote never lands and no CLI ever starts
    /// (`plans/codecanvas-session-refactor/issues/08`).
    #[tauri::command]
    pub fn canvas_write_persona(pane_id: String, content: String) -> Result<String, AppError> {
        let dir = crate::paths::lotus_state_dir().join("personas");
        std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
        // A pane id carries ':' separators; keep the file name flat and predictable.
        let safe: String = pane_id
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect();
        let path = dir.join(format!("{safe}.txt"));
        std::fs::write(&path, content.as_bytes()).map_err(AppError::Io)?;
        Ok(path.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub fn codecanvas_save_project(
        app: tauri::AppHandle,
        snapshot: codecanvas_store::CodeCanvasProjectSnapshot,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_store::save_project(&connection, &snapshot)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_load_collaboration_record(
        app: tauri::AppHandle,
        project_id: String,
        run_id: String,
        kind: String,
    ) -> Result<Option<serde_json::Value>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_store::load_collaboration_record(&connection, &project_id, &run_id, &kind)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_save_collaboration_record(
        app: tauri::AppHandle,
        project_id: String,
        run_id: String,
        kind: String,
        payload: serde_json::Value,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_store::save_collaboration_record(
            &connection,
            &project_id,
            &run_id,
            &kind,
            &payload,
        )
        .map_err(|err| AppError::Other(err.to_string()))?;
        let _ = tauri::Emitter::emit(
            &app,
            "codecanvas://collaboration-record-updated",
            serde_json::json!({
                "projectId": project_id,
                "runId": run_id,
                "kind": kind,
                "source": "tauri-command",
            }),
        );
        Ok(())
    }

    #[tauri::command]
    pub fn codecanvas_memory_write(
        app: tauri::AppHandle,
        input: codecanvas_memory::WriteMemoryInput,
    ) -> Result<codecanvas_memory::MemoryItem, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_memory::write_memory(&connection, &input)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_memory_list(
        app: tauri::AppHandle,
        query: codecanvas_memory::MemoryListQuery,
    ) -> Result<Vec<codecanvas_memory::MemoryItem>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_memory::list_memory(&connection, &query)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_memory_search(
        app: tauri::AppHandle,
        query: codecanvas_memory::MemorySearchQuery,
    ) -> Result<Vec<codecanvas_memory::MemorySearchResult>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_memory::search_memory(&connection, &query)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_memory_archive(
        app: tauri::AppHandle,
        project_id: String,
        item_id: String,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        codecanvas_memory::archive_memory_item(&connection, &project_id, &item_id, now)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    /// Undo for `codecanvas_memory_archive`, so the panel can offer a real undo instead of a confirm.
    #[tauri::command]
    pub fn codecanvas_memory_restore(
        app: tauri::AppHandle,
        project_id: String,
        item_id: String,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        codecanvas_memory::restore_memory_item(&connection, &project_id, &item_id, now)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    /// Pin/unpin a memory item. Pinning writes the store's `pinned` tag, which the retention policy
    /// already honours as "never auto-archive".
    #[tauri::command]
    pub fn codecanvas_memory_set_pinned(
        app: tauri::AppHandle,
        project_id: String,
        item_id: String,
        pinned: bool,
    ) -> Result<codecanvas_memory::MemoryItem, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        codecanvas_memory::set_memory_pinned(&connection, &project_id, &item_id, pinned, now)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    /// Retention maintenance: archive expired/noisy memory for a project using the default policy.
    /// Returns the number of rows archived. Safe to call opportunistically (e.g. on project open).
    #[tauri::command]
    pub fn codecanvas_memory_archive_expired(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<usize, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        codecanvas_memory::archive_expired_memory(
            &connection,
            &project_id,
            &codecanvas_memory::RetentionPolicy::with_now(now),
        )
        .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_rename_project(
        app: tauri::AppHandle,
        project_id: String,
        alias: Option<String>,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_store::rename_project(&connection, &project_id, alias)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_close_project(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<codecanvas_store::CodeCanvasProjectIndex, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let index = codecanvas_store::close_project(&connection, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let root = codecanvas_note_assets_root(&app)?;
        codecanvas_note_assets::remove_project_asset_dir(&root, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))?;
        Ok(index)
    }

    #[tauri::command]
    pub fn codecanvas_set_active_project(
        app: tauri::AppHandle,
        project_id: Option<String>,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_store::set_active_project(&connection, project_id.as_deref())
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_list_agents(
        app: tauri::AppHandle,
    ) -> Result<Vec<codecanvas_agents::AgentDefinitionRecord>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_agents::list_agents(&connection).map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_save_agent(
        app: tauri::AppHandle,
        definition: codecanvas_agents::AgentDefinitionRecord,
    ) -> Result<codecanvas_agents::AgentDefinitionRecord, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_agents::save_agent(&connection, &definition)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_delete_agent(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_agents::delete_agent(&connection, &id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_list_agent_runs(
        app: tauri::AppHandle,
        agent_id: String,
    ) -> Result<Vec<codecanvas_runs::AgentRunRecordRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_runs::list_agent_runs(&connection, &agent_id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_append_agent_run(
        app: tauri::AppHandle,
        record: codecanvas_runs::AgentRunRecordRow,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_runs::append_agent_run(&connection, &record)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_list_sessions(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<Vec<codecanvas_sessions::CodeCanvasSessionRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_sessions::list_sessions(&connection, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_upsert_session(
        app: tauri::AppHandle,
        session: codecanvas_sessions::CodeCanvasSessionRow,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_sessions::upsert_session(&connection, &session)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_delete_session(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_sessions::delete_session(&connection, &id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_save_graph_run(
        app: tauri::AppHandle,
        record: codecanvas_graph_runs::GraphRunRow,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_graph_runs::save_graph_run(&connection, &record)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_list_graph_runs(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<Vec<codecanvas_graph_runs::GraphRunRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_graph_runs::list_graph_runs(&connection, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_list_all_graph_runs(
        app: tauri::AppHandle,
    ) -> Result<Vec<codecanvas_graph_runs::GraphRunRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_graph_runs::list_all_graph_runs(&connection)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_get_graph_run(
        app: tauri::AppHandle,
        id: String,
    ) -> Result<Option<codecanvas_graph_runs::GraphRunRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_graph_runs::get_graph_run(&connection, &id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    fn graph_run_engine(
        app: &tauri::AppHandle,
    ) -> Result<std::sync::Arc<lotus_graph_run::Engine>, AppError> {
        use tauri::Manager;
        app.try_state::<crate::graph_run_host::GraphRunHost>()
            .map(|host| std::sync::Arc::clone(&host.engine))
            .ok_or_else(|| AppError::Other("the graph run engine is not running".into()))
    }

    /// Starts a Graph Run on the Rust engine (ADR-0049 §6). Returns the run id; the run itself
    /// goes on in the background and is read back with `codecanvas_get_graph_run`.
    #[tauri::command]
    pub async fn graph_run_start(
        app: tauri::AppHandle,
        project_id: String,
        graph: lotus_graph_run::RunGraph,
        workflow_id: Option<String>,
        run: Option<lotus_graph_run::RunBrief>,
        budget_cap: Option<f64>,
        factory: Option<lotus_graph_run::FactoryTicket>,
    ) -> Result<String, AppError> {
        let _config_guard = if factory.is_some() { Some(crate::factory_settings::CONFIG_LOCK.lock().await) } else { None };
        if let Some(ticket) = &factory {
            if app.try_state::<lotus_graph_run::factory::check_trials::CheckTrials>().is_some_and(|trials| trials.is_running(&ticket.repo)) {
                return Err(AppError::Other("Finish or cancel this repository's check trial before starting a Factory run".into()));
            }
        }
        graph_run_engine(&app)?
            .start(lotus_graph_run::StartRun { project_id, graph, workflow_id, run, budget_cap, factory })
            .await
            .map_err(|err| AppError::Other(err.to_string()))
    }

    /// The skills and MCP servers a Factory definition can name for this checkout (FI4): the user's,
    /// the plugins', the repo's at `origin/<base>`, and those of Lotus's private factory for `repo`
    /// (#169). Names only; never a server's args, env or headers.
    #[tauri::command]
    pub async fn factory_catalog(
        checkout: String,
        base: Option<String>,
        repo: Option<String>,
    ) -> Result<lotus_graph_run::factory::kit::Catalog, AppError> {
        tokio::task::spawn_blocking(move || {
            let env = crate::shell_env::user_login_env().clone();
            let at = base.map(|b| format!("origin/{b}"));
            let sources = crate::graph_run_host::factory_kit_sources();
            let private = repo.and_then(|repo| sources.private_dir(&repo));
            // Settings is told no workspace: guess the meta-repo from the folder above the checkout.
            let meta = lotus_graph_run::factory::kit::guess_meta_repo(std::path::Path::new(&checkout), &env);
            lotus_graph_run::factory::kit::read_catalog_with(
                &sources,
                std::path::Path::new(&checkout),
                at.as_deref(),
                private.as_deref(),
                meta.as_deref(),
                &env,
            )
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))
    }

    /// The Agents tab (FI5): a repo's factory definition as runs see it (`origin/<base>`) and as
    /// the checkout holds it, with the files that are not pushed yet. A repo with no factory of
    /// its own shows Lotus's private one for `repo` instead (#169).
    #[tauri::command]
    pub async fn factory_definition_view(
        checkout: String,
        base: Option<String>,
        repo: Option<String>,
    ) -> Result<lotus_graph_run::factory::edit::DefinitionView, AppError> {
        tokio::task::spawn_blocking(move || {
            let env = crate::shell_env::user_login_env().clone();
            let private = repo.and_then(|repo| crate::graph_run_host::factory_kit_sources().private_dir(&repo));
            lotus_graph_run::factory::edit::read_view(
                std::path::Path::new(&checkout),
                base.as_deref().unwrap_or(""),
                private.as_deref(),
                &env,
                lotus_graph_run::factory::edit::VIEW_FETCH_TIMEOUT,
            )
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))
    }

    /// Writes one role's agent file in the checkout (no commit, no push); `agent: null` deletes
    /// it, so the role is built in again. Refused when the definition would not parse.
    #[tauri::command]
    pub async fn factory_agent_save(
        checkout: String,
        role: lotus_graph_run::factory::Role,
        agent: Option<lotus_graph_run::factory::edit::AgentEdit>,
    ) -> Result<lotus_graph_run::factory::FactoryDefinition, AppError> {
        let _config_guard = crate::factory_settings::CONFIG_LOCK.lock().await;
        tokio::task::spawn_blocking(move || {
            let checkout = std::path::Path::new(&checkout);
            match agent {
                Some(agent) => lotus_graph_run::factory::edit::save_agent(checkout, role, &agent),
                None => lotus_graph_run::factory::edit::reset_agent(checkout, role),
            }
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
        .map_err(AppError::Other)
    }

    /// Starts Lotus's private factory for `repo` (#169): kept on this Mac, outside the repo, never
    /// committed. `gate` is a shell command line run in each run's worktree.
    #[tauri::command]
    pub async fn factory_private_setup(
        repo: String,
        gate: String,
    ) -> Result<lotus_graph_run::factory::FactoryDefinition, AppError> {
        let _config_guard = crate::factory_settings::CONFIG_LOCK.lock().await;
        tokio::task::spawn_blocking(move || {
            let dir = crate::graph_run_host::factory_kit_sources()
                .private_dir(&repo)
                .ok_or_else(|| format!("{repo} is not an owner/name repo"))?;
            lotus_graph_run::factory::edit::create_private(&dir, &gate)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
        .map_err(AppError::Other)
    }

    /// The skills and MCP servers every agent gets, in the checkout's `.lotus/factory.toml`.
    #[tauri::command]
    pub async fn factory_shared_save(
        checkout: String,
        skills: Vec<String>,
        mcp: Vec<String>,
    ) -> Result<lotus_graph_run::factory::FactoryDefinition, AppError> {
        let _config_guard = crate::factory_settings::CONFIG_LOCK.lock().await;
        tokio::task::spawn_blocking(move || {
            lotus_graph_run::factory::edit::save_shared(std::path::Path::new(&checkout), &skills, &mcp)
        })
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
        .map_err(AppError::Other)
    }

    /// Raise cap on a run paused at its budget cap; returns the new cap (USD, whole cents).
    #[tauri::command]
    pub async fn graph_run_raise_cap(app: tauri::AppHandle, id: String) -> Result<f64, AppError> {
        graph_run_engine(&app)?
            .raise_cap(&id)
            .await
            .map_err(|err| AppError::Other(err.to_string()))
    }

    /// Sets a Feedback Item's label as the user chose it in the Chief of Staff pane (CoS 5).
    #[tauri::command]
    pub fn factory_set_feedback_label(app: tauri::AppHandle, run_id: String, item_id: String, label: String) -> Result<(), AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::set_feedback_label(&app, &host, &run_id, &item_id, &label).map_err(AppError::Other)
    }

    /// Starts the next Revision Run on a Factory PR ("Start round", CoS 6). Returns the round's run id.
    #[tauri::command]
    pub async fn factory_start_round(app: tauri::AppHandle, run_id: String) -> Result<String, AppError> {
        use tauri::Manager;
        let _config_guard = crate::factory_settings::CONFIG_LOCK.lock().await;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        let repo = lotus_graph_run::RunStore::get(host.store.as_ref(), &run_id).ok().flatten().and_then(|r| r.checkpoint.engine.and_then(|m| m.factory)).map(|t| t.repo);
        if repo.is_some_and(|repo| app.try_state::<lotus_graph_run::factory::check_trials::CheckTrials>().is_some_and(|trials| trials.is_running(&repo))) {
            return Err(AppError::Other("Finish or cancel this repository's check trial before starting a round".into()));
        }
        crate::graph_run_host::start_round(&app, &host, &run_id).await.map_err(AppError::Other)
    }

    /// Accepts a spec change on a Factory PR: `criteria` become an Amendment on the approved spec (CoS 8).
    #[tauri::command]
    pub async fn factory_accept_spec_change(app: tauri::AppHandle, run_id: String, item_id: String, criteria: Vec<String>) -> Result<(), AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::accept_spec_change(&app, &host, &run_id, &item_id, &criteria).await.map_err(AppError::Other)
    }

    /// Declines a spec change on a Factory PR as out of scope; a reply is drafted, never posted (CoS 8).
    #[tauri::command]
    pub async fn factory_decline_spec_change(app: tauri::AppHandle, run_id: String, item_id: String) -> Result<(), AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::decline_spec_change(&app, &host, &run_id, &item_id).await.map_err(AppError::Other)
    }

    /// Sets the text of a reply draft (`key` = an item id, or `summary:<round>`); empty discards it (CoS 9).
    #[tauri::command]
    pub async fn factory_edit_draft(app: tauri::AppHandle, run_id: String, key: String, text: String) -> Result<(), AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::edit_draft(&app, &host, &run_id, &key, &text).await.map_err(AppError::Other)
    }

    /// Send: posts one reply draft on the PR as the user (CoS 9).
    #[tauri::command]
    pub async fn factory_send_draft(app: tauri::AppHandle, run_id: String, key: String) -> Result<(), AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::send_drafts(&app, &host, &run_id, Some(&key)).await.map_err(AppError::Other)
    }

    /// Send all: posts every reply draft, then asks the reviewers whose items were addressed to review again (CoS 9).
    #[tauri::command]
    pub async fn factory_send_all(app: tauri::AppHandle, run_id: String) -> Result<(), AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::send_drafts(&app, &host, &run_id, None).await.map_err(AppError::Other)
    }

    /// The answer to "Who is GitHub @x on Slack?": a Slack member ID, remembered (CoS 12).
    #[tauri::command]
    pub async fn factory_set_slack_identity(app: tauri::AppHandle, github: String, slack: String) -> Result<(), AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::set_slack_identity(&app, &host, &github, &slack).await.map_err(AppError::Other)
    }

    /// The Slack thread a Factory PR's link was shared in, as Slack search finds it now (CoS 12).
    #[tauri::command]
    pub async fn factory_find_slack_thread(app: tauri::AppHandle, run_id: String) -> Result<Option<lotus_graph_run::SlackThread>, AppError> {
        use tauri::Manager;
        let host = app.try_state::<crate::graph_run_host::GraphRunHost>().ok_or_else(|| AppError::Other("the graph run engine is not running".into()))?;
        crate::graph_run_host::find_slack_thread(&host, &run_id).await.map_err(AppError::Other)
    }

    /// Opens a Factory Run's worktree in Finder ("Open worktree", ADR-0056 §5). Only a folder
    /// inside the Factory root, named by the run id.
    #[tauri::command]
    pub fn factory_open_worktree(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
        if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err(AppError::Other("not a Factory run id".into()));
        }
        let worktree = lotus_graph_run::factory::worktree_path(&crate::factory_host::factory_root(), &id);
        if !worktree.is_dir() {
            return Err(AppError::Other("This run has no worktree any more.".into()));
        }
        #[allow(deprecated)]
        app.shell().open(worktree.to_string_lossy().into_owned(), None).map_err(|err| AppError::Other(err.to_string()))
    }

    /// When the Chief of Staff last looked at the runs (Unix ms), or None before its first look.
    #[tauri::command]
    pub fn factory_chief_checked_at(app: tauri::AppHandle) -> Option<i64> {
        use tauri::Manager;
        let at = app.try_state::<crate::graph_run_host::GraphRunHost>()?.chief_checked_at.load(std::sync::atomic::Ordering::Relaxed);
        (at > 0).then_some(at)
    }

    #[tauri::command]
    pub async fn graph_run_abort(app: tauri::AppHandle, id: String) -> Result<(), AppError> {
        graph_run_engine(&app)?
            .abort(&id)
            .await
            .map_err(|err| AppError::Other(err.to_string()))
    }

    /// The user's answers, approval, send-back or saved spec for a run waiting on its intake (FI2).
    #[tauri::command]
    pub async fn graph_run_decide(
        app: tauri::AppHandle,
        id: String,
        decision: crate::graph_run_host::Decision,
    ) -> Result<(), AppError> {
        graph_run_engine(&app)?
            .decide(&id, decision.into())
            .await
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_save_artifact(
        app: tauri::AppHandle,
        artifact: codecanvas_artifacts::ArtifactRow,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_artifacts::save_artifact(&connection, &artifact)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_list_artifacts(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<Vec<codecanvas_artifacts::ArtifactRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_artifacts::list_artifacts(&connection, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_save_note_asset(
        app: tauri::AppHandle,
        input: codecanvas_note_assets::SaveNoteAssetInput,
    ) -> Result<codecanvas_note_assets::NoteAssetRow, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        if codecanvas_store::load_project(&connection, &input.project_id)
            .map_err(|err| AppError::Other(err.to_string()))?
            .is_none()
        {
            return Err(AppError::Other("CodeCanvas project not found".into()));
        }
        let root = codecanvas_note_assets_root(&app)?;
        let row =
            codecanvas_note_assets::save_note_asset_bytes(&root, input).map_err(AppError::Other)?;
        codecanvas_note_assets::save_note_asset(&connection, &row)
            .map_err(|err| AppError::Other(err.to_string()))?;
        Ok(row)
    }

    #[tauri::command]
    pub fn codecanvas_import_note_asset_path(
        app: tauri::AppHandle,
        input: codecanvas_note_assets::ImportNoteAssetPathInput,
    ) -> Result<codecanvas_note_assets::NoteAssetRow, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        if codecanvas_store::load_project(&connection, &input.project_id)
            .map_err(|err| AppError::Other(err.to_string()))?
            .is_none()
        {
            return Err(AppError::Other("CodeCanvas project not found".into()));
        }
        let root = codecanvas_note_assets_root(&app)?;
        let row = codecanvas_note_assets::import_note_asset_path(&root, input)
            .map_err(AppError::Other)?;
        codecanvas_note_assets::save_note_asset(&connection, &row)
            .map_err(|err| AppError::Other(err.to_string()))?;
        Ok(row)
    }

    #[tauri::command]
    pub fn codecanvas_list_note_assets(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<Vec<codecanvas_note_assets::NoteAssetRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codecanvas_note_assets::list_note_assets(&connection, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_read_note_asset(
        app: tauri::AppHandle,
        asset_id: String,
    ) -> Result<codecanvas_note_assets::ReadNoteAssetOutput, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let asset = codecanvas_note_assets::get_note_asset(&connection, &asset_id)
            .map_err(|err| AppError::Other(err.to_string()))?
            .ok_or_else(|| AppError::Other("Note Asset not found".into()))?;
        let root = codecanvas_note_assets_root(&app)?;
        codecanvas_note_assets::read_note_asset_bytes(&root, asset).map_err(AppError::Other)
    }

    /// Absolute on-disk path of a stored note asset. Used to hand a canvas image shape's file to a
    /// terminal/agent PTY (which reads images by path), without shipping the bytes back to JS.
    #[tauri::command]
    pub fn codecanvas_note_asset_path(
        app: tauri::AppHandle,
        asset_id: String,
    ) -> Result<String, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let asset = codecanvas_note_assets::get_note_asset(&connection, &asset_id)
            .map_err(|err| AppError::Other(err.to_string()))?
            .ok_or_else(|| AppError::Other("Note Asset not found".into()))?;
        let root = codecanvas_note_assets_root(&app)?;
        Ok(codecanvas_note_assets::note_asset_path(&root, &asset)
            .to_string_lossy()
            .into_owned())
    }

    /// Stage an asset into a space-free `~/.lotus/agent-drops/<clean-name>.<ext>` and return that
    /// path — a short, readable, no-space location to hand an agent (vs the deep app-data path with
    /// a space in "Application Support"). Deterministic per asset, so re-drops don't pile up.
    #[tauri::command]
    pub fn codecanvas_stage_note_asset_for_agent(
        app: tauri::AppHandle,
        asset_id: String,
    ) -> Result<String, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let asset = codecanvas_note_assets::get_note_asset(&connection, &asset_id)
            .map_err(|err| AppError::Other(err.to_string()))?
            .ok_or_else(|| AppError::Other("Note Asset not found".into()))?;
        let root = codecanvas_note_assets_root(&app)?;
        let source = codecanvas_note_assets::note_asset_path(&root, &asset);
        let drops_dir = paths::lotus_state_dir().join("agent-drops");
        let dest = codecanvas_note_assets::stage_asset_for_agent(&source, &drops_dir, &asset)
            .map_err(AppError::Other)?;
        Ok(dest.to_string_lossy().into_owned())
    }

    #[tauri::command]
    pub fn codecanvas_delete_note_asset(
        app: tauri::AppHandle,
        asset_id: String,
        force: Option<bool>,
    ) -> Result<Option<codecanvas_note_assets::NoteAssetRow>, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let root = codecanvas_note_assets_root(&app)?;
        codecanvas_note_assets::delete_note_asset(
            &connection,
            &root,
            &asset_id,
            force.unwrap_or(false),
        )
        .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_prune_unused_note_assets(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<codecanvas_note_assets::PruneNoteAssetsOutput, AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let root = codecanvas_note_assets_root(&app)?;
        codecanvas_note_assets::prune_unused_note_assets(&connection, &root, &project_id)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codecanvas_reveal_note_asset(
        app: tauri::AppHandle,
        asset_id: String,
    ) -> Result<(), AppError> {
        let connection = codecanvas_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        let asset = codecanvas_note_assets::get_note_asset(&connection, &asset_id)
            .map_err(|err| AppError::Other(err.to_string()))?
            .ok_or_else(|| AppError::Other("Note Asset not found".into()))?;
        let root = codecanvas_note_assets_root(&app)?;
        let path = codecanvas_note_assets::note_asset_path(&root, &asset);
        codecanvas_note_assets::reveal_path(&path, true).map_err(AppError::Other)
    }

    #[tauri::command]
    pub fn codecanvas_reveal_note_asset_folder(
        app: tauri::AppHandle,
        project_id: String,
    ) -> Result<(), AppError> {
        let root = codecanvas_note_assets_root(&app)?;
        let dir = codecanvas_note_assets::project_asset_dir(&root, &project_id);
        std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
        codecanvas_note_assets::reveal_path(&dir, false).map_err(AppError::Other)
    }

    // Canvas Team Templates (JSON files under ~/.lotus/canvas-templates/)
    #[tauri::command]
    pub fn codecanvas_list_templates() -> Vec<canvas_templates::CanvasTeamTemplate> {
        canvas_templates::list_templates()
    }

    #[tauri::command]
    pub fn codecanvas_save_template(
        template: canvas_templates::CanvasTeamTemplate,
    ) -> Result<canvas_templates::CanvasTeamTemplate, AppError> {
        canvas_templates::save_template(template)
    }

    #[tauri::command]
    pub fn codecanvas_delete_template(id: String) -> Result<(), AppError> {
        canvas_templates::delete_template(id)
    }

    // ── Bridge SQLite memory store ──────────────────────────────────────

    #[tauri::command]
    pub fn bridge_memory_upsert_session(
        app: tauri::AppHandle,
        session: bridge_memory_store::BridgeMemorySession,
    ) -> Result<(), AppError> {
        let mut connection = bridge_memory_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        bridge_memory_store::upsert_session(&mut connection, &session)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn bridge_memory_append_turn(
        app: tauri::AppHandle,
        turn: bridge_memory_store::BridgeMemoryTurn,
    ) -> Result<(), AppError> {
        let mut connection = bridge_memory_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        bridge_memory_store::append_turn(&mut connection, &turn)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn bridge_memory_recent_turns(
        app: tauri::AppHandle,
        session_id: String,
        limit: Option<i64>,
    ) -> Result<Vec<bridge_memory_store::BridgeMemoryTurn>, AppError> {
        let connection = bridge_memory_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        bridge_memory_store::list_recent_turns(&connection, &session_id, limit.unwrap_or(50))
            .map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn bridge_memory_search(
        app: tauri::AppHandle,
        workspace_id: String,
        query: String,
        limit: Option<i64>,
    ) -> Result<Vec<bridge_memory_store::BridgeMemorySearchHit>, AppError> {
        let connection = bridge_memory_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        bridge_memory_store::search_turns(&connection, &workspace_id, &query, limit.unwrap_or(10))
            .map_err(|err| AppError::Other(err.to_string()))
    }

    // ── CodeSpace SQLite metadata store ──────────────────────────────────

    #[tauri::command]
    pub fn codespace_load_snapshot(
        app: tauri::AppHandle,
    ) -> Result<Option<codespace_store::CodeSpaceStoredSnapshot>, AppError> {
        let connection = codespace_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codespace_store::load_snapshot(&connection).map_err(|err| AppError::Other(err.to_string()))
    }

    /// Every workspace Lotus has seen, closed ones included, so a reopened folder keeps its id.
    #[tauri::command]
    pub fn codespace_known_workspaces(
        app: tauri::AppHandle,
    ) -> Result<Vec<codespace_store::CodeSpaceKnownWorkspace>, AppError> {
        let connection = codespace_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codespace_store::load_known_workspaces(&connection).map_err(|err| AppError::Other(err.to_string()))
    }

    #[tauri::command]
    pub fn codespace_save_snapshot(
        app: tauri::AppHandle,
        snapshot: codespace_store::CodeSpaceStoredSnapshot,
    ) -> Result<(), AppError> {
        let mut connection = codespace_store::open_app_store(&app)
            .map_err(|err| AppError::Other(err.to_string()))?;
        codespace_store::save_snapshot(&mut connection, &snapshot)
            .map_err(|err| AppError::Other(err.to_string()))
    }

    // ── Project files ────────────────────────────────────────────────────

    #[tauri::command]
    pub async fn search_codebase(
        project_path: String,
        pattern: String,
        file_glob: Option<String>,
        max_results: Option<u32>,
    ) -> Result<Vec<project_files::SearchResult>, String> {
        project_files::search_codebase(project_path, pattern, file_glob, max_results)
    }

    #[tauri::command]
    pub async fn read_project_file(
        project_path: String,
        file_path: String,
        start_line: Option<u32>,
        end_line: Option<u32>,
    ) -> Result<project_files::FileContent, String> {
        project_files::read_project_file(project_path, file_path, start_line, end_line)
    }

    #[tauri::command]
    pub async fn list_project_directory(
        project_path: String,
        relative_path: Option<String>,
        max_depth: Option<u32>,
    ) -> Result<Vec<String>, String> {
        project_files::list_project_directory(project_path, relative_path, max_depth)
    }

    #[tauri::command]
    pub async fn git_blame_file(
        project_path: String,
        file_path: String,
        start_line: Option<u32>,
        end_line: Option<u32>,
    ) -> Result<Vec<project_files::GitBlameEntry>, String> {
        project_files::git_blame_file(project_path, file_path, start_line, end_line)
    }

    #[tauri::command]
    pub async fn git_diff(project_path: String, target: Option<String>) -> Result<String, String> {
        project_files::git_diff(project_path, target)
    }

    #[tauri::command]
    pub async fn git_repo_status(project_path: String) -> Result<models::GitRepoStatus, String> {
        project_files::git_repo_status(project_path)
    }

    #[tauri::command]
    pub async fn codespace_git_status(
        repo_root: String,
    ) -> Result<Vec<codespace_git::CodespaceGitFileStatus>, AppError> {
        codespace_git::codespace_git_status(repo_root)
    }

    #[tauri::command]
    pub async fn codespace_git_repo_summary(
        repo_root: String,
    ) -> Result<codespace_git::CodespaceGitRepoSummary, AppError> {
        codespace_git::codespace_git_repo_summary(repo_root)
    }

    #[tauri::command]
    pub async fn codespace_git_stage_file(
        repo_root: String,
        file_path: String,
    ) -> Result<(), AppError> {
        codespace_git::codespace_git_stage_file(repo_root, file_path)
    }

    #[tauri::command]
    pub async fn codespace_git_stage_all(repo_root: String) -> Result<(), AppError> {
        codespace_git::codespace_git_stage_all(repo_root)
    }

    #[tauri::command]
    pub async fn codespace_git_unstage_file(
        repo_root: String,
        file_path: String,
    ) -> Result<(), AppError> {
        codespace_git::codespace_git_unstage_file(repo_root, file_path)
    }

    #[tauri::command]
    pub async fn codespace_git_unstage_all(repo_root: String) -> Result<(), AppError> {
        codespace_git::codespace_git_unstage_all(repo_root)
    }

    #[tauri::command]
    pub async fn codespace_git_discard_all_changes(repo_root: String) -> Result<(), AppError> {
        codespace_git::codespace_git_discard_all_changes(repo_root)
    }

    #[tauri::command]
    pub async fn codespace_git_discard_file(
        repo_root: String,
        file_path: String,
    ) -> Result<(), AppError> {
        codespace_git::codespace_git_discard_file(repo_root, file_path)
    }

    #[tauri::command]
    pub async fn codespace_git_commit(repo_root: String, message: String) -> Result<(), AppError> {
        codespace_git::codespace_git_commit(repo_root, message)
    }

    #[tauri::command]
    pub async fn codespace_git_push(repo_root: String) -> Result<(), AppError> {
        codespace_git::codespace_git_push(repo_root)
    }

    #[tauri::command]
    pub async fn codespace_git_panel_refresh(
        repo_root: String,
    ) -> Result<codespace_git::CodespaceGitPanelRefresh, AppError> {
        codespace_git::codespace_git_panel_refresh(repo_root)
    }

    #[tauri::command]
    pub async fn codespace_git_discover_repos(workspace_root: String) -> Vec<String> {
        codespace_git::codespace_git_discover_repos(workspace_root)
    }

    #[tauri::command]
    pub async fn codespace_git_panel_refresh_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<codespace_git::CodespaceGitPanelRefresh, AppError> {
        codespace_git_ssh::codespace_git_panel_refresh_ssh(
            target,
            repo_root,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn codespace_git_status_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<Vec<codespace_git::CodespaceGitFileStatus>, AppError> {
        codespace_git_ssh::codespace_git_status_ssh(target, repo_root, Some(transport.inner()))
    }

    #[tauri::command]
    pub async fn codespace_git_repo_summary_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<codespace_git::CodespaceGitRepoSummary, AppError> {
        codespace_git_ssh::codespace_git_repo_summary_ssh(
            target,
            repo_root,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn codespace_git_stage_file_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        file_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::codespace_git_stage_file_ssh(
            target,
            repo_root,
            file_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn codespace_git_stage_all_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::codespace_git_stage_all_ssh(target, repo_root, Some(transport.inner()))
    }

    #[tauri::command]
    pub async fn codespace_git_unstage_file_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        file_path: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::codespace_git_unstage_file_ssh(
            target,
            repo_root,
            file_path,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn codespace_git_unstage_all_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::codespace_git_unstage_all_ssh(target, repo_root, Some(transport.inner()))
    }

    #[tauri::command]
    pub async fn codespace_git_discard_all_changes_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::codespace_git_discard_all_changes_ssh(
            target,
            repo_root,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn codespace_git_discard_file_ssh(
        app: tauri::AppHandle,
        target: cli_tools::SshToolTarget,
        repo_root: String,
        file_path: String,
    ) -> Result<(), AppError> {
        // Several SSH round trips: off the async runtime. The transport is looked up in there,
        // as a `State` borrow cannot move into the blocking task.
        tauri::async_runtime::spawn_blocking(move || {
            let transport = app.state::<remote_transport::RemoteTransport>();
            codespace_git_ssh::codespace_git_discard_file_ssh(
                target,
                repo_root,
                file_path,
                Some(transport.inner()),
            )
        })
        .await
        .map_err(|err| AppError::Other(format!("git task crashed: {err}")))?
    }

    #[tauri::command]
    pub async fn codespace_git_commit_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        message: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::codespace_git_commit_ssh(
            target,
            repo_root,
            message,
            Some(transport.inner()),
        )
    }

    #[tauri::command]
    pub async fn codespace_git_push_ssh(
        target: cli_tools::SshToolTarget,
        repo_root: String,
        transport: State<'_, remote_transport::RemoteTransport>,
    ) -> Result<(), AppError> {
        codespace_git_ssh::codespace_git_push_ssh(target, repo_root, Some(transport.inner()))
    }

    #[tauri::command]
    pub async fn codespace_git_ai_suggest_commit(repo_root: String) -> Result<String, AppError> {
        // Run the blocking CLI call off the async runtime so we don't stall it.
        tauri::async_runtime::spawn_blocking(move || {
            codespace_git::codespace_git_ai_suggest_commit(repo_root)
        })
        .await
        .map_err(|err| AppError::Other(format!("AI suggest task crashed: {err}")))?
    }

    #[tauri::command]
    pub async fn codespace_git_diff_file(
        repo_root: String,
        file_path: String,
        target: String,
    ) -> Result<String, AppError> {
        codespace_git::codespace_git_diff_file(repo_root, file_path, target)
    }

    #[tauri::command]
    pub async fn codespace_git_diff_file_content(
        repo_root: String,
        file_path: String,
        target: String,
    ) -> Result<codespace_git::CodespaceGitFileDiffContent, AppError> {
        codespace_git::codespace_git_diff_file_content(repo_root, file_path, target)
    }

    #[tauri::command]
    pub async fn codespace_git_diff_file_ssh(
        app: tauri::AppHandle,
        target: cli_tools::SshToolTarget,
        repo_root: String,
        file_path: String,
        diff_target: String,
    ) -> Result<String, AppError> {
        // Several SSH round trips: off the async runtime. The transport is looked up in there,
        // as a `State` borrow cannot move into the blocking task.
        tauri::async_runtime::spawn_blocking(move || {
            let transport = app.state::<remote_transport::RemoteTransport>();
            codespace_git_ssh::codespace_git_diff_file_ssh(
                target,
                repo_root,
                file_path,
                diff_target,
                Some(transport.inner()),
            )
        })
        .await
        .map_err(|err| AppError::Other(format!("git task crashed: {err}")))?
    }

    #[tauri::command]
    pub async fn codespace_git_diff_file_content_ssh(
        app: tauri::AppHandle,
        target: cli_tools::SshToolTarget,
        repo_root: String,
        file_path: String,
        diff_target: String,
    ) -> Result<codespace_git::CodespaceGitFileDiffContent, AppError> {
        // Several SSH round trips: off the async runtime. The transport is looked up in there,
        // as a `State` borrow cannot move into the blocking task.
        tauri::async_runtime::spawn_blocking(move || {
            let transport = app.state::<remote_transport::RemoteTransport>();
            codespace_git_ssh::codespace_git_diff_file_content_ssh(
                target,
                repo_root,
                file_path,
                diff_target,
                Some(transport.inner()),
            )
        })
        .await
        .map_err(|err| AppError::Other(format!("git task crashed: {err}")))?
    }

    #[tauri::command]
    pub async fn codespace_git_ai_suggest_commit_ssh(
        app: tauri::AppHandle,
        target: cli_tools::SshToolTarget,
        repo_root: String,
    ) -> Result<String, AppError> {
        // Two SSH reads and a CLI run: off the async runtime, as the local one. The transport is
        // looked up in there, as a `State` borrow cannot move into the blocking task.
        tauri::async_runtime::spawn_blocking(move || {
            let transport = app.state::<remote_transport::RemoteTransport>();
            codespace_git_ssh::codespace_git_ai_suggest_commit_ssh(
                target,
                repo_root,
                Some(transport.inner()),
            )
        })
        .await
        .map_err(|err| AppError::Other(format!("AI suggest task crashed: {err}")))?
    }

    // ── Bridge MCP ────────────────────────────────────────────────────────────

    /// `active_workspace_id` rides along with the fleet rather than getting its own command: it
    /// changes far less often than the fleet does, and a second command would be a second thing to
    /// keep in sync — plus a window that pushed cells but not its scope would leave `list_fleet`
    /// silently unscoped. Optional so an older frontend (or a window mid-navigation) still pushes.
    #[tauri::command]
    pub async fn bridge_push_fleet_snapshot(
        window: Window,
        state: State<'_, McpIpcSharedState>,
        fleet: Vec<mcp_ipc::McpFleetMember>,
        active_workspace_id: Option<String>,
    ) -> Result<(), AppError> {
        state.replace_fleet(window.label(), fleet);
        state.set_active_workspace_id(active_workspace_id);
        Ok(())
    }

    /// A canvas window reports which project it has mounted (`None` on unmount), so a note write
    /// for that project is routed through the open editor instead of the store (ADR-0047).
    #[tauri::command]
    pub async fn notes_bridge_set_canvas(
        window: Window,
        state: State<'_, McpIpcSharedState>,
        project_id: Option<String>,
    ) -> Result<(), AppError> {
        state.set_note_canvas(window.label(), project_id);
        Ok(())
    }

    /// CodeCanvas pushes its agent nodes here — kept separate from the CodeSpace
    /// fleet so neither surface clobbers the other; both surface in lotus_list_fleet.
    /// Scoped by the invoking window's label so multiple windows of the same
    /// surface do not overwrite each other.
    #[tauri::command]
    pub async fn bridge_push_canvas_fleet_snapshot(
        window: Window,
        state: State<'_, McpIpcSharedState>,
        fleet: Vec<mcp_ipc::McpFleetMember>,
    ) -> Result<(), AppError> {
        state.replace_canvas_fleet(window.label(), fleet);
        Ok(())
    }

    /// A canvas pane was closed for real — drop it from the durable roster.
    ///
    /// The roster keeps a pane alive across a project switch precisely because a
    /// board falling silent about it means nothing (see `McpIpcState::canvas_roster`).
    /// That makes closing the one event only the frontend can report: a closed pane
    /// and a switched-away one look identical from Rust until its PTY session ends,
    /// and the session can outlive the pane.
    #[tauri::command]
    pub async fn bridge_forget_canvas_cell(
        state: State<'_, McpIpcSharedState>,
        pane_id: String,
    ) -> Result<(), AppError> {
        state.forget_canvas_cell(&pane_id);
        Ok(())
    }

    /// Hook-reported turn state for the given panes — the canvas's cold hydrate.
    ///
    /// Until this existed, `pane_turns` had readers in the MCP fleet reply and the mobile HTTP
    /// handler but **none in the desktop frontend**, so peer agents and the phone knew an agent
    /// was blocked on a permission prompt while the canvas card showed it as running
    /// (`plans/honest-agent-status/`). This is the missing reader; `mcp://pane-turn` keeps it
    /// current afterwards.
    ///
    /// Pass the panes' `LOTUS_PANE_ID` (the canvas's project-scoped
    /// `canvasRuntimePaneId(projectId, nodeId)`), never a bare node id — the store is keyed by
    /// what the hook actually exported, and a mismatch here returns silence rather than an error.
    ///
    /// Panes with no fact are omitted from the result, not defaulted. Absent means "no hook has
    /// fired for this pane", which the caller must be able to distinguish from every status
    /// string; inventing a default here is what would make a hook-less runner look idle.
    #[tauri::command]
    pub async fn canvas_pane_turns(
        state: State<'_, McpIpcSharedState>,
        pane_ids: Vec<String>,
    ) -> Result<Vec<mcp_ipc::PaneTurnSnapshot>, AppError> {
        Ok(state.pane_turns_for(&pane_ids))
    }

    /// Swarm pushes its active team members here. Combined with codespace/canvas
    /// fleets in lotus_list_fleet. Push an empty vec on unmount to clear this
    /// window's swarm slice. Scoped by the invoking window's label.
    #[tauri::command]
    pub async fn bridge_push_swarm_fleet_snapshot(
        window: Window,
        state: State<'_, McpIpcSharedState>,
        fleet: Vec<mcp_ipc::McpFleetMember>,
    ) -> Result<(), AppError> {
        state.replace_swarm_fleet(window.label(), fleet);
        Ok(())
    }

    #[tauri::command]
    pub async fn bridge_resolve_mcp_request(
        state: State<'_, McpIpcSharedState>,
        request_id: String,
        ok: bool,
        data: Option<serde_json::Value>,
        error: Option<String>,
    ) -> Result<bool, AppError> {
        Ok(state.resolve_pending(&request_id, mcp_ipc::PendingResult { ok, data, error }))
    }

    #[tauri::command]
    pub async fn bridge_mcp_health(
        runtime: State<'_, std::sync::Arc<McpIpcRuntime>>,
    ) -> Result<mcp_health::BridgeMcpHealth, AppError> {
        let port = runtime.bound_port();

        let server_responsive = if let Some(port) = port {
            tokio::task::spawn_blocking(move || {
                ureq::get(&format!("http://127.0.0.1:{port}/v1/health"))
                    .timeout(std::time::Duration::from_millis(750))
                    .call()
                    .map(|r| r.status() == 200)
                    .unwrap_or(false)
            })
            .await
            .unwrap_or(false)
        } else {
            false
        };

        Ok(mcp_health::collect_bridge_mcp_health(
            port,
            server_responsive,
            mcp_sidecar_spawn_args(),
        ))
    }

    #[tauri::command]
    pub async fn bridge_mcp_launch_config() -> Result<mcp_config::LotusMcpLaunchConfig, AppError> {
        let Some((command, args)) = mcp_sidecar_spawn_args() else {
            return Err(crate::error::other("Lotus MCP sidecar is unavailable"));
        };
        Ok(mcp_config::build_lotus_mcp_launch_config(&command, &args))
    }

    #[tauri::command]
    pub async fn bridge_mcp_cleanup_stale_profiles(
    ) -> Result<mcp_keeper::OtherProfileCleanupReport, AppError> {
        Ok(mcp_keeper::cleanup_other_profile_if_stale())
    }

    /// Snapshot of recent MCP bootstrap telemetry events. Lets the Bridge UI
    /// backfill its banner detail panel when it mounts after bootstrap.
    #[tauri::command]
    pub async fn bridge_mcp_telemetry() -> Result<Vec<mcp_telemetry::TelemetryEvent>, AppError> {
        Ok(mcp_telemetry::recent())
    }

    /// Read the persisted Bridge tasks payload for a workspace. Returns
    /// `None` when no file exists yet (frontend treats null as empty).
    #[tauri::command]
    pub async fn bridge_read_tasks(workspace_id: String) -> Result<Option<String>, AppError> {
        crate::tasks_persist::read_tasks(&workspace_id)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Write the full Bridge tasks payload for a workspace (atomic, 0600).
    /// Caller is responsible for serialization shape — Rust just persists.
    #[tauri::command]
    pub async fn bridge_write_tasks(workspace_id: String, payload: String) -> Result<(), AppError> {
        crate::tasks_persist::write_tasks(&workspace_id, &payload)
            .map(|_| ())
            .map_err(|e| crate::error::other(e.to_string()))
    }

    #[tauri::command]
    pub async fn bridge_create_task(
        input: crate::bridge_tasks::CreateBridgeTaskInput,
    ) -> Result<crate::bridge_tasks::BridgeTask, AppError> {
        crate::bridge_tasks::create_task(input).map_err(|e| crate::error::other(e.to_string()))
    }

    #[tauri::command]
    pub async fn bridge_update_task(
        workspace_id: String,
        task_id: String,
        patch: crate::bridge_tasks::UpdateBridgeTaskPatch,
    ) -> Result<crate::bridge_tasks::BridgeTask, AppError> {
        crate::bridge_tasks::update_task(&workspace_id, &task_id, patch)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    #[tauri::command]
    pub async fn bridge_list_tasks(
        workspace_id: String,
        filter: Option<crate::bridge_tasks::TaskListFilter>,
    ) -> Result<Vec<crate::bridge_tasks::BridgeTask>, AppError> {
        crate::bridge_tasks::list_tasks(&workspace_id, filter.unwrap_or_default())
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Append one line to a task's history.
    ///
    /// A command of its own rather than letting the frontend read the task, push onto its events
    /// and write the whole thing back: an agent may be appending to the same task through the MCP
    /// IPC at that moment, and a read-modify-write from here would drop whatever it wrote. The
    /// Rust side already does load → mutate → save under the workspace lock; this is the door to it.
    #[tauri::command]
    pub async fn bridge_append_task_feedback_event(
        workspace_id: String,
        task_id: String,
        event: crate::bridge_task_feedback::BridgeTaskFeedbackEvent,
    ) -> Result<crate::bridge_tasks::BridgeTask, AppError> {
        crate::bridge_tasks::append_feedback_event(&workspace_id, &task_id, event)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Every ticket in an Obsidian vault. `vault_tickets` itself has no write path, and a test
    /// fails the build if one is added there — writes live only in `vault_ticket_edit`.
    // ── Automation (ADR-0038). Logic lives in automation_host; these only
    // unwrap managed state, which is absent when the database failed to open.

    fn automation_runtime(
        app: &tauri::AppHandle,
    ) -> Result<tauri::State<'_, crate::automation_host::AutomationRuntime>, AppError> {
        use tauri::Manager;
        app.try_state::<crate::automation_host::AutomationRuntime>()
            .ok_or_else(|| crate::error::other("automations are unavailable this session; see the Lotus log"))
    }

    #[tauri::command]
    pub async fn automation_list(
        app: tauri::AppHandle,
    ) -> Result<Vec<lotus_automation::views::AutomationView>, AppError> {
        automation_runtime(&app)?.list_automations().map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_list_gh_accounts() -> Result<Vec<lotus_automation::github::GhAccount>, AppError> {
        Ok(crate::automation_host::list_gh_accounts())
    }

    #[tauri::command]
    pub async fn automation_list_presets() -> Result<Vec<crate::automation_host::PresetView>, AppError> {
        Ok(crate::automation_host::list_presets())
    }

    #[tauri::command]
    pub async fn automation_create_pr_review(
        app: tauri::AppHandle,
        form: lotus_automation::pr_review::PrReviewForm,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        automation_runtime(&app)?.create_pr_review(form).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_run_now(
        app: tauri::AppHandle,
        automation_id: String,
        url: String,
        rereview: Option<bool>,
        feedback: Option<String>,
    ) -> Result<crate::automation_host::RunNowView, AppError> {
        automation_runtime(&app)?.run_review_round(&automation_id, &url, rereview.unwrap_or(false), feedback.as_deref().unwrap_or("")).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_list_runs(
        app: tauri::AppHandle,
        limit: Option<usize>,
    ) -> Result<Vec<lotus_automation::views::RunView>, AppError> {
        automation_runtime(&app)?.list_runs(limit.unwrap_or(50)).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_list_drafts(
        app: tauri::AppHandle,
    ) -> Result<Vec<lotus_automation::views::DraftView>, AppError> {
        automation_runtime(&app)?.list_drafts().map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_update_draft(
        app: tauri::AppHandle,
        draft_id: String,
        edited: lotus_automation::pr_review::EditedReview,
    ) -> Result<bool, AppError> {
        automation_runtime(&app)?.update_draft(&draft_id, edited).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_send_draft(
        app: tauri::AppHandle,
        draft_id: String,
        edited: Option<lotus_automation::pr_review::EditedReview>,
        send_even_if_stale: bool,
        reply_in_thread: Option<bool>,
        // The reviewer pressed Approve (ADR-0042); refused unless the review found nothing.
        approve: Option<bool>,
        // A re-review: reply ✅ on the GitHub threads of earlier findings it found resolved.
        close_threads: Option<bool>,
        // The reviewer's own text for the Slack thread's message, from the editable preview.
        slack_text: Option<String>,
        // false: Slack only, nothing posted on GitHub. Absent: GitHub, as before.
        post_github: Option<bool>,
    ) -> Result<crate::automation_host::SendView, AppError> {
        automation_runtime(&app)?
            .send_draft(
                draft_id,
                edited,
                send_even_if_stale,
                reply_in_thread.unwrap_or(false),
                approve.unwrap_or(false),
                close_threads.unwrap_or(false),
                slack_text,
                post_github.unwrap_or(true),
            )
            .await
            .map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_status(
        app: tauri::AppHandle,
    ) -> Result<crate::automation_slack::SlackStatusView, AppError> {
        Ok(automation_runtime(&app)?.slack_status())
    }

    #[tauri::command]
    pub async fn automation_slack_connect(
        app: tauri::AppHandle,
        app_token: String,
        user_token: String,
    ) -> Result<crate::automation_slack::SlackStatusView, AppError> {
        automation_runtime(&app)?.slack_connect(&app_token, &user_token).await.map_err(crate::error::other)
    }

    /// Runs the missed-message check now (Connectors → Slack → "Check now").
    #[tauri::command]
    pub async fn automation_slack_check_now(
        app: tauri::AppHandle,
    ) -> Result<crate::automation_slack::SlackStatusView, AppError> {
        automation_runtime(&app)?.slack_check_now().await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_set_bot_token(
        app: tauri::AppHandle,
        bot_token: String,
    ) -> Result<crate::automation_slack::SlackStatusView, AppError> {
        automation_runtime(&app)?.slack_set_bot_token(&bot_token).await.map_err(crate::error::other)
    }

    /// The emoji a review request shows for each state (Connectors → Slack → Status reactions).
    #[tauri::command]
    pub async fn automation_slack_reactions(
        app: tauri::AppHandle,
    ) -> Result<crate::automation_slack::SlackReactionsView, AppError> {
        Ok(automation_runtime(&app)?.slack_reactions())
    }

    /// The workspace's custom emoji for the reaction picker (cached 10 minutes unless `refresh`).
    #[tauri::command]
    pub async fn automation_slack_emoji(
        app: tauri::AppHandle,
        refresh: bool,
    ) -> Result<crate::automation_slack::SlackEmojiView, AppError> {
        automation_runtime(&app)?.slack_emoji(refresh).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_set_reactions(
        app: tauri::AppHandle,
        reactions: lotus_automation::slack::StatusReactions,
    ) -> Result<crate::automation_slack::SlackReactionsView, AppError> {
        automation_runtime(&app)?.slack_set_reactions(reactions).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_test_bot(app: tauri::AppHandle) -> Result<(), AppError> {
        automation_runtime(&app)?.slack_test_bot().await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_disconnect(app: tauri::AppHandle) -> Result<(), AppError> {
        automation_runtime(&app)?.slack_disconnect().map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_google_status(
        app: tauri::AppHandle,
    ) -> Result<crate::automation_google::GoogleStatusView, AppError> {
        Ok(automation_runtime(&app)?.google_status())
    }

    /// Resolves once the browser sign-in finishes, is cancelled, or times out.
    #[tauri::command]
    pub async fn automation_google_connect(
        app: tauri::AppHandle,
    ) -> Result<crate::automation_google::GoogleStatusView, AppError> {
        automation_runtime(&app)?.google_connect().await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_google_cancel_connect(app: tauri::AppHandle) -> Result<(), AppError> {
        automation_runtime(&app)?.google_cancel_connect();
        Ok(())
    }

    #[tauri::command]
    pub async fn automation_google_disconnect(app: tauri::AppHandle) -> Result<(), AppError> {
        automation_runtime(&app)?.google_disconnect().await.map_err(crate::error::other)
    }

    // ── Notion (plans/ticket-sources, task "Ticket Sources 03") ──────────────────

    fn notion_host(app: &tauri::AppHandle) -> Result<tauri::State<'_, crate::notion_host::NotionHost>, AppError> {
        use tauri::Manager;
        app.try_state::<crate::notion_host::NotionHost>()
            .ok_or_else(|| crate::error::other("Notion is unavailable this session; see the Lotus log"))
    }

    #[tauri::command]
    pub async fn notion_status(app: tauri::AppHandle) -> Result<crate::notion_host::NotionStatusView, AppError> {
        Ok(notion_host(&app)?.status())
    }

    /// Checks the pasted token with Notion and keeps it only if Notion accepted it.
    #[tauri::command]
    pub async fn notion_connect(
        app: tauri::AppHandle,
        token: String,
    ) -> Result<crate::notion_host::NotionStatusView, AppError> {
        notion_host(&app)?.connect(&app, &token).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn notion_disconnect(app: tauri::AppHandle) -> Result<(), AppError> {
        notion_host(&app)?.disconnect(&app).map_err(crate::error::other)
    }

    /// Databases the connected token can see, for "Add a Notion database".
    #[tauri::command]
    pub async fn notion_search_data_sources(
        app: tauri::AppHandle,
        query: String,
    ) -> Result<Vec<lotus_automation::notion::schema::DataSourceSummary>, AppError> {
        notion_host(&app)?.search(&query).await.map_err(crate::error::other)
    }

    /// A database's fields, and which of them Lotus would read as a ticket's.
    #[tauri::command]
    pub async fn notion_describe_data_source(
        app: tauri::AppHandle,
        data_source_id: String,
    ) -> Result<crate::notion_host::DescribedSource, AppError> {
        notion_host(&app)?.describe(&data_source_id).await.map_err(crate::error::other)
    }

    /// Syncs a Notion ticket source: its rows (the last good copy when Notion cannot be read) and its health.
    #[tauri::command]
    pub async fn notion_read_source(
        app: tauri::AppHandle,
        source_id: String,
        data_source_id: String,
        mapping: lotus_automation::notion::schema::FieldMapping,
        full: Option<bool>,
    ) -> Result<crate::notion_host::SourceSync, AppError> {
        notion_host(&app)?
            .sync_source(&source_id, &data_source_id, &mapping, full.unwrap_or(false))
            .await
            .map_err(crate::error::other)
    }

    /// Changes one field of a Notion ticket. Refused unless the source is set to Manage.
    #[tauri::command]
    pub async fn notion_write_ticket(
        app: tauri::AppHandle,
        source_id: String,
        change: lotus_automation::notion::write::TicketChange,
        seen: lotus_automation::notion::rows::NotionRow,
    ) -> Result<lotus_automation::notion::write::WriteOutcome, AppError> {
        notion_host(&app)?.write_ticket(&source_id, change, seen).await.map_err(crate::error::other)
    }

    /// Moves a Notion ticket to trash (`trash: true`) or back. Refused unless the source is Manage.
    #[tauri::command]
    pub async fn notion_trash_ticket(
        app: tauri::AppHandle,
        source_id: String,
        page_id: String,
        trash: bool,
    ) -> Result<lotus_automation::notion::write::WriteOutcome, AppError> {
        notion_host(&app)?.trash_ticket(&source_id, &page_id, trash).await.map_err(crate::error::other)
    }

    /// Creates a Notion ticket, or a sub-ticket of `parent`. Refused unless the source is Manage.
    #[tauri::command]
    pub async fn notion_create_ticket(
        app: tauri::AppHandle,
        source_id: String,
        title: String,
        parent: Option<String>,
    ) -> Result<lotus_automation::notion::write::WriteOutcome, AppError> {
        notion_host(&app)?.create_ticket(&source_id, &title, parent.as_deref()).await.map_err(crate::error::other)
    }

    /// Saves an edited Notion page body as small search-and-replace pieces. Manage only.
    #[tauri::command]
    pub async fn notion_write_body(
        app: tauri::AppHandle,
        source_id: String,
        page_id: String,
        seen: String,
        markdown: String,
    ) -> Result<lotus_automation::notion::body::BodyOutcome, AppError> {
        notion_host(&app)?.write_body(&source_id, &page_id, &seen, &markdown).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn notion_forget_source(app: tauri::AppHandle, source_id: String) -> Result<(), AppError> {
        notion_host(&app)?.forget_source(&source_id).map_err(crate::error::other)
    }

    /// A Notion ticket's page body, as Notion's markdown.
    #[tauri::command]
    pub async fn notion_page_markdown(
        app: tauri::AppHandle,
        page_id: String,
    ) -> Result<lotus_automation::notion::api::PageMarkdown, AppError> {
        notion_host(&app)?.page_markdown(&page_id).await.map_err(crate::error::other)
    }

    /// A Notion ticket for a Factory Run: title, link, every property and the body. Read only.
    #[tauri::command]
    pub async fn notion_ticket_text(app: tauri::AppHandle, page_id: String) -> Result<crate::notion_host::NotionTicketText, AppError> {
        notion_host(&app)?.ticket_text(&page_id).await.map_err(crate::error::other)
    }

    /// When a Notion page was last edited, read just before its body on a pull into a vault note.
    #[tauri::command]
    pub async fn notion_page_edited_time(app: tauri::AppHandle, page_id: String) -> Result<String, AppError> {
        notion_host(&app)?.page_edited_time(&page_id).await.map_err(crate::error::other)
    }

    // ── GitHub Issues ticket source (ADR-0048, plans/github-issues-source slice 02) ─────

    fn github_issues_host(app: &tauri::AppHandle) -> Result<tauri::State<'_, crate::github_issues_host::GitHubIssuesHost>, AppError> {
        use tauri::Manager;
        app.try_state::<crate::github_issues_host::GitHubIssuesHost>()
            .ok_or_else(|| crate::error::other("GitHub Issues is unavailable this session; see the Lotus log"))
    }

    /// Syncs a GitHub Issues source: its issues (the last good copy when GitHub cannot be read) and
    /// its health. The account and repo come from settings, never from here.
    #[tauri::command]
    pub async fn github_issues_sync_source(
        app: tauri::AppHandle,
        source_id: String,
        full: Option<bool>,
    ) -> Result<crate::github_issues_host::IssueSourceSync, AppError> {
        github_issues_host(&app)?.sync_source(&source_id, full.unwrap_or(false)).await.map_err(crate::error::other)
    }

    /// One issue of a GitHub source and its comments, for its panel.
    #[tauri::command]
    pub async fn github_issues_read_issue(
        app: tauri::AppHandle,
        source_id: String,
        number: u64,
    ) -> Result<crate::github_issues_host::IssueDetail, AppError> {
        github_issues_host(&app)?.read_issue(&source_id, number).await.map_err(crate::error::other)
    }

    /// Repos a gh account can see, for "Add a GitHub repo".
    #[tauri::command]
    pub async fn github_issues_list_repos(
        app: tauri::AppHandle,
        account: String,
    ) -> Result<Vec<lotus_automation::github_issues::RepoSummary>, AppError> {
        github_issues_host(&app)?.repos(&account).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn github_issues_forget_source(app: tauri::AppHandle, source_id: String) -> Result<(), AppError> {
        github_issues_host(&app)?.forget_source(&source_id).map_err(crate::error::other)
    }

    /// Google's Picker in the browser; resolves with the chosen sheet or folder (`kind`: sheet | folder).
    #[tauri::command]
    pub async fn automation_google_pick(
        app: tauri::AppHandle,
        kind: String,
    ) -> Result<crate::automation_google::PickedView, AppError> {
        automation_runtime(&app)?.google_pick(&kind).await.map_err(crate::error::other)
    }

    /// Sends a result's failed Sheet/Drive writes again (never the agent); returns where they went.
    #[tauri::command]
    pub async fn automation_google_resend(app: tauri::AppHandle, draft_id: String) -> Result<serde_json::Value, AppError> {
        automation_runtime(&app)?.google_resend(&draft_id).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_channels(
        app: tauri::AppHandle,
    ) -> Result<Vec<lotus_automation::slack::web::SlackChannel>, AppError> {
        automation_runtime(&app)?.slack_channels().await.map_err(crate::error::other)
    }

    /// Slack user id → display name, for the ids Slack knows (who asked for each review).
    #[tauri::command]
    pub async fn automation_slack_user_names(
        app: tauri::AppHandle,
        ids: Vec<String>,
    ) -> Result<std::collections::HashMap<String, String>, AppError> {
        automation_runtime(&app)?.slack_user_names(ids).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_usergroups(
        app: tauri::AppHandle,
    ) -> Result<Vec<lotus_automation::slack::web::SlackUserGroup>, AppError> {
        automation_runtime(&app)?.slack_usergroups().await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_slack_manifest() -> Result<String, AppError> {
        Ok(lotus_automation::slack::MANIFEST.to_string())
    }

    #[tauri::command]
    pub async fn automation_set_slack_trigger(
        app: tauri::AppHandle,
        automation_id: String,
        channels: Vec<String>,
        team: Option<String>,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        automation_runtime(&app)?.set_slack_trigger(&automation_id, channels, team).map_err(crate::error::other)
    }

    /// `settings`: the source's settings to turn it on, `null` to turn it off.
    #[tauri::command]
    pub async fn automation_set_request_source(
        app: tauri::AppHandle,
        automation_id: String,
        source: String,
        settings: Option<serde_json::Value>,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        automation_runtime(&app)?.set_request_source(&automation_id, &source, settings).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_create_agent_prompt(
        app: tauri::AppHandle,
        mut form: serde_json::Value,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        let runtime = automation_runtime(&app)?;
        runtime.google_prepare_form("agent_prompt", &mut form).await.map_err(crate::error::other)?;
        let form = serde_json::from_value(form).map_err(|e| crate::error::other(format!("form: {e}")))?;
        runtime.create_agent_prompt(form).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_pane_opened(
        app: tauri::AppHandle,
        token: String,
        cwd: String,
        workspace_id: String,
    ) -> Result<(), AppError> {
        automation_runtime(&app)?.pane_opened(&token, &cwd, &workspace_id).map_err(crate::error::other)
    }

    /// Where the checkout of `repo` is among these workspaces (a root, or a folder directly
    /// inside one, the `preferred` workspace first), so a review's pane opens there. Null: nowhere.
    /// `namesake`: also the one checkout of a same-named repo under another owner (a fork), for
    /// delegating an issue to an agent only; Factory leaves it off because it pushes.
    #[tauri::command]
    pub async fn automation_find_checkout(
        repo: String,
        workspaces: Vec<crate::automation_host::WorkspaceFolder>,
        preferred: Option<String>,
        namesake: Option<bool>,
    ) -> Option<lotus_automation::checkout::Found> {
        let namesake = namesake.unwrap_or(false);
        tokio::task::spawn_blocking(move || {
            crate::automation_host::find_checkout(&repo, workspaces, preferred.as_deref(), namesake)
        })
            .await
            .ok()
            .flatten()
    }

    /// The sub-repos of a Factory Workspace: the names of the git folders one level down
    /// (no dot-folders, no `node_modules`), sorted.
    #[tauri::command]
    pub async fn factory_git_subfolders(folder: String) -> Vec<String> {
        // The runner's own `sub_repos`: the frontend and the run agree on what a sub-repo is.
        tokio::task::spawn_blocking(move || lotus_graph_run::factory::sub_repos(std::path::Path::new(&folder)))
            .await
            .unwrap_or_default()
    }

    /// The window's local workspaces, so a run in a project works in its folder (or checkout)
    /// without a pane. Sent whenever the rail changes; each call replaces the last.
    #[tauri::command]
    pub async fn automation_set_workspaces(
        app: tauri::AppHandle,
        workspaces: Vec<crate::automation_host::WorkspaceFolder>,
    ) -> Result<(), AppError> {
        automation_runtime(&app)?.set_workspaces(workspaces);
        Ok(())
    }

    /// What a recent run has done so far; later steps arrive as `automation://step`.
    #[tauri::command]
    pub async fn automation_run_steps(
        app: tauri::AppHandle,
        run_id: String,
    ) -> Result<Vec<lotus_automation::activity::Step>, AppError> {
        Ok(automation_runtime(&app)?.run_steps(&run_id))
    }

    /// How many review worktrees are on disk, and their size (ADR-0052 §2).
    #[tauri::command]
    pub async fn automation_review_worktrees(app: tauri::AppHandle) -> Result<crate::automation_host::ReviewWorktreesView, AppError> {
        Ok(automation_runtime(&app)?.review_worktrees())
    }

    #[tauri::command]
    pub async fn automation_pane_failed(app: tauri::AppHandle, token: String, reason: String) -> Result<(), AppError> {
        automation_runtime(&app)?.pane_failed(&token, &reason).map_err(crate::error::other)
    }

    /// A run's conversation as a chat thread (the agent's transcript, read by run id only).
    #[tauri::command]
    pub async fn automation_run_conversation(
        app: tauri::AppHandle,
        run_id: String,
    ) -> Result<crate::automation_host::RunConversationView, AppError> {
        automation_runtime(&app)?.run_conversation(&run_id).map_err(crate::error::other)
    }

    /// The user's message to a run's agent (a click on Send); returns the run that answers it.
    #[tauri::command]
    pub async fn automation_send_message(
        app: tauri::AppHandle,
        run_id: String,
        text: String,
        key: String,
    ) -> Result<String, AppError> {
        automation_runtime(&app)?.send_message(&run_id, &text, &key).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_list_sent_reviews(
        app: tauri::AppHandle,
        limit: Option<usize>,
    ) -> Result<Vec<lotus_automation::views::DraftView>, AppError> {
        automation_runtime(&app)?.list_sent_reviews(limit.unwrap_or(20)).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_review_room(app: tauri::AppHandle, automation_id: String, url: String)
        -> Result<crate::automation_host::ReviewRoomView, AppError> {
        automation_runtime(&app)?.review_room(&automation_id, &url).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_list_results(
        app: tauri::AppHandle,
        limit: Option<usize>,
    ) -> Result<Vec<lotus_automation::views::DraftView>, AppError> {
        automation_runtime(&app)?.list_results(limit.unwrap_or(30)).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_preview_result(app: tauri::AppHandle, draft_id: String, text: String) -> Result<String, AppError> {
        automation_runtime(&app)?.preview_result(&draft_id, &text).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_send_result(
        app: tauri::AppHandle,
        draft_id: String,
        text: Option<String>,
    ) -> Result<(), AppError> {
        automation_runtime(&app)?.send_result(&draft_id, text).await.map_err(crate::error::other)
    }

    /// Answers an Automation Ask (a click, ADR-0040) and starts its Follow-up Run.
    #[tauri::command]
    pub async fn automation_answer_ask(
        app: tauri::AppHandle,
        ask_id: String,
        choice: Option<String>,
        note: String,
    ) -> Result<String, AppError> {
        automation_runtime(&app)?.answer_ask(&ask_id, choice.as_deref(), &note).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_list_answered_asks(
        app: tauri::AppHandle,
        limit: Option<usize>,
    ) -> Result<Vec<lotus_automation::views::DraftView>, AppError> {
        automation_runtime(&app)?.list_answered_asks(limit.unwrap_or(20)).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_discard_draft(
        app: tauri::AppHandle,
        draft_id: String,
        reason: Option<String>,
    ) -> Result<(), AppError> {
        automation_runtime(&app)?.discard_draft(&draft_id, reason.as_deref()).await.map_err(crate::error::other)
    }

    /// "Send all": every pending review of the Slack thread `draft_id` was asked in goes to
    /// GitHub, then the thread gets one message (ADR-0052 §8).
    #[tauri::command]
    pub async fn automation_send_all(
        app: tauri::AppHandle,
        draft_id: String,
        reply_in_thread: Option<bool>,
        close_threads: Option<bool>,
        slack_text: Option<String>,
    ) -> Result<Vec<(String, crate::automation_host::SendView)>, AppError> {
        automation_runtime(&app)?
            .send_all(draft_id, reply_in_thread.unwrap_or(true), close_threads.unwrap_or(true), slack_text)
            .await.map_err(crate::error::other)
    }

    /// What a draft's Slack thread will be told if it is sent now (`all`: with Send all).
    #[tauri::command]
    pub async fn automation_slack_preview(
        app: tauri::AppHandle,
        draft_id: String,
        all: Option<bool>,
    ) -> Result<lotus_automation::pr_review::slack_reply::Preview, AppError> {
        automation_runtime(&app)?.slack_preview(&draft_id, all.unwrap_or(false)).map_err(crate::error::other)
    }

    /// Posts the Slack reply a sent review holds, without waiting for the rest of its thread.
    #[tauri::command]
    pub async fn automation_reply_now(app: tauri::AppHandle, draft_id: String) -> Result<String, AppError> {
        Ok(automation_runtime(&app)?.reply_now(&draft_id).await)
    }

    /// The user's switch for an automation. MCP has no equivalent on purpose:
    /// an agent can propose an automation but never turn it on.
    #[tauri::command]
    pub async fn automation_set_enabled(
        app: tauri::AppHandle,
        automation_id: String,
        enabled: bool,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        automation_runtime(&app)?.set_enabled(&automation_id, enabled).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_run_scheduled_now(
        app: tauri::AppHandle,
        automation_id: String,
    ) -> Result<crate::automation_host::RunNowView, AppError> {
        automation_runtime(&app)?.run_scheduled_now(&automation_id).await.map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_update_prompt(
        app: tauri::AppHandle,
        automation_id: String,
        text: String,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        automation_runtime(&app)?.update_prompt(&automation_id, &text).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_update_agent(
        app: tauri::AppHandle,
        automation_id: String,
        agent: String,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        automation_runtime(&app)?.update_agent(&automation_id, &agent).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_edit(
        app: tauri::AppHandle,
        automation_id: String,
        kind: String,
        mut form: serde_json::Value,
    ) -> Result<lotus_automation::views::AutomationView, AppError> {
        let runtime = automation_runtime(&app)?;
        runtime.google_prepare_form(&kind, &mut form).await.map_err(crate::error::other)?;
        runtime.edit(&automation_id, kind, form).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn automation_delete(app: tauri::AppHandle, automation_id: String) -> Result<bool, AppError> {
        automation_runtime(&app)?.delete_automation(&automation_id).map_err(crate::error::other)
    }

    #[tauri::command]
    pub async fn vault_list_tickets(
        vault_path: String,
    ) -> Result<Vec<crate::vault_tickets::VaultTicket>, AppError> {
        crate::vault_tickets::list_tickets(std::path::Path::new(&vault_path))
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Watch an Editor pane's folder while it is on screen; changes arrive as
    /// `editor://fs-changed` with this `watch_id`. Off the async runtime: a recursive watch walks
    /// the tree on Linux.
    #[tauri::command]
    pub async fn editor_watch_root(app: tauri::AppHandle, watch_id: String, root: String) -> Result<(), AppError> {
        tauri::async_runtime::spawn_blocking(move || crate::editor_watcher::watch_root(app, &watch_id, &root))
            .await
            .map_err(|err| AppError::Other(format!("watch task crashed: {err}")))?
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Git graph (GLOSSARY "Source control"): read-only history of one local repository.
    #[tauri::command]
    pub async fn git_graph_refs(repo_root: String) -> Result<crate::git_graph::GraphRefs, AppError> {
        blocking(move || crate::git_graph::git_graph_refs(repo_root)).await
    }

    #[tauri::command]
    pub async fn git_graph_log(
        repo_root: String,
        revs: Vec<String>,
        skip: u32,
        limit: u32,
    ) -> Result<Vec<crate::git_graph::GraphCommit>, AppError> {
        blocking(move || crate::git_graph::git_graph_log(repo_root, revs, skip, limit)).await
    }

    #[tauri::command]
    pub async fn git_graph_search(
        repo_root: String,
        revs: Vec<String>,
        query: String,
        limit: u32,
    ) -> Result<Vec<crate::git_graph::GraphCommit>, AppError> {
        blocking(move || crate::git_graph::git_graph_search(repo_root, revs, query, limit)).await
    }

    #[tauri::command]
    pub async fn git_graph_commit(repo_root: String, sha: String) -> Result<crate::git_graph::CommitDetail, AppError> {
        blocking(move || crate::git_graph::git_graph_commit(repo_root, sha)).await
    }

    #[tauri::command]
    #[allow(clippy::too_many_arguments)]
    pub async fn git_graph_file_pair(
        repo_root: String,
        sha: String,
        parent: Option<String>,
        path: String,
        old_path: Option<String>,
        status: String,
        allow_large: bool,
    ) -> Result<crate::git_graph::CommitFilePair, AppError> {
        blocking(move || crate::git_graph::git_graph_file_pair(repo_root, sha, parent, path, old_path, status, allow_large)).await
    }

    /// Changes arrive as `git-graph://refs-moved` with this `watch_id`.
    #[tauri::command]
    pub async fn git_graph_watch(app: tauri::AppHandle, watch_id: String, repo_root: String) -> Result<(), AppError> {
        blocking(move || crate::git_graph::watch::watch(app, &watch_id, &repo_root)).await
    }

    #[tauri::command]
    pub async fn git_graph_unwatch(watch_id: String) -> Result<(), AppError> {
        blocking(move || {
            crate::git_graph::watch::unwatch(&watch_id);
            Ok(())
        })
        .await
    }

    /// git is a process per call: off the async runtime, so a slow repo never stalls other commands.
    async fn blocking<T: Send + 'static>(
        work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        tauri::async_runtime::spawn_blocking(work)
            .await
            .map_err(|err| AppError::Other(format!("git graph task crashed: {err}")))?
    }

    /// Stop one watch: its pane went off screen, moved to SSH, or closed.
    #[tauri::command]
    pub async fn editor_unwatch(watch_id: String) -> Result<(), AppError> {
        tauri::async_runtime::spawn_blocking(move || crate::editor_watcher::unwatch(&watch_id))
            .await
            .map_err(|err| AppError::Other(format!("unwatch task crashed: {err}")))
    }

    /// One ticket with its prose. `None` when that file is not a ticket — which includes a
    /// `file` that tries to climb out of the vault's `tickets/` directory.
    /// Start watching a vault for changes, or stop when `vaultPath` is empty.
    ///
    /// Needed because `obsidian-git` rewrites ticket files with nobody at the keyboard — it pulls
    /// on boot and pushes every ten minutes — so a list that only refreshed on a button press
    /// would be quietly wrong.
    #[tauri::command]
    pub async fn vault_watch(app: tauri::AppHandle, vault_path: String) -> Result<(), AppError> {
        crate::vault_watcher::set_watched_vault(app, &vault_path)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Edit one ticket: status, title, or the body of named sections. Refused as a `conflict` —
    /// nothing written, the current ticket handed back — when the file is no longer the revision
    /// the edit was made against. `today` comes from the webview so `updated:` is the person's
    /// local date, not UTC's.
    #[tauri::command]
    pub async fn vault_edit_ticket(
        vault_path: String,
        file: String,
        base_revision: String,
        today: String,
        edits: crate::vault_ticket_edit::TicketEdits,
    ) -> Result<crate::vault_ticket_edit::EditOutcome, AppError> {
        crate::vault_ticket_edit::edit_ticket(
            std::path::Path::new(&vault_path),
            &file,
            &base_revision,
            &today,
            &edits,
        )
        .map_err(|e| crate::error::other(e.to_string()))
    }

    #[tauri::command]
    pub async fn vault_get_ticket(
        vault_path: String,
        file: String,
    ) -> Result<Option<crate::vault_tickets::VaultTicketDetail>, AppError> {
        crate::vault_tickets::get_ticket(std::path::Path::new(&vault_path), &file)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    #[tauri::command]
    pub async fn bridge_get_task(
        workspace_id: String,
        task_id: String,
    ) -> Result<Option<crate::bridge_tasks::BridgeTask>, AppError> {
        crate::bridge_tasks::get_task(&workspace_id, &task_id)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    #[tauri::command]
    pub async fn bridge_delete_task(workspace_id: String, task_id: String) -> Result<(), AppError> {
        crate::bridge_tasks::delete_task(&workspace_id, &task_id)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Task files that no open workspace owns — the frontend passes the open ids because the
    /// open set is what the rail shows, not a table Rust can read.
    #[tauri::command]
    pub async fn bridge_list_orphan_task_files(
        open_workspace_ids: Vec<String>,
    ) -> Result<Vec<crate::bridge_tasks::OrphanTaskFile>, AppError> {
        crate::bridge_tasks::list_orphan_task_files(&open_workspace_ids)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    #[tauri::command]
    pub async fn bridge_move_workspace_tasks(
        from_workspace_id: String,
        to_workspace_id: String,
    ) -> Result<crate::bridge_tasks::MovedTasks, AppError> {
        crate::bridge_tasks::move_workspace_tasks(&from_workspace_id, &to_workspace_id)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Hide a closed workspace's tasks from the list, or show them again. The file is untouched.
    #[tauri::command]
    pub async fn bridge_set_orphan_task_file_ignored(
        workspace_id: String,
        ignored: bool,
    ) -> Result<(), AppError> {
        crate::bridge_tasks::set_orphan_ignored(&workspace_id, ignored)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    /// Retire a closed workspace's task file; refused for any id in `open_workspace_ids`.
    #[tauri::command]
    pub async fn bridge_delete_orphan_task_file(
        workspace_id: String,
        open_workspace_ids: Vec<String>,
    ) -> Result<(), AppError> {
        crate::bridge_tasks::delete_orphan_task_file(&workspace_id, &open_workspace_ids)
            .map_err(|e| crate::error::other(e.to_string()))
    }

    // ── Embedded Telegram bot ────────────────────────────────────────────────
    //
    // These commands drive the supervisor that owns the `lotus-remote`
    // subprocess. Lifecycle is auto-managed at app start/exit; these expose
    // it for the settings UI.
    use crate::host_runtime::config::HostRuntimeConfig;
    use crate::host_runtime::integration::HostRuntimeIntegration;
    use crate::host_runtime::supervisor::HostRuntimeStatus;

    type HostRuntimeState<'a> = State<'a, std::sync::Arc<HostRuntimeIntegration>>;

    fn map_io<T>(r: std::io::Result<T>) -> Result<T, String> {
        r.map_err(|e| e.to_string())
    }

    /// Addresses this machine can bind for mobile access, each labelled by who
    /// can reach it. The Settings picker offers only these, so `0.0.0.0` and a
    /// mistyped address never become choices.
    #[tauri::command]
    pub fn host_runtime_bind_candidates() -> Vec<crate::host_runtime::interfaces::BindCandidate> {
        crate::host_runtime::interfaces::enumerate()
    }

    #[tauri::command]
    pub fn host_runtime_status(state: HostRuntimeState<'_>) -> HostRuntimeStatus {
        state.status()
    }

    /// Whether idle sleep is currently held off on this machine.
    ///
    /// Separate from `host_runtime_status` rather than a field on it: that enum answers
    /// "is the child alive", and a sleep hold is a property of the *machine*, which
    /// outlives any one child. Folding them would make both harder to read.
    #[tauri::command]
    pub fn host_runtime_sleep_hold(
        state: HostRuntimeState<'_>,
    ) -> crate::host_runtime::keep_awake::SleepHoldState {
        state.sleep_hold()
    }

    /// Mint a single-use pairing code for the operator to scan or type.
    ///
    /// Rust does not mint it: the code lives in the host's `PairingService`
    /// alongside the device store, and Rust deliberately holds no device
    /// credentials (ADR-5). This forwards over the loopback admin channel.
    #[tauri::command]
    pub fn host_runtime_create_pairing_code(
        state: HostRuntimeState<'_>,
    ) -> Result<serde_json::Value, String> {
        state.create_pairing_code().map_err(|e| e.to_string())
    }

    /// Paired devices, never their tokens. Returns `NotAdvertised` as an error
    /// when the host is not running, which the UI should read as "start it first".
    #[tauri::command]
    pub fn host_runtime_list_devices(
        state: HostRuntimeState<'_>,
    ) -> Result<serde_json::Value, String> {
        state.list_devices().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn host_runtime_revoke_device(
        state: HostRuntimeState<'_>,
        device_id: String,
    ) -> Result<serde_json::Value, String> {
        state.revoke_device(&device_id).map_err(|e| e.to_string())
    }

    /// Whether the façade is bound, and to what. A loopback bind looks healthy
    /// but no phone can reach it, so the UI needs the address, not just a flag.
    #[tauri::command]
    pub fn host_runtime_admin_health(
        state: HostRuntimeState<'_>,
    ) -> Result<serde_json::Value, String> {
        state.admin_health().map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn host_runtime_get_config(state: HostRuntimeState<'_>) -> HostRuntimeConfig {
        state.get_config()
    }

    /// Persist a new config. Does NOT auto-apply (re-spawn / kill) — the
    /// frontend should call `host_runtime_apply` after save when the user wants the
    /// change to take effect immediately.
    #[tauri::command]
    pub fn host_runtime_save_config(
        state: HostRuntimeState<'_>,
        config: HostRuntimeConfig,
    ) -> Result<(), String> {
        map_io(state.save_config(&config))
    }

    /// Reconcile runtime state with on-disk config: spawns if `enabled`,
    /// kills if disabled. Used by settings UI's "Restart" / "Apply now".
    #[tauri::command]
    pub fn host_runtime_apply(state: HostRuntimeState<'_>) -> Result<HostRuntimeStatus, String> {
        map_io(state.apply())
    }

    #[tauri::command]
    pub fn host_runtime_stop(state: HostRuntimeState<'_>) -> Result<(), String> {
        map_io(state.stop())
    }

    // ── Model registry ────────────────────────────────────────────────────────
    use crate::model_registry::{self, ProviderConfig as RegistryProvider};

    #[tauri::command]
    pub fn registry_list_providers() -> Vec<RegistryProvider> {
        model_registry::cmd_list_providers()
    }

    #[tauri::command]
    pub fn registry_get_provider(id: String) -> Option<RegistryProvider> {
        model_registry::cmd_get_provider(&id)
    }

    #[tauri::command]
    pub fn registry_upsert_provider(provider: RegistryProvider) -> Result<(), String> {
        model_registry::cmd_upsert_provider(provider)
    }

    #[tauri::command]
    pub fn registry_delete_provider(id: String) -> Result<(), String> {
        model_registry::cmd_delete_provider(&id)
    }

    #[tauri::command]
    pub fn registry_get_active_model() -> serde_json::Value {
        model_registry::cmd_get_active_model()
    }

    #[tauri::command]
    pub fn registry_set_active_model(provider: String, model: String) -> Result<(), String> {
        model_registry::cmd_set_active_model(&provider, &model)
    }

    // ── TTS providers (CodeCanvas voice feedback — BYOK) ────────────────────────
    use crate::tts_providers::{
        self, TtsProviderConfig as TtsProvider, TtsProviderRegistry as TtsRegistry,
        TtsSynthesisResult, VoiceOutputSettings,
    };
    use crate::tts_runtime::{run_cancellable, TtsRuntime};

    #[tauri::command]
    pub fn tts_list_providers() -> TtsRegistry {
        tts_providers::cmd_list_providers()
    }

    #[tauri::command]
    pub fn tts_get_provider(id: String) -> Option<TtsProvider> {
        tts_providers::cmd_get_provider(&id)
    }

    #[tauri::command]
    pub fn tts_upsert_provider(provider: TtsProvider) -> Result<(), String> {
        tts_providers::cmd_upsert_provider(provider)
    }

    #[tauri::command]
    pub fn tts_delete_provider(id: String) -> Result<(), String> {
        tts_providers::cmd_delete_provider(&id)
    }

    #[tauri::command]
    pub fn tts_set_active_provider(id: String) -> Result<(), String> {
        tts_providers::cmd_set_active_provider(&id)
    }

    #[tauri::command]
    pub fn tts_set_output(output: VoiceOutputSettings) -> Result<(), String> {
        tts_providers::cmd_set_output(output)
    }

    #[tauri::command]
    pub async fn tts_synthesize(
        request_id: String,
        provider_id: String,
        text: String,
        voice: Option<String>,
        speed: Option<f32>,
        runtime: State<'_, TtsRuntime>,
    ) -> Result<TtsSynthesisResult, AppError> {
        let request = runtime.register(&request_id)?;
        run_cancellable(
            request,
            tts_providers::cmd_synthesize(runtime.client(), &provider_id, &text, voice, speed),
        )
        .await
    }

    #[tauri::command]
    pub fn tts_cancel_synthesis(request_id: String, runtime: State<'_, TtsRuntime>) {
        runtime.cancel(&request_id);
    }

    // ── STT providers (CodeCanvas voice input — BYOK) ───────────────────────────
    use crate::stt_providers::{
        self, SttProviderConfig as SttProvider, SttProviderRegistry as SttRegistry,
        SttTranscriptResult,
    };

    #[tauri::command]
    pub fn stt_list_providers() -> SttRegistry {
        stt_providers::cmd_list_providers()
    }

    #[tauri::command]
    pub fn stt_get_provider(id: String) -> Option<SttProvider> {
        stt_providers::cmd_get_provider(&id)
    }

    #[tauri::command]
    pub fn stt_upsert_provider(provider: SttProvider) -> Result<(), String> {
        stt_providers::cmd_upsert_provider(provider)
    }

    #[tauri::command]
    pub fn stt_delete_provider(id: String) -> Result<(), String> {
        stt_providers::cmd_delete_provider(&id)
    }

    #[tauri::command]
    pub fn stt_set_active_provider(id: String) -> Result<(), String> {
        stt_providers::cmd_set_active_provider(&id)
    }

    // ── Voice-to-Voice (S2S) providers (opt-in duplex mode — BYOK) ──────────────
    use crate::s2s_providers::{
        self, S2sProviderConfig as S2sProvider, S2sProviderRegistry as S2sRegistry,
    };

    #[tauri::command]
    pub fn s2s_list_providers() -> S2sRegistry {
        s2s_providers::cmd_list_providers()
    }

    #[tauri::command]
    pub fn s2s_get_provider(id: String) -> Option<S2sProvider> {
        s2s_providers::cmd_get_provider(&id)
    }

    #[tauri::command]
    pub fn s2s_upsert_provider(provider: S2sProvider) -> Result<(), String> {
        s2s_providers::cmd_upsert_provider(provider)
    }

    #[tauri::command]
    pub fn s2s_delete_provider(id: String) -> Result<(), String> {
        s2s_providers::cmd_delete_provider(&id)
    }

    #[tauri::command]
    pub fn s2s_set_active_provider(id: String) -> Result<(), String> {
        s2s_providers::cmd_set_active_provider(&id)
    }

    /// Async so the blocking HTTP call runs off the main thread — a slow provider must not freeze the UI.
    #[tauri::command]
    pub async fn stt_transcribe(
        provider_id: String,
        audio_base64: String,
        mime: String,
        context: Option<stt_providers::SttDecoderContext>,
    ) -> Result<SttTranscriptResult, AppError> {
        stt_providers::cmd_transcribe_off_main(provider_id, audio_base64, mime, context).await
    }

    /// Open a streaming (Deepgram realtime) STT session; partial + final transcripts arrive on `on_event`.
    #[tauri::command]
    pub async fn stt_stream_start(
        provider_id: String,
        on_event: Channel<crate::stt_stream::StreamEvent>,
    ) -> Result<String, AppError> {
        crate::stt_stream::cmd_start(&provider_id, on_event).await
    }

    /// Forward one base64 audio chunk to an open streaming STT session.
    #[tauri::command]
    pub fn stt_stream_send(session_id: String, audio_base64: String) -> Result<(), AppError> {
        crate::stt_stream::cmd_send(&session_id, &audio_base64)
    }

    /// Flush an open streaming STT session and await its final transcripts.
    #[tauri::command]
    pub fn stt_stream_finish(session_id: String) -> Result<(), AppError> {
        crate::stt_stream::cmd_finish(&session_id)
    }

    /// Abort an open streaming STT session without waiting for finals.
    #[tauri::command]
    pub fn stt_stream_cancel(session_id: String) -> Result<(), AppError> {
        crate::stt_stream::cmd_cancel(&session_id)
    }

    // ── Voice-to-Voice (S2S) duplex stream (opt-in — BYOK realtime WebSocket) ────

    /// Open a duplex voice-to-voice session; audio deltas + turn events arrive on `on_event`.
    #[tauri::command]
    pub async fn s2s_stream_start(
        provider_id: String,
        instructions: Option<String>,
        tools: Option<String>,
        on_event: Channel<crate::s2s_stream::S2sStreamEvent>,
    ) -> Result<String, AppError> {
        crate::s2s_stream::cmd_start(&provider_id, instructions, tools, on_event).await
    }

    /// Forward one base64 PCM16 mic chunk to an open voice-to-voice session.
    #[tauri::command]
    pub fn s2s_stream_send(session_id: String, audio_base64: String) -> Result<(), AppError> {
        crate::s2s_stream::cmd_send(&session_id, &audio_base64)
    }

    /// Barge-in: cancel the model's in-flight response so the user can interrupt.
    #[tauri::command]
    pub fn s2s_stream_interrupt(session_id: String) -> Result<(), AppError> {
        crate::s2s_stream::cmd_interrupt(&session_id)
    }

    /// Barge-in continuation: after `s2s_stream_interrupt`, tell the provider how many
    /// milliseconds of the assistant's audio the user actually heard so it can discard the
    /// un-heard tail of the transcript from context (`conversation.item.truncate`).
    #[tauri::command]
    pub fn s2s_stream_truncate(
        session_id: String,
        item_id: String,
        audio_end_ms: i64,
    ) -> Result<(), AppError> {
        crate::s2s_stream::cmd_truncate(&session_id, &item_id, audio_end_ms)
    }

    /// Snapshot sanitized queue/backpressure diagnostics for an open voice-to-voice stream.
    #[tauri::command]
    pub fn s2s_stream_diagnostics(
        session_id: String,
    ) -> Result<crate::s2s_stream::S2sStreamDiagnostics, AppError> {
        crate::s2s_stream::cmd_diagnostics(&session_id)
    }

    /// Send a realtime function-call result back to an open voice-to-voice session.
    #[tauri::command]
    pub fn s2s_stream_tool_result(
        session_id: String,
        call_id: String,
        output: String,
        continue_response: Option<bool>,
    ) -> Result<(), AppError> {
        crate::s2s_stream::cmd_tool_result(
            &session_id,
            &call_id,
            &output,
            continue_response.unwrap_or(true),
        )
    }

    /// Refresh realtime session instructions/tools without restarting mic/audio.
    #[tauri::command]
    pub fn s2s_stream_update(
        session_id: String,
        instructions: Option<String>,
        tools: Option<String>,
    ) -> Result<(), AppError> {
        crate::s2s_stream::cmd_update(&session_id, instructions, tools)
    }

    /// Close an open voice-to-voice session.
    #[tauri::command]
    pub fn s2s_stream_close(session_id: String) -> Result<(), AppError> {
        crate::s2s_stream::cmd_close(&session_id)
    }

    /// A Content-Security-Policy violation the webview reported, appended to
    /// `<lotus state dir>/csp-violations.log` and echoed to stderr. The CSP only applies to a
    /// production build (dev loads the dev server directly), so this file is how a blocked
    /// load in a release build is found. The file stops growing at 256 KB.
    #[tauri::command]
    pub fn csp_violation_log(line: String) {
        use std::io::Write;
        let line: String = line.chars().filter(|c| !c.is_control()).take(500).collect();
        eprintln!("[csp] {line}");
        let path = crate::paths::lotus_state_dir().join("csp-violations.log");
        if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
            return;
        }
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(file, "{now} {line}");
        }
    }

    /// What the bug-report dialog attaches: version, OS, the unseen crash, a redacted log tail.
    #[tauri::command]
    pub fn bug_report_context(app: tauri::AppHandle) -> crate::bug_report::BugReportContext {
        crate::bug_report::context(app.package_info().version.to_string())
    }

    #[tauri::command]
    pub fn bug_report_mark_crash_seen() -> Result<(), String> {
        crate::bug_report::mark_crash_seen()
    }

    /// Diagnostic seam: surface a renderer-side voice-to-voice log line on the same stderr the Rust
    /// transport logs to (only echoed when `LOTUS_S2S_DEBUG` is set), so playback issues that live in
    /// the webview (Audio element decode/errors) show up in the dev terminal without opening devtools.
    #[tauri::command]
    pub fn s2s_debug_log(line: String) {
        if std::env::var("LOTUS_S2S_DEBUG").is_ok_and(|v| v != "0" && !v.is_empty()) {
            eprintln!("[s2s-fe] {line}");
        }
    }

    // ── Music node (CodeCanvas YouTube player) ──────────────────────────────────
    /// Resolve title/author/thumbnail for a pasted YouTube URL via oEmbed (keyless).
    /// Lives in Rust because the oEmbed endpoint has no CORS headers.
    #[tauri::command]
    pub fn music_resolve_track(
        url: String,
    ) -> Result<crate::youtube_meta::MusicTrackMeta, AppError> {
        crate::youtube_meta::cmd_resolve_track(&url)
    }

    /// Build the local HTTP wrapper URL used by the production desktop Music node.
    /// The wrapper gives YouTube an HTTP Referer while the main app keeps Tauri IPC.
    /// `start_sec` resumes the track at a stored position (music engine, plan
    /// `plans/canvas-music-persistent-playback/PLAN.md`).
    #[tauri::command]
    pub fn music_youtube_player_url(
        state: tauri::State<'_, ApiServerEndpoint>,
        video_id: String,
        autoplay: bool,
        start_sec: Option<u32>,
    ) -> Result<String, AppError> {
        if video_id.len() != 11
            || !video_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err(AppError::Other("Invalid YouTube video id".into()));
        }
        let start = start_sec.filter(|value| *value > 0);
        Ok(format!(
            "{}/api/music/youtube-player?videoId={}&autoplay={}{}",
            state.base_url,
            video_id,
            autoplay,
            start.map(|s| format!("&start={s}")).unwrap_or_default()
        ))
    }

    /// One cancellable NL utility completion. Credentials remain in Rust.
    #[tauri::command]
    pub async fn nl_complete(
        prompt: String,
        schema: Option<serde_json::Value>,
        request_id: Option<String>,
        runtime: State<'_, crate::nl_runtime::NlRuntime>,
    ) -> Result<String, AppError> {
        let request_id = request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let request = runtime.register(&request_id)?;
        crate::nl_runtime::run_cancellable(
            request,
            crate::nl_model::cmd_complete(runtime.client(), prompt, schema),
        ).await
    }

    #[tauri::command]
    pub fn nl_cancel(request_id: String, runtime: State<'_, crate::nl_runtime::NlRuntime>) {
        runtime.cancel(&request_id);
    }

    /// Read the BYOK NL model config (api key redacted).
    #[tauri::command]
    pub fn nl_model_get_config() -> crate::nl_model::NlModelConfig {
        crate::nl_model::cmd_get_config()
    }

    /// Persist the BYOK NL model config (provider/key/model/baseUrl). "***" key = keep the stored one.
    #[tauri::command]
    pub fn nl_model_set_config(config: crate::nl_model::NlModelConfig) -> Result<(), AppError> {
        crate::nl_model::cmd_set_config(config)
    }
}

/// Resolve `node` + an absolute path to the bundled Lotus MCP sidecar, so the
/// Claude CLI mcpServers entry can spawn it regardless of the app's working
/// directory or available repo-local `node_modules`. We first honour
/// `LOTUS_MCP_SERVER_PATH` for tests, then install the embedded managed copy
/// under the Lotus state directory, then probe the workspace layout as a dev
/// fallback. Returns `None` if nothing resolves.
///
/// The returned args always include `--discovery <path>` (via
/// [`mcp_config::build_lotus_sidecar_args`]) so the sidecar reads the
/// discovery file matching this Lotus instance — release: `~/.lotus/`,
/// dev: `~/.lotus-dev/`.
fn mcp_sidecar_spawn_args() -> Option<(String, Vec<String>)> {
    use std::path::PathBuf;

    if let Ok(custom) = std::env::var("LOTUS_MCP_SERVER_PATH") {
        let path = PathBuf::from(custom);
        if path.exists() {
            return Some(mcp_config::build_lotus_sidecar_args("node", &path));
        }
    }

    if let Ok(path) = mcp_config::install_lotus_mcp_server_script() {
        return Some(mcp_config::build_lotus_sidecar_args("node", &path));
    }

    // Walk from CWD → ancestors looking for the repo bundle as a dev fallback.
    // Prefer the bundled file; the source file requires repo-local dependencies
    // and will fail when Claude starts from another project directory.
    let mut cursor = std::env::current_dir().ok()?;
    for _ in 0..6 {
        for file_name in ["lotus-mcp-server.bundle.mjs", "lotus-mcp-server.mjs"] {
            let candidate = cursor.join("scripts").join(file_name);
            if candidate.exists() {
                return Some(mcp_config::build_lotus_sidecar_args("node", &candidate));
            }
        }
        if !cursor.pop() {
            break;
        }
    }
    None
}

// ─── App entry point ──────────────────────────────────────────────────────────

pub fn run() {
    // Create PtyState before the builder so both .manage() (inside setup) and the HTTP API
    // server share the same Arc without racing the builder chain.
    let pty_state: PtyState = Arc::new(Mutex::new(pty::PtyStore::default()));
    let pty_for_api = Arc::clone(&pty_state);

    let mut builder = tauri::Builder::default();
    // Single-instance guard: a second `Lotus.app` launch would race the
    // discovery file and overwrite the running app's port/secret. The plugin
    // keeps only the first instance alive and forwards any subsequent launch
    // into the callback, where we surface the existing window.
    //
    // Only register in release. The dev profile (`tauri dev`, cargo debug)
    // uses its own bundle of state under `~/.lotus-dev/` and a separate
    // `mcpServers.lotus-dev` registration, so it must be free to run
    // alongside a bundled `Lotus.app` without being killed by this guard
    // on every Rust hot-rebuild.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            windowing::focus_or_create_window(app);
        }));
    }
    builder
        .menu(windowing::build_app_menu)
        .on_menu_event(windowing::handle_menu_event)
        // A reload discards every JS handle on this window's PTYs, and nothing re-adopts them, so
        // they would run on unseen. Reaped here rather than from a page component because only this
        // runs before any surface can spawn — the old hook lived in Code mode, so a reload into
        // Canvas never reaped. Child webviews (canvas browser, panes) share the window label:
        // their navigations must not count.
        .on_page_load(|webview, payload| {
            use tauri::Manager;
            if payload.event() != tauri::webview::PageLoadEvent::Started
                || webview.label() != webview.window().label()
            {
                return;
            }
            let mut reaped = 0;
            if let Some(state) = webview.try_state::<pty::PtyState>() {
                match pty::release_sessions_for_window(webview.label(), &state) {
                    Ok(0) => {}
                    Ok(n) => {
                        reaped = n;
                        eprintln!("[pty] page load: reaped {n} session(s) left by the previous page")
                    }
                    Err(err) => eprintln!("[pty] page load: reap failed: {err}"),
                }
            }
            session_diagnostics::main_page_load(payload.url().as_str(), reaped as u64);
        })
        .on_window_event(|window, event| {
            // Following an Ask's notification brings Lotus to the front (PLAN §8 Q10).
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                crate::automation_host::window_focused(window);
            }
            // When a window is destroyed, drop its fleet slice from the shared
            // MCP IPC state — a closed webview cannot push an empty snapshot to
            // clear itself, so without this its dead agents would linger in
            // lotus_list_fleet for the surviving windows.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                use tauri::Manager;
                crate::editor_unsaved::forget(window.label());
                crate::nav_guard::forget(window.label());
                if let Some(state) = window.try_state::<McpIpcSharedState>() {
                    state.evict_window_fleet(window.label());
                }
            }
        })
        .setup(move |app| {
            use tauri::Manager;
            bug_report::install_panic_hook(app.package_info().version.to_string());
            #[cfg(target_os = "macos")]
            macos_dock::install(app.handle().clone())?;
            #[cfg(not(target_os = "macos"))]
            let _ = app;

            // One-time relocation of legacy state (~/.claude/teams, …) into
            // ~/.lotus/. Idempotent and release-only — see migrations.rs.
            // Run before any subsystem that reads/writes Lotus state so the
            // first MCP discovery write lands in the new home.
            let _ = migrations::migrate_claude_to_lotus_release();
            settings::fold_retired_settings();

            // Session daemon (ADR-0067), default on macOS: connect (starting it) off the setup path so
            // the first terminal does not pay for it.
            #[cfg(unix)]
            if pty::sessiond_client::enabled() {
                let app = app.handle().clone();
                std::thread::spawn(move || pty::sessiond_client::warm_up(app));
            }

            // Dev builds ship as the same bundle id but use ~/.lotus-dev/ and
            // a separate `mcpServers.lotus-dev` registration. Surface the
            // distinction in the window chrome so a developer never confuses
            // the dev window with the production app side-by-side.
            if cfg!(debug_assertions) {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title("Lotus Dev");
                }
            }
            // Windows: one drawn title row instead of the native title bar + menubar. At runtime,
            // not only in tauri.windows.conf.json, because dev's --config replaces the window list.
            if let Some(win) = app.get_webview_window("main") {
                windowing::apply_windows_chrome(&win);
            }

            let _ = agent_cli::cleanup_stale_temp_dirs();
            // A Lotus that crashed or was Ctrl-C'd never ran the Exit teardown, so its panes'
            // SIGHUP-ignoring children may still be spinning. Off-thread: it samples CPU.
            #[cfg(unix)]
            std::thread::spawn(|| {
                let _ = pty::reap_stranded_orphans();
            });
            if let Err(err) = browser_helper::install_lotus_browser_helper() {
                eprintln!("[lotus-browser] helper install failed: {err}");
            }
            if let Err(err) = browser_helper::install_lotus_browser_skill() {
                eprintln!("[lotus-browser] skill install failed: {err}");
            }
            if let Err(err) = mcp_automation::install_skill() {
                eprintln!("[automation] skill install failed: {err}");
            }
            if let Err(err) = mcp_automation::install_swarm_skill() {
                eprintln!("[swarm] skill install failed: {err}");
            }
            // Cross-provider discovery: drop a managed instruction block into
            // each installed non-Claude agent's global instructions (Codex
            // AGENTS.md, Gemini GEMINI.md, Cursor rules) so they know the
            // `lotus-browser` CLI exists. Claude gets the skill above instead.
            if let Err(err) = browser_helper::install_agent_browser_instructions() {
                eprintln!("[lotus-browser] agent instruction install failed: {err}");
            }
            if let Err(err) = browser_mcp::sync_browser_mcp_entries() {
                eprintln!("[lotus-browser] Browser MCP config sync failed: {err}");
            }

            // Unlink any orphaned `~/.ssh/lotus-cm-*` ControlMaster sockets
            // left over from a previous Lotus run that crashed before
            // ControlPersist could reap them. Stale sockets cause
            // "Connection to UNKNOWN port 65535" failures on the first SSH
            // call of a new session because the slave races into a master
            // that does not exist. See `ssh_control_socket.rs`.
            let _ = ssh_control_socket::cleanup_stale_lotus_control_sockets();

            // Bridge MCP: bootstrap the localhost IPC server + advertise its
            // port/secret so the MCP sidecar (spawned by Claude CLI) can reach
            // back into us. Non-fatal on error — the desktop app still works,
            // just without cross-cell tooling for Bridge.
            // NOTE: pty_state is pre-created before the builder so the HTTP API
            // server (below) shares the same Arc.
            let state: McpIpcSharedState = Arc::new(mcp_ipc::McpIpcState::with_runtime(
                mcp_ipc::generate_secret(),
                pty_state.clone(),
            ));
            state.set_app_handle(app.handle().clone());
            app.manage(state.clone());
            // Fase 0 instrumentation (`plans/session-history-hardening/issues/01`). Started
            // before the state is handed over, because the sampler only needs a clone of the
            // Arc and starting it here keeps the whole of Fase 0's wiring in one place.
            session_diagnostics::app_started();
            session_diagnostics::spawn_pty_sampler(pty_state.clone());
            app.manage(pty_state);
            app.manage(remote_transport::RemoteTransport::new());
            std::thread::spawn(remote_transport::reap_orphans);
            let host_links = std::sync::Arc::new(remote_host_link::HostLinks::new(std::sync::Arc::new(
                remote_host_link::SshAccess::new(app.handle().clone()),
            )));
            app.manage(std::sync::Arc::clone(&host_links));
            app.manage(remote_tunnel::RemoteTunnel::new());
            app.manage(remote_capability::RemoteCapabilityStore::new());
            app.manage(terminal_file_drop::TerminalFileDropUploads::default());
            app.manage(notion_host::NotionHost::new());
            app.manage(github_issues_host::GitHubIssuesHost::new());
            app.manage(tts_runtime::TtsRuntime::new()?);
            app.manage(nl_runtime::NlRuntime::new()?);
            let chat = chat_runtime::ChatRuntime::open(&paths::lotus_state_dir().join("chat").join("chat.sqlite3"));
            chat.attach_host_links(host_links);
            // Command Rail: a thread finishing or starting moves in the rail now, not at the next poll.
            let app_for_rail = app.handle().clone();
            chat.on_rail_change(move || {
                let _ = tauri::Emitter::emit(&app_for_rail, "chat://rail-changed", ());
            });
            // An unused chat session holds a whole agent process; the next message resumes it.
            let reaper = chat.clone();
            tauri::async_runtime::spawn(async move {
                const IDLE_MS: i64 = 20 * 60 * 1000;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    reaper.reap_idle_sessions(IDLE_MS).await;
                }
            });
            // Worktrees of deleted chats whose work is already on the main branch.
            let sweeper = chat.clone();
            std::thread::spawn(move || {
                sweeper.reap_worktrees(None);
                // Pasted files of deleted chats and of drafts never sent.
                sweeper.reap_attachments(None);
            });
            app.manage(chat);
            // 07m: CodeChat's history is read-only, so bring every chat over once at start. The
            // importer skips what it already has, so this is a no-op after.
            let app_for_import = app.handle().clone();
            std::thread::spawn(move || {
                let result = codechat_database_path(&app_for_import)
                    .and_then(|path| {
                        app_for_import
                            .state::<chat_runtime::ChatRuntime>()
                            .import_codechat(&path, false)
                    });
                match result {
                    Ok(report) => eprintln!("[chat] CodeChat import at start: {} imported", report.imported),
                    Err(err) => eprintln!("[chat] CodeChat import at start failed: {err}"),
                }
            });
            let mcp_runtime = Arc::new(McpIpcRuntime::default());
            app.manage(mcp_runtime.clone());
            let app_handle_for_bootstrap = app.handle().clone();
            // Keep an Arc handle for the HTTP API state (built later) so the
            // bridge MCP fleet snapshot is reachable via /api/fleet without
            // a second IPC channel.
            let mcp_state_for_api = Arc::clone(&state);
            // Notification broadcast channel — wired into the HTTP API and the
            // agent-hooks sink.  The initial `_rx` is immediately dropped; real
            // subscribers call `.subscribe()` on the sender later.
            let (notification_tx, _notification_rx_initial) =
                tokio::sync::broadcast::channel::<notification_event::NotificationEvent>(
                    api_server::state::NOTIFICATION_CHANNEL_CAPACITY,
                );
            tauri::async_runtime::spawn(async move {
                let app = app_handle_for_bootstrap;
                match mcp_ipc::start_mcp_ipc(state.clone()).await {
                    Ok(server_handle) => {
                        let pid = std::process::id();
                        let port = server_handle.port;
                        let secret = state.secret().to_string();
                        let discovery = mcp_config::IpcDiscoveryFile {
                            version: 1,
                            port,
                            secret: secret.clone(),
                            pid,
                            profile_key: mcp_config::mcp_server_key().to_string(),
                        };
                        if let Err(err) = mcp_config::write_ipc_discovery(&discovery) {
                            mcp_telemetry::emit(
                                Some(&app),
                                mcp_telemetry::Level::Error,
                                "discovery",
                                format!("write discovery failed: {err}"),
                            );
                        }
                        // Install the Claude CLI mcpServers.lotus entry so the
                        // sidecar is auto-discovered. Args point at the
                        // bun-runnable script we ship in the repo.
                        let sidecar_spawn = mcp_sidecar_spawn_args();
                        match &sidecar_spawn {
                            Some((command, args)) => {
                                if let Err(err) = mcp_config::install_mcp_config_entry(command, args) {
                                    mcp_telemetry::emit(
                                        Some(&app),
                                        mcp_telemetry::Level::Error,
                                        "mcp-config",
                                        format!("install config failed: {err}"),
                                    );
                                }
                                if let Err(err) =
                                    mcp_config::install_codex_mcp_config_entry(command, args)
                                {
                                    mcp_telemetry::emit(
                                        Some(&app),
                                        mcp_telemetry::Level::Error,
                                        "codex-mcp-config",
                                        format!("install Codex MCP config failed: {err}"),
                                    );
                                }
                                // Cursor MCP: same JSON shape as ~/.claude.json.
                                // Only register when Cursor is actually installed
                                // so we never create a config for an absent tool.
                                if paths::cursor_dir().is_dir() {
                                    match mcp_config::cursor_mcp_config_path() {
                                        Ok(cursor_path) => {
                                            if let Err(err) = mcp_config::install_mcp_config_entry_at(
                                                &cursor_path,
                                                command,
                                                args,
                                            ) {
                                                mcp_telemetry::emit(
                                                    Some(&app),
                                                    mcp_telemetry::Level::Error,
                                                    "cursor-mcp-config",
                                                    format!("install Cursor MCP config failed: {err}"),
                                                );
                                            }
                                        }
                                        Err(err) => {
                                            mcp_telemetry::emit(
                                                Some(&app),
                                                mcp_telemetry::Level::Warn,
                                                "cursor-mcp-config",
                                                format!("could not resolve Cursor MCP config path: {err}"),
                                            );
                                        }
                                    }
                                }
                            }
                            None => {
                                mcp_telemetry::emit(
                                    Some(&app),
                                    mcp_telemetry::Level::Warn,
                                    "mcp-config",
                                    "could not locate lotus-mcp-server.mjs; skipping config install",
                                );
                                eprintln!(
                                    "[mcp] could not locate lotus-mcp-server.mjs; skipping config install + keeper"
                                );
                            }
                        }
                        // Eager sibling-profile eviction. We just installed our
                        // own `mcpServers.<key>` entry above, but a prior run of
                        // the OTHER profile (dev vs release) may have left its
                        // `lotus`/`lotus-dev` entry behind in ~/.claude.json.
                        // Because both profiles expose IDENTICAL base tool names,
                        // an agent that sees both picks arbitrarily and can call
                        // the sibling's tools — which fail with "instance not
                        // running" when that profile is closed. The keeper does
                        // this on its first 30s tick; running it eagerly here
                        // closes the startup window so agents spawned in the
                        // first minute never inherit the stale sibling entry.
                        // Safe: only removes the sibling when its discovery file
                        // is missing or its PID is dead, so a genuine dual-live
                        // dev+release still coexists.
                        let cleanup = mcp_keeper::cleanup_other_profile_if_stale();
                        if cleanup.config_removed || cleanup.discovery_removed {
                            eprintln!("[mcp] eager sibling cleanup: {}", cleanup.message);
                            mcp_telemetry::emit(
                                Some(&app),
                                mcp_telemetry::Level::Info,
                                "mcp-config",
                                cleanup.message,
                            );
                        }
                        // Native Stop hook: register a curl-back into our
                        // /v1/hook/stop endpoint inside ~/.claude/settings.json.
                        // Gives us an authoritative "Claude turn done" signal
                        // without relying on output-buffer pattern matching.
                        if let Err(err) = settings::install_stop_hook(port, state.secret()) {
                            mcp_telemetry::emit(
                                Some(&app),
                                mcp_telemetry::Level::Error,
                                "stop-hook",
                                format!("install Claude Stop hook failed: {err}"),
                            );
                        }
                        // Same idea for Codex's `notify` hook — drop a tiny
                        // shell script under ~/.lotus and merge a one-line
                        // notify entry into ~/.codex/config.toml.
                        if let Err(err) = mcp_config::install_codex_notify(port, state.secret()) {
                            mcp_telemetry::emit(
                                Some(&app),
                                mcp_telemetry::Level::Error,
                                "codex-notify",
                                format!("install Codex notify hook failed: {err}"),
                            );
                        }
                        // Agent-notify drop-file hooks: write the Node.js
                        // scripts to ~/.lotus/agent-notify/ and register Stop
                        // + Notification entries in ~/.claude/settings.json.
                        match mcp_config::install_agent_notify_scripts() {
                            Ok(script_path) => {
                                if let Err(err) =
                                    settings::install_agent_notify_hooks(&script_path)
                                {
                                    mcp_telemetry::emit(
                                        Some(&app),
                                        mcp_telemetry::Level::Error,
                                        "agent-hooks",
                                        format!("install hook entries failed: {err}"),
                                    );
                                }
                            }
                            Err(err) => mcp_telemetry::emit(
                                Some(&app),
                                mcp_telemetry::Level::Error,
                                "agent-hooks",
                                format!("install scripts failed: {err}"),
                            ),
                        }
                        // Codex's own hook system (`~/.codex/hooks.json`), which is what
                        // gives Codex cells a Chat transcript at all. Registered AFTER the
                        // agent-notify scripts above, because the script this writes shells
                        // out to that entry point.
                        //
                        // Deliberately separate from `install_codex_notify` rather than
                        // replacing it: the notify slot is the fastest turn-end signal and
                        // wakes `wait_cell_idle`, while this is the richer per-tool source.
                        match codex_hooks::install_codex_hooks() {
                            Ok(_) => {
                                // Registered is not the same as trusted. Codex gates hooks
                                // behind a per-entry approval, and Lotus deliberately does
                                // not write that trust on the operator's behalf — so an
                                // unapproved hook is silent, and silence here is
                                // indistinguishable from having no hook at all. Say it out
                                // loud once, at the level that reaches the operator.
                                if matches!(
                                    codex_hooks::trust_state_on_disk(),
                                    Some(codex_hooks::CodexHookTrust::AwaitingApproval)
                                ) {
                                    mcp_telemetry::emit(
                                        Some(&app),
                                        mcp_telemetry::Level::Warn,
                                        "codex-hooks",
                                        "Codex hooks registered but not yet trusted — Codex \
                                         will ask you to approve them on its next run, and \
                                         Chat stays empty for Codex cells until you do."
                                            .to_string(),
                                    );
                                }
                            }
                            Err(err) => mcp_telemetry::emit(
                                Some(&app),
                                mcp_telemetry::Level::Error,
                                "codex-hooks",
                                format!("install Codex hooks failed: {err}"),
                            ),
                        }
                        // Installing is not the same as being read. Every write above
                        // can succeed and still leave the agents this app spawns blind,
                        // because Claude resolves its settings from CLAUDE_CONFIG_DIR —
                        // and the only visible symptom is Chat on the phone rendering
                        // nothing, for every pane, with no error anywhere. So the check
                        // is made here and said out loud, rather than left for someone
                        // to discover from an empty screen (measured 2026-08-09).
                        if !settings::hooks_reach_spawned_agents() {
                            mcp_telemetry::emit(
                                Some(&app),
                                mcp_telemetry::Level::Warn,
                                "agent-hooks",
                                format!(
                                    "hooks are not readable by the agents this app spawns — \
                                     Claude here reads {}, and Chat will stay empty until \
                                     that file carries them",
                                    settings::spawned_agent_claude_dir().display()
                                ),
                            );
                        }
                        // Keep the server alive through app-managed state so
                        // the RunEvent cleanup path can shut it down cleanly.
                        mcp_runtime.set_handle(server_handle);
                        mcp_telemetry::emit(
                            Some(&app),
                            mcp_telemetry::Level::Info,
                            "bootstrap",
                            format!("MCP IPC listening on 127.0.0.1:{port}"),
                        );
                        // Self-heal keeper: the discovery file and mcpServers
                        // entry can disappear out from under us (lifecycle
                        // bug, manual edit, third-party tool). Periodically
                        // restore them while the server is alive so Bridge
                        // tooling never silently breaks.
                        if let Some((command, args)) = sidecar_spawn {
                            mcp_keeper::spawn(mcp_keeper::KeeperConfig {
                                port,
                                secret,
                                pid,
                                sidecar_command: command,
                                sidecar_args: args,
                            });
                        }
                    }
                    Err(err) => {
                        mcp_telemetry::emit(
                            Some(&app),
                            mcp_telemetry::Level::Error,
                            "bootstrap",
                            format!("start IPC failed: {err}"),
                        );
                    }
                }
            });

            // Agent hooks watcher: monitors ~/.lotus/agent-hooks/global/ for
            // drop files written by the hook script and emits lotus://agent-hook
            // Tauri events to the frontend for accurate completion notifications.
            // Non-fatal — if the watcher can't start (e.g. home dir missing),
            // the PTY-tap fallback continues to work.
            // Managed so Tauri commands and the axum API can both read it.
            let transcript_store =
                Arc::new(std::sync::Mutex::new(agent_hooks::TranscriptStore::new()));
            app.manage(Arc::clone(&transcript_store));

            // Built before the watcher so the HTTP hook route can share the very same instance: an
            // agent on another machine reports through `POST /api/hook/drop`, and "identical to a
            // local one" only stays true if both paths end in one sink.
            let hook_sink = {
                let broadcast_sink = agent_hooks::BroadcastSink::new(
                    notification_tx.clone(),
                    Arc::clone(&mcp_state_for_api),
                );
                std::sync::Arc::new(agent_hooks::MultiSink {
                        tauri: agent_hooks::TauriSink(app.handle().clone()),
                        broadcast: broadcast_sink,
                        extras: vec![
                            // Pane-correlated turn events (LOTUS_PANE_ID) feed the MCP fleet turn
                            // state + wake in-flight wait_cell_idle calls (push, not poll).
                            std::sync::Arc::new(crate::mcp_ipc::McpTurnSink(Arc::clone(
                                &mcp_state_for_api,
                            ))),
                            // Per-pane history, so Chat mode on the phone is not empty for an
                            // agent that is blocked and therefore emitting nothing new.
                            std::sync::Arc::new(agent_hooks::TranscriptSink(Arc::clone(
                                &transcript_store,
                            ))),
                        ],
                })
            };
            let hook_sink_for_api: std::sync::Arc<dyn agent_hooks::HookEventSink> =
                std::sync::Arc::clone(&hook_sink) as std::sync::Arc<dyn agent_hooks::HookEventSink>;

            match agent_hooks::default_drop_dir() {
                Some(drop_dir) => {
                    match agent_hooks::spawn_watcher(&drop_dir, std::sync::Arc::clone(&hook_sink)) {
                        Ok(watcher) => {
                            app.manage(watcher);
                            if let Err(err) = tauri::Emitter::emit(
                                app.handle(),
                                "lotus://agent-hooks-ready",
                                (),
                            ) {
                                eprintln!("[agent-hooks] emit ready failed: {err}");
                            }
                        }
                        Err(err) => eprintln!("[agent-hooks] watcher start failed: {err}"),
                    }
                }
                None => eprintln!("[agent-hooks] cannot resolve home dir, skipping watcher"),
            }

            // ── HTTP API server ──────────────────────────────────────────────
            // Runs on localhost as a background task on the Tauri tokio runtime.
            // The stable app usually owns 9877; dev/debug instances auto-fallback
            // to the next available port unless LOTUS_API_PORT pins an exact port.
            let api_key_inner = api_auth::load_or_create_api_key();
            let api_key_for_bot = api_key_inner.0.clone();
            let api_key = Arc::new(api_key_inner);
            let (api_listener, api_port) = match bind_api_listener() {
                Ok(bound) => bound,
                Err(e) => {
                    eprintln!("[lotus-api] HTTP API server failed to bind: {e}");
                    return Ok(());
                }
            };
            let api_base_url = format!("http://127.0.0.1:{api_port}");
            write_api_server_discovery(&api_key, api_port);

            // ── Embedded Telegram bot supervisor ─────────────────────────────
            // Spawns the bundled `lotus-remote.mjs` via `node` when the user
            // enables the bot in settings. Lifecycle:
            //   - `apply()` here on startup → respect the persisted enabled flag.
            //   - Tauri commands (`bot_*`) drive runtime changes from the UI.
            //   - `RunEvent::Exit` (lower in this file) calls `stop()`.
            let bot_integration = match host_runtime::integration::HostRuntimeIntegration::build_default(
                Some(api_base_url.clone()),
                Some(api_key_for_bot),
            ) {
                Ok(integ) => {
                    if let Err(err) = integ.apply() {
                        eprintln!("[telegram-bot] startup apply failed: {err}");
                    }
                    Some(Arc::new(integ))
                }
                Err(err) => {
                    eprintln!("[telegram-bot] could not initialise: {err}");
                    None
                }
            };
            if let Some(integ) = bot_integration.as_ref() {
                app.manage(Arc::clone(integ));
            }

            // Clone handles for the CellStalled ticker (spawned below).
            let pty_for_stall = Arc::clone(&pty_for_api);
            let mcp_state_for_stall = Arc::clone(&mcp_state_for_api);
            let notification_tx_stall = notification_tx.clone();

            // Manage the API key as Tauri state so Tauri commands can inject it
            // (e.g. create_session needs it to build AGENT_CANVAS_API_KEY env var).
            app.manage(Arc::clone(&api_key));
            app.manage(ApiServerEndpoint {
                base_url: api_base_url,
            });

            // Register the annotation store + origin-policy store as Tauri managed
            // state so open_canvas_browser can access them from the on_navigation
            // closure via app.state().
            let browser_annotations = crate::canvas_browser::CanvasBrowserAnnotationStore::default();
            app.manage(browser_annotations.clone());
            let browser_results = crate::canvas_browser::CanvasBrowserResultStore::default();
            app.manage(browser_results.clone());
            let canvas_browser_policies =
                crate::canvas_browser_policy::CanvasBrowserPolicyStore::default();
            app.manage(canvas_browser_policies.clone());
            let canvas_browser_approval_modes =
                crate::canvas_browser_approval::CanvasBrowserApprovalModeStore::default();
            app.manage(canvas_browser_approval_modes.clone());
            let canvas_browser_approval_gate =
                crate::canvas_browser_approval::CanvasBrowserApprovalGate::default();
            app.manage(canvas_browser_approval_gate.clone());
            let canvas_browser_local_files =
                crate::canvas_browser_local_files::LocalFileServeStore::with_port(api_port);
            app.manage(canvas_browser_local_files.clone());

            let router_state = api_server::ApiState {
                pty_state: Arc::clone(&pty_for_api),
                api_key,
                port: api_port,
                mcp_state: mcp_state_for_api,
                notification_tx,
                browser_annotations,
                browser_results,
                canvas_browser_policies,
                canvas_browser_approval_modes,
                canvas_browser_approval_gate,
                canvas_browser_local_files,
                // The SAME store the TranscriptSink writes into. A fresh one here
                // would compile and never work: the sink would fill one store
                // while every read saw an empty other one.
                transcripts: Arc::clone(&transcript_store),
                hook_sink: Some(hook_sink_for_api),
                app_handle: Some(app.handle().clone()),
            };
            // A phone's hold on a pane's size ends by itself when the phone goes quiet
            // (`pty/size_lease.rs`). Five seconds of slack on a 30-second lease.
            let pty_for_leases = Arc::clone(&pty_for_api);
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(5));
                loop {
                    tick.tick().await;
                    pty::expire_remote_sizes(&pty_for_leases);
                }
            });
            tauri::async_runtime::spawn(async move {
                let router = api_server::build_router(router_state);
                let listener = match tokio::net::TcpListener::from_std(api_listener) {
                    Ok(listener) => listener,
                    Err(e) => {
                        eprintln!("[lotus-api] HTTP API listener setup failed: {e}");
                        return;
                    }
                };
                if let Err(e) = axum::serve(listener, router).await {
                    eprintln!("[lotus-api] HTTP API server exited unexpectedly: {e}");
                }
            });

            // Graph Run engine (ADR-0049 §6): runs go on with no window open and resume
            // after a restart. A broken database must not take the whole app down.
            match graph_run_host::start(app.handle()) {
                Ok(host) => {
                    app.manage(lotus_graph_run::factory::check_trials::CheckTrials::new(factory_host::factory_root().join("check-trials"), shell_env::user_login_env().clone()));
                    app.manage(host);
                }
                Err(e) => eprintln!("[graph-run] disabled for this session: {e}"),
            }

            // Automation engine (ADR-0038). A broken database must not take the
            // whole app down: log it and run without automations.
            match automation_host::start(app.handle()) {
                Ok(runtime) => {
                    app.manage(runtime);
                    // Resume Slack from saved tokens without holding up startup.
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri::Manager;
                        if let Some(runtime) = handle.try_state::<automation_host::AutomationRuntime>() {
                            runtime.resume_interrupted().await;
                            runtime.resume_slack().await;
                        }
                    });
                    // Schedules and request sources: check every 30 s; missed runs collapse into one (PLAN Q37),
                    // and each source is asked every few minutes (ADR-0041).
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri::Manager;
                        let mut every = tokio::time::interval(std::time::Duration::from_secs(30));
                        loop {
                            every.tick().await;
                            if let Some(runtime) = handle.try_state::<automation_host::AutomationRuntime>() {
                                runtime.tick().await;
                            }
                        }
                    });
                }
                Err(e) => eprintln!("[automation] disabled for this session: {e}"),
            }

            // CellStalled ticker: every 30 s scan the fleet for cells that have
            // produced no PTY output beyond the stall threshold and emit
            // `CellStalled` events so remote subscribers can alert the operator.
            // Threshold is tunable via `LOTUS_CELL_STALL_MS` (default 10 min).
            let stall_threshold_ms: u64 = std::env::var("LOTUS_CELL_STALL_MS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(600_000);
            tauri::async_runtime::spawn(async move {
                let mut ticker =
                    tokio::time::interval(std::time::Duration::from_secs(30));
                ticker.tick().await; // skip the immediate first tick
                loop {
                    ticker.tick().await;
                    let fleet = mcp_state_for_stall.fleet_snapshot();
                    let now_ms = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as i64;
                    for member in &fleet {
                        let Some(ref session_id) = member.session_id else {
                            continue;
                        };
                        let idle_ms = {
                            // Clone the Arc before dropping the outer lock so we
                            // never hold pty_state while waiting for output_tail.
                            let tail_arc = {
                                let store = pty_for_stall
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                store.0.get(session_id).map(|s| Arc::clone(&s.pty.output_tail))
                            };
                            if let Some(t) = tail_arc {
                                t.lock().map(|g| g.metrics().idle_ms).unwrap_or(0)
                            } else {
                                0
                            }
                        };
                        if idle_ms >= stall_threshold_ms {
                            let event =
                                notification_event::NotificationEvent::CellStalled {
                                    pane_id: member.pane_id.clone(),
                                    workspace_id: member.workspace_id.clone(),
                                    session_id: session_id.clone(),
                                    idle_ms,
                                    timestamp: now_ms,
                                };
                            let _ = notification_tx_stall.send(event);
                        }
                    }
                }
            });


            Ok(())
        })
        .plugin(nav_guard::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // PtyState and McpIpcSharedState are managed inside setup() via app.manage().
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
            // PTY sessions
            commands::create_session,
            commands::create_command_session,
            commands::write_to_session,
            commands::resize_session,
            commands::kill_session,
            commands::close_window_sessions,
            commands::list_sessions,
            commands::adopt_session,
            commands::reconcile_sessions,
            commands::quit_with_agents,
            commands::get_quit_choice,
            commands::set_quit_choice,
            commands::take_kept_agents,
            commands::take_sessiond_fallback,
            commands::read_scrollback,
            // Teams
            commands::list_canvas_themes,
            commands::save_canvas_theme,
            commands::read_canvas_theme_asset,
            commands::canvas_theme_asset_path,
            commands::list_teams,
            commands::get_team,
            commands::delete_team,
            // Tasks
            commands::bridge_read_tasks,
            commands::bridge_write_tasks,
            commands::bridge_create_task,
            commands::bridge_update_task,
            commands::bridge_list_tasks,
            commands::bridge_get_task,
            commands::bridge_append_task_feedback_event,
            commands::automation_list,
            commands::automation_list_presets,
            commands::automation_list_gh_accounts,
            commands::automation_create_pr_review,
            commands::automation_run_now,
            commands::automation_list_runs,
            commands::automation_list_drafts,
            commands::automation_update_draft,
            commands::automation_send_draft,
            commands::automation_discard_draft,
            commands::automation_send_all,
            commands::automation_reply_now,
            commands::automation_slack_preview,
            commands::automation_answer_ask,
            commands::automation_list_answered_asks,
            commands::automation_create_agent_prompt,
            commands::automation_list_results,
            commands::automation_list_sent_reviews,
            commands::automation_review_room,
            commands::automation_run_conversation,
            commands::automation_send_message,
            commands::automation_pane_opened,
            commands::automation_find_checkout,
            commands::factory_git_subfolders,
            commands::automation_pane_failed,
            commands::automation_preview_result,
            commands::automation_send_result,
            commands::automation_set_enabled,
            commands::automation_delete,
            commands::automation_run_scheduled_now,
            commands::automation_update_prompt,
            commands::automation_update_agent,
            commands::automation_set_workspaces,
            commands::automation_run_steps,
            commands::automation_review_worktrees,
            commands::automation_edit,
            commands::automation_slack_status,
            commands::automation_slack_connect,
            commands::automation_slack_disconnect,
            commands::automation_slack_set_bot_token,
            commands::automation_slack_test_bot,
            commands::automation_slack_reactions,
            commands::automation_slack_emoji,
            commands::automation_slack_set_reactions,
            commands::automation_slack_check_now,
            commands::automation_google_status,
            commands::automation_google_connect,
            commands::automation_google_cancel_connect,
            commands::automation_google_disconnect,
            commands::automation_google_resend,
            commands::automation_google_pick,
            commands::notion_status,
            commands::notion_connect,
            commands::notion_disconnect,
            commands::notion_search_data_sources,
            commands::notion_describe_data_source,
            commands::notion_read_source,
            commands::notion_forget_source,
            commands::notion_write_ticket,
            commands::notion_trash_ticket,
            commands::notion_create_ticket,
            commands::notion_write_body,
            commands::notion_page_markdown,
            commands::notion_ticket_text,
            commands::notion_page_edited_time,
            commands::github_issues_sync_source,
            commands::github_issues_read_issue,
            commands::github_issues_list_repos,
            commands::github_issues_forget_source,
            commands::automation_slack_channels,
            commands::automation_slack_user_names,
            commands::automation_slack_usergroups,
            commands::automation_slack_manifest,
            commands::automation_set_slack_trigger,
            commands::automation_set_request_source,
            commands::vault_list_tickets,
            commands::vault_get_ticket,
            commands::vault_edit_ticket,
            commands::vault_watch,
            commands::editor_watch_root,
            commands::editor_unwatch,
            commands::git_graph_refs,
            commands::git_graph_log,
            commands::git_graph_search,
            commands::git_graph_commit,
            commands::git_graph_file_pair,
            commands::git_graph_watch,
            commands::git_graph_unwatch,
            commands::bridge_delete_task,
            commands::bridge_list_orphan_task_files,
            commands::bridge_move_workspace_tasks,
            commands::bridge_set_orphan_task_file_ignored,
            commands::bridge_delete_orphan_task_file,
            // Settings
            commands::get_settings,
            commands::save_settings,
            // FS / projects
            commands::get_homedir,
            commands::list_dir_entries,
            commands::editor_read_file,
            commands::editor_read_file_bytes,
            commands::editor_read_file_tail,
            commands::editor_stat_file,
            commands::editor_report_unsaved,
            commands::editor_quit_discarding,
            commands::editor_backup_write,
            commands::editor_search,
            commands::editor_search_ssh,
            commands::editor_search_cancel,
            commands::editor_lsp_resolve,
            commands::editor_lsp_resolve_ssh,
            commands::editor_lsp_start,
            commands::editor_lsp_start_ssh,
            commands::editor_lsp_send,
            commands::editor_lsp_stop,
            commands::editor_backup_read,
            commands::editor_backup_delete,
            commands::editor_write_file,
            commands::editor_create_file,
            commands::editor_create_directory,
            commands::editor_delete_entry,
            commands::editor_trash_entry,
            commands::editor_rename_entry,
            commands::editor_reveal_entry,
            commands::editor_list_files,
            commands::editor_index_files,
            commands::editor_list_entries,
            commands::ssh_resolve_remote_cwd,
            commands::editor_read_file_ssh,
            commands::editor_read_file_bytes_ssh,
            commands::editor_list_entries_ssh,
            commands::editor_write_file_ssh,
            commands::terminal_file_drop_inspect_paths,
            commands::terminal_file_drop_upload_ssh_batch,
            commands::terminal_file_drop_cancel_upload,
            commands::editor_create_file_ssh,
            commands::editor_create_directory_ssh,
            commands::editor_delete_entry_ssh,
            commands::editor_rename_entry_ssh,
            commands::list_projects,
            commands::get_claude_session_title,
            commands::read_claude_session_tail,
            commands::list_claude_sessions,
            commands::list_ssh_hosts,
            commands::list_dir_entries_ssh,
            commands::machine_readiness,
            commands::machine_access_login,
            commands::lotus_api_credentials,
            commands::list_claude_sessions_ssh,
            commands::read_claude_session_tail_ssh,
            commands::machine_install_hooks,
            commands::machine_host_fleet,
            commands::managed_host_status,
            commands::managed_host_step,
            commands::machine_host_link_check,
            commands::machine_host_projects,
            commands::machine_host_browse,
            commands::machine_host_add_project,
            commands::machine_host_dispatch,
            commands::machine_host_conversation,
            commands::machine_tunnel_open,
            commands::machine_tunnel_status,
            commands::machine_tunnel_close,
            commands::machine_recheck,
            commands::machine_disconnect,
            commands::webview_create,
            commands::webview_set_bounds,
            commands::webview_navigate,
            commands::webview_reload,
            commands::webview_back,
            commands::webview_forward,
            commands::webview_set_visible,
            commands::webview_destroy,
            // Processes
            commands::list_processes,
            commands::kill_process,
            // Runners (ADR-0027 Phase 2)
            commands::list_runners,
            commands::get_runner,
            commands::save_runner_config,
            commands::delete_runner_config,
            // Log streaming
            // Launch
            commands::spawn_claude,
            commands::smart_convert_note,
            commands::generate_pane_title,
            commands::pane_agent_title,
            commands::pty_session_metrics,
            commands::agent_cli_stage_images,
            commands::agent_cli_cleanup_temp_dir,
            // Skills
            commands::list_skills,
            commands::list_git_worktrees,
            commands::list_git_worktrees_ssh,
            commands::create_git_worktree_ssh,
            commands::remove_git_worktree_ssh,
            commands::validate_worktree_branches_ssh,
            commands::resolve_repo_head_branch_ssh,
            commands::git_diff_ssh,
            commands::create_git_worktree,
            commands::remove_git_worktree,
            commands::validate_worktree_branches,
            commands::resolve_repo_head_branch,
            commands::create_skill,
            commands::import_skill_from_url,
            commands::open_new_window,
            commands::show_window_menu,
            commands::open_external_link,
            commands::open_path_reference,
            commands::open_path_in_editor,
            commands::get_editor_availability,
            commands::get_cli_tool_availability,
            commands::detect_installed_clis,
            commands::set_cli_path,
            commands::cli_update_status,
            commands::cli_update_run,
            commands::get_ssh_cli_tool_availability,
            commands::get_ssh_git_repo_root,
            commands::ssh_probe_workspace,
            // Chat runtime (new Chat module)
            commands::chat_thread_create,
            commands::chat_thread_create_remote,
            commands::chat_remote_retry,
            commands::chat_threads_list,
            commands::chat_stats,
            commands::chat_import_codechat,
            commands::chat_api_models,
            commands::chat_send,
            commands::chat_interrupt,
            commands::chat_thread_stop,
            commands::chat_thread_rename,
            commands::chat_thread_set_agent_name,
            commands::chat_thread_set_strict_permissions,
            commands::chat_thread_warm,
            commands::chat_thread_regenerate_title,
            commands::chat_thread_archive,
            commands::chat_thread_pin,
            commands::chat_handoff_seed,
            commands::chat_thread_mark_read,
            commands::chat_thread_delete,
            commands::chat_models_list,
            commands::chat_commands_list,
            commands::chat_set_model,
            commands::chat_set_account,
            commands::chat_set_permission_mode,
            commands::chat_attachment_save_pasted,
            commands::chat_attachment_preview,
            commands::chat_attachment_upload,
            commands::chat_changes,
            commands::chat_change_diff,
            commands::chat_changes_commit,
            commands::chat_changes_undo,
            commands::chat_merge_child,
            commands::chat_child_discard,
            commands::worktree_cleanup_list,
            commands::worktree_cleanup_remove,
            commands::worktree_cleanup_auto,
            commands::worktree_cleanup_log,
            commands::chat_fork,
            commands::chat_rewind,
            commands::chat_fork_worktree,
            commands::chat_resolve_interaction,
            commands::chat_subscribe,
            commands::chat_unsubscribe,
            commands::chat_auth_get,
            commands::usage_snapshot,
            commands::usage_use_account,
            commands::usage_remote,
            commands::remote_accounts_list,
            commands::remote_account_create,
            commands::remote_account_remove,
            commands::remote_account_default,
            commands::accounts_list,
            commands::antigravity_login,
            commands::remote_ccs_migration,
            commands::ccs_migration_plan,
            commands::ccs_migration_run,
            commands::ccs_migration_remove_mcp,
            commands::account_create,
            commands::account_remove,
            commands::account_unhide,
            commands::account_removal_check,
            commands::chat_auth_save_key,
            commands::chat_auth_remove_key,
            commands::chat_auth_set_mode,
            // CodeChat streaming
            commands::agent_cli_run,
            commands::agent_cli_cancel,
            commands::agent_cli_availability,
            commands::agent_cli_models,
            commands::list_agent_models,
            commands::browser_preview_open_window,
            commands::browser_preview_open,
            commands::browser_preview_reachable,
            commands::browser_preview_sync_bounds,
            commands::browser_preview_close,
            commands::browser_preview_set_visible,
            commands::browser_preview_capture,
            commands::browser_preview_reload,
            commands::browser_preview_go_back,
            commands::browser_preview_go_forward,
            commands::browser_preview_start_annotation,
            commands::browser_preview_stop_annotation,
            commands::browser_preview_emit_annotation,
            // Canvas Browser WebView
            commands::open_canvas_browser,
            commands::close_canvas_browser,
            commands::navigate_canvas_browser,
            commands::sync_canvas_browser_bounds,
            commands::reload_canvas_browser,
            commands::is_canvas_browser_open,
            commands::get_canvas_browser_status,
            commands::history_canvas_browser,
            commands::set_canvas_browser_policy,
            commands::get_canvas_browser_policy,
            commands::set_canvas_browser_approval_mode,
            commands::get_canvas_browser_approval_mode,
            commands::resolve_canvas_browser_action,
            commands::focus_canvas_main_webview,
            commands::start_canvas_browser_annotation_mode,
            commands::stop_canvas_browser_annotation_mode,
            commands::emit_canvas_browser_annotation,
            commands::emit_canvas_browser_tool_result,
            commands::log_canvas_browser_annotation_trace,
            commands::voice_mute_other_audio,
            commands::voice_play_agent_done_sound,
            commands::capture_canvas_browser_annotation_screenshot,
            // CodeChat SQLite store
            // CodeCanvas SQLite project store
            commands::codecanvas_get_index,
            commands::codecanvas_open_project,
            commands::codecanvas_load_project,
            commands::codecanvas_save_project,
            commands::canvas_write_persona,
            commands::codecanvas_load_collaboration_record,
            commands::codecanvas_save_collaboration_record,
            commands::codecanvas_memory_write,
            commands::codecanvas_memory_list,
            commands::codecanvas_memory_search,
            commands::codecanvas_memory_archive,
            commands::codecanvas_memory_restore,
            commands::codecanvas_memory_set_pinned,
            commands::codecanvas_memory_archive_expired,
            commands::codecanvas_rename_project,
            commands::codecanvas_close_project,
            commands::codecanvas_set_active_project,
            commands::codecanvas_list_agents,
            commands::codecanvas_save_agent,
            commands::codecanvas_delete_agent,
            commands::codecanvas_list_agent_runs,
            commands::codecanvas_append_agent_run,
            commands::codecanvas_list_sessions,
            commands::codecanvas_upsert_session,
            commands::codecanvas_delete_session,
            commands::codecanvas_save_graph_run,
            commands::codecanvas_list_graph_runs,
            commands::codecanvas_list_all_graph_runs,
            commands::codecanvas_get_graph_run,
            commands::graph_run_start,
            commands::factory_catalog,
            commands::factory_definition_view,
            commands::factory_agent_save,
            commands::factory_shared_save,
            commands::factory_private_setup,
            factory_settings::factory_check_suggestions,
            factory_check_trials::factory_check_preview,
            factory_check_trials::factory_check_start,
            factory_check_trials::factory_check_status,
            factory_check_trials::factory_check_cancel,
            factory_settings::factory_gate_save,
            factory_settings::factory_private_remove,
            factory_settings::factory_private_restore,
            commands::graph_run_raise_cap,
            commands::graph_run_abort,
            commands::factory_chief_checked_at,
            commands::factory_set_feedback_label,
            commands::factory_start_round,
            commands::factory_accept_spec_change,
            commands::factory_decline_spec_change,
            commands::factory_edit_draft,
            commands::factory_send_draft,
            commands::factory_send_all,
            commands::factory_set_slack_identity,
            commands::factory_find_slack_thread,
            commands::factory_open_worktree,
            commands::graph_run_decide,
            commands::codecanvas_save_artifact,
            commands::codecanvas_list_artifacts,
            commands::codecanvas_save_note_asset,
            commands::codecanvas_import_note_asset_path,
            commands::codecanvas_list_note_assets,
            commands::codecanvas_read_note_asset,
            commands::codecanvas_note_asset_path,
            commands::codecanvas_stage_note_asset_for_agent,
            commands::codecanvas_delete_note_asset,
            commands::codecanvas_prune_unused_note_assets,
            commands::codecanvas_reveal_note_asset,
            commands::codecanvas_reveal_note_asset_folder,
            commands::codecanvas_list_templates,
            commands::codecanvas_save_template,
            commands::codecanvas_delete_template,
            // Bridge SQLite memory store
            commands::bridge_memory_upsert_session,
            commands::bridge_memory_append_turn,
            commands::bridge_memory_recent_turns,
            commands::bridge_memory_search,
            // CodeSpace SQLite metadata store
            commands::codespace_load_snapshot,
            commands::codespace_save_snapshot,
            commands::codespace_known_workspaces,
            // CodeChat tools
            commands::search_codebase,
            commands::read_project_file,
            commands::list_project_directory,
            commands::git_blame_file,
            commands::git_diff,
            commands::git_repo_status,
            commands::codespace_git_status,
            commands::codespace_git_repo_summary,
            commands::codespace_git_stage_file,
            commands::codespace_git_stage_all,
            commands::codespace_git_unstage_file,
            commands::codespace_git_unstage_all,
            commands::codespace_git_discard_all_changes,
            commands::codespace_git_commit,
            commands::codespace_git_push,
            commands::codespace_git_panel_refresh,
            commands::codespace_git_discover_repos,
            commands::codespace_git_panel_refresh_ssh,
            commands::codespace_git_status_ssh,
            commands::codespace_git_repo_summary_ssh,
            commands::codespace_git_stage_file_ssh,
            commands::codespace_git_stage_all_ssh,
            commands::codespace_git_unstage_file_ssh,
            commands::codespace_git_unstage_all_ssh,
            commands::codespace_git_discard_all_changes_ssh,
            commands::codespace_git_discard_file_ssh,
            commands::codespace_git_commit_ssh,
            commands::codespace_git_push_ssh,
            commands::codespace_git_ai_suggest_commit,
            commands::codespace_git_diff_file,
            commands::codespace_git_diff_file_content,
            commands::codespace_git_discard_file,
            commands::codespace_git_diff_file_ssh,
            commands::codespace_git_diff_file_content_ssh,
            commands::codespace_git_ai_suggest_commit_ssh,
            // Bridge MCP
            commands::bridge_push_fleet_snapshot,
            commands::notes_bridge_set_canvas,
            commands::bridge_push_canvas_fleet_snapshot,
            commands::bridge_forget_canvas_cell,
            commands::canvas_pane_turns,
            commands::bridge_push_swarm_fleet_snapshot,
            commands::bridge_resolve_mcp_request,
            commands::bridge_mcp_health,
            commands::bridge_mcp_launch_config,
            commands::bridge_mcp_cleanup_stale_profiles,
            commands::bridge_mcp_telemetry,
            commands::get_agent_hooks_health,
            // Telegram bot supervision
            commands::host_runtime_status,
            commands::host_runtime_sleep_hold,
            commands::host_runtime_bind_candidates,
            commands::host_runtime_create_pairing_code,
            commands::host_runtime_list_devices,
            commands::host_runtime_revoke_device,
            commands::host_runtime_admin_health,
            commands::host_runtime_get_config,
            commands::host_runtime_save_config,
            commands::host_runtime_apply,
            commands::host_runtime_stop,
            // Model registry
            commands::registry_list_providers,
            commands::registry_get_provider,
            commands::registry_upsert_provider,
            commands::registry_delete_provider,
            commands::registry_get_active_model,
            commands::registry_set_active_model,
            // TTS providers (CodeCanvas voice feedback — BYOK)
            commands::tts_list_providers,
            commands::tts_get_provider,
            commands::tts_upsert_provider,
            commands::tts_delete_provider,
            commands::tts_set_active_provider,
            commands::tts_set_output,
            commands::tts_synthesize,
            commands::tts_cancel_synthesis,
            // STT providers (CodeCanvas voice input — BYOK)
            commands::stt_list_providers,
            commands::stt_get_provider,
            commands::stt_upsert_provider,
            commands::stt_delete_provider,
            commands::stt_set_active_provider,
            commands::s2s_list_providers,
            commands::s2s_get_provider,
            commands::s2s_upsert_provider,
            commands::s2s_delete_provider,
            commands::s2s_set_active_provider,
            commands::stt_transcribe,
            commands::stt_stream_start,
            commands::stt_stream_send,
            commands::stt_stream_finish,
            commands::stt_stream_cancel,
            commands::s2s_stream_start,
            commands::s2s_stream_send,
            commands::s2s_stream_interrupt,
            commands::s2s_stream_truncate,
            commands::s2s_stream_diagnostics,
            commands::s2s_stream_tool_result,
            commands::s2s_stream_update,
            commands::s2s_stream_close,
            commands::s2s_debug_log,
            commands::csp_violation_log,
            commands::bug_report_context,
            commands::bug_report_mark_crash_seen,
            // Music node (CodeCanvas YouTube player)
            commands::music_resolve_track,
            commands::music_youtube_player_url,
            // NL utility completion over direct Anthropic HTTP (W1c; BYOK, falls back to CLI)
            commands::nl_complete,
            commands::nl_cancel,
            commands::nl_model_get_config,
            commands::nl_model_set_config,
            ];
            // Counts every command call (`ipc.calls`), to pick what should become a Rust push.
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                session_diagnostics::ipc_call(invoke.message.command());
                handler(invoke)
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Clicking the Dock icon of a running app does not spawn a new
            // process, so the single-instance guard never fires — this is the
            // only hook that can bring back a window once the last one was
            // closed. Without it the app is alive but unreachable.
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                windowing::focus_or_create_window(app_handle);
            }

            // A user quit (⌘Q, the menu, the Dock) carries no exit code; `app.exit(n)` does. A
            // window with unsaved editor files is asked first (`editor_unsaved.rs`).
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                if crate::editor_unsaved::should_block_quit(app_handle) {
                    api.prevent_exit();
                }
            }

            // Teardown ONLY on the final `Exit` event. `ExitRequested` fires
            // on macOS when the user closes the last window or hits ⌘Q
            // without confirming — running the destructive teardown there
            // leaves the app alive but in a half-uninstalled state (the
            // exact bug described in plans/bridge-mcp-resilience/PLAN.md).
            // Any failure inside the block is best-effort and never blocks
            // shutdown.
            //
            // Match ONLY `RunEvent::Exit` (the final, non-cancelable event).
            // `RunEvent::ExitRequested` can fire on macOS when the user closes
            // the last window or cancels a quit attempt — running destructive
            // teardown there leaves the app alive in a half-uninstalled state
            // (discovery file gone, mcpServers entry stripped) while the IPC
            // server keeps listening. The MCP sidecar then sees ENOENT on
            // every call and surfaces "Lotus IPC unavailable" to Bridge.
            if matches!(event, tauri::RunEvent::Exit) {
                use tauri::Manager;

                // Kill every pane's process tree. Closing the PTY masters alone leaves any
                // SIGHUP-ignoring child running as an orphan, still billed to Lotus by macOS.
                // Daemon sessions run on when the quit said "Keep running" (`quit_guard.rs`).
                if let Some(state) = app_handle.try_state::<PtyState>() {
                    quit_guard::on_exit(&state);
                }

                if let Some(trials) = app_handle.try_state::<lotus_graph_run::factory::check_trials::CheckTrials>() {
                    tauri::async_runtime::block_on(trials.shutdown());
                }
                if let Some(runtime) = app_handle.try_state::<nl_runtime::NlRuntime>() {
                    runtime.cancel_all();
                }
                if let Some(runtime) = app_handle.try_state::<tts_runtime::TtsRuntime>() {
                    runtime.cancel_all();
                }
                // Close live voice sockets so nothing keeps streaming (or billing) after quit.
                stt_stream::close_all();
                s2s_stream::close_all();
                voice_duck::restore();
                editor_lsp::stop_all();
                if let Some(transport) =
                    app_handle.try_state::<remote_transport::RemoteTransport>()
                {
                    transport.shutdown();
                }
                if let Some(runtime) = app_handle.try_state::<Arc<McpIpcRuntime>>() {
                    if let Some(server_handle) = runtime.take_handle() {
                        tauri::async_runtime::block_on(server_handle.shutdown());
                    }
                }
                if let Err(err) = mcp_config::remove_ipc_discovery_if_ours(std::process::id()) {
                    eprintln!("[mcp] remove discovery failed: {err}");
                }
                if let Err(err) = mcp_config::uninstall_mcp_config_entry() {
                    eprintln!("[mcp] uninstall config failed: {err}");
                }
                if let Err(err) = settings::uninstall_stop_hook() {
                    eprintln!("[mcp] uninstall Claude Stop hook failed: {err}");
                }
                if let Err(err) = mcp_config::uninstall_codex_notify() {
                    eprintln!("[mcp] uninstall Codex notify hook failed: {err}");
                }
                if let Err(err) = settings::uninstall_agent_notify_hooks() {
                    eprintln!("[agent-hooks] uninstall hook entries failed: {err}");
                }
                if let Err(err) = codex_hooks::uninstall_codex_hooks() {
                    eprintln!("[codex-hooks] uninstall hook entries failed: {err}");
                }
                // Whatever the sampler and the hook path buffered since the last flush.
                // Without this the final batch of a measurement run — up to 64 records, and
                // exactly the ones from the most interesting moment, shutdown — is lost.
                session_diagnostics::flush();

                // Stop the embedded Telegram bot subprocess so it doesn't
                // outlive the app (e.g. detach via fork). Best-effort: any
                // failure here is logged and ignored.
                if let Some(integ) =
                    app_handle.try_state::<Arc<host_runtime::integration::HostRuntimeIntegration>>()
                {
                    if let Err(err) = integ.stop() {
                        eprintln!("[telegram-bot] stop on exit failed: {err}");
                    }
                }
            }
        });
}
