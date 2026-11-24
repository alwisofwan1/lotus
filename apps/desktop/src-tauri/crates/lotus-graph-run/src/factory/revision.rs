//! Revision Runs on the record side (CoS 6, ADR-0057): starting a round by hand, and writing what
//! a finished round did back onto the Factory PR's record.
//!
//! The Factory PR's state lives on the run that opened it ([`crate::PrWatch`]). A round is its own
//! Factory Run whose ticket carries [`RevisionOf`]; [`start_round`] starts it through the engine
//! and lists it in [`crate::PrWatch::rounds`]. [`reconcile_rounds`] (each watcher tick) reads a
//! round that ended and writes its outcome onto the PR: "waiting for review" when it pushed, Needs
//! you when it stopped. The PR watcher and these writes share one lock ([`PrEdits`]), so neither
//! saves over the other.

use std::sync::Arc;

use super::definition::{Replies, Revise};
use super::test_guard;
use crate::{
    Amendment, BoxFuture, ChiefEntry, ChiefOfStaffLog, ChiefSignal, Engine, FactoryTicket, FeedbackItem, FeedbackLabel, GraphRunRecord, Intake, ItemStatus, PrPhase, PrWatch,
    RevisionOf, RevisionRound, RoundEnd, RoundItem, RunBrief, RunStatus, RunStore, StartRun,
};

/// Held while a Factory PR's record is read, changed and saved by the watcher or by a round start.
pub type PrEdits = Arc<tokio::sync::Mutex<()>>;

/// The labels a round works on. A question needs an answer, a spec change a decision, and none
/// nothing: they stay with the user.
pub const ROUND_LABELS: [FeedbackLabel; 2] = [FeedbackLabel::Change, FeedbackLabel::Nit];

/// What the repo's factory says about rounds: read from `origin/<base>` each time a round may start.
#[derive(Debug, Clone, PartialEq)]
pub struct RoundPolicy {
    pub revise: Revise,
    /// `replies`: whether addressed replies go out by themselves (CoS 9).
    pub replies: Replies,
    /// `reply_footer`: added under everything Lotus posts.
    pub reply_footer: Option<String>,
    /// The repo's `cap_usd`; `None` = the cap the PR's run had.
    pub cap_usd: Option<f64>,
    pub max_rounds: u32,
}

/// Reads a repo's [`RoundPolicy`]. The app reads the factory definition; tests answer directly.
pub trait RoundPolicies: Send + Sync {
    fn policy(&self, ticket: &FactoryTicket) -> BoxFuture<Result<RoundPolicy, String>>;
}

/// What a closed batch leads to (the routing rule, CoS 7). Each carries its reason for the log.
#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    /// The round starts with no click.
    Start(String),
    /// The user decides: edit labels, then Start round.
    NeedsYou(String),
    /// The PR had all its rounds: Needs you, and the PR shows "Out of rounds".
    OutOfRounds(String),
    /// Every item says there is nothing to do: logged, not raised.
    Nothing(String),
}

