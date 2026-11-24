//! A Revision Run's step (CoS 6, ADR-0057): one round of fixes on an open Factory PR.
//!
//! It starts from `origin/<PR branch>` in a fresh worktree on its own local branch, so a commit the
//! reviewer pushed is kept. Implement gets the spec, the round's Feedback Items and the PR's diff,
//! and may decline an item with a reason. The gate runs as on any run. The reviewer judges each AC
//! and each item; an item not addressed goes back to implement while attempts are left. The round
//! commits on top of the branch and pushes with a plain push: never `--force`, never a rebase. A
//! refused push or a conflict with the base stops the round for a person. No PR is opened.

use crate::no_window::NoWindow;
use std::collections::HashMap;

use serde_json::{json, Value};

use super::*;
use super::super::SidecarRound;
use crate::{FeedbackLabel, ItemStatus, ItemVerdict, RevisionOf, RoundReport};

/// The reply the round's reviewer gives: the normal review, plus one verdict per item.
pub fn revision_review_schema() -> Value {
    let mut schema = review_schema();
    schema["required"].as_array_mut().expect("required list").push(json!("items"));
    schema["properties"]["items"] = json!({
        "type": "array",
        "description": "One entry per Feedback Item of the round, by id.",
        "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "verdict", "why"],
            "properties": {
                "id": { "type": "string" },
                "verdict": { "type": "string", "enum": ["addressed", "not-addressed"] },
                "why": { "type": "string", "description": "The code that does it, or what is still missing." }
            }
        }
    });
    schema
}

/// `id → (addressed, why)` for exactly the asked `ids`.
pub fn parse_item_verdicts(reply: &Value, ids: &[&str]) -> Result<HashMap<String, (bool, String)>, String> {
    let items = reply["items"].as_array().ok_or("the review has no items list")?;
    let mut out = HashMap::new();
    for item in items {
        let id = item["id"].as_str().ok_or("an item verdict has no id")?;
        if !ids.contains(&id) {
            return Err(format!("the review judges item \"{id}\", which is not in the round"));
        }
        let addressed = match item["verdict"].as_str() {
            Some("addressed") => true,
            Some("not-addressed") => false,
            _ => return Err(format!("{id}: the verdict is not addressed or not-addressed")),
        };
        let why = item["why"].as_str().unwrap_or_default().trim().to_string();
        if out.insert(id.to_string(), (addressed, why)).is_some() {
            return Err(format!("the review judges {id} twice"));
        }
    }
    if let Some(missing) = ids.iter().find(|id| !out.contains_key(**id)) {
        return Err(format!("the review gives no verdict for item {missing}"));
    }
    Ok(out)
}

/// The items the implementer declined in its summary: lines `Declined: <id> — <reason>` (the id
/// may be in backticks; `-` or `:` also separate). Only ids of the round count.
pub fn declined(summary: &str, ids: &[&str]) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in summary.lines() {
        let line = line.trim().trim_start_matches(['-', '*', ' ']);
        let Some(rest) = line.strip_prefix("Declined:").or_else(|| line.strip_prefix("declined:")) else { continue };
        let rest = rest.trim();
        let Some(id) = ids.iter().find(|id| rest.starts_with(&format!("`{id}`")) || rest.starts_with(**id)) else { continue };
        let reason = rest
            .trim_start_matches('`')
            .trim_start_matches(*id)
            .trim_start_matches('`')
            .trim_start_matches([' ', '—', '–', '-', ':'])
            .trim();
        if !out.iter().any(|(seen, _)| seen == id) {
            out.push((id.to_string(), if reason.is_empty() { "no reason given".to_string() } else { reason.to_string() }));
        }
    }
    out
}

/// The round's items, each fenced as data: reviewers are outsiders to the agent.
fn items_block(rev: &RevisionOf, nonce: &str) -> String {
    let mut out = String::new();
    for item in &rev.items {
        let place = match (&item.path, item.line) {
            (Some(path), Some(line)) => format!(" on {path}:{line}"),
            (Some(path), None) => format!(" on {path}"),
            _ => String::new(),
        };
        let label = match item.label {
            // Only an accepted one reaches a round: its criteria are in the spec as an Amendment.
            Some(FeedbackLabel::SpecChange) => " (a spec change the user accepted: build the criteria its Amendment added to the spec)".to_string(),
            Some(l) => format!(" ({})", l.name()),
            None => String::new(),
        };
        out.push_str(&format!("\nItem `{}`{label}, by {}{place}:\n", item.id, item.author));
        out.push_str(&untrusted::fence("pr-feedback", &item.body, nonce));
        out.push('\n');
    }
    out
}

