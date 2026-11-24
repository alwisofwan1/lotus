use crate::fs_browse;
use crate::models::LaunchConfig;

pub(crate) fn build_prompt(config: &LaunchConfig) -> String {
    let work_dir = config
        .project_dir
        .clone()
        .unwrap_or_else(fs_browse::get_homedir);
    let agent_list = config
        .agents
        .iter()
        .enumerate()
        .map(|(i, a)| {
            format!(
                "  {}. {} ({}) — {}",
                i + 1,
                a.name,
                a.role,
                if a.prompt.is_empty() {
                    format!("Expert {} engineer", a.role)
                } else {
                    a.prompt.clone()
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let task_list = match &config.tasks {
        Some(tasks) if !tasks.is_empty() => tasks
            .iter()
            .enumerate()
            .map(|(i, t)| format!("  {}. {}", i + 1, t))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => "  (determine tasks based on the goal)".to_string(),
    };

    let goal = config.goal.clone().unwrap_or_else(|| config.name.clone());
    let plan_approval = if config.require_plan_approval.unwrap_or(false) {
        "Require plan approval from each teammate before they make any changes."
    } else {
        ""
    };
    let display_mode = if config.display_mode.as_deref() == Some("split-panes") {
        "Use split-pane display mode."
    } else {
        "Use in-process display mode."
    };

    format!(
        r#"You are the Team Lead for an agent team working on: {work_dir}.

Goal: {goal}

Create an agent team with these teammates:
{agent_list}

Tasks to complete:
{task_list}

Project directory: {work_dir}
{plan_approval}
{display_mode}

Spawn the teammates now and assign them their tasks. Work independently in parallel. Synthesize results when done."#
    )
}

pub(crate) fn build_shell_cmd(config: &LaunchConfig, prompt: &str) -> String {
    let work_dir = config
        .project_dir
        .clone()
        .unwrap_or_else(fs_browse::get_homedir);
    let model = config
        .lead_model
        .clone()
        .or_else(|| config.agents.first().map(|a| a.model.clone()))
        .unwrap_or_else(|| "claude-haiku-4-5".to_string());
    let escaped = prompt.replace('\'', "'\"'\"'");
    format!(
        "cd '{work_dir}' && CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 claude --model {model} '{escaped}'"
    )
}
