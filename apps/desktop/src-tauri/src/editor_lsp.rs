//! Language servers for the editor: errors as you type, hover, go to definition, rename,
//! completion — what VS Code gets from the same servers.
//!
//! Lotus ships no server. Each language has a list of known servers, found where the user
//! installed them: the project's `node_modules/.bin` (TypeScript), then the login shell's `PATH`.
//! A server that is not installed is reported with the command that installs it.
//!
//! The server runs as a child process (locally, or on the SSH host through the workspace's
//! connection) and speaks LSP over stdio. Here the stdio is only framed: each message from the
//! server goes to the webview through a channel, as text, and each message from the webview is
//! written to the server with its `Content-Length` header. The protocol itself is the webview's
//! (`services/lsp/`).
//!
//! The webview can only start a binary this module found for it (`resolve_*`): the command a
//! start names must be one a resolve returned, with that resolve's arguments.

use crate::no_window::NoWindow;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::ipc::Channel;

use crate::cli_tools::SshToolTarget;
use crate::error::other;
use crate::AppError;

/// A message larger than this ends the session: no real server sends one.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
/// The end of the server's stderr kept for the error shown when it stops.
const STDERR_TAIL_BYTES: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootRule {
    /// One server for the whole workspace folder.
    Workspace,
    /// The closest folder holding one of these, else the workspace folder.
    Nearest(&'static [&'static str]),
    /// The folder nearest the workspace root holding one of these (a Cargo workspace, not each
    /// of its crates), else the workspace folder.
    Outermost(&'static [&'static str]),
}

#[derive(Debug, Clone, Copy)]
pub struct LspCandidate {
    pub bin: &'static str,
    pub args: &'static [&'static str],
    /// Installed with npm: looked for in the project's `node_modules/.bin` first.
    pub node_package: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct LspServerSpec {
    pub id: &'static str,
    pub label: &'static str,
    /// Tried in order; the first one installed is used.
    pub candidates: &'static [LspCandidate],
    pub root: RootRule,
    pub install_hint: &'static str,
}

const fn candidate(bin: &'static str, args: &'static [&'static str], node_package: bool) -> LspCandidate {
    LspCandidate { bin, args, node_package }
}

pub const SERVERS: &[LspServerSpec] = &[
    LspServerSpec {
        id: "typescript",
        label: "TypeScript",
        candidates: &[
            candidate("typescript-language-server", &["--stdio"], true),
            candidate("vtsls", &["--stdio"], true),
        ],
        root: RootRule::Workspace,
        install_hint: "npm install -g typescript-language-server typescript",
    },
    LspServerSpec {
        id: "rust",
        label: "rust-analyzer",
        candidates: &[candidate("rust-analyzer", &[], false)],
        root: RootRule::Outermost(&["Cargo.toml"]),
        install_hint: "rustup component add rust-analyzer",
    },
    LspServerSpec {
        id: "python",
        label: "Python",
        candidates: &[
            candidate("basedpyright-langserver", &["--stdio"], true),
            candidate("pyright-langserver", &["--stdio"], true),
            candidate("pylsp", &[], false),
        ],
        root: RootRule::Nearest(&["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json"]),
        install_hint: "npm install -g pyright",
    },
    LspServerSpec {
        id: "go",
        label: "gopls",
        candidates: &[candidate("gopls", &[], false)],
        root: RootRule::Nearest(&["go.mod"]),
        install_hint: "go install golang.org/x/tools/gopls@latest",
    },
    LspServerSpec {
        id: "clangd",
        label: "clangd",
        candidates: &[candidate("clangd", &[], false)],
        root: RootRule::Nearest(&["compile_commands.json", "compile_flags.txt", ".clangd"]),
        install_hint: "brew install llvm",
    },
];

pub fn server_spec(id: &str) -> Result<&'static LspServerSpec, AppError> {
    SERVERS
        .iter()
        .find(|spec| spec.id == id)
        .ok_or_else(|| other(format!("Unknown language server: {id}")))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LspResolution {
    pub server_id: String,
    pub label: String,
    /// The folder the server is started in and told is the workspace.
    pub project_root: String,
    /// The server binary, absolute; `None` when none of the candidates is installed.
    pub command: Option<String>,
    pub install_hint: String,
}

/// Folders from the file's own up to the workspace root, closest first. A file outside the
/// root has only its own folder.
pub fn ancestor_dirs(file_path: &str, root_dir: &str) -> Vec<String> {
    let root = trim_dir(root_dir);
    let parent = match file_path.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => file_path[..index].to_string(),
        None => return vec![root.to_string()],
    };
    let inside = parent == root || root == "/" || parent.starts_with(&format!("{root}/"));
    if !inside {
        return vec![parent];
    }
    let mut dirs = Vec::new();
    let mut current = parent;
    loop {
        dirs.push(current.clone());
        if current == root {
            break;
        }
        match current.rfind('/') {
            Some(0) => current = "/".to_string(),
            Some(index) => current.truncate(index),
            None => break,
        }
        if current.len() < root.len() {
            break;
        }
    }
    dirs
}

