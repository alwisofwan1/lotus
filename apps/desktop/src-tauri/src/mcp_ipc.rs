//! Localhost HTTP IPC server consumed by the Lotus MCP sidecar (see
//! `scripts/lotus-mcp-server.mjs`). Claude CLI spawns the MCP server as its own
//! subprocess; the MCP server in turn posts tool invocations to this endpoint so
//! the running Tauri app can fulfil them against live state (terminal sessions,
//! fleet snapshot, etc.).
//!
//! Design goals:
//!   - Bind to `127.0.0.1:0` so the OS picks a free port, then advertise it via
//!     `~/.claude/lotus-mcp-ipc.json`.
//!   - Require `Authorization: Bearer <secret>` on every request. Secret is
//!     random 32-byte hex, regenerated on every app startup.
//!   - Keep handler functions thin — all domain state (fleet snapshot, dispatch
//!     invocations) is supplied via the shared [`McpIpcState`] which the rest
//!     of the app updates.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use parking_lot::{Mutex as ParkMutex, RwLock};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

use crate::pty::{self, PtyState};

/// Pure nested-`claude -p` attribution for the `/v1/hook/stop` endpoint —
/// split out so the ancestor-walk decision logic stays injectable/testable.
mod nested_stop;

/// Snapshot of a single Terminal cell. Mirrors `FleetMember` on the TS side so
/// Claude can consume the same shape it sees in the GUI. Optional fields are
/// `None` when the frontend has not yet reported them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpFleetMember {
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub member_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fleet_schema_version: Option<u32>,
    pub workspace_id: String,
    pub cwd: String,
    pub provider: String,
    /// The runner's name as the desktop's own node header prints it (`acme`, `Codex`).
    /// `None` when the frontend could not name it. Distinct from `provider`, which
    /// collapses a custom Claude-family runner to `claude` on purpose.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner_label: Option<String>,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub legacy_aliases: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub status: String,
    pub is_alive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_output_preview: Option<String>,
    /// What this cell was asked to do — the headline its card shows.
    ///
    /// The one field that says what a peer is WORKING ON rather than what state it is in:
    /// `status` and `turn` give its state, and [`Self::last_output_preview`] is a raw terminal
    /// tail. A lead agent picking a dispatch target had no better clue than that tail.
    ///
    /// Pushed by the frontend because that is the only place it exists — unlike `turn`, which is
    /// deliberately NOT taken from a push because the hook pipeline is its authoritative source and
    /// a second, weaker one would let a stale value outrank it.
    ///
    /// `None` when the frontend has not seen this cell asked anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    /// Runtime PTY session id, if the pane is still live. Needed by
    /// `dispatch-to-cell` + `read-cell-output` so those tools do not need
    /// another round-trip to the frontend to resolve paneId → sessionId.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Phase 4 capability truth pushed by the frontend so a lead agent can route by what a peer can
    /// actually do: `can_reply` (reachable right now), `can_queue` (alive, will buffer until ready),
    /// `mcp_tools_available` (has the Lotus MCP tools). `None` when the frontend has not reported them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_reply: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_queue: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_tools_available: Option<bool>,
    /// Whether this cell's CLI drives the hook pipeline a transcript is made of.
    ///
    /// Reported rather than inferred from [`Self::provider`], for the reason
    /// [`Self::runner_label`] exists: `provider` collapses a custom Claude-family runner
    /// to `claude` **on purpose**, and it is also what an unreported runner falls back to
    /// (`runnerToFleetProvider`). Reading capability off that label made every such cell
    /// claim it reports steps, so Chat waited for a transcript that was never coming.
    ///
    /// `None` when the frontend cannot say — the same "cannot say" the other capability
    /// flags above carry, and the reason this is not a bare `bool`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reports_steps: Option<bool>,
    /// Whether the cell asks before acting: `asks`, `skipped`, `runner_cannot`.
    /// Derived by the frontend from the command that launched it; `None` means
    /// unknown, never ungated (ADR-8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gating: Option<String>,
}

/// One pane's hook-reported turn state, as the desktop frontend reads it.
///
/// **Why `turn` is not `status`.** `McpFleetMember::status` is launch phase — "this pane exists
/// and is running". `turn` is turn phase — "this agent is waiting for a human". They are
/// different questions with overlapping answer strings (`idle`, `running`, `error`), and
/// `contract/README.md` is the authority on keeping them apart. This type exists so the canvas
/// can stop inferring the second from PTY bytes.
///
/// `turn` carries the canonical strings from `scripts/agent-notify/event-mapping.mjs` verbatim —
/// notably `needs-input`, the one value that means a human is actually needed. Rust does not
/// re-interpret them; mapping them onto UI state is the frontend resolver's single job.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PaneTurnSnapshot {
    pub pane_id: String,
    pub turn: String,
    /// Age of the fact in ms. A stale `needs-input` is a very different thing from a fresh one,
    /// so the age travels with the value rather than being recomputed from a timestamp the
    /// frontend would have to trust its own clock to compare against.
    pub turn_age_ms: u64,
}

/// Outcome of resolving a dispatch target against the fleet snapshot, with
/// cross-project name-collision awareness (RC6).
#[derive(Debug, Clone, PartialEq)]
enum FleetResolution {
    /// Exactly one target (either a single match or the caller-scoped winner).
    Unique(McpFleetMember),
    /// A display name matched agents in multiple projects and the caller's own
    /// workspace did not disambiguate — the caller must dispatch by `pane_id`.
    Ambiguous(Vec<McpFleetMember>),
    /// No agent matched the target in the current snapshot.
    NotFound,
}

/// Outcome of a frontend-resolved MCP request. Kept flat so it can carry
/// arbitrary tool responses without type gymnastics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Shared mutable state accessed by HTTP handlers. Updated from the Tauri
/// command layer whenever the frontend pushes a new fleet snapshot.
pub struct McpIpcState {
    secret: String,
    /// Fleet snapshots keyed by the pushing WINDOW's label. All windows share
    /// one MCP IPC server, so a flat `Vec` let a second window's push clobber
    /// the first's (last-writer-wins) — opening/refreshing one window then made
    /// another window's live agents vanish from `lotus_list_fleet`. Keying by
    /// window label lets each window own its slice; `fleet_snapshot()` flattens
    /// them and window-close evicts the closed window's slice.
    fleet: RwLock<HashMap<String, Vec<McpFleetMember>>>,
    canvas_fleet: RwLock<HashMap<String, Vec<McpFleetMember>>>,
    /// Which canvas project each window has mounted right now (ADR-0047 write path). A note write
    /// for a project in this map goes THROUGH that window, so the open editor shows it and the
    /// canvas autosave cannot overwrite it; any other project is written to the store directly.
    /// Unlike `active_workspace_id`, an unmount clears its entry, and window close evicts it.
    note_canvases: RwLock<HashMap<String, String>>,
    /// Every canvas pane this process has been told about, keyed by pane id and
    /// **not** cleared when the board that pushed it goes away.
    ///
    /// `canvas_fleet` above is a per-window bucket that a push replaces wholesale,
    /// and a canvas board only ever holds the project currently on screen — so
    /// switching project unmounts the old project's nodes and its agents vanish
    /// from the fleet while their processes keep running. Measured 2026-08-09:
    /// four live PTY sessions, two of them in a switched-away project, and
    /// `/api/fleet` reported one member. Lotus Pocket read that as `no agents`
    /// for a project that was busy.
    ///
    /// So membership stops being the board's decision. The frontend still owns
    /// *identity* — a pane's name, provider and gating are known nowhere else —
    /// but whether that pane still exists is answered by its PTY session, which
    /// outlives any board. A roster entry is resurrected into a snapshot only
    /// while its session is alive, so this can keep a ghost but never invent one.
    canvas_roster: RwLock<HashMap<String, RosterEntry>>,
    /// Live Swarm Team Terminal members. Combined with CodeSpace/Canvas fleet
    /// snapshots; callers must filter by workspace/surface/team when needed.
    swarm_fleet: RwLock<HashMap<String, Vec<McpFleetMember>>>,
    /// The workspace the operator is actually looking at, as reported by the UI on every fleet
    /// push. `None` until a workspace UI has said so.
    ///
    /// This is what lets `list_fleet` answer "who are MY neighbours?" instead of "who exists
    /// anywhere?". Without it the only workspace clue an agent had was `cwd`, and the tool's own
    /// description warns it never to guess a repo path.
    ///
    /// **Last push wins across windows.** Each window owns its own slice of `fleet` because a
    /// window's cells are unambiguously its own, but "which workspace is active" is a question
    /// about the operator, not about a window, and two windows cannot both be the one being looked
    /// at. Recorded per push so switching workspace — or switching window — moves it immediately.
    active_workspace_id: RwLock<Option<String>>,
    /// Epoch-ms of the last `replace_fleet` push, or `None` if the frontend has
    /// never pushed a snapshot. Drives `snapshot_age_ms` in `list_fleet` and the
    /// fast-fail on spawn/close when no workspace UI is active.
    fleet_pushed_at: RwLock<Option<u64>>,
    /// Epoch-ms of the last push from **any** workspace UI, empty or not.
    ///
    /// Deliberately not the same question as [`fleet_pushed_at`], which answers *when
    /// were cells last reported* and is reset to `None` by a board that reports none.
    /// That reset is right for staleness and was wrong for the spawn guard keyed on it:
    /// a canvas open on a project with no agents pushes `[]`, so starting the **first**
    /// agent was refused with "no active Lotus workspace UI" while the operator was
    /// looking straight at that workspace. Reported from a phone, 2026-08-09.
    ///
    /// This one only ever moves forward: a board announcing itself is a board that can
    /// answer an event, whatever it happens to be showing.
    ui_pushed_at: RwLock<Option<u64>>,
    pty: Option<PtyState>,
    app: RwLock<Option<AppHandle>>,
    task_base: RwLock<Option<PathBuf>>,
    /// Every `emit_to_frontend` in a test, where there is no window to receive it.
    #[cfg(test)]
    emitted: ParkMutex<Vec<(String, serde_json::Value)>>,
    pending: ParkMutex<HashMap<String, oneshot::Sender<PendingResult>>>,
    /// Recent dispatch timestamps (epoch-ms) per target session, for the cross-agent
    /// handoff rate guard — caps runaway/ping-pong dispatch loops at the choke point (Fase 2).
    dispatch_history: ParkMutex<HashMap<String, Vec<u64>>>,
    /// Turn state per pane, pushed by agent-CLI stop hooks (LOTUS_PANE_ID correlation) — the
    /// push signal that lets `wait_for_cell_ready` settle instantly instead of discovering
    /// completion via the 180ms output-quiet heuristic. Value: (status, epoch-ms of the event).
    pane_turns: ParkMutex<HashMap<String, (String, u64)>>,
    /// Verdicts of [`Self::hook_not_from_pane`], keyed by (pane, pane child pid, agent pid), so a
    /// busy agent's tool hooks walk the process table once per [`HOOK_ORIGIN_TTL`], not per event.
    hook_origin_cache: ParkMutex<HookOriginCache>,
    /// The agent session each pane is known to own (pane id → the CLI's own session id), learned
    /// from the first hook the process tree vouched for. See [`Self::hook_belongs_to_pane`].
    pane_sessions: ParkMutex<HashMap<String, String>>,
    /// Wakes in-flight waits the moment a hook turn event lands.
    turn_notify: tokio::sync::Notify,
}

impl Default for McpIpcState {
    fn default() -> Self {
        Self {
            secret: String::new(),
            fleet: RwLock::new(HashMap::new()),
            canvas_fleet: RwLock::new(HashMap::new()),
            note_canvases: RwLock::new(HashMap::new()),
            canvas_roster: RwLock::new(HashMap::new()),
            swarm_fleet: RwLock::new(HashMap::new()),
            active_workspace_id: RwLock::new(None),
            fleet_pushed_at: RwLock::new(None),
            ui_pushed_at: RwLock::new(None),
            pty: None,
            app: RwLock::new(None),
            task_base: RwLock::new(None),
            #[cfg(test)]
            emitted: ParkMutex::new(Vec::new()),
            pending: ParkMutex::new(HashMap::new()),
            dispatch_history: ParkMutex::new(HashMap::new()),
            pane_turns: ParkMutex::new(HashMap::new()),
            hook_origin_cache: ParkMutex::new(HashMap::new()),
            pane_sessions: ParkMutex::new(HashMap::new()),
            turn_notify: tokio::sync::Notify::new(),
        }
    }
}

impl McpIpcState {
    pub fn new(secret: String) -> Self {
        Self {
            secret,
            fleet: RwLock::new(HashMap::new()),
            canvas_fleet: RwLock::new(HashMap::new()),
            note_canvases: RwLock::new(HashMap::new()),
            canvas_roster: RwLock::new(HashMap::new()),
            swarm_fleet: RwLock::new(HashMap::new()),
            active_workspace_id: RwLock::new(None),
            fleet_pushed_at: RwLock::new(None),
            ui_pushed_at: RwLock::new(None),
            pty: None,
            app: RwLock::new(None),
            task_base: RwLock::new(None),
            #[cfg(test)]
            emitted: ParkMutex::new(Vec::new()),
            pending: ParkMutex::new(HashMap::new()),
            dispatch_history: ParkMutex::new(HashMap::new()),
            pane_turns: ParkMutex::new(HashMap::new()),
            hook_origin_cache: ParkMutex::new(HashMap::new()),
            pane_sessions: ParkMutex::new(HashMap::new()),
            turn_notify: tokio::sync::Notify::new(),
        }
    }

    /// Builder-style variant that captures PTY state + Tauri handle so we can
    /// actually fulfil tool calls. In tests we use [`McpIpcState::new`] which
    /// leaves these empty and leaves the endpoints returning descriptive
    /// errors for the paths that need them.
    pub fn with_runtime(secret: String, pty: PtyState) -> Self {
        Self {
            secret,
            fleet: RwLock::new(HashMap::new()),
            canvas_fleet: RwLock::new(HashMap::new()),
            note_canvases: RwLock::new(HashMap::new()),
            canvas_roster: RwLock::new(HashMap::new()),
            swarm_fleet: RwLock::new(HashMap::new()),
            active_workspace_id: RwLock::new(None),
            fleet_pushed_at: RwLock::new(None),
            ui_pushed_at: RwLock::new(None),
            pty: Some(pty),
            app: RwLock::new(None),
            task_base: RwLock::new(None),
            #[cfg(test)]
            emitted: ParkMutex::new(Vec::new()),
            pending: ParkMutex::new(HashMap::new()),
            dispatch_history: ParkMutex::new(HashMap::new()),
            pane_turns: ParkMutex::new(HashMap::new()),
            hook_origin_cache: ParkMutex::new(HashMap::new()),
            pane_sessions: ParkMutex::new(HashMap::new()),
            turn_notify: tokio::sync::Notify::new(),
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app.write() = Some(handle);
    }

    pub(crate) fn app_handle(&self) -> Option<AppHandle> {
        self.app.read().as_ref().cloned()
    }

    #[cfg(test)]
    pub fn set_task_base_for_tests(&self, base: PathBuf) {
        *self.task_base.write() = Some(base);
    }

    #[cfg(test)]
    pub(crate) fn emitted_for_tests(&self) -> Vec<(String, serde_json::Value)> {
        self.emitted.lock().clone()
    }

    pub(crate) fn task_base_override(&self) -> Option<PathBuf> {
        self.task_base.read().clone()
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }

    pub fn replace_fleet(&self, window: &str, next: Vec<McpFleetMember>) {
        set_window_bucket(&self.fleet, window, next);
        *self.fleet_pushed_at.write() = Some(now_ms());
        self.note_ui_push();
    }

    /// Record which workspace the operator is looking at.
    ///
    /// A `None` from the UI does NOT clear a known value: a push can legitimately arrive while no
    /// workspace is selected (cold start, or a window mid-navigation), and forgetting the scope at
    /// that moment would widen `list_fleet` back to every workspace without anyone asking. Only a
    /// real id moves it.
    pub fn set_active_workspace_id(&self, next: Option<String>) {
        let Some(id) = next.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
            return;
        };
        *self.active_workspace_id.write() = Some(id);
    }

    /// The workspace the operator is looking at, or `None` if no UI has said yet.
    pub fn active_workspace_id(&self) -> Option<String> {
        self.active_workspace_id.read().clone()
    }

    /// A workspace UI just spoke. Recorded on every push, including an empty one —
    /// see [`Self::ui_pushed_at`].
    fn note_ui_push(&self) {
        *self.ui_pushed_at.write() = Some(now_ms());
    }

    /// Whether any workspace UI has announced itself since this process started.
    ///
    /// What the spawn and close routes actually need to know: not whether cells exist,
    /// but whether anything is listening for the event they are about to emit.
    pub(crate) fn workspace_ui_seen(&self) -> bool {
        self.ui_pushed_at.read().is_some()
    }

    /// Epoch-ms of the last fleet push, or `None` if never pushed.
    pub fn fleet_pushed_at(&self) -> Option<u64> {
        *self.fleet_pushed_at.read()
    }

    /// Age of the current fleet snapshot in ms, or `None` if no snapshot has
    /// been pushed yet. Push-on-change semantics mean a large age signals "no
    /// recent cell changes", which the caller interprets — not necessarily stale.
    pub fn fleet_snapshot_age_ms(&self) -> Option<u64> {
        self.fleet_pushed_at().map(|t| now_ms().saturating_sub(t))
    }

    pub fn replace_canvas_fleet(&self, window: &str, mut next: Vec<McpFleetMember>) {
        // Before anything is stored: make each member's workspace agree with the project its
        // own pane id names. A board pushes ONE project's identity while the agent registry can
        // hold agents from more than one, so a mis-stamped member is representable at this
        // boundary — and once filed in the roster it is resurrected for as long as its PTY
        // lives, long after the board that mislabelled it is gone.
        let repaired = reconcile_canvas_fleet(&mut next);
        if !repaired.is_empty() {
            note_canvas_identity_repair(window, &repaired);
        }
        // Canvas is often the ONLY active surface, so this push must maintain the
        // `fleet_pushed_at` "a UI is live" signal exactly like `replace_fleet` /
        // `replace_swarm_fleet`. Omitting it left `snapshot_age_ms` permanently null
        // for canvas-only workspaces, breaking the staleness signal and the
        // spawn/dispatch fast-fail guard that keys on it (RC1).
        let is_non_empty = !next.is_empty();
        if fleet_log_enabled() {
            eprintln!(
                "[fleet-push] window={window} canvas received n={} [{}]",
                next.len(),
                summarize_fleet_members(&next),
            );
        }
        // Remember every pane before the bucket is replaced. The push is the only
        // moment identity is on offer, and the board that carries it is about to
        // stop mentioning the panes it no longer shows.
        self.remember_canvas_panes(window, &next);
        set_window_bucket(&self.canvas_fleet, window, next);
        // Unconditional: an empty board is still a board, and it is the only board there
        // is while the operator is starting their first agent.
        self.note_ui_push();
        if is_non_empty {
            *self.fleet_pushed_at.write() = Some(now_ms());
        } else if self.swarm_fleet.read().is_empty()
            && self.fleet.read().is_empty()
            && self.canvas_fleet.read().is_empty()
        {
            *self.fleet_pushed_at.write() = None;
        }
    }

    /// Files the panes a board just reported, and drops the ones whose PTY
    /// session has since ended.
    ///
    /// Only panes the frontend itself called alive are filed. A board that says a
    /// pane is finished is the authority on that — resurrecting it later on the
    /// strength of a still-open shell would put a completed agent back on the
    /// operator's phone.
    ///
    /// Pruning rides on the push rather than on read: [`fleet_snapshot`] is called
    /// from every tool and every HTTP route, and making it take a write lock to
    /// tidy up would put a writer in the path of the hottest read in the process.
    fn remember_canvas_panes(&self, window: &str, members: &[McpFleetMember]) {
        let mut roster = self.canvas_roster.write();
        apply_canvas_push(&mut roster, window, members, |m| self.pane_session_alive(m));
    }

    /// Whether a remembered pane's PTY session is still in the store.
    ///
    /// Without PTY state — the test constructors, and any headless path — nothing
    /// can be verified, so nothing is resurrected. The live buckets still answer
    /// exactly as they did before this roster existed.
    fn pane_session_alive(&self, member: &McpFleetMember) -> bool {
        let (Some(pty), Some(session_id)) = (self.pty.as_ref(), member.session_id.as_deref())
        else {
            return false;
        };
        pty::session_exists(session_id, pty)
    }

    /// A pane was genuinely closed, as opposed to merely scrolled off a board.
    ///
    /// The distinction is the whole point of the roster, so it cannot be inferred
    /// — the frontend has to say which one happened, and it does so here from the
    /// same handler that forgets the pane's durable identity.
    pub fn forget_canvas_cell(&self, pane_id: &str) {
        self.canvas_roster.write().remove(pane_id);
    }

    /// The canvas surface as a whole: the boards that are open, plus the panes
    /// that are still running behind boards that are not.
    ///
    /// A live bucket always wins over the roster for the same pane — it carries
    /// this second's status and output preview, where a roster entry carries
    /// whatever was true when its project was last on screen.
    fn canvas_members(&self) -> Vec<McpFleetMember> {
        compose_canvas_members(
            flatten_window_bucket(&self.canvas_fleet, "canvas"),
            self.canvas_roster
                .read()
                .values()
                .map(|entry| entry.member.clone())
                .collect(),
            |member| self.pane_session_alive(member),
        )
    }

    /// Drop every fleet slice owned by a window — called when that window is
    /// destroyed so its (now-dead) agents stop surfacing in `lotus_list_fleet`.
    /// A closed window's webview cannot push an empty snapshot to clear itself.
    pub fn evict_window_fleet(&self, window: &str) {
        self.note_canvases.write().remove(window);
        self.fleet.write().remove(window);
        self.canvas_fleet.write().remove(window);
        // The roster outlives a *board*, deliberately — but not the window that
        // owned it. Closing a window does not end its PTY sessions, so without
        // this its panes would stay verifiably alive with nothing left to ever
        // update them (see [`RosterEntry`]).
        self.canvas_roster
            .write()
            .retain(|_, entry| entry.window != window);
        let had_swarm = self.swarm_fleet.write().remove(window).is_some();
        if had_swarm
            && self.swarm_fleet.read().is_empty()
            && self.fleet.read().is_empty()
            && self.canvas_fleet.read().is_empty()
        {
            *self.fleet_pushed_at.write() = None;
        }
    }

    /// Record a turn-state event from an agent-CLI stop hook (correlated by LOTUS_PANE_ID) and
    /// wake any in-flight `wait_for_cell_ready` so completion is pushed, not poll-discovered.
    ///
    /// Also pushes the fact to the desktop frontend as `mcp://pane-turn`. This is the ONE choke
    /// point both producers pass through — the `/v1/hook/stop` curl path and the drop-file path
    /// via [`McpTurnSink`] — so emitting here is what makes the canvas see every turn fact
    /// without either caller having to remember to (`plans/honest-agent-status/` Slice 0).
    ///
    /// The emit is best-effort by design: before the window registers its `AppHandle` there is
    /// nobody to tell, and a hook must never fail because the UI is not up yet. A frontend that
    /// starts late hydrates from [`McpIpcState::pane_turns_for`] instead.
    pub fn record_hook_turn(&self, pane_id: &str, status: &str, at_ms: u64) {
        if turn_log_enabled() {
            eprintln!("[pane-turn] pane={pane_id} turn={status} at={at_ms}");
        }
        self.pane_turns
            .lock()
            .insert(pane_id.to_string(), (status.to_string(), at_ms));
        self.turn_notify.notify_waiters();
        let _ = self.emit_to_frontend(
            "mcp://pane-turn",
            serde_json::json!({ "paneId": pane_id, "turn": status, "atMs": at_ms }),
        );
    }

    /// Wraps a pane's output sink so OSC 7501 program status (grok, pi, agy) becomes the pane's
    /// turn fact. No attribution check: these bytes come from the pane's own PTY.
    pub fn program_status_sink(
        self: Arc<Self>,
        pane_id: String,
        mut inner: lotus_pty::OutputSink,
    ) -> lotus_pty::OutputSink {
        use lotus_pty::agent_detect::{AgentDetector, AgentSignal};
        let mut detector = AgentDetector::new();
        let mut last: Option<String> = None;
        Box::new(move |data| {
            detector.observe(&data, |signal| {
                let AgentSignal::ProgramStatus(state) = signal else {
                    return;
                };
                if last.as_deref() != Some(state.as_str()) {
                    self.record_hook_turn(&pane_id, program_status_turn(&state), now_ms());
                    last = Some(state);
                }
            });
            inner(data)
        })
    }

    /// Did a hook event claiming `pane_id` come from some process other than the pane's own
    /// agent? `LOTUS_PANE_ID` is only an env var, and anything started from the pane inherits
    /// it — a nested `claude -p`, or a daemon that outlives the pane's turn and works for every
    /// pane. The process tree is the evidence; see [`nested_stop::hook_not_from_pane`].
    ///
    /// `false` (deliver) whenever the evidence is missing: no agent pid, unresolved pane.
    pub fn hook_not_from_pane(&self, pane_id: &str, agent_pid: Option<u32>) -> bool {
        let Some(agent_pid) = agent_pid else {
            return false;
        };
        let Some(pane_child_pid) = self.resolve_session_id(pane_id).and_then(|sid| {
            let pty = self.pty.as_ref()?;
            pty::session_child_pid(&sid, pty)
        }) else {
            return false;
        };
        let key = (pane_id.to_string(), pane_child_pid, agent_pid);
        if let Some((verdict, at)) = self.hook_origin_cache.lock().get(&key) {
            if at.elapsed() < HOOK_ORIGIN_TTL {
                return *verdict;
            }
        }
        let verdict = nested_stop::hook_not_from_pane(agent_pid, pane_child_pid, &|pid| {
            nested_stop::proc_lookup(pid)
        });
        let mut cache = self.hook_origin_cache.lock();
        cache.retain(|_, (_, at)| at.elapsed() < HOOK_ORIGIN_TTL);
        cache.insert(key, (verdict, Instant::now()));
        verdict
    }

    /// Should a hook event claiming `pane_id` be believed? Every producer goes through here.
    ///
    /// **Session first, process tree second.** A pane's agent session id is stable for the life of
    /// the conversation, whatever process happens to be running it — Claude Code can move a live
    /// session into its own daemon (observed 2026-11-23), and a nested `claude -p` or a foreign
    /// daemon always runs a DIFFERENT session. So once the tree has vouched for one event from a
    /// session, that session's later events are accepted without walking the tree again.
    ///
    /// The tree still decides for a session the pane has not been seen to own (startup, `/clear`,
    /// `/resume`, an app restart that forgot the binding), and a verdict of "own" rebinds. A
    /// payload without a session id gets exactly the old behaviour.
    ///
    /// A rejection is counted in `session-history.jsonl` (`hook_dropped`), because a silent drop is
    /// how a pane once sat on "working" for hours with nobody able to see why.
    pub fn hook_belongs_to_pane(
        &self,
        pane_id: &str,
        agent_pid: Option<u32>,
        session_id: Option<&str>,
    ) -> bool {
        let session_id = session_id.map(str::trim).filter(|s| !s.is_empty());
        if let Some(sid) = session_id {
            if self.pane_sessions.lock().get(pane_id).is_some_and(|owned| owned == sid) {
                return true;
            }
        }
        if self.hook_not_from_pane(pane_id, agent_pid) {
            crate::session_diagnostics::record("hook_dropped", 1, &[("pane", pane_id)]);
            if turn_log_enabled() {
                eprintln!("[pane-turn] dropped pane={pane_id} session={session_id:?} agent_pid={agent_pid:?}");
            }
            return false;
        }
        if let Some(sid) = session_id {
            self.pane_sessions
                .lock()
                .insert(pane_id.to_string(), sid.to_string());
        }
        true
    }

    /// Last hook-reported turn state for a pane: (status, epoch-ms). `None` = no hook has fired
    /// (non-claude-family runner, hook not installed, or pane never correlated).
    pub fn pane_turn(&self, pane_id: &str) -> Option<(String, u64)> {
        self.pane_turns.lock().get(pane_id).cloned()
    }

    /// Turn state for many panes at once, for the desktop frontend's cold hydrate.
    ///
    /// Batched because the canvas asks about every agent node it just mounted, and one IPC
    /// round-trip per node on every board load is the kind of cost that only shows up on a
    /// large board. Panes with no recorded fact are **omitted**, never defaulted: absent means
    /// "no hook has fired", which is a different statement from any status string, and the whole
    /// point of the resolver downstream is that it can tell those apart.
    pub fn pane_turns_for(&self, pane_ids: &[String]) -> Vec<PaneTurnSnapshot> {
        let now = now_ms();
        let turns = self.pane_turns.lock();
        pane_ids
            .iter()
            .filter_map(|pane_id| {
                let (turn, at_ms) = turns.get(pane_id)?;
                Some(PaneTurnSnapshot {
                    pane_id: pane_id.clone(),
                    turn: turn.clone(),
                    turn_age_ms: now.saturating_sub(*at_ms),
                })
            })
            .collect()
    }

