//! What the runtime must know about one thread to drive it: is its provider session alive, which
//! turn is running, which approvals are waiting. Pure — fed with each stored event.
//!
//! The frontend has the full projection (`src/modules/chat/domain/thread-state.ts`); this is only
//! the part the runtime acts on: to pick start vs resume, to accept only real approval answers,
//! and to close a turn the bridge can no longer finish.

use std::collections::HashSet;

use serde_json::{json, Value};

use super::store::event_type;

#[derive(Debug, Default, Clone, PartialEq)]
pub struct RunState {
    pub session_live: bool,
    /// Running turn id, the seq of its `turn/started`, and when it started (ms).
    pub active_turn: Option<(String, u64, i64)>,
    pub pending_interactions: HashSet<String>,
    /// When the thread's last event landed (ms): how long an open session has sat unused.
    pub last_event_at: i64,
    /// Background tasks the session still runs (`session/background`): Claude ends a turn while
    /// they run and starts one by itself when one settles, so the thread is not done yet.
    pub background: u64,
    /// Out of quota (`session/rateLimit` rejected) until this time (ms); cleared by a turn that completes.
    pub limited_until: Option<i64>,
}

impl RunState {
    pub fn observe(&mut self, seq: u64, at: i64, event: &Value) {
        let str_at = |pointer: &str| {
            event
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        self.last_event_at = at;
        match event_type(event) {
            "session/configured" => {
                // A new CLI process: the level restarts empty until it reports again.
                self.session_live = true;
                self.background = 0;
            }
            "session/ended" => {
                self.session_live = false;
                self.pending_interactions.clear();
                self.background = 0;
            }
            "session/background" => self.background = event["running"].as_u64().unwrap_or(0),
            "turn/started" => self.active_turn = str_at("/turnId").map(|id| (id, seq, at)),
            "session/rateLimit" => {
                self.limited_until = (event["status"] == "rejected").then(|| event["resetsAtMs"].as_i64()).flatten().filter(|t| *t > 0);
            }
            "turn/completed" => {
                if event["status"] == "completed" {
                    self.limited_until = None;
                }
                if self.active_turn.as_ref().map(|(id, ..)| id) == str_at("/turnId").as_ref() {
                    self.active_turn = None;
                }
            }
            "interaction/requested" => {
                if let Some(id) = str_at("/interaction/id") {
                    self.pending_interactions.insert(id);
                }
            }
            "interaction/resolved" => {
                if let Some(id) = str_at("/interactionId") {
                    self.pending_interactions.remove(&id);
                }
            }
            _ => {}
        }
    }

    /// A live session nobody is using: no turn running, no approval waiting, no event since `cutoff`.
    /// A message is going to the live session. It counts as use: until Claude's first event (seconds
    /// on a cold start) nothing else would tell the reaper the session is not idle.
    pub fn sending(&mut self, at: i64) {
        self.session_live = true;
        self.last_event_at = at;
    }

    pub fn idle_since(&self, cutoff: i64) -> bool {
        self.session_live
            && self.active_turn.is_none()
            && self.pending_interactions.is_empty()
            && self.background == 0
            && self.last_event_at <= cutoff
    }

    /// Events that close what the bridge left open when it died: the running turn fails and the
    /// session ends. Without them the thread would show "running" forever.
    pub fn crash_events(&self, error: &str) -> Vec<Value> {
        let mut events = Vec::new();
        if let Some((turn_id, ..)) = &self.active_turn {
            events.push(json!({
                "type": "turn/completed", "turnId": turn_id, "status": "failed",
                "error": error, "usage": null,
            }));
        }
        if self.session_live || self.active_turn.is_some() {
            events.push(json!({ "type": "session/ended", "error": error }));
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(events: &[Value]) -> RunState {
        let mut state = RunState::default();
        for (i, event) in events.iter().enumerate() {
            state.observe(i as u64 + 1, 100 + i as i64, event);
        }
        state
    }

    #[test]
    fn tracks_the_running_turn_and_waiting_approvals() {
        let state = run(&[
            json!({"type": "session/configured"}),
            json!({"type": "turn/started", "turnId": "t1"}),
            json!({"type": "interaction/requested", "interaction": {"id": "i1"}}),
            json!({"type": "interaction/requested", "interaction": {"id": "i2"}}),
            json!({"type": "interaction/resolved", "interactionId": "i1"}),
        ]);
        assert!(state.session_live);
        assert_eq!(state.active_turn, Some(("t1".into(), 2, 101)));
        assert_eq!(
            state.pending_interactions,
            HashSet::from(["i2".to_string()])
        );
    }

    #[test]
    fn a_crash_fails_the_running_turn_then_ends_the_session() {
        let mut state = run(&[
            json!({"type": "session/configured"}),
            json!({"type": "turn/started", "turnId": "t1"}),
        ]);
        let events = state.crash_events("bridge exited");
        assert_eq!(
            events
                .iter()
                .map(|e| event_type(e).to_string())
                .collect::<Vec<_>>(),
            vec!["turn/completed", "session/ended"]
        );
        assert_eq!(events[0]["status"], "failed");
        for (i, event) in events.iter().enumerate() {
            state.observe(10 + i as u64, 0, event);
        }
        assert_eq!(state, RunState::default());
    }

    #[test]
    fn a_session_is_idle_only_when_nothing_runs_or_waits_since_the_cutoff() {
        // Events land at 100, 101, ...
        let open = run(&[json!({"type": "session/configured"})]);
        assert!(open.idle_since(100));
        assert!(!open.idle_since(99), "used after the cutoff");

        let working = run(&[json!({"type": "session/configured"}), json!({"type": "turn/started", "turnId": "t1"})]);
        assert!(!working.idle_since(i64::MAX));

        let waiting = run(&[
            json!({"type": "session/configured"}),
            json!({"type": "interaction/requested", "interaction": {"id": "i1"}}),
        ]);
        assert!(!waiting.idle_since(i64::MAX));

        let ended = run(&[json!({"type": "session/configured"}), json!({"type": "session/ended", "error": null})]);
        assert!(!ended.idle_since(i64::MAX), "nothing left to stop");
    }

    #[test]
    fn a_rejected_rate_limit_holds_until_a_turn_completes() {
        let limited = json!({"type": "session/rateLimit", "status": "rejected", "rateLimitType": "five_hour", "resetsAtMs": 5000});
        let failed = json!({"type": "turn/completed", "turnId": "t1", "status": "failed"});
        assert_eq!(run(&[limited.clone(), failed.clone()]).limited_until, Some(5000));
        let warning = json!({"type": "session/rateLimit", "status": "allowed_warning", "resetsAtMs": 9000});
        assert_eq!(run(&[limited.clone(), warning]).limited_until, None);
        let done = json!({"type": "turn/completed", "turnId": "t2", "status": "completed"});
        assert_eq!(run(&[limited, failed, done]).limited_until, None);
    }

    #[test]
    fn background_work_keeps_a_thread_busy_until_it_settles_or_the_process_restarts() {
        // Seen live 2026-11-11: Claude ended its turn at 21 s with a Monitor still running, then
        // woke by itself at 94 s; the verifier had started on the half-done work in between.
        let ended_turn = [
            json!({"type": "session/configured"}),
            json!({"type": "turn/started", "turnId": "t1"}),
            json!({"type": "session/background", "running": 1}),
            json!({"type": "turn/completed", "turnId": "t1"}),
        ];
        let state = run(&ended_turn);
        assert_eq!((state.active_turn.is_none(), state.background), (true, 1));
        assert!(!state.idle_since(i64::MAX), "the reaper must not kill its background work");

        let mut settled = ended_turn.to_vec();
        settled.push(json!({"type": "session/background", "running": 0}));
        assert_eq!(run(&settled).background, 0);

        let mut restarted = ended_turn.to_vec();
        restarted.push(json!({"type": "session/configured"}));
        assert_eq!(run(&restarted).background, 0, "a new CLI process starts with none");
    }

    #[test]
    fn a_session_handed_a_message_is_not_idle_before_its_first_event() {
        // A new thread has no events; its session goes live on `thread/start`, seconds before
        // Claude's first event. The reaper ran on that state and stopped the first message.
        let mut fresh = RunState::default();
        fresh.sending(5_000_000);
        assert!(fresh.session_live);
        assert!(!fresh.idle_since(5_000_000 - 20 * 60 * 1000));

        // A session about to be reaped is used again: the message resets its idle time.
        let mut old = run(&[json!({"type": "session/configured"})]);
        old.sending(5_000_000);
        assert!(!old.idle_since(5_000_000 - 1));
    }

    #[test]
    fn a_crash_after_a_clean_end_adds_nothing() {
        let state = run(&[
            json!({"type": "session/configured"}),
            json!({"type": "turn/started", "turnId": "t1"}),
            json!({"type": "turn/completed", "turnId": "t1"}),
            json!({"type": "session/ended", "error": null}),
        ]);
        assert!(state.crash_events("x").is_empty());
    }
}