fn trim_dir(dir: &str) -> &str {
    let trimmed = dir.trim_end_matches('/');
    if trimmed.is_empty() {
        "/"
    } else {
        trimmed
    }
}

fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The paths a resolve must test: root markers (exists) and npm binaries (executable).
fn probe_paths(spec: &LspServerSpec, dirs: &[String]) -> (Vec<String>, Vec<String>) {
    let markers: &[&str] = match spec.root {
        RootRule::Workspace => &[],
        RootRule::Nearest(markers) | RootRule::Outermost(markers) => markers,
    };
    let marker_paths = dirs
        .iter()
        .flat_map(|dir| markers.iter().map(move |marker| join(dir, marker)))
        .collect();
    let bin_paths = spec
        .candidates
        .iter()
        .filter(|candidate| candidate.node_package)
        .flat_map(|candidate| dirs.iter().map(move |dir| join(dir, &format!("node_modules/.bin/{}", candidate.bin))))
        .collect();
    (marker_paths, bin_paths)
}

/// Pure over its probes: `exists` for markers, `executable` for npm binaries, `which` for PATH.
pub fn resolve_with(
    spec: &LspServerSpec,
    file_path: &str,
    root_dir: &str,
    exists: impl Fn(&str) -> bool,
    executable: impl Fn(&str) -> bool,
    which: impl Fn(&str) -> Option<String>,
) -> (LspResolution, Option<&'static LspCandidate>) {
    let dirs = ancestor_dirs(file_path, root_dir);
    let has_marker = |dir: &String, markers: &[&str]| markers.iter().any(|marker| exists(&join(dir, marker)));
    let fallback = || dirs.last().cloned().unwrap_or_else(|| trim_dir(root_dir).to_string());
    let project_root = match spec.root {
        RootRule::Workspace => fallback(),
        RootRule::Nearest(markers) => dirs.iter().find(|dir| has_marker(dir, markers)).cloned().unwrap_or_else(fallback),
        RootRule::Outermost(markers) => dirs.iter().rev().find(|dir| has_marker(dir, markers)).cloned().unwrap_or_else(fallback),
    };
    let mut found = None;
    for candidate in spec.candidates {
        if candidate.node_package {
            let local = dirs
                .iter()
                .map(|dir| join(dir, &format!("node_modules/.bin/{}", candidate.bin)))
                .find(|path| executable(path));
            if let Some(path) = local {
                found = Some((path, candidate));
                break;
            }
        }
        if let Some(path) = which(candidate.bin) {
            found = Some((path, candidate));
            break;
        }
    }
    let resolution = LspResolution {
        server_id: spec.id.to_string(),
        label: spec.label.to_string(),
        project_root,
        command: found.as_ref().map(|(path, _)| path.clone()),
        install_hint: spec.install_hint.to_string(),
    };
    (resolution, found.map(|(_, candidate)| candidate))
}

/// What a start may run, per place: the binaries resolves found, with their arguments and the
/// `PATH` they need (a remote one, for SSH).
#[derive(Debug, Clone)]
struct Allowed {
    args: Vec<String>,
    path_env: Option<String>,
}

fn allowed() -> &'static Mutex<HashMap<(String, String), Allowed>> {
    static ALLOWED: OnceLock<Mutex<HashMap<(String, String), Allowed>>> = OnceLock::new();
    ALLOWED.get_or_init(|| Mutex::new(HashMap::new()))
}

fn place_key(target: Option<&SshToolTarget>) -> String {
    match target {
        None => "local".to_string(),
        Some(target) => format!(
            "ssh:{}@{}:{}",
            target.user.as_deref().unwrap_or(""),
            target.host,
            target.port.unwrap_or(22)
        ),
    }
}

