use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::bridge_task_feedback::*;
use crate::tasks_persist::{self, TaskPersistError};

/// Per-workspace-file write lock registry. Serializes the load → mutate → save
/// critical section in the task store so concurrent writers — the frontend via
/// Tauri commands and an AI agent self-patching via the MCP IPC HTTP server
/// (axum handlers run on a multithreaded Tokio runtime) — cannot interleave and
/// clobber each other with a stale full-file overwrite, nor collide on the
/// shared `{workspace}.tmp` staging file used by the atomic write.
fn workspace_locks() -> &'static Mutex<HashMap<PathBuf, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve the lock guarding a single workspace's task file, keyed by the
/// resolved on-disk path. Distinct base dirs (e.g. per-test tempdirs) and
/// distinct workspaces never contend; every writer of the same file shares one
/// lock. Poison is recovered — a panicked writer must not wedge the store.
fn workspace_lock(base: &Path, workspace_id: &str) -> Arc<Mutex<()>> {
    let key = base.join(workspace_id);
    let mut registry = workspace_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    registry.entry(key).or_default().clone()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum SubTaskStatus {
    #[default]
    #[serde(rename = "pending")]
    Pending,
    #[serde(rename = "in-progress")]
    InProgress,
    #[serde(rename = "completed")]
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeSubTask {
    pub id: String,
    pub title: String,
    pub status: SubTaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_to: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum BridgePriority {
    #[default]
    None,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum BridgeTaskStatus {
    #[serde(rename = "todo")]
    Todo,
    #[serde(rename = "in-progress")]
    InProgress,
    #[serde(rename = "blocked")]
    Blocked,
    #[serde(rename = "in-review")]
    InReview,
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "cancelled")]
    Cancelled,
}

impl Default for BridgeTaskStatus {
    fn default() -> Self {
        Self::Todo
    }
}

/// Where a task came from, when it did not start here.
///
/// A task delegated from an Obsidian ticket points back at the FILE, not at the ticket key: two
/// files in a real vault both carry `ticket: DRAFT`, so a key cannot reopen the right one.
///
/// The vault itself learns nothing about this. It stays the human's record and Notion stays the
/// team's; the link is one-way on purpose, so nothing Lotus does can make either of them wrong.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskSource {
    pub kind: String,
    #[serde(rename = "ref")]
    pub source_ref: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTask {
    pub id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    pub title: String,
    pub goal: String,
    pub knowledge: String,
    pub status: BridgeTaskStatus,
    #[serde(default)]
    pub priority: BridgePriority,
    pub assignees: Vec<String>,
    /// The task's number within its workspace — the half of `INT-2` that identifies the task.
    ///
    /// `Option` and `serde(default)` because tasks written before this field existed have none,
    /// and a task that fails to load is worse than a task without a key. Assigned once, at
    /// creation, and never reused: a key that changed when an earlier task was deleted would be
    /// a name that lies about which task it names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
    /// PTY pane id for the cell currently executing this task. Set on
    /// dispatch, cleared on cancel / cell close. None for inert tasks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_id: Option<String>,
    /// Last execution error surfaced to the UI. Cleared on next successful
    /// dispatch. None when execution has never been attempted or last
    /// attempt succeeded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub subtasks: Vec<BridgeSubTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intake: Option<BridgeTaskIntake>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker: Option<BridgeTaskBlocker>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feedback_events: Vec<BridgeTaskFeedbackEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<TaskSource>,
    /// Where this task sits when the list is ordered by hand. A fraction, so a row dropped between
    /// two others takes the midpoint and nothing else is rewritten. `None` until it is first
    /// moved: the list then orders it by its number, which is the order it was made in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBridgeTaskInput {
    pub workspace_id: String,
    #[serde(default)]
    pub team_id: Option<String>,
    pub title: String,
    pub goal: String,
    #[serde(default)]
    pub knowledge: Option<String>,
    #[serde(default)]
    pub assignees: Vec<String>,
    #[serde(default)]
    pub status: Option<BridgeTaskStatus>,
    #[serde(default)]
    pub priority: Option<BridgePriority>,
    #[serde(default)]
    pub subtasks: Vec<BridgeSubTask>,
    #[serde(default)]
    pub due_date: Option<u64>,
    #[serde(default)]
    pub source: Option<TaskSource>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateBridgeTaskPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub knowledge: Option<String>,
    #[serde(default)]
    pub status: Option<BridgeTaskStatus>,
    #[serde(default)]
    pub assignees: Option<Vec<String>>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub priority: Option<BridgePriority>,
    /// Set / clear the active execution cell binding. `Some(Some(id))`
    /// binds, `Some(None)` clears, absent leaves it untouched.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_field",
        skip_serializing
    )]
    pub cell_id: Option<Option<String>>,
    /// Same tri-state semantics as cell_id for the last_error field.
    #[serde(
        default,
        deserialize_with = "deserialize_optional_field",
        skip_serializing
    )]
    pub last_error: Option<Option<String>>,
    #[serde(default)]
    pub subtasks: Option<Vec<BridgeSubTask>>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_field",
        skip_serializing
    )]
    pub due_date: Option<Option<u64>>,
    #[serde(default)]
    pub intake: Option<BridgeTaskIntake>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_field",
        skip_serializing
    )]
    pub blocker: Option<Option<BridgeTaskBlocker>>,
    #[serde(default)]
    pub feedback_events: Option<Vec<BridgeTaskFeedbackEvent>>,
    /// A new place in the manual order. Only ever set, never cleared: a task that was placed by
    /// hand and then "unplaced" would jump to wherever its number puts it.
    #[serde(default)]
    pub position: Option<f64>,
}

