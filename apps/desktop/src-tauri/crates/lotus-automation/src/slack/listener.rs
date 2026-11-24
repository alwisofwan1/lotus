use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{
    decide_reacted, decide_with, parse_event, ts_after, ts_from_ms, Decision, ReactionSettings, ReviewRequest, SlackApi,
    SlackEvent, SlackMessage, SlackTrigger,
};
use crate::engine::{Engine, RunEvent, Submitted};
use crate::github::GitHub;
use crate::model::Automation;
use super::intake::{self, IntakeInput, ReplyClassifier};
use crate::pr_review::{pr_key, precheck, submit_pr, RunNowError};
use crate::ports::{Clock, SystemClock};
use crate::store::Store;

/// How long a message's live event may still be on its way. A catch-up does
/// not count younger messages as missed by the socket.
pub const LIVE_GRACE_MS: i64 = 60_000;

/// How long a review thread is still read for replies after its last request.
const THREAD_WATCH_MS: i64 = 14 * 24 * 60 * 60 * 1000;
/// The most review threads one catch-up reads, newest first: one Web API call each.
const MAX_THREADS: usize = 25;
/// How often a request GitHub or the engine could not take is tried in all, one try per
/// catch-up: about half an hour of outage at the usual five-minute check.
const MAX_ATTEMPTS: u32 = 6;

/// Turns Slack events into PR review runs for every enabled automation whose
/// trigger is `slack`. Live events and catch-up go through the same path, and
/// both are deduplicated in the store, so a message is acted on once.
pub struct SlackListener {
    store: Arc<Store>,
    github: Arc<dyn GitHub>,
    slack: Arc<dyn SlackApi>,
    /// The Slack user id the token belongs to (`auth.test`).
    me: String,
    /// One task per started review, showing its course on its request.
    watchers: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    /// Which emoji show that course; the user's choice, read anew for each request.
    reactions: Arc<ReactionSettings>,
    /// Reads the thread replies the rules cannot (ADR-0059). `None`: the rules alone decide.
    intake: Option<Arc<dyn ReplyClassifier>>,
}

impl SlackListener {
    pub fn new(store: Arc<Store>, github: Arc<dyn GitHub>, slack: Arc<dyn SlackApi>, me: String) -> Self {
        Self { store, github, slack, me, watchers: Mutex::new(Vec::new()), reactions: Arc::default(), intake: None }
    }

    /// Shows the reactions in `reactions` instead of the defaults (👀 ⏳ ⏭️).
    pub fn with_reactions(mut self, reactions: Arc<ReactionSettings>) -> Self {
        self.reactions = reactions;
        self
    }

    /// Asks `classifier` about thread replies the rules cannot place. Without one, those replies
    /// start nothing.
    pub fn with_intake(mut self, classifier: Arc<dyn ReplyClassifier>) -> Self {
        self.intake = Some(classifier);
        self
    }

    /// Waits until every review started so far has shown how it ended. For tests: in the app the
    /// watchers run on their own.
    pub async fn settle(&self) {
        loop {
            let pending: Vec<_> = self.watchers.lock().unwrap_or_else(|p| p.into_inner()).drain(..).collect();
            if pending.is_empty() {
                return;
            }
            for handle in pending {
                let _ = handle.await;
            }
        }
    }

