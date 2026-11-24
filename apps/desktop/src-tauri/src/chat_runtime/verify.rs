//! Delegate Verify (ADR-0066, plans/delegate-verify/SPEC.md): a child delegated with `verify` is
//! checked by a verifier on the other provider when it finishes; a `fail` goes back to the child as
//! a follow-up, up to `rounds` times. The loop is code, not an agent (ADR-0051/0056).

use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};

use super::{now_ms, ChatRuntime};

const POLL: Duration = Duration::from_secs(2);
const SETTLE_MS: i64 = 10_000;
const RESUME_MARGIN_MS: u64 = 60_000;
/// A worker waiting on the user's permission can stall a round; past this the loop gives up.
const CAP: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyOptions {
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub rounds: Option<u32>,
}

/// One verified child's loop, as `lotus_chat_wait` reports it.
#[derive(Debug, Clone)]
pub(super) struct VerifyState {
    pub status: &'static str,
    pub round: u32,
    pub rounds: u32,
    pub verifier_id: Option<String>,
    pub reasons: Option<String>,
}

impl VerifyState {
    pub fn to_json(&self) -> Value {
        json!({
            "status": self.status,
            "round": self.round,
            "rounds": self.rounds,
            "verifierId": self.verifier_id,
            "reasons": self.reasons,
        })
    }
}

/// What the loop needs to run the verifier: fixed when the child is delegated.
pub(super) struct Plan {
    pub worker_id: String,
    pub title: String,
    pub task: String,
    pub branch: Option<String>,
    pub cwd: String,
    pub permission_mode: String,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub rounds: u32,
}

pub(super) fn other_provider(provider: &str) -> &'static str {
    if provider == "codex" { "claude" } else { "codex" }
}

pub(super) fn clamp_rounds(asked: Option<u32>) -> u32 {
    asked.unwrap_or(3).clamp(1, 5)
}

#[derive(Debug, PartialEq)]
pub(super) enum Verdict {
    Pass,
    Fail(String),
    Missing,
}

/// The verifier's last `VERDICT: pass|fail` line; what it wrote above that line is the reasons.
pub(super) fn parse_verdict(text: &str) -> Verdict {
    let lines: Vec<&str> = text.lines().collect();
    for (i, line) in lines.iter().enumerate().rev() {
        let bare = line.trim().trim_matches(|c| c == '*' || c == '`' || c == '#').trim().to_lowercase();
        let Some(word) = bare.strip_prefix("verdict:") else { continue };
        let reasons = lines[..i].join("\n").trim().to_string();
        return match word.trim().trim_matches(|c| c == '*' || c == '`') {
            "pass" => Verdict::Pass,
            "fail" => Verdict::Fail(if reasons.is_empty() { "(the verifier gave no reasons)".into() } else { reasons }),
            _ => Verdict::Missing,
        };
    }
    Verdict::Missing
}

fn verifier_prompt(plan: &Plan, report: &str, round: u32) -> String {
    let branch = match &plan.branch {
        Some(b) => format!("The work is committed on branch {b}, checked out in this folder (a git worktree)."),
        None => "The work is uncommitted changes in this folder.".into(),
    };
    format!(
        "<lotus-delegation from=\"{worker}\">You are a verifier (round {round} of {rounds}). Another agent did the task below; \
         check its work. Your last line goes back to Lotus, which acts on it.</lotus-delegation>\n\n\
         {branch}\n\n\
         Rules:\n\
         - Read-only: do not edit tracked files and do not commit. Write any probe in $TMPDIR.\n\
         - Read the whole diff. Judge whether each change removes the ROOT cause, not only whether a test is green. \
         Look for the same bug elsewhere and for regressions the diff introduces.\n\
         - Run the FULL test suite of every package the diff touches, not only the tests the agent ran. \
         A test that fails the same way without this diff is not a reason to fail it; say so.\n\
         - Deleting dead code needs no failing test first; a green build is the evidence.\n\
         - End with reasons (file:line, the input that still breaks), then a last line that is exactly \
         `VERDICT: pass` or `VERDICT: fail`.\n\n\
         ## The task\n\n{task}\n\n## The agent's report\n\n{report}",
        worker = plan.worker_id,
        rounds = plan.rounds,
        task = plan.task,
    )
}

impl ChatRuntime {
    /// Whether `thread_id` may still be working although no turn runs: background tasks remain, or
    /// its last event is under `SETTLE` old. Seen live: Claude starts its self-woken turn ~1 s after
    /// the last task settles, and a verifier started in that gap saw an uncommitted diff.
    pub(super) fn still_busy(&self, thread_id: &str) -> bool {
        let core = self.inner.core.lock();
        core.runs.get(thread_id).is_some_and(|r| r.background > 0 || r.limited_until.is_some() || now_ms() - r.last_event_at < SETTLE_MS)
    }

    /// When an out-of-quota thread's limit resets (ms); it is resumed then (`schedule_resume`).
    pub(super) fn paused_until(&self, thread_id: &str) -> Option<i64> {
        self.inner.core.lock().runs.get(thread_id).and_then(|r| r.limited_until)
    }

