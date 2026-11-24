//! Headless agent CLI runs (Claude, Codex, Cursor, custom): spawn, stream, cancel, availability and
//! model discovery. Mode-neutral: Canvas, Smart Convert and Tasks use it; it was CodeChat's (07g).

use crate::no_window::NoWindow;
mod provider;

use self::provider::{
    build_agent_cli_provider_invocation, discover_agent_cli_provider_models,
    parser_supports_image_attachments, probe_agent_cli_provider_auth,
    AgentCliProviderInvocationOptions, AgentCliResolvedCommand,
};
use crate::paths;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::ipc::Channel;

const AGENT_CLI_IMAGE_TEMP_PREFIX: &str = "lotus-codechat-images-";
const AGENT_CLI_IMAGE_TEMP_RETENTION: Duration = Duration::from_secs(60 * 60);
const AGENT_CLI_IMAGE_WORKSPACE_DIR: &str = ".lotus/codechat-images";

type SharedAgentCliChild = Arc<Mutex<Child>>;

static AGENT_CLI_RUNS: OnceLock<Mutex<HashMap<String, SharedAgentCliChild>>> = OnceLock::new();
static AGENT_CLI_PENDING_CANCELLATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn agent_cli_runs() -> &'static Mutex<HashMap<String, SharedAgentCliChild>> {
    AGENT_CLI_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn pending_agent_cli_cancellations() -> &'static Mutex<HashSet<String>> {
    AGENT_CLI_PENDING_CANCELLATIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn insert_agent_cli_run(run_id: String, child: SharedAgentCliChild) -> Result<bool, String> {
    let mut runs = agent_cli_runs()
        .lock()
        .map_err(|_| "Agent CLI run registry is unavailable.".to_string())?;
    if take_pending_agent_cli_cancellation(&run_id)? {
        return Ok(false);
    }
    runs.insert(run_id, child);
    Ok(true)
}

fn remove_agent_cli_run(run_id: &str) -> Option<SharedAgentCliChild> {
    agent_cli_runs().lock().ok()?.remove(run_id)
}

fn is_agent_cli_run_registered(run_id: &str) -> bool {
    agent_cli_runs()
        .lock()
        .map(|runs| runs.contains_key(run_id))
        .unwrap_or(false)
}

fn mark_pending_agent_cli_cancellation(run_id: &str) -> Result<(), String> {
    pending_agent_cli_cancellations()
        .lock()
        .map_err(|_| "Agent CLI cancellation registry is unavailable.".to_string())?
        .insert(run_id.to_string());
    Ok(())
}

fn take_pending_agent_cli_cancellation(run_id: &str) -> Result<bool, String> {
    Ok(pending_agent_cli_cancellations()
        .lock()
        .map_err(|_| "Agent CLI cancellation registry is unavailable.".to_string())?
        .remove(run_id))
}