    /// Shows the course of `run_id` on the request message: waiting for a slot, running, and how
    /// it ended, each as the reaction the user chose (none when a state has none). Reactions only:
    /// nothing is written in the thread in the user's name.
    ///
    /// The reactions are read once, here, so a review takes off the same emoji it put on even when
    /// the user changes them meanwhile.
    fn watch(&self, mut events: tokio::sync::broadcast::Receiver<RunEvent>, run_id: String, queued: bool, channel: String, ts: String) {
        let slack = Arc::clone(&self.slack);
        let settings = Arc::clone(&self.reactions);
        let reactions = settings.get();
        let handle = tokio::spawn(async move {
            let add = |name: String| {
                let (slack, settings, channel, ts) = (Arc::clone(&slack), Arc::clone(&settings), channel.clone(), ts.clone());
                async move {
                    if name.is_empty() {
                        return false;
                    }
                    match slack.add_reaction(&channel, &ts, &name).await {
                        Ok(()) => true,
                        Err(e) => {
                            settings.note_error("add", &name, &e);
                            false
                        }
                    }
                }
            };
            let remove = |name: String| {
                let (slack, settings, channel, ts) = (Arc::clone(&slack), Arc::clone(&settings), channel.clone(), ts.clone());
                async move {
                    if let Err(e) = slack.remove_reaction(&channel, &ts, &name).await {
                        settings.note_error("take off", &name, &e);
                    }
                }
            };
            let mut waiting = queued && add(reactions.queued.clone()).await;
            let mut running = false;
            loop {
                let (started, finished) = match events.recv().await {
                    Ok(RunEvent::Started { run_id: id }) if id == run_id => (true, None),
                    Ok(RunEvent::Finished { run_id: id, status, quiet }) if id == run_id => (false, Some((status, quiet))),
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                };
                if waiting {
                    waiting = false;
                    remove(reactions.queued.clone()).await;
                }
                if started && !running {
                    running = add(reactions.running.clone()).await;
                }
                if let Some((status, quiet)) = finished {
                    if running {
                        remove(reactions.running.clone()).await;
                    }
                    add(reactions.for_finish(status, quiet).to_string()).await;
                    return;
                }
            }
        });
        let mut watchers = self.watchers.lock().unwrap_or_else(|p| p.into_inner());
        watchers.retain(|h| !h.is_finished());
        watchers.push(handle);
    }

    pub async fn handle_event(&self, engine: &Engine, event: &Value) {
        self.handle(engine, parse_event(event)).await;
    }

    /// Reads what each watched channel received since its cursor. On a
    /// channel's first catch-up nothing is reviewed: the cursor starts at
    /// `now_ms`, so turning Slack on never replays old requests.
    ///
    /// It then reads the replies in each recent review thread since that
    /// thread's own cursor: history never holds replies, and a reply is how a
    /// re-review is asked for. A thread first seen here starts at `now_ms`.
    ///
    /// Returns how many of those messages the socket never delivered. Live
    /// events move the cursor, so a message still past it [`LIVE_GRACE_MS`]
    /// after it was posted did not arrive live: typically another connection
    /// to the same Slack app took it, since Slack hands each event to one
    /// connection only.
    pub async fn catch_up(&self, engine: &Engine, now_ms: i64) -> usize {
        let missed = self.catch_up_channels(engine, now_ms).await + self.catch_up_threads(engine, now_ms).await;
        self.retry_requests(engine).await;
        missed
    }

    /// The channel half of [`Self::catch_up`]: one `conversations.history` call per watched
    /// channel, no thread replies and no retries. Cheap enough to run every minute while the
    /// socket is not delivering.
    pub async fn catch_up_channels(&self, engine: &Engine, now_ms: i64) -> usize {
        let mut missed = 0;
        let channels: BTreeSet<String> =
            self.watching().into_iter().flat_map(|(_, trigger)| trigger.channels).collect();
        for channel in channels {
            let cursor = match self.store.slack_cursor(&channel) {
                Ok(Some(cursor)) => cursor,
                Ok(None) => {
                    self.log_err(self.store.advance_slack_cursor(&channel, &ts_from_ms(now_ms)));
                    continue;
                }
                Err(e) => {
                    eprintln!("[automation] slack cursor for {channel}: {e}");
                    continue;
                }
            };
            match self.slack.history(&channel, &cursor).await {
                Ok(messages) => {
                    let settled = ts_from_ms(now_ms - LIVE_GRACE_MS);
                    for message in messages {
                        if !ts_after(&message.ts, &settled) {
                            missed += 1;
                        }
                        self.handle(engine, SlackEvent::Message(message)).await;
                    }
                }
                Err(e) => eprintln!("[automation] slack catch-up of {channel}: {e}"),
            }
        }
        missed
    }

