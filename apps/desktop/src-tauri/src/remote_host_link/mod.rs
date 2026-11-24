//! One long-lived HTTP link per machine to its Standalone Host, for remote Chat threads.
//!
//! `remote_lotus_host` spawns `ssh … curl` per call (0.31–0.58 s on devbox-vps). This adds a
//! `-L` forward to the master `RemoteTransport` already holds, and talks plain HTTP/1.1
//! keep-alive through it (0.11–0.22 s measured), plus SSE for the stream. The secret is read once
//! over SSH and held in memory only. If the forward cannot be opened, actions fall back to curl.
//! Decision record: `plans/chat-remote-host/RESEARCH.md` §5.

pub mod sse;
mod ssh;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::cli_tools::SshToolTarget;
use crate::error::{other, AppError};

pub use ssh::SshAccess;

/// Where the forward lands locally, and the bearer the host expects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub base: String,
    pub secret: String,
}

/// The two things a link needs from a machine; a trait so tests run without SSH.
pub trait MachineAccess: Send + Sync + 'static {
    /// Open (or reopen) the forward and read the secret. Blocking.
    fn open(&self, target: &SshToolTarget) -> Result<Endpoint, AppError>;
    /// The old per-call `ssh … curl` path, answering `(status, body)`. Blocking.
    fn curl(&self, target: &SshToolTarget, path: &str, body: &Value) -> Result<(u16, Value), AppError>;
}

/// Action timeout; the stream has none, only the idle timeout in `sse`.
const ACTION_TIMEOUT: Duration = Duration::from_secs(10);

/// An upload's overall cap grows with its size: 30 s plus one second per 64 KB (a slow link still
/// finishes a 10 MB file in ~3 min). A dead link is caught sooner, by [`STALL`].
fn upload_timeout(bytes: usize) -> Duration {
    Duration::from_secs(30 + (bytes / (64 * 1024)) as u64)
}

/// Whole percents of an upload handed to the link, for the composer's chip.
pub type Progress = Arc<dyn Fn(u8) + Send + Sync>;

/// How long an upload may go without the link taking another piece before it counts as dead.
const STALL: Duration = if cfg!(test) { Duration::from_millis(300) } else { Duration::from_secs(30) };

/// When the link last took a piece, and whether it has taken them all.
type Pulled = Arc<Mutex<(std::time::Instant, bool)>>;

/// Resolves once the body has sat still for [`STALL`]. After the last piece the overall cap
/// rules instead: ssh may still be draining a few MB it buffered.
async fn stalled(pulled: Pulled) {
    loop {
        tokio::time::sleep(STALL / 4).await;
        let (at, done) = *pulled.lock().unwrap_or_else(|e| e.into_inner());
        if !done && at.elapsed() >= STALL {
            return;
        }
    }
}

/// The body in 64 KB pieces, reporting each new percent as the client pulls it. Pulled is not
/// delivered: ssh and the sockets buffer a few MB, so it stops at 99 and the host's answer is 100.
fn counted_body(bytes: Arc<Vec<u8>>, progress: Progress, pulled: Pulled) -> reqwest::Body {
    const PIECE: usize = 64 * 1024;
    let total = bytes.len().max(1);
    let mut last = None;
    let pieces = (0..bytes.len()).step_by(PIECE).map(move |start| {
        let end = (start + PIECE).min(bytes.len());
        *pulled.lock().unwrap_or_else(|e| e.into_inner()) = (std::time::Instant::now(), end == bytes.len());
        let percent = (end * 100 / total).min(99) as u8;
        if last != Some(percent) {
            last = Some(percent);
            progress(percent);
        }
        Ok::<_, std::io::Error>(bytes[start..end].to_vec())
    });
    reqwest::Body::wrap_stream(tokio_stream::iter(pieces))
}

pub struct HostLink {
    target: SshToolTarget,
    access: Arc<dyn MachineAccess>,
    client: reqwest::Client,
    endpoint: Mutex<Endpoint>,
    healing: tokio::sync::Mutex<()>,
}

impl HostLink {
    fn new(target: SshToolTarget, access: Arc<dyn MachineAccess>, endpoint: Endpoint) -> Self {
        let client = reqwest::Client::builder()
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        HostLink { target, access, client, endpoint: Mutex::new(endpoint), healing: tokio::sync::Mutex::new(()) }
    }