/// The routing rule for the batch `items` just closed on `watch`. A round starts by itself only when
/// `revise = "auto"`, the PR is open, rounds are left, no round runs, every label is confident and
/// is change, nit or none (CI is change), and at least one is a change. A batch of nits alone waits:
/// nits ride along with a round, they never start one.
pub fn route(items: &[&FeedbackItem], watch: &PrWatch, policy: &RoundPolicy) -> Route {
    if watch.phase.is_ended() {
        return Route::NeedsYou("the PR is not open".into());
    }
    let used = watch.rounds.len() as u32;
    if used >= policy.max_rounds {
        return Route::OutOfRounds(format!("the PR had all its {} rounds (max_rounds)", policy.max_rounds));
    }
    if let Some(running) = watch.rounds.iter().find(|r| r.ended.is_none()) {
        return Route::NeedsYou(format!("round {} is still running; start the next one after it", running.round));
    }
    let unsure = items.iter().filter(|i| i.unsure.is_some() || i.label.is_none()).count();
    if unsure > 0 {
        return Route::NeedsYou(format!("{unsure} label{} not sure", if unsure == 1 { " is" } else { "s are" }));
    }
    let n = |label: FeedbackLabel| items.iter().filter(|i| i.label == Some(label)).count();
    let asks: Vec<String> = [(FeedbackLabel::Question, "question"), (FeedbackLabel::SpecChange, "spec change")]
        .into_iter()
        .filter_map(|(label, what)| match n(label) {
            0 => None,
            1 => Some(format!("1 {what}")),
            k => Some(format!("{k} {what}s")),
        })
        .collect();
    if !asks.is_empty() {
        return Route::NeedsYou(format!("{} wait{} for your answer", asks.join(" and "), if n(FeedbackLabel::Question) + n(FeedbackLabel::SpecChange) == 1 { "s" } else { "" }));
    }
    let (changes, nits) = (n(FeedbackLabel::Change), n(FeedbackLabel::Nit));
    if changes == 0 && nits == 0 {
        return Route::Nothing("every item says there is nothing to do".into());
    }
    if changes == 0 {
        return Route::NeedsYou("only nits: they ride along with a round and never start one".into());
    }
    if policy.revise == Revise::Confirm {
        return Route::NeedsYou("revise = \"confirm\": every round waits for Start round".into());
    }
    // CI that keeps failing is often flaky or broken on the base: one paid round, then the user.
    if ci_only(items) && watch.rounds.iter().any(|r| r.ci_only) {
        return Route::NeedsYou("CI still fails after a round that started by itself on CI alone; check whether it is flaky or broken on the base".into());
    }
    let nits = if nits > 0 { format!(" and {nits} nit{}", if nits == 1 { "" } else { "s" }) } else { String::new() };
    Route::Start(format!("{changes} change{}{nits}, every label sure", if changes == 1 { "" } else { "s" }))
}

/// Every change in `items` is failing CI: no person asked for one.
pub fn ci_only(items: &[&FeedbackItem]) -> bool {
    !items.iter().any(|i| i.label == Some(FeedbackLabel::Change) && i.source != crate::FeedbackSource::Check)
}

/// An item in this state waits for the user: never sent to a round yet, or a round declined it or
/// did not address it. The next round may take it again.
pub fn waits_for_you(status: ItemStatus) -> bool {
    matches!(status, ItemStatus::NeedsYou | ItemStatus::NotAddressed | ItemStatus::Declined)
}

/// A sure change or nit, or a spec change the user accepted: what a round works on.
fn goes_to_round(item: &FeedbackItem) -> bool {
    item.unsure.is_none()
        && match item.label {
            Some(FeedbackLabel::SpecChange) => item.amendment.is_some(),
            Some(label) => ROUND_LABELS.contains(&label),
            None => false,
        }
}

/// The approved spec with its Amendments (CoS 8): each new criterion at the end of the acceptance
/// criteria, where the reviewer reads them, and an `## Amendments` section saying where each came
/// from. The approved criteria are never rewritten. `None` when the run has no approved spec.
pub fn amended_spec(intake: &Intake) -> Option<String> {
    let spec = intake.approved_spec()?;
    if intake.amendments.is_empty() {
        return Some(spec.to_string());
    }
    let added: String = intake.amendments.iter().flat_map(|a| a.criteria.iter().map(move |c| format!("- {c} _(Amendment {})_\n", a.n))).collect();
    let mut out = match test_guard::acceptance_end(spec) {
        Some(end) => {
            let rest = spec[end..].trim_start_matches('\n');
            let gap = if rest.is_empty() { "" } else { "\n" };
            format!("{}\n{added}{gap}{rest}", spec[..end].trim_end())
        }
        None => format!("{}\n\n## Added criteria\n\n{added}", spec.trim_end()),
    };
    out = format!("{}\n\n## Amendments\n\n", out.trim_end());
    for a in &intake.amendments {
        let names: Vec<&str> = a.criteria.iter().map(|c| c.split(':').next().unwrap_or(c)).collect();
        let link = a.url.as_deref().map(|u| format!(" ({u})")).unwrap_or_default();
        out.push_str(&format!("- Amendment {}, {}: {}, accepted from {}'s spec change `{}`{link}\n", a.n, day(a.at), names.join(", "), a.author, a.item));
    }
    Some(out)
}

