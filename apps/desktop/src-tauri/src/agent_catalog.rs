//! The agent CLIs Lotus launches, read from `src/agents.json` — the same file the frontend's agent
//! registry reads. Embedded at build time, so a CLI added there reaches detection, updates and the
//! nested-agent check here without a second list to forget (`plans/agent-pane-identity/PLAN.md`).

use std::sync::LazyLock;

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAgent {
    pub id: String,
    /// The name Settings shows (`Claude Code`, `Cursor Agent`).
    pub product_name: String,
    /// `command[0]` is the binary as it is spelled on PATH.
    pub command: Vec<String>,
    /// Autonomy flags added only where verified; the rest launch as the bare binary.
    #[serde(default)]
    pub launch_flags: Option<String>,
    #[serde(default)]
    pub npm_package: Option<String>,
    /// Arguments for the CLI's own updater (`update`, `update --self`).
    #[serde(default)]
    pub self_update: Option<Vec<String>>,
    /// Present when the agent also runs as a Chat runner over ACP; the bridge reads the details.
    #[serde(default)]
    pub acp: Option<serde_json::Value>,
    /// What Lotus hooks report for it: `"all"` (every step and the turn end) or `"tools"`.
    /// Absent = no hook reaches Lotus. Read by the frontend's `agentTurnReports` too.
    #[serde(default)]
    pub hooks: Option<String>,
    /// `command` plus `launch_flags`, filled after parsing.
    #[serde(skip)]
    pub base_command: String,
}

/// Does this agent drive Lotus's hook pipeline (agents.json `hooks`)?
pub fn drives_hooks(id: &str) -> bool {
    AGENTS.iter().any(|a| a.id == id && a.hooks.is_some())
}

/// A Chat runner that speaks ACP (`acp` in agents.json): "antigravity", "cursor".
pub fn is_acp_runner(id: &str) -> bool {
    AGENTS.iter().any(|a| a.id == id && a.acp.is_some())
}

impl CatalogAgent {
    pub fn binary(&self) -> &str {
        &self.command[0]
    }
}

#[derive(serde::Deserialize)]
struct Catalog {
    agents: Vec<CatalogAgent>,
}

pub static AGENTS: LazyLock<Vec<CatalogAgent>> = LazyLock::new(|| {
    let catalog: Catalog =
        serde_json::from_str(include_str!("../../src/agents.json")).expect("src/agents.json is valid");
    catalog
        .agents
        .into_iter()
        .map(|mut agent| {
            let mut base = agent.command.join(" ");
            if let Some(flags) = agent.launch_flags.as_deref().filter(|f| !f.is_empty()) {
                base = format!("{base} {flags}");
            }
            agent.base_command = base;
            agent
        })
        .collect()
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_agent_has_a_binary_and_a_unique_id() {
        assert!(AGENTS.len() >= 11);
        let mut ids: Vec<&str> = AGENTS.iter().map(|a| a.id.as_str()).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), AGENTS.len());
        for agent in AGENTS.iter() {
            assert!(!agent.binary().is_empty(), "{}", agent.id);
        }
    }

    #[test]
    fn hook_driving_agents_are_the_three_with_installers() {
        let mut ids: Vec<&str> = AGENTS
            .iter()
            .filter(|a| drives_hooks(&a.id))
            .map(|a| a.id.as_str())
            .collect();
        ids.sort();
        assert_eq!(ids, ["claude", "codex", "cursor"]);
    }

    #[test]
    fn verified_launch_flags_stay_on_the_base_command() {
        let base = |id: &str| AGENTS.iter().find(|a| a.id == id).unwrap().base_command.clone();
        assert_eq!(base("claude"), "claude --dangerously-skip-permissions");
        assert_eq!(base("cursor"), "cursor-agent --yolo");
        assert_eq!(base("antigravity"), "agy --dangerously-skip-permissions");
        assert_eq!(base("pi"), "pi");
    }
}