pub fn cancel(run_id: String) -> Result<bool, String> {
    let run_id = run_id.trim();
    if run_id.is_empty() {
        return Ok(false);
    }

    let child = agent_cli_runs()
        .lock()
        .map_err(|_| "Agent CLI run registry is unavailable.".to_string())?
        .get(run_id)
        .cloned();
    let Some(child) = child else {
        mark_pending_agent_cli_cancellation(run_id)?;
        return Ok(false);
    };

    let mut child = child
        .lock()
        .map_err(|_| "Agent CLI run process handle is unavailable.".to_string())?;
    if child
        .try_wait()
        .map_err(|e| format!("Agent wait failed: {e}"))?
        .is_none()
    {
        #[cfg(unix)]
        crate::pty::process_tree::terminate_process_tree(child.id(), Duration::from_millis(200));
        if child
            .try_wait()
            .map_err(|e| format!("Agent wait failed: {e}"))?
            .is_none()
        {
            child
                .kill()
                .map_err(|e| format!("Agent stop failed: {e}"))?;
        }
        child
            .wait()
            .map_err(|e| format!("Agent wait failed: {e}"))?;
    }
    // Retain the registered handle on failure so the same close can be retried.
    let _ = remove_agent_cli_run(run_id);
    Ok(true)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub available: bool,
    pub resolved_path: Option<String>,
    pub source: Option<String>,
    pub message: Option<String>,
    pub auth_state: Option<String>,
    pub auth_message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredModels {
    pub models: Vec<String>,
    pub default_model: Option<String>,
    pub efforts: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAttachment {
    pub name: String,
    pub content: String,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedImageAttachments {
    pub temp_dir: String,
    pub image_paths: Vec<String>,
}

#[derive(Debug, Default, Clone)]
struct StreamDiagnostics {
    stdout_lines: usize,
    stderr_lines: usize,
    meaningful_stdout_lines: usize,
    last_stdout: Option<String>,
    last_stderr: Option<String>,
}

#[derive(Debug, Clone)]
struct ResolvedAgentCommand {
    executable: String,
    resolved_path: Option<String>,
    source: Option<String>,
    prepend_args: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentCliRunFinalStatus {
    Completed,
    Canceled,
    Error,
}

#[derive(Debug, Clone, Copy)]
struct AgentCliRunExit {
    status: AgentCliRunFinalStatus,
    exit_code: Option<i32>,
}

/// Builds the provider CLI invocation, with the operator's login-shell environment layered
/// underneath the vars this module sets itself.
///
/// `std::process::Command` inherits the parent env, and that parent is not a shell. A
/// Finder/Dock/launchd launch never sourced `.zshrc`/`.zprofile`, so the app process carries
/// neither the auth env nor the real `PATH` — measured on this machine, `Lotus.app` runs with no
/// `CLAUDE_CONFIG_DIR` at all and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A child inheriting that
/// resolves its Claude config to `~/.claude` instead of the `ccs` profile the operator is logged
/// into, and reports an expired OAuth session while the real credential is valid.
///
/// `login_env` is a parameter rather than a direct `shell_env::user_login_env()` call so the
/// layering is testable without depending on the machine's actual login shell. It is empty on
/// Windows, where the parent process env is already the right one.
///
/// Order matters: the login env goes on **first** so the vars this module sets deliberately
/// (`TERM=dumb` for a non-interactive stream, `NO_COLOR`, `OTEL_SDK_DISABLED`) win over whatever
/// the operator's shell exports.
fn build_agent_cli_command(
    executable: &str,
    args: &[String],
    cwd: Option<&str>,
    login_env: &HashMap<String, String>,
) -> Command {
    let mut cmd = Command::new(executable).no_window();

    // An empty captured value is a mask, not a value — `shell_env::apply_login_env_pairs` turns it
    // into `env_remove`. A plain `cmd.env(key, value)` loop here is what wrote a Claude config home
    // into this crate's own directory on 2026-09-20: this spawn's cwd was `src-tauri/`.
    crate::shell_env::apply_login_env_pairs(&mut cmd, login_env);

    cmd.args(args)
        .env("OTEL_SDK_DISABLED", "true")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    cmd
}

/// Spawn the Claude CLI and stream each stream-json line back to the frontend
/// via `on_chunk`. A sentinel `"__END__"` is sent when the process finishes.
///
/// The frontend receives raw stream-json lines and runs the same `handleEvent`
/// parser already used by the dev-mode API route — no duplication needed.
#[allow(clippy::too_many_arguments)]
pub fn run(
    run_id: String,
    prompt: String,
    agent_id: String,
    command: Vec<String>,
    parser: String,
    model: String,
    effort: String,
    flash: bool,
    provider_session_id: Option<String>,
    image_attachments: Vec<ImageAttachment>,
    image_paths: Option<Vec<String>>,
    dangerously_skip_permissions: bool,
    cwd: Option<String>,
    on_chunk: Channel<String>,
) -> Result<(), String> {
    let run_id = if run_id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        run_id
    };
    let run_started_at = Instant::now();
    let resolved = resolve_agent_command(&command)?;
    let executable = resolved.executable.clone();
    let mut prompt = prompt;

    let mut prepared_images = PreparedImageAttachments::default();

    if parser_supports_image_attachments(&parser) {
        prepared_images = prepare_image_attachments(&image_attachments, cwd.as_deref())?;
        if let Some(paths) = image_paths {
            prepared_images.image_paths.extend(
                paths
                    .into_iter()
                    .filter(|path| !path.trim().is_empty())
                    .map(PathBuf::from),
            );
        }
    }

    let provider_invocation =
        build_agent_cli_provider_invocation(AgentCliProviderInvocationOptions {
            parser: &parser,
            model: &model,
            effort: &effort,
            flash,
            provider_session_id: provider_session_id.as_deref(),
            image_paths: &prepared_images.image_paths,
            dangerously_skip_permissions,
        })?;

    if provider_invocation.should_prepend_image_paths_to_prompt {
        prompt = prepend_image_attachment_paths_to_prompt(prompt, &prepared_images.image_paths);
    }

    let mut args = resolved.prepend_args.clone();
    args.extend(command.iter().skip(1).cloned());
    args.extend(provider_invocation.args);

    let mut cmd = build_agent_cli_command(
        &executable,
        &args,
        cwd.as_deref(),
        crate::shell_env::user_login_env(),
    );

    let mut child = cmd.spawn().map_err(|e| {
        if let Some(temp_dir) = prepared_images.temp_dir.as_ref() {
            let _ = fs::remove_dir_all(temp_dir);
        }
        format!("Failed to spawn agent process `{executable}`: {e}")
    })?;

    send_perf_line(
        &on_chunk,
        &run_id,
        "spawned",
        &agent_id,
        &parser,
        run_started_at.elapsed().as_millis(),
        None,
        None,
        None,
    );

    let child_stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Failed to capture stdout for agent {agent_id}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Failed to capture stderr for agent {agent_id}"))?;
    // One line per run, to the dev terminal. The question it answers is whether two
    // conversations on screen are two runs: same pane count, two run ids, two pids. Without it
    // a shared or reused run looks exactly like two independent ones from the UI side.
    eprintln!(
        "[agent-cli-run] start run={run_id} agent={agent_id} parser={parser} pid={pid:?}",
        pid = child.id()
    );

    let shared_child = Arc::new(Mutex::new(child));
    if !insert_agent_cli_run(run_id.clone(), shared_child.clone())? {
        if let Ok(mut child) = shared_child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(temp_dir) = prepared_images.temp_dir.as_ref() {
            let _ = fs::remove_dir_all(temp_dir);
        }
        send_final_line(
            &on_chunk,
            &run_id,
            AgentCliRunFinalStatus::Canceled,
            None,
            Some("Agent run was canceled before startup completed."),
        );
        let _ = on_chunk.send("__END__".to_string());
        return Ok(());
    }

    // Write prompt to stdin then close the pipe so the agent knows input is done.
    if let Some(mut stdin) = child_stdin {
        let _ = stdin.write_all(prompt.as_bytes());
        // stdin drops here, closing the pipe
    }

    let diagnostics = Arc::new(Mutex::new(StreamDiagnostics::default()));
    let first_chunk_emitted = Arc::new(AtomicBool::new(false));

    let stdout_channel = on_chunk.clone();
    let stdout_diagnostics = diagnostics.clone();
    let stdout_first_chunk_emitted = first_chunk_emitted.clone();
    let stdout_agent_id = agent_id.clone();
    let stdout_parser = parser.clone();
    let stdout_run_id = run_id.clone();
    let stdout_thread = thread::spawn(move || {
        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !l.trim().is_empty() {
                if !stdout_first_chunk_emitted.swap(true, Ordering::SeqCst) {
                    send_perf_line(
                        &stdout_channel,
                        &stdout_run_id,
                        "first-chunk",
                        &stdout_agent_id,
                        &stdout_parser,
                        run_started_at.elapsed().as_millis(),
                        Some("stdout"),
                        None,
                        None,
                    );
                }
                if let Ok(mut snapshot) = stdout_diagnostics.lock() {
                    snapshot.stdout_lines += 1;
                    snapshot.last_stdout = Some(l.clone());
                    if is_meaningful_codex_stdout_line(&l) {
                        snapshot.meaningful_stdout_lines += 1;
                    }
                }
                let _ = stdout_channel.send(l);
            }
        }
    });

    let stderr_channel = on_chunk.clone();
    let stderr_diagnostics = diagnostics.clone();
    let stderr_first_chunk_emitted = first_chunk_emitted.clone();
    let stderr_agent_id = agent_id.clone();
    let stderr_parser = parser.clone();
    let stderr_run_id = run_id.clone();
    let stderr_thread = thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !l.trim().is_empty() {
                if !stderr_first_chunk_emitted.swap(true, Ordering::SeqCst) {
                    send_perf_line(
                        &stderr_channel,
                        &stderr_run_id,
                        "first-chunk",
                        &stderr_agent_id,
                        &stderr_parser,
                        run_started_at.elapsed().as_millis(),
                        Some("stderr"),
                        None,
                        None,
                    );
                }
                if let Ok(mut snapshot) = stderr_diagnostics.lock() {
                    snapshot.stderr_lines += 1;
                    snapshot.last_stderr = Some(l.clone());
                }
                send_error_line(&stderr_channel, &l);
            }
        }
    });

    // Poll without holding the child lock so `cancel_agent_cli_run` can kill it.
    let run_exit = wait_for_agent_cli_child(shared_child, &run_id, &agent_id, &on_chunk);
    eprintln!(
        "[agent-cli-run] end run={run_id} agent={agent_id} ms={elapsed}",
        elapsed = run_started_at.elapsed().as_millis()
    );
    let _ = remove_agent_cli_run(&run_id);

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    let exit_code = run_exit.as_ref().and_then(|exit| exit.exit_code);

    let final_status = run_exit
        .map(|exit| exit.status)
        .unwrap_or(AgentCliRunFinalStatus::Error);

    if final_status != AgentCliRunFinalStatus::Canceled {
        if let Ok(snapshot) = diagnostics.lock() {
            if parser == "codex-json" {
                if let Some(summary) = build_codex_failure_summary(&agent_id, &snapshot, exit_code)
                {
                    send_error_line(&on_chunk, &summary);
                }
            }
        }
    }

    if let Ok(snapshot) = diagnostics.lock() {
        send_perf_line(
            &on_chunk,
            &run_id,
            "completed",
            &agent_id,
            &parser,
            run_started_at.elapsed().as_millis(),
            None,
            Some(&snapshot),
            exit_code,
        );
    } else {
        send_perf_line(
            &on_chunk,
            &run_id,
            "completed",
            &agent_id,
            &parser,
            run_started_at.elapsed().as_millis(),
            None,
            None,
            exit_code,
        );
    }

    if let Some(temp_dir) = prepared_images.temp_dir.as_ref() {
        let _ = fs::remove_dir_all(temp_dir);
    }

    send_final_line(
        &on_chunk,
        &run_id,
        final_status,
        exit_code,
        match final_status {
            AgentCliRunFinalStatus::Canceled => Some("Agent run was canceled."),
            AgentCliRunFinalStatus::Error => Some("Agent run ended with an error."),
            AgentCliRunFinalStatus::Completed => None,
        },
    );

    // Sentinel — frontend closes the ReadableStream on this token.
    let _ = on_chunk.send("__END__".to_string());
    Ok(())
}

