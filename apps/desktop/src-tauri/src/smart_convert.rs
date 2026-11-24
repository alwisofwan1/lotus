use crate::no_window::NoWindow;
use std::path::PathBuf;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::error::{other, AppError};

const SMART_CONVERT_TIMEOUT_SECS: u64 = 120;
const MAX_NOTE_CHARS: usize = 24_000;
const SMART_CONVERT_WORK_DIR_NAME: &str = "lotus-smart-convert";

pub fn smart_convert_work_dir() -> PathBuf {
    std::env::temp_dir().join(SMART_CONVERT_WORK_DIR_NAME)
}

fn ensure_smart_convert_work_dir() -> Result<PathBuf, AppError> {
    let dir = smart_convert_work_dir();
    std::fs::create_dir_all(&dir).map_err(|e| {
        other(format!(
            "smart_convert_note: failed to create isolated work dir: {e}"
        ))
    })?;
    Ok(dir)
}

fn trim_note_content(content: &str) -> Result<String, AppError> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Err(other("smart_convert_note: note is empty"));
    }
    let mut chars = trimmed.chars();
    let clipped: String = chars.by_ref().take(MAX_NOTE_CHARS).collect();
    if chars.next().is_some() {
        Ok(format!(
            "{clipped}\n\n[Note truncated to {MAX_NOTE_CHARS} characters for Smart Convert.]"
        ))
    } else {
        Ok(clipped)
    }
}

pub fn build_smart_convert_prompt(content: &str) -> Result<String, AppError> {
    let content = trim_note_content(content)?;
    Ok(format!(
        "Extract a structured task from the following note. Return ONLY valid JSON, no markdown fences.\n\n\
        You are doing a pure text transformation for Lotus Smart Convert. Do not read files, write files, modify a repository, run shell commands, or use tools.\n\n\
        Schema:\n\
        {{\n\
          \"title\": \"concise task label (max 80 chars)\",\n\
          \"intent\": \"clarified goal in 1-3 sentences — what must be achieved and why\",\n\
          \"acceptanceCriteria\": [\"verifiable condition 1\", \"verifiable condition 2\"],\n\
          \"taskClass\": \"quick | needs-research | deep-focus | benchmark\",\n\
          \"when\": \"urgent | this-week | this-month | whenever\",\n\
          \"subtasks\": []\n\
        }}\n\n\
        taskClass: quick=<2h clear steps, needs-research=requires investigation first, \
        deep-focus=>4h complex work, benchmark=measuring/comparing quality or performance\n\
        when: urgent=blocking/imminent deadline, this-week=address soon, \
        this-month=flexible timing, whenever=no time pressure\n\n\
        Production rules:\n\
        - Make acceptanceCriteria externally verifiable.\n\
        - Preserve concrete nouns, product names, and user intent from the note.\n\
        - Do not invent deadlines, assignees, or implementation details.\n\n\
        Note:\n{content}"
    ))
}

pub async fn smart_convert_note(
    content: String,
    model: String,
    provider: Option<String>,
) -> Result<String, AppError> {
    let prompt = build_smart_convert_prompt(&content)?;
    match provider
        .unwrap_or_else(|| "claude".to_string())
        .to_ascii_lowercase()
        .as_str()
    {
        "" | "claude" => run_claude(&prompt, &model).await,
        "codex" => run_codex(&prompt, &model).await,
        other_provider => Err(other(format!(
            "smart_convert_note: unsupported provider '{other_provider}'"
        ))),
    }
}

async fn run_claude(prompt: &str, model: &str) -> Result<String, AppError> {
    let bin = crate::pty::resolve_command_executable("claude");
    let mut cmd = Command::new(bin).no_window();
    cmd.arg("--print").arg("--output-format").arg("text");
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(model);
    }
    cmd.kill_on_drop(true);
    cmd.current_dir(ensure_smart_convert_work_dir()?);
    cmd.arg(prompt);

    let output = timeout(
        Duration::from_secs(SMART_CONVERT_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .map_err(|_| other("smart_convert_note: claude timed out"))?
    .map_err(|e| other(format!("smart_convert_note: failed to spawn claude: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(other(format!(
            "smart_convert_note: claude exited with error: {stderr}"
        )));
    }
    String::from_utf8(output.stdout)
        .map_err(|e| other(format!("smart_convert_note: utf8 decode: {e}")))
}

async fn run_codex(prompt: &str, model: &str) -> Result<String, AppError> {
    let bin = crate::pty::resolve_command_executable("codex");
    let work_dir = ensure_smart_convert_work_dir()?;
    let mut cmd = Command::new(bin).no_window();
    cmd.arg("exec");
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(model);
    }
    cmd.kill_on_drop(true);
    cmd.current_dir(&work_dir);
    cmd.arg("-c")
        .arg(r#"model_reasoning_effort="medium""#)
        .arg("--json")
        .arg("--color")
        .arg("never")
        .arg("--sandbox")
        .arg("read-only")
        .arg("--cd")
        .arg(&work_dir)
        .arg("--ephemeral")
        .arg("--ignore-rules")
        .arg("--skip-git-repo-check")
        .arg("-")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| other(format!("smart_convert_note: failed to spawn codex: {e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes()).await.map_err(|e| {
            other(format!(
                "smart_convert_note: failed to write codex prompt: {e}"
            ))
        })?;
    }

    let output = timeout(
        Duration::from_secs(SMART_CONVERT_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| other("smart_convert_note: codex timed out"))?
    .map_err(|e| other(format!("smart_convert_note: codex failed: {e}")))?;
    let response = crate::bridge_chat::parse_codex_jsonl(&output.stdout)?;
    if !output.status.success() || response.is_error {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if !response.text.trim().is_empty() {
            response.text
        } else if !stderr.is_empty() {
            stderr
        } else {
            format!("codex exited with code {:?}", output.status.code())
        };
        return Err(other(format!("smart_convert_note: {message}")));
    }
    Ok(response.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_rejects_empty_notes() {
        assert!(build_smart_convert_prompt("  \n ").is_err());
    }

    #[test]
    fn prompt_caps_large_notes() {
        let prompt = build_smart_convert_prompt(&"x".repeat(MAX_NOTE_CHARS + 20)).unwrap();
        assert!(prompt.contains("Note truncated"));
        assert!(prompt.len() < MAX_NOTE_CHARS + 2_000);
    }

    #[test]
    fn prompt_includes_production_rules() {
        let prompt = build_smart_convert_prompt("ship this").unwrap();
        assert!(prompt.contains("Return ONLY valid JSON"));
        assert!(prompt.contains("pure text transformation"));
        assert!(prompt.contains("externally verifiable"));
        assert!(prompt.contains("ship this"));
    }

    #[test]
    fn isolated_work_dir_uses_os_temp_not_repo() {
        let dir = smart_convert_work_dir();
        assert!(dir.ends_with(SMART_CONVERT_WORK_DIR_NAME));
        assert!(dir.starts_with(std::env::temp_dir()));
    }
}
