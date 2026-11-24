//! Why a run failed, in the user's terms (plans/automation-agent-health P1): a kind the UI can
//! offer one fix for, and whether another attempt could help. Read from the run's error text,
//! so runs stored before this existed are classified too.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureKind {
    /// The agent program is not on this machine (`could not start ccs`, seen 2026-11-16).
    AgentMissing,
    /// The preset names a Claude account that is gone.
    AccountMissing,
    /// The automation's preset was deleted.
    PresetMissing,
    /// The Claude login expired or was revoked (seen 2026-11-16: "this login reached its time limit").
    LoginExpired,
    /// The subscription's usage limit (seen 2026-11-12: "You've hit your 5-hour limit · resets 3pm").
    RateLimited,
    Other,
}

impl FailureKind {
    /// Another attempt minutes later can only help an unknown failure; the rest need the user
    /// (or, for a usage limit, hours).
    pub fn retryable(self) -> bool {
        self == FailureKind::Other
    }

    /// A usage limit says nothing about the automation itself, so it never pauses one.
    pub fn counts_toward_pause(self) -> bool {
        self != FailureKind::RateLimited
    }

    /// One plain sentence saying what to do; `None` when only the raw error says anything.
    pub fn advice(self) -> Option<&'static str> {
        Some(match self {
            FailureKind::AgentMissing => "The agent program is not installed on this machine. Choose another agent for this automation.",
            FailureKind::AccountMissing => "The Claude account this agent runs on is gone. Pick another account for the agent.",
            FailureKind::PresetMissing => "The agent this automation used was deleted. Choose another agent.",
            FailureKind::LoginExpired => "The Claude login expired. Sign in again in Settings › Accounts, then run it again.",
            FailureKind::RateLimited => "The Claude usage limit was reached. Run it again once the limit resets.",
            FailureKind::Other => return None,
        })
    }
}

pub fn classify(error: &str) -> FailureKind {
    let e = error.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| e.contains(n));
    if has(&["could not start "]) && has(&["not installed", "no such file", "not found"]) {
        FailureKind::AgentMissing
    } else if has(&["no delegation preset with id"]) {
        FailureKind::PresetMissing
    } else if has(&["claude account"]) && has(&["not on this machine"]) {
        FailureKind::AccountMissing
    } else if has(&[
        "failed to authenticate",
        "claude auth login",
        "oauth token has expired",
        "invalid api key",
        "please run /login",
        "authentication_error",
    ]) {
        FailureKind::LoginExpired
    } else if has(&["hit your", "usage limit", "rate_limit_error"]) && has(&["limit"]) {
        FailureKind::RateLimited
    } else {
        FailureKind::Other
    }
}

/// The advice when there is one, else the error itself.
pub fn plain(error: &str) -> String {
    classify(error).advice().map_or_else(|| error.to_string(), String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_errors_get_their_kind() {
        let cases = [
            ("the agent failed: could not start ccs: No such file or directory (os error 2) (failed 3 attempts)", FailureKind::AgentMissing),
            ("could not start codex: it is not installed on this machine; choose another agent", FailureKind::AgentMissing),
            ("no delegation preset with id preset_x", FailureKind::PresetMissing),
            ("the Claude account \"gone\" is not on this machine; pick another account", FailureKind::AccountMissing),
            ("the agent hit a temporary API error: Failed to authenticate: this login reached its time limit and cannot be renewed. Run `claude auth login`", FailureKind::LoginExpired),
            ("the review agent failed: the agent hit an API error: You've hit your 5-hour limit · resets 3pm (Asia/Jakarta)", FailureKind::RateLimited),
            ("the agent replied without structured output", FailureKind::Other),
        ];
        for (error, kind) in cases {
            assert_eq!(classify(error), kind, "{error}");
        }
    }

    #[test]
    fn only_unknown_failures_retry_and_only_limits_spare_the_pause() {
        assert!(FailureKind::Other.retryable());
        assert!(!FailureKind::LoginExpired.retryable());
        assert!(!FailureKind::AgentMissing.retryable());
        assert!(!FailureKind::RateLimited.counts_toward_pause());
        assert!(FailureKind::LoginExpired.counts_toward_pause());
    }

    #[test]
    fn plain_keeps_an_unknown_error_as_it_is() {
        assert_eq!(plain("boom"), "boom");
        assert!(plain("could not start ccs: No such file or directory").contains("Choose another agent"));
    }
}