fn wait_for_agent_cli_child(
    child: SharedAgentCliChild,
    run_id: &str,
    agent_id: &str,
    on_chunk: &Channel<String>,
) -> Option<AgentCliRunExit> {
    loop {
        let status = {
            let mut child = match child.lock() {
                Ok(child) => child,
                Err(_) => {
                    send_error_line(on_chunk, "Process wait failed: child handle unavailable");
                    return Some(AgentCliRunExit {
                        status: AgentCliRunFinalStatus::Error,
                        exit_code: None,
                    });
                }
            };

            match child.try_wait() {
                Ok(status) => status,
                Err(error) => {
                    send_error_line(on_chunk, &format!("Process wait failed: {error}"));
                    return Some(AgentCliRunExit {
                        status: AgentCliRunFinalStatus::Error,
                        exit_code: None,
                    });
                }
            }
        };

        match status {
            Some(status) if !status.success() => {
                let exit_code = status.code();
                if is_agent_cli_run_registered(run_id) {
                    let code = exit_code.unwrap_or(-1);
                    send_error_line(
                        on_chunk,
                        &format!("Agent {agent_id} exited with code {code}"),
                    );
                    return Some(AgentCliRunExit {
                        status: AgentCliRunFinalStatus::Error,
                        exit_code,
                    });
                } else {
                    send_error_line(on_chunk, &format!("Agent {agent_id} was canceled"));
                    return Some(AgentCliRunExit {
                        status: AgentCliRunFinalStatus::Canceled,
                        exit_code,
                    });
                }
            }
            Some(status) => {
                return Some(AgentCliRunExit {
                    status: AgentCliRunFinalStatus::Completed,
                    exit_code: status.code(),
                });
            }
            None => thread::sleep(Duration::from_millis(25)),
        }
    }
}

#[derive(Debug, Default)]
struct PreparedImageAttachments {
    temp_dir: Option<PathBuf>,
    image_paths: Vec<PathBuf>,
}

fn prepare_image_attachments(
    attachments: &[ImageAttachment],
    cwd: Option<&str>,
) -> Result<PreparedImageAttachments, String> {
    if attachments.is_empty() {
        return Ok(PreparedImageAttachments::default());
    }

    let root_dir = resolve_image_attachment_root_dir(cwd);
    fs::create_dir_all(&root_dir)
        .map_err(|error| format!("Failed to create image attachment root directory: {error}"))?;
    let _ = cleanup_stale_agent_cli_temp_dirs_in(&root_dir, SystemTime::now());

    let temp_dir = root_dir.join(format!(
        "{AGENT_CLI_IMAGE_TEMP_PREFIX}{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&temp_dir)
        .map_err(|error| format!("Failed to create temporary image directory: {error}"))?;

    let mut image_paths = Vec::with_capacity(attachments.len());
    for (index, attachment) in attachments.iter().enumerate() {
        let result: Result<PathBuf, String> = (|| {
            let (_, encoded) = attachment.content.split_once(',').ok_or_else(|| {
                format!(
                    "Image attachment `{}` is not a valid data URL.",
                    attachment.name
                )
            })?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|error| {
                    format!(
                        "Failed to decode image attachment `{}`: {error}",
                        attachment.name
                    )
                })?;
            let extension = infer_image_extension(attachment);
            let file_name = format!(
                "{}-{}.{}",
                index,
                sanitize_file_stem(&attachment.name),
                extension
            );
            let image_path = temp_dir.join(file_name);
            fs::write(&image_path, decoded).map_err(|error| {
                format!(
                    "Failed to write image attachment `{}`: {error}",
                    attachment.name
                )
            })?;
            Ok(image_path)
        })();

        match result {
            Ok(image_path) => image_paths.push(image_path),
            Err(error) => {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(error);
            }
        }
    }

    Ok(PreparedImageAttachments {
        temp_dir: Some(temp_dir),
        image_paths,
    })
}

pub fn stage_image_attachments(
    attachments: Vec<ImageAttachment>,
) -> Result<StagedImageAttachments, String> {
    let prepared = prepare_image_attachments(&attachments, None)?;
    let temp_dir = prepared
        .temp_dir
        .ok_or_else(|| "No temporary image directory was created.".to_string())?;

    Ok(StagedImageAttachments {
        temp_dir: temp_dir.to_string_lossy().into_owned(),
        image_paths: prepared
            .image_paths
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect(),
    })
}

pub fn cleanup_temp_dir(temp_dir: String) -> Result<(), String> {
    if temp_dir.trim().is_empty() {
        return Ok(());
    }

    let path = PathBuf::from(&temp_dir);
    if !path.exists() {
        return Ok(());
    }

    let cleanup_path = validate_agent_cli_temp_dir_for_cleanup(&path)?;
    fs::remove_dir_all(&cleanup_path).map_err(|error| {
        format!("Failed to remove temporary image directory `{temp_dir}`: {error}")
    })
}

pub fn cleanup_stale_temp_dirs() -> Result<(), String> {
    cleanup_stale_agent_cli_temp_dirs_at(SystemTime::now())
}

fn cleanup_stale_agent_cli_temp_dirs_at(now: SystemTime) -> Result<(), String> {
    let temp_root = env::temp_dir();
    cleanup_stale_agent_cli_temp_dirs_in(&temp_root, now)
}

fn cleanup_stale_agent_cli_temp_dirs_in(root_dir: &Path, now: SystemTime) -> Result<(), String> {
    let entries = fs::read_dir(root_dir).map_err(|error| {
        format!(
            "Failed to read temp directory `{}`: {error}",
            root_dir.display()
        )
    })?;

    for entry in entries {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();

        if !is_stale_agent_cli_temp_dir_candidate(&path, now) {
            continue;
        }

        let _ = fs::remove_dir_all(&path);
    }

    Ok(())
}

fn resolve_image_attachment_root_dir(cwd: Option<&str>) -> PathBuf {
    cwd.map(PathBuf::from)
        .filter(|path| path.is_dir())
        .map(|path| path.join(AGENT_CLI_IMAGE_WORKSPACE_DIR))
        .unwrap_or_else(env::temp_dir)
}

fn validate_agent_cli_temp_dir_for_cleanup(path: &Path) -> Result<PathBuf, String> {
    if !path.is_dir() {
        return Err(format!(
            "Refusing to clean agent CLI temp path `{}` because it is not a directory.",
            path.display()
        ));
    }

    let file_type = fs::symlink_metadata(path)
        .map_err(|error| {
            format!(
                "Failed to inspect agent CLI temp path `{}`: {error}",
                path.display()
            )
        })?
        .file_type();
    if file_type.is_symlink() {
        return Err(format!(
            "Refusing to clean agent CLI temp path `{}` because it is a symlink.",
            path.display()
        ));
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            format!(
                "Refusing to clean agent CLI temp path `{}` because its name is invalid.",
                path.display()
            )
        })?;
    if !name.starts_with(AGENT_CLI_IMAGE_TEMP_PREFIX) {
        return Err(format!(
            "Refusing to clean agent CLI temp directory `{}` because it does not use the expected prefix.",
            path.display()
        ));
    }

    let canonical_path = fs::canonicalize(path).map_err(|error| {
        format!(
            "Failed to resolve agent CLI temp directory `{}`: {error}",
            path.display()
        )
    })?;
    let parent = canonical_path.parent().ok_or_else(|| {
        format!(
            "Refusing to clean agent CLI temp directory `{}` because it has no parent.",
            canonical_path.display()
        )
    })?;

    if is_allowed_agent_cli_temp_parent(parent) {
        return Ok(canonical_path);
    }

    Err(format!(
        "Refusing to clean agent CLI temp directory `{}` because it is outside agent CLI temp storage.",
        canonical_path.display()
    ))
}

