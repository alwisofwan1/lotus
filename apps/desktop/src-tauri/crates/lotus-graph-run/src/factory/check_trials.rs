//! App-level trial receipts and single-flight admission. Results are ephemeral, not persisted.
use super::check_trial::*;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrialSnapshot {
    #[serde(flatten)]
    pub preview: TrialPreview,
    #[serde(flatten)]
    pub result: TrialResult,
    pub output: String,
    pub elapsed_ms: u64,
    pub current_revision: Option<String>,
}
struct Prepared {
    plan: TrialPlan,
    at: Instant,
}
struct Job {
    plan: TrialPlan,
    result: TrialResult,
    output: Arc<Mutex<Vec<u8>>>,
    cancel: watch::Sender<bool>,
    start: Instant,
    elapsed: Option<u64>,
    task: Option<JoinHandle<()>>,
}
#[derive(Default)]
struct Data {
    prepared: HashMap<String, Prepared>,
    jobs: HashMap<String, Job>,
    active: Option<String>,
    closing: bool,
}
#[derive(Clone)]
pub struct CheckTrials {
    root: PathBuf,
    env: Arc<HashMap<String, String>>,
    data: Arc<Mutex<Data>>,
}
impl CheckTrials {
    pub fn new(root: PathBuf, env: HashMap<String, String>) -> Self {
        Self {
            root,
            env: Arc::new(env),
            data: Arc::new(Mutex::new(Data::default())),
        }
    }
    pub async fn preview(
        &self,
        checkout: &Path,
        repo: &str,
        base: &str,
        command: &str,
        shell: bool,
    ) -> Result<TrialPreview, String> {
        let plan = prepare(checkout, repo, base, command, shell, &self.root, &self.env).await?;
        let view = plan.preview.clone();
        let mut data = self.data.lock().unwrap_or_else(|p| p.into_inner());
        if data.closing {
            return Err("Check trials are shutting down".into());
        }
        data.prepared
            .retain(|_, p| p.at.elapsed() < Duration::from_secs(300));
        if data.prepared.len() >= 16 {
            if let Some(oldest) = data
                .prepared
                .iter()
                .min_by_key(|(_, p)| p.at)
                .map(|(id, _)| id.clone())
            {
                data.prepared.remove(&oldest);
            }
        }
        data.prepared.insert(
            view.id.clone(),
            Prepared {
                plan,
                at: Instant::now(),
            },
        );
        Ok(view)
    }
    pub fn planned_repo(&self, id: &str) -> Result<String, String> {
        self.data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .prepared
            .get(id)
            .map(|p| p.plan.preview.repo.clone())
            .ok_or("Check preview expired or was already used. Review a new preview.".into())
    }
    pub fn is_running(&self, repo: &str) -> bool {
        self.data
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .jobs
            .get(repo)
            .is_some_and(|j| j.result.status == TrialStatus::Running)
    }
    pub fn start(&self, id: &str) -> Result<TrialSnapshot, String> {
        let mut data = self.data.lock().unwrap_or_else(|p| p.into_inner());
        if data.closing || data.active.is_some() {
            return Err(
                "Another check trial is running. Cancel or finish it before starting another."
                    .into(),
            );
        }
        let prepared = data
            .prepared
            .remove(id)
            .filter(|p| p.at.elapsed() < Duration::from_secs(300))
            .ok_or("Check preview expired or was already used. Review a new preview.")?;
        let plan = prepared.plan;
        let repo = plan.preview.repo.clone();
        if !data.jobs.contains_key(&repo) && data.jobs.len() >= 16 {
            if let Some(oldest) = data
                .jobs
                .iter()
                .min_by_key(|(_, j)| j.start)
                .map(|(r, _)| r.clone())
            {
                data.jobs.remove(&oldest);
            }
        }
        let output = Arc::new(Mutex::new(Vec::new()));
        let (cancel, receiver) = watch::channel(false);
        let start = Instant::now();
        let result = TrialResult { status: TrialStatus::Running, exit_code: None, message: "Preparing an isolated detached worktree. No dependencies are installed automatically.".into() };
        let job = Job {
            plan: plan.clone(),
            result,
            output: output.clone(),
            cancel,
            start,
            elapsed: None,
            task: None,
        };
        let receipt = self.snapshot(&job);
        data.active = Some(id.into());
        data.jobs.insert(repo.clone(), job);
        let service = self.clone();
        let task = tokio::spawn(async move {
            let result = execute(&plan, &service.env, TRIAL_TIMEOUT, receiver, output).await;
            let mut data = service.data.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(job) = data.jobs.get_mut(&repo) {
                job.result = result;
                job.elapsed = Some(start.elapsed().as_millis() as u64);
            }
            data.active = None;
        });
        data.jobs
            .get_mut(&receipt.preview.repo)
            .expect("inserted")
            .task = Some(task);
        Ok(receipt)
    }
    pub async fn status(&self, repo: &str) -> Option<TrialSnapshot> {
        let mut snapshot = {
            let data = self.data.lock().unwrap_or_else(|p| p.into_inner());
            self.snapshot(data.jobs.get(repo)?)
        };
        snapshot.current_revision = revision(
            Path::new(&snapshot.preview.checkout),
            &snapshot.preview.base,
            &self.env,
        )
        .await
        .ok();
        Some(snapshot)
    }
    fn snapshot(&self, job: &Job) -> TrialSnapshot {
        let mut output =
            String::from_utf8_lossy(&job.output.lock().unwrap_or_else(|p| p.into_inner()))
                .into_owned();
        for (key, value) in self.env.iter() {
            let key = key.to_ascii_uppercase();
            if value.len() >= 4
                && ([
                    "KEY",
                    "TOKEN",
                    "PASSWORD",
                    "SECRET",
                    "CREDENTIAL",
                    "AUTH",
                    "COOKIE",
                ]
                .iter()
                .any(|word| key.contains(word))
                    || (value.contains("://") && value.contains('@')))
            {
                output = output.replace(value, "[redacted]");
            }
        }
        if output.len() > 16_384 {
            let mut from = output.len() - 16_384;
            while !output.is_char_boundary(from) {
                from += 1;
            }
            output.drain(..from);
        }
        TrialSnapshot {
            preview: job.plan.preview.clone(),
            result: job.result.clone(),
            output,
            elapsed_ms: job
                .elapsed
                .unwrap_or_else(|| job.start.elapsed().as_millis() as u64),
            current_revision: Some(job.plan.preview.revision.clone()),
        }
    }
    pub fn cancel(&self, repo: &str, id: &str) -> Result<(), String> {
        let data = self.data.lock().unwrap_or_else(|p| p.into_inner());
        let job = data
            .jobs
            .get(repo)
            .filter(|j| j.plan.preview.id == id)
            .ok_or("The check trial no longer matches this repository")?;
        if job.result.status == TrialStatus::Running {
            let _ = job.cancel.send(true);
        }
        Ok(())
    }
    pub async fn shutdown(&self) {
        let tasks: Vec<_> = {
            let mut data = self.data.lock().unwrap_or_else(|p| p.into_inner());
            data.closing = true;
            data.prepared.clear();
            data.jobs
                .values_mut()
                .filter_map(|j| {
                    let _ = j.cancel.send(true);
                    j.task.take()
                })
                .collect()
        };
        for task in tasks {
            let _ = task.await;
        }
    }
}
#[cfg(test)]
#[path = "check_trials_tests.rs"]
mod tests;