/// Distinguish "field omitted" (None) from "field set to null" (Some(None)).
/// Without this, serde collapses both to None, which makes it impossible to
/// explicitly *clear* an Option-typed field via PATCH semantics.
fn deserialize_optional_field<'de, T, D>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<T>::deserialize(d)?))
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListFilter {
    #[serde(default)]
    pub status: Option<BridgeTaskStatus>,
    #[serde(default)]
    pub assignee: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeTaskError {
    #[error(transparent)]
    Persist(#[from] TaskPersistError),
    #[error("workspaceId is required")]
    MissingWorkspaceId,
    #[error("title is required")]
    MissingTitle,
    #[error("goal is required")]
    MissingGoal,
    #[error("title exceeds cap ({0})")]
    TitleTooLong(usize),
    #[error("goal exceeds cap ({0})")]
    GoalTooLong(usize),
    #[error("knowledge exceeds cap ({0})")]
    KnowledgeTooLong(usize),
    #[error("task not found: {0}")]
    NotFound(String),
    #[error("cannot move a workspace's tasks into itself")]
    SameWorkspace,
    #[error("workspace {0} is open; only a closed workspace's tasks can be deleted")]
    WorkspaceOpen(String),
}

const ID_PREFIX: &str = "task_";
const TITLE_CAP: usize = 120;
const GOAL_CAP: usize = 500;
const KNOWLEDGE_CAP: usize = 200_000;

#[derive(Serialize, Deserialize, Default)]
struct SerializedTasks {
    v: u8,
    /// The highest task number ever handed out in this workspace.
    ///
    /// Stored rather than derived from the tasks present, because deleting the newest task would
    /// otherwise put its number back in circulation — and two tasks sharing `INT-2` across time is
    /// exactly the confusion a speakable key exists to remove. bb keeps the same counter on the
    /// project row (`next_task_number`) for the same reason.
    ///
    /// `serde(default)` leaves it at 0 in files written before numbering existed, which is what
    /// makes the first numbered task in such a workspace start at 1.
    #[serde(default)]
    next_number: u32,
    tasks: Vec<BridgeTask>,
}

pub fn create_task(input: CreateBridgeTaskInput) -> Result<BridgeTask, BridgeTaskError> {
    create_task_in(&tasks_persist::tasks_dir()?, input)
}

pub fn list_tasks(
    workspace_id: &str,
    filter: TaskListFilter,
) -> Result<Vec<BridgeTask>, BridgeTaskError> {
    list_tasks_in(&tasks_persist::tasks_dir()?, workspace_id, filter)
}

pub fn get_task(workspace_id: &str, task_id: &str) -> Result<Option<BridgeTask>, BridgeTaskError> {
    get_task_in(&tasks_persist::tasks_dir()?, workspace_id, task_id)
}

pub fn update_task(
    workspace_id: &str,
    task_id: &str,
    patch: UpdateBridgeTaskPatch,
) -> Result<BridgeTask, BridgeTaskError> {
    update_task_in(&tasks_persist::tasks_dir()?, workspace_id, task_id, patch)
}

pub fn delete_task(workspace_id: &str, task_id: &str) -> Result<(), BridgeTaskError> {
    delete_task_in(&tasks_persist::tasks_dir()?, workspace_id, task_id)
}

pub(crate) fn create_task_in(
    base: &Path,
    input: CreateBridgeTaskInput,
) -> Result<BridgeTask, BridgeTaskError> {
    validate_workspace_id(&input.workspace_id)?;
    validate_create(&input)?;
    let lock = workspace_lock(base, &input.workspace_id);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = load_state_in(base, &input.workspace_id)?;
    let next_number = next_task_number(&state);
    let mut tasks = state.tasks;
    let ts = now_ms();
    let task = BridgeTask {
        id: make_task_id(),
        number: Some(next_number),
        workspace_id: input.workspace_id.clone(),
        team_id: input.team_id,
        title: input.title,
        goal: input.goal,
        knowledge: input.knowledge.unwrap_or_default(),
        status: input.status.unwrap_or_default(),
        priority: input.priority.unwrap_or_default(),
        assignees: input.assignees,
        created_at: ts,
        updated_at: ts,
        cell_id: None,
        last_error: None,
        subtasks: input.subtasks,
        due_date: input.due_date,
        intake: None,
        blocker: None,
        feedback_events: vec![],
        source: input.source,
        position: None,
    };
    tasks.push(task.clone());
    save_tasks_in(base, &input.workspace_id, &tasks)?;
    Ok(task)
}

pub(crate) fn list_tasks_in(
    base: &Path,
    workspace_id: &str,
    filter: TaskListFilter,
) -> Result<Vec<BridgeTask>, BridgeTaskError> {
    validate_workspace_id(workspace_id)?;
    let mut tasks: Vec<BridgeTask> = load_tasks_in(base, workspace_id)?
        .into_iter()
        .filter(|t| {
            if t.workspace_id != workspace_id {
                return false;
            }
            if let Some(status) = filter.status {
                if t.status != status {
                    return false;
                }
            }
            if let Some(assignee) = filter.assignee.as_ref() {
                if !t.assignees.iter().any(|a| a == assignee) {
                    return false;
                }
            }
            true
        })
        .collect();
    tasks.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(tasks)
}

pub(crate) fn get_task_in(
    base: &Path,
    workspace_id: &str,
    task_id: &str,
) -> Result<Option<BridgeTask>, BridgeTaskError> {
    Ok(
        list_tasks_in(base, workspace_id, TaskListFilter::default())?
            .into_iter()
            .find(|t| t.id == task_id),
    )
}

pub(crate) fn update_task_in(
    base: &Path,
    workspace_id: &str,
    task_id: &str,
    patch: UpdateBridgeTaskPatch,
) -> Result<BridgeTask, BridgeTaskError> {
    validate_workspace_id(workspace_id)?;
    validate_update(&patch)?;
    let lock = workspace_lock(base, workspace_id);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut tasks = load_tasks_in(base, workspace_id)?;
    let Some(index) = tasks
        .iter()
        .position(|t| t.workspace_id == workspace_id && t.id == task_id)
    else {
        return Err(BridgeTaskError::NotFound(task_id.to_string()));
    };

    let mut task = tasks[index].clone();
    if let Some(title) = patch.title {
        task.title = title;
    }
    if let Some(goal) = patch.goal {
        task.goal = goal;
    }
    if let Some(knowledge) = patch.knowledge {
        task.knowledge = knowledge;
    }
    if let Some(status) = patch.status {
        task.status = status;
    }
    if let Some(assignees) = patch.assignees {
        task.assignees = assignees;
    }
    if let Some(team_id) = patch.team_id {
        task.team_id = Some(team_id);
    }
    if let Some(priority) = patch.priority {
        task.priority = priority;
    }
    if let Some(position) = patch.position {
        task.position = Some(position);
    }
    // Tri-state Option<Option<T>> patches: outer Some means "client touched
    // this field"; inner Option carries the new value (or None to clear).
    if let Some(cell_id) = patch.cell_id {
        task.cell_id = cell_id;
    }
    if let Some(last_error) = patch.last_error {
        task.last_error = last_error;
    }
    if let Some(subtasks) = patch.subtasks {
        task.subtasks = subtasks;
    }
    if let Some(due_date) = patch.due_date {
        task.due_date = due_date;
    }
    if let Some(intake) = patch.intake {
        task.intake = Some(intake);
    }
    if let Some(blocker) = patch.blocker {
        task.blocker = blocker;
    }
    if let Some(feedback_events) = patch.feedback_events {
        task.feedback_events = feedback_events;
    }
    task.updated_at = now_ms();
    tasks[index] = task.clone();
    save_tasks_in(base, workspace_id, &tasks)?;
    Ok(task)
}

pub fn append_feedback_event(
    workspace_id: &str,
    task_id: &str,
    event: BridgeTaskFeedbackEvent,
) -> Result<BridgeTask, BridgeTaskError> {
    append_feedback_event_in(&tasks_persist::tasks_dir()?, workspace_id, task_id, event)
}

pub(crate) fn append_feedback_event_in(
    base: &Path,
    workspace_id: &str,
    task_id: &str,
    event: BridgeTaskFeedbackEvent,
) -> Result<BridgeTask, BridgeTaskError> {
    validate_workspace_id(workspace_id)?;
    let lock = workspace_lock(base, workspace_id);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut tasks = load_tasks_in(base, workspace_id)?;
    let Some(index) = tasks
        .iter()
        .position(|t| t.workspace_id == workspace_id && t.id == task_id)
    else {
        return Err(BridgeTaskError::NotFound(task_id.to_string()));
    };

    let mut task = tasks[index].clone();
    task.feedback_events.push(event);
    task.updated_at = now_ms();
    tasks[index] = task.clone();
    save_tasks_in(base, workspace_id, &tasks)?;
    Ok(task)
}

pub(crate) fn delete_task_in(
    base: &Path,
    workspace_id: &str,
    task_id: &str,
) -> Result<(), BridgeTaskError> {
    validate_workspace_id(workspace_id)?;
    let lock = workspace_lock(base, workspace_id);
    let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut tasks = load_tasks_in(base, workspace_id)?;
    let before = tasks.len();
    tasks.retain(|task| !(task.workspace_id == workspace_id && task.id == task_id));
    if tasks.len() == before {
        return Err(BridgeTaskError::NotFound(task_id.to_string()));
    }
    save_tasks_in(base, workspace_id, &tasks)?;
    Ok(())
}

/// The whole file, counter included. `create_task_in` needs it; every other caller only wants the
/// tasks and goes through `load_tasks_in`.
fn load_state_in(base: &Path, workspace_id: &str) -> Result<SerializedTasks, BridgeTaskError> {
    let raw = tasks_persist::read_tasks_in(base, workspace_id)?;
    let Some(raw) = raw else {
        return Ok(SerializedTasks::default());
    };
    // A file this build cannot parse is treated as empty rather than fatal — the same rule as
    // before numbering. It is the one case where the counter can be lost, and it is already the
    // case where every task is lost.
    Ok(serde_json::from_str::<SerializedTasks>(&raw).unwrap_or_default())
}

fn load_tasks_in(base: &Path, workspace_id: &str) -> Result<Vec<BridgeTask>, BridgeTaskError> {
    Ok(load_state_in(base, workspace_id)?.tasks)
}

fn save_tasks_in(
    base: &Path,
    workspace_id: &str,
    tasks: &[BridgeTask],
) -> Result<(), BridgeTaskError> {
    // The counter is carried forward HERE rather than passed in by each of the four writers: an
    // invariant that four call sites have to remember is an invariant that one of them will drop.
    // The read is cheap (one small file) and happens under the lock the caller already holds.
    let previous = load_state_in(base, workspace_id)?.next_number;
    let high_water = tasks
        .iter()
        .filter_map(|task| task.number)
        .max()
        .unwrap_or(0)
        .max(previous);
    let payload = serde_json::to_string(&SerializedTasks {
        v: 1,
        next_number: high_water,
        tasks: tasks.to_vec(),
    })
    .expect("Bridge tasks serialize");
    tasks_persist::write_tasks_in(base, workspace_id, &payload)?;
    Ok(())
}

fn validate_workspace_id(workspace_id: &str) -> Result<(), BridgeTaskError> {
    if workspace_id.is_empty() {
        return Err(BridgeTaskError::MissingWorkspaceId);
    }
    Ok(())
}

fn validate_create(input: &CreateBridgeTaskInput) -> Result<(), BridgeTaskError> {
    if input.title.is_empty() {
        return Err(BridgeTaskError::MissingTitle);
    }
    if input.goal.is_empty() {
        return Err(BridgeTaskError::MissingGoal);
    }
    validate_text(
        input.title.as_str(),
        input.goal.as_str(),
        input.knowledge.as_deref(),
    )
}

fn validate_update(patch: &UpdateBridgeTaskPatch) -> Result<(), BridgeTaskError> {
    validate_text(
        patch.title.as_deref().unwrap_or(""),
        patch.goal.as_deref().unwrap_or(""),
        patch.knowledge.as_deref(),
    )
}

fn validate_text(title: &str, goal: &str, knowledge: Option<&str>) -> Result<(), BridgeTaskError> {
    if title.len() > TITLE_CAP {
        return Err(BridgeTaskError::TitleTooLong(TITLE_CAP));
    }
    if goal.len() > GOAL_CAP {
        return Err(BridgeTaskError::GoalTooLong(GOAL_CAP));
    }
    if knowledge.is_some_and(|k| k.len() > KNOWLEDGE_CAP) {
        return Err(BridgeTaskError::KnowledgeTooLong(KNOWLEDGE_CAP));
    }
    Ok(())
}

/// The next number for a workspace: one past the highest ever handed out there.
///
/// Derived from the MAXIMUM rather than from the count, because deleting a task must not put its
/// number back in circulation — two tasks sharing `INT-2` across time is exactly the confusion a
/// speakable key exists to remove. Tasks from before this field existed count as zero, so the
/// first numbered task in an old workspace starts at 1 and the unnumbered ones simply never get
/// a key.
fn next_task_number(state: &SerializedTasks) -> u32 {
    // The stored counter wins, but the tasks present are still consulted: a file hand-edited to
    // carry a higher number than the counter must not produce a duplicate key.
    state
        .tasks
        .iter()
        .filter_map(|task| task.number)
        .max()
        .unwrap_or(0)
        .max(state.next_number)
        .saturating_add(1)
}

fn make_task_id() -> String {
    let raw = uuid::Uuid::new_v4().simple().to_string();
    format!("{ID_PREFIX}{}", &raw[..12])
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// A task file no open workspace owns — typically one written under a workspace id Lotus handed
/// out before a reopened folder kept its old id.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrphanTaskFile {
    pub workspace_id: String,
    pub task_count: usize,
    /// Tasks not yet complete or cancelled — what the user is actually missing.
    pub open_count: usize,
    pub last_updated_at: u64,
    /// A few open titles, newest first: a pre-fix workspace id is a uuid nobody recognises, and
    /// its tasks are how the user tells which folder it was.
    pub sample_titles: Vec<String>,
    /// The user hid it from the list; its file is untouched, so the tasks load again if that
    /// workspace is ever reopened.
    pub ignored: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MovedTasks {
    pub moved: usize,
    /// Tasks left behind because the target already has one with the same title.
    pub skipped_duplicates: usize,
}

pub fn list_orphan_task_files(
    open_workspace_ids: &[String],
) -> Result<Vec<OrphanTaskFile>, BridgeTaskError> {
    list_orphan_task_files_in(&tasks_persist::tasks_dir()?, open_workspace_ids)
}

pub fn move_workspace_tasks(from: &str, to: &str) -> Result<MovedTasks, BridgeTaskError> {
    move_workspace_tasks_in(&tasks_persist::tasks_dir()?, from, to)
}

pub fn set_orphan_ignored(workspace_id: &str, ignored: bool) -> Result<(), BridgeTaskError> {
    set_orphan_ignored_in(&tasks_persist::tasks_dir()?, workspace_id, ignored)
}

pub fn delete_orphan_task_file(
    workspace_id: &str,
    open_workspace_ids: &[String],
) -> Result<(), BridgeTaskError> {
    delete_orphan_task_file_in(&tasks_persist::tasks_dir()?, workspace_id, open_workspace_ids)
}

/// The ids the user chose to ignore, beside the task files. No `.json` suffix, so the orphan
/// scan never mistakes it for a workspace.
const IGNORED_ORPHANS_FILE: &str = ".orphans-ignored";

/// One writer at a time for the ignore list; it is written atomically, so readers need no lock.
fn ignored_orphans_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// The ignored ids; none when the list was never written. A list that exists but cannot be read
/// is an error, never an empty list, so a toggle cannot overwrite the ids it failed to read.
fn read_ignored_orphans(base: &Path) -> Result<Vec<String>, BridgeTaskError> {
    match std::fs::read_to_string(base.join(IGNORED_ORPHANS_FILE)) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            TaskPersistError::Io(std::io::Error::new(std::io::ErrorKind::InvalidData, e)).into()
        }),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(TaskPersistError::Io(err).into()),
    }
}