fn is_allowed_agent_cli_temp_parent(parent: &Path) -> bool {
    let Ok(canonical_parent) = fs::canonicalize(parent) else {
        return false;
    };

    if fs::canonicalize(env::temp_dir())
        .map(|temp_dir| canonical_parent == temp_dir)
        .unwrap_or(false)
    {
        return true;
    }

    is_agent_cli_workspace_image_root(&canonical_parent)
}

fn is_agent_cli_workspace_image_root(path: &Path) -> bool {
    let mut components = path.components().rev();
    let Some(last) = components.next() else {
        return false;
    };
    let Some(previous) = components.next() else {
        return false;
    };

    last.as_os_str() == "codechat-images" && previous.as_os_str() == ".lotus"
}

fn is_stale_agent_cli_temp_dir_candidate(path: &Path, now: SystemTime) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if !path.is_dir() {
        return false;
    }

    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    let Ok(modified_at) = metadata.modified() else {
        return false;
    };

    is_stale_agent_cli_temp_dir(name, modified_at, now)
}

fn is_stale_agent_cli_temp_dir(name: &str, modified_at: SystemTime, now: SystemTime) -> bool {
    if !name.starts_with(AGENT_CLI_IMAGE_TEMP_PREFIX) {
        return false;
    }

    match now.duration_since(modified_at) {
        Ok(age) => age >= AGENT_CLI_IMAGE_TEMP_RETENTION,
        Err(_) => false,
    }
}

fn infer_image_extension(attachment: &ImageAttachment) -> &'static str {
    match attachment.mime_type.as_deref() {
        Some("image/png") => "png",
        Some("image/jpeg") => "jpg",
        Some("image/webp") => "webp",
        Some("image/gif") => "gif",
        Some("image/svg+xml") => "svg",
        _ => "png",
    }
}

fn sanitize_file_stem(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let sanitized = stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();

    sanitized
        .trim_matches('-')
        .to_string()
        .chars()
        .take(48)
        .collect::<String>()
}

fn prepend_image_attachment_paths_to_prompt(prompt: String, image_paths: &[PathBuf]) -> String {
    if image_paths.is_empty() {
        return prompt;
    }

    let analysis_guidance = [
        "Visual analysis instructions:",
        "- Treat the attached image paths as the primary source of truth for visual details.",
        "- Do not default to a generic summary if the user is asking for analysis or critique.",
        "- Prioritize layout, visual hierarchy, spacing, contrast, labeling, and obvious anomalies before summarizing metrics.",
        "- If the image appears to be a dashboard or UI screenshot, explain why the result may feel off, confusing, sparse, or visually unbalanced.",
        "- If any detail is unclear, say so explicitly instead of guessing.",
    ]
    .join("\n");

    let attachment_instructions = if image_paths.len() == 1 {
        format!("Analyze this image:\n{}", image_paths[0].to_string_lossy())
    } else {
        let lines = image_paths
            .iter()
            .enumerate()
            .map(|(index, path)| format!("{}. {}", index + 1, path.to_string_lossy()))
            .collect::<Vec<_>>()
            .join("\n");
        format!("Analyze these images:\n{lines}")
    };

    if prompt.trim().is_empty() {
        format!("{analysis_guidance}\n\n{attachment_instructions}")
    } else {
        format!("{analysis_guidance}\n\n{attachment_instructions}\n\n{prompt}")
    }
}

