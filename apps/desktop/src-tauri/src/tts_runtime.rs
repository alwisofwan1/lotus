use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::Arc;

use parking_lot::Mutex;
use reqwest::Client;
use tokio::sync::watch;

use crate::error::{other, AppError};
use crate::voice_http::VOICE_HTTP_TIMEOUT;

const MAX_ACTIVE_REQUESTS: usize = 2;
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

pub struct TtsRuntime {
    client: Client,
    inner: Arc<RuntimeInner>,
}

impl TtsRuntime {
    pub fn new() -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder().timeout(VOICE_HTTP_TIMEOUT).build()?,
            inner: Arc::new(RuntimeInner {
                registry: Mutex::new(Registry::default()),
            }),
        })
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    pub fn register(&self, request_id: &str) -> Result<TtsRequest, AppError> {
        if !valid_request_id(request_id) {
            return Err(other("invalid tts synthesis request id"));
        }
        let mut registry = self.inner.registry.lock();
        if registry.active.contains_key(request_id) {
            return Err(other(format!(
                "tts synthesis request '{request_id}' is already active"
            )));
        }
        if registry.retired.iter().any(|id| id == request_id) {
            return Err(other(format!(
                "tts synthesis request '{request_id}' was recently completed"
            )));
        }
        if registry.active.len() >= MAX_ACTIVE_REQUESTS {
            return Err(other("too many active tts synthesis requests"));
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

        Ok(TtsRequest {
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

pub struct TtsRequest {
    request_id: String,
    generation: u64,
    cancellation: watch::Receiver<bool>,
    inner: Arc<RuntimeInner>,
}

impl TtsRequest {
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

impl Drop for TtsRequest {
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

pub async fn run_cancellable<T, F>(mut request: TtsRequest, provider: F) -> Result<T, AppError>
where
    F: Future<Output = Result<T, AppError>>,
{
    tokio::pin!(provider);
    tokio::select! {
        biased;
        _ = request.cancelled() => Err(other("tts synthesis cancelled")),
        result = &mut provider => {
            if request.is_cancelled() {
                Err(other("tts synthesis cancelled"))
            } else {
                result
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AppError;
    use std::future::pending;

    fn request_id(index: u128) -> String {
        uuid::Uuid::from_u128(index).to_string()
    }

    #[test]
    fn rejects_duplicate_ids_and_enforces_process_ceiling() {
        let runtime = TtsRuntime::new().unwrap();
        let first_id = request_id(1);
        let second_id = request_id(2);
        let third_id = request_id(3);
        let first = runtime.register(&first_id).unwrap();

        assert_eq!(
            runtime.register(&first_id).err().unwrap().to_string(),
            format!("tts synthesis request '{first_id}' is already active")
        );

        let _second = runtime.register(&second_id).unwrap();
        assert_eq!(
            runtime.register(&third_id).err().unwrap().to_string(),
            "too many active tts synthesis requests"
        );

        drop(first);
        assert!(runtime.register(&third_id).is_ok());
    }

    #[test]
    fn rejects_unbounded_or_malformed_request_ids() {
        let runtime = TtsRuntime::new().unwrap();
        let too_long = "x".repeat(129);

        for request_id in ["", "contains/slash", "contains space", too_long.as_str()] {
            assert_eq!(
                runtime.register(request_id).err().unwrap().to_string(),
                "invalid tts synthesis request id"
            );
        }
    }

    #[test]
    fn requires_canonical_uuid_request_ids() {
        let runtime = TtsRuntime::new().unwrap();

        assert!(runtime
            .register("550e8400-e29b-41d4-a716-446655440000")
            .is_ok());
        for request_id in [
            "reused-id",
            "550E8400-E29B-41D4-A716-446655440000",
            "550e8400e29b41d4a716446655440000",
        ] {
            assert_eq!(
                runtime.register(request_id).err().unwrap().to_string(),
                "invalid tts synthesis request id"
            );
        }
    }

    #[tokio::test]
    async fn cancel_before_register_is_consumed_by_next_registration() {
        let runtime = TtsRuntime::new().unwrap();
        let request_id = request_id(4);
        runtime.cancel(&request_id);

        let request = runtime.register(&request_id).unwrap();
        let result = run_cancellable(request, async { Ok::<_, AppError>("audio") }).await;

        assert_eq!(result.unwrap_err().to_string(), "tts synthesis cancelled");
        assert_eq!(
            runtime.register(&request_id).err().unwrap().to_string(),
            format!("tts synthesis request '{request_id}' was recently completed")
        );
    }

    #[test]
    fn rejects_immediate_reuse_after_request_completion() {
        let runtime = TtsRuntime::new().unwrap();
        let request_id = request_id(5);
        let completed = runtime.register(&request_id).unwrap();
        drop(completed);
        runtime.cancel(&request_id);

        assert_eq!(
            runtime.register(&request_id).err().unwrap().to_string(),
            format!("tts synthesis request '{request_id}' was recently completed")
        );
    }

    #[tokio::test]
    async fn cancellation_interrupts_an_active_provider_future() {
        let runtime = TtsRuntime::new().unwrap();
        let request_id = request_id(6);
        let request = runtime.register(&request_id).unwrap();
        runtime.cancel(&request_id);

        let result = run_cancellable(request, pending::<Result<(), AppError>>()).await;

        assert_eq!(result.unwrap_err().to_string(), "tts synthesis cancelled");
    }

    #[tokio::test]
    async fn cancellation_wins_when_provider_result_is_already_ready() {
        let runtime = TtsRuntime::new().unwrap();
        let request_id = request_id(7);
        let request = runtime.register(&request_id).unwrap();
        runtime.cancel(&request_id);

        let result = run_cancellable(request, async { Ok::<_, AppError>("audio") }).await;

        assert_eq!(result.unwrap_err().to_string(), "tts synthesis cancelled");
    }

    #[test]
    fn cancel_all_cancels_active_requests_and_clears_tombstones() {
        let runtime = TtsRuntime::new().unwrap();
        let stale_id = request_id(8);
        let active_id = request_id(9);
        runtime.cancel(&stale_id);
        let active = runtime.register(&active_id).unwrap();

        runtime.cancel_all();

        assert!(active.is_cancelled());
        assert!(!runtime.register(&stale_id).unwrap().is_cancelled());
    }

    #[test]
    fn cancel_before_register_tombstones_are_bounded() {
        let runtime = TtsRuntime::new().unwrap();
        for index in 0..=MAX_CANCEL_TOMBSTONES {
            runtime.cancel(&request_id(100 + index as u128));
        }

        assert!(!runtime.register(&request_id(100)).unwrap().is_cancelled());
    }

    #[test]
    fn stale_guard_does_not_remove_a_newer_generation() {
        let runtime = TtsRuntime::new().unwrap();
        let request_id = request_id(10);
        let stale = runtime.register(&request_id).unwrap();
        {
            let mut registry = runtime.inner.registry.lock();
            let (cancel, _) = watch::channel(false);
            registry.active.insert(
                request_id.clone(),
                ActiveRequest {
                    generation: stale.generation.wrapping_add(1),
                    cancel,
                },
            );
        }

        drop(stale);

        assert_eq!(
            runtime.register(&request_id).err().unwrap().to_string(),
            format!("tts synthesis request '{request_id}' is already active")
        );
    }
}
