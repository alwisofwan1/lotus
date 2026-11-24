use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

use super::sse::{follow, StreamEnd, StreamSignal};
use super::*;

/// A fake machine: `open` hands out the endpoints queued in it, `curl` answers a fixed reply.
struct Fake {
    endpoints: Mutex<Vec<Result<Endpoint, String>>>,
    opens: AtomicUsize,
    curls: AtomicUsize,
}

impl Fake {
    fn new(endpoints: Vec<Result<Endpoint, String>>) -> Arc<Self> {
        Arc::new(Fake { endpoints: Mutex::new(endpoints), opens: AtomicUsize::new(0), curls: AtomicUsize::new(0) })
    }
}

impl MachineAccess for Fake {
    fn open(&self, _: &SshToolTarget) -> Result<Endpoint, AppError> {
        self.opens.fetch_add(1, Ordering::SeqCst);
        self.endpoints.lock().unwrap().remove(0).map_err(other)
    }
    fn curl(&self, _: &SshToolTarget, path: &str, _: &Value) -> Result<(u16, Value), AppError> {
        self.curls.fetch_add(1, Ordering::SeqCst);
        Ok((200, json!({ "via": "curl", "path": path })))
    }
}

fn target() -> SshToolTarget {
    SshToolTarget { host: "vps".into(), user: None, port: None }
}

fn ep(base: &str, secret: &str) -> Endpoint {
    Endpoint { base: base.into(), secret: secret.into() }
}

