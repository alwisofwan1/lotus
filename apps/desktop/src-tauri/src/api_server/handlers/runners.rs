//! The runners this machine can actually launch — read from the same registry the
//! desktop's own Settings screen edits.
//!
//! Exists because the phone had a **hardcoded** list of three, and a hardcoded list is
//! wrong in both directions on a machine like the one this was measured against: it
//! offered `gemini`, which was not installed, and it could not offer `Pi` or `acme`,
//! which were — because a custom runner is a name and a command the operator invented,
//! and nothing but this registry knows it exists.
//!
//! `detected` CLIs and user-defined `custom` entries arrive in one list on purpose. To
//! a caller that only wants to start something, the difference between "found on
//! `PATH`" and "you wrote this command yourself" is not a distinction it can act on;
//! what it can act on is `claudeFamily`, which decides whether the runner has a
//! permission gate to be asked for at all.

use axum::Json;
use serde::Serialize;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::runners;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSummary {
    /// The id a spawn names, native (`claude`) or custom (`custom-acme`).
    pub id: String,
    /// What the operator calls it — `Pi`, `acme`. Never the command.
    pub name: String,
    /// Whether this runner executes the `claude` binary, so Lotus' hooks fire for it
    /// and it can be launched with its permission gate on.
    pub claude_family: bool,
    /// True for a runner the operator defined rather than one detected on `PATH`.
    pub custom: bool,
    /// Whether this runner's own launch command already fixes a model or an effort, so a
    /// client must not offer to set one: the flag it sent would be appended *after* the
    /// operator's own and fight it.
    pub pins_tuning: bool,
}

#[derive(Serialize)]
pub struct ListRunnersResponse {
    pub items: Vec<RunnerSummary>,
}

/// `GET /api/runners` — what can be started here.
///
/// Uninstalled entries are dropped rather than reported: a client's only use for this
/// list is to offer a choice, and offering a runner the machine cannot execute is the
/// same broken promise as offering a control the host cannot honour.
pub async fn list_runners(_: RequireAuth) -> Result<Json<ListRunnersResponse>, ApiError> {
    let registry = runners::list_runners().map_err(ApiError::from)?;

    Ok(Json(ListRunnersResponse {
        items: registry
            .runners
            .into_iter()
            .filter(|r| r.installed)
            .map(|r| RunnerSummary {
                claude_family: is_claude_family(&r.id, r.claude_family),
                pins_tuning: pins_tuning(&r.command, &r.extra_flags),
                id: r.id,
                name: r.name,
                custom: r.custom,
            })
            .collect(),
    }))
}

/// Whether a runner executes the `claude` binary, for the wire.
///
/// The registry only records the flag for **custom** runners — a detected CLI is
/// "classified by its own id" there (`runners.rs`), so `claude` itself carried
/// `claude_family: false`. Inside the desktop that is harmless, because the kernel
/// checks the id. On the wire it is not: the phone reads only this flag, and on
/// 2026-08-27 it printed `Claude Code · never asks` and sent no posture for the one
/// runner that can ask. The id is the truth for native runners; the flag for custom.
fn is_claude_family(id: &str, flagged: bool) -> bool {
    flagged || id == "claude"
}

/// Whether a launch already carries a model or effort flag of its own.
///
/// **Scanned, not assumed.** The mobile façade used to treat *every* custom runner as one
/// that owns its flags, which is true of `ccs acme --model opus` and false of
/// `ccs initech --dangerously-skip-permissions` — and the second shape is the common one,
/// so the phone withheld a model picker the machine would have honoured (`spawn-tuning.ts`).
/// This registry is the only place that can tell the two apart, which is why the fact ships
/// as a field rather than being guessed from `custom`.
///
/// Both halves of what reaches the CLI are read: a custom runner's own `command`, and the
/// `extra_flags` any runner may carry from Settings → Runners. The spawn path appends its
/// `--model` / `--effort` after both (`live-agent-spawn.ts`), so either one is enough to
/// collide — and one field covers both knobs because a command that pins one usually means
/// to own the tuning entirely.
fn pins_tuning(command: &str, extra_flags: &str) -> bool {
    [command, extra_flags].iter().any(|part| {
        part.split_whitespace().any(|token| {
            matches!(token, "--model" | "-m" | "--effort")
                || token.starts_with("--model=")
                || token.starts_with("--effort=")
                // codex takes its effort as `-c model_reasoning_effort="high"`, so the
                // interesting token is the one *after* the flag.
                || token.starts_with("model_reasoning_effort=")
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{is_claude_family, pins_tuning};

    #[test]
    fn native_claude_is_claude_family_on_the_wire_even_when_the_registry_says_nothing() {
        assert!(is_claude_family("claude", false));
        assert!(is_claude_family("custom-acme", true), "custom keeps its saved flag");
        assert!(!is_claude_family("custom-pi", false));
        assert!(!is_claude_family("codex", false));
    }

    #[test]
    fn a_plain_wrapper_command_pins_nothing_so_the_phone_may_tune_it() {
        // The case that motivated the field: a 2nd-account Claude wrapper. Nothing here
        // fixes a model, so `--model sonnet` appended at spawn is the only one present.
        assert!(!pins_tuning("ccs initech --dangerously-skip-permissions", ""));
        assert!(!pins_tuning("claude", ""));
        assert!(!pins_tuning("opencode", ""));
    }

    #[test]
    fn a_command_that_already_names_a_model_keeps_its_own() {
        assert!(pins_tuning("ccs acme --model opus", ""));
        assert!(pins_tuning("ccs acme --model=opus", ""));
        assert!(pins_tuning("codex -m gpt-5.4", ""));
    }

    #[test]
    fn extra_flags_count_too_even_on_a_detected_cli() {
        // Settings → Runners appends these to a native runner's command, and the spawn's
        // own flag lands after them — so `claude` itself can be pinned this way.
        assert!(pins_tuning("claude", "--model opus"));
        assert!(pins_tuning("claude", "--effort max"));
        assert!(pins_tuning("codex", "-c model_reasoning_effort=\"high\""));
    }

    #[test]
    fn a_word_that_merely_contains_the_flag_is_not_the_flag() {
        // Substring matching would have read a path or a prompt as a pinned model.
        assert!(!pins_tuning("/Users/op/.claude/scripts/claude-model-wrapper.sh", ""));
        assert!(!pins_tuning("pi --models", ""));
    }
}