    /// Replace the live Swarm Team Terminal fleet. It is combined with the
    /// CodeSpace/Canvas fleets, not treated as a global override.
    pub fn replace_swarm_fleet(&self, window: &str, next: Vec<McpFleetMember>) {
        let is_non_empty = !next.is_empty();
        // `LOTUS_FLEET_LOG=1` records every swarm push, because an EMPTY push replaces the bucket
        // and resets `fleet_pushed_at` — so "fleet: [], snapshot_age_ms: null" cannot be told
        // apart from "nothing was ever pushed" without seeing the pushes themselves.
        //
        // It also goes to `<state dir>/fleet-push.log`, not only to the dev terminal: the
        // question these lines answer ("did ANY push ever carry a session id?") is asked minutes
        // later, by which time the terminal has scrolled or been restarted.
        if fleet_log_enabled() {
            let line = format!(
                "[fleet-push] window={window} swarm n={} [{}]",
                next.len(),
                next.iter()
                    .map(|m| format!(
                        "{}:{}:{}",
                        m.member_id.as_deref().unwrap_or("?"),
                        if m.is_alive { "alive" } else { "dead" },
                        m.session_id.as_deref().unwrap_or("NO-SESSION")
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            eprintln!("{line}");
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(crate::paths::lotus_state_dir().join("fleet-push.log"))
            {
                use std::io::Write;
                let _ = writeln!(file, "{} {}", now_ms(), line);
            }
        }
        set_window_bucket(&self.swarm_fleet, window, next);
        self.note_ui_push();
        if is_non_empty {
            *self.fleet_pushed_at.write() = Some(now_ms());
        } else if self.swarm_fleet.read().is_empty()
            && self.fleet.read().is_empty()
            && self.canvas_fleet.read().is_empty()
        {
            *self.fleet_pushed_at.write() = None;
        }
    }

    pub fn fleet_snapshot(&self) -> Vec<McpFleetMember> {
        // The storage bucket is the AUTHORITATIVE surface — the frontend payload
        // omits the `surface` field for codespace and canvas members (only swarm
        // sets it), so relying on the self-reported field made `list_fleet(surface)`
        // silently drop every codespace/canvas member (RC2). Stamp the surface from
        // the bucket origin here so the filter and the serialized output agree.
        let mut combined = flatten_window_bucket(&self.fleet, "codespace");
        // Not `flatten_window_bucket` for canvas: a board only ever holds the
        // project on screen, so the buckets alone under-report the surface by
        // however many projects are open elsewhere. See [`canvas_members`].
        combined.extend(self.canvas_members());
        combined.extend(flatten_window_bucket(&self.swarm_fleet, "swarm"));
        combined
    }

    fn resolve_session_id(&self, target: &str) -> Option<String> {
        self.fleet_snapshot()
            .into_iter()
            .find(|m| fleet_target_matches(m, target))
            .and_then(|m| m.session_id)
    }

    fn resolve_fleet_member(&self, target: &str) -> Option<McpFleetMember> {
        self.fleet_snapshot()
            .into_iter()
            .find(|m| fleet_target_matches(m, target))
    }

    /// `workspace_id` of the pane with this EXACT `pane_id`, if it is in the
    /// current snapshot. Used to scope a dispatch to the caller's own project.
    fn workspace_of_pane(&self, pane_id: &str) -> Option<String> {
        self.fleet_snapshot()
            .into_iter()
            .find(|m| m.pane_id == pane_id)
            .map(|m| m.workspace_id)
    }

    /// Resolve a dispatch target with project scoping (RC6). A bare display name
    /// ("Kai") can match agents in more than one open project; the flat snapshot
    /// would otherwise pick an arbitrary one. Resolution order:
    ///   1. An exact `pane_id`/`address` hit is unambiguous → [`FleetResolution::Unique`].
    ///   2. A single match → `Unique`.
    ///   3. Multiple name matches → prefer the caller's own workspace (derived from
    ///      `from_pane_id`); if that disambiguates → `Unique`, else `Ambiguous`.
    ///
    /// (06b) A qualified `<workspace>/<name>` address (e.g. "Lotus/claude-1") reaches an
    /// agent in ANY workspace by naming it explicitly, bypassing caller-scoping — see the
    /// pre-filter below. Distinguished from a Swarm v2 address (`@swarm/ws/team/member`,
    /// always 4 segments, always `@`-prefixed) by requiring exactly one `/` and no `@`.
    fn resolve_dispatch_target(&self, target: &str, from_pane_id: Option<&str>) -> FleetResolution {
        // A qualified target names its workspace explicitly, so it must be recognized
        // BEFORE fleet_target_matches runs `target` through normalize_fleet_target below —
        // that pass collapses "/" to "-", so "Lotus/Nara" would otherwise silently degrade
        // into a normalized-string match against some unrelated candidate whose
        // alias/address happens to normalize the same way (06b pitfall #2). Gate on
        // exactly one `/` and no leading `@` so a Swarm v2 address (4 segments, `@`-led)
        // is never mistaken for one (06b pitfall #1).
        let segments: Vec<&str> = target.split('/').collect();
        let qualified = !target.starts_with('@')
            && segments.len() == 2
            && !segments[0].is_empty()
            && !segments[1].is_empty();
        let (search_target, workspace_query) = if qualified {
            (segments[1], Some(normalize_fleet_target(segments[0])))
        } else {
            (target, None)
        };

        let mut matches: Vec<McpFleetMember> = self
            .fleet_snapshot()
            .into_iter()
            .filter(|m| fleet_target_matches(m, search_target))
            .filter(|m| match &workspace_query {
                None => true,
                Some(ws_query) => {
                    let label = m.workspace_label.as_deref().unwrap_or(m.workspace_id.as_str());
                    &normalize_fleet_target(label) == ws_query
                }
            })
            .collect();
        match matches.len() {
            0 => FleetResolution::NotFound,
            1 => FleetResolution::Unique(matches.pop().unwrap()),
            _ => {
                // An exact pane_id / address match is inherently unique — a UUID or
                // fully-qualified address cannot collide the way a display name does.
                if let Some(m) = matches
                    .iter()
                    .find(|m| m.pane_id == target || m.address.as_deref() == Some(target))
                {
                    return FleetResolution::Unique(m.clone());
                }
                // Display-name collision across projects — scope to the caller's own
                // workspace before giving up. Scoping can itself be ambiguous: if MORE
                // THAN ONE candidate shares the caller's workspace, `.find()` would
                // silently pick whichever was registered first (06a). Collect instead —
                // exactly one candidate disambiguates, more than one stays Ambiguous but
                // narrowed to just the caller's own workspace (their neighbours, not the
                // full cross-workspace match set).
                if let Some(caller_ws) = from_pane_id.and_then(|from| self.workspace_of_pane(from))
                {
                    let in_caller_ws: Vec<McpFleetMember> = matches
                        .iter()
                        .filter(|m| m.workspace_id == caller_ws)
                        .cloned()
                        .collect();
                    match in_caller_ws.len() {
                        1 => return FleetResolution::Unique(in_caller_ws.into_iter().next().unwrap()),
                        n if n > 1 => return FleetResolution::Ambiguous(in_caller_ws),
                        _ => {}
                    }
                }
                FleetResolution::Ambiguous(matches)
            }
        }
    }

    /// Provider string (e.g. "codex", "claude", "shell") associated with the
    /// given pane, or `None` if the pane is not in the current snapshot.
    /// Used to pick a provider-aware default wait timeout: agent CLIs like
    /// codex/gemini/opencode/ccs-hss take noticeably longer to render their first
    /// prompt than a plain shell, so the generic 8s default causes frequent
    /// `state="busy"` false negatives.
    fn resolve_provider(&self, pane_id: &str) -> Option<String> {
        self.fleet_snapshot()
            .into_iter()
            .find(|m| m.pane_id == pane_id)
            .map(|m| m.provider)
    }

    /// Reserves a slot for an answer the frontend will hand back.
    ///
    /// `pub(crate)` since 2026-08-09: the mobile façade closes cells through
    /// `api_server`, and panes belong to the workspace UI on that path exactly as they
    /// do on this one. Two copies of the round trip would be two places for the
    /// timeout, the 503 sentence, and the request-id bookkeeping to drift.
    pub(crate) fn register_pending(&self) -> (String, oneshot::Receiver<PendingResult>) {
        let (tx, rx) = oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        self.pending.lock().insert(id.clone(), tx);
        (id, rx)
    }

    /// Drops a slot nobody is going to answer — a timed-out request.
    ///
    /// Named rather than reached into, because `api_server` waits on the same channel
    /// and a leaked sender there would hold its oneshot for the life of the process.
    pub(crate) fn forget_pending(&self, id: &str) {
        self.pending.lock().remove(id);
    }

    pub fn resolve_pending(&self, id: &str, result: PendingResult) -> bool {
        if let Some(tx) = self.pending.lock().remove(id) {
            let _ = tx.send(result);
            true
        } else {
            false
        }
    }

    /// A window says which canvas project it has mounted (`None` = none, e.g. on unmount).
    pub fn set_note_canvas(&self, window: &str, project_id: Option<String>) {
        let mut map = self.note_canvases.write();
        match project_id.map(|id| id.trim().to_string()).filter(|id| !id.is_empty()) {
            Some(id) => {
                map.insert(window.to_string(), id);
            }
            None => {
                map.remove(window);
            }
        }
    }

    /// The window that has `project_id` mounted, if any. With several, the first by label —
    /// stable, so retries hit the same window.
    pub fn note_canvas_window(&self, project_id: &str) -> Option<String> {
        let map = self.note_canvases.read();
        let mut windows: Vec<&String> = map.iter().filter(|(_, p)| p.as_str() == project_id).map(|(w, _)| w).collect();
        windows.sort();
        windows.first().map(|w| w.to_string())
    }

    /// Emit to ONE window, so a note write is applied exactly once even with two windows open.
    pub(crate) fn emit_to_window<S: Serialize + Clone>(&self, window: &str, event: &str, payload: S) -> Result<(), String> {
        let guard = self.app.read();
        let handle = guard.as_ref().ok_or_else(|| "Tauri app handle not registered yet".to_string())?;
        handle.emit_to(window, event, payload).map_err(|e| e.to_string())
    }

    pub(crate) fn emit_to_frontend<S: Serialize + Clone>(
        &self,
        event: &str,
        payload: S,
    ) -> Result<(), String> {
        #[cfg(test)]
        if let Ok(value) = serde_json::to_value(&payload) {
            self.emitted.lock().push((event.to_string(), value));
        }
        let guard = self.app.read();
        let handle = guard
            .as_ref()
            .ok_or_else(|| "Tauri app handle not registered yet".to_string())?;
        handle.emit(event, payload).map_err(|e| e.to_string())
    }
}

pub type SharedState = Arc<McpIpcState>;

fn normalize_fleet_target(value: &str) -> String {
    let mut out = String::new();
    let mut last_was_dash = false;
    for ch in value
        .trim()
        .trim_start_matches('@')
        .to_ascii_lowercase()
        .chars()
    {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn fleet_target_matches(member: &McpFleetMember, target: &str) -> bool {
    let trimmed = target.trim();
    if trimmed.is_empty() {
        return false;
    }
    if member.pane_id == trimmed {
        return true;
    }
    if member.address.as_deref() == Some(trimmed) {
        return true;
    }
    if member.agent_address.as_deref() == Some(trimmed) {
        return true;
    }
    let normalized = normalize_fleet_target(trimmed);
    member
        .address
        .as_deref()
        .is_some_and(|address| normalize_fleet_target(address) == normalized)
        || member
            .agent_address
            .as_deref()
            .is_some_and(|address| normalize_fleet_target(address) == normalized)
        || member
            .aliases
            .iter()
            .chain(member.legacy_aliases.iter())
            .any(|alias| normalize_fleet_target(alias) == normalized)
        || normalize_fleet_target(&member.display_name) == normalized
}

/// OSC 7501 state → the hook `turn` vocabulary the frontend resolver reads.
fn program_status_turn(state: &str) -> &'static str {
    match state {
        "working" => "running",
        "blocked" => "needs-input",
        "error" => "error",
        _ => "idle", // "done" | "idle"
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Set a window's slice of a per-window fleet bucket. An empty push removes the
/// window's key entirely so closed/navigated windows leave no residue — keeping
/// `HashMap::is_empty()` an exact "any live members?" check.
fn set_window_bucket(
    bucket: &RwLock<HashMap<String, Vec<McpFleetMember>>>,
    window: &str,
    next: Vec<McpFleetMember>,
) {
    let mut guard = bucket.write();
    if next.is_empty() {
        guard.remove(window);
    } else {
        guard.insert(window.to_string(), next);
    }
}

/// A remembered canvas pane, and the window whose board reported it.
///
/// The window label is carried so [`McpIpcState::evict_window_fleet`] can reach
/// these entries. A destroyed window's panes are the one case the PTY-liveness
/// rule cannot decide on its own: closing a window does not kill its sessions
/// (only `close_window_sessions`, called on webview reload, does that), so the
/// entries would stay verifiably alive while no board will ever update their
/// status again — frozen at whatever they last said, resurrected forever. That
/// is the ghost this roster is otherwise careful not to create.
#[derive(Clone)]
struct RosterEntry {
    window: String,
    member: McpFleetMember,
}

/// The project a canvas pane id names: `canvas:<project>:<node>`.
///
/// `None` for everything else, and that is the common case rather than an error — a
/// CodeSpace or Swarm pane id carries no project, and a canvas pane launched before its
/// board resolved its project id is the bare node id. Neither can be checked, so neither
/// is touched.
fn canvas_project_of_pane(pane_id: &str) -> Option<&str> {
    let (project, node) = pane_id.strip_prefix("canvas:")?.split_once(':')?;
    (!project.is_empty() && !node.is_empty()).then_some(project)
}

/// Makes one member's workspace agree with the project its own pane id names.
///
/// The pane id is the trustworthy half: it is minted from the agent's own project and
/// travels with it, while `workspace_id`, `workspace_label` and `cwd` are stamped from
/// whichever board happened to send the push. When they disagree, the pane id wins.
///
/// The label and directory are **dropped**, not rewritten: they described a different
/// project, and this layer has no way to look up the right ones. Absent is a state every
/// consumer already handles; wrong is one none of them can detect.
///
/// Returns whether anything was repaired.
fn reconcile_canvas_identity(member: &mut McpFleetMember) -> bool {
    let Some(project) = canvas_project_of_pane(&member.pane_id) else {
        return false;
    };
    let expected = format!("canvas:{project}");
    if member.workspace_id == expected {
        return false;
    }
    member.workspace_id = expected;
    member.workspace_label = None;
    member.cwd = String::new();
    true
}

/// Applies [`reconcile_canvas_identity`] across a push; answers which panes it had to fix.
///
/// Pane ids rather than a count, because the count alone cannot be acted on: the id names
/// both the offending project and the agent, which is what a bug report needs. An empty
/// `Vec` does not allocate, so the normal path pays nothing for it.
fn reconcile_canvas_fleet(members: &mut [McpFleetMember]) -> Vec<String> {
    let mut repaired = Vec::new();
    for member in members.iter_mut() {
        if reconcile_canvas_identity(member) {
            repaired.push(member.pane_id.clone());
        }
    }
    repaired
}

/// Whether the "a push arrived mis-stamped" line has already been printed this process.
static CANVAS_IDENTITY_REPAIR_LOGGED: AtomicBool = AtomicBool::new(false);

/// Reports a repair — once per process unconditionally, then only under `LOTUS_FLEET_LOG`.
///
/// A repair means a producer sent one project's identity on another project's agent, which
/// is a defect worth a breadcrumb in any build. It is also per-push, so logging every one
/// would spam a terminal for as long as the offending board stays open; the first line is
/// what a bug report needs, the rest belong behind the diagnostics flag.
fn note_canvas_identity_repair(window: &str, repaired: &[String]) {
    let first_time = !CANVAS_IDENTITY_REPAIR_LOGGED.swap(true, Ordering::Relaxed);
    if !first_time && !fleet_log_enabled() {
        return;
    }
    eprintln!(
        "[fleet-push] window={window} repaired {} member(s) whose workspace_id disagreed with \
         their pane id ({}); their label and cwd were dropped",
        repaired.len(),
        repaired.join(", "),
    );
}

/// Files a board's push into the durable canvas roster.
///
/// Split from [`McpIpcState::remember_canvas_panes`] so the policy can be tested
/// without a PTY: a `PtySession` owns a real master fd and a live child, so a
/// fake one cannot be built, and a rule that could only be exercised against a
/// running desktop would be a rule nobody checks.
///
/// `alive` is the liveness oracle — in production, "this pane's PTY session is
/// still in the store".
fn apply_canvas_push(
    roster: &mut HashMap<String, RosterEntry>,
    window: &str,
    members: &[McpFleetMember],
    alive: impl Fn(&McpFleetMember) -> bool,
) {
    for member in members {
        // A pane with no session id cannot be verified later, so filing it would
        // create an entry that can never be resurrected and never be pruned.
        if member.is_alive && member.session_id.is_some() {
            roster.insert(
                member.pane_id.clone(),
                RosterEntry {
                    window: window.to_string(),
                    member: member.clone(),
                },
            );
        } else {
            roster.remove(&member.pane_id);
        }
    }
    roster.retain(|_, entry| alive(&entry.member));
}

/// The canvas surface: boards that are open, plus panes still running behind
/// boards that are not.
///
/// Split from [`McpIpcState::canvas_members`] for the same reason as
/// [`apply_canvas_push`].
fn compose_canvas_members(
    mut on_screen: Vec<McpFleetMember>,
    roster: Vec<McpFleetMember>,
    alive: impl Fn(&McpFleetMember) -> bool,
) -> Vec<McpFleetMember> {
    let drawn: HashSet<&str> = on_screen.iter().map(|m| m.pane_id.as_str()).collect();

    let offscreen: Vec<McpFleetMember> = roster
        .iter()
        // A board that is open is this second's truth about its own panes; the
        // roster holds whatever was true when that project was last on screen.
        .filter(|member| !drawn.contains(member.pane_id.as_str()))
        .filter(|member| alive(member))
        .cloned()
        .map(|mut member| {
            if member.surface.is_none() {
                member.surface = Some("canvas".to_string());
            }
            member
        })
        .collect();

    on_screen.extend(offscreen);
    on_screen
}

/// Flatten a per-window fleet bucket into one combined member list, stamping
/// `default_surface` on any member that did not carry its own `surface` (the
/// bucket origin is authoritative — see [`McpIpcState::fleet_snapshot`]).
fn flatten_window_bucket(
    bucket: &RwLock<HashMap<String, Vec<McpFleetMember>>>,
    default_surface: &str,
) -> Vec<McpFleetMember> {
    bucket
        .read()
        .values()
        .flat_map(|members| members.iter().cloned())
        .map(|mut member| {
            if member.surface.is_none() {
                member.surface = Some(default_surface.to_string());
            }
            member
        })
        .collect()
}

/// Cross-agent handoff rate guard (Fase 2). Caps how many dispatches one target session may
/// receive within a sliding window — a runaway A→B→A ping-pong or fan-out trips this at the
/// MCP-IPC choke point. Pure + deterministic so it is unit-testable.
/// (pane id, pane child pid, agent pid) → (verdict, when it was decided).
type HookOriginCache = HashMap<(String, u32, u32), (bool, Instant)>;

/// How long a hook-origin verdict is reused. Bounds both the `ps` walks of a busy agent and the
/// window in which a reused pid could inherit a stale verdict.
const HOOK_ORIGIN_TTL: Duration = Duration::from_secs(60);
const DISPATCH_WINDOW_MS: u64 = 20_000;
const DISPATCH_LIMIT: usize = 6;
const CODECANVAS_COLLABORATION_RECORD_UPDATED_EVENT: &str =
    "codecanvas://collaboration-record-updated";

fn dispatches_in_window(times_ms: &[u64], now_ms: u64, window_ms: u64) -> usize {
    times_ms
        .iter()
        .filter(|&&t| now_ms.saturating_sub(t) < window_ms)
        .count()
}

pub fn generate_secret() -> String {
    let mut buf = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut buf);
    hex::encode(buf)
}

/// Handle returned from [`start_mcp_ipc`]. Drop or call [`McpIpcHandle::shutdown`]
/// to stop the server.
pub struct McpIpcHandle {
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    join: Option<tokio::task::JoinHandle<()>>,
}

impl McpIpcHandle {
    pub async fn shutdown(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(handle) = self.join.take() {
            let _ = handle.await;
        }
    }
}

/// Spawn the HTTP server on a random localhost port. Returns a handle that
/// carries the actual bound port (so callers can serialize it to the IPC
/// discovery file).
pub async fn start_mcp_ipc(state: SharedState) -> std::io::Result<McpIpcHandle> {
    let app = router(state);
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
    let port = listener.local_addr()?.port();

    let (tx, rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = rx.await;
            })
            .await;
        if let Err(err) = result {
            eprintln!("[mcp-ipc] server exited with error: {err:?}");
        }
    });

    Ok(McpIpcHandle {
        port,
        shutdown: Some(tx),
        join: Some(join),
    })
}

fn router(state: SharedState) -> Router {
    Router::new()
        .route("/v1/ping", post(ping))
        .route("/v1/list-fleet", post(list_fleet))
        .route("/v1/dispatch-to-cell", post(dispatch_to_cell))
        .route("/v1/read-cell-output", post(read_cell_output))
        .route("/v1/chat-read", post(chat_read))
        .route("/v1/chat-delegate", post(chat_delegate))
        .route("/v1/chat-wait", post(chat_wait))
        .route("/v1/chat-stop", post(chat_stop))
        .route("/v1/chat-child", post(chat_child))
        .route("/v1/chat-list", post(chat_list))
        .route("/v1/chat-manage", post(chat_manage))
        .route("/v1/spawn-cell", post(spawn_cell))
        .route("/v1/close-cell", post(close_cell))
        .route("/v1/canvas-control", post(canvas_control))
        .route("/v1/canvas-draw", post(canvas_draw))
        .route("/v1/canvas-read-shapes", post(canvas_read_shapes))
        .route("/v1/canvas-collaboration", post(canvas_collaboration))
        .route(
            "/v1/canvas-memory",
            post(crate::mcp_canvas_memory::canvas_memory),
        )
        .route("/v1/notes", post(crate::mcp_notes::notes))
        .route("/v1/factory/save-spec", post(crate::mcp_factory::save_spec))
        .route("/v1/wait-cell-idle", post(wait_cell_idle))
        .route("/v1/ensure-fleet", post(ensure_fleet))
        .route("/v1/gather-results", post(gather_results))
        .route("/v1/canvas-themes/save", post(save_canvas_theme_ipc))
        .route("/v1/tasks/create", post(create_bridge_task))
        .route("/v1/tasks/update", post(update_bridge_task))
        .route(
            "/v1/tasks/append-feedback-event",
            post(append_bridge_task_feedback_event),
        )
        .route("/v1/tasks/list", post(list_bridge_tasks))
        .route("/v1/tasks/get", post(get_bridge_task))
        .route("/v1/automation", post(crate::mcp_automation::automation))
        .route("/v1/automation-submit", post(crate::mcp_automation::automation_submit))
        .route("/v1/github-read", post(crate::mcp_automation::github_read))
        .route("/v1/notion-read", post(crate::mcp_automation::notion_read))
        .route("/v1/hook/stop", post(hook_stop))
        .with_state(state)
}

#[allow(clippy::result_large_err)] // Response is the standard axum return type for early-exit auth.
pub(crate) fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), Response> {
    let header = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "missing authorization").into_response())?;
    let token = header
        .strip_prefix("Bearer ")
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, "bad scheme").into_response())?;
    if token != expected {
        return Err((StatusCode::UNAUTHORIZED, "bad token").into_response());
    }
    Ok(())
}

/// The camelCase aliases are not cosmetic. The MCP tool schema this endpoint backs declares its
/// inputs as `workspaceId` / `teamId` (see `lotus_list_fleet` in `scripts/lotus-mcp-server.mjs`),
/// and the sidecar translates them to snake_case on the way through — so anything that talks to
/// `/v1/list-fleet` directly, reading the tool schema as its guide, naturally sends the camelCase
/// spelling. Serde ignores unknown fields here, so such a request used to come back `200` with the
/// FULL fleet and no sign that the filter had been dropped: a silently unscoped answer, which is
/// worse than a loud rejection. Measured 2026-09-12: `{"workspaceId": "<real id>"}` returned every
/// member, while `{"workspace_id": "nope"}` correctly returned none.
///
/// Accepting both spellings is additive — nothing that worked before stops working.
#[derive(Deserialize, Default)]
struct ListFleetRequest {
    #[serde(default, alias = "workspaceId")]
    workspace_id: Option<String>,
    #[serde(default)]
    surface: Option<String>,
    #[serde(default, alias = "teamId")]
    team_id: Option<String>,
    /// `"active"` (the default) or `"all"`. Narrowing is the default because "who are my
    /// neighbours?" is the question almost every caller means; widening has to be asked for, and
    /// is always reported back so the narrowing is visible rather than silent.
    #[serde(default)]
    scope: Option<String>,
    /// The caller's own pane (`LOTUS_PANE_ID`). The default scope is the caller's workspace, not
    /// the one on screen: an agent in project A asked while the user looks at project B used to
    /// get B's agents, whose names and agent addresses (`claude-2`) repeat A's.
    #[serde(default, alias = "fromPaneId")]
    from_pane_id: Option<String>,
    /// When true, return the full `McpFleetMember` shape including display_name
    /// and session_id. When false or omitted (default), return a compact
    /// projection with the fields the planner needs most often — `pane_id`,
    /// `workspace_id`, `cwd`, `provider`, `status`, `is_alive`, and
    /// `last_output_preview`. Keeping cwd in compact mode prevents agents from
    /// inventing relative repo paths after listing the fleet.
    #[serde(default)]
    verbose: bool,
}

#[derive(Serialize)]
struct PingResponse {
    ok: bool,
    service: &'static str,
}

async fn ping(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    Json(PingResponse {
        ok: true,
        service: "lotus-mcp",
    })
    .into_response()
}

/// How long list_fleet waits for the UI to re-push after an empty-result refresh request (6.4).
/// Short enough not to stall a genuinely-empty listing noticeably; long enough for the frontend's
/// forcePush round-trip (mcp://request-fleet-refresh → bridgePushCanvasFleetSnapshot).
const FLEET_PULL_ON_MISS_WAIT_MS: u64 = 150;

/// Opt-in fleet diagnostics to the `tauri dev` terminal — set `LOTUS_FLEET_LOG=1` before launch.
/// Logs member NAMES + pane_ids + alive flags only (no secrets/prompts; Phase 7.4 contract holds).
fn fleet_log_enabled() -> bool {
    std::env::var_os("LOTUS_FLEET_LOG").is_some()
}

/// `LOTUS_TURN_LOG=1` prints every hook turn fact as it is recorded, to the Rust dev terminal.
///
/// This exists to make **pane-id correlation** observable, which is the one failure mode of
/// `plans/honest-agent-status/` that produces silence rather than an error: the store is keyed by
/// the `LOTUS_PANE_ID` the hook exported, and the canvas queries it with
/// `canvasRuntimePaneId(projectId, nodeId)`. If those two strings ever diverge, every downstream
/// slice looks built and green while showing nothing at all. One line per fact is what lets an
/// operator compare the key against the node's `hookPaneId` without adding a manual step.
///
/// Every fact is logged, not one line per pane: the sequence (`running` → `needs-input` → `idle`)
/// is the diagnostic, and turn facts arrive a handful of times per turn — nothing like PTY byte
/// volume — so the log stays readable. It is env-gated, so the cost is opt-in either way.
fn turn_log_enabled() -> bool {
    std::env::var_os("LOTUS_TURN_LOG").is_some()
}

