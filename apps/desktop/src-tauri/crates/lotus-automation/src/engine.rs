use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::{broadcast, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;

use crate::error::{Error, Result};
use crate::model::{Automation, ClaimOutcome, NewDraft, RunStatus};
use crate::ports::{Clock, Notifier, RunReport};
use crate::registry::{ActionContext, ActionResult, Registry};
use crate::store::Store;

#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// Most runs executing at once, across all automations whose action kind has no pool.
    pub max_concurrency: usize,
    /// Action kinds with their own limit, apart from the shared one: (kind, most at once).
    pub pools: Vec<(String, usize)>,
    /// Waits before each retry of a failed run; its length is the number of
    /// retries (PLAN §2.6 Q27: two, after 30 s and 60 s).
    pub retry_delays: Vec<Duration>,
    /// Failed runs in a row after which the automation is switched off.
    pub pause_after_failures: usize,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            max_concurrency: 2,
            // Reviews come in bursts, from several people at once, and last a minute or two each.
            pools: vec![("pr_review".to_string(), 3)],
            retry_delays: vec![Duration::from_secs(30), Duration::from_secs(60)],
            pause_after_failures: 3,
        }
    }
}

/// What happens to a run as it goes, for whoever watches ([`Engine::subscribe`]).
#[derive(Debug, Clone, PartialEq)]
pub enum RunEvent {
    /// It has its slot and starts working.
    Started { run_id: String },
    /// It ended and its end is recorded. `quiet`: there was nothing to report.
    Finished { run_id: String, status: RunStatus, quiet: bool },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Submitted {
    Started { run_id: String },
    /// This unit of work already has a run; nothing was started.
    Duplicate { existing_run_id: String },
}

struct Inner {
    store: Arc<Store>,
    registry: Registry,
    clock: Arc<dyn Clock>,
    permits: Arc<Semaphore>,
    /// Action kind → its own slots ([`EngineConfig::pools`]).
    pools: HashMap<String, Arc<Semaphore>>,
    /// Runs that could not start at once: waiting for their lane or a slot.
    queued: Mutex<std::collections::HashSet<String>>,
    events: broadcast::Sender<RunEvent>,
    /// One lock per busy lane ([`crate::registry::ActionKind::lane`]); gone once nobody holds it.
    lanes: Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>,
    notifier: Option<Arc<dyn Notifier>>,
    retry_delays: Vec<Duration>,
    pause_after_failures: usize,
}

/// Turns submitted work into runs: claims each unit of work exactly once,
/// executes it through the registered action under a concurrency cap, and
/// records how it ended.
pub struct Engine {
    inner: Arc<Inner>,
    in_flight: Mutex<Vec<JoinHandle<()>>>,
}

impl Engine {
    pub fn new(store: Arc<Store>, registry: Registry, clock: Arc<dyn Clock>, config: EngineConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                registry,
                clock,
                permits: Arc::new(Semaphore::new(config.max_concurrency.max(1))),
                pools: config.pools.into_iter().map(|(kind, n)| (kind, Arc::new(Semaphore::new(n.max(1))))).collect(),
                queued: Mutex::new(Default::default()),
                events: broadcast::channel(256).0,
                lanes: Mutex::new(HashMap::new()),
                notifier: None,
                retry_delays: config.retry_delays,
                pause_after_failures: config.pause_after_failures,
            }),
            in_flight: Mutex::new(Vec::new()),
        }
    }

    /// Tells `notifier` how every run ends. Call before submitting work.
    pub fn with_notifier(mut self, notifier: Arc<dyn Notifier>) -> Self {
        Arc::get_mut(&mut self.inner)
            .expect("with_notifier must be called before the engine runs anything")
            .notifier = Some(notifier);
        self
    }

    /// Tells what happens to every run from now on. Subscribe before submitting, so a run that
    /// starts at once is not missed.
    pub fn subscribe(&self) -> broadcast::Receiver<RunEvent> {
        self.inner.events.subscribe()
    }

    /// The run waits for its lane or a slot: it was submitted but has not started.
    pub fn is_queued(&self, run_id: &str) -> bool {
        self.inner.queued.lock().unwrap_or_else(|p| p.into_inner()).contains(run_id)
    }

    /// Submits one unit of work, identified by `key`, for `automation_id`.
    /// Returns once the run is claimed; execution continues in the background.
    pub async fn submit(&self, automation_id: &str, key: &str, payload: Value) -> Result<Submitted> {
        let id = automation_id.to_string();
        let automation = blocking(&self.inner.store, move |s| s.get_automation(&id))
            .await?
            .ok_or_else(|| Error::UnknownAutomation(automation_id.to_string()))?;

        let now = self.inner.clock.now_ms();
        let (id, key) = (automation_id.to_string(), key.to_string());
        let run = match blocking(&self.inner.store, move |s| s.claim_run(&id, &key, now)).await? {
            ClaimOutcome::Claimed(run) => run,
            ClaimOutcome::Duplicate { existing_run_id } => return Ok(Submitted::Duplicate { existing_run_id }),
        };

        let run_id = run.id.clone();
        let (id, kept) = (run.id.clone(), payload.clone());
        if let Err(e) = blocking(&self.inner.store, move |s| s.set_run_payload(&id, &kept)).await {
            eprintln!("[automation] could not keep run {run_id}'s payload: {e}");
        }
        let inner = Arc::clone(&self.inner);
        // Take the lane's place in line now, so runs of one lane go in the order they came.
        let lane = inner.registry.action(&automation.action.kind).and_then(|a| a.lane(&automation, &payload));
        let lane = lane.map(|key| inner.lane(&automation.id, key));
        let pool = inner.pool(&automation.action.kind);
        // Start at once when both are free; otherwise the run is queued, and says so before
        // `submit` returns.
        // A lane got now is kept even when no slot is free, so this run stays first in it.
        let held = lane.as_ref().and_then(|lane| Arc::clone(lane).try_lock_owned().ok());
        let permit = if lane.is_some() && held.is_none() { None } else { Arc::clone(&pool).try_acquire_owned().ok() };
        if permit.is_none() {
            inner.queued.lock().unwrap_or_else(|p| p.into_inner()).insert(run.id.clone());
        }
        let handle = tokio::spawn(execute(inner, automation, run.id, payload, Start { lane, pool, held, permit }));
        let mut in_flight = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
        in_flight.retain(|h| !h.is_finished());
        in_flight.push(handle);
        Ok(Submitted::Started { run_id })
    }

    /// Runs again, once, what the last process cut off ([`Store::reconcile_for_resume`]), unless its
    /// automation is off or would open a pane — a pane opening by itself as Lotus starts waits for
    /// the user instead. Returns how many started.
    pub async fn resume(&self, runs: Vec<crate::store::Resumable>) -> usize {
        let mut started = 0;
        for run in runs {
            let id = run.automation_id.clone();
            let Ok(Some(automation)) = blocking(&self.inner.store, move |s| s.get_automation(&id)).await else { continue };
            if !automation.enabled || automation.action.config["open_pane"].as_bool() == Some(true) {
                continue;
            }
            match self.submit(&run.automation_id, &run.key, run.payload).await {
                Ok(Submitted::Started { run_id }) => {
                    started += 1;
                    if let Err(e) = blocking(&self.inner.store, move |s| s.mark_resumed(&run_id)).await {
                        eprintln!("[automation] could not mark a resumed run: {e}");
                    }
                }
                Ok(Submitted::Duplicate { .. }) => {}
                Err(e) => eprintln!("[automation] resuming {}: {e}", run.key),
            }
        }
        started
    }

    /// Waits until every run submitted so far has finished.
    pub async fn drain(&self) {
        loop {
            let pending: Vec<_> = {
                let mut in_flight = self.in_flight.lock().unwrap_or_else(|p| p.into_inner());
                in_flight.drain(..).collect()
            };
            if pending.is_empty() {
                return;
            }
            for handle in pending {
                let _ = handle.await;
            }
        }
    }
}

