//! Slice 07: Slack and GitHub rate limits are waited out as the server says,
//! once, and never longer than a minute (PLAN §3 principle 6).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use lotus_automation::github::{rate_limit_wait, split_included};
use lotus_automation::ratelimit::{with_rate_limit, Attempt};

fn headers(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

// ---------- GitHub: reading `gh api --include` ----------

#[test]
fn an_included_response_is_split_into_status_headers_and_a_body_that_may_hold_blank_lines() {
    // The shape `gh api -i` printed live on 2026-09-25 (gh 2.x), trimmed.
    let out = b"HTTP/2.0 200 OK\nContent-Type: text/plain\nX-Ratelimit-Remaining: 4999\n\ndiff --git a/x b/x\n\n+line\n";
    let (status, headers, body) = split_included(out).unwrap();
    assert_eq!(status, 200);
    assert!(headers.contains(&("x-ratelimit-remaining".to_string(), "4999".to_string())), "{headers:?}");
    assert_eq!(body, b"diff --git a/x b/x\n\n+line\n");
}

#[test]
fn crlf_headers_are_read_too() {
    let (status, headers, body) = split_included(b"HTTP/1.1 404 Not Found\r\nRetry-After: 3\r\n\r\n{}").unwrap();
    assert_eq!(status, 404);
    assert_eq!(headers, vec![("retry-after".to_string(), "3".to_string())]);
    assert_eq!(body, b"{}");
}

#[test]
fn output_that_is_not_an_http_response_is_not_guessed_at() {
    assert!(split_included(b"{\"a\":1}").is_none());
}

#[test]
fn github_says_how_long_to_wait() {
    // Secondary limit: Retry-After.
    assert_eq!(rate_limit_wait(429, &headers(&[("retry-after", "7")]), 1_000), Some(Duration::from_secs(7)));
    assert_eq!(rate_limit_wait(403, &headers(&[("retry-after", "2")]), 1_000), Some(Duration::from_secs(2)));
    // Primary limit: nothing left until the reset time.
    assert_eq!(
        rate_limit_wait(403, &headers(&[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "1020")]), 1_000),
        Some(Duration::from_secs(20))
    );
    // A 429 that says nothing: wait a minute.
    assert_eq!(rate_limit_wait(429, &[], 1_000), Some(Duration::from_secs(60)));
}

#[test]
fn a_403_that_is_not_a_rate_limit_is_an_ordinary_error() {
    assert_eq!(rate_limit_wait(403, &headers(&[("x-ratelimit-remaining", "12")]), 1_000), None);
    assert_eq!(rate_limit_wait(404, &[], 1_000), None);
    assert_eq!(rate_limit_wait(200, &headers(&[("retry-after", "5")]), 1_000), None);
}

// ---------- the one wait-and-retry loop both clients use ----------

struct Sleeps(Arc<Mutex<Vec<Duration>>>);

impl Sleeps {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(Vec::new())))
    }
    fn sleeper(&self) -> impl FnMut(Duration) -> std::future::Ready<()> {
        let log = Arc::clone(&self.0);
        move |d| {
            log.lock().unwrap().push(d);
            std::future::ready(())
        }
    }
    fn taken(&self) -> Vec<Duration> {
        self.0.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn a_rate_limit_is_waited_out_for_exactly_as_long_as_asked_then_the_call_is_made_again() {
    let sleeps = Sleeps::new();
    let mut replies = vec![Attempt::Wait(Duration::from_secs(5)), Attempt::Done("ok")].into_iter();
    let result = with_rate_limit("reviews", || std::future::ready(Ok(replies.next().unwrap())), sleeps.sleeper()).await;
    assert_eq!(result, Ok("ok"));
    assert_eq!(sleeps.taken(), vec![Duration::from_secs(5)]);
}

#[tokio::test]
async fn a_second_rate_limit_in_a_row_gives_up_instead_of_waiting_forever() {
    let sleeps = Sleeps::new();
    let result = with_rate_limit::<&str, _, _, _, _>(
        "reviews",
        || std::future::ready(Ok(Attempt::Wait(Duration::from_secs(1)))),
        sleeps.sleeper(),
    )
    .await;
    assert!(result.unwrap_err().contains("rate limited"));
    assert_eq!(sleeps.taken().len(), 1);
}

#[tokio::test]
async fn a_wait_over_a_minute_is_not_slept_through_but_reported() {
    let sleeps = Sleeps::new();
    let result = with_rate_limit::<&str, _, _, _, _>(
        "search",
        || std::future::ready(Ok(Attempt::Wait(Duration::from_secs(900)))),
        sleeps.sleeper(),
    )
    .await;
    let err = result.unwrap_err();
    assert!(err.contains("900"), "{err}");
    assert!(err.contains("search"), "{err}");
    assert!(sleeps.taken().is_empty());
}

#[tokio::test]
async fn an_error_is_passed_through_untouched() {
    let sleeps = Sleeps::new();
    let result =
        with_rate_limit::<&str, _, _, _, _>("x", || std::future::ready(Err("boom".to_string())), sleeps.sleeper()).await;
    assert_eq!(result, Err("boom".to_string()));
}

#[test]
fn slack_429_reads_its_retry_after() {
    use lotus_automation::slack::web::SlackReply;
    assert_eq!(SlackReply::from_status(429, Some(" 4 ")), SlackReply::RetryAfter(4));
    assert_eq!(SlackReply::from_status(200, Some("4")), SlackReply::Body);
}