/// A host on a random loopback port whose `/v1/chat-cell/send` wants `Bearer good`.
async fn host(seen_ids: Arc<Mutex<Vec<Option<String>>>>) -> String {
    let streams = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .route(
            "/v1/chat-cell/send",
            post(|headers: HeaderMap, body: String| async move {
                if headers.get("authorization").and_then(|v| v.to_str().ok()) != Some("Bearer good") {
                    return (StatusCode::UNAUTHORIZED, "{}".to_string());
                }
                (StatusCode::CONFLICT, format!("{{\"echo\":{body}}}"))
            }),
        )
        .route(
            "/v1/chat-attachments",
            post(|uri: axum::http::Uri, headers: HeaderMap, body: axum::body::Bytes| async move {
                let kind = headers.get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                (StatusCode::OK, json!({ "query": uri.query(), "bytes": body.len(), "type": kind }).to_string())
            }),
        )
        // Takes the request and never reads its body, like a link that stopped moving bytes.
        .route("/v1/stall", post(|| std::future::pending::<&'static str>()))
        .route(
            "/v1/cell-conversation/stream",
            get(move |headers: HeaderMap| {
                let n = streams.fetch_add(1, Ordering::SeqCst);
                seen_ids.lock().unwrap().push(headers.get("last-event-id").and_then(|v| v.to_str().ok()).map(String::from));
                async move {
                    // First connection gives one delta then drops; the second says the cell ended.
                    if n == 0 { "event: hello\ndata: {}\n\nid: b:7\nevent: conversation\ndata: {\"cursor\":7}\n\n" }
                    else { ": ping\n\nevent: ended\ndata: {}\n\n" }
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// A loopback port with nothing listening.
fn dead_base() -> String {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn posts_json_with_the_bearer_and_returns_any_status_as_an_answer() {
    let base = host(Arc::default()).await;
    let links = HostLinks::new(Fake::new(vec![Ok(ep(&base, "good"))]));
    let (status, body, route) = links.post(&target(), "/v1/chat-cell/send", &json!({ "text": "hi" })).await.unwrap();
    assert_eq!((status, route), (409, Route::Forward));
    assert_eq!(body, json!({ "echo": { "text": "hi" } }));
}

#[tokio::test]
async fn uploads_raw_bytes_and_reopens_a_refused_forward() {
    let base = host(Arc::default()).await;
    let fake = Fake::new(vec![Ok(ep(&dead_base(), "good")), Ok(ep(&base, "good"))]);
    let links = HostLinks::new(fake.clone());
    let (status, body) = links.upload(&target(), "/v1/chat-attachments?thread=t1", vec![7; 1000], Arc::new(|_| {})).await.unwrap();
    assert_eq!(status, 200);
    assert_eq!(body, json!({ "query": "thread=t1", "bytes": 1000, "type": "application/octet-stream" }));
    assert_eq!(fake.opens.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn an_upload_reports_how_far_it_has_got_but_not_done_before_the_answer() {
    let base = host(Arc::default()).await;
    let links = HostLinks::new(Fake::new(vec![Ok(ep(&base, "good"))]));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let progress: Progress = Arc::new(move |p| log.lock().unwrap().push(p));
    let (status, body) = links.upload(&target(), "/v1/chat-attachments", vec![7; 1_000_000], progress).await.unwrap();
    assert_eq!((status, body["bytes"].clone()), (200, json!(1_000_000)));
    let seen = seen.lock().unwrap().clone();
    assert!(seen.len() > 3, "{seen:?}");
    assert!(seen.windows(2).all(|w| w[0] < w[1]), "{seen:?}");
    assert_eq!(seen.last(), Some(&99));
}

#[tokio::test]
async fn an_upload_whose_bytes_stop_moving_fails_soon_after_one_reconnect() {
    let base = host(Arc::default()).await;
    let fake = Fake::new(vec![Ok(ep(&base, "good")), Ok(ep(&base, "good"))]);
    let links = HostLinks::new(fake.clone());
    let started = std::time::Instant::now();
    let err = links.upload(&target(), "/v1/stall", vec![7; 32 * 1024 * 1024], Arc::new(|_| {})).await.unwrap_err();
    assert!(err.to_string().contains("stopped moving"), "{err}");
    assert!(started.elapsed() < Duration::from_secs(10), "{:?}", started.elapsed());
    assert_eq!(fake.opens.load(Ordering::SeqCst), 2);
}

#[test]
fn an_upload_gets_more_time_the_larger_it_is() {
    assert_eq!(upload_timeout(0), Duration::from_secs(30));
    assert_eq!(upload_timeout(25 * 1024 * 1024), Duration::from_secs(430));
}

#[tokio::test]
async fn a_401_rereads_the_secret_once_and_retries() {
    let base = host(Arc::default()).await;
    let fake = Fake::new(vec![Ok(ep(&base, "stale")), Ok(ep(&base, "good"))]);
    let links = HostLinks::new(fake.clone());
    let (status, _, _) = links.post(&target(), "/v1/chat-cell/send", &json!({})).await.unwrap();
    assert_eq!(status, 409);
    assert_eq!(fake.opens.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_refused_connection_reopens_the_forward() {
    let base = host(Arc::default()).await;
    let fake = Fake::new(vec![Ok(ep(&dead_base(), "good")), Ok(ep(&base, "good"))]);
    let links = HostLinks::new(fake.clone());
    assert_eq!(links.post(&target(), "/v1/chat-cell/send", &json!({})).await.unwrap().0, 409);
    assert_eq!(fake.opens.load(Ordering::SeqCst), 2);
}

/// What an `ssh -L` forward does when the host behind it moved port: it accepts, then hangs up.
async fn hangup_base() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            drop(sock);
        }
    });
    base
}

#[tokio::test]
async fn a_forward_that_hangs_up_is_reopened_too() {
    let base = host(Arc::default()).await;
    let fake = Fake::new(vec![Ok(ep(&hangup_base().await, "good")), Ok(ep(&base, "good"))]);
    let links = HostLinks::new(fake.clone());
    assert_eq!(links.post(&target(), "/v1/chat-cell/send", &json!({})).await.unwrap().0, 409);
    assert_eq!(fake.opens.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn falls_back_to_curl_when_the_forward_cannot_open() {
    let fake = Fake::new(vec![Err("Port forwarding failed".into())]);
    let links = HostLinks::new(fake.clone());
    let (status, body, route) = links.post(&target(), "/v1/chat-cell/stop", &json!({})).await.unwrap();
    assert_eq!((status, route), (200, Route::Curl));
    assert_eq!(body["path"], "/v1/chat-cell/stop");
}

#[tokio::test]
async fn follow_resumes_with_last_event_id_after_a_drop_and_stops_on_ended() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let base = host(seen.clone()).await;
    let links = HostLinks::new(Fake::new(vec![Ok(ep(&base, "good"))]));
    let link = links.link(&target()).await.unwrap();
    let mut signals = Vec::new();
    let end = tokio::time::timeout(
        Duration::from_secs(5),
        follow(&link, "ss-1", None, Duration::from_secs(2), |s| signals.push(s)),
    )
    .await
    .unwrap();
    assert_eq!(end, StreamEnd::Ended);
    assert_eq!(*seen.lock().unwrap(), vec![None, Some("b:7".to_string())]);
    let kinds: Vec<String> = signals
        .iter()
        .map(|s| match s {
            StreamSignal::Event(e) => e.event.clone(),
            StreamSignal::Reconnecting { .. } => "reconnecting".into(),
        })
        .collect();
    assert_eq!(kinds, ["hello", "conversation", "reconnecting", "ended"]);
}