    fn current(&self) -> Endpoint {
        self.endpoint.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Reopen after a failed connection or a 401 (host restarted). An `ssh -L` forward whose host moved
    /// port accepts and then hangs up, so "refused" alone misses a host restart.
    async fn heal(&self) -> Result<(), AppError> {
        let _one_at_a_time = self.healing.lock().await;
        let (access, target) = (Arc::clone(&self.access), self.target.clone());
        let fresh = tokio::task::spawn_blocking(move || access.open(&target))
            .await
            .map_err(|e| other(format!("reopening the host link panicked: {e}")))??;
        *self.endpoint.lock().unwrap_or_else(|e| e.into_inner()) = fresh;
        Ok(())
    }

    /// `POST <path>` with a JSON body. Retried once after any failure but a timeout.
    pub async fn post(&self, path: &str, body: &Value) -> Result<(u16, Value), AppError> {
        self.request(path, Some(body)).await
    }

    /// `GET <path>`, with the same retry rule as `post`.
    pub async fn get(&self, path: &str) -> Result<(u16, Value), AppError> {
        self.request(path, None).await
    }

    async fn request(&self, path: &str, body: Option<&Value>) -> Result<(u16, Value), AppError> {
        for first in [true, false] {
            let ep = self.current();
            let url = format!("{}{path}", ep.base);
            let req = match body {
                Some(body) => self.client.post(url).json(body),
                None => self.client.get(url),
            };
            let sent = req.bearer_auth(&ep.secret).timeout(ACTION_TIMEOUT).send().await;
            match sent {
                Ok(resp) if resp.status().as_u16() == 401 && first => self.heal().await?,
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.map_err(|e| other(format!("reading the host's answer: {e}")))?;
                    return Ok((status, serde_json::from_str(&text).unwrap_or(Value::String(text))));
                }
                // Not after a timeout: the action may have run. Any other failure retries with the same
                // body, so a `requestId` makes a repeat harmless.
                Err(e) if !e.is_timeout() && first => self.heal().await?,
                Err(e) => return Err(other(format!("{}'s Lotus Host did not answer: {e}", self.target.host))),
            }
        }
        Err(other(format!("{}'s Lotus Host still refuses after reconnecting.", self.target.host)))
    }

    /// `POST <path_and_query>` with raw bytes. Unlike an action it is retried after a timeout too: the
    /// host names the file by its sha256, so a repeat stores nothing twice.
    pub async fn upload(&self, path_and_query: &str, bytes: Vec<u8>, progress: Progress) -> Result<(u16, Value), AppError> {
        let timeout = upload_timeout(bytes.len());
        let bytes = Arc::new(bytes);
        for first in [true, false] {
            let ep = self.current();
            let pulled: Pulled = Arc::new(Mutex::new((std::time::Instant::now(), bytes.is_empty())));
            let send = self
                .client
                .post(format!("{}{path_and_query}", ep.base))
                .bearer_auth(&ep.secret)
                .header("content-type", "application/octet-stream")
                .body(counted_body(bytes.clone(), progress.clone(), pulled.clone()))
                .timeout(timeout)
                .send();
            // `None`: the bytes stopped moving, so the forward is likely dead; reopen it like a refusal.
            let sent = tokio::select! {
                sent = send => Some(sent),
                () = stalled(pulled) => None,
            };
            match sent {
                Some(Ok(resp)) if resp.status().as_u16() == 401 && first => self.heal().await?,
                Some(Ok(resp)) => {
                    let status = resp.status().as_u16();
                    let text = resp.text().await.map_err(|e| other(format!("reading the host's answer: {e}")))?;
                    return Ok((status, serde_json::from_str(&text).unwrap_or(Value::String(text))));
                }
                Some(Err(e)) if first => {
                    if !e.is_timeout() {
                        self.heal().await?;
                    }
                }
                Some(Err(e)) => return Err(other(format!("{}'s Lotus Host did not take the file: {e}", self.target.host))),
                None if first => self.heal().await?,
                None => return Err(other(format!("the file stopped moving to {}", self.target.host))),
            }
        }
        Err(other(format!("{}'s Lotus Host still refuses after reconnecting.", self.target.host)))
    }

