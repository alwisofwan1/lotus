use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};
use lotus_automation::scheduler::tick;
use lotus_automation::{
    ActionContext, ActionKind, ActionResult, BoxFuture, Clock, Engine, EngineConfig, NewAutomation, Registry, Spec, Store,
};
use serde_json::{json, Value};

fn ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap().timestamp_millis()
}

/// Records each payload it runs with.
struct Recorder(Arc<Mutex<Vec<Value>>>);
impl ActionKind for Recorder {
    fn kind(&self) -> &str {
        "record"
    }
    fn execute(&self, ctx: ActionContext) -> BoxFuture<ActionResult> {
        self.0.lock().unwrap().push(ctx.payload);
        Box::pin(async { ActionResult::Succeeded { detail: None } })
    }
}

struct Fixed;
impl Clock for Fixed {
    fn now_ms(&self) -> i64 {
        0
    }
}

fn setup(trigger: Value) -> (tempfile::TempDir, Arc<Store>, Engine, Arc<Mutex<Vec<Value>>>) {
    setup_with(trigger, Recorder)
}

/// A scheduled automation run by the action `make` builds around the list of payloads it saw.
fn setup_with<A: ActionKind + 'static>(
    trigger: Value,
    make: impl FnOnce(Arc<Mutex<Vec<Value>>>) -> A,
) -> (tempfile::TempDir, Arc<Store>, Engine, Arc<Mutex<Vec<Value>>>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("automations.db")).unwrap());
    store
        .create_automation(
            NewAutomation {
                name: "Morning brief".into(),
                trigger: Spec::new("schedule", trigger),
                action: Spec::new("record", json!({})),
                outputs: vec![],
            },
            1,
        )
        .unwrap();
    let seen = Arc::new(Mutex::new(vec![]));
    let engine = Engine::new(
        Arc::clone(&store),
        Registry::new().with_action(make(Arc::clone(&seen))),
        Arc::new(Fixed),
        EngineConfig { retry_delays: vec![], ..EngineConfig::default() },
    );
    (dir, store, engine, seen)
}

const DAILY_NINE_WIB: fn() -> Value = || json!({ "cron": "0 9 * * *", "timezone": "Asia/Jakarta" });

#[tokio::test]
async fn the_first_tick_only_starts_the_clock_and_runs_nothing() {
    let (_d, _store, engine, seen) = setup(DAILY_NINE_WIB());
    assert_eq!(tick(&_store, &engine, ms(2026, 9, 28, 3, 0)).await, 0);
    engine.drain().await;
    assert!(seen.lock().unwrap().is_empty(), "turning a schedule on never runs the past");
}

#[tokio::test]
async fn several_missed_runs_while_lotus_was_off_become_exactly_one() {
    let (_d, store, engine, seen) = setup(DAILY_NINE_WIB());
    tick(&store, &engine, ms(2026, 9, 28, 1, 0)).await; // Monday 08:00 WIB: clock starts

    // Lotus comes back Thursday 10:00 WIB: Mon, Tue, Wed and Thu 09:00 were all missed.
    assert_eq!(tick(&store, &engine, ms(2026, 10, 1, 3, 0)).await, 1);
    assert_eq!(tick(&store, &engine, ms(2026, 10, 1, 3, 0)).await, 0, "a second tick owes nothing");
    engine.drain().await;

    let payloads = seen.lock().unwrap();
    assert_eq!(payloads.len(), 1);
    assert_eq!(payloads[0]["scheduled_at_ms"], json!(ms(2026, 10, 1, 2, 0)));
    let runs = store.list_runs(10).unwrap();
    assert_eq!(runs[0].run.idempotency_key, format!("schedule@{}", ms(2026, 10, 1, 2, 0)));
}

#[tokio::test]
async fn each_new_occurrence_runs_once_as_time_moves_on() {
    let (_d, store, engine, seen) = setup(DAILY_NINE_WIB());
    tick(&store, &engine, ms(2026, 9, 28, 1, 0)).await;
    for day in [28, 29, 30] {
        tick(&store, &engine, ms(2026, 9, day, 2, 1)).await; // 09:01 WIB each day
    }
    engine.drain().await;
    assert_eq!(seen.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn an_unreadable_schedule_is_skipped_without_stopping_the_others() {
    let (_d, store, engine, seen) = setup(json!({ "cron": "nonsense", "timezone": "Asia/Jakarta" }));
    tick(&store, &engine, ms(2026, 9, 28, 1, 0)).await;
    assert_eq!(tick(&store, &engine, ms(2026, 10, 1, 3, 0)).await, 0);
    engine.drain().await;
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn run_now_starts_a_scheduled_prompt_at_once_even_while_it_is_off() {
    let (_d, store, engine, seen) = setup(DAILY_NINE_WIB());
    let id = store.list_automations().unwrap()[0].id.clone();
    store.set_enabled(&id, false).unwrap();
    let started = lotus_automation::scheduler::run_now(&engine, &id, 42_000).await.unwrap();
    engine.drain().await;
    assert!(matches!(started, lotus_automation::Submitted::Started { .. }));
    assert_eq!(store.list_runs(10).unwrap()[0].run.idempotency_key, "manual@42000");
    assert_eq!(seen.lock().unwrap()[0]["scheduled_at_ms"], 42_000);
}

/// Asks on its first run, then just records.
struct AsksFirst(Arc<Mutex<Vec<Value>>>);
impl ActionKind for AsksFirst {
    fn kind(&self) -> &str {
        "record"
    }
    fn execute(&self, ctx: ActionContext) -> BoxFuture<ActionResult> {
        let mut seen = self.0.lock().unwrap();
        seen.push(ctx.payload);
        let first = seen.len() == 1;
        Box::pin(async move {
            if first {
                ActionResult::Asked { subject: "Ticket runner".into(), question: "Approve?".into(), choices: vec!["Approve".into()], origin: Value::Null }
            } else {
                ActionResult::Succeeded { detail: None }
            }
        })
    }
}

/// PLAN §8 Q6: an open Ask blocks nothing. The next scheduled run starts on time while the first
/// one's Ask still waits, and the Ask is left waiting.
#[tokio::test]
async fn the_schedule_keeps_running_while_an_ask_waits_for_the_user() {
    let (_d, store, engine, seen) = setup_with(DAILY_NINE_WIB(), AsksFirst);
    tick(&store, &engine, ms(2026, 9, 28, 1, 0)).await;
    tick(&store, &engine, ms(2026, 9, 28, 2, 1)).await;
    engine.drain().await;
    let asked = store.list_runs(10).unwrap();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].run.status, lotus_automation::RunStatus::Asked);

    tick(&store, &engine, ms(2026, 9, 29, 2, 1)).await;
    engine.drain().await;

    assert_eq!(seen.lock().unwrap().len(), 2, "the next day's run started");
    let ask = store.draft_for_run(&asked[0].run.id).unwrap().expect("the Ask");
    assert_eq!(ask.status, lotus_automation::DraftStatus::Pending, "and the Ask still waits");
}