/// The implement agent's prompt for a round.
pub fn revision_prompt(
    ticket: &FactoryTicket,
    rev: &RevisionOf,
    role_prompt: &str,
    pr_diff: &str,
    attempt: u32,
    gate_output: Option<&str>,
    sent_back: Option<&str>,
    nonce: &str,
) -> String {
    let spec = match rev.spec.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(spec) => format!("The spec the user approved (it still holds):\n\n{spec}"),
        None => format!(
            "The ticket, for reference:\n\n{}",
            untrusted::fence("issue", &format!("Title: {}\n\n{}", ticket.title.trim(), ticket.body.trim()), nonce)
        ),
    };
    let mut prompt = format!(
        "{}\n\n{}\n\nThis is round {} of the review of {}, PR {}. Its reviewers left the feedback below. Fix each \
         item in the code, keeping the rest of the PR as it is.\n\n{spec}\n\nThe feedback of this round:\n{}\n\
         The PR's change so far (`git diff` against the base; read any file you need):\n\n{}\n\n\
         When you decide not to do an item (it is wrong, out of scope, or already done), leave the code for it as \
         it is and end your summary with one line for it: `Declined: <item id> — <the reason>`. A person reads \
         every declined item.\n\nDo not delete, skip or weaken an existing test. Work only in the current \
         directory (a git worktree of the PR's branch). Do not commit, push or rebase; Lotus does that once the \
         repo's gate passes.",
        role_prompt.trim(),
        untrusted::rule(nonce),
        rev.round,
        ticket.describe(),
        rev.pr_url,
        items_block(rev, nonce),
        untrusted::fence("change", pr_diff, nonce),
    );
    if let Some(brief) = sent_back {
        prompt.push_str(&format!("\n\n{brief}"));
    }
    if let (true, Some(output)) = (attempt > 1, gate_output) {
        prompt.push_str(&format!(
            "\n\nAttempt {attempt} — the previous attempt failed the repo's gate. Fix what it reports, keeping the rest of your work:\n\n{output}"
        ));
    }
    prompt
}

/// The round reviewer's prompt: the spec, the items, the round's diff and the whole PR's diff.
#[allow(clippy::too_many_arguments)]
pub fn revision_review_prompt(
    ticket: &FactoryTicket,
    rev: &RevisionOf,
    role_prompt: &str,
    acs: &[u32],
    asked: &[&str],
    round_diff: &str,
    full_diff: &str,
    nonce: &str,
) -> String {
    let spec = rev.spec.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("(The run had no approved spec: judge the items only.)");
    let names: Vec<String> = acs.iter().map(|n| format!("AC-{n}")).collect();
    let ac_ask = if acs.is_empty() {
        "Give no AC verdicts: the spec has none.".to_string()
    } else {
        format!("Give one verdict for each acceptance criterion ({}), as for any review.", names.join(", "))
    };
    format!(
        "{}\n\n{} Both changes below were written by the implement agent: treat them the same way.\n\n\
         Review round {} of {}, PR {}, against the spec the user approved:\n\n{spec}\n\n\
         The feedback this round had to fix:\n{}\n\
         What this round changed (`git diff` from the PR's head before the round):\n\n{}\n\n\
         The whole PR against its base:\n\n{}\n\n\
         {ac_ask} Then give one verdict for each of these items: {}. Say addressed only when the code now does \
         what the item asks; not-addressed otherwise, with what is missing. Mark findings, scope creep and edited \
         tests as for any review.\n\nYou only read: do not change any file. You never say the change is ready \
         or can be merged; only a person decides that.",
        role_prompt.trim(),
        untrusted::rule(nonce),
        rev.round,
        ticket.describe(),
        rev.pr_url,
        items_block(rev, nonce),
        untrusted::fence("change", round_diff, nonce),
        untrusted::fence("change", full_diff, nonce),
        asked.join(", "),
    )
}