    /// Tries again the requests that failed for a reason that passes, such as GitHub being down.
    async fn retry_requests(&self, engine: &Engine) {
        let retries = match self.store.slack_retries() {
            Ok(retries) => retries,
            Err(e) => return eprintln!("[automation] slack retries: {e}"),
        };
        let watching = self.watching();
        for (automation_id, request, attempts) in retries {
            let parsed = serde_json::from_value::<ReviewRequest>(request.clone());
            let automation = watching.iter().find(|(a, _)| a.id == automation_id).map(|(a, _)| a);
            match (parsed, automation) {
                (Ok(request), Some(automation)) => self.submit(engine, automation, request, attempts).await,
                // Switched off or unreadable: a retry hours later would surprise more than help.
                _ => self.log_err(self.store.drop_slack_retry(
                    &automation_id,
                    request["channel"].as_str().unwrap_or_default(),
                    request["message_ts"].as_str().unwrap_or_default(),
                )),
            }
        }
    }

    async fn catch_up_threads(&self, engine: &Engine, now_ms: i64) -> usize {
        let mut threads = BTreeSet::new();
        for (automation, trigger) in self.watching() {
            match self.store.recent_review_threads(&automation.id, now_ms - THREAD_WATCH_MS, MAX_THREADS) {
                Ok(list) => threads.extend(list.into_iter().filter(|(channel, _)| trigger.channels.contains(channel))),
                Err(e) => eprintln!("[automation] slack review threads: {e}"),
            }
        }
        let settled = ts_from_ms(now_ms - LIVE_GRACE_MS);
        let mut missed = 0;
        for (channel, thread) in threads.into_iter().take(MAX_THREADS) {
            let cursor = match self.store.slack_thread_cursor(&channel, &thread) {
                Ok(Some(cursor)) => cursor,
                Ok(None) => {
                    self.log_err(self.store.advance_slack_thread_cursor(&channel, &thread, &ts_from_ms(now_ms)));
                    continue;
                }
                Err(e) => {
                    eprintln!("[automation] slack thread cursor for {channel}/{thread}: {e}");
                    continue;
                }
            };
            let replies = match self.slack.replies(&channel, &thread, &cursor).await {
                Ok(replies) => replies,
                Err(e) => {
                    eprintln!("[automation] slack catch-up of thread {channel}/{thread}: {e}");
                    continue;
                }
            };
            for reply in replies {
                // Also sent to the channel: the history pass already had it.
                if reply.subtype.as_deref() == Some("thread_broadcast") {
                    continue;
                }
                if !ts_after(&reply.ts, &settled) {
                    missed += 1;
                }
                let ts = reply.ts.clone();
                // Not through `handle`: a reply must not move the channel cursor past
                // top-level messages a later catch-up still has to read.
                self.dispatch(engine, SlackEvent::Message(reply)).await;
                self.log_err(self.store.advance_slack_thread_cursor(&channel, &thread, &ts));
            }
        }
        missed
    }

    async fn handle(&self, engine: &Engine, event: SlackEvent) {
        match &event {
            SlackEvent::Message(m) if !m.ts.is_empty() => {
                self.log_err(self.store.advance_slack_cursor(&m.channel, &m.ts));
            }
            SlackEvent::Reaction(r) if r.user == self.me && r.reaction == self.reactions.get().taken => {
                // Lotus reacts as the user, so its own 👀 comes back looking exactly like a request.
                if self.store.take_own_reaction(&r.channel, &r.ts, &r.reaction).unwrap_or(false) {
                    return;
                }
            }
            _ => {}
        }
        self.dispatch(engine, event).await;
    }