/// `2026-10-13` for Unix ms (UTC).
fn day(at_ms: i64) -> String {
    // Days to civil date (Howard Hinnant's algorithm).
    let z = at_ms.div_euclid(86_400_000) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `AC-9: text`, `- text` or `text` → `text`: Lotus numbers the criteria itself.
fn criterion_text(line: &str) -> &str {
    let line = line.trim().trim_start_matches(['-', '*']).trim_start();
    let Some(rest) = line.strip_prefix("AC-") else { return line };
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    rest.trim_start_matches([':', '.', ')']).trim_start()
}

/// The spec change `item_id` on the PR that run `run_id` opened, still waiting for the user.
fn open_spec_change<'a>(watch: &'a mut PrWatch, item_id: &str) -> Result<&'a mut FeedbackItem, String> {
    if watch.phase.is_ended() {
        return Err("the PR is merged or closed".into());
    }
    let item = watch.feedback.iter_mut().find(|i| i.id == item_id).ok_or_else(|| format!("the PR has no feedback item {item_id}"))?;
    if item.label != Some(FeedbackLabel::SpecChange) {
        return Err("only an item labelled spec change can be accepted or declined".into());
    }
    if !waits_for_you(item.status) || item.amendment.is_some() {
        return Err("this spec change was decided already".into());
    }
    Ok(item)
}

