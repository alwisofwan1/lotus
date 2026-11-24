//! One wait-and-retry rule for every rate-limited call, Slack and GitHub
//! alike (PLAN §3 principle 6): wait as long as the server asks, once, and
//! never longer than [`MAX_WAIT`] — a longer wait is reported, not slept.

use std::future::Future;
use std::time::Duration;

/// Longest wait slept through. A run holds a concurrency slot while it waits.
pub const MAX_WAIT: Duration = Duration::from_secs(60);

/// What one call came back with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attempt<T> {
    Done(T),
    /// Rate limited: the server asks to come back after this long.
    Wait(Duration),
}

/// Makes `call`, waiting out one rate limit with `sleep`. `what` names the
/// call in errors.
pub async fn with_rate_limit<T, C, CF, S, SF>(what: &str, mut call: C, mut sleep: S) -> Result<T, String>
where
    C: FnMut() -> CF,
    CF: Future<Output = Result<Attempt<T>, String>>,
    S: FnMut(Duration) -> SF,
    SF: Future<Output = ()>,
{
    for attempt in 0..2 {
        match call().await? {
            Attempt::Done(value) => return Ok(value),
            Attempt::Wait(wait) if wait > MAX_WAIT => {
                return Err(format!("{what}: rate limited; try again in {} s", wait.as_secs()));
            }
            Attempt::Wait(wait) if attempt == 0 => sleep(wait).await,
            Attempt::Wait(_) => break,
        }
    }
    Err(format!("{what}: rate limited twice in a row"))
}