fn send_error_line(channel: &Channel<String>, text: &str) {
    let escaped = text
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n");
    let _ = channel.send(format!(r#"{{"type":"_error","text":"{escaped}"}}"#));
}

fn agent_cli_final_status_label(status: AgentCliRunFinalStatus) -> &'static str {
    match status {
        AgentCliRunFinalStatus::Completed => "completed",
        AgentCliRunFinalStatus::Canceled => "canceled",
        AgentCliRunFinalStatus::Error => "error",
    }
}

fn agent_cli_final_event_json(
    run_id: &str,
    status: AgentCliRunFinalStatus,
    exit_code: Option<i32>,
    message: Option<&str>,
) -> String {
    serde_json::json!({
        "type": "_final",
        "runId": run_id,
        "status": agent_cli_final_status_label(status),
        "exitCode": exit_code,
        "message": message,
    })
    .to_string()
}

fn send_final_line(
    channel: &Channel<String>,
    run_id: &str,
    status: AgentCliRunFinalStatus,
    exit_code: Option<i32>,
    message: Option<&str>,
) {
    let _ = channel.send(agent_cli_final_event_json(
        run_id, status, exit_code, message,
    ));
}

#[allow(clippy::too_many_arguments)]
fn send_perf_line(
    channel: &Channel<String>,
    run_id: &str,
    stage: &str,
    agent_id: &str,
    parser: &str,
    elapsed_ms: u128,
    source: Option<&str>,
    diagnostics: Option<&StreamDiagnostics>,
    exit_code: Option<i32>,
) {
    let payload = serde_json::json!({
        "type": "_perf",
        "runId": run_id,
        "stage": stage,
        "agentId": agent_id,
        "parser": parser,
        "elapsedMs": elapsed_ms,
        "source": source,
        "stdoutLines": diagnostics.map(|value| value.stdout_lines),
        "stderrLines": diagnostics.map(|value| value.stderr_lines),
        "meaningfulStdoutLines": diagnostics.map(|value| value.meaningful_stdout_lines),
        "exitCode": exit_code,
    });
    let _ = channel.send(payload.to_string());
}

fn is_meaningful_codex_stdout_line(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }

    if trimmed == "Reading prompt from stdin..." {
        return false;
    }

    if trimmed.contains(r#""type":"thread.started""#)
        || trimmed.contains(r#""type":"turn.started""#)
    {
        return false;
    }

    true
}

fn build_codex_failure_summary(
    agent_id: &str,
    diagnostics: &StreamDiagnostics,
    exit_code: Option<i32>,
) -> Option<String> {
    if diagnostics.meaningful_stdout_lines > 0 {
        return None;
    }

    let mut details = Vec::new();

    if let Some(code) = exit_code {
        details.push(format!("exit_code={code}"));
    }
    details.push(format!("stdout_lines={}", diagnostics.stdout_lines));
    details.push(format!("stderr_lines={}", diagnostics.stderr_lines));

    if let Some(last_stdout) = diagnostics.last_stdout.as_ref() {
        details.push(format!("last_stdout={}", truncate_for_error(last_stdout)));
    }
    if let Some(last_stderr) = diagnostics.last_stderr.as_ref() {
        details.push(format!("last_stderr={}", truncate_for_error(last_stderr)));
    }

    Some(format!(
        "Codex process `{agent_id}` finished without meaningful output. {}",
        details.join(" | ")
    ))
}

fn truncate_for_error(value: &str) -> String {
    const LIMIT: usize = 240;
    let trimmed = value.trim();
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }

    let shortened = trimmed.chars().take(LIMIT).collect::<String>();
    format!("{shortened}...")
}

pub fn availability(
    command: Vec<String>,
    probe_auth: bool,
) -> Availability {
    let is_empty = command
        .first()
        .map(|value| value.trim())
        .is_none_or(|value| value.is_empty());

    if is_empty {
        return Availability {
            available: false,
            resolved_path: None,
            source: None,
            message: Some("Command is empty.".into()),
            auth_state: None,
            auth_message: None,
        };
    }

    match resolve_agent_command(&command) {
        Ok(resolved) => {
            let executable_name = command
                .first()
                .map(|value| value.trim())
                .unwrap_or_default();
            let (auth_state, auth_message) = probe_agent_cli_provider_auth(
                executable_name,
                &AgentCliResolvedCommand {
                    executable: resolved.executable,
                    prepend_args: resolved.prepend_args,
                },
                probe_auth,
            );

            Availability {
                available: true,
                resolved_path: resolved.resolved_path,
                source: resolved.source,
                message: None,
                auth_state,
                auth_message,
            }
        }
        Err(message) => Availability {
            available: false,
            resolved_path: None,
            source: None,
            message: Some(message),
            auth_state: None,
            auth_message: None,
        },
    }
}

pub fn discover_models(
    agent_id: String,
    command: Vec<String>,
) -> DiscoveredModels {
    let discovered = discover_agent_cli_provider_models(&agent_id, &command, run_command_for_stdout);

    DiscoveredModels {
        models: discovered.models,
        default_model: discovered.default_model,
        efforts: discovered.efforts,
    }
}

fn run_command_for_stdout(command: &[String], extra_args: &[&str]) -> String {
    if command.first().is_none_or(|value| value.trim().is_empty()) {
        return String::new();
    }
    let resolved = match resolve_agent_command(command) {
        Ok(resolved) => resolved,
        Err(_) => return String::new(),
    };

    let mut help_cmd = Command::new(&resolved.executable).no_window();
    if !resolved.prepend_args.is_empty() {
        help_cmd.args(&resolved.prepend_args);
    }
    if command.len() > 1 {
        help_cmd.args(&command[1..]);
    }
    help_cmd.args(extra_args);

    match help_cmd.output() {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        _ => String::new(),
    }
}

fn resolve_agent_command(command: &[String]) -> Result<ResolvedAgentCommand, String> {
    resolve_agent_command_inner(command, 0)
}

fn resolve_agent_command_inner(
    command: &[String],
    alias_depth: usize,
) -> Result<ResolvedAgentCommand, String> {
    if alias_depth > 4 {
        return Err("Command resolution exceeded alias expansion limit.".to_string());
    }

    let executable = command
        .first()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Command is empty.".to_string())?;

    if let Some(resolved) = resolve_explicit_path(executable) {
        return Ok(resolved);
    }

    if let Some(resolved) = resolve_from_current_path(executable) {
        return Ok(resolved);
    }

    if let Some(resolved) = resolve_from_macos_path_files(executable) {
        return Ok(resolved);
    }

    if let Some(resolved) = resolve_from_known_locations(executable) {
        return Ok(resolved);
    }

    if let Some(resolved) = resolve_from_shell_lookup(executable, alias_depth) {
        return Ok(resolved);
    }

    Err(format!(
        "Could not resolve `{executable}`. Checked app PATH, macOS system paths, common install directories, and shell lookup."
    ))
}

fn resolve_explicit_path(executable: &str) -> Option<ResolvedAgentCommand> {
    if !looks_like_path(executable) {
        return None;
    }

    let path = PathBuf::from(executable);
    if !path.exists() {
        return None;
    }

    let canonical = fs::canonicalize(&path).unwrap_or(path);
    Some(ResolvedAgentCommand {
        executable: canonical.to_string_lossy().into_owned(),
        resolved_path: Some(canonical.to_string_lossy().into_owned()),
        source: Some("explicit-path".into()),
        prepend_args: Vec::new(),
    })
}

fn resolve_from_current_path(executable: &str) -> Option<ResolvedAgentCommand> {
    search_in_dirs(env::var_os("PATH"), executable).map(|path| ResolvedAgentCommand {
        executable: path.to_string_lossy().into_owned(),
        resolved_path: Some(path.to_string_lossy().into_owned()),
        source: Some("path".into()),
        prepend_args: Vec::new(),
    })
}

#[cfg(target_os = "macos")]
fn resolve_from_macos_path_files(executable: &str) -> Option<ResolvedAgentCommand> {
    let dirs = collect_macos_system_path_dirs();
    for dir in dirs {
        if let Some(path) = find_executable_in_dir(&dir, executable) {
            return Some(ResolvedAgentCommand {
                executable: path.to_string_lossy().into_owned(),
                resolved_path: Some(path.to_string_lossy().into_owned()),
                source: Some("macos-system-path".into()),
                prepend_args: Vec::new(),
            });
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn resolve_from_macos_path_files(_executable: &str) -> Option<ResolvedAgentCommand> {
    None
}

fn resolve_from_known_locations(executable: &str) -> Option<ResolvedAgentCommand> {
    let mut dirs = Vec::new();
    let home = paths::home_dir();

    dirs.push(home.join(".bun").join("bin"));
    dirs.push(home.join(".local").join("bin"));
    dirs.push(home.join(".cargo").join("bin"));
    dirs.push(home.join("bin"));

    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/usr/local/bin"));
    }

    #[cfg(target_os = "linux")]
    {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/usr/bin"));
        dirs.push(PathBuf::from("/snap/bin"));
    }

    #[cfg(windows)]
    {
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(
            home.join("AppData")
                .join("Local")
                .join("Microsoft")
                .join("WindowsApps"),
        );
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(home.join("scoop").join("shims"));
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Microsoft").join("WindowsApps"));
            dirs.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("Microsoft VS Code")
                    .join("bin"),
            );
        }
    }

    for dir in dirs {
        if let Some(path) = find_executable_in_dir(&dir, executable) {
            return Some(ResolvedAgentCommand {
                executable: path.to_string_lossy().into_owned(),
                resolved_path: Some(path.to_string_lossy().into_owned()),
                source: Some("known-location".into()),
                prepend_args: Vec::new(),
            });
        }
    }

    None
}

fn resolve_from_shell_lookup(executable: &str, alias_depth: usize) -> Option<ResolvedAgentCommand> {
    #[cfg(windows)]
    {
        let output = Command::new("where.exe").no_window().arg(executable).output().ok()?;
        if !output.status.success() {
            return None;
        }
        let resolved = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(PathBuf::from)?;
        return Some(ResolvedAgentCommand {
            executable: resolved.to_string_lossy().into_owned(),
            resolved_path: Some(resolved.to_string_lossy().into_owned()),
            source: Some("where".into()),
            prepend_args: Vec::new(),
        });
    }

    #[cfg(unix)]
    {
        let mut shells = Vec::new();
        if let Some(shell) = env::var_os("SHELL") {
            shells.push(PathBuf::from(shell));
        }
        shells.push(PathBuf::from("/bin/zsh"));
        shells.push(PathBuf::from("/bin/bash"));
        shells.push(PathBuf::from("/bin/sh"));

        for shell in &shells {
            if !shell.exists() {
                continue;
            }
            let output = match Command::new(shell)
                .no_window()
                .args([
                    "-l",
                    "-c",
                    &format!("command -v {}", shell_escape(executable)),
                ])
                .output()
            {
                Ok(output) => output,
                Err(_) => continue,
            };
            if !output.status.success() {
                continue;
            }
            let resolved = String::from_utf8_lossy(&output.stdout)
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
                .map(PathBuf::from)?;
            return Some(ResolvedAgentCommand {
                executable: resolved.to_string_lossy().into_owned(),
                resolved_path: Some(resolved.to_string_lossy().into_owned()),
                source: Some("login-shell".into()),
                prepend_args: Vec::new(),
            });
        }

        for shell in &shells {
            if !shell.exists() {
                continue;
            }
            if let Some(alias_command) = resolve_from_shell_alias(shell, executable, alias_depth) {
                return Some(alias_command);
            }
        }
        None
    }
}

#[cfg(unix)]
fn resolve_from_shell_alias(
    shell: &Path,
    executable: &str,
    alias_depth: usize,
) -> Option<ResolvedAgentCommand> {
    let output = Command::new(shell)
        .no_window()
        .args(["-i", "-c", &format!("alias {}", shell_escape(executable))])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let alias_tokens = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| parse_shell_alias_definition(line, executable))?;

    let mut resolved = resolve_agent_command_inner(&alias_tokens, alias_depth + 1).ok()?;
    let alias_args = alias_tokens.iter().skip(1).cloned().collect::<Vec<_>>();
    if !alias_args.is_empty() {
        let mut prepend_args = resolved.prepend_args;
        prepend_args.extend(alias_args);
        resolved.prepend_args = prepend_args;
    }
    resolved.source = Some("shell-alias".into());
    Some(resolved)
}