/// Hide (or show again) a closed workspace's tasks in the list, leaving its file as it is.
pub(crate) fn set_orphan_ignored_in(
    base: &Path,
    workspace_id: &str,
    ignored: bool,
) -> Result<(), BridgeTaskError> {
    validate_workspace_id(workspace_id)?;
    let _held = ignored_orphans_lock()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut ids = read_ignored_orphans(base)?;
    let was = ids.iter().any(|id| id == workspace_id);
    if was == ignored {
        return Ok(());
    }
    ids.retain(|id| id != workspace_id);
    if ignored {
        ids.push(workspace_id.to_string());
    }
    let raw = serde_json::to_vec(&ids).unwrap_or_else(|_| b"[]".to_vec());
    tasks_persist::atomic_write(base.join(IGNORED_ORPHANS_FILE), &raw)
        .map_err(TaskPersistError::Io)?;
    Ok(())
}

/// Retire a closed workspace's task file (`{id}.json.deleted-{ms}`, restorable by hand). Refused
/// for an open workspace: its tasks are on the board right now.
pub(crate) fn delete_orphan_task_file_in(
    base: &Path,
    workspace_id: &str,
    open_workspace_ids: &[String],
) -> Result<(), BridgeTaskError> {
    validate_workspace_id(workspace_id)?;
    if open_workspace_ids.iter().any(|id| id == workspace_id) {
        return Err(BridgeTaskError::WorkspaceOpen(workspace_id.to_string()));
    }
    let lock = workspace_lock(base, workspace_id);
    let _held = lock.lock().unwrap_or_else(|p| p.into_inner());
    if tasks_persist::read_tasks_in(base, workspace_id)?.is_none() {
        return Err(BridgeTaskError::NotFound(workspace_id.to_string()));
    }
    // Forgotten first, so a failure here leaves the file in place and the error is the truth; a
    // file written under this id later then starts shown.
    set_orphan_ignored_in(base, workspace_id, false)?;
    tasks_persist::retire_tasks_in(base, workspace_id, tasks_persist::Retired::Deleted, now_ms())?;
    Ok(())
}

