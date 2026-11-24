//! Raw-byte source fingerprints, independent of staged/committed state. Never persist the diff.
use crate::no_window::NoWindow;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceProof {
    pub base: String,
    pub head: String,
    pub digest: String,
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub async fn capture(
    worktree: &Path,
    env: &HashMap<String, String>,
    base: &str,
    committed: bool,
) -> Result<SourceProof, String> {
    if !(base.len() == 40 || base.len() == 64) || !base.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid source proof base".into());
    }
    // Match Factory's publication pathspec, including newly generated non-ignored files.
    // Intent-to-add changes the owned worktree index, never commits source content.
    if !committed {
        raw_git(worktree, env, &["add", "-N", "--", ".", ":(exclude)target"]).await?;
    }
    let head = raw_git(worktree, env, &["rev-parse", "HEAD"]).await?;
    let head = String::from_utf8(head)
        .map_err(|_| "Invalid source proof HEAD")?
        .trim()
        .to_string();
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--binary", base];
    if committed {
        args.push(&head);
    }
    args.extend(["--", ".", ":(exclude)target"]);
    let bytes = raw_git(worktree, env, &args).await?;
    Ok(SourceProof {
        base: base.into(),
        head,
        digest: digest(&bytes),
    })
}
async fn raw_git(
    worktree: &Path,
    env: &HashMap<String, String>,
    args: &[&str],
) -> Result<Vec<u8>, String> {
    let mut command = tokio::process::Command::new("git").no_window();
    command
        .arg("-C")
        .arg(worktree)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .envs(env)
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
    ] {
        command.env_remove(key);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "Cannot start source proof inspection")?;
    let _group = super::super::runner::KillGroup(child.id());
    let pipe = child
        .stdout
        .take()
        .ok_or("Source proof output unavailable")?;
    let action = async {
        let (bytes, status) = tokio::join!(
            async {
                let mut bytes = Vec::new();
                pipe.take(4 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|_| "Cannot read source proof")?;
                Ok::<_, String>(bytes)
            },
            child.wait()
        );
        let bytes = bytes?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err("Source proof diff exceeds 4 MiB; publication refused".into());
        }
        if !status.map_err(|_| "Source proof process failed")?.success() {
            return Err("Cannot inspect source proof".into());
        }
        Ok(bytes)
    };
    tokio::time::timeout(Duration::from_secs(15), action)
        .await
        .map_err(|_| "Source proof inspection timed out")?
}