fn parse_shell_alias_definition(line: &str, alias_name: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    let definition = trimmed.strip_prefix("alias ").unwrap_or(trimmed);
    let (name, value) = definition.split_once('=')?;
    if name.trim() != alias_name {
        return None;
    }

    let quoted = value.trim();
    let quote = quoted.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let body = quoted.strip_prefix(quote)?.strip_suffix(quote)?;
    split_shell_words(body)
}

fn split_shell_words(input: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut chars = input.chars().peekable();
    let mut quote: Option<char> = None;

    while let Some(ch) = chars.next() {
        match quote {
            Some(active_quote) if ch == active_quote => {
                quote = None;
            }
            Some('"') if ch == '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            Some(_) => current.push(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    words.push(std::mem::take(&mut current));
                }
            }
            None if ch == '\'' || ch == '"' => {
                quote = Some(ch);
            }
            None if ch == '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            None => current.push(ch),
        }
    }

    if quote.is_some() {
        return None;
    }
    if !current.is_empty() {
        words.push(current);
    }
    if words.is_empty() {
        None
    } else {
        Some(words)
    }
}

fn looks_like_path(executable: &str) -> bool {
    executable.contains('/') || executable.contains('\\') || Path::new(executable).is_absolute()
}

fn search_in_dirs(path_env: Option<std::ffi::OsString>, executable: &str) -> Option<PathBuf> {
    let path_env = path_env?;
    for dir in env::split_paths(&path_env) {
        if let Some(path) = find_executable_in_dir(&dir, executable) {
            return Some(path);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn collect_macos_system_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    for line in read_nonempty_lines(Path::new("/etc/paths")) {
        dirs.push(PathBuf::from(line));
    }

    let paths_d = Path::new("/etc/paths.d");
    if let Ok(entries) = fs::read_dir(paths_d) {
        let mut entries = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .collect::<Vec<_>>();
        entries.sort();

        for entry in entries {
            for line in read_nonempty_lines(&entry) {
                dirs.push(PathBuf::from(line));
            }
        }
    }

    dedupe_paths(dirs)
}

#[cfg(target_os = "macos")]
fn read_nonempty_lines(path: &Path) -> Vec<String> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Vec::new();
    };

    contents
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(target_os = "macos")]
fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::new();

    for path in paths {
        let key = path.to_string_lossy().into_owned();
        if seen.insert(key) {
            unique.push(path);
        }
    }

    unique
}