/// How a run gets going: its lane and slots, and what of them `submit` already got.
struct Start {
    lane: Option<Arc<tokio::sync::Mutex<()>>>,
    pool: Arc<Semaphore>,
    held: Option<OwnedMutexGuard<()>>,
    /// Set only when the lane (if any) is held too: the run starts at once.
    permit: Option<OwnedSemaphorePermit>,
}

impl Inner {
    fn pool(&self, kind: &str) -> Arc<Semaphore> {
        Arc::clone(self.pools.get(kind).unwrap_or(&self.permits))
    }

    fn lane(&self, automation_id: &str, key: String) -> Arc<tokio::sync::Mutex<()>> {
        let key = format!("{automation_id}:{key}");
        let mut lanes = self.lanes.lock().unwrap_or_else(|p| p.into_inner());
        lanes.retain(|_, lane| lane.strong_count() > 0);
        if let Some(lane) = lanes.get(&key).and_then(Weak::upgrade) {
            return lane;
        }
        let lane = Arc::new(tokio::sync::Mutex::new(()));
        lanes.insert(key, Arc::downgrade(&lane));
        lane
    }
}

async fn execute(inner: Arc<Inner>, automation: Automation, run_id: String, payload: Value, start: Start) {
    let Start { lane, pool, held, permit } = start;
    let (_lane, permit) = match permit {
        Some(permit) => (held, permit),
        None => {
            // Wait for the lane first and the slot second: a run queued behind its own PR must
            // not sit on a slot another PR could use. The lane stays held through retries, so
            // order is kept.
            let held = match (held, lane) {
                (Some(held), _) => Some(held),
                (None, Some(lane)) => Some(lane.lock_owned().await),
                (None, None) => None,
            };
            let permit = Arc::clone(&pool).acquire_owned().await.expect("engine semaphore is never closed");
            inner.queued.lock().unwrap_or_else(|p| p.into_inner()).remove(&run_id);
            (held, permit)
        }
    };
    let mut permit = Some(permit);
    let _ = inner.events.send(RunEvent::Started { run_id: run_id.clone() });

    let id = run_id.clone();
    if let Err(err) = blocking(&inner.store, move |s| s.mark_running(&id)).await {
        eprintln!("[automation] could not mark run {run_id} running: {err}");
    }

    let automation_id = automation.id.clone();
    let automation_name = automation.name.clone();
    let action_kind = automation.action.kind.clone();
    let mut draft_ref: Option<(String, String)> = None;
    let attempts = inner.retry_delays.len() + 1;
    let mut attempt = 0;
    let result = loop {
        let result = match inner.registry.action(&automation.action.kind) {
            None => ActionResult::Failed { error: format!("no action kind named {:?} is registered", automation.action.kind) },
            Some(action) => {
                let ctx = ActionContext { automation: automation.clone(), run_id: run_id.clone(), payload: payload.clone() };
                // Run the action in its own task so a panic inside it becomes a
                // failed run instead of a run stuck in `running` forever.
                match tokio::spawn(action.execute(ctx)).await {
                    Ok(result) => result,
                    Err(join) => ActionResult::Failed { error: format!("action crashed: {join}") },
                }
            }
        };
        attempt += 1;
        match result {
            // Only an unknown failure is worth another try; a missing agent or an expired login fails the same way again.
            ActionResult::Failed { error } if attempt < attempts && crate::failure::classify(&error).retryable() => {
                eprintln!("[automation] {automation_name}: attempt {attempt} failed, retrying: {}", crate::secrets::redact(&error));
                // Give the slot back while waiting: a retry must not stall other runs.
                drop(permit.take());
                tokio::time::sleep(inner.retry_delays[attempt - 1]).await;
                permit = Some(Arc::clone(&pool).acquire_owned().await.expect("engine semaphore is never closed"));
            }
            ActionResult::Failed { error } if attempt > 1 => {
                break ActionResult::Failed { error: format!("{error} (failed {attempt} attempts)") };
            }
            ActionResult::FailedFinal { error } => break ActionResult::Failed { error },
            other => break other,
        }
    };
    let _permit = permit;

    let quiet = matches!(result, ActionResult::NothingToReport { .. });
    let (status, detail) = match result {
        ActionResult::Succeeded { detail } => (RunStatus::Succeeded, detail),
        ActionResult::Drafted { subject, content, detail, delivered } => {
            let draft =
                NewDraft { run_id: run_id.clone(), automation_id: automation_id.clone(), kind: action_kind, subject, content };
            let now = inner.clock.now_ms();
            let saved = blocking(&inner.store, move |s| {
                let saved = s.save_draft(draft, now)?;
                if delivered {
                    s.mark_draft_delivered(&saved.id)?;
                }
                Ok(saved)
            })
            .await;
            match saved {
                Ok(saved) => {
                    draft_ref = Some((saved.id, saved.subject));
                    (RunStatus::Succeeded, Some(detail))
                }
                Err(err) => (RunStatus::Failed, Some(format!("could not save the draft: {err}"))),
            }
        }
        ActionResult::Asked { subject, question, choices, origin } => {
            let detail = format!("asked: {}", question.lines().next().unwrap_or_default().trim());
            let mut content = serde_json::json!({ "question": question, "choices": choices, "action_kind": action_kind });
            if !origin.is_null() {
                content["origin"] = origin;
            }
            if let Some((parent, chain)) = crate::ask::chain_fields(&payload["follow_up"]) {
                content["parent_ask_id"] = parent;
                content["chain"] = chain;
            }
            let ask = NewDraft {
                run_id: run_id.clone(),
                automation_id: automation_id.clone(),
                kind: crate::model::ASK_KIND.to_string(),
                subject,
                content,
            };
            let now = inner.clock.now_ms();
            match blocking(&inner.store, move |s| s.save_draft(ask, now)).await {
                Ok(saved) => {
                    draft_ref = Some((saved.id, saved.subject));
                    (RunStatus::Asked, Some(detail))
                }
                Err(err) => (RunStatus::Failed, Some(format!("could not save the question: {err}"))),
            }
        }
        ActionResult::Skipped { reason } | ActionResult::NothingToReport { reason } => (RunStatus::Skipped, Some(reason)),
        ActionResult::Failed { error } | ActionResult::FailedFinal { error } => (RunStatus::Failed, Some(error)),
    };
    let now = inner.clock.now_ms();
    let id = run_id.clone();
    let recorded = detail.clone();
    if let Err(err) = blocking(&inner.store, move |s| s.finish_run(&id, status, recorded.as_deref(), now)).await {
        eprintln!("[automation] could not record the end of run {run_id}: {err}");
    }
    if status == RunStatus::Failed && payload["follow_up"].is_object() {
        let (follow_up, id) = (payload["follow_up"].clone(), run_id.clone());
        if let Err(err) = blocking(&inner.store, move |s| {
            crate::ask::follow_up_failed(s, &follow_up, &id);
            Ok(())
        })
        .await
        {
            eprintln!("[automation] could not bring back the question of run {run_id}: {err}");
        }
    }
    let _ = inner.events.send(RunEvent::Finished { run_id: run_id.clone(), status, quiet });
    let paused = status == RunStatus::Failed && pause_if_failing(&inner, &automation_id).await;
    let failures_in_a_row = if paused { inner.pause_after_failures } else { 0 };
    if let Some(notifier) = &inner.notifier {
        let (draft_id, subject) = draft_ref.unzip();
        let detail = detail.map(|d| crate::secrets::redact(&d));
        notifier.run_finished(&RunReport { run_id, automation_id, automation_name, status, detail, draft_id, subject, paused, failures_in_a_row, quiet });
    }
}

/// Switches the automation off once its runs have failed
/// `pause_after_failures` times in a row. `true` when this call paused it.
async fn pause_if_failing(inner: &Arc<Inner>, automation_id: &str) -> bool {
    let (limit, id) = (inner.pause_after_failures, automation_id.to_string());
    if limit == 0 {
        return false;
    }
    let paused = blocking(&inner.store, move |s| {
        let enabled = s.get_automation(&id)?.is_some_and(|a| a.enabled);
        if enabled && s.failure_streak(&id)? >= limit {
            s.set_enabled(&id, false)?;
            return Ok(true);
        }
        Ok(false)
    })
    .await;
    paused.unwrap_or_else(|err| {
        eprintln!("[automation] could not check the failure streak of {automation_id}: {err}");
        false
    })
}

/// SQLite calls block; keep them off the async worker threads.
async fn blocking<T, F>(store: &Arc<Store>, f: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(&Store) -> Result<T> + Send + 'static,
{
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || f(&store))
        .await
        .map_err(|join| Error::Internal(format!("store task failed: {join}")))?
}