fn remember(target: Option<&SshToolTarget>, resolution: &LspResolution, candidate: Option<&LspCandidate>, path_env: Option<String>) {
    let (Some(command), Some(candidate)) = (resolution.command.as_ref(), candidate) else {
        return;
    };
    let args = candidate.args.iter().map(|arg| arg.to_string()).collect();
    allowed()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert((place_key(target), command.clone()), Allowed { args, path_env });
}

fn take_allowed(target: Option<&SshToolTarget>, command: &str) -> Result<Allowed, AppError> {
    allowed()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(&(place_key(target), command.to_string()))
        .cloned()
        .ok_or_else(|| other("This language server was not found by Lotus; it cannot be started."))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

pub fn resolve_local(server_id: &str, file_path: &str, root_dir: &str) -> Result<LspResolution, AppError> {
    let spec = server_spec(server_id)?;
    let (resolution, candidate) = resolve_with(
        spec,
        file_path,
        root_dir,
        |path| Path::new(path).exists(),
        |path| is_executable(Path::new(path)),
        crate::cli_detect::find_executable,
    );
    remember(None, &resolution, candidate, None);
    Ok(resolution)
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

const REMOTE_TAG: &str = "LOTUS_LSP";

/// One script for every probe a resolve needs on the host, read back by `parse_remote_probe`.
/// Lines are tagged: a login shell can print its own text first.
pub fn build_remote_probe_script(spec: &LspServerSpec, file_path: &str, root_dir: &str) -> String {
    let dirs = ancestor_dirs(file_path, root_dir);
    let (markers, bins) = probe_paths(spec, &dirs);
    let list = |paths: &[String]| paths.iter().map(|path| quote(path)).collect::<Vec<_>>().join(" ");
    let mut script = String::from(crate::cli_tools::SH_GLOB_PRELUDE);
    if !markers.is_empty() {
        script.push_str(&format!(
            "for p in {}; do [ -e \"$p\" ] && printf '{REMOTE_TAG}\\tE\\t%s\\n' \"$p\"; done\n",
            list(&markers)
        ));
    }
    if !bins.is_empty() {
        script.push_str(&format!(
            "for p in {}; do [ -f \"$p\" ] && [ -x \"$p\" ] && printf '{REMOTE_TAG}\\tX\\t%s\\n' \"$p\"; done\n",
            list(&bins)
        ));
    }
    let names = spec.candidates.iter().map(|candidate| quote(candidate.bin)).collect::<Vec<_>>().join(" ");
    script.push_str(&format!(
        "for b in {names}; do c=$(command -v \"$b\" 2>/dev/null) && printf '{REMOTE_TAG}\\tW\\t%s\\t%s\\n' \"$b\" \"$c\"; done\n"
    ));
    script.push_str(&format!("printf '{REMOTE_TAG}\\tP\\t%s\\n' \"$PATH\"\n"));
    script
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct RemoteProbe {
    pub existing: HashSet<String>,
    pub executable: HashSet<String>,
    pub which: HashMap<String, String>,
    pub path_env: Option<String>,
}

pub fn parse_remote_probe(output: &[u8]) -> RemoteProbe {
    let mut probe = RemoteProbe::default();
    for line in String::from_utf8_lossy(output).lines() {
        let Some(rest) = line.strip_prefix(&format!("{REMOTE_TAG}\t")) else {
            continue;
        };
        let mut parts = rest.splitn(3, '\t');
        match (parts.next(), parts.next(), parts.next()) {
            (Some("E"), Some(path), None) => {
                probe.existing.insert(path.to_string());
            }
            (Some("X"), Some(path), None) => {
                probe.executable.insert(path.to_string());
            }
            // `command -v` prints an alias or a function name for those; only a path can run.
            (Some("W"), Some(bin), Some(path)) if path.starts_with('/') => {
                probe.which.insert(bin.to_string(), path.to_string());
            }
            (Some("P"), Some(path), None) => probe.path_env = Some(path.to_string()),
            _ => {}
        }
    }
    probe
}

pub fn resolve_ssh(
    target: &SshToolTarget,
    server_id: &str,
    file_path: &str,
    root_dir: &str,
    transport: Option<&crate::remote_transport::RemoteTransport>,
) -> Result<LspResolution, AppError> {
    let spec = server_spec(server_id)?;
    let script = build_remote_probe_script(spec, file_path, root_dir);
    // `-lic`: only an interactive login shell has the PATH that `.zshrc` sets (nvm, cargo, go).
    let output = crate::cli_tools::run_ssh_shell_command(
        target,
        &crate::cli_tools::login_shell_script(&script),
        crate::cli_tools::SshCommandMode::NoTty,
        transport,
    )?;
    let probe = parse_remote_probe(&output.stdout);
    if probe.path_env.is_none() {
        return Err(other(crate::cli_tools::read_command_error(&output)));
    }
    let (resolution, candidate) = resolve_with(
        spec,
        file_path,
        root_dir,
        |path| probe.existing.contains(path),
        |path| probe.executable.contains(path),
        |bin| probe.which.get(bin).cloned(),
    );
    remember(Some(target), &resolution, candidate, probe.path_env.clone());
    Ok(resolution)
}

// ── Sessions ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LspEvent {
    /// One message from the server, as the JSON text it sent.
    Message { data: String },
    /// The server stopped (or could not be read any more). `stderr` is the end of what it said.
    Exit { code: Option<i32>, stderr: String },
}

struct Session {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
}

fn sessions() -> &'static Mutex<HashMap<String, Arc<Session>>> {
    static SESSIONS: OnceLock<Mutex<HashMap<String, Arc<Session>>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reads one LSP message. Headers other than `Content-Length` are skipped, and so is any line
/// before them that is not a header (a login shell's greeting over SSH). `None` at the end.
pub fn read_message<R: BufRead>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut length: Option<usize> = None;
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line)? == 0 {
            return Ok(None);
        }
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            if length.is_some() {
                break;
            }
            continue;
        }
        let lower = text.to_ascii_lowercase();
        if let Some(index) = lower.find("content-length:") {
            let value = text[index + "content-length:".len()..].trim();
            length = value.parse::<usize>().ok();
        }
    }
    let length = length.unwrap_or(0);
    if length > MAX_MESSAGE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("language server message of {length} bytes"),
        ));
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    Ok(Some(body))
}

