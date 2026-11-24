//! Request sources (ADR-0041): places a PR review can be asked for that Lotus
//! polls, such as GitHub's review requests. Slack asks by pushing events (see
//! [`crate::slack`]); a source is asked every few minutes instead.
//!
//! A PR review's trigger turns a source on under `trigger.config.sources.<key>`
//! with that source's settings, beside whatever its trigger kind needs (Slack's
//! channels, or nothing for `manual`). A new source — Notion, Linear, … — is one
//! [`RequestSource`] handed to the [`Poller`]; nothing else changes.

mod github;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{Map, Value};

pub use github::GitHubRequests;

use crate::engine::{Engine, Submitted};
use crate::github::GitHub;
use crate::model::{Automation, Spec};
use crate::pr_review::{pr_key, repo_is_watched, submit_pr, PrRef, PrReviewConfig};
use crate::registry::BoxFuture;
use crate::store::Store;

/// How often a source is asked, per automation. GitHub's search allows 30 requests a minute.
pub const DEFAULT_EVERY_MS: i64 = 5 * 60_000;

pub trait RequestSource: Send + Sync {
    /// Its key under `trigger.config.sources`, e.g. `github`.
    fn key(&self) -> &str;
    /// Refuses settings it cannot use, naming what is wrong.
    fn check(&self, settings: &Value) -> Result<(), String>;
    /// The pull requests it asks `review.account` to review now. A request
    /// missing from a later answer is gone; made again, it counts as new.
    fn requests(&self, review: &PrReviewConfig, settings: &Value) -> BoxFuture<Result<Vec<PrRef>, String>>;
}

/// Asks every source each PR review that is on watches, and starts a review
/// for each request it has not acted on yet.
pub struct Poller {
    store: Arc<Store>,
    github: Arc<dyn GitHub>,
    sources: Vec<Arc<dyn RequestSource>>,
    every_ms: i64,
    /// When each (automation, source) was last asked. In memory: after a
    /// restart every source is asked at once, and the store says what is new.
    asked: Mutex<HashMap<(String, String), i64>>,
}

impl Poller {
    pub fn new(store: Arc<Store>, github: Arc<dyn GitHub>, sources: Vec<Arc<dyn RequestSource>>) -> Self {
        Self { store, github, sources, every_ms: DEFAULT_EVERY_MS, asked: Mutex::new(HashMap::new()) }
    }

    pub fn sources(&self) -> &[Arc<dyn RequestSource>] {
        &self.sources
    }

    /// Called on the host's tick; asks only what is due. Returns how many reviews started.
    pub async fn tick(&self, engine: &Engine, now_ms: i64) -> usize {
        let automations = match self.store.list_automations() {
            Ok(all) => all,
            Err(e) => {
                eprintln!("[automation] request sources: {e}");
                return 0;
            }
        };
        let mut started = 0;
        for automation in automations.iter().filter(|a| a.enabled && a.action.kind == "pr_review") {
            for source in &self.sources {
                let Some(settings) = settings(&automation.trigger, source.key()) else { continue };
                if !self.due(&automation.id, source.key(), now_ms) {
                    continue;
                }
                started += self.ask(engine, automation, source.as_ref(), settings, now_ms).await;
            }
        }
        started
    }

    fn due(&self, automation_id: &str, key: &str, now_ms: i64) -> bool {
        let mut asked = self.asked.lock().unwrap_or_else(|p| p.into_inner());
        let last = asked.entry((automation_id.to_string(), key.to_string())).or_insert(i64::MIN);
        if *last != i64::MIN && now_ms - *last < self.every_ms {
            return false;
        }
        *last = now_ms;
        true
    }

    async fn ask(&self, engine: &Engine, automation: &Automation, source: &dyn RequestSource, settings: &Value, now_ms: i64) -> usize {
        let name = &automation.name;
        let review: PrReviewConfig = match serde_json::from_value(automation.action.config.clone()) {
            Ok(review) => review,
            Err(e) => {
                eprintln!("[automation] {name} has an unreadable review config: {e}");
                return 0;
            }
        };
        let requests = match source.requests(&review, settings).await {
            Ok(requests) => requests,
            // Nothing is forgotten on an error: the same requests are not new next time.
            Err(e) => {
                eprintln!("[automation] {} requests for {name}: {e}", source.key());
                return 0;
            }
        };
        let seen_key = |pr: &PrRef| format!("{}:{}", source.key(), pr_key(pr));
        let requests: Vec<PrRef> = requests.into_iter().filter(|pr| repo_is_watched(&review.repos, &pr.repo)).collect();
        let mut started = 0;
        for pr in &requests {
            let key = seen_key(pr);
            if self.store.has_seen(&automation.id, &key).unwrap_or(true) {
                continue;
            }
            // A PR asked about in Slack before keeps that thread, so Send can still reply there.
            let thread = self.store.pr_thread(&automation.id, &pr_key(pr)).unwrap_or(None);
            match submit_pr(engine, self.github.as_ref(), automation, pr, thread).await {
                Ok(submitted) => {
                    started += usize::from(matches!(submitted, Submitted::Started { .. }));
                    log_err(self.store.mark_seen(&automation.id, &key, now_ms).map(drop));
                }
                // Not marked: asked again on the next poll.
                Err(e) => eprintln!("[automation] {} request {}: {e}", source.key(), pr.url()),
            }
        }
        let still: Vec<String> = requests.iter().map(seen_key).collect();
        log_err(self.store.forget_seen_except(&automation.id, &format!("{}:", source.key()), &still));
        started
    }
}

/// A source's settings in `trigger`, when it is on.
pub fn settings<'a>(trigger: &'a Spec, key: &str) -> Option<&'a Value> {
    trigger.config.get("sources")?.get(key).filter(|s| s.is_object())
}

/// `trigger` with source `key` on (`Some(settings)`) or off (`None`). Everything else in it stays.
pub fn with_source(trigger: &Spec, key: &str, settings: Option<Value>) -> Result<Spec, String> {
    let mut config = match &trigger.config {
        Value::Object(map) => map.clone(),
        Value::Null => Map::new(),
        _ => return Err("trigger: its config is not an object".into()),
    };
    let mut sources = config.remove("sources").and_then(|s| s.as_object().cloned()).unwrap_or_default();
    match settings {
        Some(settings) => {
            sources.insert(key.to_string(), settings);
        }
        None => {
            sources.remove(key);
        }
    }
    if !sources.is_empty() {
        config.insert("sources".into(), Value::Object(sources));
    }
    Ok(Spec::new(trigger.kind.clone(), Value::Object(config)))
}

/// `new` (e.g. Slack moved to another channel) still watching what `old` watched.
pub fn keep_sources(mut new: Spec, old: &Spec) -> Spec {
    if let (Some(sources), Value::Object(config)) = (old.config.get("sources"), &mut new.config) {
        config.insert("sources".into(), sources.clone());
    }
    new
}

fn log_err(result: crate::error::Result<()>) {
    if let Err(e) = result {
        eprintln!("[automation] request sources store: {e}");
    }
}