    /// `GET /v1/cell-conversation/stream`; heals first when the last attempt could not connect.
    pub(crate) async fn open_stream(&self, pane_id: &str, last_id: Option<&str>) -> Result<reqwest::Response, AppError> {
        for first in [true, false] {
            let ep = self.current();
            let mut req = self
                .client
                .get(format!("{}/v1/cell-conversation/stream", ep.base))
                .query(&[("pane_id", pane_id)])
                .bearer_auth(&ep.secret);
            if let Some(id) = last_id {
                req = req.header("Last-Event-ID", id);
            }
            match req.send().await {
                Ok(resp) if resp.status().as_u16() == 401 && first => self.heal().await?,
                Ok(resp) => return Ok(resp),
                Err(e) if !e.is_timeout() && first => self.heal().await?,
                Err(e) => return Err(other(format!("stream connect failed: {e}"))),
            }
        }
        Err(other("the host keeps refusing the stream"))
    }
}

/// How an action reached the host — `curl` means the forward failed and it is the slow path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Route {
    Forward,
    Curl,
}

/// Every machine's link, opened on first use.
pub struct HostLinks {
    access: Arc<dyn MachineAccess>,
    links: Mutex<HashMap<String, Arc<HostLink>>>,
}

fn key(t: &SshToolTarget) -> String {
    format!("{}@{}:{}", t.user.as_deref().unwrap_or(""), t.host, t.port.unwrap_or(22))
}

impl HostLinks {
    pub fn new(access: Arc<dyn MachineAccess>) -> Self {
        HostLinks { access, links: Mutex::new(HashMap::new()) }
    }

    /// The machine's link, opening it if needed (blocks on SSH, so off the async runtime).
    pub async fn link(&self, target: &SshToolTarget) -> Result<Arc<HostLink>, AppError> {
        if let Some(l) = self.links.lock().unwrap_or_else(|e| e.into_inner()).get(&key(target)) {
            return Ok(Arc::clone(l));
        }
        let (access, t) = (Arc::clone(&self.access), target.clone());
        let ep = tokio::task::spawn_blocking(move || access.open(&t))
            .await
            .map_err(|e| other(format!("opening the host link panicked: {e}")))??;
        let link = Arc::new(HostLink::new(target.clone(), Arc::clone(&self.access), ep));
        // A racing opener may have won; keep the first so both callers share one link.
        let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        Ok(Arc::clone(links.entry(key(target)).or_insert(link)))
    }

    /// An action over the link, or over curl when the link cannot be opened.
    pub async fn post(&self, target: &SshToolTarget, path: &str, body: &Value) -> Result<(u16, Value, Route), AppError> {
        match self.link(target).await {
            Ok(link) => {
                let answer = link.post(path, body).await;
                // Not retried over curl here: a timed-out action may have run. The next call reopens.
                if answer.is_err() {
                    self.forget(target);
                }
                answer.map(|(s, v)| (s, v, Route::Forward))
            }
            Err(open_error) => {
                let (access, t, p, b) = (Arc::clone(&self.access), target.clone(), path.to_string(), body.clone());
                let (s, v) = tokio::task::spawn_blocking(move || access.curl(&t, &p, &b))
                    .await
                    .map_err(|e| other(format!("curl fallback panicked: {e}")))?
                    .map_err(|e| other(format!("{open_error}; curl fallback also failed: {e}")))?;
                Ok((s, v, Route::Curl))
            }
        }
    }

    /// A read over the link. No curl fallback: a list that cannot load just says so.
    pub async fn get(&self, target: &SshToolTarget, path: &str) -> Result<(u16, Value), AppError> {
        let answer = self.link(target).await?.get(path).await;
        if answer.is_err() {
            self.forget(target);
        }
        answer
    }

    /// Raw bytes over the link. No curl fallback: a file does not fit in a command line.
    pub async fn upload(&self, target: &SshToolTarget, path_and_query: &str, bytes: Vec<u8>, progress: Progress) -> Result<(u16, Value), AppError> {
        let answer = self.link(target).await?.upload(path_and_query, bytes, progress).await;
        if answer.is_err() {
            self.forget(target);
        }
        answer
    }

    pub fn forget(&self, target: &SshToolTarget) {
        self.links.lock().unwrap_or_else(|e| e.into_inner()).remove(&key(target));
    }
}

#[cfg(test)]
mod tests;