fn summarize_fleet_members(members: &[McpFleetMember]) -> String {
    if members.is_empty() {
        return "<empty>".to_string();
    }
    members
        .iter()
        .map(|m| {
            format!(
                "{}(pane={} ws={} alive={} status={})",
                m.display_name, m.pane_id, m.workspace_id, m.is_alive, m.status
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Stamp a fleet member's hook-reported turn onto its projected JSON, when a hook has fired.
///
/// Shared by BOTH `list_fleet` projections on purpose. They diverged once — compact injected the
/// turn and verbose did not, because verbose serializes the struct and the struct has no such field
/// — and the fix has to be a single call site or the next projection added will diverge the same way.
///
/// Absent stays absent: no entry means no hook has fired for this pane, which the fleet contract
/// reads as "this host cannot say". A default would be a confident answer nobody has.
fn attach_pane_turn(state: &SharedState, pane_id: &str, obj: &mut serde_json::Value) {
    if let Some((turn, at_ms)) = state.pane_turn(pane_id) {
        obj["turn"] = serde_json::Value::String(turn);
        obj["turn_age_ms"] = serde_json::Value::Number(now_ms().saturating_sub(at_ms).into());
    }
}

/// Why the body is `Result<_, JsonRejection>` and not `Option<Json<_>>`.
///
/// `Option<Json<T>>` swallows EVERY body failure into `None`, and `None` here meant "no filters,
/// not verbose, HTTP 200". So a caller who got the shape slightly wrong was told nothing and
/// handed the whole fleet. Measured on the dev IPC, 2026-09-12:
///
/// ```text
/// {"verbose":"true"}  (wrong type)      -> 200, verbose silently OFF
/// {"verbose":            (broken JSON)  -> 200
/// {"workspace_id":"nope"} no content-type -> 200 with n=2, where the filter says n=0
/// ```
///
/// The last one is the sharp edge: a perfect payload, one missing header, and every filter
/// evaporates without a symptom. This endpoint is the scoping mechanism agents rely on to know
/// who their neighbours are — a filter that fails OPEN and silent is not a filter.
///
/// Blast radius is zero: every real client goes through `postToLotus` in
/// `scripts/lotus-mcp-server.mjs`, which always sends `content-type: application/json` and
/// `JSON.stringify(body ?? {})` — valid JSON, never malformed. `packages/host` serves its own
/// TypeScript `/v1/list-fleet` (`app.ts:231`); that is a different server and is untouched by this.
///
/// Every rejection is mapped to 400 deliberately, including a missing/foreign content-type, which
/// axum would otherwise answer 415. One shape of complaint is easier to act on than three, and 415
/// reads as "wrong endpoint" when the real answer is "your body did not arrive".
/// Say what this reply is scoped to, and what that scope hid — on BOTH projections, via one call
/// site, because the `turn` and `headline` fields each drifted between compact and verbose exactly
/// once by being stamped in two places.
///
/// A narrowed list that does not announce its narrowing is indistinguishable from a complete one.
/// That is the whole reason the default may narrow at all: an agent that sees `hidden_count: 6`
/// knows to ask for `scope: "all"`, whereas an agent handed six fewer teammates with no note
/// concludes they do not exist.
fn attach_scope(
    body: &mut serde_json::Value,
    scope_label: &str,
    active_workspace_id: Option<&str>,
    hidden_count: usize,
    hidden_workspace_count: usize,
) {
    body["scope"] = serde_json::Value::String(scope_label.to_string());
    if let Some(active) = active_workspace_id {
        body["active_workspace_id"] = serde_json::Value::String(active.to_string());
    }
    if hidden_count > 0 {
        body["hidden_count"] = serde_json::Value::Number(hidden_count.into());
        body["hidden_workspace_count"] = serde_json::Value::Number(hidden_workspace_count.into());
        body["scope_note"] = serde_json::Value::String(format!(
            "{hidden_count} cell(s) in {hidden_workspace_count} other workspace(s) are not listed; \
             pass scope=\"all\" to include them"
        ));
    }
    if scope_label == "unknown" {
        body["scope_note"] = serde_json::Value::String(
            "No workspace UI has reported an active workspace yet, so this lists EVERY workspace. \
             This is NOT a scoped answer."
                .to_string(),
        );
    }
}

async fn list_fleet(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Result<Json<ListFleetRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let req = match body {
        Ok(Json(req)) => req,
        Err(rejection) => {
            return (
                StatusCode::BAD_REQUEST,
                format!(
                    "list-fleet body must be a JSON object sent with content-type: application/json ({})",
                    rejection.body_text()
                ),
            )
                .into_response();
        }
    };
    let (surface_filter, team_filter, verbose) = (req.surface, req.team_id, req.verbose);

    // Resolve the workspace scope BEFORE filtering, so the reply can say what it narrowed to and
    // what that cost. Precedence, most explicit first:
    //   1. An explicit `workspace_id` always wins — the caller named a workspace, answer about it.
    //   2. `scope: "all"` — the caller asked to see everything.
    //   3. Default: the active workspace, if a UI has told us one.
    //   4. No active workspace known yet: return EVERYTHING and say the scope is unknown. An empty
    //      list here would read as "you have no teammates", which is a lie told confidently — the
    //      same failure `snapshot_age_ms: null` exists to avoid.
    let requested_scope = req.scope.as_deref().map(str::trim).unwrap_or("active");
    let active_workspace = state.active_workspace_id();
    let own_workspace = req
        .from_pane_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .and_then(|id| state.workspace_of_pane(id));
    let (workspace_filter, scope_label) = match (req.workspace_id, requested_scope) {
        (Some(explicit), _) => (Some(explicit), "explicit"),
        (None, "all") => (None, "all"),
        (None, _) => match (own_workspace, active_workspace.clone()) {
            (Some(own), _) => (Some(own), "own"),
            (None, Some(active)) => (Some(active), "active"),
            (None, None) => (None, "unknown"),
        },
    };
    let filter_members = |fleet: Vec<McpFleetMember>| -> Vec<McpFleetMember> {
        fleet
            .into_iter()
            .filter(|m| {
                workspace_filter
                    .as_ref()
                    .is_none_or(|ws| &m.workspace_id == ws)
            })
            .filter(|m| {
                surface_filter
                    .as_ref()
                    .is_none_or(|surface| m.surface.as_deref() == Some(surface.as_str()))
            })
            .filter(|m| {
                team_filter
                    .as_ref()
                    .is_none_or(|team| m.team_id.as_deref() == Some(team.as_str()))
            })
            .collect()
    };
    let mut filtered = filter_members(state.fleet_snapshot());
    let mut snapshot_age_ms = state.fleet_snapshot_age_ms();

    // 6.4 pull-on-miss: an empty result while a UI has pushed before is often a stale/missed
    // snapshot — e.g. a just-spawned agent whose first push hasn't landed, so the caller would
    // wrongly conclude "no teammates here". Ask the UI to re-push NOW, wait briefly, and re-read
    // once. Gated on `fleet_pushed_at().is_some()` so we never wait when no UI has ever pushed
    // (nothing would answer). The emit is best-effort (no app handle in headless/tests). A
    // genuinely empty canvas just pays one short wait and still returns empty — never a hang.
    if filtered.is_empty() && state.fleet_pushed_at().is_some() {
        let _ = state.emit_to_frontend(
            "mcp://request-fleet-refresh",
            serde_json::json!({ "reason": "list_fleet_empty" }),
        );
        tokio::time::sleep(std::time::Duration::from_millis(FLEET_PULL_ON_MISS_WAIT_MS)).await;
        filtered = filter_members(state.fleet_snapshot());
        snapshot_age_ms = state.fleet_snapshot_age_ms();
    }
    // What the narrowing COST, measured against the same surface/team filters so the number means
    // "peers you did not see", not "rows in the process". A hidden count nobody is told is exactly
    // the silent narrowing this slice exists to prevent.
    let (hidden_count, hidden_workspace_count) = if workspace_filter.is_some() {
        let shown: std::collections::HashSet<&str> =
            filtered.iter().map(|m| m.workspace_id.as_str()).collect();
        let everything = state.fleet_snapshot();
        let siblings: Vec<&McpFleetMember> = everything
            .iter()
            .filter(|m| {
                surface_filter
                    .as_ref()
                    .is_none_or(|surface| m.surface.as_deref() == Some(surface.as_str()))
            })
            .filter(|m| {
                team_filter
                    .as_ref()
                    .is_none_or(|team| m.team_id.as_deref() == Some(team.as_str()))
            })
            .filter(|m| !shown.contains(m.workspace_id.as_str()))
            .collect();
        let workspaces: std::collections::HashSet<&str> =
            siblings.iter().map(|m| m.workspace_id.as_str()).collect();
        (siblings.len(), workspaces.len())
    } else {
        (0, 0)
    };

    // The frontend no longer sends `last_output_preview` (it changed on every output chunk and
    // re-pushed the whole fleet ~1.6/s); the PTY ring on this side has the same bytes.
    if let Some(pty) = state.pty.as_ref() {
        for m in filtered.iter_mut().filter(|m| m.last_output_preview.is_none()) {
            if let Some(sid) = m.session_id.as_deref() {
                m.last_output_preview = crate::api_server::handlers::fleet::tail_preview(pty, sid);
            }
        }
    }

    if fleet_log_enabled() {
        eprintln!(
            "[fleet-list] filters(ws={:?} surface={:?} team={:?}) age={:?}ms returning n={} [{}]",
            workspace_filter,
            surface_filter,
            team_filter,
            snapshot_age_ms,
            filtered.len(),
            summarize_fleet_members(&filtered),
        );
    }
    if verbose {
        // `filtered` is serialized straight from `McpFleetMember`, which carries no turn — the
        // authoritative value lives in `pane_turns`, not on the pushed snapshot. Without this the
        // verbose reply was the one projection with no turn state at all, so a caller asking for
        // MORE detail got LESS truth (observed live 2026-08-25). Same helper as compact, so the two
        // cannot drift apart again.
        let detailed: Vec<serde_json::Value> = filtered
            .iter()
            .map(|m| {
                let mut obj = serde_json::to_value(m).unwrap_or_else(|_| serde_json::json!({}));
                attach_pane_turn(&state, &m.pane_id, &mut obj);
                obj
            })
            .collect();
        let mut body = serde_json::json!({ "fleet": detailed, "snapshot_age_ms": snapshot_age_ms });
        attach_scope(
            &mut body,
            scope_label,
            active_workspace.as_deref(),
            hidden_count,
            hidden_workspace_count,
        );
        Json(body).into_response()
    } else {
        let compact: Vec<serde_json::Value> = filtered
            .iter()
            .map(|m| {
                let mut obj = serde_json::json!({
                    "pane_id": m.pane_id,
                    // The capability prompt tells agents to "dispatch by name", so the
                    // default (compact) response MUST carry the name — otherwise the
                    // agent addresses a peer it was never shown, and cannot detect a
                    // cross-project name collision (RC6 / F5b).
                    "display_name": m.display_name,
                    "workspace_id": m.workspace_id,
                    "cwd": m.cwd,
                    "provider": m.provider,
                    "status": m.status,
                    "is_alive": m.is_alive,
                });
                // In COMPACT too, for the same parity reason `headline` is: compact is what a
                // dispatching agent reads, and the readable address is precisely the field it
                // needs to name a peer. Verbose gets it for free by serializing the struct.
                if let Some(agent_address) = &m.agent_address {
                    obj["agent_address"] = serde_json::Value::String(agent_address.clone());
                }
                if let Some(preview) = &m.last_output_preview {
                    obj["last_output_preview"] = serde_json::Value::String(preview.clone());
                }
                // In COMPACT too, not only verbose. Compact is what a dispatching agent actually
                // reads, and "what is this peer working on" is the question it is asking; a field
                // present only in the detailed reply would be missing exactly where it is needed.
                // Verbose gets it for free by serializing the struct — the inverse of the `turn`
                // parity gap, where the hand-built compact projection was the one that had it.
                if let Some(headline) = &m.headline {
                    obj["headline"] = serde_json::Value::String(headline.clone());
                }
                if let Some(surface) = &m.surface {
                    obj["surface"] = serde_json::Value::String(surface.clone());
                }
                if let Some(runtime_id) = &m.runtime_id {
                    obj["runtime_id"] = serde_json::Value::String(runtime_id.clone());
                }
                if let Some(team_id) = &m.team_id {
                    obj["team_id"] = serde_json::Value::String(team_id.clone());
                }
                if let Some(member_id) = &m.member_id {
                    obj["member_id"] = serde_json::Value::String(member_id.clone());
                }
                if let Some(address) = &m.address {
                    obj["address"] = serde_json::Value::String(address.clone());
                }
                if let Some(workspace_label) = &m.workspace_label {
                    obj["workspace_label"] = serde_json::Value::String(workspace_label.clone());
                }
                if let Some(version) = m.fleet_schema_version {
                    obj["fleet_schema_version"] = serde_json::Value::Number(version.into());
                }
                // Phase 4 capability truth — present only when the frontend reported it, so a lead
                // agent can route (reachable now / queueable / MCP-capable) without a verbose fetch.
                if let Some(can_reply) = m.can_reply {
                    obj["can_reply"] = serde_json::Value::Bool(can_reply);
                }
                if let Some(can_queue) = m.can_queue {
                    obj["can_queue"] = serde_json::Value::Bool(can_queue);
                }
                if let Some(mcp_tools_available) = m.mcp_tools_available {
                    obj["mcp_tools_available"] = serde_json::Value::Bool(mcp_tools_available);
                }
                if let Some(gating) = &m.gating {
                    obj["gating"] = serde_json::Value::String(gating.clone());
                }
                // Turn-accurate state from the agent's stop hook (when one has fired): the
                // launch-phase `status` says "live" even while idle at the prompt; `turn`
                // says what the agent is actually doing this turn.
                attach_pane_turn(&state, &m.pane_id, &mut obj);
                obj
            })
            .collect();
        let mut body = serde_json::json!({ "fleet": compact, "snapshot_age_ms": snapshot_age_ms });
        attach_scope(
            &mut body,
            scope_label,
            active_workspace.as_deref(),
            hidden_count,
            hidden_workspace_count,
        );
        Json(body).into_response()
    }
}

#[derive(Deserialize)]
struct CreateBridgeTaskRequest {
    workspace_id: String,
    title: String,
    goal: String,
    #[serde(default)]
    knowledge: Option<String>,
    #[serde(default)]
    assignees: Vec<String>,
    #[serde(default)]
    status: Option<crate::bridge_tasks::BridgeTaskStatus>,
}

#[derive(Deserialize)]
struct UpdateBridgeTaskRequest {
    workspace_id: String,
    task_id: String,
    #[serde(default)]
    patch: crate::bridge_tasks::UpdateBridgeTaskPatch,
}

#[derive(Deserialize, Default)]
struct ListBridgeTasksRequest {
    workspace_id: String,
    #[serde(default)]
    status: Option<crate::bridge_tasks::BridgeTaskStatus>,
    #[serde(default)]
    assignee: Option<String>,
}

#[derive(Deserialize)]
struct GetBridgeTaskRequest {
    workspace_id: String,
    task_id: String,
}

#[derive(Deserialize)]
struct AppendBridgeTaskFeedbackEventRequest {
    workspace_id: String,
    task_id: String,
    event: crate::bridge_task_feedback::BridgeTaskFeedbackEvent,
}

/// Tells the desktop a task changed OUTSIDE it: these three routes and the REST task routes
/// (`api_server/handlers/tasks.rs`, an agent's `curl`) are how agents write, and the tracker
/// otherwise only learned of it when somebody pressed Refresh. The UI's own writes go
/// through Tauri commands and never reach here, so it does not hear its own edits echoed back.
const TASKS_CHANGED_EVENT: &str = "tasks://changed";

pub(crate) fn announce_task_changed(state: &SharedState, task: &crate::bridge_tasks::BridgeTask) {
    // No window yet (tests, early boot) is not an error: there is nobody to tell.
    let _ = state.emit_to_frontend(
        TASKS_CHANGED_EVENT,
        serde_json::json!({ "workspaceId": task.workspace_id, "taskId": task.id }),
    );
}

fn task_error_response(err: crate::bridge_tasks::BridgeTaskError) -> Response {
    let status = match &err {
        crate::bridge_tasks::BridgeTaskError::NotFound(_) => StatusCode::NOT_FOUND,
        crate::bridge_tasks::BridgeTaskError::Persist(_) => StatusCode::INTERNAL_SERVER_ERROR,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, err.to_string()).into_response()
}

// CodeCanvas Artisan Theme Engine (ADR-0023, Phase 3): the `lotus_save_canvas_theme`
// MCP tool round-trips here. Validation failures come back as ok:false data so the
// agent can correct; only genuine IO errors are a 500.
async fn save_canvas_theme_ipc(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(spec): Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    match crate::canvas_themes::save_canvas_theme(spec) {
        Ok(result) => Json(result).into_response(),
        Err(err) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "ok": false, "errors": [err.to_string()] })),
        )
            .into_response(),
    }
}

async fn create_bridge_task(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<CreateBridgeTaskRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let input = crate::bridge_tasks::CreateBridgeTaskInput {
        workspace_id: req.workspace_id,
        team_id: None,
        title: req.title,
        goal: req.goal,
        knowledge: req.knowledge,
        assignees: req.assignees,
        status: req.status,
        priority: None,
        subtasks: vec![],
        due_date: None,
            // An MCP-created task starts here, so it has no elsewhere to point at.
        source: None,
};
    let result = match state.task_base_override() {
        Some(base) => crate::bridge_tasks::create_task_in(&base, input),
        None => crate::bridge_tasks::create_task(input),
    };
    match result {
        Ok(task) => {
            announce_task_changed(&state, &task);
            Json(serde_json::json!({ "ok": true, "task": task })).into_response()
        }
        Err(err) => task_error_response(err),
    }
}

async fn update_bridge_task(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<UpdateBridgeTaskRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let result = match state.task_base_override() {
        Some(base) => {
            crate::bridge_tasks::update_task_in(&base, &req.workspace_id, &req.task_id, req.patch)
        }
        None => crate::bridge_tasks::update_task(&req.workspace_id, &req.task_id, req.patch),
    };
    match result {
        Ok(task) => {
            announce_task_changed(&state, &task);
            Json(serde_json::json!({ "ok": true, "task": task })).into_response()
        }
        Err(err) => task_error_response(err),
    }
}

async fn append_bridge_task_feedback_event(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<AppendBridgeTaskFeedbackEventRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let result = match state.task_base_override() {
        Some(base) => crate::bridge_tasks::append_feedback_event_in(
            &base,
            &req.workspace_id,
            &req.task_id,
            req.event,
        ),
        None => {
            crate::bridge_tasks::append_feedback_event(&req.workspace_id, &req.task_id, req.event)
        }
    };
    match result {
        Ok(task) => {
            announce_task_changed(&state, &task);
            Json(serde_json::json!({ "ok": true, "task": task })).into_response()
        }
        Err(err) => task_error_response(err),
    }
}

async fn list_bridge_tasks(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<ListBridgeTasksRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let filter = crate::bridge_tasks::TaskListFilter {
        status: req.status,
        assignee: req.assignee,
    };
    let result = match state.task_base_override() {
        Some(base) => crate::bridge_tasks::list_tasks_in(&base, &req.workspace_id, filter),
        None => crate::bridge_tasks::list_tasks(&req.workspace_id, filter),
    };
    match result {
        Ok(tasks) => Json(serde_json::json!({ "ok": true, "tasks": tasks })).into_response(),
        Err(err) => task_error_response(err),
    }
}

async fn get_bridge_task(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<GetBridgeTaskRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let result = match state.task_base_override() {
        Some(base) => crate::bridge_tasks::get_task_in(&base, &req.workspace_id, &req.task_id),
        None => crate::bridge_tasks::get_task(&req.workspace_id, &req.task_id),
    };
    match result {
        Ok(Some(task)) => Json(serde_json::json!({ "ok": true, "task": task })).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            format!("task not found: {}", req.task_id),
        )
            .into_response(),
        Err(err) => task_error_response(err),
    }
}

#[derive(Deserialize)]
struct DispatchRequest {
    pane_id: String,
    /// The CALLER's own pane id (from the sidecar's `LOTUS_PANE_ID`), used to
    /// scope a bare display-name target to the caller's project when the same
    /// name exists in more than one open project (RC6). Optional — absent for
    /// non-canvas callers or older sidecars.
    #[serde(default)]
    from_pane_id: Option<String>,
    command: String,
    #[serde(default = "default_true")]
    append_newline: bool,
    #[serde(default)]
    enter_key: Option<String>,
    #[serde(default)]
    submit_after_paste: Option<bool>,
    #[serde(default)]
    submit_delay_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpTerminalInputPayload {
    pane_id: String,
    workspace_id: String,
    data: String,
    origin: String,
    intent: String,
    submitted: bool,
    prompt_text: String,
}

fn default_true() -> bool {
    true
}

fn strip_trailing_line_ending(mut command: String) -> String {
    if command.ends_with("\r\n") {
        command.truncate(command.len().saturating_sub(2));
    } else if command.ends_with('\n') || command.ends_with('\r') {
        command.pop();
    }
    command
}

fn build_dispatch_payload(
    command: String,
    append_newline: bool,
    enter_key: Option<&str>,
) -> String {
    if !append_newline {
        return command;
    }
    let line_ending = match enter_key {
        Some("lf") => "\n",
        _ => "\r",
    };
    let mut command = strip_trailing_line_ending(command);
    command.push_str(line_ending);
    command
}

/// How a dispatch reaches the PTY: what to write, and whether to pause mid-way.
///
/// `pub(crate)` because `/api/fleet/dispatch` builds the same plan. It used to push a
/// bare `\n` of its own, which a TUI agent leaves sitting in its prompt buffer
/// unsubmitted — measured against a live Claude Code cell on 2026-08-06, where a
/// single `\r` afterwards submitted the text that had been waiting. Two
/// implementations of "submit to a cell" is how one of them stays wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DispatchWritePlan {
    pub(crate) writes: Vec<String>,
    pub(crate) delay_before_submit_ms: u64,
    pub(crate) bytes: usize,
}

/// Whether this target is a full-screen TUI agent, and therefore needs its submit key
/// as a separate write.
///
/// **The surface used to be part of this test, and that was the bug.** It required
/// `surface == "swarm"`, so a canvas cell — which is the surface Lotus Pocket
/// dispatches into, and the one ADR-0024 made the default for every agent — fell
/// through to a single write carrying both the text and the CR.
///
/// Measured against a live Claude Code cell on 2026-08-07: an 88-character prompt sent
/// from the phone arrived intact and sat unsubmitted at `❯`, and a single bare `\r`
/// written afterwards submitted it (turn `none` → `running`, transcript 0 → 4 entries).
/// The TUI treats a burst arriving in one write as a **paste**, so a CR inside that
/// burst becomes a newline in the buffer rather than a submit.
///
/// The earlier measurement that produced the surface-gated version was not wrong, it
/// was narrow: it used a two-character prompt, which is too short to trip the paste
/// heuristic and so submitted from one write. What generalises is the provider, not
/// the surface — `claude` on a canvas pane is exactly as much a TUI as on a swarm one.
fn is_tui_dispatch_target(member: &McpFleetMember) -> bool {
    matches!(
        member.provider.to_ascii_lowercase().as_str(),
        "claude" | "ccs" | "csp" | "codex"
    )
}

pub(crate) fn build_dispatch_write_plan(
    member: &McpFleetMember,
    command: String,
    append_newline: bool,
    enter_key: Option<&str>,
    submit_after_paste: Option<bool>,
    submit_delay_ms: Option<u64>,
) -> DispatchWritePlan {
    if !append_newline {
        let bytes = command.len();
        return DispatchWritePlan {
            writes: vec![command],
            delay_before_submit_ms: 0,
            bytes,
        };
    }

    let should_split = submit_after_paste.unwrap_or_else(|| is_tui_dispatch_target(member));
    if !should_split {
        let payload = build_dispatch_payload(command, true, enter_key);
        let bytes = payload.len();
        return DispatchWritePlan {
            writes: vec![payload],
            delay_before_submit_ms: 0,
            bytes,
        };
    }

    let line_ending = match enter_key {
        Some("lf") => "\n",
        _ => "\r",
    };
    let body = strip_trailing_line_ending(command);
    let submit = line_ending.to_string();
    let bytes = body.len() + submit.len();
    DispatchWritePlan {
        writes: vec![body, submit],
        delay_before_submit_ms: submit_delay_ms.unwrap_or(120).min(1_000),
        bytes,
    }
}

/// Build the response for a dispatch whose target could not be resolved. Distinguishes
/// "the UI never pushed a fleet" (503, retryable) from "that name isn't here" (404 with the
/// live roster) so the caller can self-correct instead of re-guessing (RC4).
fn dispatch_target_not_found_response(state: &McpIpcState, target: &str) -> Response {
    if state.fleet_pushed_at().is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "no fleet snapshot has been received from the Lotus UI yet — open or focus a workspace window, then retry dispatch to '{target}'."
            ),
        )
            .into_response();
    }
    let mut names: Vec<String> = state
        .fleet_snapshot()
        .into_iter()
        .filter(|m| m.is_alive)
        .map(|m| m.display_name)
        .collect();
    names.sort();
    names.dedup();
    let roster = if names.is_empty() {
        "none".to_string()
    } else {
        names.join(", ")
    };
    (
        StatusCode::NOT_FOUND,
        format!(
            "no live agent matches '{target}'. Live agents: [{roster}]. Call lotus_list_fleet to refresh, then dispatch by an exact name or pane_id."
        ),
    )
        .into_response()
}

async fn dispatch_to_cell(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<DispatchRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
    const POLL_MAX: std::time::Duration = std::time::Duration::from_millis(3_000);

    // Fast-fail: the fleet snapshot is populated exclusively by the frontend push, so if
    // nothing has ever been pushed there is no UI that can resolve this dispatch. Return an
    // actionable, retryable 503 immediately instead of polling out to an opaque 404 (RC4).
    if state.fleet_pushed_at().is_none() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "no fleet snapshot has been received from the Lotus UI yet — open or focus a workspace window on the canvas, then retry dispatch to '{}'.",
                req.pane_id
            ),
        )
            .into_response();
    }

    // Resolve the target with project scoping (RC6). A freshly-spawned pane may not be in the
    // snapshot yet, so poll briefly; an ambiguous name, by contrast, will never resolve by
    // waiting, so it returns straight away with a disambiguation hint.
    let resolve_started = std::time::Instant::now();
    let mut refresh_requested = false;
    let member = loop {
        match state.resolve_dispatch_target(&req.pane_id, req.from_pane_id.as_deref()) {
            FleetResolution::Unique(m) => break m,
            FleetResolution::Ambiguous(candidates) => {
                // 06a follow-up: the wording used to assume every ambiguity spans multiple
                // projects and told the caller to "dispatch from that project" — useless
                // advice when the collision is between two agents in the caller's OWN
                // project (they're already there). Branch on whether the candidates
                // actually share one workspace_id, and always suggest a real target
                // (agent_address, falling back to pane_id) instead of a project move.
                let same_project = candidates
                    .iter()
                    .all(|m| m.workspace_id == candidates[0].workspace_id);
                let where_ = candidates
                    .iter()
                    .map(|m| {
                        let target = m.agent_address.as_deref().unwrap_or(m.pane_id.as_str());
                        let ws = m.workspace_label.as_deref().unwrap_or(m.workspace_id.as_str());
                        format!("{} in {}", target, ws)
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                let targets = candidates
                    .iter()
                    .map(|m| m.agent_address.as_deref().unwrap_or(m.pane_id.as_str()))
                    .collect::<Vec<_>>()
                    .join(", ");
                let scope_clause = if same_project {
                    "it matches more than one agent in this project"
                } else {
                    "it matches agents in multiple projects"
                };
                return (
                    StatusCode::CONFLICT,
                    format!(
                        "target '{}' is ambiguous — {} ({}). Pass one of these exact targets instead: {}.",
                        req.pane_id, scope_clause, where_, targets
                    ),
                )
                    .into_response();
            }
            FleetResolution::NotFound => {
                if resolve_started.elapsed() >= POLL_MAX {
                    return dispatch_target_not_found_response(&state, &req.pane_id);
                }
                // Pull-on-miss (F4): the fleet push is on-change, so a genuinely stale snapshot
                // would never self-correct by polling alone. Prod the frontend to re-push NOW,
                // turning a single missed push into a self-healing round-trip instead of a 404.
                //
                // Enhanced (P1.3): if the snapshot is already stale (>5s), emit the refresh
                // request AND sleep longer to give the frontend time to push before we retry.
                // This handles the race where:
                //   1. Agent spawns, PTY connects, but frontend hasn't pushed yet
                //   2. Dispatch arrives immediately → 404
                // Without this fix, agents must wait up to 3s before retrying.
                if !refresh_requested {
                    refresh_requested = true;
                    let _ = state.emit_to_frontend(
                        "mcp://request-fleet-refresh",
                        serde_json::json!({ "target": req.pane_id }),
                    );
                    // Sleep longer on first miss to give frontend time to push
                    // (vs 50ms POLL_INTERVAL for subsequent retries)
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                } else {
                    // Subsequent retries use shorter interval
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
            }
        }
    };

    // ADR-0030: canvas live agents are bus-dispatchable, not PTY-dispatchable. Route a resolved
    // `canvas:` member to the frontend message bus (sendAgentMessage, which does session-resume)
    // instead of pty::write_to_session. We emit the RESOLVED pane_id (not the raw name target) so
    // the owning window delivers to the exact scoped node instead of re-guessing an ambiguous name.
    if member.workspace_id.starts_with("canvas:") {
        // Loop-safety rate-guard, keyed on the resolved canvas pane.
        {
            let now = now_ms();
            let mut history = state.dispatch_history.lock();
            let entry = history
                .entry(format!("canvas:{}", member.pane_id))
                .or_default();
            entry.retain(|&t| now.saturating_sub(t) < DISPATCH_WINDOW_MS);
            let recent = dispatches_in_window(entry, now, DISPATCH_WINDOW_MS);
            if recent >= DISPATCH_LIMIT {
                return (
                    StatusCode::TOO_MANY_REQUESTS,
                    format!(
                        "handoff rate guard: {} dispatches to '{}' within {}s — possible loop; pausing",
                        recent,
                        member.display_name,
                        DISPATCH_WINDOW_MS / 1000
                    ),
                )
                    .into_response();
            }
            entry.push(now);
        }
        let (req_id, rx) = state.register_pending();
        let emit_payload = serde_json::json!({
            "requestId": req_id,
            "target": member.pane_id,
            "text": req.command.clone(),
            // Who sent it. Already known here (it scopes an ambiguous target to the caller's
            // project); forwarding it lets the receiving agent see the sender and reply by name
            // instead of reading every peer message as if the user had typed it.
            "fromPaneId": req.from_pane_id.clone(),
        });
        if let Err(err) = state.emit_to_frontend("mcp://dispatch-to-canvas-agent", emit_payload) {
            state.pending.lock().remove(&req_id);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("cannot reach frontend: {err}"),
            )
                .into_response();
        }
        return match tokio::time::timeout(Duration::from_secs(6), rx).await {
            Ok(Ok(result)) => {
                if result.ok {
                    Json(result.data.unwrap_or_else(|| serde_json::json!({}))).into_response()
                } else {
                    (
                        StatusCode::NOT_FOUND,
                        result
                            .error
                            .unwrap_or_else(|| "canvas dispatch failed".into()),
                    )
                        .into_response()
                }
            }
            Ok(Err(_)) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "canvas dispatch channel closed",
            )
                .into_response(),
            Err(_) => {
                state.pending.lock().remove(&req_id);
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    "canvas dispatch timed out — is the Lotus window open on the canvas?",
                )
                    .into_response()
            }
        };
    }

    // PTY path: the member is resolved; wait briefly for its live session id. A freshly-spawned
    // pane (spawn_cell immediately followed by dispatch_to_cell) may not carry a session_id yet.
    let session_started = std::time::Instant::now();
    let session_id = loop {
        if let Some(m) = state.resolve_fleet_member(&req.pane_id) {
            if let Some(sid) = m.session_id.clone() {
                break sid;
            }
        }
        if session_started.elapsed() >= POLL_MAX {
            return (
                StatusCode::NOT_FOUND,
                format!(
                    "cell '{}' is in the fleet but has no live PTY session (it may have exited).",
                    req.pane_id
                ),
            )
                .into_response();
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };
    // Handoff loop guard: cap dispatches to one target within the window (Fase 2). A runaway
    // A→B→A ping-pong or fan-out trips this here, at the unbypassable choke point.
    {
        let now = now_ms();
        let mut history = state.dispatch_history.lock();
        let entry = history.entry(session_id.clone()).or_default();
        // Prune timestamps outside the window so the buffer can't grow unbounded.
        entry.retain(|&t| now.saturating_sub(t) < DISPATCH_WINDOW_MS);
        // Decide via the unit-tested helper so the live path is the one under test.
        let recent = dispatches_in_window(entry, now, DISPATCH_WINDOW_MS);
        if recent >= DISPATCH_LIMIT {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                format!(
                    "handoff rate guard: {} dispatches to '{}' within {}s — possible loop; pausing",
                    recent,
                    req.pane_id,
                    DISPATCH_WINDOW_MS / 1000
                ),
            )
                .into_response();
        }
        entry.push(now);
    }
    let Some(pty) = state.pty.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "PTY state unavailable").into_response();
    };
    let plan = build_dispatch_write_plan(
        &member,
        req.command,
        req.append_newline,
        req.enter_key.as_deref(),
        req.submit_after_paste,
        req.submit_delay_ms,
    );
    let bytes = plan.bytes;
    for (index, write) in plan.writes.iter().enumerate() {
        if index > 0 && plan.delay_before_submit_ms > 0 {
            tokio::time::sleep(Duration::from_millis(plan.delay_before_submit_ms)).await;
        }
        if let Err(err) = pty::write_to_session(session_id.clone(), write.clone(), &pty) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("dispatch failed: {err}"),
            )
                .into_response();
        }
    }
    let payload = plan.writes.concat();
    let _ = state.emit_to_frontend(
        "mcp://terminal-input",
        McpTerminalInputPayload {
            pane_id: member.pane_id,
            workspace_id: member.workspace_id,
            prompt_text: payload.trim().to_string(),
            data: payload,
            origin: "mcp".to_string(),
            intent: "conversation-prompt".to_string(),
            submitted: true,
        },
    );
    Json(serde_json::json!({
        "ok": true,
        "sessionId": session_id,
        "paneId": req.pane_id,
        "bytesWritten": bytes,
    }))
    .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatReadRequest {
    chat_id: String,
    #[serde(default)]
    from_turn: usize,
    #[serde(default)]
    limit: Option<usize>,
}

/// `lotus_chat_read`: another agent reads a Chat thread it continues (handoff), a page at a time.
async fn chat_read(State(state): State<SharedState>, headers: HeaderMap, Json(req): Json<ChatReadRequest>) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    use tauri::Manager;
    let Some(app) = state.app_handle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lotus app not ready").into_response();
    };
    let Some(chat) = app.try_state::<crate::chat_runtime::ChatRuntime>() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Chat unavailable").into_response();
    };
    // Capped so one call never floods the reader's context.
    let limit = req.limit.unwrap_or(20).clamp(1, 50);
    match chat.transcript(&req.chat_id, req.from_turn, limit) {
        Ok(page) => Json(page).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "ok": false, "error": error }))).into_response(),
    }
}

/// `lotus_chat_delegate`: a chat starts a child chat on any runner, model and effort.
async fn chat_delegate(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<crate::chat_runtime::DelegateRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    use tauri::Manager;
    let Some(app) = state.app_handle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lotus app not ready").into_response();
    };
    let Some(chat) = app.try_state::<crate::chat_runtime::ChatRuntime>() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Chat unavailable").into_response();
    };
    match chat.delegate(req).await {
        Ok(child) => Json(child).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": error }))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatWaitRequest {
    chat_ids: Vec<String>,
    #[serde(default)]
    timeout_sec: Option<u64>,
}

/// `lotus_chat_wait`: the delegating chat collects its children's answers.
async fn chat_wait(State(state): State<SharedState>, headers: HeaderMap, Json(req): Json<ChatWaitRequest>) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    use tauri::Manager;
    let Some(app) = state.app_handle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lotus app not ready").into_response();
    };
    let Some(chat) = app.try_state::<crate::chat_runtime::ChatRuntime>() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Chat unavailable").into_response();
    };
    // Capped under the sidecar's request timeout for this route (31 min).
    let timeout = std::time::Duration::from_secs(req.timeout_sec.unwrap_or(600).clamp(5, 1800));
    match chat.wait_children(&req.chat_ids, timeout).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": error }))).into_response(),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatStopRequest {
    parent_id: String,
    chat_ids: Vec<String>,
}

/// `lotus_chat_stop`: the delegating chat stops children it started, and theirs.
async fn chat_stop(State(state): State<SharedState>, headers: HeaderMap, Json(req): Json<ChatStopRequest>) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    use tauri::Manager;
    let Some(app) = state.app_handle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lotus app not ready").into_response();
    };
    let Some(chat) = app.try_state::<crate::chat_runtime::ChatRuntime>() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Chat unavailable").into_response();
    };
    match chat.stop_children(&req.parent_id, &req.chat_ids).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": error }))).into_response(),
    }
}

/// `lotus_chat_tell` / `_merge` / `_discard` / `_answer`: the delegating chat acts on one child.
async fn chat_child(State(state): State<SharedState>, headers: HeaderMap, Json(req): Json<crate::chat_runtime::ChatChildRequest>) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    use tauri::Manager;
    let Some(app) = state.app_handle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lotus app not ready").into_response();
    };
    let Some(chat) = app.try_state::<crate::chat_runtime::ChatRuntime>() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Chat unavailable").into_response();
    };
    match chat.child_action(req).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": error }))).into_response(),
    }
}

/// `lotus_chat_list`: an agent finds chats by title or folder, to manage them when asked.
async fn chat_list(State(state): State<SharedState>, headers: HeaderMap, Json(req): Json<crate::chat_runtime::ChatListRequest>) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    use tauri::Manager;
    let Some(app) = state.app_handle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lotus app not ready").into_response();
    };
    let Some(chat) = app.try_state::<crate::chat_runtime::ChatRuntime>() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Chat unavailable").into_response();
    };
    match chat.list_for_agent(&req) {
        Ok(result) => Json(result).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": error }))).into_response(),
    }
}

/// `lotus_chat_manage`: the rail's archive, pin, rename and delete, asked of an agent.
async fn chat_manage(State(state): State<SharedState>, headers: HeaderMap, Json(req): Json<crate::chat_runtime::ChatManageRequest>) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    use tauri::Manager;
    let Some(app) = state.app_handle() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Lotus app not ready").into_response();
    };
    let Some(chat) = app.try_state::<crate::chat_runtime::ChatRuntime>() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Chat unavailable").into_response();
    };
    match chat.manage_threads(req).await {
        Ok(result) => Json(result).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "ok": false, "error": error }))).into_response(),
    }
}

#[derive(Deserialize)]
struct ReadCellRequest {
    pane_id: String,
    #[serde(default)]
    tail_bytes: Option<usize>,
    /// Opt back into raw PTY bytes (ANSI included). Default false — output is cleaned for
    /// LLM consumption (see `clean_cell_output`).
    #[serde(default)]
    raw: bool,
}