pub fn frame_message(message: &str) -> Vec<u8> {
    let mut framed = format!("Content-Length: {}\r\n\r\n", message.len()).into_bytes();
    framed.extend_from_slice(message.as_bytes());
    framed
}

fn spawn_session(mut command: Command, on_event: Channel<LspEvent>) -> Result<String, AppError> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(AppError::Io)?;
    let stdin = child.stdin.take().ok_or_else(|| other("language server has no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| other("language server has no stdout"))?;
    let stderr = child.stderr.take().ok_or_else(|| other("language server has no stderr"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let session = Arc::new(Session {
        child: Mutex::new(child),
        stdin: Mutex::new(stdin),
    });
    sessions()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(id.clone(), session.clone());

    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let stderr_tail = tail.clone();
    let stderr_thread = std::thread::spawn(move || {
        let mut stderr = stderr;
        let mut chunk = [0u8; 4096];
        while let Ok(read) = stderr.read(&mut chunk) {
            if read == 0 {
                break;
            }
            let mut tail = stderr_tail.lock().unwrap_or_else(|error| error.into_inner());
            tail.extend_from_slice(&chunk[..read]);
            if tail.len() > STDERR_TAIL_BYTES {
                let cut = tail.len() - STDERR_TAIL_BYTES;
                tail.drain(..cut);
            }
        }
    });

    let session_id = id.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Ok(Some(body)) = read_message(&mut reader) {
            let data = String::from_utf8_lossy(&body).into_owned();
            if on_event.send(LspEvent::Message { data }).is_err() {
                break;
            }
        }
        let code = {
            let mut child = session.child.lock().unwrap_or_else(|error| error.into_inner());
            // Stdout closed: the server is exiting, or wedged; it must not outlive its session.
            if !matches!(child.try_wait(), Ok(Some(_))) {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if !matches!(child.try_wait(), Ok(Some(_))) {
                    let _ = child.kill();
                }
            }
            child.wait().ok().and_then(|status| status.code())
        };
        let _ = stderr_thread.join();
        sessions()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&session_id);
        let stderr = String::from_utf8_lossy(&tail.lock().unwrap_or_else(|error| error.into_inner())).into_owned();
        let _ = on_event.send(LspEvent::Exit { code, stderr });
    });
    Ok(id)
}

fn checked_root(project_root: &str) -> Result<&str, AppError> {
    if !project_root.starts_with('/') || project_root.contains('\0') {
        return Err(other("Language server folder must be an absolute path."));
    }
    Ok(project_root)
}