    /// Hands `event` to every Slack-triggered automation.
    async fn dispatch(&self, engine: &Engine, event: SlackEvent) {
        for (automation, trigger) in self.watching() {
            let (contextual, linked) = self.thread_event(&automation, &trigger, &event);
            match decide_with(&contextual, &trigger, &self.me, &self.reactions.get().taken) {
                Decision::Review(request) => {
                    // A reply that got its PR from the thread is read before it is acted on.
                    let reply = match (&contextual, linked) {
                        (SlackEvent::Message(m), true) => Some(m),
                        _ => None,
                    };
                    self.review(engine, &automation, request, reply).await
                }
                Decision::LookUp { channel, ts } => match self.slack.message(&channel, &ts).await {
                    Ok(Some(message)) => {
                        let (contextual, _) = self.thread_event(&automation, &trigger, &SlackEvent::Message(message));
                        let SlackEvent::Message(message) = contextual else { continue };
                        if let Decision::Review(request) = decide_reacted(&message, &trigger, &self.me) {
                            // My own 👀 is the ask: no reading of the text.
                            self.review(engine, &automation, request, None).await;
                        }
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("[automation] slack message {channel}/{ts}: {e}"),
                },
                Decision::Ignore(_) => {}
            }
        }
    }

    /// Replies belong to the already registered review room. Capturing feedback does not start
    /// an agent: the existing mention/own-eyes rules still authorize re-review.
    ///
    /// The flag says the reply had no PR link and was given the thread's, so what it is for
    /// is still to be read ([`Self::admit_reply`]). A reply with a link of its own is a request.
    fn thread_event(&self, automation: &Automation, trigger: &SlackTrigger, event: &SlackEvent) -> (SlackEvent, bool) {
        let SlackEvent::Message(m) = event else { return (event.clone(), false) };
        if !trigger.channels.contains(&m.channel) || m.subtype.as_deref().is_some_and(|s| s != "thread_broadcast") {
            return (event.clone(), false);
        }
        let Some(thread) = &m.thread_ts else { return (event.clone(), false) };
        let prs = self.store.prs_in_thread(&automation.id, &m.channel, thread).unwrap_or_default();
        if !prs.is_empty() {
            // Read live: a catch-up of this thread starts after it. Also my own reply, which
            // Lotus posts as me, or every sent review would read as missed by the socket.
            self.log_err(self.store.advance_slack_thread_cursor(&m.channel, thread, &m.ts));
        }
        if m.user.is_none() || m.user.as_deref() == Some(&self.me) {
            return (event.clone(), false);
        }
        let millis = m.ts.parse::<f64>().unwrap_or(0.0) * 1000.0;
        for pr in &prs {
            self.log_err(self.store.record_review_feedback(&automation.id, &pr_key(pr), &json!({
                "id": format!("{}:{}", m.channel, m.ts), "author": m.user,
                "text": m.text.chars().take(4000).collect::<String>(), "atMs": millis as i64,
                "channel": m.channel, "threadTs": thread,
            })).map(|_| ()));
        }
        let mut message = m.clone();
        let linked = !prs.is_empty() && crate::slack::read_message_text(&message.text).pull_requests.is_empty();
        if linked {
            for pr in prs { message.text.push_str(&format!("\n{}", pr.url())); }
        }
        (SlackEvent::Message(message), linked)
    }

    /// Whether a thread reply that mentions me asks for another review (ADR-0059): the facts
    /// around it, then the rules, then the model, and when none is sure, no. `request` has the
    /// reply's text with the thread's PR links added.
    async fn admit_reply(&self, automation: &Automation, request: &ReviewRequest, reply: &SlackMessage) -> bool {
        let at = format!("{}/{}", reply.channel, reply.ts);
        // A merged or own PR needs no reading, and no model call.
        let mut authors = Vec::new();
        let mut worth_a_run = false;
        for pr in &request.pull_requests {
            match precheck(self.github.as_ref(), automation, pr).await {
                Ok(info) => {
                    worth_a_run = true;
                    authors.push(info.author);
                }
                Err(RunNowError::NotReviewable(reason)) => eprintln!("[automation] slack reply {at}: {} is not reviewable: {reason}", pr.url()),
                // GitHub or the config failed: the run that follows reports or retries it.
                Err(_) => worth_a_run = true,
            }
        }
        if !worth_a_run {
            return false;
        }
        let mut input = IntakeInput {
            text: reply.text.clone(),
            reply_author: reply.user.clone().unwrap_or_default(),
            pr_authors: authors,
            root_requester: self.store.thread_requester(&automation.id, &reply.channel, &request.thread_ts).unwrap_or_default(),
            mentions_me: true,
            root_text: None,
            last_lotus_reply: None,
            preset_id: automation.action.config["preset_id"].as_str().unwrap_or_default().to_string(),
        };
        let intake = match (intake::by_rules(&input), &self.intake) {
            (Some(intake), _) => intake,
            (None, None) => {
                eprintln!("[automation] slack reply {at}: the rules are unsure and no model is set, leaving it");
                return false;
            }
            (None, Some(classifier)) => {
                self.add_thread_context(&mut input, &reply.channel, &request.thread_ts).await;
                let asked = tokio::time::timeout(
                    std::time::Duration::from_secs(intake::MODEL_TIMEOUT_SECS),
                    classifier.classify(input),
                )
                .await;
                match asked {
                    Ok(Ok(intake)) => intake,
                    Ok(Err(e)) => {
                        eprintln!("[automation] slack reply {at}: the intake model failed, leaving it: {e}");
                        return false;
                    }
                    Err(_) => {
                        eprintln!("[automation] slack reply {at}: the intake model timed out, leaving it");
                        return false;
                    }
                }
            }
        };
        let acts = intake.starts_review();
        eprintln!(
            "[automation] slack reply {at}: intent={:?} confidence={} source={} reason={:?} -> {}",
            intake.intent, intake.confidence, intake.source.as_str(), intake.reason, if acts { "review again" } else { "leave it" },
        );
        acts
    }

    /// The thread's first message and what I last said in it, for the model.
    async fn add_thread_context(&self, input: &mut IntakeInput, channel: &str, thread: &str) {
        let Ok(messages) = self.slack.replies(channel, thread, "0").await else { return };
        input.root_text = messages.iter().find(|m| m.ts == thread).map(|m| m.text.clone());
        input.last_lotus_reply = messages.iter().rev().find(|m| m.ts != thread && m.user.as_deref() == Some(&self.me)).map(|m| m.text.clone());
    }

    async fn review(&self, engine: &Engine, automation: &Automation, request: ReviewRequest, reply: Option<&SlackMessage>) {
        // A message is acted on once. My 👀 comes only live, never from
        // catch-up, and is how I ask again, so it is not held to that.
        if !request.by_me {
            let key = format!("{}:{}", request.channel, request.message_ts);
            match self.store.mark_seen(&automation.id, &key, SystemClock.now_ms()) {
                Ok(true) => {}
                Ok(false) => return,
                Err(e) => return eprintln!("[automation] slack seen {key}: {e}"),
            }
        }
        if let Some(reply) = reply {
            if !request.by_me && !self.admit_reply(automation, &request, reply).await {
                return;
            }
        }
        self.submit(engine, automation, request, 0).await;
    }

    /// Submits each PR of `request`, which already failed `attempts` times. A PR that failed for a
    /// reason that passes (GitHub, the store) is kept to try at the next catch-up, so a short
    /// outage does not lose a request that is already marked seen.
    async fn submit(&self, engine: &Engine, automation: &Automation, request: ReviewRequest, attempts: u32) {
        let context = json!({
            "channel": request.channel,
            "thread_ts": request.thread_ts,
            "message_ts": request.message_ts,
            "requester": request.requester,
        });
        // 👀 tells the requester the PR is in hand: a new review, or one already started from
        // another request (another engineer's thread) for the same commit.
        let mut in_hand = false;
        let mut again = Vec::new();
        // Kept whatever the run does: a skipped review retried with the Review button still
        // replies in this thread. All before any run starts, so each run sees its siblings.
        for pr in &request.pull_requests {
            self.log_err(self.store.remember_pr_thread(&automation.id, &pr_key(pr), &context, SystemClock.now_ms()));
        }
        for pr in &request.pull_requests {
            // The thread is read for replies from the request on.
            self.log_err(self.store.advance_slack_thread_cursor(&request.channel, &request.thread_ts, &request.message_ts));
            // Before submitting, so a run that starts and ends at once is still seen.
            let events = engine.subscribe();
            // Before any mark: a PR nothing can review (merged, a draft, my own) is not "taken in
            // hand". My own 👀 skips this, so the run still says why it skipped.
            let checked = if request.by_me { Ok(()) } else { precheck(self.github.as_ref(), automation, pr).await.map(|_| ()) };
            let submitted = if let Err(e) = checked { Err(e) } else if request.thread_ts != request.message_ts {
                let id = format!("{}:{}", request.channel, request.message_ts);
                let feedback = self.store.review_feedback(&automation.id, &pr_key(pr)).unwrap_or_default()
                    .into_iter().find(|f| f["id"] == id).and_then(|f| f["text"].as_str().map(str::to_string)).unwrap_or_default();
                crate::pr_review::submit_round(engine, self.github.as_ref(), automation, pr, Some(context.clone()), Some(&feedback), Some(&id)).await
            } else { submit_pr(engine, self.github.as_ref(), automation, pr, Some(context.clone())).await };
            match submitted {
                Ok(Submitted::Started { run_id }) => {
                    in_hand = true;
                    let queued = engine.is_queued(&run_id);
                    self.watch(events, run_id, queued, request.channel.clone(), request.message_ts.clone());
                }
                Ok(Submitted::Duplicate { existing_run_id }) => {
                    in_hand = true;
                    // Send replies here too, not only in the thread that started the run.
                    self.log_err(self.store.add_run_slack_thread(&existing_run_id, &context));
                }
                Err(e @ (RunNowError::GitHub(_) | RunNowError::Engine(_))) => {
                    eprintln!("[automation] slack request for {}, trying again later: {e}", pr.url());
                    again.push(pr.clone());
                }
                Err(RunNowError::NotReviewable(reason)) => {
                    eprintln!("[automation] slack request for {}: not started, {reason}", pr.url());
                }
                // Typically a repository this automation does not watch: trying again changes nothing.
                Err(e) => eprintln!("[automation] slack request for {}: {e}", pr.url()),
            }
        }
        // My own 👀 is already on the message.
        if in_hand && !request.by_me {
            let taken = self.reactions.get().taken;
            // Recorded before adding, so the echo that follows is recognised.
            self.log_err(self.store.record_own_reaction(&request.channel, &request.message_ts, &taken));
            if let Err(e) = self.slack.add_reaction(&request.channel, &request.message_ts, &taken).await {
                self.reactions.note_error("add", &taken, &e);
            }
        }
        let (channel, ts) = (&request.channel, &request.message_ts);
        let attempts = attempts + 1;
        if again.is_empty() {
            if attempts > 1 {
                self.log_err(self.store.drop_slack_retry(&automation.id, channel, ts));
            }
        } else if attempts >= MAX_ATTEMPTS {
            eprintln!("[automation] slack request {channel}/{ts}: gave up after {attempts} attempts");
            self.log_err(self.store.drop_slack_retry(&automation.id, channel, ts));
        } else {
            let rest = ReviewRequest { pull_requests: again, ..request.clone() };
            let rest = serde_json::to_value(&rest).unwrap_or(Value::Null);
            self.log_err(self.store.retry_slack_request(&automation.id, channel, ts, &rest, attempts, SystemClock.now_ms()));
        }
    }

    /// Enabled automations triggered from Slack, with their parsed trigger.
    fn watching(&self) -> Vec<(Automation, SlackTrigger)> {
        let all = match self.store.list_automations() {
            Ok(all) => all,
            Err(e) => {
                eprintln!("[automation] listing automations: {e}");
                return vec![];
            }
        };
        all.into_iter()
            .filter(|a| a.enabled && a.trigger.kind == "slack")
            .filter_map(|a| {
                let trigger = serde_json::from_value::<SlackTrigger>(a.trigger.config.clone()).ok()?;
                Some((a, trigger))
            })
            .collect()
    }

    fn log_err(&self, result: crate::error::Result<()>) {
        if let Err(e) = result {
            eprintln!("[automation] slack store: {e}");
        }
    }
}
