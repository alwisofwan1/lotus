//! Atomic bounded execution evidence and OS-backed single-writer leases. No replay/kill API.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::{File, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock, Weak},
};
#[path = "process_identity.rs"]
mod identity;
#[path = "source_proof.rs"]
pub mod source_proof;
pub use identity::{ProcessIdentity, ProcessState};
#[path = "execution_storage.rs"]
mod storage;
pub(super) use storage::write_snapshot;
pub use storage::{cleanup_lease, retention_required};
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Worktree,
    Implement,
    Gate,
    Review,
    Commit,
    Push,
    DraftPr,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Event {
    Intent,
    Done,
    Failed,
}
#[derive(Clone, Serialize, Deserialize)]
struct Receipt {
    phase: Phase,
    event: Event,
    attempt: u32,
    head: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Process {
    identity: ProcessIdentity,
    group: u32,
    actor: Actor,
    session: Option<String>,
    exited: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Actor {
    Implement,
    Spec,
    Triage,
    Review,
    /// The Handoff role's turn: fills the repo's PR template.
    Handoff,
    Gate,
    Probe,
}
fn group_absent(group: u32) -> bool {
    if group == 0 || group > i32::MAX as u32 {
        return false;
    }
    #[cfg(unix)]
    {
        (unsafe { libc::kill(-(group as i32), 0) }) == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
    #[cfg(not(unix))]
    {
        false
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct Data {
    version: u32,
    owner: ProcessIdentity,
    epoch: String,
    events: VecDeque<Receipt>,
    processes: Vec<Process>,
    truncated: bool,
    #[serde(default)]
    pr: Option<PrReceipt>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    checked: Option<CheckReceipt>,
    #[serde(default)]
    review: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
struct CheckReceipt {
    proof: source_proof::SourceProof,
    gate: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct PrReceipt {
    url: String,
    head: String,
}
type Registry = Mutex<HashMap<PathBuf, Weak<ExecutionJournal>>>;
fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Mutex::default)
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessHandle {
    path: PathBuf,
    epoch: String,
    actor: Actor,
    session: Option<String>,
}
impl ProcessHandle {
    fn journal(&self) -> Result<Arc<ExecutionJournal>, String> {
        let journal = registry()
            .lock()
            .map_err(|_| "Execution registry unavailable")?
            .get(&self.path)
            .and_then(Weak::upgrade)
            .ok_or("Execution owner is no longer active")?;
        if journal
            .data
            .lock()
            .map_err(|_| "Execution journal unavailable")?
            .epoch
            != self.epoch
        {
            return Err("Execution epoch changed".into());
        }
        Ok(journal)
    }
    pub fn with_actor(mut self, actor: Actor) -> Self {
        self.actor = actor;
        self
    }
    pub fn with_session(mut self, session: String) -> Self {
        self.session = Some(session);
        self
    }
    pub fn spawned(&self, pid: u32) -> Result<(), String> {
        if self.session.as_ref().is_some_and(|s| {
            s.len() > 128 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        }) {
            return Err("Invalid execution session identity".into());
        }
        #[cfg(unix)]
        if unsafe { libc::getpgid(pid as i32) } != pid as i32 {
            return Err("Child does not lead its owned process group".into());
        }
        let identity = ProcessIdentity::capture(pid)?;
        self.journal()?.update(|data| {
            if data.processes.len() >= 64 {
                return Err("Execution process evidence limit reached".into());
            }
            data.processes.push(Process {
                identity,
                group: pid,
                actor: self.actor,
                session: self.session.clone(),
                exited: false,
            });
            Ok(())
        })
    }
    pub fn exited(&self, pid: u32) -> Result<(), String> {
        self.journal()?.update(|data| {
            let process = data
                .processes
                .iter_mut()
                .rev()
                .find(|p| p.identity.pid == pid && !p.exited)
                .ok_or("Process was not registered in this execution")?;
            process.exited = true;
            Ok(())
        })
    }
}
pub struct ExecutionJournal {
    root: PathBuf,
    path: PathBuf,
    _lease: File,
    data: Mutex<Data>,
}
pub fn journal_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.journal"))
}
impl ExecutionJournal {
    pub fn acquire(root: &Path, id: &str) -> Result<Arc<Self>, String> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("Invalid execution ID".into());
        }
        super::settings::checked_path(root, root)?;
        std::fs::create_dir_all(root).map_err(|_| "Cannot create execution storage")?;
        let root = std::fs::canonicalize(root).map_err(|_| "Cannot resolve execution storage")?;
        let lock_path = root.join(format!("{id}.lease"));
        super::settings::checked_path(&root, &lock_path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lease = options
            .open(&lock_path)
            .map_err(|_| "Cannot open execution lease")?;
        lease
            .try_lock()
            .map_err(|_| "Another execution owns this Factory run")?;
        let path = journal_path(&root, id);
        super::settings::checked_path(&root, &path)?;
        let owner = ProcessIdentity::capture(std::process::id())?;
        let mut data = if path.exists() {
            let mut bytes = Vec::new();
            File::open(&path)
                .map_err(|_| "Cannot open execution journal")?
                .take(65537)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read execution journal")?;
            if bytes.len() > 65536 {
                return Err("Execution journal exceeds its bound".into());
            }
            let old: Data = serde_json::from_slice(&bytes)
                .map_err(|_| "Execution journal is unreadable; recovery required")?;
            if old.version != 1
                || old
                    .processes
                    .iter()
                    .any(|p| !p.exited || !group_absent(p.group))
            {
                return Err(
                    "Unacknowledged execution processes require recovery inspection".into(),
                );
            }
            old
        } else {
            Data {
                version: 1,
                owner: owner.clone(),
                epoch: String::new(),
                events: VecDeque::new(),
                processes: Vec::new(),
                truncated: false,
                pr: None,
                base: None,
                checked: None,
                review: None,
            }
        };
        data.owner = owner;
        data.epoch = uuid::Uuid::new_v4().to_string();
        data.processes.clear();
        atomic_write(&root, &path, &data)?;
        let journal = Arc::new(Self {
            root,
            path: path.clone(),
            _lease: lease,
            data: Mutex::new(data),
        });
        registry()
            .lock()
            .map_err(|_| "Execution registry unavailable")?
            .insert(path, Arc::downgrade(&journal));
        Ok(journal)
    }
    fn update(&self, change: impl FnOnce(&mut Data) -> Result<(), String>) -> Result<(), String> {
        let mut current = self
            .data
            .lock()
            .map_err(|_| "Execution journal unavailable")?;
        let mut next = current.clone();
        change(&mut next)?;
        atomic_write(&self.root, &self.path, &next)?;
        *current = next;
        Ok(())
    }
    pub fn record(
        &self,
        phase: Phase,
        event: Event,
        attempt: u32,
        head: Option<String>,
    ) -> Result<(), String> {
        if head
            .as_ref()
            .is_some_and(|h| h.len() > 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()))
        {
            return Err("Invalid execution revision evidence".into());
        }
        self.update(|data| {
            if matches!((phase, event), (Phase::Implement, Event::Intent)) {
                data.checked = None;
                data.review = None;
            }
            if data.events.len() == 64 {
                data.events.pop_front();
                data.truncated = true;
            }
            data.events.push_back(Receipt {
                phase,
                event,
                attempt,
                head,
            });
            Ok(())
        })
    }
    pub fn base(&self) -> Option<String> {
        self.data.lock().expect("journal mutex").base.clone()
    }
    pub fn bind_base(&self, base: String) -> Result<(), String> {
        self.update(|data| {
            if data.base.as_ref().is_some_and(|old| old != &base) {
                return Err("Execution base changed".into());
            }
            data.base = Some(base);
            Ok(())
        })
    }
    pub fn record_check(
        &self,
        proof: source_proof::SourceProof,
        gate: String,
        passed: bool,
    ) -> Result<(), String> {
        self.update(|data| {
            data.checked = passed.then_some(CheckReceipt { proof, gate });
            Ok(())
        })
    }
    pub fn checked_source(&self) -> Result<source_proof::SourceProof, String> {
        self.data
            .lock()
            .map_err(|_| "Execution journal unavailable")?
            .checked
            .as_ref()
            .map(|checked| checked.proof.clone())
            .ok_or("No durable checked source receipt".into())
    }
    pub fn record_review(&self, verdict: &str) -> Result<(), String> {
        if ![
            "accepted",
            "human",
            "revision",
            "failed",
            "skipped",
            "not-asked",
            "cancelled",
        ]
        .contains(&verdict)
        {
            return Err("Invalid review receipt".into());
        }
        self.update(|data| {
            if data.checked.is_none() {
                return Err("Review has no checked source receipt".into());
            }
            data.review = Some(verdict.into());
            Ok(())
        })
    }
    pub fn record_pr(&self, repo: &str, url: &str, head: String) -> Result<(), String> {
        let prefix = format!("https://github.com/{repo}/pull/");
        if !url
            .strip_prefix(&prefix)
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err("Publication returned an unverifiable PR URL".into());
        }
        self.update(|data| {
            data.pr = Some(PrReceipt {
                url: url.into(),
                head,
            });
            Ok(())
        })
    }
    pub fn handle(&self) -> ProcessHandle {
        ProcessHandle {
            path: self.path.clone(),
            epoch: self.data.lock().expect("journal mutex").epoch.clone(),
            actor: Actor::Probe,
            session: None,
        }
    }
}
/// Private-file replace: failed serialization/write never truncates the last valid snapshot.
fn atomic_write(root: &Path, path: &Path, data: &Data) -> Result<(), String> {
    write_snapshot(root, path, data, 65536)
}
pub fn active_handle(root: &Path, id: &str) -> Result<ProcessHandle, String> {
    let root = std::fs::canonicalize(root).map_err(|_| "Execution storage unavailable")?;
    let journal = registry()
        .lock()
        .map_err(|_| "Execution registry unavailable")?
        .get(&journal_path(&root, id))
        .and_then(Weak::upgrade)
        .ok_or("Execution owner unavailable")?;
    Ok(journal.handle())
}
impl Drop for ExecutionJournal {
    fn drop(&mut self) {
        if let Ok(mut registry) = registry().lock() {
            registry.remove(&self.path);
        }
        // Explicit release avoids transient copies inherited by concurrent fork-before-exec.
        let _ = self._lease.unlock();
    }
}
#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