async fn read_cell_output(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<ReadCellRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    // Same race as dispatch_to_cell. Brief poll before reporting "no session".
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
    const POLL_MAX: std::time::Duration = std::time::Duration::from_millis(3_000);
    let started = std::time::Instant::now();
    let session_id = loop {
        if let Some(sid) = state.resolve_session_id(&req.pane_id) {
            break sid;
        }
        if started.elapsed() >= POLL_MAX {
            return Json(serde_json::json!({
                "ok": false,
                "error": "no live session for paneId",
                "paneId": req.pane_id,
                "output": "",
                "bytes": 0,
            }))
            .into_response();
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };
    let Some(pty) = state.pty.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "PTY state unavailable").into_response();
    };
    let limit = req.tail_bytes.unwrap_or(4096).min(64 * 1024);
    let tail = pty::read_output_tail(&session_id, limit, &pty);
    let bytes = tail.len();
    let output = if req.raw {
        tail
    } else {
        clean_cell_output(&tail)
    };
    Json(serde_json::json!({
        "ok": true,
        "paneId": req.pane_id,
        "sessionId": session_id,
        "bytes": bytes,
        "output": output,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct GatherResultsRequest {
    pane_ids: Vec<String>,
    #[serde(default)]
    tail_bytes: Option<usize>,
    #[serde(default)]
    timeout_ms: Option<u64>,
}

/// Batched wait+read across N cells (Phase C orchestration): the lead agent collects every worker's
/// output in one call instead of polling read-cell-output per pane. Each cell waits for readiness in
/// parallel (mirrors `ensure_fleet`), then its output tail is read.
async fn gather_results(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<GatherResultsRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    if req.pane_ids.is_empty() {
        return (StatusCode::BAD_REQUEST, "pane_ids must be non-empty").into_response();
    }
    let Some(pty) = state.pty.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "PTY state unavailable").into_response();
    };
    let limit = req.tail_bytes.unwrap_or(4096).min(64 * 1024);
    let timeout_ms = req
        .timeout_ms
        .unwrap_or(WAIT_IDLE_CEILING_MS)
        .min(WAIT_IDLE_CEILING_MS);

    let mut handles = Vec::new();
    let wait_started_ms = now_ms();
    for pane_id in req.pane_ids {
        let session_id = state.resolve_session_id(&pane_id);
        let pty_cloned = pty.clone();
        let hook = Some(HookTurnWatch::new(
            state.clone(),
            pane_id.clone(),
            wait_started_ms,
        ));
        handles.push(tokio::spawn(async move {
            let Some(session_id) = session_id else {
                return (pane_id, None::<WaitOutcome>, String::new());
            };
            let outcome =
                wait_for_cell_ready(pty_cloned.clone(), &session_id, timeout_ms, None, hook).await;
            // Cleaned like read_cell_output: gather feeds a planner, not a terminal.
            let tail = clean_cell_output(&pty::read_output_tail(&session_id, limit, &pty_cloned));
            (pane_id, Some(outcome), tail)
        }));
    }

    let mut results = Vec::new();
    let mut errors = Vec::new();
    for handle in handles {
        match handle.await {
            Ok((pane_id, Some(outcome), tail)) => {
                let bytes = tail.len();
                results.push(serde_json::json!({
                    "paneId": pane_id,
                    "readiness": outcome.state,
                    "output": tail,
                    "bytes": bytes,
                }));
            }
            Ok((pane_id, None, _)) => {
                errors.push(format!("{pane_id}: no live session for paneId"));
                results.push(serde_json::json!({
                    "paneId": pane_id,
                    "readiness": "no_session",
                    "output": "",
                    "bytes": 0,
                }));
            }
            Err(e) => errors.push(format!("gather task panicked: {e}")),
        }
    }

    Json(serde_json::json!({
        "ok": errors.is_empty(),
        "results": results,
        "errors": errors,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SpawnCellRequest {
    provider: String,
    #[serde(default)]
    workspace_id: Option<String>,
    /// Optional first task auto-submitted once the cell is ready (orchestrator spawn-with-brief).
    #[serde(default)]
    initial_prompt: Option<String>,
    /// Optional runner/CLI id override; the frontend defaults it to `provider`.
    #[serde(default)]
    runner_id: Option<String>,
    /// Optional working directory for the new cell.
    #[serde(default)]
    cwd: Option<String>,
    /// Optional role label (orchestration metadata).
    #[serde(default)]
    role: Option<String>,
    /// Pane id of the agent that asked for this spawn (`LOTUS_PANE_ID` in its PTY). Forwarded to
    /// the frontend so it can count spawn generations and refuse a chain that recurses too deep.
    /// Absent for a human-invoked spawn, which counts as a root.
    #[serde(default)]
    from_pane_id: Option<String>,
    /// Whether the new cell asks before acting: `safe` or `yolo`. Absent keeps the
    /// runner's own default, which is what every caller before the phone relied on.
    #[serde(default)]
    permission_mode: Option<String>,
    /// Model alias and effort for the new cell (`spawn-tuning` in `contract/README.md`). Absent
    /// keeps the CLI's own defaults; the frontend turns them into the runner's flags.
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    /// Canvas Frame to place the new cell in: a Frame id or its exact title. Passed through
    /// untouched; the canvas resolves it and refuses an unknown one before spawning.
    #[serde(default)]
    frame: Option<String>,
    /// The Lotus task this cell is for. The canvas groups an agent's cells for one task into one
    /// Frame named after it; passed through untouched. Ignored when `frame` is given.
    #[serde(default)]
    task: Option<SpawnCellTask>,
    /// Claude only: the account to run as (issues/07). Absent = the chosen account.
    #[serde(default)]
    profile_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct SpawnCellTask {
    id: String,
    #[serde(default)]
    title: Option<String>,
}

async fn spawn_cell(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<SpawnCellRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    if !state.workspace_ui_seen() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "no active Lotus workspace UI — open the Lotus window on a workspace so it can handle spawn requests",
        )
            .into_response();
    }
    // Refused by name here, as in `fleet.rs`: otherwise the cell starts and only its PTY fails.
    if let Some(id) = req.profile_id.as_deref() {
        if crate::accounts::find(id).is_none() {
            let known: Vec<String> = crate::accounts::claude_accounts().into_iter().map(|a| a.id).collect();
            return (StatusCode::BAD_REQUEST, format!("no account named \"{id}\" — this machine has {}", known.join(", ")))
                .into_response();
        }
    }
    let (req_id, rx) = state.register_pending();
    let emit_payload = serde_json::json!({
        "requestId": req_id,
        "provider": req.provider,
        "workspaceId": req.workspace_id,
        "initialPrompt": req.initial_prompt,
        "runnerId": req.runner_id,
        "cwd": req.cwd,
        "role": req.role,
        "fromPaneId": req.from_pane_id,
        "permissionMode": req.permission_mode,
        "model": req.model,
        "effort": req.effort,
        "frame": req.frame,
        "task": req.task,
        "profileId": req.profile_id,
    });
    if let Err(err) = state.emit_to_frontend("mcp://spawn-cell", emit_payload) {
        state.pending.lock().remove(&req_id);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("cannot reach frontend: {err}"),
        )
            .into_response();
    }
    // 10s (was 6s): the codespace spawn bridge's own frontend budget is 5s — a 1s margin meant any
    // added frontend latency surfaced as an opaque 504 instead of the bridge's fallback result.
    // The sidecar's /v1/spawn-cell client timeout (12s) still bounds the caller.
    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(result)) => {
            if result.ok {
                Json(result.data.unwrap_or_else(|| serde_json::json!({}))).into_response()
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    result.error.unwrap_or_else(|| "spawn failed".into()),
                )
                    .into_response()
            }
        }
        Ok(Err(_)) => (StatusCode::INTERNAL_SERVER_ERROR, "spawn channel closed").into_response(),
        Err(_) => {
            state.pending.lock().remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "spawn timed out — the Lotus workspace UI did not resolve the request within 10s (is the window open on a workspace?)",
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct CloseCellRequest {
    pane_id: String,
}

async fn close_cell(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<CloseCellRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    if !state.workspace_ui_seen() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "no active Lotus workspace UI — open the Lotus window on a workspace so it can handle close requests",
        )
            .into_response();
    }
    let (req_id, rx) = state.register_pending();
    let emit_payload = serde_json::json!({
        "requestId": req_id,
        "paneId": req.pane_id,
    });
    if let Err(err) = state.emit_to_frontend("mcp://close-cell", emit_payload) {
        state.pending.lock().remove(&req_id);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("cannot reach frontend: {err}"),
        )
            .into_response();
    }
    match tokio::time::timeout(Duration::from_secs(6), rx).await {
        Ok(Ok(result)) => {
            if result.ok {
                Json(result.data.unwrap_or_else(|| {
                    serde_json::json!({
                        "ok": true,
                        "paneId": req.pane_id,
                    })
                }))
                .into_response()
            } else {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    result.error.unwrap_or_else(|| "close failed".into()),
                )
                    .into_response()
            }
        }
        Ok(Err(_)) => (StatusCode::INTERNAL_SERVER_ERROR, "close channel closed").into_response(),
        Err(_) => {
            state.pending.lock().remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "close timed out — the Lotus workspace UI did not resolve the request within 6s (is the window open on a workspace?)",
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct CanvasControlRequest {
    /// "focus" (requires `target`) or "arrange".
    action: String,
    #[serde(default)]
    target: Option<String>,
}

/// Agent canvas-control: pan/zoom to a node or auto-arrange the board. Round-trips
/// to the frontend (`mcp://canvas-control`), which honours it only when the user
/// has enabled "Let agents move the canvas & focus" (Settings → Canvas) — when
/// disabled the frontend resolves this request with a denial, not the Rust side.
async fn canvas_control(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<CanvasControlRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let action = req.action.trim().to_lowercase();
    if action != "focus" && action != "arrange" {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "unknown action '{}': expected 'focus' or 'arrange'",
                req.action
            ),
        )
            .into_response();
    }
    if action == "focus"
        && req
            .target
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            "action 'focus' requires a non-empty 'target'",
        )
            .into_response();
    }
    let (req_id, rx) = state.register_pending();
    let emit_payload = serde_json::json!({
        "requestId": req_id,
        "action": action,
        "target": req.target,
    });
    if let Err(err) = state.emit_to_frontend("mcp://canvas-control", emit_payload) {
        state.pending.lock().remove(&req_id);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("cannot reach frontend: {err}"),
        )
            .into_response();
    }
    match tokio::time::timeout(Duration::from_secs(6), rx).await {
        Ok(Ok(result)) => {
            if result.ok {
                Json(
                    result
                        .data
                        .unwrap_or_else(|| serde_json::json!({ "ok": true, "action": action })),
                )
                .into_response()
            } else {
                (
                    StatusCode::FORBIDDEN,
                    result
                        .error
                        .unwrap_or_else(|| "canvas control rejected".into()),
                )
                    .into_response()
            }
        }
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "canvas control channel closed",
        )
            .into_response(),
        Err(_) => {
            state.pending.lock().remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "canvas control timed out — is the Lotus window open on the canvas?",
            )
                .into_response()
        }
    }
}

/// Hard ceiling on ops per `lotus_canvas_draw` batch (mirrors the frontend planner). A runaway-loop
/// backstop — fast-failed here so an oversized batch never reaches the UI.
const MAX_DRAW_OPS: usize = 60;

/// Agent canvas-draw: draw shapes (`ops`) or generate a diagram (`graph`). The payload is
/// validated + laid out by the frontend runtime; Rust does light fast-fail checks then round-trips
/// to `mcp://canvas-draw`, which honours it only when the user has enabled "Let agents draw &
/// generate diagrams" (Settings → Canvas). When disabled the frontend resolves with a denial (403).
async fn canvas_draw(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<serde_json::Value>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let obj = match req.as_object() {
        Some(obj) => obj,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                "request body must be a JSON object",
            )
                .into_response()
        }
    };
    // Infer mode: explicit `mode`, else `graph` → diagram, else ops.
    let mode = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .map(str::to_lowercase)
        .unwrap_or_else(|| {
            if obj.contains_key("graph") {
                "diagram".into()
            } else {
                "ops".into()
            }
        });

    match mode.as_str() {
        "ops" => match obj.get("ops") {
            Some(serde_json::Value::Array(ops)) if ops.is_empty() => {
                return (StatusCode::BAD_REQUEST, "`ops` is empty — nothing to draw")
                    .into_response();
            }
            Some(serde_json::Value::Array(ops)) if ops.len() > MAX_DRAW_OPS => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!(
                        "too many operations: {} exceeds the {MAX_DRAW_OPS}-op limit",
                        ops.len()
                    ),
                )
                    .into_response();
            }
            Some(serde_json::Value::Array(_)) => {}
            _ => {
                return (StatusCode::BAD_REQUEST, "ops mode requires an `ops` array")
                    .into_response()
            }
        },
        "diagram" => {
            let nodes_ok = obj
                .get("graph")
                .and_then(|g| g.get("nodes"))
                .and_then(|n| n.as_array())
                .map(|n| !n.is_empty())
                .unwrap_or(false);
            if !nodes_ok {
                return (
                    StatusCode::BAD_REQUEST,
                    "diagram mode requires a `graph` with a non-empty `nodes` array",
                )
                    .into_response();
            }
        }
        other => {
            return (
                StatusCode::BAD_REQUEST,
                format!("unknown mode '{other}': expected 'ops' or 'diagram'"),
            )
                .into_response();
        }
    }

    let (req_id, rx) = state.register_pending();
    let mut payload = obj.clone();
    payload.insert("requestId".into(), serde_json::json!(req_id));
    payload.insert("mode".into(), serde_json::json!(mode));
    if let Err(err) =
        state.emit_to_frontend("mcp://canvas-draw", serde_json::Value::Object(payload))
    {
        state.pending.lock().remove(&req_id);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("cannot reach frontend: {err}"),
        )
            .into_response();
    }
    match tokio::time::timeout(Duration::from_secs(6), rx).await {
        Ok(Ok(result)) => {
            if result.ok {
                Json(
                    result
                        .data
                        .unwrap_or_else(|| serde_json::json!({ "ok": true })),
                )
                .into_response()
            } else {
                (
                    StatusCode::FORBIDDEN,
                    result
                        .error
                        .unwrap_or_else(|| "canvas draw rejected".into()),
                )
                    .into_response()
            }
        }
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "canvas draw channel closed",
        )
            .into_response(),
        Err(_) => {
            state.pending.lock().remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "canvas draw timed out — is the Lotus window open on the canvas?",
            )
                .into_response()
        }
    }
}

/// Agent canvas read-back: return a tiered snapshot of the canvas (shapes + connectors) so the
/// agent can edit an existing diagram. Read-only round-trip to `mcp://canvas-read-shapes`; honoured
/// under the same "Let agents draw & generate diagrams" gate (reading enables editing).
async fn canvas_read_shapes(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let (req_id, rx) = state.register_pending();
    if let Err(err) = state.emit_to_frontend(
        "mcp://canvas-read-shapes",
        serde_json::json!({ "requestId": req_id }),
    ) {
        state.pending.lock().remove(&req_id);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("cannot reach frontend: {err}"),
        )
            .into_response();
    }
    match tokio::time::timeout(Duration::from_secs(6), rx).await {
        Ok(Ok(result)) => {
            if result.ok {
                Json(
                    result
                        .data
                        .unwrap_or_else(|| serde_json::json!({ "shapes": [], "connectors": [] })),
                )
                .into_response()
            } else {
                (
                    StatusCode::FORBIDDEN,
                    result
                        .error
                        .unwrap_or_else(|| "canvas read rejected".into()),
                )
                    .into_response()
            }
        }
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "canvas read channel closed",
        )
            .into_response(),
        Err(_) => {
            state.pending.lock().remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "canvas read timed out — is the Lotus window open on the canvas?",
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct CanvasCollaborationRequest {
    /// list-participants | read-assignment | record-evidence | mark-blocked.
    action: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    assignee: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    files: Option<Vec<String>>,
    #[serde(default)]
    checks: Option<Vec<String>>,
    #[serde(default)]
    blockers: Option<Vec<String>>,
}

fn empty_mailbox(run_id: &str) -> serde_json::Value {
    serde_json::json!({ "runId": run_id, "messages": [], "updatedAt": now_ms() })
}

fn message_array(mailbox: &serde_json::Value) -> Vec<serde_json::Value> {
    mailbox
        .get("messages")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
}

fn collaboration_clean_list(values: &Option<Vec<String>>) -> Option<Vec<String>> {
    let cleaned: Vec<String> = values
        .as_ref()
        .into_iter()
        .flatten()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn collaboration_evidence(
    files: &Option<Vec<String>>,
    checks: &Option<Vec<String>>,
    blockers: &Option<Vec<String>>,
) -> serde_json::Value {
    let mut evidence = serde_json::Map::new();
    if let Some(values) = collaboration_clean_list(files) {
        evidence.insert("files".into(), serde_json::json!(values));
    }
    if let Some(values) = collaboration_clean_list(checks) {
        evidence.insert("checks".into(), serde_json::json!(values));
    }
    if let Some(values) = collaboration_clean_list(blockers) {
        evidence.insert("blockers".into(), serde_json::json!(values));
    }
    serde_json::Value::Object(evidence)
}

fn collaboration_message(
    run_id: &str,
    kind: &str,
    assignee: &str,
    summary: &str,
    files: &Option<Vec<String>>,
    checks: &Option<Vec<String>>,
    blockers: &Option<Vec<String>>,
) -> serde_json::Value {
    let now = now_ms();
    let evidence = collaboration_evidence(files, checks, blockers);
    let mut message = serde_json::json!({
        "id": format!("mcp-{now}-{}", uuid::Uuid::new_v4()),
        "assignee": assignee.trim(),
        "assigneeKey": normalize_fleet_target(assignee),
        "kind": kind,
        "author": "agent",
        "body": summary.trim(),
        "createdAt": now,
    });
    if let Some(object) = message.as_object_mut() {
        if evidence
            .as_object()
            .is_some_and(|object| !object.is_empty())
        {
            object.insert("evidence".into(), evidence);
        }
        // Keep the run id available for native-only callers that inspect an isolated message.
        object.insert("runId".into(), serde_json::json!(run_id));
    }
    message
}

fn mailbox_with_message(
    mut mailbox: serde_json::Value,
    message: serde_json::Value,
) -> serde_json::Value {
    let now = now_ms();
    let mut messages = message_array(&mailbox);
    if let Some(id) = message.get("id").and_then(|value| value.as_str()) {
        if messages
            .iter()
            .any(|existing| existing.get("id").and_then(|value| value.as_str()) == Some(id))
        {
            return mailbox;
        }
    }
    messages.push(message);
    messages.sort_by_key(|message| {
        message
            .get("createdAt")
            .and_then(|value| value.as_i64())
            .unwrap_or_default()
    });
    if let Some(object) = mailbox.as_object_mut() {
        object.insert("messages".into(), serde_json::json!(messages));
        object.insert("updatedAt".into(), serde_json::json!(now));
    }
    mailbox
}

fn messages_for_assignee(mailbox: &serde_json::Value, target: &str) -> Vec<serde_json::Value> {
    let key = normalize_fleet_target(target);
    let mut messages: Vec<serde_json::Value> = message_array(mailbox)
        .into_iter()
        .filter(|message| {
            message.get("nodeId").and_then(|value| value.as_str()) == Some(target)
                || message.get("assigneeKey").and_then(|value| value.as_str()) == Some(key.as_str())
                || message
                    .get("assignee")
                    .and_then(|value| value.as_str())
                    .map(normalize_fleet_target)
                    .as_deref()
                    == Some(key.as_str())
        })
        .collect();
    messages.sort_by_key(|message| {
        std::cmp::Reverse(
            message
                .get("createdAt")
                .and_then(|value| value.as_i64())
                .unwrap_or_default(),
        )
    });
    messages
}

fn participant_from_records(
    assignee_key: &str,
    name: &str,
    node_id: Option<&serde_json::Value>,
    assignment_state: Option<&serde_json::Value>,
    assignment_updated_at: Option<&serde_json::Value>,
    mailbox: &serde_json::Value,
) -> serde_json::Value {
    let target = node_id.and_then(|value| value.as_str()).unwrap_or(name);
    let messages = messages_for_assignee(mailbox, target);
    let latest = messages.first().cloned().unwrap_or(serde_json::Value::Null);
    let latest_kind = latest.get("kind").and_then(|value| value.as_str());
    let status = match latest_kind {
        Some("blocker") => "needs-attention",
        Some("evidence") => "done",
        _ => assignment_state
            .and_then(|value| value.as_str())
            .unwrap_or("unknown"),
    };
    serde_json::json!({
        "assigneeKey": assignee_key,
        "name": name,
        "nodeId": node_id.cloned().unwrap_or(serde_json::Value::Null),
        "assignmentState": assignment_state.cloned().unwrap_or(serde_json::Value::Null),
        "assignmentUpdatedAt": assignment_updated_at.cloned().unwrap_or(serde_json::Value::Null),
        "status": status,
        "messageCount": messages.len(),
        "evidenceCount": messages.iter().filter(|message| message.get("kind").and_then(|value| value.as_str()) == Some("evidence")).count(),
        "latestMessage": latest,
    })
}

fn ledger_participants(
    ledger: Option<&serde_json::Value>,
    mailbox: &serde_json::Value,
) -> Vec<serde_json::Value> {
    let mut participants = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(assignments) = ledger
        .and_then(|ledger| ledger.get("assignments"))
        .and_then(|value| value.as_object())
    {
        for (key, record) in assignments {
            seen.insert(key.clone());
            participants.push(participant_from_records(
                key,
                record
                    .get("assignee")
                    .and_then(|value| value.as_str())
                    .unwrap_or(key),
                record.get("nodeId"),
                record.get("state"),
                record.get("updatedAt"),
                mailbox,
            ));
        }
    }
    for message in message_array(mailbox) {
        let key = message
            .get("assigneeKey")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                normalize_fleet_target(
                    message
                        .get("assignee")
                        .and_then(|value| value.as_str())
                        .unwrap_or(""),
                )
            });
        if key.is_empty() || seen.contains(&key) {
            continue;
        }
        seen.insert(key.clone());
        participants.push(participant_from_records(
            &key,
            message
                .get("assignee")
                .and_then(|value| value.as_str())
                .unwrap_or("Unknown"),
            message.get("nodeId"),
            None,
            None,
            mailbox,
        ));
    }
    participants
}

fn collaboration_response_context(
    context: Option<&serde_json::Value>,
    live_task: Option<serde_json::Value>,
) -> (serde_json::Value, serde_json::Value, &'static str) {
    let run = context
        .and_then(|context| context.get("launch"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let persisted_task = context
        .and_then(|context| context.get("task"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    if let Some(task) = live_task {
        return (run, task, "live-task");
    }
    let freshness = if persisted_task.is_null() {
        "unavailable"
    } else {
        "persisted-context"
    };
    (run, persisted_task, freshness)
}

fn collaboration_context_task_ids(context: Option<&serde_json::Value>) -> Option<(&str, &str)> {
    let launch = context?.get("launch")?;
    let workspace_id = launch.get("workspaceId")?.as_str()?.trim();
    let task_id = launch.get("taskId")?.as_str()?.trim();
    if workspace_id.is_empty() || task_id.is_empty() {
        return None;
    }
    Some((workspace_id, task_id))
}

fn collaboration_live_task_value(context: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let (workspace_id, task_id) = collaboration_context_task_ids(context)?;
    let task = crate::bridge_tasks::get_task(workspace_id, task_id)
        .ok()
        .flatten()?;
    serde_json::to_value(task).ok()
}

fn collaboration_find_participant(
    ledger: Option<&serde_json::Value>,
    mailbox: &serde_json::Value,
    target: &str,
) -> serde_json::Value {
    let key = normalize_fleet_target(target);
    ledger_participants(ledger, mailbox)
        .into_iter()
        .find(|participant| {
            participant.get("nodeId").and_then(|value| value.as_str()) == Some(target)
                || participant
                    .get("assigneeKey")
                    .and_then(|value| value.as_str())
                    == Some(key.as_str())
                || participant
                    .get("name")
                    .and_then(|value| value.as_str())
                    .map(normalize_fleet_target)
                    .as_deref()
                    == Some(key.as_str())
        })
        .unwrap_or_else(|| {
            serde_json::json!({
                "assigneeKey": key,
                "name": target,
                "status": "unknown",
                "messageCount": messages_for_assignee(mailbox, target).len(),
            })
        })
}

fn collaboration_assignment_summary(
    participant: &serde_json::Value,
    messages: &[serde_json::Value],
) -> serde_json::Value {
    let latest_evidence = messages
        .iter()
        .find(|message| message.get("kind").and_then(|value| value.as_str()) == Some("evidence"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let latest_blocker = messages
        .iter()
        .find(|message| message.get("kind").and_then(|value| value.as_str()) == Some("blocker"))
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let next_action = if !latest_blocker.is_null() {
        "Resolve or clarify the latest blocker, then call lotus_canvas_record_evidence when progress is ready."
    } else if !latest_evidence.is_null() {
        "Continue from the latest evidence or wait for review feedback."
    } else {
        "Review the handoff brief, complete the assignment, then call lotus_canvas_record_evidence with files and checks."
    };
    serde_json::json!({
        "assignee": participant.get("name").cloned().unwrap_or(serde_json::Value::Null),
        "nodeId": participant.get("nodeId").cloned().unwrap_or(serde_json::Value::Null),
        "status": participant.get("status").cloned().unwrap_or(serde_json::Value::Null),
        "assignmentState": participant.get("assignmentState").cloned().unwrap_or(serde_json::Value::Null),
        "assignmentUpdatedAt": participant.get("assignmentUpdatedAt").cloned().unwrap_or(serde_json::Value::Null),
        "messageCount": messages.len(),
        "evidenceCount": messages.iter().filter(|message| message.get("kind").and_then(|value| value.as_str()) == Some("evidence")).count(),
        "latestEvidence": latest_evidence,
        "latestBlocker": latest_blocker,
        "nextAction": next_action,
    })
}

fn collaboration_assignment_response(
    ledger: Option<&serde_json::Value>,
    mailbox: &serde_json::Value,
    assignee: &str,
) -> serde_json::Value {
    let participant = collaboration_find_participant(ledger, mailbox, assignee);
    let target = participant
        .get("nodeId")
        .and_then(|value| value.as_str())
        .or_else(|| participant.get("name").and_then(|value| value.as_str()))
        .unwrap_or(assignee);
    let messages = messages_for_assignee(mailbox, target);
    let assignment = collaboration_assignment_summary(&participant, &messages);
    serde_json::json!({
        "participant": participant,
        "assignment": assignment,
        "messages": messages,
    })
}

fn canvas_collaboration_project_backed(
    state: SharedState,
    action: String,
    req: CanvasCollaborationRequest,
) -> Response {
    let project_id = req.project_id.as_deref().map(str::trim).unwrap_or_default();
    let run_id = req.run_id.as_deref().map(str::trim).unwrap_or_default();
    let app = match state.app.read().as_ref().cloned() {
        Some(app) => app,
        None => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                "Tauri app handle not registered yet",
            )
                .into_response()
        }
    };
    let connection = match crate::codecanvas_store::open_app_store(&app) {
        Ok(connection) => connection,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };
    let ledger = match crate::codecanvas_store::load_collaboration_record(
        &connection,
        project_id,
        run_id,
        "ledger",
    ) {
        Ok(value) => value,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };
    let mailbox = match crate::codecanvas_store::load_collaboration_record(
        &connection,
        project_id,
        run_id,
        "mailbox",
    ) {
        Ok(Some(value)) => value,
        Ok(None) => empty_mailbox(run_id),
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };
    let context = match crate::codecanvas_store::load_collaboration_record(
        &connection,
        project_id,
        run_id,
        "context",
    ) {
        Ok(value) => value,
        Err(err) => return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response(),
    };
    let live_task = collaboration_live_task_value(context.as_ref());
    let (run, task, task_freshness) = collaboration_response_context(context.as_ref(), live_task);

    if action == "list-participants" {
        return Json(serde_json::json!({
            "ok": true,
            "source": "project-store",
            "projectId": project_id,
            "runId": run_id,
            "run": run,
            "task": task,
            "taskFreshness": task_freshness,
            "participants": ledger_participants(ledger.as_ref(), &mailbox),
        }))
        .into_response();
    }

    let assignee = req.assignee.as_deref().map(str::trim).unwrap_or_default();
    if action == "read-assignment" {
        let assignment = collaboration_assignment_response(ledger.as_ref(), &mailbox, assignee);
        return Json(serde_json::json!({
            "ok": true,
            "source": "project-store",
            "projectId": project_id,
            "runId": run_id,
            "run": run,
            "task": task,
            "taskFreshness": task_freshness,
            "assignee": assignee,
            "participant": assignment.get("participant").cloned().unwrap_or(serde_json::Value::Null),
            "assignment": assignment.get("assignment").cloned().unwrap_or(serde_json::Value::Null),
            "messages": assignment.get("messages").cloned().unwrap_or_else(|| serde_json::json!([])),
        })).into_response();
    }

    let kind = if action == "record-evidence" {
        "evidence"
    } else {
        "blocker"
    };
    let summary = req.summary.as_deref().map(str::trim).unwrap_or_default();
    let message = collaboration_message(
        run_id,
        kind,
        assignee,
        summary,
        &req.files,
        &req.checks,
        &req.blockers,
    );
    let mailbox = mailbox_with_message(mailbox, message.clone());
    if let Err(err) = crate::codecanvas_store::save_collaboration_record(
        &connection,
        project_id,
        run_id,
        "mailbox",
        &mailbox,
    ) {
        return (StatusCode::INTERNAL_SERVER_ERROR, err.to_string()).into_response();
    }
    // Phase 4 mirror: also append an assignment-scoped memory row so evidence/blockers join project
    // memory retrieval/search. Best-effort — the mailbox record above stays authoritative.
    if let Some(mirror) = crate::codecanvas_memory::collaboration_mirror_input(
        project_id,
        run_id,
        assignee,
        kind,
        summary,
        message
            .get("evidence")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        message.get("id").and_then(|value| value.as_str()),
    ) {
        if let Err(err) = crate::codecanvas_memory::write_memory(&connection, &mirror) {
            eprintln!("collaboration memory mirror failed: {err}");
        }
    }
    let _ = app.emit(
        CODECANVAS_COLLABORATION_RECORD_UPDATED_EVENT,
        serde_json::json!({
            "projectId": project_id,
            "runId": run_id,
            "kind": "mailbox",
            "source": "mcp",
        }),
    );
    let mailbox_count = message_array(&mailbox).len();
    Json(serde_json::json!({
        "ok": true,
        "source": "project-store",
        "projectId": project_id,
        "runId": run_id,
        "action": action,
        "message": message,
        "mailboxCount": mailbox_count,
    }))
    .into_response()
}

/// Agent-facing CodeCanvas collaboration tools. Uses project-backed records when
/// project_id+run_id are supplied; otherwise round-trips to the frontend for live
/// Canvas run context.
async fn canvas_collaboration(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<CanvasCollaborationRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let action = req.action.trim().to_lowercase();
    let known = [
        "list-participants",
        "read-assignment",
        "record-evidence",
        "mark-blocked",
    ];
    if !known.contains(&action.as_str()) {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "unknown action '{}': expected {}",
                req.action,
                known.join(", ")
            ),
        )
            .into_response();
    }
    if matches!(
        action.as_str(),
        "read-assignment" | "record-evidence" | "mark-blocked"
    ) && req
        .assignee
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            format!("action '{action}' requires a non-empty 'assignee'"),
        )
            .into_response();
    }
    if matches!(action.as_str(), "record-evidence" | "mark-blocked")
        && req
            .summary
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .is_empty()
    {
        return (
            StatusCode::BAD_REQUEST,
            format!("action '{action}' requires a non-empty 'summary'"),
        )
            .into_response();
    }

    let has_project = req
        .project_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    let has_run = req
        .run_id
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty());
    if has_project != has_run {
        return (
            StatusCode::BAD_REQUEST,
            "project_id and run_id must be supplied together",
        )
            .into_response();
    }
    if has_project && has_run {
        return canvas_collaboration_project_backed(state, action, req);
    }

    let (req_id, rx) = state.register_pending();
    let emit_payload = serde_json::json!({
        "requestId": req_id,
        "action": action,
        "assignee": req.assignee,
        "summary": req.summary,
        "files": req.files,
        "checks": req.checks,
        "blockers": req.blockers,
    });
    if let Err(err) = state.emit_to_frontend("mcp://canvas-collaboration", emit_payload) {
        state.pending.lock().remove(&req_id);
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("cannot reach frontend: {err}"),
        )
            .into_response();
    }
    match tokio::time::timeout(Duration::from_secs(6), rx).await {
        Ok(Ok(result)) => {
            if result.ok {
                Json(
                    result
                        .data
                        .unwrap_or_else(|| serde_json::json!({ "ok": true, "action": action })),
                )
                .into_response()
            } else {
                (
                    StatusCode::BAD_REQUEST,
                    result
                        .error
                        .unwrap_or_else(|| "canvas collaboration request rejected".into()),
                )
                    .into_response()
            }
        }
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "canvas collaboration channel closed",
        )
            .into_response(),
        Err(_) => {
            state.pending.lock().remove(&req_id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "canvas collaboration timed out — is the Lotus window open on the active collaboration canvas?",
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
struct WaitIdleRequest {
    pane_id: String,
    #[serde(default)]
    timeout_ms: Option<u64>,
    /// Optional case-insensitive substrings signalling the cell has returned to a prompt.
    /// Defaults to a common set (shell `$ `, Claude `>`, etc.).
    #[serde(default)]
    signatures: Option<Vec<String>>,
}

/// Signatures indicating a full-screen agent TUI is ready for input. These are
/// distinct from shell prompts because dispatch should generally submit with a
/// carriage return (`\r`) instead of a line feed.
///
/// Each entry must be a stable string that appears once the agent has finished
/// booting and rendered its idle UI. Bias toward fragments that survive ANSI
/// stripping (no escape sequences inside) and that do not appear during boot.
const READY_TUI_SIGNATURES: &[&str] = &[
    // Claude Code footer.
    "? for shortcuts",
    "esc to interrupt",
    // Codex / Gemini / OpenCode persistent status line that only renders once
    // the input prompt is up.
    "ctrl+c to exit",
    // Codex boot banner + model header — these only appear after the CLI has
    // finished its handshake and printed the input box. Catching them avoids
    // falling through to the fragile ANSI-only TUI heuristic which used to
    // misclassify Codex as "busy" indefinitely.
    "openai codex",
    "model: gpt-",
];

/// Signatures indicating a shell-like prompt is ready for command input.
const READY_SHELL_SIGNATURES: &[&str] = &["\n$ ", "\n% ", "\n> "];

/// Hard server-side ceiling, matched to the sidecar's `/v1/wait-cell-idle`
/// client-side timeout slack. The sidecar disconnects at 65s, so we cap
/// marginally under that to always return a body instead of an abort.
const WAIT_IDLE_CEILING_MS: u64 = 60_000;

/// Pick a reasonable default wait timeout for a cell when the caller did not
/// specify one. Agent CLIs take longer to render their first prompt than a
/// shell, so their default is bumped up — otherwise the generic 8s window
/// frequently returns `state="busy"` before the CLI has even finished
/// booting, burning the planner's retry budget on nothing.
fn default_wait_timeout_ms(provider: Option<&str>) -> u64 {
    match provider.map(str::to_ascii_lowercase).as_deref() {
        Some("codex" | "gemini" | "opencode") => 15_000,
        Some("cursor" | "copilot") => 12_000,
        Some("claude" | "claude-headless" | "ccs-hss" | "ccs-hss-headless") => 10_000,
        _ => 8_000,
    }
}

/// Signatures indicating the cell is waiting on a dismissable interactive
/// dialog (welcome screen, confirm, etc.). `auto_dismiss_input` describes
/// how the frontend / Claude can unblock it; `None` means manual user
/// intervention is required (e.g. MCP auth key navigation).
struct DialogPattern {
    needle: &'static str,
    auto_dismiss_input: Option<&'static str>,
}

const DIALOG_PATTERNS: &[DialogPattern] = &[
    DialogPattern {
        needle: "press enter to continue",
        auto_dismiss_input: Some("\r"),
    },
    DialogPattern {
        needle: "press any key",
        auto_dismiss_input: Some("\r"),
    },
    DialogPattern {
        needle: "(y/n)",
        auto_dismiss_input: None,
    },
    DialogPattern {
        needle: "[y/n]",
        auto_dismiss_input: None,
    },
    DialogPattern {
        needle: "continue?",
        auto_dismiss_input: None,
    },
];

/// Patterns that indicate the cell is blocked waiting for the user to
/// authenticate. Each entry MUST be specific enough that random prose / code
/// / memory-observation dumps don't trigger it. The previous shortlist
/// (`needs auth`, `sign in`, `login`) was too loose: claude-mem dumps and
/// markdown observation titles routinely contain those words and were
/// misclassifying ready CCS-HSS panes as auth_required.
const AUTH_REQUIRED_PATTERNS: &[&str] = &[
    // Claude Code's literal MCP server prompt.
    "mcp server needs",
    // Generic CLI sign-in / login prompts (multi-word so they don't match
    // file paths like `loginflow.tsx` or memory titles like `sign in fixed`).
    "please sign in",
    "please log in",
    "authentication required",
    "approval required",
    "authorize this",
];

/// Examine the tail buffer and classify the cell's readiness.
/// Returns (state, matched, suggested_input). `state` is one of
/// "ready_shell", "ready_tui", "dialog", "auth_required", "unknown_tui", or
/// "busy".
fn classify_cell_state(
    tail_lower: &str,
    custom_signatures: Option<&[String]>,
) -> (&'static str, Option<String>, Option<&'static str>) {
    let clean_tail = strip_ansi_sequences(tail_lower);
    let classification_tail = clean_tail.as_str();
    // Custom signatures (if provided) are treated as READY hints and take
    // precedence — they are the caller's explicit intent.
    if let Some(list) = custom_signatures {
        for sig in list {
            if classification_tail.contains(sig) {
                return ("ready_shell", Some(sig.clone()), None);
            }
        }
    } else {
        for sig in READY_TUI_SIGNATURES {
            if classification_tail.contains(&sig.to_lowercase()) {
                return ("ready_tui", Some((*sig).to_string()), None);
            }
        }
        for sig in READY_SHELL_SIGNATURES {
            if classification_tail.contains(&sig.to_lowercase()) {
                return ("ready_shell", Some((*sig).to_string()), None);
            }
        }
    }
    // Only look for dialog patterns in the LAST 256 bytes to reduce false
    // positives from output containing e.g. "press enter" as prose.
    let window = tail_window(classification_tail, 256);
    for pat in AUTH_REQUIRED_PATTERNS {
        if window.contains(pat) {
            return ("auth_required", Some((*pat).to_string()), None);
        }
    }
    for pat in DIALOG_PATTERNS {
        if window.contains(pat.needle) {
            return (
                "dialog",
                Some(pat.needle.to_string()),
                pat.auto_dismiss_input,
            );
        }
    }
    if looks_like_ansi_tui_output(tail_lower, classification_tail) {
        return ("unknown_tui", Some("ansi_tui_output".to_string()), None);
    }
    ("busy", None, None)
}

fn strip_ansi_sequences(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }

        match chars.peek().copied() {
            Some('[') => {
                chars.next();
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next();
                let mut prev_was_esc = false;
                for next in chars.by_ref() {
                    if next == '\u{7}' || (prev_was_esc && next == '\\') {
                        break;
                    }
                    prev_was_esc = next == '\u{1b}';
                }
            }
            Some(_) => {
                let _ = chars.next();
            }
            None => {}
        }
    }
    out
}

