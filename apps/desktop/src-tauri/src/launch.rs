use crate::no_window::NoWindow;
use std::io::{Read, Write};
use std::path::PathBuf;

use uuid::Uuid;

use crate::error::{other, AppError};
use crate::fs_browse;
use crate::json;
use crate::launch_prompt::{build_prompt, build_shell_cmd};
use crate::models::{
    LaunchConfig, LaunchPtyResult, LaunchResult, ProcessInfo, TeamConfig, TeamMember,
};
use crate::paths;
use crate::processes;
use crate::pty::PtyState;
use crate::time;

fn persist_team_config(
    config: &LaunchConfig,
    team_id: &str,
    work_dir: &str,
    status: &str,
) -> Result<(), AppError> {
    let team_config = TeamConfig {
        // Left unstamped on purpose: this path writes `prompt`/`effort`/`applied_skills`/
        // `permission_mode` as None below, which IS the v0 shape. The frontend migration fills
        // them from the agent catalog on the next load.
        schema_version: None,
        id: team_id.to_string(),
        name: config.name.clone(),
        description: config.goal.clone(),
        project: config.project.clone().or_else(|| {
            PathBuf::from(work_dir)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        }),
        project_dir: Some(work_dir.to_string()),
        display_mode: config.display_mode.clone(),
        require_plan_approval: config.require_plan_approval,
        lead_model: config.lead_model.clone(),
        created_at: time::chrono_now(),
        status: status.to_string(),
        members: config
            .agents
            .iter()
            .map(|a| TeamMember {
                name: a.name.clone(),
                agent_id: Uuid::new_v4()
                    .to_string()
                    .split('-')
                    .next()
                    .unwrap_or("")
                    .to_string(),
                agent_type: "teammate".to_string(),
                model: Some(a.model.clone()),
                role: Some(a.role.clone()),
                status: Some("spawning".to_string()),
                pid: None,
                runner: None,
                runner_command: None,
                prompt: None,
                applied_skills: None,
                effort: None,
                permission_mode: None,
            })
            .collect(),
    };
    json::write_json(
        &paths::teams_dir().join(team_id).join("config.json"),
        &team_config,
    )
}

fn persist_tasks(config: &LaunchConfig, team_id: &str) -> Result<(), AppError> {
    if let Some(tasks) = &config.tasks {
        for (idx, title) in tasks.iter().enumerate() {
            let task = serde_json::json!({
                "id": format!("task-{}", idx + 1),
                "teamId": team_id,
                "title": title,
                "status": "pending",
                "priority": "medium",
                "dependencies": [],
                "tags": [],
                "createdAt": time::chrono_now(),
                "updatedAt": time::chrono_now(),
            });
            json::write_json(
                &paths::tasks_dir()
                    .join(team_id)
                    .join(format!("task-{}.json", idx + 1)),
                &task,
            )?;
        }
    }
    Ok(())
}

fn new_team_id() -> String {
    Uuid::new_v4()
        .to_string()
        .split('-')
        .next()
        .unwrap_or("team")
        .to_string()
}