pub(crate) fn list_orphan_task_files_in(
    base: &Path,
    open_workspace_ids: &[String],
) -> Result<Vec<OrphanTaskFile>, BridgeTaskError> {
    let entries = match std::fs::read_dir(base) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(TaskPersistError::Io(err).into()),
    };
    // Unreadable, everything shows: nothing is lost, and the next toggle reports the problem.
    let ignored = read_ignored_orphans(base).unwrap_or_default();
    let mut orphans = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(workspace_id) = name.strip_suffix(".json") else {
            continue;
        };
        if open_workspace_ids.iter().any(|id| id == workspace_id) {
            continue;
        }
        // Not a name the store could have written (the id check would refuse it anyway).
        let Ok(state) = load_state_in(base, workspace_id) else {
            continue;
        };
        if state.tasks.is_empty() {
            continue;
        }
        let mut open: Vec<&BridgeTask> = state
            .tasks
            .iter()
            .filter(|t| {
                !matches!(
                    t.status,
                    BridgeTaskStatus::Complete | BridgeTaskStatus::Cancelled
                )
            })
            .collect();
        open.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        orphans.push(OrphanTaskFile {
            workspace_id: workspace_id.to_string(),
            task_count: state.tasks.len(),
            open_count: open.len(),
            last_updated_at: state.tasks.iter().map(|t| t.updated_at).max().unwrap_or(0),
            sample_titles: open.iter().take(3).map(|t| t.title.clone()).collect(),
            ignored: ignored.iter().any(|id| id == workspace_id),
        });
    }
    orphans.sort_by(|a, b| b.last_updated_at.cmp(&a.last_updated_at));
    Ok(orphans)
}

