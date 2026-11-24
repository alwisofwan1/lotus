use crate::no_window::NoWindow;
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::cli_tools::{format_ssh_target, validate_remote_cwd, SshToolTarget};
use crate::error::AppError;
use crate::remote_transport::RemoteTransport;

const MAX_BATCH_BYTES: u64 = 250 * 1024 * 1024;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
pub struct TerminalFileDropUploads {
    jobs: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    cancelled: Mutex<HashSet<String>>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UploadFile {
    pub path: String,
    pub name: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadedFile {
    pub source_path: String,
    pub remote_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedUpload {
    pub source_path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadBatchResult {
    pub uploaded: Vec<UploadedFile>,
    pub failed: Vec<FailedUpload>,
    pub cancelled: bool,
}

fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn safe_basename(name: &str, fallback_path: &str) -> Result<String, AppError> {
    let raw = if name.trim().is_empty() {
        Path::new(fallback_path)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
    } else {
        name
    };
    if raw.is_empty() || raw.contains('/') || raw.contains('\\') || raw.contains('\0') {
        return Err(AppError::Other("Dropped file name is not valid.".into()));
    }
    Ok(raw.to_string())
}

fn validate_files(files: &[UploadFile]) -> Result<(), AppError> {
    let total = files.iter().try_fold(0u64, |sum, file| {
        let metadata = std::fs::metadata(&file.path).map_err(|e| AppError::Other(e.to_string()))?;
        if !metadata.is_file() {
            return Err(AppError::Other(format!(
                "Not a regular file: {}",
                file.path
            )));
        }
        let size = metadata.len();
        if file.size != 0 && file.size != size {
            // Frontend size is advisory; tolerate stale zero but reject obvious drift.
            return Err(AppError::Other(format!(
                "File changed before upload: {}",
                file.path
            )));
        }
        sum.checked_add(size)
            .ok_or_else(|| AppError::Other("Upload is too large.".into()))
    })?;
    if total > MAX_BATCH_BYTES {
        return Err(AppError::Other(
            "SSH file drops are limited to 250 MB per batch.".into(),
        ));
    }
    Ok(())
}

pub(crate) fn upload_script(remote_cwd: &str, name: &str, size: u64) -> String {
    format!(
        concat!(
            "set -eu\n",
            "ROOT={root}\n",
            "NAME={name}\n",
            "cd \"$ROOT\"\n",
            "BASE=$NAME; EXT=\n",
            "case \"$NAME\" in *.*) BASE=${{NAME%.*}}; EXT=.${{NAME##*.}};; esac\n",
            "TMP=\"$ROOT/.lotus-drop-$$-$NAME.tmp\"\n",
            "trap 'rm -f -- \"$TMP\"' EXIT HUP INT TERM\n",
            "cat > \"$TMP\"\n",
            "WRITTEN=$(wc -c < \"$TMP\" | tr -d ' ')\n",
            "[ \"$WRITTEN\" = {size} ] || {{ echo SIZE_MISMATCH >&2; exit 8; }}\n",
            "i=0\n",
            "while [ $i -lt 10000 ]; do\n",
            "  if [ $i -eq 0 ]; then CAND=$NAME; else CAND=\"$BASE-$i$EXT\"; fi\n",
            "  DEST=\"$ROOT/$CAND\"\n",
            "  if ln \"$TMP\" \"$DEST\" 2>/dev/null; then rm -f -- \"$TMP\"; trap - EXIT HUP INT TERM; printf '%s\\n' \"$DEST\"; exit 0; fi\n",
            "  i=$((i + 1))\n",
            "done\n",
            "echo NAME_EXHAUSTED >&2\n",
            "exit 9\n"
        ),
        root = quote_shell_arg(remote_cwd),
        name = quote_shell_arg(name),
        size = size,
    )
}

fn build_ssh(
    target: &SshToolTarget,
    command: &str,
    transport: Option<&RemoteTransport>,
) -> Result<Command, AppError> {
    let mut ssh = Command::new("ssh").no_window();
    ssh.arg("-T").args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "ConnectionAttempts=2",
    ]);
    if let Some(t) = transport {
        let socket = t.acquire(target)?;
        ssh.args([
            "-o",
            "ControlMaster=no",
            "-o",
            &format!("ControlPath={}", socket.display()),
        ]);
    }
    if let Some(port) = target.port {
        ssh.arg("-p").arg(port.to_string());
    }
    ssh.arg(format_ssh_target(target)?)
        .arg(format!(
            "exec ${{SHELL:-bash}} -lc {}",
            quote_shell_arg(command)
        ))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    Ok(ssh)
}

fn stream_one(
    job_id: &str,
    target: &SshToolTarget,
    remote_cwd: &str,
    file: &UploadFile,
    jobs: &Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    transport: Option<&RemoteTransport>,
) -> Result<String, AppError> {
    let name = safe_basename(&file.name, &file.path)?;
    let mut child = build_ssh(
        target,
        &upload_script(remote_cwd, &name, file.size),
        transport,
    )?
    .spawn()
    .map_err(AppError::Io)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::Other("Failed to open ssh stdin.".into()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Other("Failed to open ssh stdout.".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("Failed to open ssh stderr.".into()))?;
    let shared = Arc::new(Mutex::new(child));
    lock(jobs).insert(job_id.to_string(), Arc::clone(&shared));

    let path = file.path.clone();
    let writer = std::thread::spawn(move || -> io::Result<()> {
        let mut input = std::fs::File::open(path)?;
        let mut stdin = stdin;
        io::copy(&mut input, &mut stdin)?;
        stdin.flush()
    });
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        buf
    });
    let status = loop {
        if let Some(status) = lock(&shared).try_wait().map_err(AppError::Io)? {
            break status;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = lock(jobs).remove(job_id);
    let writer_result = writer
        .join()
        .map_err(|_| AppError::Other("Upload writer panicked.".into()))?;
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();

    if status.success() {
        writer_result.map_err(AppError::Io)?;
    }
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(AppError::Other(if stderr.is_empty() {
            "SSH upload failed.".into()
        } else {
            stderr
        }));
    }
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

pub fn upload_ssh_batch(
    job_id: String,
    target: SshToolTarget,
    remote_cwd: String,
    files: Vec<UploadFile>,
    state: &TerminalFileDropUploads,
    transport: Option<&RemoteTransport>,
) -> Result<UploadBatchResult, AppError> {
    let cwd = validate_remote_cwd(&remote_cwd)?.to_string();
    validate_files(&files)?;
    let mut result = UploadBatchResult {
        uploaded: Vec::new(),
        failed: Vec::new(),
        cancelled: false,
    };
    lock(&state.cancelled).remove(&job_id);
    for file in files {
        if lock(&state.cancelled).contains(&job_id) {
            result.cancelled = true;
            break;
        }
        match stream_one(&job_id, &target, &cwd, &file, &state.jobs, transport) {
            Ok(remote_path) => result.uploaded.push(UploadedFile {
                source_path: file.path,
                remote_path,
            }),
            Err(err) => {
                let cancelled = lock(&state.cancelled).contains(&job_id);
                result.cancelled |= cancelled;
                result.failed.push(FailedUpload {
                    source_path: file.path,
                    reason: err.to_string(),
                });
                if cancelled {
                    break;
                }
            }
        }
    }
    lock(&state.cancelled).remove(&job_id);
    Ok(result)
}

pub fn cancel_upload(job_id: String, state: &TerminalFileDropUploads) {
    lock(&state.cancelled).insert(job_id.clone());
    if let Some(child) = lock(&state.jobs).remove(&job_id) {
        let _ = lock(&child).kill();
    }
}