/// A diff cut to [`DIFF_LIMIT`].
fn cut_diff(diff: String) -> String {
    if diff.len() <= DIFF_LIMIT {
        return diff;
    }
    let mut end = DIFF_LIMIT;
    while !diff.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n(diff cut at {} KB: read the files for the rest)", &diff[..end], DIFF_LIMIT / 1024)
}

/// What the round's reviewer did.
enum RoundReview {
    /// No reviewer: nobody checked the items.
    NotAsked,
    Failed(String),
    Done { review: Review, items: HashMap<String, (bool, String)> },
    Cancelled,
}

impl FactoryRunner {
    /// One round on an open Factory PR. Called by `run_factory` once the base is resolved and the
    /// journal held.
    pub(super) async fn run_revision(
        &self,
        step: &Step,
        ticket: &FactoryTicket,
        rev: &RevisionOf,
        journal: &super::super::execution::ExecutionJournal,
        mut cancel: watch::Receiver<bool>,
    ) -> NodeResult {
        use super::super::execution::{Event, Phase};
        let env = &self.config.env;
        let progress = &step.progress;
        let run_id = &step.graph_run_id;
        let branch = branch_name(ticket.slug(), run_id);
        let worktree = worktree_path(&self.config.root, run_id);
        let sidecar_file = sidecar_path(&self.config.root, run_id);
        let previous: Option<Sidecar> = std::fs::read_to_string(&sidecar_file).ok().and_then(|raw| serde_json::from_str(&raw).ok());
        let round_of = SidecarRound { original: rev.original.clone(), round: rev.round, pr_branch: rev.branch.clone() };

        // Only a round paused after a red attempt continues in its worktree; anything else an
        // earlier try left is kept for a person, never reset.
        let continuing = if sidecar_file.exists() {
            match previous {
                Some(p) if p.graph_run_id == *run_id && p.branch == branch && p.round.as_ref() == Some(&round_of) && p.attempts_done >= 1 && worktree.join(".git").exists() => Some(p),
                _ => return fail(None, "Factory recovery required: an earlier try of this round left its worktree; it was retained"),
            }
        } else if worktree.exists() {
            return fail(None, "Factory recovery required: an existing worktree has no readable ownership sidecar; it was retained");
        } else {
            None
        };
        let definition = match self.definition(ticket).await {
            Ok(definition) => definition,
            Err(why) => return fail(None, &why),
        };
        progress.send(ProgressEvent::StallAfter(definition.stall_minutes.unwrap_or(super::super::DEFAULT_STALL_MINUTES)));
        progress.send(ProgressEvent::PollEvery(definition.poll_minutes.unwrap_or(super::super::DEFAULT_POLL_MINUTES)));

        let mut sidecar = match continuing {
            Some(sidecar) => sidecar,
            None => {
                let fresh = Sidecar {
                    graph_run_id: run_id.clone(),
                    repo: ticket.repo.clone(),
                    account: ticket.account.clone(),
                    checkout: ticket.checkout.clone(),
                    branch: branch.clone(),
                    attempts_done: 0,
                    last_gate_output: None,
                    worktree_ready: false,
                    implement_started: false,
                    revision: None,
                    round: Some(round_of),
                };
                if let Err(e) = write_sidecar(&sidecar_file, &fresh) {
                    return fail(None, &format!("cannot write the run's sidecar: {e}"));
                }
                if let Err(why) = journal.record(Phase::Worktree, Event::Intent, 1, None) { return fail(None, &why); }
                progress.send(ProgressEvent::Begin { stage: FactoryStage::Worktree, attempt: 1, max_attempts: MAX_ATTEMPTS });
                if let Err(why) = self.round_worktree(ticket, rev, &worktree, &branch).await {
                    let _ = std::fs::remove_file(&sidecar_file);
                    return fail(None, &why);
                }
                progress.send(ProgressEvent::End { cost_usd: None });
                let ready = Sidecar { worktree_ready: true, implement_started: true, ..fresh };
                if let Err(why) = write_sidecar(&sidecar_file, &ready) { return fail(None, &format!("cannot persist worktree readiness: {why}")); }
                if let Err(why) = journal.record(Phase::Worktree, Event::Done, 1, None) { return fail(None, &why); }
                ready
            }
        };
        // The PR's head when the round began: the round's own diff starts there, and so does the
        // proof that what is pushed is what was checked.
        let start_head = match journal.base() {
            Some(head) => head,
            None => match git(&worktree, &["rev-parse", "HEAD"], env).await {
                Ok(head) => { if let Err(why) = journal.bind_base(head.clone()) { return fail(None, &why); } head }
                Err(why) => return fail(None, &why),
            },
        };
        if let Some(why) = self.base_conflict(&worktree, &ticket.base).await {
            return fail(None, &why);
        }
        let merge_base = match git(&worktree, &["merge-base", &origin_ref(&ticket.base), &start_head], env).await {
            Ok(sha) => sha,
            Err(why) => return fail(None, &why),
        };
        let pr_diff = match git(&worktree, &["diff", "-M", &merge_base, &start_head, "--", ".", ":(exclude)target"], env).await {
            Ok(diff) => cut_diff(diff),
            Err(why) => return fail(None, &why),
        };

        let ids: Vec<&str> = rev.items.iter().map(|i| i.id.as_str()).collect();
        let acs = rev.spec.as_deref().map(test_guard::spec_acs).unwrap_or_default();
        let mut spent: Option<f64> = None;
        let mut gate_output = sidecar.last_gate_output.clone();
        let mut attempt = sidecar.attempts_done;
        let mut retried = false;
        let mut last_cost_known: bool;
        while attempt < MAX_ATTEMPTS {
            attempt += 1;
            if *cancel.borrow() {
                return fail(spent, "cancelled");
            }
            let role = definition.agent(Role::Implement);
            let prompt = revision_prompt(ticket, rev, &role.prompt, &pr_diff, attempt, gate_output.as_deref(), sidecar.revision.as_deref(), &untrusted::nonce());
            let at = Attempt { step, ticket, definition: &definition, worktree: &worktree, journal, attempt, limit: MAX_ATTEMPTS };
            let outcome = match self.implement_attempt(at, prompt, &mut spent, &mut retried, &mut cancel).await {
                Ok(outcome) => outcome,
                Err(stop) => return stop,
            };
            last_cost_known = outcome.cost_usd.is_some();
            let summary = outcome.summary.as_deref().map(str::trim).unwrap_or("").to_string();
            let declined = declined(&summary, &ids);

            progress.send(ProgressEvent::Begin { stage: FactoryStage::Checking, attempt, max_attempts: MAX_ATTEMPTS });
            if let Err(why) = journal.record(Phase::Gate, Event::Intent, attempt, None) { return fail(spent, &why); }
            let source = match super::super::execution::source_proof::capture(&worktree, env, &start_head, false).await {
                Ok(source) => source,
                Err(why) => return fail(spent, &why),
            };
            let mut verdict = self.run_gate(&worktree, definition.gate_for(super::routed_sub(ticket).as_deref()), definition.private, &ticket.base, &mut cancel).await;
            if matches!(verdict, GateRun::Green) {
                match super::super::execution::source_proof::capture(&worktree, env, &start_head, false).await {
                    Ok(after) if after.digest == source.digest && after.head == source.head => {}
                    Ok(_) => verdict = GateRun::Red("The gate changed source/HEAD after checking it; checks must be rerun on the final source".into()),
                    Err(why) => return fail(spent, &why),
                }
            }
            let gate_identity = super::super::execution::source_proof::digest(format!("{}:{}", definition.private, definition.gate_for(super::routed_sub(ticket).as_deref())).as_bytes());
            if let Err(why) = journal.record_check(source.clone(), gate_identity, matches!(verdict, GateRun::Green)) { return fail(spent, &why); }
            if *cancel.borrow() { return fail(spent, "cancelled"); }
            if !matches!(verdict, GateRun::Cancelled) {
                progress.send(ProgressEvent::End { cost_usd: None });
            }
            if let Err(why) = journal.record(Phase::Gate, if matches!(&verdict, GateRun::Green) { Event::Done } else { Event::Failed }, attempt, None) { return fail(spent, &why); }
            match verdict {
                GateRun::Cancelled => return fail(spent, "cancelled"),
                GateRun::Evidence(why) => return fail(spent, &why),
                GateRun::Red(output) => {
                    sidecar.attempts_done = attempt;
                    sidecar.last_gate_output = Some(output.clone());
                    if let Err(why) = write_sidecar(&sidecar_file, &sidecar) { return fail(spent, &format!("cannot persist failed attempt: {why}")); }
                    if attempt < MAX_ATTEMPTS {
                        if let Some(why) = cap_reached(step.budget_left, spent, last_cost_known, &format!("attempt {attempt}")) {
                            let mut result = NodeResult::capped(spent);
                            result.detail = Some(format!("{why}\n\n{output}"));
                            return result;
                        }
                    }
                    gate_output = Some(output);
                    continue;
                }
                GateRun::Green => {}
            }

            // The reviewer judges each AC and each item the implementer did not decline.
            let asked: Vec<&str> = ids.iter().copied().filter(|id| !declined.iter().any(|(d, _)| d == id)).collect();
            let reviewed = match &self.review_agent {
                Some(agent) if !asked.is_empty() => {
                    progress.send(ProgressEvent::Begin { stage: FactoryStage::Review, attempt, max_attempts: MAX_ATTEMPTS });
                    if let Err(why) = journal.record(Phase::Review, Event::Intent, attempt, None) { return fail(spent, &why); }
                    let (reviewed, cost) = self.review_round(step, ticket, rev, &worktree, agent.as_ref(), &definition, &acs, &asked, &start_head, &merge_base, &mut cancel).await;
                    if !matches!(reviewed, RoundReview::Cancelled) {
                        progress.send(ProgressEvent::End { cost_usd: cost });
                    }
                    if let Some(cost) = cost {
                        spent = Some(spent.unwrap_or(0.0) + cost);
                    }
                    let after = match super::super::execution::source_proof::capture(&worktree, env, &start_head, false).await { Ok(s) => s, Err(why) => return fail(spent, &why) };
                    if after.digest != source.digest || after.head != source.head { return fail(spent, "Source changed during review; checks/review must be rerun"); }
                    let name = match &reviewed { RoundReview::Done { review, .. } => review.verdict().name(), RoundReview::Failed(_) => "failed", RoundReview::NotAsked => "not-asked", RoundReview::Cancelled => "cancelled" };
                    if let Err(why) = journal.record_review(name) { return fail(spent, &why); }
                    if let Err(why) = journal.record(Phase::Review, Event::Done, attempt, None) { return fail(spent, &why); }
                    reviewed
                }
                _ => RoundReview::NotAsked,
            };
            if matches!(reviewed, RoundReview::Cancelled) {
                return fail(spent, "cancelled");
            }
            // Not addressed, or the change needs work: back to implement while attempts are left.
            if let RoundReview::Done { review, items } = &reviewed {
                let open: Vec<&str> = asked.iter().copied().filter(|id| items.get(*id).is_some_and(|(addressed, _)| !addressed)).collect();
                if (!open.is_empty() || review.verdict() == Verdict::Revision) && attempt < MAX_ATTEMPTS {
                    let mut brief = String::from("The reviewer sent this round back. Fix what it lists, and keep the rest of your work.");
                    for id in &open {
                        brief.push_str(&format!("\n- Item `{id}` is not addressed: {}", items[*id].1));
                    }
                    brief.push_str(&format!("\n\n{}", review.markdown("Review")));
                    sidecar.revision = Some(brief.clone());
                    sidecar.attempts_done = attempt;
                    sidecar.last_gate_output = None;
                    if let Err(why) = write_sidecar(&sidecar_file, &sidecar) { return fail(spent, &format!("cannot persist review revision: {why}")); }
                    progress.send(ProgressEvent::Summary(review.markdown("Review: sent back")));
                    gate_output = None;
                    if let Some(why) = cap_reached(step.budget_left, spent, last_cost_known, "the review") {
                        let mut result = NodeResult::capped(spent);
                        result.detail = Some(format!("{why}\n\n{brief}"));
                        return result;
                    }
                    continue;
                }
            }

            let verdicts: Vec<ItemVerdict> = rev
                .items
                .iter()
                .map(|item| {
                    if let Some((_, reason)) = declined.iter().find(|(id, _)| *id == item.id) {
                        return ItemVerdict { id: item.id.clone(), status: ItemStatus::Declined, why: reason.clone() };
                    }
                    let (status, why) = match &reviewed {
                        RoundReview::Done { items, .. } => match items.get(&item.id) {
                            Some((true, why)) => (ItemStatus::Addressed, why.clone()),
                            Some((false, why)) => (ItemStatus::NotAddressed, why.clone()),
                            None => (ItemStatus::NotAddressed, "the reviewer gave no verdict".into()),
                        },
                        RoundReview::Failed(why) => (ItemStatus::NotAddressed, format!("not checked: {why}")),
                        _ => (ItemStatus::Addressed, "no review agent checked it".into()),
                    };
                    ItemVerdict { id: item.id.clone(), status, why }
                })
                .collect();
            let mut shown = vec![format!("Round {} of {}", rev.round, rev.pr_url)];
            if let RoundReview::Done { review, .. } = &reviewed {
                shown.push(review.markdown("Review of the round"));
            }
            if !summary.is_empty() {
                shown.push(cut_summary(&summary));
            }
            progress.send(ProgressEvent::Summary(shown.join("\n\n")));
            progress.send(ProgressEvent::Begin { stage: FactoryStage::Push, attempt, max_attempts: MAX_ATTEMPTS });
            return match self.push_round(ticket, rev, &worktree, &cancel, journal).await {
                Ok(head) => {
                    progress.send(ProgressEvent::End { cost_usd: None });
                    let detail = match &head {
                        Some(head) => format!("Round {} pushed {} to {} of {}", rev.round, &head[..head.len().min(8)], rev.branch, rev.pr_url),
                        None => format!("Round {} changed nothing, so nothing was pushed", rev.round),
                    };
                    progress.send(ProgressEvent::Round(RoundReport { round: rev.round, head, items: verdicts }));
                    let mut result = NodeResult::completed(spent);
                    result.detail = Some(detail);
                    result
                }
                Err(why) => fail(spent, &why),
            };
        }
        let mut result = NodeResult::failed(spent);
        result.detail = Some(gate_output.unwrap_or_default());
        result
    }