fn find_executable_in_dir(dir: &Path, executable: &str) -> Option<PathBuf> {
    if executable.trim().is_empty() {
        return None;
    }

    #[cfg(windows)]
    {
        for candidate in windows_executable_candidates(executable) {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }

    #[cfg(not(windows))]
    {
        let full = dir.join(executable);
        if full.is_file() {
            return Some(full);
        }
    }

    None
}

#[cfg(windows)]
fn windows_executable_candidates(executable: &str) -> Vec<String> {
    let has_extension = Path::new(executable).extension().is_some();
    if has_extension {
        return vec![executable.to_string()];
    }

    let pathext = env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    let extensions = pathext
        .split(';')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();

    if extensions.is_empty() {
        return vec![executable.to_string()];
    }

    extensions
        .into_iter()
        .map(|ext| format!("{executable}{ext}"))
        .collect()
}

#[cfg(unix)]
fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Reads one explicitly-set env var back off a built `Command`. `get_envs` yields
    /// `(key, None)` for a *removed* var, which is why the value is an `Option` inside an `Option`
    /// and both layers are flattened here.
    fn command_env_value(cmd: &Command, key: &str) -> Option<String> {
        cmd.get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new(key))
            .and_then(|(_, v)| v)
            .map(|v| v.to_string_lossy().into_owned())
    }

    #[test]
    fn codex_lifecycle_lines_are_not_counted_as_meaningful() {
        assert!(!is_meaningful_codex_stdout_line(
            "Reading prompt from stdin..."
        ));
        assert!(!is_meaningful_codex_stdout_line(
            r#"{"type":"thread.started"}"#
        ));
        assert!(!is_meaningful_codex_stdout_line(
            r#"{"type":"turn.started"}"#
        ));
        assert!(is_meaningful_codex_stdout_line(
            r#"{"type":"error","message":"Reconnecting..."}"#
        ));
    }

    #[test]
    fn codex_failure_summary_appears_when_no_meaningful_output_exists() {
        let diagnostics = StreamDiagnostics {
            stdout_lines: 2,
            stderr_lines: 1,
            meaningful_stdout_lines: 0,
            last_stdout: Some(r#"{"type":"turn.started"}"#.into()),
            last_stderr: Some("network failure".into()),
        };

        let summary = build_codex_failure_summary("codex", &diagnostics, Some(1));
        assert!(summary.is_some());
        let summary = summary.unwrap_or_default();
        assert!(summary.contains("finished without meaningful output"));
        assert!(summary.contains("stderr_lines=1"));
        assert!(summary.contains("last_stderr=network failure"));
    }

    #[test]
    fn cancel_missing_agent_cli_run_returns_false() {
        let run_id = format!("missing-run-{}", uuid::Uuid::new_v4());
        let result = cancel(run_id.clone());

        assert_eq!(result, Ok(false));
        assert_eq!(take_pending_agent_cli_cancellation(&run_id), Ok(true));
    }

    #[cfg(unix)]
    #[test]
    fn pending_cancel_prevents_late_run_registration() {
        let run_id = format!("pending-cancel-run-{}", uuid::Uuid::new_v4());
        assert_eq!(cancel(run_id.clone()), Ok(false));

        let child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep process");
        let child = Arc::new(Mutex::new(child));

        assert_eq!(
            insert_agent_cli_run(run_id.clone(), child.clone()),
            Ok(false)
        );
        assert!(!is_agent_cli_run_registered(&run_id));

        let mut child = child.lock().expect("child lock");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn agent_cli_final_event_json_marks_canceled_runs() {
        let event = agent_cli_final_event_json(
            "run-123",
            AgentCliRunFinalStatus::Canceled,
            None,
            Some("Agent run was canceled."),
        );
        let value: serde_json::Value = serde_json::from_str(&event).expect("valid final event");

        assert_eq!(value["type"], "_final");
        assert_eq!(value["runId"], "run-123");
        assert_eq!(value["status"], "canceled");
        assert!(value["exitCode"].is_null());
        assert_eq!(value["message"], "Agent run was canceled.");
    }

    #[cfg(unix)]
    #[test]
    fn cancel_agent_cli_run_kills_term_ignoring_descendant() {
        let _serial = crate::pty::PROCESS_KILL_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let temp = tempfile::tempdir().expect("tempdir");
        let pid_file = temp.path().join("child.pid");
        let script = format!(
                "nohup /bin/sh -c 'trap \"\" TERM HUP; while :; do sleep 1; done' </dev/null >/dev/null 2>&1 & echo $! > '{}' ; wait",
                pid_file.display()
            );
        let child = Command::new("/bin/sh")
            .args(["-c", &script])
            .spawn()
            .expect("spawn");
        let root_pid = child.id();
        let child = Arc::new(Mutex::new(child));
        let run_id = format!("test-tree-{}", uuid::Uuid::new_v4());
        insert_agent_cli_run(run_id.clone(), child.clone()).expect("register");
        let deadline = Instant::now() + Duration::from_secs(2);
        while !pid_file.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let pid: i32 = fs::read_to_string(pid_file)
            .expect("pid file")
            .trim()
            .parse()
            .expect("pid");
        cancel(run_id).expect("cancel");
        let output = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .expect("ps");
        let running = output.status.success()
            && output
                .stdout
                .iter()
                .copied()
                .find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|state| state != b'Z');
        // The RED run must clean its own fixture rather than leave an orphan behind.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::kill(root_pid as i32, libc::SIGKILL);
        }
        child.lock().expect("child").wait().expect("wait");
        assert!(!running, "headless descendant survived cancellation");
    }

    #[cfg(unix)]
    #[test]
    fn cancel_agent_cli_run_kills_registered_child() {
        let run_id = format!("test-run-{}", uuid::Uuid::new_v4());
        let child = Command::new("sh")
            .args(["-c", "sleep 30"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn sleep process");
        let child = Arc::new(Mutex::new(child));

        assert_eq!(insert_agent_cli_run(run_id.clone(), child.clone()), Ok(true));

        assert_eq!(cancel(run_id.clone()), Ok(true));
        assert!(!is_agent_cli_run_registered(&run_id));

        let exited = (0..40).any(|_| {
            let mut child = child.lock().expect("child lock");
            let status = child.try_wait().expect("try wait child");
            if status.is_some() {
                true
            } else {
                thread::sleep(Duration::from_millis(25));
                false
            }
        });

        assert!(exited, "cancelled process should exit promptly");
        let _ = remove_agent_cli_run(&run_id);
    }

    #[test]
    fn explicit_path_is_detected_without_path_lookup() {
        let temp = std::env::temp_dir().join("lotus_agent_cli_explicit_path_test");
        let _ = fs::write(&temp, "echo test");

        let resolved = resolve_explicit_path(temp.to_string_lossy().as_ref());
        assert!(resolved.is_some());

        let _ = fs::remove_file(temp);
    }

    #[test]
    fn path_like_detection_handles_common_forms() {
        assert!(looks_like_path("/usr/local/bin/codex"));
        assert!(looks_like_path("./node_modules/.bin/codex"));
        assert!(looks_like_path(r"C:\tools\codex.exe"));
        assert!(!looks_like_path("codex"));
    }

    #[test]
    fn shell_alias_parser_extracts_command_tokens() {
        let parsed =
            parse_shell_alias_definition("alias csp='ccs --dangerously-skip-permissions'", "csp");

        assert_eq!(
            parsed,
            Some(vec![
                "ccs".to_string(),
                "--dangerously-skip-permissions".to_string()
            ])
        );
    }

    #[test]
    fn shell_word_splitter_handles_quotes_and_spaces() {
        let parsed = split_shell_words(r#"ccs --profile "team alpha" --flag='two words'"#);

        assert_eq!(
            parsed,
            Some(vec![
                "ccs".to_string(),
                "--profile".to_string(),
                "team alpha".to_string(),
                "--flag=two words".to_string(),
            ])
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_path_file_reader_ignores_blank_lines() {
        let temp = std::env::temp_dir().join("lotus_agent_cli_macos_paths");
        let _ = fs::write(&temp, "/usr/local/bin\n\n/opt/homebrew/bin\n");

        let lines = read_nonempty_lines(&temp);
        assert_eq!(lines, vec!["/usr/local/bin", "/opt/homebrew/bin"]);

        let _ = fs::remove_file(temp);
    }

    #[test]
    fn image_attachment_prompt_prefix_lists_staged_paths() {
        let prompt = prepend_image_attachment_paths_to_prompt(
            "User: Analyze this screenshot".to_string(),
            &[
                PathBuf::from("/tmp/request-1/screenshot.png"),
                PathBuf::from("/tmp/request-1/error-state.jpg"),
            ],
        );

        assert!(prompt.contains("Visual analysis instructions"));
        assert!(prompt.contains(
            "layout, visual hierarchy, spacing, contrast, labeling, and obvious anomalies"
        ));
        assert!(prompt.contains("dashboard or UI screenshot"));
        assert!(prompt.contains("Analyze these images"));
        assert!(prompt.contains("/tmp/request-1/screenshot.png"));
        assert!(prompt.contains("/tmp/request-1/error-state.jpg"));
        assert!(prompt.contains("User: Analyze this screenshot"));
    }

    #[test]
    fn image_attachment_root_dir_prefers_workspace_scope_when_available() {
        let workspace = std::env::temp_dir().join("lotus_agent_cli_workspace_scope");
        fs::create_dir_all(&workspace).expect("create workspace");

        let root = resolve_image_attachment_root_dir(workspace.to_str());
        assert_eq!(root, workspace.join(AGENT_CLI_IMAGE_WORKSPACE_DIR));

        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn image_attachment_root_dir_falls_back_to_system_temp_without_workspace() {
        let root = resolve_image_attachment_root_dir(None);
        assert_eq!(root, std::env::temp_dir());
    }

    #[test]
    fn cleanup_agent_cli_temp_dir_allows_prefixed_system_temp_dir() {
        let temp_dir = std::env::temp_dir().join(format!(
            "{AGENT_CLI_IMAGE_TEMP_PREFIX}cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        fs::write(temp_dir.join("image.png"), b"png").expect("write temp file");

        cleanup_temp_dir(temp_dir.to_string_lossy().into_owned())
            .expect("cleanup temp dir");

        assert!(!temp_dir.exists());
    }

    #[test]
    fn cleanup_agent_cli_temp_dir_rejects_unprefixed_system_temp_dir() {
        let temp_dir =
            std::env::temp_dir().join(format!("lotus-other-cleanup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&temp_dir).expect("create temp dir");
        fs::write(temp_dir.join("keep.txt"), b"keep").expect("write temp file");

        let error = cleanup_temp_dir(temp_dir.to_string_lossy().into_owned())
            .expect_err("unprefixed dir must be rejected");

        assert!(error.contains("expected prefix"));
        assert!(temp_dir.exists());
        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn cleanup_agent_cli_temp_dir_rejects_prefixed_non_agent_cli_parent() {
        let parent =
            std::env::temp_dir().join(format!("lotus-cleanup-parent-{}", uuid::Uuid::new_v4()));
        let temp_dir = parent.join(format!("{AGENT_CLI_IMAGE_TEMP_PREFIX}nested"));
        fs::create_dir_all(&temp_dir).expect("create nested temp dir");

        let error = cleanup_temp_dir(temp_dir.to_string_lossy().into_owned())
            .expect_err("prefixed dir outside allowed parents must be rejected");

        assert!(error.contains("outside agent CLI temp storage"));
        assert!(temp_dir.exists());
        let _ = fs::remove_dir_all(&parent);
    }

    #[test]
    fn cleanup_agent_cli_temp_dir_rejects_prefixed_project_root_child() {
        let project_root =
            std::env::temp_dir().join(format!("lotus-cleanup-project-{}", uuid::Uuid::new_v4()));
        let temp_dir = project_root.join(format!("{AGENT_CLI_IMAGE_TEMP_PREFIX}project-child"));
        fs::create_dir_all(&temp_dir).expect("create project child temp dir");

        let error = cleanup_temp_dir(temp_dir.to_string_lossy().into_owned())
            .expect_err("prefixed dir under a project root must be rejected");

        assert!(error.contains("outside agent CLI temp storage"));
        assert!(temp_dir.exists());
        let _ = fs::remove_dir_all(&project_root);
    }

    #[test]
    fn cleanup_agent_cli_temp_dir_rejects_prefixed_home_child() {
        let home_root =
            std::env::temp_dir().join(format!("lotus-cleanup-home-{}", uuid::Uuid::new_v4()));
        let temp_dir = home_root.join(format!("{AGENT_CLI_IMAGE_TEMP_PREFIX}home-child"));
        fs::create_dir_all(&temp_dir).expect("create home child temp dir");

        let error = cleanup_temp_dir(temp_dir.to_string_lossy().into_owned())
            .expect_err("prefixed dir under a home-like root must be rejected");

        assert!(error.contains("outside agent CLI temp storage"));
        assert!(temp_dir.exists());
        let _ = fs::remove_dir_all(&home_root);
    }

    #[test]
    fn cleanup_agent_cli_temp_dir_allows_workspace_image_root() {
        let workspace =
            std::env::temp_dir().join(format!("lotus-cleanup-workspace-{}", uuid::Uuid::new_v4()));
        let root = workspace.join(AGENT_CLI_IMAGE_WORKSPACE_DIR);
        let temp_dir = root.join(format!("{AGENT_CLI_IMAGE_TEMP_PREFIX}workspace"));
        fs::create_dir_all(&temp_dir).expect("create workspace temp dir");
        fs::write(temp_dir.join("image.png"), b"png").expect("write temp file");

        cleanup_temp_dir(temp_dir.to_string_lossy().into_owned())
            .expect("cleanup workspace temp dir");

        assert!(!temp_dir.exists());
        let _ = fs::remove_dir_all(&workspace);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_agent_cli_temp_dir_rejects_symlink() {
        let target =
            std::env::temp_dir().join(format!("lotus-cleanup-target-{}", uuid::Uuid::new_v4()));
        let link = std::env::temp_dir().join(format!(
            "{AGENT_CLI_IMAGE_TEMP_PREFIX}symlink-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&target).expect("create symlink target");
        std::os::unix::fs::symlink(&target, &link).expect("create symlink");

        let error = cleanup_temp_dir(link.to_string_lossy().into_owned())
            .expect_err("symlink must be rejected");

        assert!(error.contains("symlink"));
        assert!(target.exists());
        let _ = fs::remove_file(&link);
        let _ = fs::remove_dir_all(&target);
    }

    #[test]
    fn stale_temp_dir_candidate_requires_expected_prefix_and_age() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(10_000);
        let temp_dir =
            std::env::temp_dir().join(format!("{AGENT_CLI_IMAGE_TEMP_PREFIX}candidate-check"));
        fs::create_dir_all(&temp_dir).expect("create temp dir");

        assert!(!is_stale_agent_cli_temp_dir_candidate(&temp_dir, now));
        assert!(is_stale_agent_cli_temp_dir(
            &format!("{AGENT_CLI_IMAGE_TEMP_PREFIX}orphan"),
            SystemTime::UNIX_EPOCH,
            SystemTime::UNIX_EPOCH + AGENT_CLI_IMAGE_TEMP_RETENTION + Duration::from_secs(10),
        ));
        assert!(!is_stale_agent_cli_temp_dir(
            "lotus-other-temp-dir",
            SystemTime::UNIX_EPOCH,
            SystemTime::UNIX_EPOCH + AGENT_CLI_IMAGE_TEMP_RETENTION + Duration::from_secs(10),
        ));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    /// The bug this guards, measured 2026-09-03 on this machine: `Lotus.app` launched from Finder
    /// has **no** `CLAUDE_CONFIG_DIR` and `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. A child that
    /// inherits only that env resolves its Claude config to `~/.claude`, whose keychain entry holds
    /// no `claudeAiOauth` on a `ccs` machine — so `claude --print` returns
    /// `Failed to authenticate: OAuth session expired and could not be refreshed` while the
    /// operator's real profile credential is valid. The NL command bar then shows a "session
    /// expired" banner whose advertised remedy (`claude /login` in a terminal) cannot fix it,
    /// because a terminal gets the login env and re-logs a profile that was never the one failing.
    ///
    /// `pty::apply_inherited_env` and `bridge_chat::apply_login_env` already layer this env for
    /// their spawns; this module was the only CLI spawn path in the app that did not.
    #[test]
    fn agent_cli_command_carries_the_login_shell_claude_config_dir() {
        let mut login_env = HashMap::new();
        login_env.insert(
            "CLAUDE_CONFIG_DIR".to_string(),
            "/Users/operator/.ccs/instances/work".to_string(),
        );

        let cmd = build_agent_cli_command("claude", &[], None, &login_env);

        assert_eq!(
            command_env_value(&cmd, "CLAUDE_CONFIG_DIR").as_deref(),
            Some("/Users/operator/.ccs/instances/work"),
            "the spawned agent must read the profile the operator is actually logged into",
        );
    }

    /// The masked case of the test above: a default agent gets `CLAUDE_CONFIG_DIR=""` from
    /// `shell_env::default_agent_env`, meaning "use the standard login". Handing that to the child
    /// as a value resolves Claude's config home to a relative `""` — i.e. this process's cwd — and
    /// spills `projects/`, `skills/synced/`, `plugins/` and friends into the repo being worked on.
    #[test]
    fn agent_cli_command_unsets_a_masked_claude_config_dir_rather_than_blanking_it() {
        let login_env = HashMap::from([("CLAUDE_CONFIG_DIR".to_string(), String::new())]);

        let cmd = build_agent_cli_command("claude", &[], None, &login_env);

        assert_eq!(
            cmd.get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new("CLAUDE_CONFIG_DIR"))
                .map(|(_, value)| value),
            Some(None),
            "the mask must arrive as a removal, so `claude` falls back to ~/.claude, not to cwd",
        );
    }

    /// The login shell exports a real `TERM` (`xterm-256color` here) and may export `NO_COLOR=0`.
    /// Layering that env in must not reach the child: this parser consumes `stream-json` on stdout,
    /// so an interactive terminal type invites ANSI colour into the very lines
    /// `parse_claude_stream_json` has to read as JSON. The module's own vars are a deliberate
    /// choice about a non-interactive stream and outrank the operator's shell.
    #[test]
    fn agent_cli_command_keeps_its_own_stream_vars_over_the_login_shell() {
        let mut login_env = HashMap::new();
        login_env.insert("TERM".to_string(), "xterm-256color".to_string());
        login_env.insert("NO_COLOR".to_string(), "0".to_string());
        login_env.insert("OTEL_SDK_DISABLED".to_string(), "false".to_string());

        let cmd = build_agent_cli_command("claude", &[], None, &login_env);

        assert_eq!(command_env_value(&cmd, "TERM").as_deref(), Some("dumb"));
        assert_eq!(command_env_value(&cmd, "NO_COLOR").as_deref(), Some("1"));
        assert_eq!(
            command_env_value(&cmd, "OTEL_SDK_DISABLED").as_deref(),
            Some("true"),
        );
    }
}