fn looks_like_ansi_tui_output(raw_tail: &str, clean_tail: &str) -> bool {
    if !raw_tail.contains('\u{1b}') {
        return false;
    }
    let visible = clean_tail.chars().filter(|c| !c.is_whitespace()).count();
    let escape_count = raw_tail.matches('\u{1b}').count();
    escape_count >= 4 && visible <= 24
}

fn tail_window(input: &str, max_chars: usize) -> String {
    let mut chars: Vec<char> = input.chars().rev().take(max_chars).collect();
    chars.reverse();
    chars.into_iter().collect()
}

fn clean_tail_excerpt(raw_tail: &str, max_chars: usize) -> String {
    let clean = strip_ansi_sequences(raw_tail);
    tail_window(&clean, max_chars)
}

/// Normalize a raw PTY tail for LLM consumption: strip ANSI, fold TUI carriage returns into
/// newlines, and collapse blank-line storms — raw redraw bytes burn the caller's tokens and
/// bury the actual text (`read_cell_output` / `gather_results` feed planners, not terminals).
fn clean_cell_output(raw: &str) -> String {
    let stripped = strip_ansi_sequences(raw);
    let unified = stripped.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(unified.len());
    let mut blank_run = 0usize;
    for line in unified.split('\n') {
        if line.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue; // collapse 2+ consecutive blank lines into one
            }
        } else {
            blank_run = 0;
        }
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out.trim_matches('\n').to_string()
}

fn is_dispatchable_cell_state(state: &str) -> bool {
    matches!(state, "ready_shell" | "ready_tui" | "ready_hook")
}

fn is_settled_cell_state(state: &str) -> bool {
    is_dispatchable_cell_state(state) || matches!(state, "dialog" | "auth_required" | "unknown_tui")
}

fn is_idle_cell_state(state: &str) -> bool {
    is_settled_cell_state(state)
}

fn legacy_cell_state(state: &str) -> &'static str {
    match state {
        "ready_shell" | "ready_tui" | "ready_hook" => "ready",
        "dialog" | "auth_required" => "dialog",
        // `unknown_tui` is "alternate-screen agent has rendered its UI but we
        // didn't pin a known signature". For the planner that's the same
        // dispatchable / idle state as `ready_tui`. Mapping to "busy" caused
        // Bridge to tell users "agent is still booting" for fully-ready
        // Codex / Gemini / Cursor TUIs.
        "unknown_tui" => "ready",
        _ => "busy",
    }
}

/// Outcome of a wait-for-ready poll. `state` names the classified readiness
/// state. `matched` names the signature that tripped the classification;
/// `suggested_input` is the auto-dismiss string for auto-handleable dialogs.
struct WaitOutcome {
    state: &'static str,
    matched: Option<String>,
    suggested_input: Option<&'static str>,
    tail_excerpt: String,
    waited_ms: u64,
}

/// Shared polling loop used by both `wait_cell_idle` (single pane) and
/// `ensure_fleet` (N panes in parallel). Reads the session's output tail,
/// classifies it, and returns as soon as it hits `ready`/`dialog` or the
/// deadline expires. Kept free of auth / HTTP concerns so it can be spawned
/// inside `tokio::spawn` from the batched flow.
/// Bridges the agent-hooks watcher into the MCP turn-state map: every drop file that carries a
/// LOTUS_PANE_ID lands here and (a) updates the pane's turn state for the fleet projection and
/// (b) wakes any in-flight `wait_for_cell_ready` on that pane. Payloads without a pane id
/// (codespace terminals, external CLIs) are ignored — nothing to correlate.
pub struct McpTurnSink(pub SharedState);

impl crate::agent_hooks::HookEventSink for McpTurnSink {
    fn emit_hook(&self, payload: &crate::agent_hooks::DropPayload) {
        if let Some(pane_id) = payload.pane_id.as_deref() {
            let agent_pid = payload.agent_pid.and_then(|pid| u32::try_from(pid).ok());
            if !self
                .0
                .hook_belongs_to_pane(pane_id, agent_pid, payload.session_id.as_deref())
            {
                return;
            }
            self.0
                .record_hook_turn(pane_id, &payload.status, payload.timestamp.max(0) as u64);
        }
    }
}

/// Hook-driven wake for `wait_for_cell_ready`: a stop-hook idle event for `pane_id` that lands
/// AFTER the wait started settles the wait instantly (push), instead of the 180ms output-quiet
/// heuristic discovering it a poll-cycle later. Events older than `since_ms` are ignored — a
/// stale idle from a previous turn must not settle a wait on freshly-dispatched work.
pub struct HookTurnWatch {
    state: SharedState,
    pane_id: String,
    since_ms: u64,
}

impl HookTurnWatch {
    pub fn new(state: SharedState, pane_id: String, since_ms: u64) -> Self {
        Self {
            state,
            pane_id,
            since_ms,
        }
    }

    /// True when the pane's last hook event is a settled turn end newer than the wait start.
    fn hook_settled(&self) -> bool {
        self.state
            .pane_turn(&self.pane_id)
            .is_some_and(|(status, at)| {
                at >= self.since_ms && matches!(status.as_str(), "idle" | "needs-input")
            })
    }
}

async fn wait_for_cell_ready(
    pty: PtyState,
    session_id: &str,
    timeout_ms: u64,
    custom_sigs_lower: Option<Vec<String>>,
    hook: Option<HookTurnWatch>,
) -> WaitOutcome {
    let started = Instant::now();
    let deadline = started + Duration::from_millis(timeout_ms);
    loop {
        // Push signal first: a stop-hook turn end is exact and instant — the tail heuristic
        // below stays as the fallback for runners without hooks.
        if let Some(watch) = hook.as_ref() {
            if watch.hook_settled() {
                let tail = pty::read_output_tail(session_id, 8192, &pty);
                return WaitOutcome {
                    state: "ready_hook",
                    matched: Some("stop-hook".to_string()),
                    suggested_input: None,
                    tail_excerpt: clean_tail_excerpt(&tail, 512),
                    waited_ms: started.elapsed().as_millis() as u64,
                };
            }
        }
        // Read a larger tail (8 KB) so CLI banners do not push the prompt /
        // dialog text out of view.
        let tail = pty::read_output_tail(session_id, 8192, &pty);
        let lowered = tail.to_lowercase();
        let (cell_state, matched, suggested) =
            classify_cell_state(&lowered, custom_sigs_lower.as_deref());
        let settled = is_settled_cell_state(cell_state);
        let expired = Instant::now() >= deadline;
        if settled || expired {
            let tail_out = clean_tail_excerpt(&tail, 512);
            return WaitOutcome {
                state: if settled || cell_state == "unknown_tui" {
                    cell_state
                } else {
                    "busy"
                },
                matched: if settled || cell_state == "unknown_tui" {
                    matched
                } else {
                    None
                },
                suggested_input: if settled { suggested } else { None },
                tail_excerpt: tail_out,
                waited_ms: started.elapsed().as_millis() as u64,
            };
        }
        // Sleep until the next heuristic poll — or earlier, the moment a hook event lands.
        // A notify race just falls back to the 180ms tick, so wakes are best-effort but bounded.
        match hook.as_ref() {
            Some(watch) => {
                tokio::select! {
                    _ = watch.state.turn_notify.notified() => {}
                    _ = tokio::time::sleep(Duration::from_millis(180)) => {}
                }
            }
            None => tokio::time::sleep(Duration::from_millis(180)).await,
        }
    }
}