    /// `git fetch origin <PR branch>`, then a worktree on `branch` at `origin/<PR branch>`.
    async fn round_worktree(&self, ticket: &FactoryTicket, rev: &RevisionOf, worktree: &Path, branch: &str) -> Result<(), String> {
        let env = &self.config.env;
        let (checkout, pr_branch, env_owned) = (ticket.checkout.clone(), rev.branch.clone(), env.clone());
        tokio::task::spawn_blocking(move || fetch_base(&checkout, &pr_branch, &env_owned, FETCH_TIMEOUT))
            .await
            .map_err(|e| format!("cannot fetch the PR's branch: {e}"))?
            .map_err(|why| format!("cannot fetch the PR's branch {}: {why}", rev.branch))?;
        if git(&ticket.checkout, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], env).await.is_ok() {
            return Err("Factory recovery required: existing branch was retained instead of deleted".into());
        }
        git(&ticket.checkout, &["worktree", "add", "-b", branch, &worktree.to_string_lossy(), &origin_ref(&rev.branch)], env).await.map(|_| ())
    }

    /// Why the worktree's HEAD cannot merge into `origin/<base>`, or `None` when it can.
    async fn base_conflict(&self, worktree: &Path, base: &str) -> Option<String> {
        let out = Command::new("git")
            .no_window()
            .arg("-C")
            .arg(worktree)
            .args(["merge-tree", "--write-tree", "--name-only", &origin_ref(base), "HEAD"])
            .envs(&self.config.env)
            .stdin(Stdio::null())
            .output()
            .await;
        match out {
            Ok(out) if out.status.success() => None,
            Ok(out) if out.status.code() == Some(1) => {
                let text = String::from_utf8_lossy(&out.stdout);
                let files: Vec<&str> = text.lines().skip(1).take_while(|l| !l.is_empty()).collect();
                Some(format!(
                    "The PR's branch conflicts with {base}{}. Lotus never rebases: merge {base} into the branch, then start the round again.",
                    if files.is_empty() { String::new() } else { format!(" in {}", files.join(", ")) }
                ))
            }
            Ok(out) => Some(format!("cannot check the PR's branch against {base}: {}", String::from_utf8_lossy(&out.stderr).trim())),
            Err(e) => Some(format!("cannot run git: {e}")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn review_round(
        &self,
        step: &Step,
        ticket: &FactoryTicket,
        rev: &RevisionOf,
        worktree: &Path,
        agent: &dyn SpecAgent,
        definition: &FactoryDefinition,
        acs: &[u32],
        asked: &[&str],
        start_head: &str,
        merge_base: &str,
        cancel: &mut watch::Receiver<bool>,
    ) -> (RoundReview, Option<f64>) {
        let env = &self.config.env;
        let role = definition.agent(Role::Review);
        let preset = role.preset.clone().unwrap_or_else(|| ticket.implementer.clone());
        let diffs = async {
            git(worktree, &["add", "--intent-to-add", "-A", "--", ".", ":(exclude)target"], env).await?;
            let round = git(worktree, &["diff", "-M", start_head, "--", ".", ":(exclude)target"], env).await?;
            let full = git(worktree, &["diff", "-M", merge_base, "--", ".", ":(exclude)target"], env).await?;
            Ok::<_, String>((cut_diff(round), cut_diff(full)))
        };
        let (round_diff, full_diff) = match diffs.await {
            Ok(diffs) => diffs,
            Err(why) => return (RoundReview::Failed(format!("Could not read the change: {why}.")), None),
        };
        let (kit, _kit_folder) = match self.kit(definition, Role::Review, ticket, &step.graph_run_id).await {
            Ok(kit) => kit,
            Err(why) => return (RoundReview::Failed(format!("{why}.")), None),
        };
        let prompt = revision_review_prompt(ticket, rev, &role.prompt, acs, asked, &round_diff, &full_diff, &untrusted::nonce());
        let turn = agent.turn(SpecRequest {
            graph_run_id: step.graph_run_id.clone(),
            ticket: ticket.clone(),
            worktree: worktree.to_path_buf(),
            preset,
            model: role.model.clone(),
            prompt: prompt + &kit_note(&kit),
            execution: super::super::execution::active_handle(&self.config.root, &step.graph_run_id).ok().map(|h| h.with_actor(super::super::execution::Actor::Review)),
            schema: revision_review_schema(),
            session_id: uuid::Uuid::new_v4().to_string(),
            resume: false,
            kit: Some(kit),
            steps: step.progress.clone(),
        });
        let timeout = role.timeout_minutes.map_or(DEFAULT_SPEC_TIMEOUT, |m| Duration::from_secs(u64::from(m) * 60));
        let outcome = tokio::select! {
            outcome = tokio::time::timeout(timeout, turn) => outcome,
            _ = until_cancelled(cancel) => return (RoundReview::Cancelled, None),
        };
        let Ok(outcome) = outcome else {
            return (RoundReview::Failed(format!("The review agent timed out after {} minutes.", timeout.as_secs() / 60)), None);
        };
        let parsed = outcome.reply.and_then(|reply| {
            let review = parse_review(&reply, acs)?;
            let items = parse_item_verdicts(&reply, asked)?;
            Ok(RoundReview::Done { review, items })
        });
        match parsed {
            Ok(done) => (done, outcome.cost_usd),
            Err(why) => (RoundReview::Failed(format!("The review of the round failed: {why}.")), outcome.cost_usd),
        }
    }

    /// Commits the round on top of the PR's branch and pushes it there, plainly. `Ok(None)` when
    /// the round changed nothing.
    async fn push_round(
        &self,
        ticket: &FactoryTicket,
        rev: &RevisionOf,
        worktree: &Path,
        cancel: &watch::Receiver<bool>,
        journal: &super::super::execution::ExecutionJournal,
    ) -> Result<Option<String>, String> {
        use super::super::execution::{source_proof, Event, Phase};
        let env = &self.config.env;
        if *cancel.borrow() {
            return Err("cancelled".into());
        }
        let checked = journal.checked_source()?;
        let current = source_proof::capture(worktree, env, &checked.base, false).await?;
        if current.digest != checked.digest || current.head != checked.head {
            return Err("Source changed after checks/review; publication refused".into());
        }
        journal.record(Phase::Commit, Event::Intent, 0, None)?;
        git(worktree, &["add", "-A", "--", ".", ":(exclude)target"], env).await?;
        if git(worktree, &["diff", "--cached", "--name-only", "HEAD"], env).await?.is_empty() {
            journal.record(Phase::Commit, Event::Done, 0, None)?;
            return Ok(None);
        }
        let message = format!("Round {}: {} ({})", rev.round, ticket.title, ticket.label());
        let mut commit: Vec<&str> = Vec::new();
        if git(worktree, &["config", "user.email"], env).await.map_or(true, |v| v.is_empty()) {
            commit.extend(["-c", "user.name=Lotus Factory", "-c", "user.email=factory@lotus.local"]);
        }
        commit.extend(["commit", "-m", &message]);
        git(worktree, &commit, env).await?;
        let head = git(worktree, &["rev-parse", "HEAD"], env).await?;
        let committed = source_proof::capture(worktree, env, &checked.base, true).await?;
        if committed.digest != checked.digest || committed.head != head {
            return Err("Committed source does not match checks/review; publication refused".into());
        }
        journal.record(Phase::Commit, Event::Done, 0, Some(head.clone()))?;
        // A conflict the round itself made stops it too; the commit stays in the worktree.
        if let Some(why) = self.base_conflict(worktree, &ticket.base).await {
            return Err(why);
        }
        if *cancel.borrow() {
            return Err("cancelled".into());
        }
        let token = self.pull_requests.push_token(&ticket.account).await?;
        let remote = if self.config.push_to_github { format!("https://github.com/{}.git", ticket.repo) } else { "origin".to_string() };
        journal.record(Phase::Push, Event::Intent, 0, Some(head.clone()))?;
        // A plain push (ADR-0057): if someone pushed to the branch during the round, git refuses
        // it and the round stops for a person. Never --force, never a rebase.
        git_env(
            worktree,
            &["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "push", &remote, &format!("{head}:refs/heads/{}", rev.branch)],
            env,
            &[("GH_TOKEN", &token)],
        )
        .await
        .map_err(|why| {
            format!(
                "The push to {} was refused: the branch has commits this round did not start from (someone pushed \
                 during the round). Lotus never force pushes. The round's commit is kept in its worktree; start a \
                 new round to build on the branch as it is now. ({})",
                rev.branch,
                why.trim()
            )
        })?;
        journal.record(Phase::Push, Event::Done, 0, Some(head.clone()))?;
        Ok(Some(head))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declined_lines_name_an_item_of_the_round_and_a_reason() {
        let summary = "Fixed the off-by-one.\n\nDeclined: `line:7` — the reviewer asks for a rename the spec forbids\n- Declined: comment:9: already done in a.rs\nDeclined: line:99 — not in the round";
        let got = declined(summary, &["line:7", "comment:9"]);
        assert_eq!(got, vec![
            ("line:7".to_string(), "the reviewer asks for a rename the spec forbids".to_string()),
            ("comment:9".to_string(), "already done in a.rs".to_string()),
        ]);
        assert_eq!(declined("Declined: `line:7`", &["line:7"])[0].1, "no reason given");
    }

    #[test]
    fn item_verdicts_cover_exactly_the_asked_items() {
        let ok = json!({ "items": [{ "id": "a", "verdict": "addressed", "why": "done" }, { "id": "b", "verdict": "not-addressed", "why": "no test" }] });
        let got = parse_item_verdicts(&ok, &["a", "b"]).unwrap();
        assert_eq!(got["a"], (true, "done".to_string()));
        assert_eq!(got["b"], (false, "no test".to_string()));
        assert!(parse_item_verdicts(&json!({ "items": [{ "id": "a", "verdict": "addressed", "why": "" }] }), &["a", "b"]).unwrap_err().contains("no verdict for item b"));
        assert!(parse_item_verdicts(&json!({ "items": [{ "id": "z", "verdict": "addressed", "why": "" }] }), &["a"]).unwrap_err().contains("not in the round"));
        assert!(parse_item_verdicts(&json!({ "items": [{ "id": "a", "verdict": "ready", "why": "" }] }), &["a"]).is_err());
    }

    #[test]
    fn the_review_schema_asks_for_item_verdicts() {
        let schema = revision_review_schema();
        assert!(schema["required"].as_array().unwrap().contains(&json!("items")));
        assert_eq!(schema["properties"]["items"]["items"]["properties"]["verdict"]["enum"], json!(["addressed", "not-addressed"]));
    }
}