pub fn spawn_claude(config: LaunchConfig) -> Result<LaunchResult, AppError> {
    let work_dir = config
        .project_dir
        .clone()
        .unwrap_or_else(fs_browse::get_homedir);

    if !std::path::Path::new(&work_dir).exists() {
        return Err(other(format!("Directory not found: {work_dir}")));
    }

    let team_id: String = new_team_id();
    let prompt = build_prompt(&config);
    let shell_cmd = build_shell_cmd(&config, &prompt);
    let model = config
        .lead_model
        .clone()
        .or_else(|| config.agents.first().map(|a| a.model.clone()))
        .unwrap_or_else(|| "claude-haiku-4-5".to_string());

    // Persist team config
    let team_config = TeamConfig {
        // v0 shape for the same reason as above — the member fields below are all None.
        schema_version: None,
        id: team_id.clone(),
        name: config.name.clone(),
        description: config.goal.clone(),
        project: config.project.clone().or_else(|| {
            PathBuf::from(&work_dir)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
        }),
        project_dir: Some(work_dir.clone()),
        display_mode: config.display_mode.clone(),
        require_plan_approval: config.require_plan_approval,
        lead_model: config.lead_model.clone(),
        created_at: time::chrono_now(),
        status: "idle".to_string(),
        members: config
            .agents
            .iter()
            .map(|a| TeamMember {
                name: a.name.clone(),
                agent_id: Uuid::new_v4()
                    .to_string()
                    .split('-')
                    .next()
                    .unwrap_or("")
                    .to_string(),
                agent_type: "teammate".to_string(),
                model: Some(a.model.clone()),
                role: Some(a.role.clone()),
                status: Some("spawning".to_string()),
                pid: None,
                runner: None,
                runner_command: None,
                prompt: None,
                applied_skills: None,
                effort: None,
                permission_mode: None,
            })
            .collect(),
    };
    json::write_json(
        &paths::teams_dir().join(&team_id).join("config.json"),
        &team_config,
    )?;

    // Persist tasks
    if let Some(tasks) = &config.tasks {
        for (idx, title) in tasks.iter().enumerate() {
            let task = serde_json::json!({
                "id": format!("task-{}", idx + 1),
                "teamId": team_id,
                "title": title,
                "status": "pending",
                "priority": "medium",
                "dependencies": [],
                "tags": [],
                "createdAt": time::chrono_now(),
                "updatedAt": time::chrono_now(),
            });
            json::write_json(
                &paths::tasks_dir()
                    .join(&team_id)
                    .join(format!("task-{}.json", idx + 1)),
                &task,
            )?;
        }
    }

    if config.dry_run.unwrap_or(false) {
        return Ok(LaunchResult {
            ok: true,
            team_id,
            pid: None,
            log_file: String::new(),
            work_dir,
            shell_cmd,
        });
    }

    // Prepare log file
    let log_dir = paths::logs_dir();
    std::fs::create_dir_all(&log_dir).map_err(AppError::Io)?;
    let log_path = log_dir.join(format!("{team_id}.log"));
    let log_path_str = log_path.to_string_lossy().to_string();

    let mut log_file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(AppError::Io)?;

    let header = format!(
        "=== {} ({}) — {} ===\n=== Working dir: {} ===\n=== Shell command: ===\n{}\n\n",
        config.name,
        team_id,
        time::chrono_now(),
        work_dir,
        shell_cmd
    );
    log_file
        .write_all(header.as_bytes())
        .map_err(AppError::Io)?;

    // Spawn the claude process
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("claude").no_window();
    cmd.arg("--print")
        .arg("--verbose")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--model")
        .arg(&model)
        .arg(&prompt)
        .current_dir(&work_dir)
        .env("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| other(format!("spawn error: {e}")))?;
    let pid = child.id();
    let cfg_path = paths::teams_dir().join(&team_id).join("config.json");
    crate::launch_status::update_team_status_file(
        &cfg_path,
        crate::launch_status::TEAM_STATUS_ACTIVE,
    )?;

    // Stream stdout + stderr to log file in background thread
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let log_path_clone = log_path.clone();
    let cfg_path_clone = cfg_path.clone();

    std::thread::spawn(move || {
        let mut log = std::fs::OpenOptions::new()
            .append(true)
            .open(&log_path_clone)
            .ok();

        if let Some(mut out) = stdout {
            let mut buf = [0u8; 4096];
            loop {
                match out.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Some(f) = &mut log {
                            let _ = f.write_all(&buf[..n]);
                        }
                    }
                }
            }
        }
        if let Some(mut err) = stderr {
            let mut buf = [0u8; 4096];
            loop {
                match err.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Some(f) = &mut log {
                            let prefix = b"[stderr] ";
                            let _ = f.write_all(prefix);
                            let _ = f.write_all(&buf[..n]);
                        }
                    }
                }
            }
        }

        let exit_status = child.wait().ok();
        let code = exit_status.and_then(|s| s.code()).unwrap_or(-1);
        if let Some(f) = &mut log {
            let footer = format!("\n=== Exited code {code} at {} ===\n", time::chrono_now());
            let _ = f.write_all(footer.as_bytes());
        }

        // Update team status
        let status = crate::launch_status::status_for_exit_code(code);
        let _ = crate::launch_status::update_team_status_file(&cfg_path_clone, status);
    });

    // Record process
    let proc_info = ProcessInfo {
        pid,
        team_id: Some(team_id.clone()),
        project_dir: Some(work_dir.clone()),
        started_at: time::chrono_now(),
        cmd: "claude ...".to_string(),
    };
    let procs_path = paths::procs_file();
    let mut procs = processes::read_procs();
    procs.push(proc_info);
    let _ = json::write_json(&procs_path, &procs);

    Ok(LaunchResult {
        ok: true,
        team_id,
        pid: Some(pid),
        log_file: log_path_str,
        work_dir,
        shell_cmd,
    })
}

pub fn spawn_claude_pty(
    config: LaunchConfig,
    pty_state: &PtyState,
) -> Result<LaunchPtyResult, AppError> {
    let work_dir = config
        .project_dir
        .clone()
        .unwrap_or_else(fs_browse::get_homedir);

    if !std::path::Path::new(&work_dir).exists() {
        return Err(other(format!("Directory not found: {work_dir}")));
    }

    let team_id = new_team_id();
    let prompt = build_prompt(&config);
    let shell_cmd = build_shell_cmd(&config, &prompt);
    let model = config
        .lead_model
        .clone()
        .or_else(|| config.agents.first().map(|a| a.model.clone()))
        .unwrap_or_else(|| "claude-haiku-4-5".to_string());

    persist_team_config(&config, &team_id, &work_dir, "active")?;
    persist_tasks(&config, &team_id)?;

    if config.dry_run.unwrap_or(false) {
        return Ok(LaunchPtyResult {
            ok: true,
            team_id,
            session_id: String::new(),
            work_dir,
            shell_cmd,
        });
    }

    let command = vec!["claude".to_string(), "--model".to_string(), model, prompt];
    let session_id =
        crate::pty::create_headless_command_session(work_dir.clone(), command, 100, 30, pty_state)?;

    Ok(LaunchPtyResult {
        ok: true,
        team_id,
        session_id,
        work_dir,
        shell_cmd,
    })
}