    pub(super) fn verify_state(&self, thread_id: &str) -> Option<VerifyState> {
        self.inner.core.lock().verifies.get(thread_id).cloned()
    }

    /// A delegated chat out of quota is sent on once its limit resets, so its lead and any verify
    /// loop get the work instead of the limit message. A chat the user drives is left to them.
    /// shortcut: the timer and the pause are lost on restart (the chat then reads as done with the limit
    /// message); persist `limited_until` if a restart mid-pause bites.
    pub(super) fn schedule_resume(&self, thread_id: &str) {
        let delegated = {
            let mut core = self.inner.core.lock();
            let delegated = core.store().ok().and_then(|s| s.thread(thread_id).ok().flatten()).is_some_and(|t| t.parent_id.is_some());
            delegated && core.resumes.insert(thread_id.to_string())
        };
        let Some(reset) = self.paused_until(thread_id).filter(|_| delegated) else { return };
        let runtime = self.clone();
        let id = thread_id.to_string();
        tokio::spawn(async move {
            // A minute past the reset: the provider's clock and ours are not the same clock.
            let wait = (reset - now_ms()).max(0) as u64 + RESUME_MARGIN_MS;
            tokio::time::sleep(Duration::from_millis(wait)).await;
            runtime.inner.core.lock().resumes.remove(&id);
            let idle = runtime.inner.core.lock().runs.get(&id).is_some_and(|r| r.active_turn.is_none());
            if runtime.paused_until(&id).is_none() || !idle {
                return;
            }
            let text = "<lotus-delegation from=\"lotus\">Your usage limit has reset. Continue the task where you \
                        left off, and end with a short, complete report.</lotus-delegation>";
            let short = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
            if let Err(error) = runtime.send(&id, text, &format!("resume-{short}"), Vec::new()).await {
                eprintln!("[chat-runtime] resume of {id} after its quota reset failed: {error}");
            }
        });
    }

    fn set_verify(&self, thread_id: &str, change: impl FnOnce(&mut VerifyState)) {
        if let Some(state) = self.inner.core.lock().verifies.get_mut(thread_id) {
            change(state);
        }
        self.rail_changed();
    }

    /// Ends the loop of each of `ids` that is still verifying (`lotus_chat_stop`).
    pub(super) fn cancel_verify(&self, ids: &[String]) {
        let mut core = self.inner.core.lock();
        for id in ids {
            if let Some(state) = core.verifies.get_mut(id).filter(|s| s.status == "verifying") {
                state.status = "interrupted";
            }
        }
    }

    pub(super) fn start_verify(&self, plan: Plan) {
        self.inner.core.lock().verifies.insert(
            plan.worker_id.clone(),
            VerifyState { status: "verifying", round: 0, rounds: plan.rounds, verifier_id: None, reasons: None },
        );
        let runtime = self.clone();
        tokio::spawn(async move {
            let worker = plan.worker_id.clone();
            let outcome = runtime.verify_loop(&plan).await;
            runtime.set_verify(&worker, |s| {
                if s.status != "verifying" {
                    return; // stopped meanwhile: keep "interrupted"
                }
                match outcome {
                    Ok(None) => s.status = "passed",
                    Ok(Some(reasons)) => {
                        s.status = "unverified";
                        s.reasons = Some(reasons);
                    }
                    Err(error) => {
                        s.status = "interrupted";
                        s.reasons = Some(error);
                    }
                }
            });
            // A verifier made after lotus_chat_stop took its snapshot is not stopped by it.
            if let Some(state) = runtime.verify_state(&worker).filter(|s| s.status == "interrupted") {
                if let Some(verifier) = state.verifier_id {
                    let _ = runtime.interrupt(&verifier).await;
                }
            }
        });
    }