pub fn start_local(command: &str, project_root: &str, on_event: Channel<LspEvent>) -> Result<String, AppError> {
    let allowed = take_allowed(None, command)?;
    let root = checked_root(project_root)?;
    let mut process = Command::new(command).no_window();
    process.args(&allowed.args).current_dir(PathBuf::from(root));
    // A dock launch has a minimal PATH; an npm server's `#!/usr/bin/env node` needs the user's.
    if let Some(path) = crate::shell_env::user_login_env().get("PATH") {
        process.env("PATH", path);
    }
    spawn_session(process, on_event)
}

pub fn build_remote_start_command(command: &str, args: &[String], project_root: &str, path_env: Option<&str>) -> String {
    let mut line = format!("cd {} && ", quote(project_root));
    if let Some(path) = path_env {
        line.push_str(&format!("PATH={} ", quote(path)));
    }
    line.push_str("exec ");
    line.push_str(&quote(command));
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    line
}

pub fn start_ssh(
    target: &SshToolTarget,
    command: &str,
    project_root: &str,
    on_event: Channel<LspEvent>,
    transport: Option<&crate::remote_transport::RemoteTransport>,
) -> Result<String, AppError> {
    let allowed = take_allowed(Some(target), command)?;
    let root = checked_root(project_root)?;
    let line = build_remote_start_command(command, &allowed.args, root, allowed.path_env.as_deref());
    let process = crate::cli_tools::build_ssh_command(target, &line, crate::cli_tools::SshCommandMode::NoTty, transport)?;
    spawn_session(process, on_event)
}

pub fn send(session_id: &str, message: &str) -> Result<(), AppError> {
    let session = sessions()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(session_id)
        .cloned()
        .ok_or_else(|| other("Language server is not running."))?;
    let mut stdin = session.stdin.lock().unwrap_or_else(|error| error.into_inner());
    stdin.write_all(&frame_message(message)).map_err(AppError::Io)?;
    stdin.flush().map_err(AppError::Io)
}

/// Ends the server. The webview asks it to shut down first; this is for one that does not.
pub fn stop(session_id: &str) {
    let session = sessions()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(session_id);
    if let Some(session) = session {
        let _ = session.child.lock().unwrap_or_else(|error| error.into_inner()).kill();
    }
}

