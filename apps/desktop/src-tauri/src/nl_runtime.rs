use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::Arc;

use parking_lot::Mutex;
use reqwest::Client;
use tokio::sync::watch;

use crate::error::{other, AppError};
use std::time::Duration;

const MAX_CANCEL_TOMBSTONES: usize = 128;
const MAX_RETIRED_REQUESTS: usize = 1_024;

fn valid_request_id(request_id: &str) -> bool {
    uuid::Uuid::parse_str(request_id)
        .map(|id| id.hyphenated().to_string() == request_id)
        .unwrap_or(false)
}

struct ActiveRequest {
    generation: u64,
    cancel: watch::Sender<bool>,
}

#[derive(Default)]
struct Registry {
    active: HashMap<String, ActiveRequest>,
    tombstones: VecDeque<String>,
    retired: VecDeque<String>,
    next_generation: u64,
}

struct RuntimeInner {
    registry: Mutex<Registry>,
}

pub struct NlRuntime {
    client: Client,
    inner: Arc<RuntimeInner>,
}

impl NlRuntime {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder().timeout(Duration::from_secs(10)).build()?,
            inner: Arc::new(RuntimeInner {
                registry: Mutex::new(Registry::default()),
            }),
        })
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn register(&self, request_id: &str) -> Result<NlRequest, AppError> {
        if !valid_request_id(request_id) {
            return Err(other("invalid NL completion request id"));
        }
        let mut registry = self.inner.registry.lock();
        if registry.active.contains_key(request_id) {
            return Err(other(format!(
                "NL completion request '{request_id}' is already active"
            )));
        }
        if registry.retired.iter().any(|id| id == request_id) {
            return Err(other(format!(
                "NL completion request '{request_id}' was recently completed"
            )));
        }
        registry.next_generation = registry.next_generation.wrapping_add(1);
        let generation = registry.next_generation;
        let cancelled = registry
            .tombstones
            .iter()
            .position(|id| id == request_id)
            .map(|position| registry.tombstones.remove(position).is_some())
            .unwrap_or(false);
        let (cancel, cancellation) = watch::channel(cancelled);
        registry
            .active
            .insert(request_id.to_string(), ActiveRequest { generation, cancel });

        Ok(NlRequest {
            request_id: request_id.to_string(),
            generation,
            cancellation,
            inner: Arc::clone(&self.inner),
        })
    }

    pub fn cancel(&self, request_id: &str) {
        if !valid_request_id(request_id) {
            return;
        }
        let mut registry = self.inner.registry.lock();
        if let Some(active) = registry.active.get(request_id) {
            active.cancel.send_replace(true);
            return;
        }
        if registry.retired.iter().any(|id| id == request_id) {
            return;
        }
        if registry.tombstones.iter().any(|id| id == request_id) {
            return;
        }
        if registry.tombstones.len() == MAX_CANCEL_TOMBSTONES {
            registry.tombstones.pop_front();
        }
        registry.tombstones.push_back(request_id.to_string());
    }

    pub fn cancel_all(&self) {
        let mut registry = self.inner.registry.lock();
        for request in registry.active.values() {
            request.cancel.send_replace(true);
        }
        registry.tombstones.clear();
    }
}

pub struct NlRequest {
    request_id: String,
    generation: u64,
    cancellation: watch::Receiver<bool>,
    inner: Arc<RuntimeInner>,
}

impl NlRequest {
    pub fn is_cancelled(&self) -> bool {
        *self.cancellation.borrow()
    }

    async fn cancelled(&mut self) {
        while !self.is_cancelled() {
            if self.cancellation.changed().await.is_err() {
                break;
            }
        }
    }
}

impl Drop for NlRequest {
    fn drop(&mut self) {
        let mut registry = self.inner.registry.lock();
        let owns_entry = registry
            .active
            .get(&self.request_id)
            .map(|active| active.generation == self.generation)
            .unwrap_or(false);
        if owns_entry {
            registry.active.remove(&self.request_id);
            if registry.retired.len() == MAX_RETIRED_REQUESTS {
                registry.retired.pop_front();
            }
            registry.retired.push_back(self.request_id.clone());
        }
    }
}

pub async fn run_cancellable<T, F>(mut request: NlRequest, provider: F) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    tokio::pin!(provider);
    tokio::select! {
        biased;
        _ = request.cancelled() => Err(other("nl_complete[cancelled]: NL completion cancelled")),
        result = &mut provider => {
            if request.is_cancelled() {
                Err(other("nl_complete[cancelled]: NL completion cancelled"))
            } else {
                result
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[tokio::test]
    async fn cancel_before_register_never_polls_provider() {
        let runtime = NlRuntime::new().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        runtime.cancel(&id);
        let request = runtime.register(&id).unwrap();
        let polled = AtomicBool::new(false);
        let result = run_cancellable(request, async {
            polled.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert!(result.is_err());
        assert!(!polled.load(Ordering::SeqCst));
        assert!(runtime.inner.registry.lock().active.is_empty());
    }

    #[tokio::test]
    async fn cancel_drops_inflight_work_without_cancelling_other_requests() {
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let runtime = NlRuntime::new().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let request = runtime.register(&id).unwrap();
        let other = runtime.register(&uuid::Uuid::new_v4().to_string()).unwrap();
        let dropped = Arc::new(AtomicBool::new(false));
        let guard = Dropped(Arc::clone(&dropped));
        let (started, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(run_cancellable(request, async move {
            let _guard = guard;
            let _ = started.send(());
            std::future::pending::<Result<(), AppError>>().await
        }));
        ready.await.unwrap();
        runtime.cancel(&id);
        let result = tokio::time::timeout(Duration::from_millis(100), task).await;
        assert!(
            result.is_ok(),
            "native request stayed alive after cancellation"
        );
        assert!(result.unwrap().unwrap().is_err());
        assert!(dropped.load(Ordering::SeqCst));
        assert!(!other.is_cancelled());
    }
}