    /// Ok(None) = passed; Ok(Some(reasons)) = unverified; Err = the loop was stopped or lost a chat.
    async fn verify_loop(&self, plan: &Plan) -> Result<Option<String>, String> {
        let deadline = Instant::now() + CAP;
        let gave_up = || Ok(Some(format!("gave up after {} h", CAP.as_secs() / 3600)));
        let worker = plan.worker_id.as_str();
        let mut since = 0;
        for round in 1..=plan.rounds {
            if !self.turn_ended(worker, worker, since, deadline).await? {
                return gave_up();
            }
            self.still_verifying(worker)?;
            let report = self.last_answer(worker).unwrap_or_default();
            let title = format!("verify · {} · r{round}", plan.title);
            let verifier = self
                .start_child(
                    worker,
                    &plan.cwd,
                    &plan.permission_mode,
                    &plan.provider,
                    plan.model.clone(),
                    plan.effort.clone(),
                    &title,
                    &verifier_prompt(plan, &report, round),
                )
                .await?;
            self.set_verify(worker, |s| {
                s.round = round;
                s.verifier_id = Some(verifier.clone());
            });
            if !self.turn_ended(worker, &verifier, 0, deadline).await? {
                return gave_up();
            }
            let reasons = match parse_verdict(&self.last_answer(&verifier).unwrap_or_default()) {
                Verdict::Pass => return Ok(None),
                Verdict::Missing => {
                    // Seen live: Codex failed a turn with "failed to load workspace requirements".
                    return Ok(Some(match self.last_turn_error(&verifier) {
                        Some(error) => format!("the verifier's turn failed before a verdict: {error}"),
                        None => "the verifier gave no VERDICT line".into(),
                    }));
                }
                Verdict::Fail(reasons) => reasons,
            };
            self.set_verify(worker, |s| s.reasons = Some(reasons.clone()));
            if round == plan.rounds {
                return Ok(Some(reasons));
            }
            self.still_verifying(worker)?;
            since = now_ms();
            let text = format!(
                "<lotus-delegation from=\"{verifier}\">A verifier on {} failed your work (round {round} of {}). Fix the \
                 causes it names, commit, and end with a short, complete report again.</lotus-delegation>\n\n{reasons}",
                plan.provider, plan.rounds
            );
            let short = uuid::Uuid::new_v4().simple().to_string()[..6].to_string();
            self.send(worker, &text, &format!("verify-{short}"), Vec::new()).await?;
            // A stop that landed during the send saw an idle worker; end the turn this send started.
            // shortcut: on Claude a still-queued input survives a plain interrupt (bridge-wide, the Stop
            // button has the same window); use thread/stop here if a stopped worker is seen running.
            if let Err(stopped) = self.still_verifying(worker) {
                let _ = self.interrupt(worker).await;
                return Err(stopped);
            }
            self.rail_changed();
        }
        unreachable!("the last round returns")
    }

    /// The error of `id`'s last turn, when it failed.
    fn last_turn_error(&self, id: &str) -> Option<String> {
        let events = self.inner.core.lock().store().ok()?.events_after(id, 0).ok()?;
        let last = events.iter().rev().find(|e| super::store::event_type(&e.event) == "turn/completed")?;
        (last.event["status"] == "failed").then(|| last.event["error"].as_str().unwrap_or("unknown error").to_string())
    }

    /// Err once `lotus_chat_stop` ended the loop or the worker is gone (deleted).
    fn still_verifying(&self, worker: &str) -> Result<(), String> {
        if self.verify_state(worker).is_none_or(|s| s.status != "verifying") {
            return Err("stopped".into());
        }
        if !self.list_threads()?.iter().any(|t| t.id == worker) {
            return Err(format!("chat {worker} is gone"));
        }
        Ok(())
    }

    /// Waits until `id` has finished a turn at or after `since` (ms) and is not working: true, or
    /// false at `deadline`. A chat waiting on the user's permission is waited on: that is theirs.
    async fn turn_ended(&self, worker: &str, id: &str, since: i64, deadline: Instant) -> Result<bool, String> {
        loop {
            self.still_verifying(worker)?;
            let thread = self.list_threads()?.into_iter().find(|t| t.id == id).ok_or_else(|| format!("chat {id} is gone"))?;
            let ended = thread.last_turn_ended_at.is_some_and(|at| at >= since);
            if thread.status.is_none() && ended && !self.still_busy(id) {
                return Ok(true);
            }
            // A quota pause can outlast the cap; the work is not stuck, it resumes at the reset.
            if Instant::now() > deadline && self.paused_until(id).is_none() {
                return Ok(false);
            }
            tokio::time::sleep(POLL).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_verdict_line_decides_and_what_is_above_it_is_the_reasons() {
        assert_eq!(parse_verdict("all good\nVERDICT: pass"), Verdict::Pass);
        assert_eq!(parse_verdict("**VERDICT: PASS**"), Verdict::Pass);
        assert_eq!(parse_verdict("`VERDICT: fail`"), Verdict::Fail("(the verifier gave no reasons)".into()));
        assert_eq!(
            parse_verdict("x.rs:3 still panics on \"\"\n\nVERDICT: fail\n"),
            Verdict::Fail("x.rs:3 still panics on \"\"".into())
        );
        // An earlier verdict quoted in the reasons does not count; the last one does.
        assert_eq!(parse_verdict("round 1 said VERDICT: fail\nVERDICT: pass"), Verdict::Pass);
        assert_eq!(parse_verdict("VERDICT: pass\nbut actually\nVERDICT: fail"), Verdict::Fail("VERDICT: pass\nbut actually".into()));
        assert_eq!(parse_verdict("looks fine"), Verdict::Missing);
        assert_eq!(parse_verdict("VERDICT: maybe"), Verdict::Missing);
    }

    #[test]
    fn the_verifier_runs_on_the_other_provider_for_one_to_five_rounds() {
        assert_eq!(other_provider("claude"), "codex");
        assert_eq!(other_provider("codex"), "claude");
        assert_eq!(clamp_rounds(None), 3);
        assert_eq!(clamp_rounds(Some(0)), 1);
        assert_eq!(clamp_rounds(Some(9)), 5);
    }
}