/// Every server goes with the app.
pub fn stop_all() {
    let all: Vec<Arc<Session>> = sessions()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .drain()
        .map(|(_, session)| session)
        .collect();
    for session in all {
        let _ = session.child.lock().unwrap_or_else(|error| error.into_inner()).kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn spec(id: &str) -> &'static LspServerSpec {
        server_spec(id).unwrap()
    }

    #[test]
    fn ancestors_run_from_the_file_up_to_the_root() {
        assert_eq!(
            ancestor_dirs("/repo/apps/desktop/src/a.ts", "/repo/"),
            vec!["/repo/apps/desktop/src", "/repo/apps/desktop", "/repo/apps", "/repo"]
        );
        assert_eq!(ancestor_dirs("/repo/a.ts", "/repo"), vec!["/repo"]);
        // A sibling that only shares the prefix is outside.
        assert_eq!(ancestor_dirs("/repo2/a.ts", "/repo"), vec!["/repo2"]);
        assert_eq!(ancestor_dirs("/a/b.rs", "/"), vec!["/a", "/"]);
    }

    #[test]
    fn rust_uses_the_outermost_cargo_toml_and_python_the_nearest_marker() {
        let exists = |path: &str| {
            matches!(
                path,
                "/repo/app/Cargo.toml" | "/repo/app/crates/x/Cargo.toml" | "/repo/py/pyproject.toml" | "/repo/py/pkg/setup.py"
            )
        };
        let none = |_: &str| None;
        let (rust, _) = resolve_with(spec("rust"), "/repo/app/crates/x/src/lib.rs", "/repo", exists, |_| false, none);
        assert_eq!(rust.project_root, "/repo/app");
        let (python, _) = resolve_with(spec("python"), "/repo/py/pkg/mod/a.py", "/repo", exists, |_| false, none);
        assert_eq!(python.project_root, "/repo/py/pkg");
        // No marker: the workspace folder.
        let (go, _) = resolve_with(spec("go"), "/repo/x/main.go", "/repo", exists, |_| false, none);
        assert_eq!(go.project_root, "/repo");
        assert_eq!(go.command, None);
        assert_eq!(go.install_hint, "go install golang.org/x/tools/gopls@latest");
    }

    #[test]
    fn an_npm_server_in_the_project_wins_over_one_on_path() {
        let executable = |path: &str| path == "/repo/web/node_modules/.bin/typescript-language-server";
        let which = |bin: &str| (bin == "typescript-language-server").then(|| "/usr/local/bin/typescript-language-server".to_string());
        let (ts, candidate) = resolve_with(spec("typescript"), "/repo/web/src/a.tsx", "/repo", |_| false, executable, which);
        assert_eq!(ts.command.as_deref(), Some("/repo/web/node_modules/.bin/typescript-language-server"));
        assert_eq!(candidate.unwrap().args, &["--stdio"]);
        assert_eq!(ts.project_root, "/repo");

        let (ts, _) = resolve_with(spec("typescript"), "/repo/a.ts", "/repo", |_| false, |_| false, which);
        assert_eq!(ts.command.as_deref(), Some("/usr/local/bin/typescript-language-server"));
        // The second candidate is used when the first is not installed.
        let (ts, _) = resolve_with(spec("typescript"), "/repo/a.ts", "/repo", |_| false, |_| false, |bin| (bin == "vtsls").then(|| "/bin/vtsls".to_string()));
        assert_eq!(ts.command.as_deref(), Some("/bin/vtsls"));
    }

    #[test]
    fn a_start_runs_only_what_a_resolve_found() {
        let ts = spec("typescript");
        let (resolution, candidate) = resolve_with(ts, "/w/a.ts", "/w", |_| false, |_| false, |_| Some("/opt/tls".to_string()));
        remember(None, &resolution, candidate, None);
        assert_eq!(take_allowed(None, "/opt/tls").unwrap().args, vec!["--stdio"]);
        assert!(take_allowed(None, "/bin/sh").is_err());
        let remote = SshToolTarget { host: "box".into(), user: None, port: None };
        assert!(take_allowed(Some(&remote), "/opt/tls").is_err());
    }

    #[test]
    fn the_remote_probe_tests_markers_and_binaries_and_reads_back_tagged_lines() {
        let script = build_remote_probe_script(spec("typescript"), "/w/src/a.ts", "/w");
        assert!(script.contains("'/w/src/node_modules/.bin/typescript-language-server'"));
        assert!(script.contains("'/w/node_modules/.bin/vtsls'"));
        assert!(script.contains("command -v"));
        let rust = build_remote_probe_script(spec("rust"), "/w/c/src/lib.rs", "/w");
        assert!(rust.contains("'/w/c/Cargo.toml'"));

        let output = b"Welcome to box!\nLOTUS_LSP\tE\t/w/Cargo.toml\nLOTUS_LSP\tX\t/w/node_modules/.bin/vtsls\nLOTUS_LSP\tW\tgopls\t/home/me/go/bin/gopls\nLOTUS_LSP\tW\tll\talias ll='ls -l'\nLOTUS_LSP\tP\t/home/me/go/bin:/usr/bin\n";
        let probe = parse_remote_probe(output);
        assert!(probe.existing.contains("/w/Cargo.toml"));
        assert!(probe.executable.contains("/w/node_modules/.bin/vtsls"));
        assert_eq!(probe.which.get("gopls").map(String::as_str), Some("/home/me/go/bin/gopls"));
        assert!(!probe.which.contains_key("ll"));
        assert_eq!(probe.path_env.as_deref(), Some("/home/me/go/bin:/usr/bin"));
    }

    #[test]
    fn the_remote_start_line_quotes_everything() {
        let line = build_remote_start_command("/x/it's", &["--stdio".to_string()], "/w/a b", Some("/p:/q"));
        assert_eq!(line, "cd '/w/a b' && PATH='/p:/q' exec '/x/it'\\''s' '--stdio'");
    }

    #[test]
    fn messages_are_framed_and_read_back_past_noise() {
        let mut stream = b"Last login: today\n".to_vec();
        stream.extend(frame_message(r#"{"id":1}"#));
        stream.extend(b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: 2\r\n\r\n{}");
        let mut reader = Cursor::new(stream);
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), br#"{"id":1}"#);
        assert_eq!(read_message(&mut reader).unwrap().unwrap(), b"{}");
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn a_huge_length_is_refused() {
        let mut reader = Cursor::new(format!("Content-Length: {}\r\n\r\n", MAX_MESSAGE_BYTES + 1).into_bytes());
        assert!(read_message(&mut reader).is_err());
    }

    #[test]
    fn utf8_lengths_are_bytes() {
        assert!(frame_message("é").starts_with(b"Content-Length: 2\r\n"));
    }
}
