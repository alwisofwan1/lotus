//! Request sources (ADR-0041): places a PR review can be asked for that Lotus
//! polls — GitHub's review requests today, others (Notion, …) later.

mod common;

use std::sync::Arc;

use common::*;
use lotus_automation::github::PrSummary;
use lotus_automation::sources::{self, GitHubRequests, Poller, RequestSource};
use lotus_automation::{RunStatus, Spec};
use serde_json::json;

const MINUTE: i64 = 60_000;

fn requested(number: u64) -> PrSummary {
    PrSummary {
        repo: REPO.into(),
        number,
        title: "Add b".into(),
        author: "teammate".into(),
        url: format!("https://github.com/{REPO}/pull/{number}"),
        updated_at: "2026-09-28T01:00:00Z".into(),
    }
}

/// A world whose review automation also watches GitHub, with `team` counting as the reviewer.
fn watching_github(team: Option<&str>) -> (World, Poller) {
    let w = world(open_pr());
    let trigger = sources::with_source(&w.automation.trigger, "github", Some(json!({ "team": team }))).unwrap();
    w.store.set_trigger(&w.automation.id, &trigger).unwrap();
    let github: Arc<dyn lotus_automation::github::GitHub> = w.github.clone();
    let poller = Poller::new(Arc::clone(&w.store), Arc::clone(&github), vec![Arc::new(GitHubRequests::new(github))]);
    (w, poller)
}

async fn tick(w: &World, poller: &Poller, now_ms: i64) -> usize {
    let started = poller.tick(&w.engine, now_ms).await;
    w.engine.drain().await;
    started
}

#[tokio::test]
async fn a_review_requested_on_github_is_reviewed_without_slack() {
    let (w, poller) = watching_github(Some(TEAM));
    *w.github.review_requests.lock().unwrap() = vec![requested(42)];

    assert_eq!(tick(&w, &poller, 0).await, 1);

    let runs = w.store.list_runs(10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].run.status, RunStatus::Succeeded, "{:?}", runs[0].run.detail);
    assert_eq!(runs[0].run.idempotency_key, format!("{REPO}#42@sha1"));
    assert_eq!(*w.github.searches.lock().unwrap(), vec![(ME.to_string(), Some(TEAM.to_string()))]);
}

#[tokio::test]
async fn a_request_still_waiting_is_acted_on_once_and_github_is_asked_every_few_minutes_only() {
    let (w, poller) = watching_github(None);
    *w.github.review_requests.lock().unwrap() = vec![requested(42)];
    tick(&w, &poller, 0).await;

    // Too soon: GitHub is not asked again.
    tick(&w, &poller, MINUTE).await;
    assert_eq!(w.github.searches.lock().unwrap().len(), 1);

    // Asked again, the request is still there (even at a new commit, or after a skipped run): no second run.
    w.github.pr.lock().unwrap().head_sha = "sha2".into();
    assert_eq!(tick(&w, &poller, 6 * MINUTE).await, 0);
    assert_eq!(w.github.searches.lock().unwrap().len(), 2);
    assert_eq!(w.store.list_runs(10).unwrap().len(), 1);
}

#[tokio::test]
async fn a_request_made_again_after_it_was_gone_is_reviewed_again() {
    let (w, poller) = watching_github(None);
    *w.github.review_requests.lock().unwrap() = vec![requested(42)];
    tick(&w, &poller, 0).await;

    // Reviewed and sent: GitHub no longer lists it. Then the author pushes and re-requests.
    w.github.review_requests.lock().unwrap().clear();
    tick(&w, &poller, 6 * MINUTE).await;
    w.github.pr.lock().unwrap().head_sha = "sha2".into();
    *w.github.review_requests.lock().unwrap() = vec![requested(42)];

    assert_eq!(tick(&w, &poller, 12 * MINUTE).await, 1);
    assert_eq!(w.store.list_runs(10).unwrap()[0].run.idempotency_key, format!("{REPO}#42@sha2"));
}

#[tokio::test]
async fn only_watched_repositories_on_automations_that_are_on_and_watch_github_are_reviewed() {
    let (w, poller) = watching_github(None);
    let mut elsewhere = requested(7);
    elsewhere.repo = "someone/else".into();
    *w.github.review_requests.lock().unwrap() = vec![elsewhere];
    assert_eq!(tick(&w, &poller, 0).await, 0, "a repository the automation does not watch");

    *w.github.review_requests.lock().unwrap() = vec![requested(42)];
    w.store.set_enabled(&w.automation.id, false).unwrap();
    assert_eq!(tick(&w, &poller, 6 * MINUTE).await, 0, "the automation is off");

    w.store.set_enabled(&w.automation.id, true).unwrap();
    let off = sources::with_source(&w.store.get_automation(&w.automation.id).unwrap().unwrap().trigger, "github", None).unwrap();
    w.store.set_trigger(&w.automation.id, &off).unwrap();
    assert_eq!(tick(&w, &poller, 12 * MINUTE).await, 0, "it no longer watches GitHub");
    assert!(w.store.list_runs(10).unwrap().is_empty());
}

#[tokio::test]
async fn a_pr_already_asked_about_in_slack_keeps_its_thread_when_github_starts_it() {
    let (w, poller) = watching_github(None);
    let thread = json!({ "channel": "C1", "thread_ts": "1.0", "message_ts": "1.0", "requester": "U1" });
    w.store.remember_pr_thread(&w.automation.id, &format!("{REPO}#42"), &thread, 1).unwrap();
    *w.github.review_requests.lock().unwrap() = vec![requested(42)];

    tick(&w, &poller, 0).await;

    let run = &w.store.list_runs(1).unwrap()[0].run;
    let draft = w.store.draft_for_run(&run.id).unwrap().expect("draft");
    assert_eq!(draft.content["slack"]["thread_ts"], json!("1.0"));
}

#[test]
fn a_source_is_switched_on_and_off_in_the_trigger_without_touching_where_slack_listens() {
    let slack = Spec::new("slack", json!({ "channels": ["C1"], "team": "S0TEAM" }));

    let on = sources::with_source(&slack, "github", Some(json!({ "team": TEAM }))).unwrap();
    assert_eq!(on.kind, "slack");
    assert_eq!(on.config, json!({ "channels": ["C1"], "team": "S0TEAM", "sources": { "github": { "team": TEAM } } }));
    assert_eq!(sources::settings(&on, "github"), Some(&json!({ "team": TEAM })));

    let off = sources::with_source(&on, "github", None).unwrap();
    assert_eq!(off.config, json!({ "channels": ["C1"], "team": "S0TEAM" }));
    assert_eq!(sources::settings(&off, "github"), None);

    // Where Slack listens changes; what else the automation watches stays.
    let moved = sources::keep_sources(Spec::new("slack", json!({ "channels": ["C2"], "team": null })), &on);
    assert_eq!(sources::settings(&moved, "github"), Some(&json!({ "team": TEAM })));
}

#[test]
fn github_settings_are_checked_before_they_are_saved() {
    let source = GitHubRequests::new(world(open_pr()).github.clone());
    assert!(source.check(&json!({})).is_ok());
    assert!(source.check(&json!({ "team": TEAM })).is_ok());
    let err = source.check(&json!({ "team": "team-orbit" })).unwrap_err();
    assert!(err.contains("org/team-slug"), "{err}");
    assert!(source.check(&json!({ "teams": [] })).is_err(), "an unknown setting");
}
