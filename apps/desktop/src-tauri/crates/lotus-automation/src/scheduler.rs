//! The `schedule` trigger: called every tick (the host uses ~30 s), it
//! submits at most one run per automation — the latest occurrence since the
//! last tick. Missed occurrences collapse into one; the first tick of a new
//! schedule only starts its clock (PLAN §2.1 Q37).

use serde_json::json;

use crate::engine::{Engine, Submitted};
use crate::schedule::Schedule;
use crate::store::Store;

/// Returns how many runs were started.
pub async fn tick(store: &Store, engine: &Engine, now_ms: i64) -> usize {
    let automations = match store.list_automations() {
        Ok(all) => all,
        Err(e) => {
            eprintln!("[automation] schedule tick: {e}");
            return 0;
        }
    };
    let mut started = 0;
    for automation in automations.into_iter().filter(|a| a.enabled && a.trigger.kind == "schedule") {
        let schedule = match serde_json::from_value::<Schedule>(automation.trigger.config.clone())
            .map_err(|e| e.to_string())
            .and_then(|s| Schedule::parse(&s.cron, &s.timezone))
        {
            Ok(schedule) => schedule,
            Err(e) => {
                eprintln!("[automation] {} has an unreadable schedule: {e}", automation.name);
                continue;
            }
        };
        let since = match store.schedule_cursor(&automation.id) {
            Ok(Some(since)) => since,
            Ok(None) => {
                if let Err(e) = store.set_schedule_cursor(&automation.id, now_ms) {
                    eprintln!("[automation] schedule cursor: {e}");
                }
                continue;
            }
            Err(e) => {
                eprintln!("[automation] schedule cursor: {e}");
                continue;
            }
        };
        if let Some(due) = schedule.latest_due(since, now_ms) {
            let key = format!("schedule@{due}");
            match engine.submit(&automation.id, &key, json!({ "scheduled_at_ms": due })).await {
                Ok(Submitted::Started { .. }) => started += 1,
                Ok(Submitted::Duplicate { .. }) => {}
                Err(e) => eprintln!("[automation] scheduled run of {}: {e}", automation.name),
            }
        }
        if let Err(e) = store.set_schedule_cursor(&automation.id, now_ms) {
            eprintln!("[automation] schedule cursor: {e}");
        }
    }
    started
}

/// "Run now" on a scheduled automation: one run at `now_ms`, whether or not
/// it is on (the user asked for it).
pub async fn run_now(engine: &Engine, automation_id: &str, now_ms: i64) -> crate::Result<Submitted> {
    engine.submit(automation_id, &format!("manual@{now_ms}"), json!({ "scheduled_at_ms": now_ms })).await
}
