//! Boundaries to the outside world. Everything the engine cannot own
//! (time, and later GitHub, Slack, the agent runner, secrets) is reached
//! through a trait here so tests can substitute it.

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// How a run ended, for whoever tells the user (an OS notification, a UI
/// refresh). Carries no secrets and no draft content.
#[derive(Debug, Clone, PartialEq)]
pub struct RunReport {
    pub run_id: String,
    pub automation_id: String,
    pub automation_name: String,
    pub status: crate::model::RunStatus,
    pub detail: Option<String>,
    /// Set when the run left a draft to review.
    pub draft_id: Option<String>,
    pub subject: Option<String>,
    /// This failure was one too many in a row: the automation is now off.
    pub paused: bool,
    /// How many runs in a row had failed when it was paused; 0 otherwise.
    pub failures_in_a_row: usize,
    /// The agent had nothing to report: the UI refreshes, but the user is not interrupted.
    pub quiet: bool,
}

/// What the OS notification says about a finished run, or `None` when there
/// is nothing worth interrupting the user for. Pure, so every case is tested
/// without Tauri (`tests/notification.rs`).
pub fn notification_text(report: &RunReport) -> Option<(String, String)> {
    use crate::model::RunStatus;
    if report.quiet {
        return None;
    }
    let detail = report.detail.clone().unwrap_or_default();
    // A failure the user can fix is told as the fix, not as the raw error.
    let detail = if report.status == RunStatus::Failed { crate::failure::plain(&detail) } else { detail };
    let name = &report.automation_name;
    Some(match (report.status, &report.subject) {
        (RunStatus::Failed, _) if report.paused => (
            format!("Paused · {name}"),
            format!("Failed {} times in a row, so it is off now. Last error: {detail}", report.failures_in_a_row),
        ),
        (RunStatus::Asked, _) => (format!("Needs your answer · {name}"), format!("{} Answer in Lotus.", plain_line(detail.strip_prefix("asked: ").unwrap_or(&detail)))),
        (RunStatus::Succeeded, Some(subject)) if detail.starts_with("result") => (subject.clone(), detail),
        (RunStatus::Succeeded, Some(subject)) => ("Review draft ready".to_string(), format!("{subject}: {detail}")),
        (RunStatus::Skipped, _) => (format!("Skipped · {name}"), detail),
        (RunStatus::Failed, _) => (format!("Failed · {name}"), detail),
        _ => return None,
    })
}

/// One short line of an agent's markdown for a notification: marks dropped, cut to 120 characters.
fn plain_line(text: &str) -> String {
    const MAX: usize = 120;
    let plain: String = text.lines().next().unwrap_or_default().chars().filter(|c| !matches!(c, '*' | '_' | '`' | '#')).collect();
    let plain = plain.split_whitespace().collect::<Vec<_>>().join(" ");
    if plain.chars().count() <= MAX {
        return plain;
    }
    format!("{}…", plain.chars().take(MAX - 1).collect::<String>().trim_end())
}

pub trait Notifier: Send + Sync {
    fn run_finished(&self, report: &RunReport);
}