async fn wait_cell_idle(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<WaitIdleRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    // Same race as dispatch_to_cell: when called immediately after spawn the
    // pane's session may not yet be visible in the fleet snapshot. Wait
    // briefly before declaring 404.
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);
    const POLL_MAX: std::time::Duration = std::time::Duration::from_millis(3_000);
    let session_resolve_started = std::time::Instant::now();
    let session_id = loop {
        if let Some(sid) = state.resolve_session_id(&req.pane_id) {
            break sid;
        }
        if session_resolve_started.elapsed() >= POLL_MAX {
            return (
                StatusCode::NOT_FOUND,
                format!("no live session for paneId={}", req.pane_id),
            )
                .into_response();
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    };
    let Some(pty) = state.pty.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "PTY state unavailable").into_response();
    };
    let effective_timeout_ms = req
        .timeout_ms
        .unwrap_or_else(|| default_wait_timeout_ms(state.resolve_provider(&req.pane_id).as_deref()))
        .min(WAIT_IDLE_CEILING_MS);
    let custom_sigs_lower: Option<Vec<String>> = match req.signatures.as_ref() {
        Some(list) if !list.is_empty() => Some(list.iter().map(|s| s.to_lowercase()).collect()),
        _ => None,
    };

    // Hook watch keyed by the resolved member's pane_id (LOTUS_PANE_ID correlation) so a v2
    // address still matches the hook's raw pane key.
    let hook_pane = state
        .resolve_fleet_member(&req.pane_id)
        .map(|m| m.pane_id)
        .unwrap_or_else(|| req.pane_id.clone());
    let hook = Some(HookTurnWatch::new(state.clone(), hook_pane, now_ms()));
    let outcome = wait_for_cell_ready(
        pty,
        &session_id,
        effective_timeout_ms,
        custom_sigs_lower,
        hook,
    )
    .await;
    let idle = is_idle_cell_state(outcome.state);
    Json(serde_json::json!({
        "ok": true,
        "idle": idle,
        "state": legacy_cell_state(outcome.state),
        "readiness": outcome.state,
        "matched": outcome.matched,
        "suggestedInput": outcome.suggested_input,
        "tail": outcome.tail_excerpt,
        "waitedMs": outcome.waited_ms,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct HookStopRequest {
    pane_id: String,
    /// Claude conversation id parsed by the stop-hook script from the Stop
    /// hook's stdin JSON; forwarded to the frontend for turn↔conversation
    /// correlation. `serde(default)` keeps older hooks (codex notify, legacy
    /// inline curl) posting `pane_id`-only payloads working unchanged.
    #[serde(default)]
    session_id: Option<String>,
    /// PID of the agent-CLI process that fired the hook (`$PPID` inside the
    /// script). Enables nested-`claude -p` attribution — see
    /// [`nested_stop::hook_not_from_pane`]. Optional for the same
    /// backward-compat reason as `session_id`.
    #[serde(default)]
    agent_pid: Option<u32>,
    /// `StopFailure`'s error type (`rate_limit` is the only one the hook is registered for); empty
    /// on a plain `Stop`.
    #[serde(default)]
    error: Option<String>,
    /// The CLI's own words for it, e.g. "You've hit your 5-hour limit · resets 2:20pm".
    #[serde(default)]
    message: Option<String>,
}

/// Payload for the `mcp://agent-stopped` Tauri event. `sessionId` is an
/// explicit `null` (not omitted) when the hook did not report one, so the
/// frontend can rely on the key existing.
fn agent_stopped_payload(pane_id: &str, session_id: Option<&str>) -> serde_json::Value {
    serde_json::json!({ "paneId": pane_id, "sessionId": session_id })
}

/// What a pane shows when its turn died on a usage limit; `None` for every other turn end.
fn usage_limit_text(error: Option<&str>, message: Option<&str>) -> Option<String> {
    if error.map(str::trim) != Some("rate_limit") {
        return None;
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    Some(message.unwrap_or("Usage limit reached").to_string())
}

/// Hook endpoint hit by Claude Code's `Stop` hook and Codex's `notify` script
/// when an agent finishes a turn. Fire-and-forget: validates and emits a Tauri
/// event for the frontend's notification layer, then always returns 200 so the
/// upstream curl never blocks the agent. The Tauri-event broadcast itself is
/// best-effort — if no `AppHandle` is registered yet (e.g. server starts
/// before the window) the call is silently dropped.
///
/// Nested-agent suppression: a `claude -p` run INSIDE an agent pane inherits
/// `LOTUS_PANE_ID`, so its Stop hook would fire a false "pane done" while the
/// pane's main agent is still working. When the request carries `agent_pid`
/// and the pane resolves to a live PTY child, we walk the reporting process's
/// ancestry (see [`nested_stop`]) and swallow nested stops — returning
/// `{"ok": true, "nested": true}` WITHOUT recording turn state or emitting.
/// Every missing piece (no `agent_pid`, unresolved pane, no child pid, proc
/// lookup failure) fails open to today's behavior: better an occasional early
/// wake than a dropped turn-end signal.
async fn hook_stop(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<HookStopRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    let pane_id = req.pane_id.trim().to_string();
    if pane_id.is_empty() {
        return (StatusCode::BAD_REQUEST, "pane_id is required").into_response();
    }
    let session_id = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    if !state.hook_belongs_to_pane(&pane_id, req.agent_pid, session_id.as_deref()) {
        // Acknowledge so the hook's curl succeeds, but do NOT touch pane
        // turn-state or wake the frontend — the pane's main agent still owns
        // this pane's "done" signal.
        return Json(serde_json::json!({ "ok": true, "nested": true })).into_response();
    }

    // Feed the pane turn-state FIRST: this curl hook is the fastest turn-end signal (no node
    // process, no fs-watcher debounce), and recording it wakes any in-flight wait_cell_idle
    // instantly (ready_hook). The drop-file path remains as the richer, event-typed source.
    state.record_hook_turn(&pane_id, "idle", now_ms());
    let mut payload = agent_stopped_payload(&pane_id, session_id.as_deref());
    if let Some(limit) = usage_limit_text(req.error.as_deref(), req.message.as_deref()) {
        payload["limit"] = serde_json::Value::String(limit);
    }
    let _ = state.emit_to_frontend("mcp://agent-stopped", payload);
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Upper bound for `count` on `/v1/ensure-fleet` to prevent an accidental
/// spawn-storm from a malformed prompt. 16 is well above any realistic fleet
/// size the planner would ask for in one turn; anything above is almost
/// certainly a mistake.
const ENSURE_FLEET_MAX_COUNT: u64 = 16;

/// Per-spawn emit timeout. Matches `spawn_cell` (6s) + small slack so the
/// batched flow still rides the same "frontend resolves fast" assumption
/// individual spawn calls already rely on.
const ENSURE_FLEET_SPAWN_TIMEOUT_MS: u64 = 8_000;
const ENSURE_FLEET_CLOSE_TIMEOUT_MS: u64 = 6_000;

#[derive(Deserialize)]
struct EnsureFleetRequest {
    provider: String,
    count: u64,
    #[serde(default)]
    workspace_id: Option<String>,
    /// When true, block until each freshly-spawned cell reaches `ready`
    /// (or `dialog`), up to the provider-aware default or `wait_timeout_ms`.
    #[serde(default)]
    wait_ready: bool,
    #[serde(default)]
    wait_timeout_ms: Option<u64>,
    /// Pane id of the agent that asked for this fleet (`LOTUS_PANE_ID`). Carried for the same
    /// reason as on `spawn_cell`: ensure_fleet creates cells, so it shares the depth ceiling.
    #[serde(default)]
    from_pane_id: Option<String>,
}

/// Ensure the alive count of `provider` in the target workspace equals
/// `count`, in a single atomic round-trip: list → delta → (spawn N ‖ close M)
/// → optional wait_ready. Collapses what would be 3-4 separate Claude
/// tool turns into one, shaving the per-turn LLM latency.
async fn ensure_fleet(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(req): Json<EnsureFleetRequest>,
) -> Response {
    if let Err(resp) = check_auth(&headers, state.secret()) {
        return resp;
    }
    if req.provider.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "provider required").into_response();
    }
    if req.count > ENSURE_FLEET_MAX_COUNT {
        return (
            StatusCode::BAD_REQUEST,
            format!("count {} exceeds max {}", req.count, ENSURE_FLEET_MAX_COUNT),
        )
            .into_response();
    }

    let provider_lc = req.provider.trim().to_ascii_lowercase();
    let fleet = state.fleet_snapshot();
    // Matching alive cells, preserving snapshot order so "close oldest first"
    // picks the earliest-pushed entries (approx = oldest created in the UI).
    let matching: Vec<McpFleetMember> = fleet
        .into_iter()
        .filter(|m| {
            if !m.is_alive {
                return false;
            }
            if m.provider.to_ascii_lowercase() != provider_lc {
                return false;
            }
            if let Some(ws) = &req.workspace_id {
                if &m.workspace_id != ws {
                    return false;
                }
            }
            true
        })
        .collect();

    let alive_before = matching.len() as u64;
    let desired = req.count;

    let mut spawned: Vec<serde_json::Value> = Vec::new();
    let mut closed: Vec<serde_json::Value> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    if desired > alive_before {
        let delta = desired - alive_before;
        let mut handles = Vec::with_capacity(delta as usize);
        for _ in 0..delta {
            let state_cloned = state.clone();
            let provider = req.provider.clone();
            let workspace_id = req.workspace_id.clone();
            let from_pane_id = req.from_pane_id.clone();
            handles.push(tokio::spawn(async move {
                let (req_id, rx) = state_cloned.register_pending();
                let payload = serde_json::json!({
                    "requestId": req_id,
                    "provider": provider,
                    "workspaceId": workspace_id,
                    "fromPaneId": from_pane_id,
                });
                if let Err(err) = state_cloned.emit_to_frontend("mcp://spawn-cell", payload) {
                    state_cloned.pending.lock().remove(&req_id);
                    return Err(format!("emit failed: {err}"));
                }
                match tokio::time::timeout(Duration::from_millis(ENSURE_FLEET_SPAWN_TIMEOUT_MS), rx)
                    .await
                {
                    Ok(Ok(result)) => {
                        if result.ok {
                            Ok(result.data.unwrap_or_else(|| serde_json::json!({})))
                        } else {
                            Err(result.error.unwrap_or_else(|| "spawn failed".into()))
                        }
                    }
                    Ok(Err(_)) => Err("spawn channel closed".into()),
                    Err(_) => {
                        state_cloned.pending.lock().remove(&req_id);
                        Err("spawn timed out".into())
                    }
                }
            }));
        }
        for h in handles {
            match h.await {
                Ok(Ok(v)) => spawned.push(v),
                Ok(Err(e)) => errors.push(format!("spawn: {e}")),
                Err(e) => errors.push(format!("spawn task join: {e}")),
            }
        }
    } else if desired < alive_before {
        let to_close = (alive_before - desired) as usize;
        let targets: Vec<String> = matching
            .iter()
            .take(to_close)
            .map(|m| m.pane_id.clone())
            .collect();
        let mut handles = Vec::with_capacity(targets.len());
        for pane_id in targets {
            let state_cloned = state.clone();
            handles.push(tokio::spawn(async move {
                let (req_id, rx) = state_cloned.register_pending();
                let payload = serde_json::json!({
                    "requestId": req_id,
                    "paneId": pane_id,
                });
                if let Err(err) = state_cloned.emit_to_frontend("mcp://close-cell", payload) {
                    state_cloned.pending.lock().remove(&req_id);
                    return Err((pane_id, format!("emit failed: {err}")));
                }
                match tokio::time::timeout(Duration::from_millis(ENSURE_FLEET_CLOSE_TIMEOUT_MS), rx)
                    .await
                {
                    Ok(Ok(result)) => {
                        if result.ok {
                            Ok(result.data.unwrap_or_else(
                                || serde_json::json!({ "ok": true, "paneId": pane_id }),
                            ))
                        } else {
                            Err((
                                pane_id,
                                result.error.unwrap_or_else(|| "close failed".into()),
                            ))
                        }
                    }
                    Ok(Err(_)) => Err((pane_id, "close channel closed".into())),
                    Err(_) => {
                        state_cloned.pending.lock().remove(&req_id);
                        Err((pane_id, "close timed out".into()))
                    }
                }
            }));
        }
        for h in handles {
            match h.await {
                Ok(Ok(v)) => closed.push(v),
                Ok(Err((pane, e))) => errors.push(format!("close {pane}: {e}")),
                Err(e) => errors.push(format!("close task join: {e}")),
            }
        }
    }

    let mut ready: Vec<serde_json::Value> = Vec::new();
    let mut busy: Vec<serde_json::Value> = Vec::new();
    if req.wait_ready && !spawned.is_empty() {
        if let Some(pty) = state.pty.clone() {
            let timeout_ms = req
                .wait_timeout_ms
                .unwrap_or_else(|| default_wait_timeout_ms(Some(&provider_lc)))
                .min(WAIT_IDLE_CEILING_MS);

            // Pair each spawned paneId with its session id. Prefer the id
            // the spawn response already carries; fall back to the fresh
            // fleet snapshot if the frontend only returned the paneId.
            let mut wait_handles = Vec::with_capacity(spawned.len());
            for entry in &spawned {
                let Some(pane_id) = entry.get("paneId").and_then(|v| v.as_str()) else {
                    continue;
                };
                let session_id = entry
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| state.resolve_session_id(pane_id));
                let Some(session_id) = session_id else {
                    errors.push(format!("wait {pane_id}: no session id"));
                    continue;
                };
                let pane_id = pane_id.to_string();
                let pty_cloned = pty.clone();
                let hook = Some(HookTurnWatch::new(state.clone(), pane_id.clone(), now_ms()));
                wait_handles.push(tokio::spawn(async move {
                    let outcome =
                        wait_for_cell_ready(pty_cloned, &session_id, timeout_ms, None, hook).await;
                    (pane_id, outcome)
                }));
            }
            for h in wait_handles {
                match h.await {
                    Ok((pane_id, outcome)) => {
                        let entry = serde_json::json!({
                            "paneId": pane_id,
                            "state": legacy_cell_state(outcome.state),
                            "readiness": outcome.state,
                            "waitedMs": outcome.waited_ms,
                        });
                        if is_dispatchable_cell_state(outcome.state) || outcome.state == "dialog" {
                            ready.push(entry);
                        } else {
                            busy.push(entry);
                        }
                    }
                    Err(e) => errors.push(format!("wait task join: {e}")),
                }
            }
        } else {
            errors.push("wait skipped: PTY state unavailable".into());
        }
    }

    Json(serde_json::json!({
        "ok": errors.is_empty(),
        "provider": req.provider,
        "requested": desired,
        "aliveBefore": alive_before,
        "spawned": spawned,
        "closed": closed,
        "ready": ready,
        "busy": busy,
        "errors": errors,
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_hook_turn_roundtrips_and_last_write_wins() {
        let state = McpIpcState::default();
        assert!(state.pane_turn("node-1").is_none());
        state.record_hook_turn("node-1", "running", 100);
        state.record_hook_turn("node-1", "idle", 200);
        assert_eq!(state.pane_turn("node-1"), Some(("idle".to_string(), 200)));
        assert!(state.pane_turn("node-2").is_none());
    }

    #[test]
    fn pane_turns_for_omits_panes_with_no_recorded_fact() {
        // Absent must stay absent. A default here ("idle") would make every hook-less runner —
        // cursor, a non-claude custom command — look settled at the prompt, which is the exact
        // class of lie `plans/honest-agent-status/` exists to remove.
        let state = McpIpcState::default();
        state.record_hook_turn("canvas:cp_1:node-a", "needs-input", now_ms());

        let out = state.pane_turns_for(&[
            "canvas:cp_1:node-a".to_string(),
            "canvas:cp_1:node-b".to_string(),
        ]);

        assert_eq!(out.len(), 1, "only the pane with a fact is reported");
        assert_eq!(out[0].pane_id, "canvas:cp_1:node-a");
        assert_eq!(out[0].turn, "needs-input");
    }

    #[test]
    fn pane_turns_for_reports_age_not_the_raw_timestamp() {
        let state = McpIpcState::default();
        state.record_hook_turn("p-1", "running", now_ms().saturating_sub(5_000));

        let out = state.pane_turns_for(&["p-1".to_string()]);

        assert_eq!(out.len(), 1);
        assert!(
            out[0].turn_age_ms >= 5_000,
            "age is measured from the recorded timestamp, got {}",
            out[0].turn_age_ms
        );
    }

    #[test]
    fn pane_turns_for_never_underflows_on_a_future_timestamp() {
        // A hook drop's timestamp comes from another process's clock. `saturating_sub` is what
        // keeps a slightly-ahead clock from reporting an age of ~584 million years, which a
        // freshness window downstream would read as "ancient" and discard.
        let state = McpIpcState::default();
        state.record_hook_turn("p-1", "needs-input", now_ms() + 60_000);

        let out = state.pane_turns_for(&["p-1".to_string()]);

        assert_eq!(out[0].turn_age_ms, 0);
    }

    #[test]
    fn pane_turns_for_preserves_the_requested_order_and_ignores_extras() {
        let state = McpIpcState::default();
        state.record_hook_turn("p-1", "idle", now_ms());
        state.record_hook_turn("p-2", "running", now_ms());
        state.record_hook_turn("p-unasked", "needs-input", now_ms());

        let out = state.pane_turns_for(&["p-2".to_string(), "p-1".to_string()]);

        let ids: Vec<&str> = out.iter().map(|s| s.pane_id.as_str()).collect();
        assert_eq!(ids, vec!["p-2", "p-1"], "the caller's order is preserved");
    }

    #[test]
    fn record_hook_turn_does_not_fail_without_an_app_handle() {
        // The emit is best-effort: the HTTP server can start before the window registers its
        // AppHandle, and a hook must never fail because the UI is not up yet. Recording must
        // still take effect so a late frontend can hydrate.
        let state = McpIpcState::default();
        state.record_hook_turn("p-1", "needs-input", 42);
        assert_eq!(
            state.pane_turn("p-1"),
            Some(("needs-input".to_string(), 42))
        );
    }

    #[tokio::test]
    async fn wait_for_cell_ready_wakes_instantly_on_hook_idle() {
        // No PTY session exists, so the output heuristic alone would poll until the 10s deadline.
        // A stop-hook idle event for the watched pane must settle the wait immediately.
        let state: SharedState = Arc::new(McpIpcState::default());
        let pty: PtyState = Arc::new(std::sync::Mutex::new(crate::pty::PtyStore::default()));
        let watch = HookTurnWatch::new(state.clone(), "node-1".to_string(), 0);
        let waiter = tokio::spawn(async move {
            wait_for_cell_ready(pty, "no-such-session", 10_000, None, Some(watch)).await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        state.record_hook_turn("node-1", "idle", now_ms());
        let outcome = tokio::time::timeout(Duration::from_secs(2), waiter)
            .await
            .expect("hook wake within 2s")
            .expect("join");
        assert_eq!(outcome.state, "ready_hook");
        assert_eq!(outcome.matched.as_deref(), Some("stop-hook"));
    }

    #[tokio::test]
    async fn wait_for_cell_ready_ignores_hook_idle_older_than_the_wait() {
        // A stale idle from a PREVIOUS turn (recorded before the wait started) must not settle the
        // wait — the agent may have just been dispatched new work.
        let state: SharedState = Arc::new(McpIpcState::default());
        let pty: PtyState = Arc::new(std::sync::Mutex::new(crate::pty::PtyStore::default()));
        state.record_hook_turn("node-1", "idle", 5); // long before since_ms below
        let watch = HookTurnWatch::new(state.clone(), "node-1".to_string(), now_ms());
        let outcome = wait_for_cell_ready(pty, "no-such-session", 400, None, Some(watch)).await;
        assert_ne!(outcome.state, "ready_hook");
    }

    #[test]
    fn program_status_sink_records_osc_7501_and_passes_bytes_through() {
        let state: SharedState = Arc::new(McpIpcState::default());
        let seen = Arc::new(ParkMutex::new(Vec::<u8>::new()));
        let seen_in = Arc::clone(&seen);
        let mut sink = Arc::clone(&state).program_status_sink(
            "pane-pi".into(),
            Box::new(move |d| {
                seen_in.lock().extend_from_slice(&d);
                false
            }),
        );
        assert_eq!(state.pane_turn("pane-pi"), None);
        sink(b"hi\x1b]7501;state=working:app=pi\x1b\\".to_vec());
        assert_eq!(state.pane_turn("pane-pi").unwrap().0, "running");
        sink(b"\x1b]7501;state=blocked:kind=question\x07".to_vec());
        assert_eq!(state.pane_turn("pane-pi").unwrap().0, "needs-input");
        sink(b"\x1b]7501;state=done\x1b\\".to_vec());
        assert_eq!(state.pane_turn("pane-pi").unwrap().0, "idle");
        assert!(seen.lock().starts_with(b"hi\x1b]7501;"));
    }

    #[test]
    fn mcp_turn_sink_records_pane_correlated_hook_events_and_ignores_the_rest() {
        use crate::agent_hooks::HookEventSink;
        let state: SharedState = Arc::new(McpIpcState::default());
        let sink = McpTurnSink(state.clone());

        let mut payload = crate::agent_hooks::DropPayload {
            version: 1,
            session_id: Some("conv-1".into()),
            agent_type: "claude".into(),
            event: "stop".into(),
            status: "idle".into(),
            title: String::new(),
            body: String::new(),
            user_prompt: String::new(),
            tool_target: String::new(),
            lines_added: None,
            lines_removed: None,
            body_truncated: false,
            transcript_path: String::new(),
            cwd: "/tmp/proj".into(),
            pid: None,
            agent_pid: None,
            pane_id: Some("node-atlas-1".into()),
            timestamp: 1_714_000_000_000,
        };
        sink.emit_hook(&payload);
        assert_eq!(
            state.pane_turn("node-atlas-1"),
            Some(("idle".to_string(), 1_714_000_000_000))
        );

        // Codespace/external drops carry no pane id → nothing to correlate, no phantom entries.
        payload.pane_id = None;
        payload.status = "running".into();
        sink.emit_hook(&payload);
        assert_eq!(state.pane_turn("node-atlas-1").unwrap().0, "idle");
    }

    #[test]
    fn ready_hook_is_dispatchable_and_maps_to_legacy_ready() {
        assert!(is_dispatchable_cell_state("ready_hook"));
        assert!(is_idle_cell_state("ready_hook"));
        assert_eq!(legacy_cell_state("ready_hook"), "ready");
    }

    #[test]
    fn dispatch_rate_guard_counts_only_dispatches_within_the_window() {
        // now=20_000, window=20_000: t=0 is exactly the window ago (excluded); 5_000 & 19_000 count.
        assert_eq!(dispatches_in_window(&[0, 5_000, 19_000], 20_000, 20_000), 2);
        assert_eq!(dispatches_in_window(&[], 100, 20_000), 0);
        assert_eq!(
            dispatches_in_window(&[18_000, 19_000, 19_999], 20_000, 20_000),
            3
        );
        // all stale → none count, so a fresh dispatch is allowed again
        assert_eq!(dispatches_in_window(&[0, 100, 200], 1_000_000, 20_000), 0);
    }

    fn member(pane: &str, ws: &str) -> McpFleetMember {
        McpFleetMember {
            pane_id: pane.into(),
            agent_address: None,
            surface: None,
            runtime_id: None,
            team_id: None,
            member_id: None,
            address: None,
            workspace_label: None,
            fleet_schema_version: None,
            workspace_id: ws.into(),
            cwd: "/tmp".into(),
            provider: "claude".into(),
            display_name: "Claude".into(),
            legacy_aliases: vec![],
            aliases: vec![],
            status: "live".into(),
            is_alive: true,
            last_output_preview: None,
            headline: None,
            session_id: None,
            gating: None,
            can_reply: None,
            can_queue: None,
            mcp_tools_available: None,
            reports_steps: None,
            runner_label: None,
        }
    }

    /// A canvas pane that can be remembered: alive, and with a session to prove it.
    fn canvas_pane(pane: &str, ws: &str, session: &str) -> McpFleetMember {
        McpFleetMember {
            session_id: Some(session.into()),
            ..member(pane, ws)
        }
    }

    // ─── Canvas identity reconciliation (2026-08-10) ─────────────────────────
    //
    // Measured on a live desktop: a Nova belonging to `terax-ai` reached Lotus Pocket
    // carrying `terax-ai`'s pane id and `codespace-demo`'s workspace id, label and cwd.
    // The phone listed it under codespace-demo, and a dispatch to that row would have
    // landed in the other repo. The frontend no longer produces it; this is the guard
    // that keeps it unrepresentable in stored state whatever a producer sends.

    #[test]
    fn a_pane_scoped_to_another_project_is_repaired_to_its_own() {
        let mut mis_stamped = canvas_pane("canvas:cp_terax:n-nova", "canvas:cp_demo", "sess-nova");
        mis_stamped.workspace_label = Some("codespace-demo".into());
        mis_stamped.cwd = "/repos/terax-ai".into();

        assert!(reconcile_canvas_identity(&mut mis_stamped));
        assert_eq!(mis_stamped.workspace_id, "canvas:cp_terax");
        // Dropped rather than rewritten: they described the other project, and nothing
        // at this layer can look the right ones up.
        assert_eq!(mis_stamped.workspace_label, None);
        assert_eq!(mis_stamped.cwd, "");
    }

    #[test]
    fn a_pane_that_agrees_with_its_workspace_is_left_exactly_as_it_came() {
        let mut ok = canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "sess-1");
        ok.workspace_label = Some("codespace-demo".into());
        let before = ok.clone();

        assert!(!reconcile_canvas_identity(&mut ok));
        assert_eq!(ok, before);
    }

    #[test]
    fn a_pane_id_that_names_no_project_is_never_second_guessed() {
        // A CodeSpace/Swarm pane id, and a canvas pane launched before its board resolved
        // its project id, both carry no project — there is nothing to check them against,
        // so a guess here would invent the very mismatch it is meant to catch.
        for pane in [
            "plain-uuid",
            "canvas:only-one-part",
            "canvas::n1",
            "canvas:cp_x:",
        ] {
            let mut member = canvas_pane(pane, "canvas:cp_demo", "sess-x");
            assert!(
                !reconcile_canvas_identity(&mut member),
                "{pane} should not be reconciled"
            );
            assert_eq!(member.workspace_id, "canvas:cp_demo");
        }
    }

    #[test]
    fn a_push_reports_every_pane_it_had_to_repair() {
        let mut push = vec![
            canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "s1"),
            canvas_pane("canvas:cp_terax:n2", "canvas:cp_demo", "s2"),
            canvas_pane("canvas:cp_other:n3", "canvas:cp_demo", "s3"),
        ];

        assert_eq!(
            reconcile_canvas_fleet(&mut push),
            vec![
                "canvas:cp_terax:n2".to_string(),
                "canvas:cp_other:n3".to_string()
            ],
        );
        assert_eq!(push[0].workspace_id, "canvas:cp_demo");
        assert_eq!(push[1].workspace_id, "canvas:cp_terax");
        assert_eq!(push[2].workspace_id, "canvas:cp_other");
    }

    #[test]
    fn a_mis_stamped_pane_is_repaired_before_it_can_reach_the_roster() {
        // The roster is the reason this has to happen at ingestion: it outlives the board
        // that pushed it, so a member filed wrong is resurrected for as long as its PTY
        // lives, with nothing left that would ever correct it.
        let state = McpIpcState::new("secret".into());
        let mut mis_stamped = canvas_pane("canvas:cp_terax:n-nova", "canvas:cp_demo", "sess-nova");
        mis_stamped.workspace_label = Some("codespace-demo".into());
        state.replace_canvas_fleet("w1", vec![mis_stamped]);

        let snapshot = state.fleet_snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].workspace_id, "canvas:cp_terax");
        assert_eq!(snapshot[0].workspace_label, None);
    }

    // ─── Canvas roster (2026-08-09) ──────────────────────────────────────────
    //
    // A canvas board only ever holds the project on screen, so switching project
    // used to delete every other project's agents from the fleet while their
    // processes kept running. Measured that day: four live PTY sessions, two in a
    // switched-away project, and `/api/fleet` reporting one member — which Lotus
    // Pocket drew as `no agents` for a project that was busy.

    #[test]
    fn a_pane_survives_the_board_that_stopped_drawing_it() {
        let mut roster = HashMap::new();
        let terax = canvas_pane("canvas:cp_terax:n1", "canvas:cp_terax", "sess-terax");
        apply_canvas_push(&mut roster, "w1", &[terax.clone()], |_| true);

        // The operator switches project: the board now pushes only the other one.
        let demo = canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "sess-demo");
        apply_canvas_push(&mut roster, "w1", &[demo.clone()], |_| true);

        let combined = compose_canvas_members(
            vec![demo.clone()],
            roster.values().map(|e| e.member.clone()).collect(),
            |_| true,
        );

        let panes: HashSet<&str> = combined.iter().map(|m| m.pane_id.as_str()).collect();
        assert!(
            panes.contains("canvas:cp_terax:n1"),
            "an agent whose project was switched away from is still running, and the \
             phone has no other way to learn that: {panes:?}"
        );
        assert_eq!(
            combined.len(),
            2,
            "the on-screen pane must not be duplicated"
        );
    }

    #[test]
    fn a_dead_session_is_not_resurrected() {
        let gone = canvas_pane("canvas:cp_terax:n1", "canvas:cp_terax", "sess-gone");
        let combined = compose_canvas_members(vec![], vec![gone], |_| false);
        assert!(
            combined.is_empty(),
            "the roster can keep a ghost, but liveness is what decides — an entry \
             whose PTY session ended must not come back"
        );
    }

    #[test]
    fn the_open_board_wins_over_what_was_remembered() {
        let remembered = McpFleetMember {
            status: "live".into(),
            ..canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "sess-demo")
        };
        let on_screen = McpFleetMember {
            status: "stalled".into(),
            ..remembered.clone()
        };

        let combined = compose_canvas_members(vec![on_screen], vec![remembered], |_| true);

        assert_eq!(combined.len(), 1);
        assert_eq!(
            combined[0].status, "stalled",
            "a board that is open reports this second; the roster reports whenever \
             its project was last drawn"
        );
    }

    #[test]
    fn a_pane_the_board_calls_finished_is_dropped() {
        let mut roster = HashMap::new();
        let running = canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "sess-demo");
        apply_canvas_push(&mut roster, "w1", &[running.clone()], |_| true);

        let finished = McpFleetMember {
            is_alive: false,
            status: "exited".into(),
            ..running
        };
        apply_canvas_push(&mut roster, "w1", &[finished], |_| true);

        assert!(
            roster.is_empty(),
            "the board is the authority on an agent being done — a still-open shell \
             must not put a completed agent back on the operator's phone"
        );
    }

    #[test]
    fn a_pane_with_no_session_is_never_filed() {
        let mut roster = HashMap::new();
        // `session_id: None` — nothing could ever verify or prune this entry.
        apply_canvas_push(
            &mut roster,
            "w1",
            &[member("canvas:cp_demo:n1", "canvas:cp_demo")],
            |_| true,
        );
        assert!(roster.is_empty());
    }

    #[test]
    fn destroying_a_window_forgets_its_panes_although_their_shells_live_on() {
        let state = McpIpcState::new("s".into());
        let pane = canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "sess-demo");
        state.canvas_roster.write().insert(
            pane.pane_id.clone(),
            RosterEntry {
                window: "w1".into(),
                member: pane,
            },
        );

        state.evict_window_fleet("w2");
        assert_eq!(
            state.canvas_roster.read().len(),
            1,
            "another window's close is not this one's"
        );

        state.evict_window_fleet("w1");
        assert!(
            state.canvas_roster.read().is_empty(),
            "closing a window does not end its PTY sessions, so liveness alone would \
             keep these panes forever with no board left to update them"
        );
    }

    #[test]
    fn closing_a_pane_forgets_it_although_its_shell_lives_on() {
        let state = McpIpcState::new("s".into());
        let pane = canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "sess-demo");
        // Seeded rather than pushed: these constructors carry no PTY state, so a
        // push would prune the entry in the same call — which is what
        // `without_pty_state_nothing_is_resurrected` pins down. Here the subject is
        // the close itself.
        state.canvas_roster.write().insert(
            pane.pane_id.clone(),
            RosterEntry {
                window: "w1".into(),
                member: pane.clone(),
            },
        );

        state.forget_canvas_cell("canvas:cp_demo:n1");
        assert!(
            state.canvas_roster.read().is_empty(),
            "a closed pane and a switched-away one are indistinguishable from Rust \
             until the session ends, so closing is the one event only the UI can report"
        );
    }

    #[test]
    fn without_pty_state_nothing_is_resurrected() {
        // Every test constructor leaves `pty: None`, as do headless paths. Nothing
        // can be verified there, so the live buckets must answer exactly as before.
        let state = McpIpcState::new("s".into());
        let pane = canvas_pane("canvas:cp_demo:n1", "canvas:cp_demo", "sess-demo");
        state.replace_canvas_fleet("w1", vec![pane]);
        state.replace_canvas_fleet("w1", vec![]);

        assert!(
            state.fleet_snapshot().is_empty(),
            "unverifiable liveness must read as absent, not as alive"
        );
    }

    fn state_with(secret: &str, fleet: Vec<McpFleetMember>) -> SharedState {
        let s = Arc::new(McpIpcState::new(secret.to_string()));
        s.replace_fleet("w-test", fleet);
        s
    }

    async fn start_test_server(state: SharedState) -> McpIpcHandle {
        start_mcp_ipc(state).await.expect("start ipc")
    }

    async fn post_json(
        port: u16,
        path: &str,
        auth: Option<&str>,
        body: serde_json::Value,
    ) -> (u16, String) {
        let client = reqwest::Client::new();
        let mut req = client
            .post(format!("http://127.0.0.1:{port}{path}"))
            .json(&body);
        if let Some(token) = auth {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let resp = req.send().await.expect("send");
        let status = resp.status().as_u16();
        let text = resp.text().await.expect("text");
        (status, text)
    }

    /// Sends an arbitrary body with an arbitrary (or absent) content-type — the only way to
    /// reproduce the three malformed-request shapes `post_json` makes impossible by construction.
    async fn post_raw(
        port: u16,
        path: &str,
        auth: Option<&str>,
        content_type: Option<&str>,
        body: &str,
    ) -> (u16, String) {
        let client = reqwest::Client::new();
        let mut req = client
            .post(format!("http://127.0.0.1:{port}{path}"))
            .body(body.to_string());
        if let Some(ct) = content_type {
            req = req.header("content-type", ct);
        }
        if let Some(token) = auth {
            req = req.header("authorization", format!("Bearer {token}"));
        }
        let resp = req.send().await.expect("send");
        let status = resp.status().as_u16();
        let text = resp.text().await.expect("text");
        (status, text)
    }

    #[tokio::test]
    async fn rejects_missing_auth() {
        let state = state_with("s3cr3t", vec![]);
        let handle = start_test_server(state).await;
        let (status, _) = post_json(handle.port, "/v1/ping", None, serde_json::json!({})).await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn rejects_wrong_auth() {
        let state = state_with("right", vec![]);
        let handle = start_test_server(state).await;
        let (status, _) = post_json(
            handle.port,
            "/v1/ping",
            Some("wrong"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn ping_ok_with_auth() {
        let state = state_with("ok-secret", vec![]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/ping",
            Some("ok-secret"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["ok"], true);
        handle.shutdown().await;
    }

    #[test]
    fn clearing_empty_swarm_fleet_does_not_mark_ui_active() {
        let state = McpIpcState::new("tok".into());
        state.replace_swarm_fleet("w-test", vec![]);
        assert_eq!(state.fleet_pushed_at(), None);
    }

    fn named(pane: &str, ws: &str, name: &str) -> McpFleetMember {
        let mut m = member(pane, ws);
        m.display_name = name.into();
        m
    }

    // F1 (RC1): a canvas-only push must maintain the "a UI is live" signal, and clearing it
    // (all buckets empty) must reset it — exactly like the codespace/swarm buckets.
    #[test]
    fn canvas_push_marks_ui_active_and_clear_resets() {
        let state = McpIpcState::new("tok".into());
        assert_eq!(state.fleet_pushed_at(), None);
        state.replace_canvas_fleet("w1", vec![member("p1", "canvas:a")]);
        assert!(
            state.fleet_pushed_at().is_some(),
            "canvas push should mark the UI active so snapshot_age_ms is non-null"
        );
        state.replace_canvas_fleet("w1", vec![]);
        assert_eq!(
            state.fleet_pushed_at(),
            None,
            "clearing the only bucket should reset the signal"
        );
    }

    // F2 (RC2): the storage bucket is the authoritative surface. Canvas/codespace payloads omit
    // the `surface` field, so `list_fleet(surface)` must still match them by bucket origin.
    #[tokio::test]
    async fn list_fleet_surface_filter_matches_bucket_origin() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        state.replace_canvas_fleet("wc", vec![named("p-canvas", "canvas:a", "Kai")]);
        state.replace_fleet("wf", vec![member("p-code", "ws-code")]);
        let handle = start_test_server(state).await;

        let (s1, b1) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "surface": "canvas" }),
        )
        .await;
        assert_eq!(s1, 200);
        let j1: serde_json::Value = serde_json::from_str(&b1).unwrap();
        let arr1 = j1["fleet"].as_array().unwrap();
        assert_eq!(arr1.len(), 1, "canvas filter should keep the canvas member");
        assert_eq!(arr1[0]["pane_id"], "p-canvas");
        assert_eq!(arr1[0]["surface"], "canvas");

        let (_, b2) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "surface": "codespace" }),
        )
        .await;
        let j2: serde_json::Value = serde_json::from_str(&b2).unwrap();
        let arr2 = j2["fleet"].as_array().unwrap();
        assert_eq!(
            arr2.len(),
            1,
            "codespace filter should keep the codespace member"
        );
        assert_eq!(arr2[0]["pane_id"], "p-code");
        handle.shutdown().await;
    }

    // F5b: agents are told to "dispatch by name", so the compact response must carry the name.
    #[tokio::test]
    async fn list_fleet_compact_includes_display_name() {
        let state = state_with("tok", vec![named("p1", "ws-1", "Atlas")]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["fleet"][0]["display_name"], "Atlas");
        handle.shutdown().await;
    }

    // Phase 4: the compact response surfaces capability flags when the frontend reported them, and
    // omits them when it did not — so a lead agent can route without a verbose fetch.
    #[tokio::test]
    async fn list_fleet_compact_surfaces_capability_flags_when_present() {
        let mut nova = named("p-nova", "canvas:projA", "Nova");
        nova.can_reply = Some(true);
        nova.can_queue = Some(true);
        nova.mcp_tools_available = Some(false);
        let bare = named("p-bare", "canvas:projA", "Bare");
        let state = state_with("tok", vec![nova, bare]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let fleet = json["fleet"].as_array().unwrap();
        let nova = fleet.iter().find(|m| m["pane_id"] == "p-nova").unwrap();
        assert_eq!(nova["can_reply"], true);
        assert_eq!(nova["can_queue"], true);
        assert_eq!(nova["mcp_tools_available"], false);
        let bare = fleet.iter().find(|m| m["pane_id"] == "p-bare").unwrap();
        assert!(bare.get("can_reply").is_none());
        assert!(bare.get("mcp_tools_available").is_none());
        handle.shutdown().await;
    }

    /// Observed live on 2026-08-25, two calls seconds apart on the same pane: the COMPACT reply
    /// carried `turn: "running"` and `turn_age_ms`, and the VERBOSE reply carried neither. Asking
    /// for more detail returned less truth.
    ///
    /// The cause is structural, not a typo: compact is assembled field by field and injects the turn
    /// explicitly, while verbose serializes `McpFleetMember` — which has no such field, because the
    /// authoritative value lives in `pane_turns`, not on the pushed snapshot.
    #[tokio::test]
    async fn list_fleet_verbose_carries_the_turn_state_too() {
        let nova = named("p-nova", "canvas:projA", "Nova");
        let state = state_with("tok", vec![nova]);
        state.record_hook_turn("p-nova", "needs-input", now_ms());
        let handle = start_test_server(state).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;

        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let nova = json["fleet"].as_array().unwrap()[0].clone();
        assert_eq!(nova["turn"], "needs-input");
        assert!(nova["turn_age_ms"].as_u64().is_some());
        handle.shutdown().await;
    }

    /// A pane no hook has ever fired for must carry no turn at all — absent means "this host cannot
    /// say", and a default would be a confident answer we do not have.
    #[tokio::test]
    async fn list_fleet_verbose_omits_the_turn_when_no_hook_has_fired() {
        let state = state_with("tok", vec![named("p-bare", "canvas:projA", "Bare")]);
        let handle = start_test_server(state).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;

        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let bare = json["fleet"].as_array().unwrap()[0].clone();
        assert!(bare.get("turn").is_none());
        assert!(bare.get("turn_age_ms").is_none());
        handle.shutdown().await;
    }

    /// A dispatching agent reads the COMPACT reply, so the headline has to be there — not only in
    /// the detailed one. This is the parity trap that bit `turn` in reverse: verbose serializes the
    /// struct and gets new fields free, while compact is hand-built and silently omits them.
    #[tokio::test]
    async fn list_fleet_compact_carries_the_headline() {
        let mut nova = named("p-nova", "canvas:projA", "Nova");
        nova.headline = Some("perbaiki judul agent".into());
        let state = state_with("tok", vec![nova]);
        let handle = start_test_server(state).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;

        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let nova = json["fleet"].as_array().unwrap()[0].clone();
        assert_eq!(nova["headline"], "perbaiki judul agent");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_verbose_carries_the_headline_too() {
        let mut nova = named("p-nova", "canvas:projA", "Nova");
        nova.headline = Some("jalankan test".into());
        let state = state_with("tok", vec![nova]);
        let handle = start_test_server(state).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;

        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let nova = json["fleet"].as_array().unwrap()[0].clone();
        assert_eq!(nova["headline"], "jalankan test");
        handle.shutdown().await;
    }

    /// Helper: two workspaces of cells with `ws-active` announced as the one on screen.
    fn state_with_two_workspaces(active: Option<&str>) -> SharedState {
        let state = state_with(
            "tok",
            vec![
                named("p-a1", "ws-active", "Claude"),
                named("p-a2", "ws-active", "Codex"),
                named("p-b1", "ws-other", "Claude"),
                named("p-b2", "ws-other", "Claude"),
                named("p-c1", "ws-third", "Claude"),
            ],
        );
        state.set_active_workspace_id(active.map(str::to_string));
        state
    }

    fn panes_of(body: &str) -> Vec<String> {
        let json: serde_json::Value = serde_json::from_str(body).unwrap();
        json["fleet"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| m["pane_id"].as_str().unwrap().to_string())
            .collect()
    }

    /// The default answers "who are my neighbours?", which is what an agent almost always means.
    /// Before this it swept every workspace, and the only workspace clue in the reply was `cwd` —
    /// which the tool description itself tells agents never to guess from.
    #[tokio::test]
    async fn list_fleet_without_arguments_returns_only_the_active_workspace() {
        let handle = start_test_server(state_with_two_workspaces(Some("ws-active"))).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;

        assert_eq!(status, 200);
        assert_eq!(panes_of(&body), vec!["p-a1", "p-a2"]);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["scope"], "active");
        assert_eq!(json["active_workspace_id"], "ws-active");
        handle.shutdown().await;
    }

    /// An agent lists its OWN workspace, not the one on screen: asked from project B while the user
    /// looks at A, the reply was A's agents, whose names and `claude-2` addresses repeat B's, and
    /// the message went to A. An unknown caller pane still falls back to the screen.
    #[tokio::test]
    async fn list_fleet_lists_the_callers_own_workspace_before_the_one_on_screen() {
        let handle = start_test_server(state_with_two_workspaces(Some("ws-active"))).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "from_pane_id": "p-b1" }),
        )
        .await;
        assert_eq!(status, 200);
        assert_eq!(panes_of(&body), vec!["p-b1", "p-b2"]);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["scope"], "own");

        let (_, unknown) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "from_pane_id": "p-gone" }),
        )
        .await;
        assert_eq!(panes_of(&unknown), vec!["p-a1", "p-a2"]);
        handle.shutdown().await;
    }

    /// Narrowing must be VISIBLE. The hidden tally is what tells an agent to widen instead of
    /// concluding the missing teammates do not exist — and it has to match what `scope: "all"`
    /// actually returns, or it is just a different lie.
    #[tokio::test]
    async fn list_fleet_reports_what_the_narrowing_hid_and_the_count_matches_scope_all() {
        let handle = start_test_server(state_with_two_workspaces(Some("ws-active"))).await;

        let (_, narrowed) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        let narrowed_json: serde_json::Value = serde_json::from_str(&narrowed).unwrap();
        assert_eq!(narrowed_json["hidden_count"], 3);
        assert_eq!(narrowed_json["hidden_workspace_count"], 2);
        assert!(narrowed_json["scope_note"]
            .as_str()
            .unwrap()
            .contains("scope=\"all\""));

        let (_, everything) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "scope": "all" }),
        )
        .await;
        let all_json: serde_json::Value = serde_json::from_str(&everything).unwrap();
        assert_eq!(all_json["scope"], "all");
        assert!(all_json.get("hidden_count").is_none(), "nothing is hidden");

        // The arithmetic has to close: shown + hidden == everything.
        let shown = panes_of(&narrowed).len();
        let all = panes_of(&everything).len();
        assert_eq!(all, 5);
        assert_eq!(shown + 3, all);
        handle.shutdown().await;
    }

    /// No active workspace yet (UI not mounted) must NOT read as "you have no teammates". Return
    /// everything and say plainly that the answer is unscoped — the same rule `snapshot_age_ms:
    /// null` follows: absent knowledge is reported, never invented.
    #[tokio::test]
    async fn list_fleet_returns_everything_and_says_so_when_no_active_workspace_is_known() {
        let handle = start_test_server(state_with_two_workspaces(None)).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;

        assert_eq!(status, 200);
        assert_eq!(panes_of(&body).len(), 5, "must not be an empty list");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["scope"], "unknown");
        assert!(json.get("active_workspace_id").is_none());
        assert!(json["scope_note"].as_str().unwrap().contains("NOT a scoped"));
        handle.shutdown().await;
    }

    /// An explicitly named workspace outranks the default — the caller said what they wanted.
    #[tokio::test]
    async fn list_fleet_explicit_workspace_id_beats_the_active_default() {
        let handle = start_test_server(state_with_two_workspaces(Some("ws-active"))).await;

        for body in [
            serde_json::json!({ "workspace_id": "ws-other" }),
            serde_json::json!({ "workspaceId": "ws-other" }),
            // Even alongside scope:"all" — naming a workspace is the more specific request.
            serde_json::json!({ "workspace_id": "ws-other", "scope": "all" }),
        ] {
            let (status, resp) =
                post_json(handle.port, "/v1/list-fleet", Some("tok"), body.clone()).await;
            assert_eq!(status, 200, "body {body}");
            assert_eq!(panes_of(&resp), vec!["p-b1", "p-b2"], "body {body}");
            let json: serde_json::Value = serde_json::from_str(&resp).unwrap();
            assert_eq!(json["scope"], "explicit", "body {body}");
        }
        handle.shutdown().await;
    }

    /// `set_active_workspace_id(None)` must not erase a known scope: a push can arrive while no
    /// workspace is selected, and forgetting then would silently widen every later reply.
    #[test]
    fn a_push_without_a_workspace_does_not_forget_the_active_one() {
        let state = McpIpcState::new("tok".into());
        state.set_active_workspace_id(Some("ws-active".into()));
        state.set_active_workspace_id(None);
        state.set_active_workspace_id(Some("   ".into()));
        assert_eq!(state.active_workspace_id().as_deref(), Some("ws-active"));
        state.set_active_workspace_id(Some("ws-next".into()));
        assert_eq!(state.active_workspace_id().as_deref(), Some("ws-next"));
    }

    /// A body the endpoint cannot understand must SAY SO. Each of these answered 200 with the
    /// full, unfiltered fleet before the body became required — the scoping mechanism failing
    /// open, silently, which is the one failure mode a safety mechanism may not have.
    #[tokio::test]
    async fn list_fleet_rejects_a_body_it_cannot_understand() {
        let state = state_with("tok", vec![named("p-a", "ws-a", "Claude")]);
        let handle = start_test_server(state).await;

        // 1. Right key, wrong type. Used to silently mean "not verbose".
        let (wrong_type, wrong_type_body) = post_raw(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            Some("application/json"),
            r#"{"verbose":"true"}"#,
        )
        .await;
        assert_eq!(wrong_type, 400, "wrong-typed field: {wrong_type_body}");

        // 2. Malformed JSON.
        let (broken, broken_body) = post_raw(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            Some("application/json"),
            r#"{"verbose":"#,
        )
        .await;
        assert_eq!(broken, 400, "broken JSON: {broken_body}");

        // 3. A PERFECT body with no content-type — the sharpest one, because nothing about the
        //    payload is wrong. axum answers 415 for this; we normalise it to 400 so a caller gets
        //    one complaint shape, and it names the header.
        let (no_ct, no_ct_body) = post_raw(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            None,
            r#"{"workspace_id":"nope"}"#,
        )
        .await;
        assert_eq!(no_ct, 400, "missing content-type: {no_ct_body}");
        assert!(
            no_ct_body.contains("content-type"),
            "the complaint must name the missing header, got: {no_ct_body}"
        );

        // The control: the shape every real client sends still works.
        let (ok, _) = post_raw(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            Some("application/json"),
            "{}",
        )
        .await;
        assert_eq!(ok, 200);
        handle.shutdown().await;
    }

    /// A malformed body must not be a way to skip the auth check, so 401 still outranks 400.
    #[tokio::test]
    async fn list_fleet_checks_auth_before_it_complains_about_the_body() {
        let state = state_with("tok", vec![named("p-a", "ws-a", "Claude")]);
        let handle = start_test_server(state).await;
        let (status, _) = post_raw(
            handle.port,
            "/v1/list-fleet",
            None,
            Some("application/json"),
            r#"{"verbose":"#,
        )
        .await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    /// A filter sent under the tool schema's own camelCase spelling must actually filter. Before
    /// the aliases it was an unknown field, so it was dropped and the caller got the whole fleet
    /// back under a `200` — an unscoped answer wearing a scoped request's clothes.
    #[tokio::test]
    async fn list_fleet_honours_the_tool_schemas_camel_case_filter_names() {
        let state = state_with(
            "tok",
            vec![
                named("p-a", "ws-a", "Claude"),
                named("p-b", "ws-b", "Claude"),
            ],
        );
        let handle = start_test_server(state).await;

        for body in [
            serde_json::json!({ "workspaceId": "ws-a" }),
            serde_json::json!({ "workspace_id": "ws-a" }),
        ] {
            let (status, resp) =
                post_json(handle.port, "/v1/list-fleet", Some("tok"), body.clone()).await;
            assert_eq!(status, 200, "body {body}");
            let json: serde_json::Value = serde_json::from_str(&resp).unwrap();
            let fleet = json["fleet"].as_array().unwrap();
            assert_eq!(fleet.len(), 1, "body {body} returned {fleet:?}");
            assert_eq!(fleet[0]["pane_id"], "p-a", "body {body}");
        }

        let (_, team_body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "teamId": "nobody" }),
        )
        .await;
        let json: serde_json::Value = serde_json::from_str(&team_body).unwrap();
        assert!(json["fleet"].as_array().unwrap().is_empty());
        handle.shutdown().await;
    }

    /// A genuinely unknown key stays IGNORED rather than rejected — pinning the half of the
    /// contract the aliases above do not change, so a future `deny_unknown_fields` cannot be added
    /// without this test noticing.
    #[tokio::test]
    async fn list_fleet_ignores_an_unknown_field_instead_of_rejecting_it() {
        let state = state_with("tok", vec![named("p-a", "ws-a", "Claude")]);
        let handle = start_test_server(state).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "notAField": 1, "verbose": true }),
        )
        .await;

        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["fleet"].as_array().unwrap().len(), 1);
        handle.shutdown().await;
    }

    /// The readable address is the whole point of the field — a peer names `claude-2` instead of
    /// quoting a pane UUID — so it has to survive BOTH projections. Verbose gets it by serializing
    /// the struct; compact is hand-built and is the reply a dispatching agent actually reads.
    #[tokio::test]
    async fn list_fleet_carries_the_agent_address_in_both_projections() {
        let mut nova = named("p-nova", "ws-1", "Claude");
        nova.agent_address = Some("claude-2".into());
        let state = state_with("tok", vec![nova]);
        let handle = start_test_server(state).await;

        let (compact_status, compact_body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        let (verbose_status, verbose_body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;

        assert_eq!(compact_status, 200);
        assert_eq!(verbose_status, 200);
        for body in [compact_body, verbose_body] {
            let json: serde_json::Value = serde_json::from_str(&body).unwrap();
            let member = json["fleet"].as_array().unwrap()[0].clone();
            assert_eq!(member["agent_address"], "claude-2");
        }
        handle.shutdown().await;
    }

    /// An unaddressed cell stays unaddressed rather than inventing a name — same absent-means-
    /// unknown rule as `headline`.
    #[tokio::test]
    async fn list_fleet_omits_the_agent_address_when_the_host_has_none() {
        let state = state_with("tok", vec![named("p-bare", "ws-1", "Claude")]);
        let handle = start_test_server(state).await;

        let (_, compact_body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        let (_, verbose_body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;

        for body in [compact_body, verbose_body] {
            let json: serde_json::Value = serde_json::from_str(&body).unwrap();
            let member = json["fleet"].as_array().unwrap()[0].clone();
            assert!(member.get("agent_address").is_none());
        }
        handle.shutdown().await;
    }

    /// Dispatching to `claude-2` must land on the cell holding that address, not on one of the
    /// four other panes whose `display_name` is also "Claude" — which is the only thing that
    /// distinguished them before the address was published.
    #[test]
    fn resolve_dispatch_target_resolves_a_readable_agent_address() {
        let state = McpIpcState::new("tok".into());
        let mut first = named("p-claude-1", "ws-1", "Claude");
        first.agent_address = Some("claude-1".into());
        let mut second = named("p-claude-2", "ws-1", "Claude");
        second.agent_address = Some("claude-2".into());
        state.replace_fleet("w", vec![first, second]);

        match state.resolve_dispatch_target("claude-2", None) {
            FleetResolution::Unique(m) => assert_eq!(m.pane_id, "p-claude-2"),
            other => panic!("expected unique by agent_address, got {other:?}"),
        }
        // `@claude-1` and `Claude-1` are the same address: agents quote names loosely.
        match state.resolve_dispatch_target("@Claude-1", None) {
            FleetResolution::Unique(m) => assert_eq!(m.pane_id, "p-claude-1"),
            other => panic!("expected unique by normalized agent_address, got {other:?}"),
        }
    }

    /// Absent means "this host cannot say", the same rule `turn` follows. A default would be a
    /// confident answer about what an agent is doing, invented from nothing.
    #[tokio::test]
    async fn list_fleet_omits_the_headline_when_the_agent_has_not_been_asked() {
        let state = state_with("tok", vec![named("p-bare", "canvas:projA", "Bare")]);
        let handle = start_test_server(state).await;

        let (compact_status, compact_body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        let (_, verbose_body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;

        assert_eq!(compact_status, 200);
        for body in [compact_body, verbose_body] {
            let json: serde_json::Value = serde_json::from_str(&body).unwrap();
            let bare = json["fleet"].as_array().unwrap()[0].clone();
            assert!(bare.get("headline").is_none());
        }
        handle.shutdown().await;
    }

    // 6.4: an empty result while a UI has pushed before triggers a refresh + brief wait, so a
    // caller that lists a beat before a just-spawned agent's snapshot lands still sees it (no
    // false "no teammates"). The spawned task stands in for the frontend answering the refresh.
    #[tokio::test]
    async fn list_fleet_pulls_on_empty_then_returns_the_refreshed_snapshot() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        // A UI is active (it pushed a member in another workspace) → fleet_pushed_at is Some, but
        // the caller's target workspace is (initially) empty — the stale/just-spawned window.
        state.replace_canvas_fleet("w-other", vec![named("p-x", "canvas:other", "X")]);
        let responder = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            responder
                .replace_canvas_fleet("w-target", vec![named("p-nova", "canvas:target", "Nova")]);
        });
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "workspace_id": "canvas:target" }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let fleet = json["fleet"].as_array().unwrap();
        assert_eq!(fleet.len(), 1);
        assert_eq!(fleet[0]["display_name"], "Nova");
        handle.shutdown().await;
    }

    // RC6: a bare display name shared by two open projects must resolve to the caller's project.
    #[test]
    fn resolve_dispatch_target_scopes_name_to_callers_project() {
        let state = McpIpcState::new("tok".into());
        state.replace_canvas_fleet(
            "wA",
            vec![
                named("p-nova-A", "canvas:projA", "Nova"),
                named("p-kai-A", "canvas:projA", "Kai"),
            ],
        );
        state.replace_canvas_fleet("wB", vec![named("p-kai-B", "canvas:projB", "Kai")]);
        match state.resolve_dispatch_target("Kai", Some("p-nova-A")) {
            FleetResolution::Unique(m) => assert_eq!(m.pane_id, "p-kai-A"),
            other => panic!("expected caller-scoped unique, got {other:?}"),
        }
    }

    // 06a bug: TWO candidates in the caller's OWN workspace must be Ambiguous, not an arbitrary
    // first-match "Unique". The caller-scope `.find()` picks whichever candidate happens to be
    // registered first, silently landing the dispatch on the wrong one.
    #[test]
    fn resolve_dispatch_target_ambiguous_within_callers_own_workspace() {
        let state = McpIpcState::new("tok".into());
        state.replace_canvas_fleet(
            "wA",
            vec![
                named("p-caller-A", "canvas:projA", "Nova"),
                named("p-claude-1", "canvas:projA", "Claude"),
                named("p-claude-2", "canvas:projA", "Claude"),
            ],
        );
        match state.resolve_dispatch_target("Claude", Some("p-caller-A")) {
            FleetResolution::Ambiguous(c) => assert_eq!(c.len(), 2),
            other => panic!("expected ambiguous within caller's own workspace, got {other:?}"),
        }
    }

    #[test]
    fn resolve_dispatch_target_ambiguous_without_caller_scope() {
        let state = McpIpcState::new("tok".into());
        state.replace_canvas_fleet("wA", vec![named("p-kai-A", "canvas:projA", "Kai")]);
        state.replace_canvas_fleet("wB", vec![named("p-kai-B", "canvas:projB", "Kai")]);
        match state.resolve_dispatch_target("Kai", None) {
            FleetResolution::Ambiguous(c) => assert_eq!(c.len(), 2),
            other => panic!("expected ambiguous, got {other:?}"),
        }
    }

    #[test]
    fn resolve_dispatch_target_exact_pane_id_is_unique_despite_name_collision() {
        let state = McpIpcState::new("tok".into());
        state.replace_canvas_fleet("wA", vec![named("p-kai-A", "canvas:projA", "Kai")]);
        state.replace_canvas_fleet("wB", vec![named("p-kai-B", "canvas:projB", "Kai")]);
        match state.resolve_dispatch_target("p-kai-B", None) {
            FleetResolution::Unique(m) => assert_eq!(m.pane_id, "p-kai-B"),
            other => panic!("expected unique by pane_id, got {other:?}"),
        }
    }

    // 06b: a qualified `<workspace>/<name>` address reaches a member of a DIFFERENT
    // workspace than the caller's — the only way to do that before was a raw pane_id.
    #[test]
    fn resolve_dispatch_target_qualified_address_reaches_another_workspace() {
        let state = McpIpcState::new("tok".into());
        let mut lotus_claude = named("p-claude-1", "canvas:lotus-ws", "Claude");
        lotus_claude.agent_address = Some("claude-1".into());
        lotus_claude.workspace_label = Some("Lotus".into());
        state.replace_canvas_fleet("wLotus", vec![lotus_claude]);
        state.replace_canvas_fleet(
            "wOther",
            vec![named("p-caller", "canvas:other-ws", "Nova")],
        );
        match state.resolve_dispatch_target("Lotus/claude-1", Some("p-caller")) {
            FleetResolution::Unique(m) => assert_eq!(m.pane_id, "p-claude-1"),
            other => panic!("expected qualified address to reach the other workspace, got {other:?}"),
        }
    }

    // 06b pitfall #1 (regression guard): a Swarm v2 address is 4 segments and `@`-led —
    // never mistaken for a 2-segment `<workspace>/<name>` qualified address.
    #[test]
    fn resolve_dispatch_target_swarm_v2_address_still_resolves() {
        let state = McpIpcState::new("tok".into());
        let mut architect = member("swarm_01JZ7Q6G9P3W7X9H8M2C4V6B8D", "swarm:/repo");
        architect.address = Some("@swarm/codespace-demo/feature-development/architect".into());
        state.replace_canvas_fleet("wSwarm", vec![architect]);
        match state
            .resolve_dispatch_target("@swarm/codespace-demo/feature-development/architect", None)
        {
            FleetResolution::Unique(m) => {
                assert_eq!(m.pane_id, "swarm_01JZ7Q6G9P3W7X9H8M2C4V6B8D")
            }
            other => panic!("expected the swarm v2 address to still resolve, got {other:?}"),
        }
    }

    // 06b: two DIFFERENT workspaces can share the same workspace_label (derived from cwd
    // basename — two repos named the same is real), so a qualified address matching both
    // must stay Ambiguous rather than guess.
    #[test]
    fn resolve_dispatch_target_qualified_ambiguous_when_workspace_labels_collide() {
        let state = McpIpcState::new("tok".into());
        let mut a = named("p-claude-a", "canvas:repoA", "Claude");
        a.agent_address = Some("claude-1".into());
        a.workspace_label = Some("Lotus".into());
        let mut b = named("p-claude-b", "canvas:repoB", "Claude");
        b.agent_address = Some("claude-1".into());
        b.workspace_label = Some("Lotus".into());
        state.replace_canvas_fleet("wA", vec![a]);
        state.replace_canvas_fleet("wB", vec![b]);
        match state.resolve_dispatch_target("Lotus/claude-1", None) {
            FleetResolution::Ambiguous(c) => assert_eq!(c.len(), 2),
            other => panic!("expected ambiguous on colliding workspace_label, got {other:?}"),
        }
    }

    // 06b: qualifying to a workspace name nothing matches is NotFound, not a fallback guess.
    #[test]
    fn resolve_dispatch_target_qualified_unknown_workspace_not_found() {
        let state = McpIpcState::new("tok".into());
        let mut lotus_claude = named("p-claude-1", "canvas:lotus-ws", "Claude");
        lotus_claude.agent_address = Some("claude-1".into());
        lotus_claude.workspace_label = Some("Lotus".into());
        state.replace_canvas_fleet("wLotus", vec![lotus_claude]);
        assert_eq!(
            state.resolve_dispatch_target("Ghostspace/claude-1", None),
            FleetResolution::NotFound
        );
    }

    #[test]
    fn resolve_dispatch_target_not_found_when_absent() {
        let state = McpIpcState::new("tok".into());
        state.replace_canvas_fleet("wA", vec![named("p-kai-A", "canvas:projA", "Kai")]);
        assert_eq!(
            state.resolve_dispatch_target("Ghost", None),
            FleetResolution::NotFound
        );
    }

    // F6 (RC4): with no UI push ever, dispatch fast-fails with a retryable 503 (not an opaque 404).
    #[tokio::test]
    async fn dispatch_fast_fails_when_no_fleet_ever_pushed() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/dispatch-to-cell",
            Some("tok"),
            serde_json::json!({ "pane_id": "Kai", "command": "hi" }),
        )
        .await;
        assert_eq!(status, 503);
        assert!(
            body.to_lowercase().contains("fleet snapshot"),
            "expected actionable no-UI message, got: {body}"
        );
        handle.shutdown().await;
    }

    // F6 (RC4): when a name is absent from a populated fleet, the error lists the live roster.
    #[tokio::test]
    async fn dispatch_not_found_lists_live_agents() {
        let state = McpIpcState::new("tok".into());
        state.replace_canvas_fleet(
            "wA",
            vec![
                named("p-atlas", "canvas:a", "Atlas"),
                named("p-nova", "canvas:a", "Nova"),
            ],
        );
        let resp = dispatch_target_not_found_response(&state, "Ghost");
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = String::from_utf8_lossy(&bytes);
        assert!(
            body.contains("Atlas") && body.contains("Nova"),
            "expected the live roster in the error, got: {body}"
        );
    }

    // 06a follow-up: an ambiguous match confined to the caller's OWN project must say so —
    // "multiple projects" and "dispatch from that project" are both wrong when the collision
    // is between two agents the caller is already sitting next to. The suggestion must name
    // real, re-callable targets instead of telling the caller to move.
    #[tokio::test]
    async fn dispatch_ambiguous_within_one_project_names_targets_not_a_project_move() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        state.replace_canvas_fleet(
            "wA",
            vec![
                named("p-caller-A", "canvas:projA", "Nova"),
                named("p-claude-1", "canvas:projA", "Claude"),
                named("p-claude-2", "canvas:projA", "Claude"),
            ],
        );
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/dispatch-to-cell",
            Some("tok"),
            serde_json::json!({
                "pane_id": "Claude",
                "from_pane_id": "p-caller-A",
                "command": "hi",
            }),
        )
        .await;
        assert_eq!(status, 409);
        assert!(
            body.contains("more than one agent in this project"),
            "expected same-project wording, got: {body}"
        );
        assert!(
            !body.contains("multiple projects"),
            "wrong-scope wording leaked into a same-project ambiguity, got: {body}"
        );
        assert!(
            !body.contains("dispatch from that project"),
            "stale advice to move projects should be gone, got: {body}"
        );
        assert!(
            body.contains("p-claude-1") && body.contains("p-claude-2"),
            "expected real, re-callable targets in the suggestion, got: {body}"
        );
        handle.shutdown().await;
    }

    #[test]
    fn resolves_fleet_member_by_swarm_address() {
        let mut architect = member("swarm_01JZ7Q6G9P3W7X9H8M2C4V6B8D", "swarm:/repo");
        architect.address = Some("@swarm/codespace-demo/feature-development/architect".into());
        architect.session_id = Some("pty-architect".into());
        let state = state_with("tok", vec![architect]);

        assert_eq!(
            state.resolve_session_id("@swarm/codespace-demo/feature-development/architect"),
            Some("pty-architect".into()),
        );
        assert_eq!(
            state.resolve_session_id("swarm/codespace-demo/feature-development/architect"),
            Some("pty-architect".into()),
        );
        assert_eq!(
            state
                .resolve_fleet_member("@swarm/codespace-demo/feature-development/architect")
                .map(|m| m.pane_id),
            Some("swarm_01JZ7Q6G9P3W7X9H8M2C4V6B8D".into()),
        );
    }

    #[tokio::test]
    async fn list_fleet_returns_snapshot() {
        let state = state_with("tok", vec![member("p1", "ws-1"), member("p2", "ws-2")]);
        let handle = start_test_server(state.clone()).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let arr = json["fleet"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_reports_snapshot_age_after_push() {
        // A pushed snapshot carries an age so the planner can tell how fresh the
        // fleet view is (push-on-change means an old age = "no recent changes",
        // not necessarily wrong — the planner interprets it).
        let state = state_with("tok", vec![member("p1", "ws-1")]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(
            json["snapshot_age_ms"].is_u64(),
            "expected numeric snapshot_age_ms, got {}",
            json["snapshot_age_ms"]
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_age_is_null_when_never_pushed() {
        // No frontend has pushed a snapshot yet → age is null, signalling the
        // fleet view is uninitialised rather than "0 ms old".
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(
            json["snapshot_age_ms"].is_null(),
            "expected null snapshot_age_ms, got {}",
            json["snapshot_age_ms"]
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn spawn_cell_is_not_globally_blocked_when_swarm_fleet_active() {
        let mut architect = member("swarm_01JZ7Q6G9P3W7X9H8M2C4V6B8D", "swarm:/repo");
        architect.surface = Some("swarm".into());
        architect.team_id = Some("team_feature_dev_01".into());
        architect.member_id = Some("agent-architect".into());
        let state = Arc::new(McpIpcState::new("tok".into()));
        state.replace_swarm_fleet("w-test", vec![architect]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/spawn-cell",
            Some("tok"),
            serde_json::json!({ "provider": "claude" }),
        )
        .await;
        assert_eq!(status, 503);
        assert!(
            body.to_lowercase().contains("cannot reach frontend"),
            "expected frontend resolution failure after passing swarm guard, got: {body}"
        );
        handle.shutdown().await;
    }

    /// #319: the spawner's pane id reaches the window, which puts the new pane in that agent's group.
    #[tokio::test]
    async fn spawn_cell_forwards_the_spawner_pane_to_the_window() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        state.replace_swarm_fleet("w-test", vec![member("p1", "w-test")]);
        let handle = start_test_server(state.clone()).await;
        let _ = post_json(
            handle.port,
            "/v1/spawn-cell",
            Some("tok"),
            serde_json::json!({ "provider": "claude", "from_pane_id": "p1" }),
        )
        .await;
        let spawn = state.emitted_for_tests().into_iter().find(|(event, _)| event == "mcp://spawn-cell");
        assert_eq!(spawn.map(|(_, payload)| payload["fromPaneId"].clone()), Some(serde_json::json!("p1")));
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn spawn_cell_refuses_an_unknown_account_before_the_window_starts_anything() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        state.replace_swarm_fleet("w-test", vec![member("p1", "w-test")]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/spawn-cell",
            Some("tok"),
            serde_json::json!({ "provider": "claude", "profile_id": "no-such-account-zz" }),
        )
        .await;
        assert_eq!(status, 400);
        assert!(body.contains("no account named \"no-such-account-zz\""), "got: {body}");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn spawn_cell_fast_fails_when_no_workspace_ui_active() {
        // Frontend never pushed a fleet snapshot → no live UI listener can resolve
        // the spawn → return an explicit, actionable error immediately instead of
        // waiting out the 6s timeout and emitting an opaque 504.
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/spawn-cell",
            Some("tok"),
            serde_json::json!({ "provider": "claude" }),
        )
        .await;
        assert_eq!(status, 503);
        assert!(
            body.to_lowercase().contains("workspace ui"),
            "expected explicit no-UI message, got: {body}"
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn close_cell_fast_fails_when_no_workspace_ui_active() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/close-cell",
            Some("tok"),
            serde_json::json!({ "pane_id": "p1" }),
        )
        .await;
        assert_eq!(status, 503);
        assert!(
            body.to_lowercase().contains("workspace ui"),
            "expected explicit no-UI message, got: {body}"
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_draw_rejects_empty_ops() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/canvas-draw",
            Some("tok"),
            serde_json::json!({ "mode": "ops", "ops": [] }),
        )
        .await;
        assert_eq!(status, 400);
        assert!(body.to_lowercase().contains("empty"), "got: {body}");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_draw_rejects_oversized_ops_batch() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let ops: Vec<serde_json::Value> = (0..MAX_DRAW_OPS + 1)
            .map(|_| serde_json::json!({ "op": "create_shape", "shape": "rectangle" }))
            .collect();
        let (status, body) = post_json(
            handle.port,
            "/v1/canvas-draw",
            Some("tok"),
            serde_json::json!({ "mode": "ops", "ops": ops }),
        )
        .await;
        assert_eq!(status, 400);
        assert!(body.contains(&MAX_DRAW_OPS.to_string()), "got: {body}");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_draw_rejects_diagram_with_no_nodes() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/canvas-draw",
            Some("tok"),
            serde_json::json!({ "mode": "diagram", "graph": { "nodes": [], "edges": [] } }),
        )
        .await;
        assert_eq!(status, 400);
        assert!(body.to_lowercase().contains("nodes"), "got: {body}");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_draw_rejects_unknown_mode() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, _body) = post_json(
            handle.port,
            "/v1/canvas-draw",
            Some("tok"),
            serde_json::json!({ "mode": "sculpt", "ops": [{ "op": "create_shape", "shape": "rectangle" }] }),
        )
        .await;
        assert_eq!(status, 400);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_draw_valid_batch_reaches_frontend_round_trip() {
        // A well-formed batch passes Rust validation and attempts the frontend round-trip;
        // with no app handle in the test server that surfaces as a 503 (cannot reach frontend),
        // proving validation let it through rather than short-circuiting with a 400.
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/canvas-draw",
            Some("tok"),
            serde_json::json!({ "mode": "ops", "ops": [{ "op": "create_shape", "shape": "rectangle" }] }),
        )
        .await;
        assert_eq!(status, 503);
        assert!(body.to_lowercase().contains("frontend"), "got: {body}");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_draw_requires_auth() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, _body) = post_json(
            handle.port,
            "/v1/canvas-draw",
            Some("wrong-token"),
            serde_json::json!({ "mode": "ops", "ops": [{ "op": "create_shape", "shape": "rectangle" }] }),
        )
        .await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_read_shapes_requires_auth() {
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, _body) = post_json(
            handle.port,
            "/v1/canvas-read-shapes",
            Some("nope"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn canvas_read_shapes_round_trips_to_frontend() {
        // With no app handle the emit fails → 503 (cannot reach frontend), proving the read request
        // passes auth and attempts the round-trip rather than erroring earlier.
        let state = Arc::new(McpIpcState::new("tok".into()));
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/canvas-read-shapes",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 503);
        assert!(body.to_lowercase().contains("frontend"), "got: {body}");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_filters_by_workspace_id() {
        let state = state_with("tok", vec![member("p1", "ws-1"), member("p2", "ws-2")]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "workspace_id": "ws-2" }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let arr = json["fleet"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["pane_id"], "p2");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_filters_by_surface_and_team_id() {
        let mut swarm_a = member("swarm-a", "ws-1");
        swarm_a.surface = Some("swarm".into());
        swarm_a.team_id = Some("team-a".into());
        let mut swarm_b = member("swarm-b", "ws-1");
        swarm_b.surface = Some("swarm".into());
        swarm_b.team_id = Some("team-b".into());
        let mut codespace = member("code-a", "ws-1");
        codespace.surface = Some("codespace".into());
        let state = state_with("tok", vec![codespace]);
        state.replace_swarm_fleet("w-test", vec![swarm_a, swarm_b]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "workspace_id": "ws-1", "surface": "swarm", "team_id": "team-b" }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let arr = json["fleet"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["pane_id"], "swarm-b");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_compact_default_includes_targeting_fields() {
        // Compact projection exposes enough fields for the planner to target
        // panes and use their filesystem cwd without opting into session_id.
        let state = state_with("tok", vec![member("p1", "ws-1")]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let entry = &json["fleet"][0];
        assert_eq!(entry["pane_id"], "p1");
        assert_eq!(entry["workspace_id"], "ws-1");
        assert_eq!(entry["cwd"], "/tmp");
        assert_eq!(entry["provider"], "claude");
        assert_eq!(entry["status"], "live");
        assert_eq!(entry["is_alive"], true);
        // display_name is now included in compact mode (F5b): the capability prompt tells agents
        // to dispatch by name, so the default response must carry the name they address.
        assert_eq!(entry["display_name"], "Claude");
        // session_id stays verbose-only.
        assert!(entry.get("session_id").is_none());
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_compact_reports_hook_turn_state() {
        // Turn-accurate fleet: a stop-hook idle event surfaces per member so the orchestrator
        // sees real busy/idle instead of the launch-phase status ("live" even when idle at prompt).
        let state = state_with("tok", vec![member("p1", "ws-1"), member("p2", "ws-1")]);
        state.record_hook_turn("p1", "idle", now_ms());
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let p1 = &json["fleet"][0];
        assert_eq!(p1["turn"], "idle");
        assert!(p1["turn_age_ms"].as_u64().is_some());
        // No hook has fired for p2 → no turn fields (unknown, not fabricated).
        assert!(json["fleet"][1].get("turn").is_none());
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_compact_includes_swarm_identity_targeting_fields() {
        let mut architect = member("swarm_01JZ7Q6G9P3W7X9H8M2C4V6B8D", "swarm:/repo");
        architect.surface = Some("swarm".into());
        architect.runtime_id = Some("01JZ7Q6G9P3W7X9H8M2C4V6B8D".into());
        architect.team_id = Some("team_feature_dev_01".into());
        architect.member_id = Some("agent-architect".into());
        architect.address = Some("@swarm/codespace-demo/feature-development/architect".into());
        architect.workspace_label = Some("codespace-demo".into());
        architect.fleet_schema_version = Some(2);

        let state = Arc::new(McpIpcState::new("tok".to_string()));
        state.replace_swarm_fleet("w-test", vec![architect]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let entry = &json["fleet"][0];
        assert_eq!(entry["surface"], "swarm");
        assert_eq!(entry["runtime_id"], "01JZ7Q6G9P3W7X9H8M2C4V6B8D");
        assert_eq!(entry["team_id"], "team_feature_dev_01");
        assert_eq!(entry["member_id"], "agent-architect");
        assert_eq!(
            entry["address"],
            "@swarm/codespace-demo/feature-development/architect"
        );
        assert_eq!(entry["workspace_label"], "codespace-demo");
        assert_eq!(entry["fleet_schema_version"], 2);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_verbose_opt_in_includes_full_shape() {
        let state = state_with("tok", vec![member("p1", "ws-1")]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let entry = &json["fleet"][0];
        assert_eq!(entry["pane_id"], "p1");
        assert_eq!(entry["workspace_id"], "ws-1");
        assert_eq!(entry["cwd"], "/tmp");
        assert_eq!(entry["display_name"], "Claude");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn list_fleet_verbose_preserves_swarm_identity_v2() {
        let mut architect = member("swarm_01JZ7Q6G9P3W7X9H8M2C4V6B8D", "swarm:/repo");
        architect.surface = Some("swarm".into());
        architect.runtime_id = Some("01JZ7Q6G9P3W7X9H8M2C4V6B8D".into());
        architect.team_id = Some("team_feature_dev_01".into());
        architect.member_id = Some("agent-architect".into());
        architect.address = Some("@swarm/codespace-demo/feature-development/architect".into());
        architect.workspace_label = Some("codespace-demo".into());
        architect.fleet_schema_version = Some(2);
        architect.display_name = "Architect".into();

        let state = Arc::new(McpIpcState::new("tok".to_string()));
        state.replace_swarm_fleet("w-test", vec![architect]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/list-fleet",
            Some("tok"),
            serde_json::json!({ "verbose": true }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let entry = &json["fleet"][0];
        assert_eq!(entry["surface"], "swarm");
        assert_eq!(entry["runtime_id"], "01JZ7Q6G9P3W7X9H8M2C4V6B8D");
        assert_eq!(entry["team_id"], "team_feature_dev_01");
        assert_eq!(entry["member_id"], "agent-architect");
        assert_eq!(
            entry["address"],
            "@swarm/codespace-demo/feature-development/architect"
        );
        assert_eq!(entry["workspace_label"], "codespace-demo");
        assert_eq!(entry["fleet_schema_version"], 2);
        handle.shutdown().await;
    }

    #[test]
    fn canvas_collaboration_project_store_helpers_append_and_project_participants() {
        let mailbox = empty_mailbox("swarm-task:task_1");
        let message = collaboration_message(
            "swarm-task:task_1",
            "evidence",
            "Mira",
            "Regression added",
            &Some(vec!["src/editor.ts".into()]),
            &Some(vec!["bun test editor".into()]),
            &None,
        );
        let mailbox = mailbox_with_message(mailbox, message.clone());
        let messages = messages_for_assignee(&mailbox, "mira");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["body"], "Regression added");
        assert_eq!(messages[0]["evidence"]["files"][0], "src/editor.ts");

        let participants = ledger_participants(None, &mailbox);
        assert_eq!(participants.len(), 1);
        assert_eq!(participants[0]["name"], "Mira");
        assert_eq!(participants[0]["assigneeKey"], "mira");
        assert_eq!(participants[0]["status"], "done");
        assert_eq!(participants[0]["messageCount"], 1);
        assert_eq!(participants[0]["evidenceCount"], 1);
        assert_eq!(participants[0]["latestMessage"]["body"], "Regression added");

        let context = serde_json::json!({
            "launch": { "mode": "swarm-task", "taskId": "task_1" },
            "task": { "id": "task_1", "title": "Ship feature" }
        });
        let (run, task, freshness) = collaboration_response_context(Some(&context), None);
        assert_eq!(run["taskId"], "task_1");
        assert_eq!(task["title"], "Ship feature");
        assert_eq!(freshness, "persisted-context");
        let fresh_task =
            serde_json::json!({ "id": "task_1", "title": "Fresh title", "updatedAt": 99 });
        let (_, fresh, freshness) =
            collaboration_response_context(Some(&context), Some(fresh_task));
        assert_eq!(fresh["title"], "Fresh title");
        assert_eq!(freshness, "live-task");

        let duplicate = mailbox_with_message(mailbox.clone(), message);
        assert_eq!(message_array(&duplicate).len(), 1);
    }

    #[test]
    fn canvas_collaboration_assignment_response_includes_guidance_and_summaries() {
        let mailbox = serde_json::json!({
            "runId": "swarm-task:task_1",
            "messages": [
                { "id": "handoff-1", "assignee": "Mira", "assigneeKey": "mira", "nodeId": "node-mira", "kind": "handoff", "author": "director", "body": "Brief", "createdAt": 1 },
                { "id": "evidence-1", "assignee": "Mira", "assigneeKey": "mira", "nodeId": "node-mira", "kind": "evidence", "author": "agent", "body": "Tests pass", "createdAt": 2, "evidence": { "files": ["src/a.ts"], "checks": ["bun test"] } },
                { "id": "blocker-1", "assignee": "Mira", "assigneeKey": "mira", "nodeId": "node-mira", "kind": "blocker", "author": "agent", "body": "Need API key", "createdAt": 3, "evidence": { "blockers": ["Missing key"] } }
            ],
            "updatedAt": 3
        });
        let ledger = serde_json::json!({
            "assignments": {
                "mira": { "assignee": "Mira", "nodeId": "node-mira", "state": "running", "updatedAt": 5, "lastBrief": { "sentAt": 4 } }
            }
        });
        let response = collaboration_assignment_response(Some(&ledger), &mailbox, "Mira");
        assert_eq!(response["participant"]["name"], "Mira");
        assert_eq!(response["assignment"]["assignee"], "Mira");
        assert_eq!(response["assignment"]["assignmentState"], "running");
        assert_eq!(response["assignment"]["messageCount"], 3);
        assert_eq!(response["assignment"]["evidenceCount"], 1);
        assert_eq!(
            response["assignment"]["latestEvidence"]["body"],
            "Tests pass"
        );
        assert_eq!(
            response["assignment"]["latestBlocker"]["body"],
            "Need API key"
        );
        assert!(response["assignment"]["nextAction"]
            .as_str()
            .unwrap()
            .contains("blocker"));
        assert_eq!(
            response["messages"].as_array().unwrap()[0]["body"],
            "Need API key"
        );
    }

    #[test]
    fn default_wait_timeout_is_provider_aware() {
        // Agent CLIs with heavy boot get a longer window; a plain shell gets
        // the tight default. These are the source-of-truth values the footer
        // rule #3 budget is built on — changing them is a behaviour change.
        assert_eq!(default_wait_timeout_ms(Some("codex")), 15_000);
        assert_eq!(default_wait_timeout_ms(Some("CODEX")), 15_000);
        assert_eq!(default_wait_timeout_ms(Some("gemini")), 15_000);
        assert_eq!(default_wait_timeout_ms(Some("opencode")), 15_000);
        assert_eq!(default_wait_timeout_ms(Some("cursor")), 12_000);
        assert_eq!(default_wait_timeout_ms(Some("copilot")), 12_000);
        assert_eq!(default_wait_timeout_ms(Some("claude")), 10_000);
        assert_eq!(default_wait_timeout_ms(Some("claude-headless")), 10_000);
        assert_eq!(default_wait_timeout_ms(Some("shell")), 8_000);
        assert_eq!(default_wait_timeout_ms(Some("anything-else")), 8_000);
        assert_eq!(default_wait_timeout_ms(None), 8_000);
    }

    #[tokio::test]
    async fn ensure_fleet_requires_auth() {
        let state = state_with("tok", vec![]);
        let handle = start_test_server(state).await;
        let (status, _) = post_json(
            handle.port,
            "/v1/ensure-fleet",
            None,
            serde_json::json!({ "provider": "codex", "count": 1 }),
        )
        .await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn ensure_fleet_rejects_empty_provider() {
        let state = state_with("tok", vec![]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/ensure-fleet",
            Some("tok"),
            serde_json::json!({ "provider": "  ", "count": 1 }),
        )
        .await;
        assert_eq!(status, 400);
        assert!(body.contains("provider required"));
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn ensure_fleet_rejects_count_over_cap() {
        let state = state_with("tok", vec![]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/ensure-fleet",
            Some("tok"),
            serde_json::json!({ "provider": "codex", "count": 999 }),
        )
        .await;
        assert_eq!(status, 400);
        assert!(body.contains("exceeds max"));
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn ensure_fleet_delta_zero_is_no_op() {
        // Snapshot already matches request: no spawn, no close, no errors.
        // Exercises the happy "already there" path without needing a
        // frontend emit mock.
        let mut m = member("p-codex", "ws-1");
        m.provider = "codex".into();
        let state = state_with("tok", vec![m]);
        let handle = start_test_server(state.clone()).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/ensure-fleet",
            Some("tok"),
            serde_json::json!({
                "provider": "codex",
                "count": 1,
                "workspace_id": "ws-1"
            }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["ok"], true);
        assert_eq!(json["provider"], "codex");
        assert_eq!(json["requested"], 1);
        assert_eq!(json["aliveBefore"], 1);
        assert_eq!(json["spawned"].as_array().unwrap().len(), 0);
        assert_eq!(json["closed"].as_array().unwrap().len(), 0);
        assert_eq!(json["errors"].as_array().unwrap().len(), 0);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn ensure_fleet_counts_filter_by_provider_and_workspace() {
        // Mixed fleet; count should only see codex-in-ws-1.
        let mut codex1 = member("p-codex-1", "ws-1");
        codex1.provider = "codex".into();
        let mut codex2 = member("p-codex-2", "ws-2");
        codex2.provider = "codex".into();
        let claude1 = member("p-claude-1", "ws-1");
        let state = state_with("tok", vec![codex1, codex2, claude1]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/ensure-fleet",
            Some("tok"),
            serde_json::json!({
                "provider": "codex",
                "count": 1,
                "workspace_id": "ws-1"
            }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        // One codex already in ws-1 → delta 0 → no-op.
        assert_eq!(json["aliveBefore"], 1);
        assert_eq!(json["spawned"].as_array().unwrap().len(), 0);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn task_endpoints_create_list_update_and_get_workspace_tasks() {
        let temp = tempfile::tempdir().unwrap();
        let state = state_with("tok", vec![]);
        state.set_task_base_for_tests(temp.path().to_path_buf());
        let handle = start_test_server(state).await;

        let (status, body) = post_json(
            handle.port,
            "/v1/tasks/create",
            Some("tok"),
            serde_json::json!({
                "workspace_id": "ws_task",
                "title": "Wire task tools",
                "goal": "Bridge can create tasks through MCP",
                "assignees": ["claude"]
            }),
        )
        .await;
        assert_eq!(status, 200);
        let created: serde_json::Value = serde_json::from_str(&body).unwrap();
        let task_id = created["task"]["id"].as_str().unwrap();
        assert!(task_id.starts_with("task_"));

        let (status, body) = post_json(
            handle.port,
            "/v1/tasks/update",
            Some("tok"),
            serde_json::json!({
                "workspace_id": "ws_task",
                "task_id": task_id,
                "patch": {
                    "status": "blocked",
                    "blocker": {
                        "phase": "intake",
                        "type": "human-input",
                        "reason": "Need scope",
                        "questionId": "q1"
                    }
                }
            }),
        )
        .await;
        assert_eq!(status, 200);
        let updated: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(updated["task"]["status"], "blocked");
        assert_eq!(updated["task"]["blocker"]["type"], "human-input");

        let (status, body) = post_json(
            handle.port,
            "/v1/tasks/append-feedback-event",
            Some("tok"),
            serde_json::json!({
                "workspace_id": "ws_task",
                "task_id": task_id,
                "event": {
                    "id": "evt_1",
                    "at": 1,
                    "actor": "director",
                    "kind": "hitl-question",
                    "summary": "Asked scope"
                }
            }),
        )
        .await;
        assert_eq!(status, 200);
        let with_event: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            with_event["task"]["feedbackEvents"][0]["kind"],
            "hitl-question"
        );

        let (status, body) = post_json(
            handle.port,
            "/v1/tasks/list",
            Some("tok"),
            serde_json::json!({ "workspace_id": "ws_task" }),
        )
        .await;
        assert_eq!(status, 200);
        let listed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(listed["tasks"].as_array().unwrap().len(), 1);

        let (status, body) = post_json(
            handle.port,
            "/v1/tasks/get",
            Some("tok"),
            serde_json::json!({ "workspace_id": "ws_task", "task_id": task_id }),
        )
        .await;
        assert_eq!(status, 200);
        let fetched: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(fetched["task"]["id"], task_id);
        handle.shutdown().await;
    }

    #[test]
    fn resolve_provider_returns_matching_pane_or_none() {
        let state = McpIpcState::new("s".into());
        let mut m = member("p-codex", "ws-1");
        m.provider = "codex".into();
        state.replace_fleet("w-test", vec![m, member("p-claude", "ws-1")]);
        assert_eq!(state.resolve_provider("p-codex").as_deref(), Some("codex"));
        assert_eq!(
            state.resolve_provider("p-claude").as_deref(),
            Some("claude")
        );
        assert!(state.resolve_provider("unknown").is_none());
    }

    #[test]
    fn generate_secret_is_hex_64() {
        let s = generate_secret();
        assert_eq!(s.len(), 64);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// The chicken-and-egg a phone walked into on 2026-08-09.
    ///
    /// A canvas open on a project with no agents pushes an empty list, which resets
    /// `fleet_pushed_at` — correct for staleness, and fatal for a guard that read it as
    /// *is a workspace UI alive*. The operator could not start their first agent
    /// precisely because they had none.
    #[test]
    fn an_empty_board_is_still_a_board() {
        let state = McpIpcState::new("x".into());
        assert!(!state.workspace_ui_seen(), "nothing has spoken yet");

        state.replace_canvas_fleet("w-test", vec![]);

        assert!(state.workspace_ui_seen(), "the board announced itself");
        assert!(
            state.fleet_pushed_at().is_none(),
            "and it still reported no cells — the two questions stay separate",
        );
    }

    #[test]
    fn replace_fleet_roundtrip() {
        let state = McpIpcState::new("x".into());
        assert!(state.fleet_snapshot().is_empty());
        state.replace_fleet("w-test", vec![member("a", "w")]);
        let snap = state.fleet_snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].pane_id, "a");
    }

    /// Multi-window regression: two windows pushing to the SAME surface bucket
    /// must both surface — before per-window keying the second push clobbered
    /// the first, so one window's live agents vanished from lotus_list_fleet.
    #[test]
    fn fleet_snapshot_merges_slices_from_multiple_windows() {
        let state = McpIpcState::new("x".into());
        state.replace_fleet("window-a", vec![member("a1", "ws-a")]);
        state.replace_fleet("window-b", vec![member("b1", "ws-b")]);

        let panes: Vec<String> = state
            .fleet_snapshot()
            .into_iter()
            .map(|m| m.pane_id)
            .collect();
        assert_eq!(panes.len(), 2, "both windows' agents present, no clobber");
        assert!(panes.contains(&"a1".to_string()));
        assert!(panes.contains(&"b1".to_string()));

        // Re-push for window-a REPLACES only its own slice (window-b untouched).
        state.replace_fleet("window-a", vec![member("a2", "ws-a")]);
        let panes: Vec<String> = state
            .fleet_snapshot()
            .into_iter()
            .map(|m| m.pane_id)
            .collect();
        assert_eq!(panes.len(), 2);
        assert!(panes.contains(&"a2".to_string()));
        assert!(panes.contains(&"b1".to_string()));
        assert!(!panes.contains(&"a1".to_string()));
    }

    /// Closing a window drops only its slice; other windows keep their agents.
    #[test]
    fn note_canvas_registry_tracks_mounts_and_window_close() {
        let state = McpIpcState::new("x".into());
        state.set_note_canvas("main", Some("cp_1".into()));
        assert_eq!(state.note_canvas_window("cp_1").as_deref(), Some("main"));
        state.set_note_canvas("main", None);
        assert_eq!(state.note_canvas_window("cp_1"), None);
        state.set_note_canvas("w2", Some("cp_2".into()));
        state.evict_window_fleet("w2");
        assert_eq!(state.note_canvas_window("cp_2"), None);
    }

    #[test]
    fn evict_window_fleet_drops_only_that_window() {
        let state = McpIpcState::new("x".into());
        state.replace_fleet("window-a", vec![member("a1", "ws-a")]);
        state.replace_canvas_fleet("window-a", vec![member("ac", "ws-a")]);
        state.replace_fleet("window-b", vec![member("b1", "ws-b")]);

        state.evict_window_fleet("window-a");

        let panes: Vec<String> = state
            .fleet_snapshot()
            .into_iter()
            .map(|m| m.pane_id)
            .collect();
        assert_eq!(panes, vec!["b1".to_string()], "only window-b survives");
    }

    #[test]
    fn dispatch_payload_uses_carriage_return_when_requested() {
        assert_eq!(
            build_dispatch_payload("hello".to_string(), true, Some("cr")),
            "hello\r"
        );
    }

    #[test]
    fn dispatch_payload_defaults_to_carriage_return_for_tui_submit() {
        assert_eq!(
            build_dispatch_payload("hello".to_string(), true, None),
            "hello\r"
        );
        assert_eq!(
            build_dispatch_payload("hello\n".to_string(), true, None),
            "hello\r"
        );
        assert_eq!(
            build_dispatch_payload("hello".to_string(), true, Some("lf")),
            "hello\n"
        );
    }

    #[test]
    fn swarm_claude_tui_dispatch_splits_paste_and_submit() {
        let mut target = member("swarm-architect", "ws-1");
        target.surface = Some("swarm".into());
        target.provider = "claude".into();

        let plan = build_dispatch_write_plan(
            &target,
            "line 1\nline 2".to_string(),
            true,
            None,
            None,
            None,
        );

        assert_eq!(
            plan.writes,
            vec!["line 1\nline 2".to_string(), "\r".to_string()]
        );
        assert_eq!(plan.delay_before_submit_ms, 120);
        assert_eq!(plan.bytes, "line 1\nline 2\r".len());
    }

    /// The shape Lotus Pocket dispatches into, and the one this has now got wrong twice.
    ///
    /// A canvas cell carries no `surface` (the frontend only sets it for swarm), and the
    /// split used to be gated on that — so a phone's dispatch went out as one write
    /// carrying text and CR together, and Claude Code's TUI kept it as staged paste.
    /// Measured 2026-08-07 against a live cell: an 88-character prompt sat unsubmitted
    /// at `❯` until a bare `\r` was written after it, at which point the turn started
    /// and four transcript entries appeared.
    ///
    /// The 2026-08-06 measurement this test used to encode is still true for what it
    /// tested — a two-character prompt does submit from a single write — but that is
    /// too short to trip the paste heuristic, so it generalised to the wrong rule.
    #[test]
    fn canvas_claude_dispatch_splits_paste_and_submit() {
        let target = member("Atlas", "canvas:cp_abc");

        let plan = build_dispatch_write_plan(
            &target,
            "List the files here, then summarise this project.".to_string(),
            true,
            None,
            None,
            None,
        );

        assert_eq!(
            plan.writes,
            vec![
                "List the files here, then summarise this project.".to_string(),
                "\r".to_string()
            ]
        );
        assert_eq!(plan.delay_before_submit_ms, 120);
    }

    /// A bare shell is not a TUI agent, so it keeps the single write: typing a command
    /// and its newline together is exactly what a terminal expects.
    #[test]
    fn a_plain_shell_target_still_gets_one_write() {
        let mut target = member("term-1", "canvas:cp_abc");
        target.provider = "shell".into();

        let plan = build_dispatch_write_plan(&target, "ls -la".to_string(), true, None, None, None);

        assert_eq!(plan.writes, vec!["ls -la\r".to_string()]);
        assert_eq!(plan.delay_before_submit_ms, 0);
    }

    #[test]
    fn explicit_dispatch_submit_after_paste_can_be_disabled() {
        let mut target = member("swarm-architect", "ws-1");
        target.surface = Some("swarm".into());
        target.provider = "claude".into();

        let plan = build_dispatch_write_plan(
            &target,
            "line 1\nline 2".to_string(),
            true,
            Some("cr"),
            Some(false),
            None,
        );

        assert_eq!(plan.writes, vec!["line 1\nline 2\r".to_string()]);
        assert_eq!(plan.delay_before_submit_ms, 0);
    }

    #[test]
    fn terminal_input_payload_serializes_for_frontend_hook() {
        let payload = McpTerminalInputPayload {
            pane_id: "pane-1".into(),
            workspace_id: "workspace-1".into(),
            data: "run\n".into(),
            origin: "mcp".into(),
            intent: "conversation-prompt".into(),
            submitted: true,
            prompt_text: "run".into(),
        };
        let json = serde_json::to_value(payload).unwrap();
        assert_eq!(json["paneId"], "pane-1");
        assert_eq!(json["workspaceId"], "workspace-1");
        assert_eq!(json["data"], "run\n");
        assert_eq!(json["origin"], "mcp");
        assert_eq!(json["intent"], "conversation-prompt");
        assert_eq!(json["submitted"], true);
        assert_eq!(json["promptText"], "run");
        assert!(json.get("pane_id").is_none());
    }

    #[tokio::test]
    async fn dispatch_without_session_id_returns_404() {
        // Fleet member has no session_id → dispatch should fail fast.
        let state = state_with("t", vec![member("p1", "w")]);
        let handle = start_test_server(state).await;
        let (status, _) = post_json(
            handle.port,
            "/v1/dispatch-to-cell",
            Some("t"),
            serde_json::json!({"pane_id": "p1", "command": "ls"}),
        )
        .await;
        assert_eq!(status, 404);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn dispatch_unauthorized_without_bearer() {
        let state = state_with("t", vec![member("p1", "w")]);
        let handle = start_test_server(state).await;
        let (status, _) = post_json(
            handle.port,
            "/v1/dispatch-to-cell",
            None,
            serde_json::json!({"pane_id": "p1", "command": "ls"}),
        )
        .await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn read_output_returns_empty_gracefully_for_unknown_session() {
        let state = state_with("t", vec![member("p1", "w")]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/read-cell-output",
            Some("t"),
            serde_json::json!({"pane_id": "p1"}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["ok"], false);
        assert_eq!(json["output"], "");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn hook_stop_rejects_missing_auth() {
        // Hook endpoint must require Bearer auth so external curl from a hook
        // command cannot be invoked from arbitrary local processes.
        let state = state_with("t", vec![]);
        let handle = start_test_server(state).await;
        let (status, _) = post_json(
            handle.port,
            "/v1/hook/stop",
            None,
            serde_json::json!({"pane_id": "p1"}),
        )
        .await;
        assert_eq!(status, 401);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn hook_stop_returns_ok_with_valid_auth() {
        // Fire-and-forget contract: even when no AppHandle is registered (so the
        // event cannot reach the frontend), the endpoint still returns 200 so
        // the upstream hook command does not retry or block the agent.
        let state = state_with("t", vec![]);
        let handle = start_test_server(state).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/hook/stop",
            Some("t"),
            serde_json::json!({"pane_id": "pane-uuid-123"}),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["ok"], true);
        handle.shutdown().await;
    }

    #[test]
    fn clean_cell_output_strips_ansi_and_normalizes_tui_line_noise() {
        // read_cell_output feeds an LLM: raw TUI redraw bytes (CSI sequences, bare \r,
        // blank-line storms) burn tokens and hide the text. Cleaned output keeps the words.
        let raw = "\u{1b}[K\u{1b}[1B\u{1b}[K\rAtlas\u{1b}[38;2;136;136;136m says\u{1b}[0m hi\r\n\r\n\r\n\r\nnext line\r";
        let clean = clean_cell_output(raw);
        assert_eq!(clean, "Atlas says hi\n\nnext line");
    }

    #[tokio::test]
    async fn hook_stop_records_turn_state_for_instant_wait_wake() {
        // The curl Stop hook is the fastest turn-end signal (no node process, no fs watcher) —
        // it must feed the same pane turn-state that wakes wait_cell_idle, not just the
        // frontend notification event.
        let state = state_with("t", vec![]);
        let handle = start_test_server(state.clone()).await;
        let (status, _) = post_json(
            handle.port,
            "/v1/hook/stop",
            Some("t"),
            serde_json::json!({"pane_id": "pane-uuid-123"}),
        )
        .await;
        assert_eq!(status, 200);
        let (turn, at) = state.pane_turn("pane-uuid-123").expect("turn recorded");
        assert_eq!(turn, "idle");
        assert!(at > 0);
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn hook_stop_rejects_empty_pane_id() {
        // An empty pane_id would emit a useless event the frontend cannot route.
        let state = state_with("t", vec![]);
        let handle = start_test_server(state).await;
        let (status, _) = post_json(
            handle.port,
            "/v1/hook/stop",
            Some("t"),
            serde_json::json!({"pane_id": ""}),
        )
        .await;
        assert_eq!(status, 400);
        handle.shutdown().await;
    }

    #[test]
    fn agent_stopped_payload_carries_session_id_or_null() {
        // The frontend correlates turn-end with a conversation when the hook
        // reported one; older hooks (codex notify, legacy inline curl) don't,
        // so sessionId must serialize as an explicit null, not disappear.
        let with = agent_stopped_payload("p1", Some("sess-1"));
        assert_eq!(with["paneId"], "p1");
        assert_eq!(with["sessionId"], "sess-1");
        let without = agent_stopped_payload("p1", None);
        assert_eq!(without["paneId"], "p1");
        assert!(without["sessionId"].is_null());
    }

    #[test]
    fn usage_limit_text_only_for_a_rate_limit() {
        assert_eq!(usage_limit_text(None, None), None);
        assert_eq!(usage_limit_text(Some(""), Some("x")), None);
        assert_eq!(usage_limit_text(Some("overloaded"), Some("x")), None);
        assert_eq!(usage_limit_text(Some("rate_limit"), Some(" ")).as_deref(), Some("Usage limit reached"));
        assert_eq!(
            usage_limit_text(Some("rate_limit"), Some("You've hit your 5-hour limit · resets 2:20pm")).as_deref(),
            Some("You've hit your 5-hour limit · resets 2:20pm"),
        );
    }

    #[tokio::test]
    async fn hook_stop_accepts_rich_payload_and_fails_open_without_pane_session() {
        // The new stop-hook script posts session_id + agent_pid. When the
        // pane cannot be resolved to a live PTY child (typical in tests, and
        // in production races right after spawn), nested attribution must
        // FAIL OPEN: 200 with no "nested" flag, turn state still recorded.
        let state = state_with("t", vec![]);
        let handle = start_test_server(state.clone()).await;
        let (status, body) = post_json(
            handle.port,
            "/v1/hook/stop",
            Some("t"),
            serde_json::json!({
                "pane_id": "pane-rich-9",
                "session_id": "sess-9",
                "agent_pid": 424242,
            }),
        )
        .await;
        assert_eq!(status, 200);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["ok"], true);
        assert!(
            json.get("nested").is_none(),
            "fail-open path must not claim nested"
        );
        let (turn, _) = state.pane_turn("pane-rich-9").expect("turn recorded");
        assert_eq!(turn, "idle");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn resolve_pending_matches_by_id() {
        let state = state_with("t", vec![]);
        let (id, rx) = state.register_pending();
        assert!(state.resolve_pending(
            &id,
            PendingResult {
                ok: true,
                data: Some(serde_json::json!({"paneId": "new"})),
                error: None,
            }
        ));
        let result = rx.await.unwrap();
        assert!(result.ok);
        assert_eq!(result.data.unwrap()["paneId"], "new");
    }

    #[tokio::test]
    async fn resolve_unknown_pending_returns_false() {
        let state = state_with("t", vec![]);
        assert!(!state.resolve_pending(
            "ghost",
            PendingResult {
                ok: true,
                data: None,
                error: None,
            }
        ));
    }

    #[test]
    fn output_tail_push_and_snapshot() {
        let mut tail = crate::pty::OutputTail::default();
        tail.push("hello ");
        tail.push("world");
        assert_eq!(tail.snapshot_tail(100), "hello world");
        assert_eq!(tail.snapshot_tail(5), "world");
    }

    #[test]
    fn output_tail_drops_bytes_past_limit() {
        let mut tail = crate::pty::OutputTail::default();
        let chunk = "x".repeat(1024);
        let cap = crate::pty::OUTPUT_TAIL_BYTES;
        // Twice the cap, so eviction is guaranteed whatever the cap currently is. The
        // literal that used to live here silently became a tautology when Fase 2 resized
        // the ring: 200KB pushed against a 256KB cap evicts nothing, and the assertion
        // still passed while testing the opposite of its name.
        for _ in 0..((cap / chunk.len()) * 2) {
            tail.push(&chunk);
        }
        assert_eq!(tail.len(), cap, "ring must be full and clamped at its cap");
    }

    #[test]
    fn classify_cell_state_detects_shell_prompt() {
        let (state, matched, hint) = classify_cell_state("some output\n$ ", None);
        assert_eq!(state, "ready_shell");
        assert!(matched.unwrap().contains("$ "));
        assert!(hint.is_none());
    }

    #[test]
    fn classify_cell_state_detects_claude_ready_prompt() {
        // Claude Code's interactive prompt footer.
        let tail = "welcome to claude\n> \n? for shortcuts";
        let (state, _matched, _hint) = classify_cell_state(tail, None);
        assert_eq!(state, "ready_tui");
    }

    #[test]
    fn classify_cell_state_detects_codex_welcome_dialog() {
        let tail = "release notes: https://x\n1. update now\n2. skip\n3. skip until next version\n\npress enter to continue";
        let (state, matched, hint) = classify_cell_state(tail, None);
        assert_eq!(state, "dialog");
        assert_eq!(matched.as_deref(), Some("press enter to continue"));
        assert_eq!(hint, Some("\r"));
    }

    #[test]
    fn classify_cell_state_detects_mcp_auth_dialog_no_auto_dismiss() {
        let tail = "claude code loading\n1 mcp server needs auth";
        let (state, _matched, hint) = classify_cell_state(tail, None);
        assert_eq!(state, "auth_required");
        assert!(hint.is_none(), "auth dialog must not auto-dismiss");
    }

    #[test]
    fn classify_cell_state_does_not_trip_auth_on_memory_observation_dump() {
        // Real-world failure: ccs-hss spawns and claude-mem dumps memory
        // observations on startup. Some titles contain phrases like
        // "needs auth dialog detected" or "loginflow.tsx fix" that used
        // to falsely trigger AUTH_REQUIRED. The bare strings "needs auth",
        // "sign in", and "login" are too generic — only multi-word, prompt-
        // shaped phrases should classify as auth_required.
        let tail = "#s116 codex terminal cell spawned via lotus\n#s117 needs auth dialog confirmed\nloginflow.tsx \"sign in fixed\"";
        let (state, matched, _hint) = classify_cell_state(tail, None);
        assert_eq!(
            state, "busy",
            "memory dump containing the words 'needs auth' / 'sign in' / 'login' must not trigger auth_required (matched={matched:?})"
        );
    }

    #[test]
    fn classify_cell_state_detects_real_please_sign_in_prompt() {
        // Gemini / Cursor style prompt — must classify as auth_required.
        let tail = "starting up...\nplease sign in to https://example.com to continue";
        let (state, _matched, hint) = classify_cell_state(tail, None);
        assert_eq!(state, "auth_required");
        assert!(hint.is_none());
    }

    #[test]
    fn classify_cell_state_busy_when_no_match() {
        let tail = "downloading package 50% 120kb/s";
        let (state, matched, hint) = classify_cell_state(tail, None);
        assert_eq!(state, "busy");
        assert!(matched.is_none());
        assert!(hint.is_none());
    }

    #[test]
    fn classify_cell_state_treats_ansi_only_tail_as_unknown_tui() {
        let tail = "\u{1b}[39m\u{1b}[49m\u{1b}[0m\u{1b}[?25h\u{1b}[19;3H\u{1b}[?2026l\u{1b}[10;?\u{1b}\\\u{1b}[11;?\u{1b}\\\u{1b}[?2026h\u{1b}[17;2H\u{1b}[0m\u{1b}[48;5;236m\u{1b}[K";
        let (state, matched, hint) = classify_cell_state(tail, None);
        assert_eq!(state, "unknown_tui");
        assert_eq!(matched.as_deref(), Some("ansi_tui_output"));
        assert!(hint.is_none());
    }

    #[test]
    fn classify_cell_state_dialog_pattern_only_checked_in_tail_window() {
        // Build a buffer where "press enter to continue" appears early in the
        // output (as prose) but the tail is a busy progress line.
        let mut buf = String::new();
        buf.push_str("Help: press enter to continue if you want to skip.\n");
        // Fill up 600 chars so the "press enter" phrase is definitely outside
        // the 256-byte dialog window.
        for _ in 0..60 {
            buf.push_str("downloading....\n");
        }
        let (state, _, _) = classify_cell_state(&buf.to_lowercase(), None);
        assert_eq!(
            state, "busy",
            "prose hint earlier in the buffer should not match"
        );
    }

    #[test]
    fn classify_cell_state_custom_signatures_override_defaults() {
        // Callers always pass the lowercased tail.
        let tail = "some random output\nmyapp>";
        let custom = vec!["myapp>".to_string()];
        let (state, matched, _) = classify_cell_state(tail, Some(&custom));
        assert_eq!(state, "ready_shell");
        assert_eq!(matched.as_deref(), Some("myapp>"));
    }

    #[test]
    fn dispatchable_cell_states_are_settled_and_idle() {
        assert!(is_settled_cell_state("ready_shell"));
        assert!(is_settled_cell_state("ready_tui"));
        assert!(is_settled_cell_state("dialog"));
        assert!(is_settled_cell_state("auth_required"));
        // `unknown_tui` is the "we know it's an alternate-screen agent but
        // couldn't pin a known signature" bucket — for the planner this is
        // the same actionable state as `ready_tui`: the UI is drawn and the
        // agent is waiting for input. Treating it as not-settled forced the
        // poll loop to burn the entire timeout, then map to "busy" downstream.
        assert!(is_settled_cell_state("unknown_tui"));
        assert!(!is_settled_cell_state("busy"));

        assert!(is_idle_cell_state("ready_shell"));
        assert!(is_idle_cell_state("ready_tui"));
        assert!(is_idle_cell_state("dialog"));
        assert!(is_idle_cell_state("auth_required"));
        assert!(is_idle_cell_state("unknown_tui"));
        assert!(!is_idle_cell_state("busy"));
    }

    #[test]
    fn legacy_cell_state_preserves_existing_tool_contract() {
        assert_eq!(legacy_cell_state("ready_shell"), "ready");
        assert_eq!(legacy_cell_state("ready_tui"), "ready");
        assert_eq!(legacy_cell_state("dialog"), "dialog");
        assert_eq!(legacy_cell_state("auth_required"), "dialog");
        // unknown_tui must surface to the planner as "ready" — historically
        // we mapped it to "busy" which made Bridge tell the user "agent is
        // still booting" for fully-rendered Codex / Gemini / Cursor TUIs.
        assert_eq!(legacy_cell_state("unknown_tui"), "ready");
        assert_eq!(legacy_cell_state("busy"), "busy");
    }

    #[test]
    fn classify_cell_state_codex_banner_signals_ready_tui() {
        // Snapshot of a freshly-booted Codex pane (the failure mode that
        // motivated this fix). Banner + model line + cwd line + input prompt
        // placeholder must classify as ready, not busy.
        let tail = "openai codex (v0.125.0)\n\nmodel: gpt-5.5 high   /model to change\ndirectory: ~/workspace/experiments/orchids-claude-agent-teams\n\n> improve documentation in @filename".to_string();
        let (state, _, _) = classify_cell_state(&tail, None);
        assert_eq!(state, "ready_tui");
    }

    #[test]
    fn classify_cell_state_codex_status_line_signals_ready_tui() {
        // Codex bottom status line that persists once the prompt is up.
        let tail = "some interim render\n\nctrl+c to exit · gpt-5.5 high · ~/workspace/experiments/orchids-cl…";
        let (state, _, _) = classify_cell_state(tail, None);
        assert_eq!(state, "ready_tui");
    }

    #[test]
    fn classify_cell_state_claude_esc_to_interrupt_signals_ready_tui() {
        // Claude Code TUI footer that appears once the agent is awaiting input.
        let tail = "thinking…\n\npress esc to interrupt · ? for shortcuts";
        let (state, _, _) = classify_cell_state(tail, None);
        assert_eq!(state, "ready_tui");
    }

    #[test]
    fn clean_tail_excerpt_removes_ansi_sequences() {
        let tail = "hello \u{1b}[39m\u{1b}[48;5;236mworld\u{1b}[0m";
        assert_eq!(clean_tail_excerpt(tail, 80), "hello world");
    }
}