/// Accept: the spec change becomes an Amendment with new criteria on the approved spec, and the
/// next round works on it (CoS 8). It starts no round: the user presses Start round.
pub async fn accept_spec_change(store: &dyn RunStore, edits: &PrEdits, run_id: &str, item_id: &str, criteria: &[String], now: i64) -> Result<GraphRunRecord, String> {
    let _held = edits.lock().await;
    let mut record = store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
    let intake = meta.intake.as_mut().filter(|i| i.approved_spec().is_some()).ok_or("the run has no approved spec to amend")?;
    let watch = meta.pr_watch.as_mut().ok_or("the Chief of Staff has not looked at the PR yet")?;
    let item = open_spec_change(watch, item_id)?;
    let texts: Vec<&str> = criteria.iter().map(|c| criterion_text(c)).filter(|c| !c.is_empty()).collect();
    if texts.is_empty() {
        return Err("write at least one new criterion".into());
    }
    let last = amended_spec(intake).map(|s| test_guard::spec_acs(&s)).and_then(|acs| acs.last().copied()).unwrap_or(0);
    let numbered: Vec<String> = texts.iter().zip(last + 1..).map(|(text, k)| format!("AC-{k}: {text}")).collect();
    let n = intake.amendments.len() as u32 + 1;
    intake.amendments.push(Amendment { n, at: now, item: item.id.clone(), author: item.author.clone(), url: item.url.clone(), criteria: numbered.clone() });
    item.amendment = Some(n);
    item.status = ItemStatus::NeedsYou;
    item.why = None;
    let names: Vec<&str> = numbered.iter().map(|c| c.split(':').next().unwrap_or(c)).collect();
    let text = format!("Spec change `{item_id}` accepted as Amendment {n} ({}). The next round builds it; press Start round.", names.join(", "));
    meta.chief.get_or_insert_with(ChiefOfStaffLog::default).say(now, text);
    store.save(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// Decline: the spec change is out of this PR's scope, and a polite reply is drafted. The draft is
/// sent only when the user presses Send, never by itself (ADR-0058).
pub async fn decline_spec_change(store: &dyn RunStore, edits: &PrEdits, run_id: &str, item_id: &str, now: i64) -> Result<GraphRunRecord, String> {
    let _held = edits.lock().await;
    let mut record = store.get(run_id).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {run_id}"))?;
    let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
    let watch = meta.pr_watch.as_mut().ok_or("the Chief of Staff has not looked at the PR yet")?;
    let item = open_spec_change(watch, item_id)?;
    item.status = ItemStatus::OutOfScope;
    item.reply = Some(out_of_scope_reply(&item.author));
    let still_waiting = super::replies::waits_on_you(watch);
    let log = meta.chief.get_or_insert_with(ChiefOfStaffLog::default);
    log.say(now, format!("Spec change `{item_id}` declined as out of scope. A reply is drafted; it is sent only when you press Send."));
    if !still_waiting {
        log.note(ChiefEntry { at: now, signal: Some(ChiefSignal::Feedback), raised: false, text: "Nothing waits for you.".into() });
    }
    store.save(&record).map_err(|e| e.to_string())?;
    Ok(record)
}

/// The drafted answer to a declined spec change.
pub fn out_of_scope_reply(author: &str) -> String {
    format!(
        "Thanks, @{author}. This goes beyond what this PR set out to do, so I'd rather keep it out of here and \
         handle it as a separate change."
    )
}

/// Why a round cannot start now, or what it would work on.
pub fn round_items(record: &GraphRunRecord, max_rounds: u32) -> Result<Vec<RoundItem>, String> {
    let meta = record.checkpoint.engine.as_ref().ok_or("the run has no engine data")?;
    let ticket = meta.factory.as_ref().ok_or("the run is not a Factory Run")?;
    if ticket.revision.is_some() {
        return Err("this run is a round itself: start the next round from the PR's first run".into());
    }
    if record.status != RunStatus::Completed {
        return Err("the run has no open Factory PR".into());
    }
    let watch = meta.pr_watch.as_ref().ok_or("the Chief of Staff has not looked at the PR yet")?;
    if watch.phase.is_ended() || meta.pr.is_some() {
        return Err("the PR is merged or closed".into());
    }
    if let Some(running) = watch.rounds.iter().find(|r| r.ended.is_none()) {
        return Err(format!("round {} is still running", running.round));
    }
    if watch.rounds.len() as u32 >= max_rounds {
        return Err(format!("the PR has had all its {max_rounds} rounds (max_rounds)"));
    }
    let items: Vec<RoundItem> = watch
        .feedback
        .iter()
        .filter(|i| i.counts && waits_for_you(i.status) && goes_to_round(i))
        .map(|i| RoundItem { id: i.id.clone(), author: i.author.clone(), body: i.body.clone(), path: i.path.clone(), line: i.line, label: i.label })
        .collect();
    if items.is_empty() {
        return Err("no change, nit or accepted spec change waits for a round (set the label of an unsure item first)".into());
    }
    Ok(items)
}

/// What starts round `round` of the PR that `record`'s run opened. `cap_usd` is the repo's cap: each
/// round gets all of it.
pub fn round_start(record: &GraphRunRecord, items: Vec<RoundItem>, cap_usd: f64) -> Result<StartRun, String> {
    let meta = record.checkpoint.engine.as_ref().ok_or("the run has no engine data")?;
    let ticket = meta.factory.as_ref().ok_or("the run is not a Factory Run")?;
    let watch = meta.pr_watch.as_ref().ok_or("the Chief of Staff has not looked at the PR yet")?;
    let branch = pr_branch(record).ok_or("the run's PR branch is not known")?;
    let round = watch.rounds.len() as u32 + 1;
    let revision = RevisionOf {
        original: record.id.clone(),
        pr_url: watch.url.clone(),
        pr_number: watch.number,
        branch,
        round,
        spec: meta.intake.as_ref().and_then(amended_spec),
        items,
    };
    let factory = FactoryTicket { previous_failure: None, revision: Some(revision), ..ticket.clone() };
    Ok(StartRun {
        project_id: record.project_id.clone(),
        graph: crate::RunGraph { node_ids: record.checkpoint.node_ids.clone(), deps: Vec::new() },
        workflow_id: record.workflow_id.clone(),
        run: Some(RunBrief { title: format!("Round {round}: {} ({})", ticket.title, ticket.label()), brief: format!("Revision Run {round} of {}", watch.url) }),
        budget_cap: Some(cap_usd),
        factory: Some(factory),
    })
}

/// The PR's branch: what GitHub reported for the PR wins (a template names the branch, FM3), else
/// the branch the run recorded when it opened the PR. Never rebuilt from the ticket: a guess would
/// push a round to another branch.
fn pr_branch(record: &GraphRunRecord) -> Option<String> {
    let meta = record.checkpoint.engine.as_ref()?;
    meta.pr_watch.as_ref().and_then(|w| w.branch.clone()).or_else(|| meta.progress.as_ref()?.pr_opening.as_ref()?.branch.clone())
}

/// Starts the next round of the PR that run `original` opened, and lists it on the PR. Returns
/// the round's run id and the PR's record as saved.
pub async fn start_round(
    engine: &Engine,
    store: &dyn RunStore,
    edits: &PrEdits,
    original: &str,
    cap_usd: f64,
    max_rounds: u32,
    now: i64,
) -> Result<(String, GraphRunRecord), String> {
    let _held = edits.lock().await;
    start_round_held(engine, store, original, cap_usd, max_rounds, now, "", false).await
}

/// [`start_round`] with [`PrEdits`] already held by the caller (the watcher's automatic round).
/// `why` is added to the log note: how the round came to start.
pub(crate) async fn start_round_held(
    engine: &Engine,
    store: &dyn RunStore,
    original: &str,
    cap_usd: f64,
    max_rounds: u32,
    now: i64,
    why: &str,
    ci_only: bool,
) -> Result<(String, GraphRunRecord), String> {
    let record = store.get(original).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {original}"))?;
    let items = round_items(&record, max_rounds)?;
    let ids: Vec<String> = items.iter().map(|i| i.id.clone()).collect();
    let start = round_start(&record, items, cap_usd)?;
    let round = start.factory.as_ref().and_then(|t| t.revision.as_ref()).map_or(1, |r| r.round);
    let run_id = engine.start(start).await.map_err(|e| e.to_string())?;

    // Read again: the engine start took a while, and this lock does not cover the pane's edits.
    let mut record = store.get(original).map_err(|e| e.to_string())?.ok_or_else(|| format!("no run {original}"))?;
    let meta = record.checkpoint.engine.as_mut().ok_or("the run has no engine data")?;
    let watch = meta.pr_watch.as_mut().ok_or("the PR is no longer watched")?;
    for item in watch.feedback.iter_mut().filter(|i| ids.contains(&i.id)) {
        item.status = ItemStatus::InRound;
    }
    watch.rounds.push(RevisionRound { round, run_id: run_id.clone(), started_at: now, items: ids.clone(), ended: None, ended_at: None, note: None, ci_only, summary: None, summary_sent: None, drafted: false, rerequested: None, slack: None });
    watch.max_rounds = Some(max_rounds);
    watch.phase = PrPhase::Revising;
    let still_waiting = super::replies::waits_on_you(watch);
    let log = meta.chief.get_or_insert_with(ChiefOfStaffLog::default);
    log.say(now, format!("Round {round} of {max_rounds} started on {} item{}{why}.", ids.len(), if ids.len() == 1 { "" } else { "s" }));
    if !still_waiting {
        log.note(ChiefEntry { at: now, signal: Some(ChiefSignal::Feedback), raised: false, text: "No feedback waits for you: a round works on it.".into() });
    }
    store.save(&record).map_err(|e| e.to_string())?;
    Ok((run_id, record))
}

/// Writes every round that ended since the last look onto its PR's record. Returns the records
/// it saved. Needs [`PrEdits`] held by the caller.
pub fn reconcile_rounds(store: &dyn RunStore, original: &str, now: i64) -> Result<Option<GraphRunRecord>, String> {
    let Some(mut record) = store.get(original).map_err(|e| e.to_string())? else { return Ok(None) };
    let Some(meta) = record.checkpoint.engine.as_mut() else { return Ok(None) };
    let Some(watch) = meta.pr_watch.as_mut() else { return Ok(None) };
    let mut changed = false;
    let log = meta.chief.get_or_insert_with(ChiefOfStaffLog::default);
    for round in watch.rounds.iter_mut().filter(|r| r.ended.is_none()) {
        let Some(run) = store.get(&round.run_id).map_err(|e| e.to_string())? else {
            // The round's record is gone: nothing will ever end it.
            round.ended = Some(RoundEnd::NeedsYou);
            round.ended_at = Some(now);
            round.note = Some("the round's run record is missing".into());
            for item in watch.feedback.iter_mut().filter(|i| round.items.contains(&i.id) && i.status == ItemStatus::InRound) {
                item.status = ItemStatus::NeedsYou;
            }
            changed = true;
            continue;
        };
        if !matches!(run.status, RunStatus::Completed | RunStatus::Error | RunStatus::Cancelled) {
            continue;
        }
        let detail = run
            .checkpoint
            .completed
            .values()
            .find_map(|r| r.detail.clone())
            .or_else(|| run.checkpoint.failed_detail.as_ref().and_then(|d| d.values().next().cloned()));
        let report = run.checkpoint.engine.as_ref().and_then(|m| m.progress.as_ref()).and_then(|p| p.round.clone());
        round.ended_at = Some(now);
        changed = true;
        match (run.status, report) {
            (RunStatus::Completed, Some(report)) => {
                round.ended = Some(RoundEnd::Pushed);
                round.note = detail;
                let mut declined = Vec::new();
                let mut open = Vec::new();
                for verdict in &report.items {
                    if let Some(item) = watch.feedback.iter_mut().find(|i| i.id == verdict.id) {
                        item.status = verdict.status;
                        item.why = Some(verdict.why.clone()).filter(|w| !w.is_empty());
                        match verdict.status {
                            ItemStatus::Declined => declined.push(format!("`{}` ({})", item.id, verdict.why)),
                            ItemStatus::NotAddressed => open.push(format!("`{}` ({})", item.id, verdict.why)),
                            _ => {}
                        }
                    }
                }
                let addressed = report.items.iter().filter(|v| v.status == ItemStatus::Addressed).count();
                log.say(now, format!("Round {}: {addressed} of {} items addressed. {}.", round.round, report.items.len(), round.note.clone().unwrap_or_default()));
                if !declined.is_empty() || !open.is_empty() {
                    let mut text = format!("Round {} needs you:", round.round);
                    if !declined.is_empty() {
                        text.push_str(&format!(" declined {}.", declined.join(", ")));
                    }
                    if !open.is_empty() {
                        text.push_str(&format!(" Not addressed {}.", open.join(", ")));
                    }
                    raise(log, now, text);
                }
                if !watch.phase.is_ended() {
                    watch.phase = PrPhase::WaitingForReview;
                }
            }
            _ => {
                let why = match run.status {
                    RunStatus::Cancelled => "the round was aborted".to_string(),
                    _ => detail.unwrap_or_else(|| "the round stopped".into()),
                };
                round.ended = Some(RoundEnd::NeedsYou);
                round.note = Some(why.clone());
                for item in watch.feedback.iter_mut().filter(|i| round.items.contains(&i.id) && i.status == ItemStatus::InRound) {
                    item.status = ItemStatus::NeedsYou;
                }
                raise(log, now, format!("Round {} stopped without a push and needs you: {why}", round.round));
                if !watch.phase.is_ended() {
                    watch.phase = PrPhase::NeedsYou;
                }
            }
        }
    }
    if !changed {
        return Ok(None);
    }
    store.save(&record).map_err(|e| e.to_string())?;
    Ok(Some(record))
}

/// True when the PR has a round that has not ended.
pub fn has_open_round(record: &GraphRunRecord) -> bool {
    record.checkpoint.engine.as_ref().and_then(|m| m.pr_watch.as_ref()).is_some_and(|w| w.rounds.iter().any(|r| r.ended.is_none()))
}

fn raise(log: &mut ChiefOfStaffLog, at: i64, text: String) {
    log.log.push(ChiefEntry { at, signal: Some(ChiefSignal::Feedback), raised: true, text });
    if !log.is_open(ChiefSignal::Feedback) {
        log.open.push(ChiefSignal::Feedback);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FeedbackSource, PrSeen};

    fn item(label: Option<FeedbackLabel>, unsure: bool) -> FeedbackItem {
        FeedbackItem {
            id: "i".into(),
            source: FeedbackSource::PrComment,
            author: "rev".into(),
            counts: true,
            body: String::new(),
            path: None,
            line: None,
            url: None,
            at: 0,
            label,
            confidence: None,
            label_by: None,
            unsure: unsure.then(|| "low".into()),
            status: ItemStatus::NeedsYou,
            batch: Some(1),
            reply: None,
            reply_sent: None,
            why: None,
            amendment: None,
        }
    }

    fn watch(rounds: Vec<RevisionRound>, phase: PrPhase) -> PrWatch {
        PrWatch { number: 1, url: "u".into(), phase, seen: PrSeen::default(), feedback: Vec::new(), batches: Vec::new(), rounds, max_rounds: None, posted: Vec::new(), branch: None }
    }

    fn round(n: u32, ended: Option<RoundEnd>) -> RevisionRound {
        RevisionRound { round: n, run_id: format!("r{n}"), started_at: 0, items: Vec::new(), ended, ended_at: None, note: None, ci_only: false, summary: None, summary_sent: None, drafted: false, rerequested: None, slack: None }
    }

    const AUTO: RoundPolicy = RoundPolicy { revise: Revise::Auto, replies: Replies::Draft, reply_footer: None, cap_usd: None, max_rounds: 3 };

    fn kind(route: &Route) -> &'static str {
        match route {
            Route::Start(_) => "start",
            Route::NeedsYou(_) => "needs you",
            Route::OutOfRounds(_) => "out of rounds",
            Route::Nothing(_) => "nothing",
        }
    }

    #[test]
    fn the_label_mix_of_a_batch_decides_between_a_round_and_needs_you() {
        use FeedbackLabel::*;
        let sure = |l| item(Some(l), false);
        let table: Vec<(&str, Vec<FeedbackItem>, &str)> = vec![
            ("one change", vec![sure(Change)], "start"),
            ("change and nit", vec![sure(Change), sure(Nit)], "start"),
            ("change and none", vec![sure(Change), sure(None)], "start"),
            ("CI (a change by rule)", vec![FeedbackItem { source: FeedbackSource::Check, ..sure(Change) }], "start"),
            ("nits only", vec![sure(Nit), sure(Nit)], "needs you"),
            ("nit and none", vec![sure(Nit), sure(None)], "needs you"),
            ("none only", vec![sure(None)], "nothing"),
            ("change and question", vec![sure(Change), sure(Question)], "needs you"),
            ("change and spec change", vec![sure(Change), sure(SpecChange)], "needs you"),
            ("an unsure change", vec![item(Some(Change), true)], "needs you"),
            ("a change and an unlabelled item", vec![sure(Change), item(Option::None, true)], "needs you"),
        ];
        for (case, items, want) in table {
            let refs: Vec<&FeedbackItem> = items.iter().collect();
            let got = route(&refs, &watch(Vec::new(), PrPhase::InReview), &AUTO);
            assert_eq!(kind(&got), want, "{case}: {got:?}");
        }
    }

    #[test]
    fn confirm_running_rounds_and_used_up_rounds_hold_back_a_round_that_would_start() {
        let change = item(Some(FeedbackLabel::Change), false);
        let items = [&change];
        let confirm = RoundPolicy { revise: Revise::Confirm, ..AUTO };
        assert_eq!(route(&items, &watch(Vec::new(), PrPhase::InReview), &confirm), Route::NeedsYou("revise = \"confirm\": every round waits for Start round".into()));
        let running = route(&items, &watch(vec![round(1, None)], PrPhase::Revising), &AUTO);
        assert_eq!(running, Route::NeedsYou("round 1 is still running; start the next one after it".into()));
        let used = vec![round(1, Some(RoundEnd::Pushed)), round(2, Some(RoundEnd::Pushed)), round(3, Some(RoundEnd::Pushed))];
        assert_eq!(kind(&route(&items, &watch(used.clone(), PrPhase::WaitingForReview), &AUTO)), "out of rounds");
        // Out of rounds is said even for a batch that would never start one.
        let question = item(Some(FeedbackLabel::Question), false);
        assert_eq!(kind(&route(&[&question], &watch(used, PrPhase::WaitingForReview), &AUTO)), "out of rounds");
        assert_eq!(kind(&route(&items, &watch(vec![round(1, Some(RoundEnd::Pushed))], PrPhase::WaitingForReview), &AUTO)), "start");
    }

    #[test]
    fn failing_ci_alone_starts_one_round_by_itself_per_pr() {
        let ci = FeedbackItem { source: FeedbackSource::Check, ..item(Some(FeedbackLabel::Change), false) };
        let person = item(Some(FeedbackLabel::Change), false);
        let after_ci_round = watch(vec![RevisionRound { ci_only: true, ..round(1, Some(RoundEnd::Pushed)) }], PrPhase::WaitingForReview);
        let after_person_round = watch(vec![round(1, Some(RoundEnd::Pushed))], PrPhase::WaitingForReview);
        assert!(ci_only(&[&ci]) && !ci_only(&[&ci, &person]));
        assert_eq!(kind(&route(&[&ci], &watch(Vec::new(), PrPhase::InReview), &AUTO)), "start", "the first CI-only round");
        assert_eq!(kind(&route(&[&ci], &after_person_round, &AUTO)), "start", "the earlier round was asked by a person");
        let held = route(&[&ci], &after_ci_round, &AUTO);
        assert!(matches!(&held, Route::NeedsYou(why) if why.starts_with("CI still fails")), "{held:?}");
        assert_eq!(kind(&route(&[&ci, &person], &after_ci_round, &AUTO)), "start", "a person's change still starts one");
    }

    #[test]
    fn each_decision_says_why() {
        let change = item(Some(FeedbackLabel::Change), false);
        let nit = item(Some(FeedbackLabel::Nit), false);
        let q = item(Some(FeedbackLabel::Question), false);
        let w = watch(Vec::new(), PrPhase::InReview);
        assert_eq!(route(&[&change, &nit], &w, &AUTO), Route::Start("1 change and 1 nit, every label sure".into()));
        assert_eq!(route(&[&change, &q], &w, &AUTO), Route::NeedsYou("1 question waits for your answer".into()));
        assert_eq!(route(&[&nit], &w, &AUTO), Route::NeedsYou("only nits: they ride along with a round and never start one".into()));
        assert_eq!(route(&[&item(Some(FeedbackLabel::Change), true)], &w, &AUTO), Route::NeedsYou("1 label is not sure".into()));
    }
    fn intake(spec: &str, criteria: &[&str]) -> Intake {
        let amendment = Amendment { n: 1, at: 0, item: "line:7".into(), author: "bob".into(), url: None, criteria: criteria.iter().map(|c| c.to_string()).collect() };
        Intake {
            turns: vec![crate::IntakeTurn::Spec { markdown: spec.into(), sent_back: None, live: false, doc: None, edited: false, at: 0 }],
            approved: true,
            amendments: if criteria.is_empty() { Vec::new() } else { vec![amendment] },
            ..Intake::default()
        }
    }

    #[test]
    fn an_amendment_adds_its_criteria_where_the_reviewer_counts_them_and_never_rewrites_the_spec() {
        let last = intake("## Acceptance criteria\n\n- AC-1: a\n", &["AC-2: b"]);
        let spec = amended_spec(&last).unwrap();
        assert!(spec.starts_with("## Acceptance criteria\n\n- AC-1: a\n- AC-2: b _(Amendment 1)_\n\n## Amendments\n\n- Amendment 1, 1970-01-01: AC-2, accepted from bob's spec change `line:7`\n"), "{spec}");
        assert_eq!(test_guard::spec_acs(&spec), vec![1, 2]);
        let loose = intake("Do AC-1.", &["AC-2: b"]);
        let spec = amended_spec(&loose).unwrap();
        assert!(spec.starts_with("Do AC-1.\n\n## Added criteria\n\n- AC-2: b _(Amendment 1)_\n"), "{spec}");
        assert_eq!(test_guard::spec_acs(&spec), vec![1, 2]);
        assert_eq!(amended_spec(&intake("## Acceptance criteria\n- AC-1: a", &[])).as_deref(), Some("## Acceptance criteria\n- AC-1: a"), "no amendment: the spec as approved");
        assert_eq!(amended_spec(&Intake { approved: false, ..loose }), None);
    }

    #[test]
    fn the_user_may_type_a_criterion_with_or_without_its_number() {
        for line in ["AC-12: logs it", "- AC-3. logs it", "* logs it", "  logs it  ", "AC-4) logs it"] {
            assert_eq!(criterion_text(line), "logs it", "{line}");
        }
        assert_eq!(day(1_791_878_400_000), "2026-10-13");
        assert_eq!(day(951_782_400_000), "2000-02-29");
    }
}