/// Move every task of `from` into `to`, then retire `from`'s file.
///
/// Ids are kept, so anything that links a task keeps working; numbers are the target's next ones,
/// so a key never names two tasks. A task whose title the target already has is skipped — the
/// first recovery was a hand copy under new ids, and moving must not make a second copy.
pub(crate) fn move_workspace_tasks_in(
    base: &Path,
    from: &str,
    to: &str,
) -> Result<MovedTasks, BridgeTaskError> {
    validate_workspace_id(from)?;
    validate_workspace_id(to)?;
    if from == to {
        return Err(BridgeTaskError::SameWorkspace);
    }
    // Both files are held for the whole move, always locked in the same order so two opposite
    // moves cannot deadlock.
    let (first, second) = if from < to { (from, to) } else { (to, from) };
    let first_lock = workspace_lock(base, first);
    let _first = first_lock.lock().unwrap_or_else(|p| p.into_inner());
    let second_lock = workspace_lock(base, second);
    let _second = second_lock.lock().unwrap_or_else(|p| p.into_inner());

    if tasks_persist::read_tasks_in(base, from)?.is_none() {
        return Err(BridgeTaskError::NotFound(from.to_string()));
    }
    let source = load_state_in(base, from)?;
    let mut target = load_state_in(base, to)?;

    let mut incoming = source.tasks;
    // Oldest first, so the moved tasks keep their relative order under the new numbers.
    incoming.sort_by_key(|t| (t.number.unwrap_or(u32::MAX), t.created_at));
    let mut result = MovedTasks {
        moved: 0,
        skipped_duplicates: 0,
    };
    for mut task in incoming {
        if target.tasks.iter().any(|t| t.title == task.title) {
            result.skipped_duplicates += 1;
            continue;
        }
        let number = next_task_number(&target);
        task.number = Some(number);
        task.workspace_id = to.to_string();
        // A pane of the closed workspace, and a place in another list, mean nothing here.
        task.cell_id = None;
        task.position = None;
        target.next_number = number;
        target.tasks.push(task);
        result.moved += 1;
    }

    // Forgotten before the file goes, like a delete: a file written under `from` later starts shown.
    set_orphan_ignored_in(base, from, false)?;
    save_tasks_in(base, to, &target.tasks)?;
    tasks_persist::retire_tasks_in(base, from, tasks_persist::Retired::Moved, now_ms())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The words that go on the wire, pinned.
    ///
    /// Twice now the desktop has read a word this store cannot produce: `blocked` was missing from
    /// the TypeScript status union, so a task that failed review was drawn at the bottom of the
    /// list; and `SubTaskStatus::Completed` serialises as `completed` while the counter looked for
    /// `done`, so sub-task progress read 0/N forever. Neither was a logic mistake — both were a
    /// rename nobody could see. These assertions make the next one fail here.
    #[test]
    fn status_words_on_the_wire_are_the_ones_the_desktop_reads() {
        let statuses = [
            (BridgeTaskStatus::Todo, "todo"),
            (BridgeTaskStatus::InProgress, "in-progress"),
            (BridgeTaskStatus::Blocked, "blocked"),
            (BridgeTaskStatus::InReview, "in-review"),
            (BridgeTaskStatus::Complete, "complete"),
            (BridgeTaskStatus::Cancelled, "cancelled"),
        ];
        for (status, word) in statuses {
            assert_eq!(serde_json::to_string(&status).unwrap(), format!("\"{word}\""));
        }
    }

    #[test]
    fn subtask_words_on_the_wire_are_the_ones_the_desktop_reads() {
        let statuses = [
            (SubTaskStatus::Pending, "pending"),
            (SubTaskStatus::InProgress, "in-progress"),
            (SubTaskStatus::Completed, "completed"),
        ];
        for (status, word) in statuses {
            assert_eq!(serde_json::to_string(&status).unwrap(), format!("\"{word}\""));
        }
    }

    #[test]
    fn priority_words_on_the_wire_are_the_ones_the_desktop_reads() {
        let priorities = [
            (BridgePriority::None, "none"),
            (BridgePriority::Low, "low"),
            (BridgePriority::Medium, "medium"),
            (BridgePriority::High, "high"),
        ];
        for (priority, word) in priorities {
            assert_eq!(serde_json::to_string(&priority).unwrap(), format!("\"{word}\""));
        }
    }

    fn temp_base() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn create_list_update_get_round_trips_workspace_tasks() {
        let base = temp_base();
        let created = create_task_in(
            base.path(),
            CreateBridgeTaskInput {
                source: None,
                workspace_id: "ws_alpha".into(),
                team_id: None,
                title: "Wire task tools".into(),
                goal: "Bridge can create tasks through MCP".into(),
                knowledge: Some("Keep storage local.".into()),
                assignees: vec!["claude".into()],
                status: Some(BridgeTaskStatus::Todo),
                priority: None,
                subtasks: vec![],
                due_date: None,
            },
        )
        .unwrap();

        assert!(created.id.starts_with("task_"));
        assert_eq!(created.status, BridgeTaskStatus::Todo);

        let listed = list_tasks_in(base.path(), "ws_alpha", TaskListFilter::default()).unwrap();
        assert_eq!(listed, vec![created.clone()]);

        let updated = update_task_in(
            base.path(),
            "ws_alpha",
            &created.id,
            UpdateBridgeTaskPatch {
                status: Some(BridgeTaskStatus::InProgress),
                goal: Some("Bridge can create and update tasks through MCP".into()),
                ..UpdateBridgeTaskPatch::default()
            },
        )
        .unwrap();
        assert_eq!(updated.status, BridgeTaskStatus::InProgress);
        assert!(updated.updated_at >= created.updated_at);

        let fetched = get_task_in(base.path(), "ws_alpha", &created.id).unwrap();
        assert_eq!(fetched, Some(updated));
    }

    /// The number is what makes `INT-2` sayable; without it the list draws no key at all.
    #[test]
    fn numbers_tasks_per_workspace_starting_at_one() {
        let base = temp_base();
        let first = seed_task(base.path(), "ws_alpha", "first");
        let second = seed_task(base.path(), "ws_alpha", "second");
        // A second workspace is a second project, and its numbering starts over.
        let other = seed_task(base.path(), "ws_beta", "first elsewhere");

        assert_eq!(first.number, Some(1));
        assert_eq!(second.number, Some(2));
        assert_eq!(other.number, Some(1));
    }

    /// Deleting must not put a number back in circulation: two tasks sharing `INT-2` across time
    /// is exactly the confusion a speakable key exists to remove.
    #[test]
    fn a_deleted_task_does_not_hand_its_number_back() {
        let base = temp_base();
        let first = seed_task(base.path(), "ws_alpha", "first");
        let second = seed_task(base.path(), "ws_alpha", "second");
        delete_task_in(base.path(), "ws_alpha", &second.id).unwrap();

        let third = seed_task(base.path(), "ws_alpha", "third");

        assert_eq!(first.number, Some(1));
        assert_eq!(third.number, Some(3));
    }

    /// A task written before this field existed must still load — and must not suddenly grow a
    /// key it never had. It simply has none, and the next task numbers from there.
    #[test]
    fn a_task_written_without_a_number_still_loads() {
        let base = temp_base();
        // The envelope an older build wrote: one file per workspace, and no `number` anywhere.
        let legacy = r#"{"v":1,"tasks":[{
            "id": "task_legacy0001",
            "workspaceId": "ws_old",
            "title": "written by an older build",
            "goal": "g",
            "knowledge": "",
            "status": "todo",
            "assignees": [],
            "createdAt": 1,
            "updatedAt": 1
        }]}"#;
        std::fs::create_dir_all(base.path()).unwrap();
        std::fs::write(base.path().join("ws_old.json"), legacy).unwrap();

        let loaded = list_tasks_in(base.path(), "ws_old", Default::default()).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].number, None);
        // Nor a place in a manual order it was never put in.
        assert_eq!(loaded[0].position, None);

        let next = seed_task(base.path(), "ws_old", "first numbered one");
        assert_eq!(next.number, Some(1));
    }

    /// The manual order is the list's own: a row dragged between two others keeps that place
    /// after the app is closed, because the place is written into the task and not into the view.
    #[test]
    fn a_position_set_from_the_list_survives_a_reload() {
        let base = temp_base();
        let task = seed_task(base.path(), "ws_alpha", "dragged");
        assert_eq!(task.position, None);

        // The shape the desktop sends, camelCase, straight off the wire.
        let patch: UpdateBridgeTaskPatch = serde_json::from_str(r#"{"position": 1.5}"#).unwrap();
        update_task_in(base.path(), "ws_alpha", &task.id, patch).unwrap();

        let reloaded = get_task_in(base.path(), "ws_alpha", &task.id).unwrap().unwrap();
        assert_eq!(reloaded.position, Some(1.5));

        // A patch that does not mention it leaves the place where it was.
        update_task_in(
            base.path(),
            "ws_alpha",
            &task.id,
            UpdateBridgeTaskPatch { title: Some("renamed".into()), ..Default::default() },
        )
        .unwrap();
        let renamed = get_task_in(base.path(), "ws_alpha", &task.id).unwrap().unwrap();
        assert_eq!(renamed.position, Some(1.5));
    }

    fn seed_task(base: &Path, workspace_id: &str, title: &str) -> BridgeTask {
        create_task_in(
            base,
            CreateBridgeTaskInput {
                source: None,
                workspace_id: workspace_id.into(),
                team_id: None,
                title: title.into(),
                goal: "goal".into(),
                knowledge: None,
                assignees: vec![],
                status: None,
                priority: None,
                subtasks: vec![],
                due_date: None,
            },
        )
        .unwrap()
    }

    /// Two writers patching *different* tasks in the same workspace must not
    /// clobber each other. Without write serialization the full-file overwrite
    /// in `save_tasks_in` means the last writer persists a stale snapshot of
    /// the other task. Stress-tests the read-modify-write critical section.
    #[test]
    fn concurrent_updates_to_distinct_tasks_do_not_clobber() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        const ITER: usize = 500;
        let base = temp_base();
        let base_path = base.path().to_path_buf();
        let ws = "ws_race";
        let a = seed_task(&base_path, ws, "a");
        let b = seed_task(&base_path, ws, "b");

        let start = Arc::new(Barrier::new(2));
        let writer = |base: PathBuf, task_id: String, prefix: char, gate: Arc<Barrier>| {
            thread::spawn(move || {
                gate.wait();
                for i in 0..ITER {
                    update_task_in(
                        &base,
                        ws,
                        &task_id,
                        UpdateBridgeTaskPatch {
                            title: Some(format!("{prefix}{i}")),
                            ..UpdateBridgeTaskPatch::default()
                        },
                    )
                    .unwrap();
                }
            })
        };

        let ta = writer(base_path.clone(), a.id.clone(), 'a', start.clone());
        let tb = writer(base_path.clone(), b.id.clone(), 'b', start.clone());
        ta.join().unwrap();
        tb.join().unwrap();

        let fa = get_task_in(&base_path, ws, &a.id).unwrap().unwrap();
        let fb = get_task_in(&base_path, ws, &b.id).unwrap().unwrap();
        assert_eq!(fa.title, format!("a{}", ITER - 1), "task A lost its update");
        assert_eq!(fb.title, format!("b{}", ITER - 1), "task B lost its update");
    }

    /// Concurrent creates in the same workspace must all survive. Without write
    /// serialization each create loads the full list, pushes one task and saves
    /// the whole file, so interleaved creates drop tasks and the final count is
    /// short of the number created.
    #[test]
    fn concurrent_creates_all_persist() {
        use std::sync::{Arc, Barrier};
        use std::thread;

        const WRITERS: usize = 8;
        const PER_WRITER: usize = 40;
        let base = temp_base();
        let base_path = base.path().to_path_buf();
        let ws = "ws_create_race";

        let start = Arc::new(Barrier::new(WRITERS));
        let handles: Vec<_> = (0..WRITERS)
            .map(|w| {
                let base = base_path.clone();
                let gate = start.clone();
                thread::spawn(move || {
                    gate.wait();
                    for i in 0..PER_WRITER {
                        seed_task(&base, ws, &format!("w{w}-{i}"));
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let listed = list_tasks_in(&base_path, ws, TaskListFilter::default()).unwrap();
        assert_eq!(
            listed.len(),
            WRITERS * PER_WRITER,
            "concurrent creates dropped tasks"
        );
    }

    #[test]
    fn blocked_task_persists_intake_blocker_and_feedback_events() {
        let base = temp_base();
        let created = seed_task(base.path(), "ws_intake", "Ambiguous task");
        let event = BridgeTaskFeedbackEvent {
            id: "evt_1".into(),
            at: 10,
            actor: BridgeTaskFeedbackActor::Director,
            kind: BridgeTaskFeedbackKind::HitlQuestion,
            summary: "Asked which scope to use".into(),
            payload: None,
        };

        let updated = update_task_in(
            base.path(),
            "ws_intake",
            &created.id,
            UpdateBridgeTaskPatch {
                status: Some(BridgeTaskStatus::Blocked),
                intake: Some(BridgeTaskIntake {
                    brief_xml: "<task-understanding-brief />".into(),
                    confidence: 0.62,
                    decision: BridgeTaskIntakeDecision::AskHuman,
                    updated_at: 20,
                }),
                blocker: Some(Some(BridgeTaskBlocker {
                    phase: BridgeTaskBlockerPhase::Intake,
                    kind: BridgeTaskBlockerType::HumanInput,
                    reason: "Need Human clarification before assignment".into(),
                    question_id: Some("q_1".into()),
                })),
                feedback_events: Some(vec![event.clone()]),
                ..UpdateBridgeTaskPatch::default()
            },
        )
        .unwrap();

        assert_eq!(updated.status, BridgeTaskStatus::Blocked);
        assert_eq!(
            updated.intake.unwrap().decision,
            BridgeTaskIntakeDecision::AskHuman
        );
        assert_eq!(
            updated.blocker.unwrap().kind,
            BridgeTaskBlockerType::HumanInput
        );
        assert_eq!(updated.feedback_events, vec![event]);
    }

    #[test]
    fn append_feedback_event_preserves_existing_timeline() {
        let base = temp_base();
        let created = seed_task(base.path(), "ws_events", "Trace task");
        append_feedback_event_in(
            base.path(),
            "ws_events",
            &created.id,
            BridgeTaskFeedbackEvent {
                id: "evt_1".into(),
                at: 1,
                actor: BridgeTaskFeedbackActor::Director,
                kind: BridgeTaskFeedbackKind::IntakeCreated,
                summary: "Brief created".into(),
                payload: None,
            },
        )
        .unwrap();
        let updated = append_feedback_event_in(
            base.path(),
            "ws_events",
            &created.id,
            BridgeTaskFeedbackEvent {
                id: "evt_2".into(),
                at: 2,
                actor: BridgeTaskFeedbackActor::Human,
                kind: BridgeTaskFeedbackKind::HitlAnswer,
                summary: "Answered scope question".into(),
                payload: None,
            },
        )
        .unwrap();

        assert_eq!(updated.feedback_events.len(), 2);
        assert_eq!(updated.feedback_events[0].id, "evt_1");
        assert_eq!(updated.feedback_events[1].id, "evt_2");
    }

    fn set_status(base: &Path, ws: &str, task: &BridgeTask, status: BridgeTaskStatus) {
        update_task_in(
            base,
            ws,
            &task.id,
            UpdateBridgeTaskPatch {
                status: Some(status),
                ..UpdateBridgeTaskPatch::default()
            },
        )
        .unwrap();
    }

    /// A task file is an orphan when no open workspace owns it — that is the only thing Lotus can
    /// know, since nothing links a pre-fix workspace id to its folder.
    #[test]
    fn lists_task_files_of_workspaces_that_are_not_open() {
        let base = temp_base();
        seed_task(base.path(), "ws_open", "mine");
        let a = seed_task(base.path(), "ws_old", "open one");
        seed_task(base.path(), "ws_old", "open two");
        let done = seed_task(base.path(), "ws_old", "finished");
        set_status(base.path(), "ws_old", &done, BridgeTaskStatus::Complete);
        let gone = seed_task(base.path(), "ws_old", "dropped");
        set_status(base.path(), "ws_old", &gone, BridgeTaskStatus::Cancelled);
        // A file that holds no task at all is nothing to recover.
        tasks_persist::write_tasks_in(base.path(), "ws_empty", r#"{"v":1,"tasks":[]}"#).unwrap();
        // Neither is something that is not a task file.
        std::fs::write(base.path().join("notes.txt"), "x").unwrap();

        let orphans = list_orphan_task_files_in(base.path(), &["ws_open".to_string()]).unwrap();

        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].workspace_id, "ws_old");
        assert_eq!(orphans[0].task_count, 4);
        assert_eq!(orphans[0].open_count, 2);
        assert!(orphans[0].last_updated_at >= a.updated_at);
        // Only open tasks are shown as the hint; finished ones are not what the user is missing.
        assert_eq!(orphans[0].sample_titles.len(), 2);
        assert!(orphans[0].sample_titles.contains(&"open one".to_string()));
        assert!(!orphans[0].sample_titles.contains(&"finished".to_string()));
    }

    #[test]
    fn moving_renumbers_after_the_target_and_retires_the_source_file() {
        let base = temp_base();
        seed_task(base.path(), "ws_new", "already here 1");
        seed_task(base.path(), "ws_new", "already here 2");
        let old1 = seed_task(base.path(), "ws_old", "old first");
        let old2 = seed_task(base.path(), "ws_old", "old second");
        update_task_in(
            base.path(),
            "ws_old",
            &old2.id,
            UpdateBridgeTaskPatch {
                cell_id: Some(Some("pane-of-a-closed-workspace".into())),
                ..UpdateBridgeTaskPatch::default()
            },
        )
        .unwrap();

        let moved = move_workspace_tasks_in(base.path(), "ws_old", "ws_new").unwrap();

        assert_eq!(moved.moved, 2);
        assert_eq!(moved.skipped_duplicates, 0);
        let listed = list_tasks_in(base.path(), "ws_new", TaskListFilter::default()).unwrap();
        let by_title = |t: &str| listed.iter().find(|x| x.title == t).unwrap().clone();
        let first = by_title("old first");
        let second = by_title("old second");
        // Same task, new home: the id survives so links to it keep working; the number is the
        // target's next, so `LOT-3` never names two tasks.
        assert_eq!(first.id, old1.id);
        assert_eq!(first.workspace_id, "ws_new");
        assert_eq!(first.number, Some(3));
        assert_eq!(second.number, Some(4));
        // A pane id from the closed workspace points at nothing here.
        assert_eq!(second.cell_id, None);
        // The source no longer shows up as an orphan, and nothing is left behind to move twice.
        assert!(
            list_orphan_task_files_in(base.path(), &["ws_new".to_string()])
                .unwrap()
                .is_empty()
        );
        assert!(
            list_tasks_in(base.path(), "ws_old", TaskListFilter::default())
                .unwrap()
                .is_empty()
        );
        // Retired, not deleted: the original file is still on disk under another name.
        let retired = std::fs::read_dir(base.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("ws_old.json.moved-")
            });
        assert!(retired);
        // The next task created in the target continues after the moved ones.
        assert_eq!(seed_task(base.path(), "ws_new", "after").number, Some(5));
    }

    /// The first recovery was done by hand: 16 tasks were copied into the new workspace under new
    /// ids. Moving the old file must not bring a second copy of each.
    #[test]
    fn moving_skips_tasks_the_target_already_has_by_title() {
        let base = temp_base();
        seed_task(base.path(), "ws_new", "copied by hand");
        seed_task(base.path(), "ws_old", "copied by hand");
        seed_task(base.path(), "ws_old", "never copied");

        let moved = move_workspace_tasks_in(base.path(), "ws_old", "ws_new").unwrap();

        assert_eq!(moved.moved, 1);
        assert_eq!(moved.skipped_duplicates, 1);
        let titles: Vec<String> = list_tasks_in(base.path(), "ws_new", TaskListFilter::default())
            .unwrap()
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert_eq!(titles.iter().filter(|t| *t == "copied by hand").count(), 1);
        assert!(titles.contains(&"never copied".to_string()));
    }

    #[test]
    fn moving_into_itself_or_from_nothing_is_refused() {
        let base = temp_base();
        seed_task(base.path(), "ws_old", "x");
        assert!(move_workspace_tasks_in(base.path(), "ws_old", "ws_old").is_err());
        assert!(move_workspace_tasks_in(base.path(), "ws_missing", "ws_old").is_err());
        // The refused move changed nothing.
        assert_eq!(
            list_tasks_in(base.path(), "ws_old", TaskListFilter::default())
                .unwrap()
                .len(),
            1
        );
    }

    fn orphan<'a>(orphans: &'a [OrphanTaskFile], ws: &str) -> Option<&'a OrphanTaskFile> {
        orphans.iter().find(|o| o.workspace_id == ws)
    }

    /// A closed workspace may be a real one that is reopened later (its tasks load again then), so
    /// ignoring only hides it from the list: the file and its tasks stay exactly as they were.
    #[test]
    fn ignoring_an_orphan_hides_it_without_touching_its_tasks_and_can_be_undone() {
        let base = temp_base();
        seed_task(base.path(), "ws_old", "keep me");
        seed_task(base.path(), "ws_other", "other");

        set_orphan_ignored_in(base.path(), "ws_old", true).unwrap();

        let listed = list_orphan_task_files_in(base.path(), &[]).unwrap();
        assert!(orphan(&listed, "ws_old").unwrap().ignored);
        assert!(!orphan(&listed, "ws_other").unwrap().ignored);
        let tasks = list_tasks_in(base.path(), "ws_old", TaskListFilter::default()).unwrap();
        assert_eq!(tasks.len(), 1, "the tasks are still there for when the workspace reopens");

        set_orphan_ignored_in(base.path(), "ws_old", false).unwrap();
        let listed = list_orphan_task_files_in(base.path(), &[]).unwrap();
        assert!(!orphan(&listed, "ws_old").unwrap().ignored);
    }

    /// Deleting retires the file like a move does (`.deleted-{ms}`, restorable by hand), and is
    /// never allowed for a workspace that is open: its tasks are on the board right now.
    #[test]
    fn deleting_an_orphan_retires_its_file_and_never_touches_an_open_workspace() {
        let base = temp_base();
        seed_task(base.path(), "ws_old", "stale");
        seed_task(base.path(), "ws_open", "live");
        set_orphan_ignored_in(base.path(), "ws_old", true).unwrap();

        assert!(delete_orphan_task_file_in(base.path(), "ws_open", &["ws_open".to_string()]).is_err());
        assert!(delete_orphan_task_file_in(base.path(), "ws_missing", &[]).is_err());
        assert_eq!(list_tasks_in(base.path(), "ws_open", TaskListFilter::default()).unwrap().len(), 1);

        delete_orphan_task_file_in(base.path(), "ws_old", &["ws_open".to_string()]).unwrap();

        assert!(list_orphan_task_files_in(base.path(), &["ws_open".to_string()]).unwrap().is_empty());
        assert!(list_tasks_in(base.path(), "ws_old", TaskListFilter::default()).unwrap().is_empty());
        let names: Vec<String> = std::fs::read_dir(base.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.starts_with("ws_old.json.deleted-")), "{names:?}");
        // A task file written again under that id later is not born ignored.
        seed_task(base.path(), "ws_old", "new life");
        let listed = list_orphan_task_files_in(base.path(), &[]).unwrap();
        assert!(!orphan(&listed, "ws_old").unwrap().ignored);
    }

    /// A moved file is gone like a deleted one: a file written under that id later starts shown.
    #[test]
    fn moving_an_ignored_orphan_forgets_that_it_was_ignored() {
        let base = temp_base();
        seed_task(base.path(), "ws_old", "old");
        seed_task(base.path(), "ws_new", "new");
        set_orphan_ignored_in(base.path(), "ws_old", true).unwrap();

        move_workspace_tasks_in(base.path(), "ws_old", "ws_new").unwrap();
        seed_task(base.path(), "ws_old", "new life");

        let listed = list_orphan_task_files_in(base.path(), &["ws_new".to_string()]).unwrap();
        assert!(!orphan(&listed, "ws_old").unwrap().ignored);
    }

    /// An ignore list Lotus cannot read is not an empty one: toggling one id must not wipe the rest.
    #[test]
    fn an_unreadable_ignore_list_is_never_overwritten() {
        let base = temp_base();
        seed_task(base.path(), "ws_a", "a");
        std::fs::write(base.path().join(IGNORED_ORPHANS_FILE), r#"["ws_b", "ws_c"#).unwrap();

        assert!(set_orphan_ignored_in(base.path(), "ws_a", true).is_err());
        let raw = std::fs::read_to_string(base.path().join(IGNORED_ORPHANS_FILE)).unwrap();
        assert!(raw.contains("ws_b") && raw.contains("ws_c"), "{raw}");
    }
}
