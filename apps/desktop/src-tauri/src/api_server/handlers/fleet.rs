//! Fleet HTTP handlers — read-only listing for v1.
//!
//! Mutating endpoints (`/api/fleet/dispatch`, `/api/fleet/read`,
//! `/api/fleet/wait`) land in a follow-up slice and route through
//! `mcp_state` and `pty::read_output_tail`.

use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api_auth::RequireAuth;
use crate::api_server::error::ApiError;
use crate::api_server::state::ApiState;
use crate::pty;

/// Unix epoch milliseconds. Local to this module because `mcp_ipc::now_ms` is
/// private, and widening another module's visibility for a timestamp is a worse
/// trade than four lines here.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

const DEFAULT_PAGE_SIZE: u32 = 10;
const MAX_PAGE_SIZE: u32 = 100;
const DEFAULT_TAIL_BYTES: usize = 4 * 1024;
/// Ceiling on one `/read` or `/scrollback` response.
///
/// Derived from the ring rather than restated: a cap below the ring makes a larger ring
/// pointless, because the poller could never drain a full interval's output in one read no
/// matter how much survived. Before Fase 2 both were 64KB, so raising either alone would
/// have changed nothing — and two literals that must agree are two literals that drift.
const MAX_TAIL_BYTES: usize = pty::OUTPUT_TAIL_BYTES;
/// Entries per transcript page. Sixty matches what the ring used to serve, so a client that
/// sends no `limit` sees at least as much as before rather than less.
/// Config directories a Claude transcript might live under: the profile this app was
/// launched with, plus the default any session with no override reads. Deduplicated,
/// because the common ccs layout symlinks one onto the other.
/// Config directories a transcript might live under, most-specific first.
///
/// `learned` are the roots hooks have actually reported (`TranscriptStore::known_roots`), and
/// they are what makes this work for a profile Lotus was never told about. The rest is the
/// environment, read from **both** the process and the login shell — because that is what the
/// child itself resolves. `apply_inherited_env` copies the process env and then lets the login
/// env override it, so a login shell that does not set the key at all leaves the process value
/// standing. Reading only one source would look in a directory the agent never used.
///
/// Deduplicated by canonical path, the same way `hook_settings_paths` does it: the ccs layout
/// points several profiles at one store through symlinks, and walking it three times would
/// cost three times as much to reach the identical answer.
fn transcript_roots(
    env_key: &str,
    default: std::path::PathBuf,
    learned: Vec<std::path::PathBuf>,
) -> Vec<std::path::PathBuf> {
    let mut roots = learned;
    for source in [
        std::env::var(env_key).ok(),
        crate::shell_env::user_login_env().get(env_key).cloned(),
    ] {
        match source {
            Some(dir) if !dir.is_empty() => roots.push(std::path::PathBuf::from(dir)),
            _ => {}
        }
    }
    roots.push(default);
    crate::settings::dedup_by_canonical_path(roots)
}

fn claude_config_roots(learned: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    let mut roots = transcript_roots("CLAUDE_CONFIG_DIR", crate::paths::claude_dir(), learned);
    // Whatever settings resolved to as well, so a change there is never a silent regression.
    let spawned = crate::settings::spawned_agent_claude_dir();
    if !roots.contains(&spawned) {
        roots.push(spawned);
    }
    roots
}

fn codex_config_roots(learned: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    transcript_roots("CODEX_HOME", crate::paths::codex_dir(), learned)
}

/// Cursor has no config-dir override this app knows of; the learned roots plus `~/.cursor`.
fn cursor_config_roots(learned: Vec<std::path::PathBuf>) -> Vec<std::path::PathBuf> {
    let mut roots = learned;
    roots.push(crate::paths::cursor_dir());
    crate::settings::dedup_by_canonical_path(roots)
}

/// The agent CLI's own transcript file for a pane, or `None` when none is known or findable.
///
/// Prefers the path a hook reported; falls back to deriving it from the session id in the
/// fleet snapshot, which covers a pane whose agent has not spoken since the app restarted. Shared
/// by Chat (`read_transcript`) and pane titles (`pane_title::pane_agent_title`), so both read
/// the same file for the same pane.
pub(crate) fn pane_transcript_path(
    transcripts: &std::sync::Mutex<crate::agent_hooks::TranscriptStore>,
    mcp_state: &crate::mcp_ipc::McpIpcState,
    pane_id: &str,
) -> Option<String> {
    // Roots come out under the same lock as the path: a second lock to fetch them would be
    // two chances to block the request for one question about the same store.
    let (reported, claude_roots, codex_roots) = match transcripts.lock() {
        Ok(store) => (
            store.transcript_path(pane_id).map(str::to_string),
            store.known_roots("projects"),
            store.known_roots("sessions"),
        ),
        Err(_) => (None, Vec::new(), Vec::new()),
    };
    if reported.is_some() {
        return reported;
    }
    let member = mcp_state
        .fleet_snapshot()
        .into_iter()
        .find(|m| m.pane_id == pane_id)?;
    let sid = member.session_id.as_deref()?;
    // Per runner, because the two store sessions differently: Claude names a file after
    // the id, Codex buries it in a date-partitioned filename. A runner with no reader
    // simply gets nothing rather than a guess.
    let found = match member.provider.as_str() {
        "claude" => crate::agent_hooks::derive_claude_path(&claude_config_roots(claude_roots), sid),
        "codex" => crate::agent_hooks::derive_codex_path(&codex_config_roots(codex_roots), sid),
        // Cursor's store sits one above `projects/` too, so the same learned roots apply;
        // `~/.cursor` is added for a session no hook has reported yet.
        "cursor" => crate::agent_hooks::derive_cursor_path(&cursor_config_roots(claude_roots), sid),
        _ => None,
    };
    found.map(|p| p.display().to_string())
}

const DEFAULT_TRANSCRIPT_LIMIT: usize = 60;
/// Ceiling on one page. A transcript can hold thousands of entries and a phone renders them
/// all; the cap is what stops one request from becoming a scroll the device cannot survive.
const MAX_TRANSCRIPT_LIMIT: usize = 500;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptQuery {
    /// Walk backwards from this cursor — the `oldestCursor` of the previous page.
    #[serde(default)]
    pub before: Option<usize>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFleetQuery {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// One cell as seen over HTTP.
///
/// Field-name history worth knowing before adding more: `agentType` is
/// `McpFleetMember::provider` and `title` is `display_name`. They are *not*
/// missing — they are renamed. Do not add `provider`/`displayName` aliases; a
/// second name for the same value is how consumers start disagreeing.
///
/// Everything below `is_alive` was added on 2026-08-02 for Lotus Pocket, whose
/// cell card needs more than a name and a liveness bit. All of it was already
/// present in the fleet snapshot and simply not forwarded. Added, never renamed,
/// so `packages/host` keeps parsing older payloads unchanged.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetMember {
    pub pane_id: String,
    pub workspace_id: String,
    /// `McpFleetMember::provider` — `claude`, `codex`, … Drives the runner logo.
    pub agent_type: String,
    /// `McpFleetMember::runner_label` — the runner's name as the desktop prints it
    /// (`acme`, `Codex`). Absent when this host cannot name it.
    ///
    /// Not a second name for `agentType`: that one is the machine-readable family a
    /// client routes on, and it deliberately reports `claude` for a custom
    /// Claude-family runner. A phone showing `claude` beside a desktop showing
    /// `acme` was the same cell described two ways, with no way to reconcile them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_label: Option<String>,
    /// `McpFleetMember::display_name` — the persona name, not the pane id.
    pub title: String,
    /// Launch-phase status (`live`, `idle`, …). Says whether the pane exists and
    /// is running — NOT whether the agent is mid-turn. For that, read `turn`.
    pub status: String,
    pub is_alive: bool,

    /// Working directory of the cell. Lets a client tell two same-named
    /// workspaces apart.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Human-readable workspace label when the frontend supplied one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_label: Option<String>,
    /// Last line of PTY output — the "still alive" line on a cell card, so a
    /// client can show motion without opening a stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_output_preview: Option<String>,
    /// What this cell was asked to do — the operator's own prompt, first line, as the
    /// canvas card shows it (`plans/agent-headlines`). The one field that says what an
    /// agent is *working on* rather than what state it is in. Absent when the desktop
    /// never saw this pane asked anything (a runner whose hooks do not reach it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    /// Agent CLI session id, when the pane has been correlated to one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,

    /// Turn-accurate state from the agent's stop hook: `idle`, `needs-input`,
    /// `running`, `error`, `ended`. `None` = no hook has fired for this pane
    /// (non-Claude-family runner, hook not installed, or never correlated).
    ///
    /// This is the field that makes `needs-input` observable as *state* rather
    /// than only as an event on `/api/notifications/stream`. Without it a client
    /// that starts cold — every mobile app launch — cannot tell which agents are
    /// waiting on a human. `mcp_ipc`'s own fleet endpoint has exposed it all
    /// along; this route simply never forwarded it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    /// Milliseconds since `turn` was recorded. A stale `needs-input` is a very
    /// different thing from a fresh one, so the age travels with the value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_age_ms: Option<u64>,

    /// Whether this cell asks before acting: `asks`, `skipped`, `runner_cannot`.
    ///
    /// ADR-8 requires the gating posture to be legible, and the three values are
    /// not interchangeable: `skipped` is fixable by respawning the cell in safe
    /// mode, `runner_cannot` never is. Absent means unknown, never ungated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gating: Option<String>,

    /// The model this session last answered with, as the agent CLI wrote it in its own
    /// transcript (`claude-opus-5-5`, `gpt-5.6-luna`). Never a runner default: absent when
    /// no transcript is known for this pane yet, or the runner does not record one (Cursor).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The git branch the session reports — Claude's latest `gitBranch`, Codex's branch at
    /// session start. Absent outside a repo, and under the same rule as `model`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFleetResponse {
    pub items: Vec<FleetMember>,
    pub total: usize,
    pub page: u32,
    pub page_size: u32,
}

/// `GET /api/fleet?workspaceId=&page=&pageSize=`
pub async fn list_fleet(
    State(state): State<ApiState>,
    _: RequireAuth,
    Query(q): Query<ListFleetQuery>,
) -> Result<Json<ListFleetResponse>, ApiError> {
    let snapshot = state.mcp_state.fleet_snapshot();

    let filtered: Vec<_> = snapshot
        .into_iter()
        .filter(|m| match &q.workspace_id {
            Some(ws) => &m.workspace_id == ws,
            None => true,
        })
        .collect();
    let total = filtered.len();

    let page = q.page.unwrap_or(1).max(1);
    let page_size = q
        .page_size
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);

    let offset = ((page - 1) as usize).saturating_mul(page_size as usize);
    let now = now_ms();
    let page_members: Vec<_> = filtered.into_iter().skip(offset).take(page_size as usize).collect();
    // Only a path a hook reported. Finding the file from the session id walks directories,
    // which is fine for one Chat open and too much for every fleet refresh; a pane whose
    // agent has not spoken since a restart gets its facts on its next turn.
    let transcript_paths: Vec<Option<String>> = match state.transcripts.lock() {
        Ok(store) => page_members
            .iter()
            .map(|m| store.transcript_path(&m.pane_id).map(str::to_string))
            .collect(),
        Err(_) => vec![None; page_members.len()],
    };
    let items: Vec<FleetMember> = page_members
        .into_iter()
        .zip(transcript_paths)
        .map(|(m, transcript_path)| {
            let facts = transcript_path
                .as_deref()
                .map(crate::agent_hooks::session_facts_at)
                .unwrap_or_default();
            // Turn state is keyed by pane id and lives outside the snapshot, so it
            // is looked up per member rather than carried by `McpFleetMember`.
            let (turn, turn_age_ms) = match state.mcp_state.pane_turn(&m.pane_id) {
                Some((turn, at_ms)) => (Some(turn), Some(now.saturating_sub(at_ms))),
                None => (None, None),
            };
            // The frontend fills `last_output_preview` only on the CodeSpace surface; a
            // canvas pane arrives without one. The PTY ring on this side has the same
            // bytes for every live pane, so a missing preview is read from there —
            // measured 2026-08-27 on a paired phone: four rows, four empty second lines,
            // while each pane's terminal had plenty to say.
            let last_output_preview = m.last_output_preview.or_else(|| {
                m.session_id
                    .as_deref()
                    .and_then(|sid| tail_preview(&state.pty_state, sid))
            });
            FleetMember {
                pane_id: m.pane_id,
                workspace_id: m.workspace_id,
                agent_type: m.provider,
                runner_label: m.runner_label,
                title: m.display_name,
                status: m.status,
                is_alive: m.is_alive,
                cwd: Some(m.cwd).filter(|c| !c.is_empty()),
                workspace_label: m.workspace_label,
                last_output_preview,
                headline: m.headline,
                session_id: m.session_id,
                turn,
                turn_age_ms,
                gating: m.gating,
                model: facts.model,
                branch: facts.branch,
            }
        })
        .collect();

    Ok(Json(ListFleetResponse {
        items,
        total,
        page,
        page_size,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCellRequest {
    pub pane_id: String,
    #[serde(default)]
    pub tail_bytes: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCellResponse {
    pub pane_id: String,
    /// UTF-8 string snapshot of the cell's PTY ring buffer (last `bytes` bytes).
    pub tail: String,
    pub bytes: usize,
}

/// `POST /api/fleet/read` — returns up to `tailBytes` of the cell's PTY tail.
///
/// 404 when `paneId` is not in the current fleet snapshot. If the cell exists
/// but has no live PTY session yet (e.g. spawn pending), returns an empty
/// tail with HTTP 200 — the caller treats that as "nothing to read yet,"
/// consistent with the MCP `lotus_read_cell_output` tool.
/// What this cell is asking, and what the operator may answer.
///
/// **Two independent signals must agree, and that is the whole design.** The hook
/// says the cell is `needs-input` (authoritative: `PreToolUse` fired and the agent
/// blocked), and the terminal says which options exist. Either alone is unsafe:
/// the hook cannot tell us the digits, and a parse alone could put buttons on a
/// prompt that was already answered.
///
/// When they disagree, `prompt` is `null` and the client shows no buttons. The
/// answer is then the raw terminal, which costs one tap; a wrong digit costs a
/// deleted file.
pub async fn read_permission(
    State(state): State<ApiState>,
    _: RequireAuth,
    Path(pane_id): Path<String>,
) -> Result<Json<PermissionResponse>, ApiError> {
    let awaiting = state
        .mcp_state
        .pane_turn(&pane_id)
        .is_some_and(|(status, _)| status == "needs-input");

    let member = state
        .mcp_state
        .fleet_snapshot()
        .into_iter()
        .find(|m| m.pane_id == pane_id);

    let mut screen_text: Option<String> = None;
    let prompt = match (
        awaiting,
        member.as_ref().and_then(|m| m.session_id.as_deref()),
    ) {
        (true, Some(session_id)) => {
            // The SCREEN, not the stream. `read_output_tail` hands back raw PTY bytes, and a
            // TUI's layout is in its cursor moves — stripping the escapes off it delivered a
            // whole prompt as one line reading `Doyouwanttocreategate17.txt?` (`issues/18`).
            // Nothing rendered means no buttons, never a guess from bytes.
            let screen = pty::read_pane_screen(session_id, &state.pty_state);
            let columns = pty::read_pane_columns(session_id, &state.pty_state);
            screen_text = screen.clone();
            screen.and_then(|s| crate::permission_prompt::parse_permission_prompt(&s, columns))
        }
        _ => None,
    };

    // Text, not audio. Reading a known string aloud is easy for any device TTS,
    // unlike recognising technical vocabulary going the other way — so the phone
    // can speak this for free and the BYOK meter never has to light up. An
    // operator who wants a better voice can still post it to their own provider.
    let readback = prompt
        .as_ref()
        .map(crate::permission_prompt::spoken_readback);

    // Only where the options could not be named. With a prompt the card already has the
    // words; without one, this is the difference between a dead end and a question the
    // operator can read.
    let tail = match (awaiting, prompt.as_ref()) {
        (true, None) => screen_text
            .as_deref()
            .and_then(crate::permission_prompt::prompt_tail),
        _ => None,
    };

    Ok(Json(PermissionResponse {
        pane_id,
        awaiting,
        prompt,
        readback,
        tail,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub pane_id: String,
    /// The hook's verdict. True with a `null` prompt means "it is waiting, but we
    /// could not read the options" — which the UI must render as a pointer to the
    /// terminal, not as "nothing to do".
    pub awaiting: bool,
    pub prompt: Option<crate::permission_prompt::PermissionPrompt>,
    /// The prompt spoken as one sentence, for hands-free use. `None` whenever
    /// `prompt` is, so there is never a read-back without something to read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readback: Option<String>,
    /// What the terminal drew, when it is waiting and the options could **not** be named.
    ///
    /// For **reading**, never for answering: the digits still come from a successful parse
    /// alone (ADR-8), so this puts the question on screen and never a button. Present exactly
    /// where `prompt` is `None` and `awaiting` is true — the case a client used to render as
    /// one sentence and a pointer to the terminal, with the question itself never crossing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tail: Option<String>,
}

/// Hook-event history for one cell — what Chat mode renders when it opens.
///
/// A separate endpoint rather than a field on the fleet snapshot: the snapshot is
/// polled every three seconds for every cell, and carrying transcripts inside it
/// would multiply that traffic by the history length for data that changes rarely.
pub async fn read_transcript(
    State(state): State<ApiState>,
    _: RequireAuth,
    Path(pane_id): Path<String>,
    Query(q): Query<TranscriptQuery>,
) -> Result<Json<TranscriptResponse>, ApiError> {
    // Deliberately not 404 for an unknown pane. A cell that has produced no hook
    // events yet is normal (a `codex` cell never will), and an error there would
    // make the phone render a fault where the truth is "nothing recorded".
    // Roots come out under the same lock as the path: a second lock to fetch them would be
    // two chances to block the request for one question about the same store.
    let ring = match state.transcripts.lock() {
        Ok(store) => store.snapshot(&pane_id),
        Err(_) => Vec::new(),
    };
    let member = state
        .mcp_state
        .fleet_snapshot()
        .into_iter()
        .find(|m| m.pane_id == pane_id);
    // Prefer the runner's own file, which has neither the ring's 60-entry cap nor its
    // habit of emptying on restart. Falling back rather than failing when it cannot be
    // read: a path can name a file the CLI has since rotated away, and losing the last
    // sixty steps to that would be a worse answer than serving them.
    //
    // A hook is not the only way to learn the path. The store only ever *learns* it from a
    // drop file, so a restart leaves Chat blank for a session whose transcript is on disk
    // until the agent speaks again — the gap Fase 0 counted fourteen times. When nothing has
    // been reported yet, the session id from the fleet snapshot is enough to find the file.
    let transcript_path = pane_transcript_path(&state.transcripts, &state.mcp_state, &pane_id);
    let limit = q
        .limit
        .unwrap_or(DEFAULT_TRANSCRIPT_LIMIT)
        .clamp(1, MAX_TRANSCRIPT_LIMIT);
    let from_file = transcript_path.as_deref().and_then(|path| {
        let text = std::fs::read_to_string(path).ok()?;
        let format = crate::agent_hooks::TranscriptFormat::sniff(&text)?;
        // The file's clock, for a format that carries none of its own (Cursor). Ignored by
        // the others, so passing it unconditionally costs one stat.
        let modified_ms = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Some(crate::agent_hooks::page_transcript(
            crate::agent_hooks::parse_transcript_file_at(&text, format, modified_ms),
            q.before,
            limit,
        ))
    });

    let (entries, source, oldest_cursor, has_more, total_ever) = match from_file {
        Some(page) => (
            page.entries,
            "file",
            page.oldest_cursor,
            page.has_more,
            Some(page.total_ever),
        ),
        // The ring has no cursor to give: it is a window that slides on its own, so a
        // client walking backwards through it would be walking through moving ground.
        None => (ring, "ring", None, false, None),
    };

    // Whether this particular CLI reports anything a transcript is made of. Looked up
    // rather than inferred from the empty list: "nothing yet" and "nothing ever" read the
    // same on the wire, and only one of them is worth telling the operator about.
    let runner_reports = member
        .as_ref()
        .and_then(|m| runner_reports_answer(m.reports_steps, &m.provider));
    let transcript_outlook = transcript_outlook_for(
        member
            .as_ref()
            .map(|m| (m.reports_steps, m.provider.as_str())),
    );

    Ok(Json(TranscriptResponse {
        pane_id,
        total: entries.len(),
        entries,
        transcript_outlook,
        transcript_path,
        source,
        oldest_cursor,
        has_more,
        total_ever,
        // Absent while the pipeline can reach the agents this host spawns, `false` when
        // it cannot — the same meaning a Standalone Host's empty answer carries, because
        // the consequence for the reader is the same: this host records nothing, so an
        // empty list is "not knowable here" rather than "nothing happened".
        host_supports: if crate::settings::hooks_reach_spawned_agents() {
            None
        } else {
            Some(false)
        },
        runner_reports,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptResponse {
    pub pane_id: String,
    /// How many entries are being returned. The ring is bounded, so this is not
    /// "everything that ever happened" and the client should not present it as such.
    pub total: usize,
    pub entries: Vec<crate::agent_hooks::TranscriptEntry>,
    /// `false` when nothing this host spawns can ever reach the transcript store —
    /// `settings::hooks_reach_spawned_agents` explains when that happens and how it was
    /// measured. **Never `true`**: the field is omitted in the healthy case, because the
    /// contract reads an absent value as "supported" and a present one as a host saying
    /// out loud that it cannot know (`contract/README.md`).
    ///
    /// Carried here rather than on the fleet snapshot because this is where a client
    /// asks the question — the snapshot is polled every three seconds for every cell,
    /// and this changes about as often as the operator switches ccs profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_supports: Option<bool>,
    /// `false` when the CLI behind this pane has nothing to report *with*, however
    /// healthy the host is. Codex's entire surface into Lotus is one
    /// `agent-turn-complete` notify carrying a pane id
    /// ([`crate::mcp_config::build_codex_notify_script`]) — no prompt, no tool steps, no
    /// prose — so its ring is empty forever and Chat is not late, it is never coming.
    ///
    /// Separate from [`Self::host_supports`] because the operator's next move differs:
    /// that one sends them to fix the desktop, and there is nothing here to fix.
    /// **Never `true`**, on the same rule — absent reads as "it reports".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_reports: Option<bool>,
    /// `"never"` or `"unknown"`, omitted when a transcript is genuinely expected.
    ///
    /// **Why this exists next to a field that already answers most of it.**
    /// [`Self::runner_reports`] has two values and three cases. Its absence means "steps
    /// are coming", so the case it cannot express is *this host does not know* — and that
    /// case is not rare. The pane→runner map is pushed by the desktop UI (ADR-1), so it is
    /// empty until a Canvas board is on screen and after every restart. Measured on
    /// 2026-08-10: a desktop twelve minutes up, with `/canvas` loaded, answered absent for
    /// every pane — including a Codex cell it had called `false` minutes earlier. Chat read
    /// that as a promise and waited for a transcript nobody was going to send.
    ///
    /// Kept additive rather than replacing `runner_reports`, because a phone already in the
    /// operator's pocket reads the old field and must keep working unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_outlook: Option<&'static str>,
    /// Where this pane's agent CLI keeps its own conversation, when a hook has reported it.
    ///
    /// Absent means no drop for this pane has carried one — a runner with no hook pipeline,
    /// or a session whose first event has not landed. Omitted rather than sent empty, for
    /// the reason `workspace_label` is: an empty string is a path, and a blank one.
    ///
    /// The client does not read this file itself; it is here so the *host* can be asked to,
    /// which is what Fase 3 builds on top. `entries` above is the 60-event ring and loses
    /// 11.7% of what it is given (Fase 0); the file this names loses nothing and survives
    /// restarts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    /// Where these entries came from: `file` (the runner's own transcript) or `ring` (the
    /// bounded in-memory hook history).
    ///
    /// A client needs this to know whether paging back is even possible, and an operator
    /// needs it to understand why an older session shows less. Sent always rather than only
    /// when interesting — an absent field would have to be guessed at.
    pub source: &'static str,
    /// Cursor for the next page back, when reading a file. Absent for the ring, which
    /// cannot be paged: it is a window that slides on its own, so walking backwards through
    /// it would be walking through moving ground.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_cursor: Option<usize>,
    /// Whether older entries exist beyond this page.
    pub has_more: bool,
    /// Entries the source holds in total.
    ///
    /// Deliberately beside `total` rather than replacing it (ADR-4): `total` has always
    /// meant "how many are in this response", clients in the field read it that way, and
    /// changing a field's meaning is the one thing an additive contract must not do.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_ever: Option<usize>,
}

/// The three-way answer: `None` means a transcript is expected, `"never"` that none is
/// coming, `"unknown"` that this host cannot say.
///
/// `member` is `None` when the pane is absent from the pushed fleet snapshot. That is the
/// case the old two-valued field got wrong: it stayed silent, and silence is a promise.
/// Saying `"unknown"` costs the operator one honest sentence and saves them waiting on a
/// screen that was never going to fill.
fn transcript_outlook_for(member: Option<(Option<bool>, &str)>) -> Option<&'static str> {
    let Some((reports_steps, provider)) = member else {
        return Some("unknown");
    };
    match runner_reports_answer(reports_steps, provider) {
        None => None,
        Some(_) => Some("never"),
    }
}

/// What to tell a client about whether this cell's CLI reports transcript steps.
///
/// `None` is "it reports" on the wire (`contract/README.md`), `Some(false)` is the host
/// saying out loud that no transcript is coming.
///
/// The frontend's `reports_steps` wins because it is the only layer that still knows the
/// runner for what it is. Reading the answer off `provider` — which is all this had before
/// — got it wrong in two ways that both ended as a Chat waiting forever: a custom
/// Claude-family runner publishes as `claude` **on purpose**, and so does any runner the
/// frontend has not reported yet (`runnerToFleetProvider`).
///
/// The label is kept as a fallback for a frontend that predates the flag. It is wrong in
/// exactly those two cases, but no more wrong than the code it replaced, and guessing
/// `false` instead would silence Chat for healthy Claude cells — the worse direction.
fn runner_reports_answer(reports_steps: Option<bool>, provider: &str) -> Option<bool> {
    match reports_steps {
        Some(true) => None,
        Some(false) => Some(false),
        None if provider_reports_steps(provider) => None,
        None => Some(false),
    }
}

/// Providers whose agents drive Lotus's hook pipeline, so a transcript can exist.
///
/// The claude family (`ccs`/`csp`, and a custom runner that drives the claude binary)
/// all publish as `claude`, which is why this is one entry rather than a family list —
/// see `runnerToFleetProvider` in `canvas-fleet.ts`. That collapsing is precisely why this
/// is now only a fallback: see [`runner_reports_answer`].
///
/// **`codex` joined on 2026-08-13**, when `codex_hooks` registered the agent-notify pipeline
/// against `~/.codex/hooks.json`. Before that Codex reached Lotus only through the `notify`
/// slot, which fires once per turn and whose handler never touches the transcript store —
/// so `transcript_outlook` correctly answered `"never"` and Chat rendered "no transcript is
/// coming" instead of an empty wait.
///
/// **`cursor` joined on 2026-08-27.** Not through a Cursor installer — three probes showed
/// `cursor-agent` 2026.08.25 never executes entries in `~/.cursor/hooks.json` — but because
/// Cursor loads the **Claude-format** hooks in `~/.claude/settings.json`: `PreToolUse` and
/// `PostToolUse` fired for a headless `cursor-agent -p` with `LOTUS_PANE_ID` inherited, and
/// carried `transcript_path` into `~/.cursor/projects/…/agent-transcripts/`, which
/// `transcript_source::TranscriptFormat::Cursor` reads. `UserPromptSubmit` and `Stop` did not
/// fire there, so the file — not the ring — is where a Cursor cell's prompts and prose come from.
///
/// This answers "the provider *can* report", not "this cell *is* reporting". A Codex whose
/// hook is registered but not yet trusted by the operator produces nothing
/// (`codex_hooks::CodexHookTrust::AwaitingApproval`), and that is deliberately **not**
/// folded in here: it is a per-machine setup state, while this is a per-provider capability.
/// Surfacing the untrusted case is `codex_hooks::trust_state_on_disk`'s job, and it has to
/// say so out loud rather than let Chat look merely quiet.
fn provider_reports_steps(provider: &str) -> bool {
    crate::agent_catalog::drives_hooks(provider)
}

#[cfg(test)]
mod transcript_source_tests {
    use super::transcript_roots;
    use crate::api_server::tests_support::{auth_header, test_state};
    use axum::body::Body;
    use axum::http::Request;
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    /// Fase 3 (`issues/04`). Two sources, and the response has to say which — a client
    /// cannot know whether paging back is possible otherwise, and an operator cannot
    /// understand why an older session shows less.
    async fn get_transcript(
        state: crate::api_server::state::ApiState,
        query: &str,
    ) -> serde_json::Value {
        let app = Router::new()
            .route(
                "/api/fleet/:pane_id/transcript",
                get(super::read_transcript),
            )
            .layer(axum::Extension((*state.api_key).clone()))
            .with_state(state);
        let (k, v) = auth_header();
        let res = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/fleet/p-1/transcript{query}"))
                    .header(k, v)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn payload_with_path(path: &str) -> crate::agent_hooks::DropPayload {
        crate::agent_hooks::DropPayload {
            version: 1,
            session_id: None,
            agent_type: "claude".into(),
            event: "stop".into(),
            status: "idle".into(),
            title: "Finished working".into(),
            body: "from the ring".into(),
            user_prompt: String::new(),
            tool_target: String::new(),
            lines_added: None,
            lines_removed: None,
            body_truncated: false,
            transcript_path: path.into(),
            cwd: String::new(),
            pid: None,
            agent_pid: None,
            pane_id: Some("p-1".into()),
            timestamp: 1,
        }
    }

    /// A key that is not set anywhere, so the ordering is provable without touching the
    /// process env — which other tests share and would race on.
    const UNSET: &str = "LOTUS_TEST_TRANSCRIPT_ROOT_UNSET";

    /// Learned roots go first because they are evidence: a hook reported a transcript there.
    /// The configured default is the fallback, not the other way round.
    #[test]
    fn a_learned_root_is_searched_before_the_default() {
        let roots = transcript_roots(
            UNSET,
            std::path::PathBuf::from("/home/.claude"),
            vec![std::path::PathBuf::from("/home/.ccs/instances/initech")],
        );
        assert_eq!(
            roots,
            vec![
                std::path::PathBuf::from("/home/.ccs/instances/initech"),
                std::path::PathBuf::from("/home/.claude"),
            ]
        );
    }

    /// The ccs layout points several profiles at one store through symlinks; walking it
    /// once per profile costs three times as much to reach the identical answer.
    #[test]
    fn roots_that_resolve_to_the_same_directory_are_walked_once() {
        let dir = tempfile::TempDir::new().unwrap();
        let real = dir.path().join("store");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.path().join("profile");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let roots = transcript_roots(UNSET, real.clone(), vec![link.clone()]);
        assert_eq!(
            roots,
            vec![link],
            "the learned root survives, the duplicate goes"
        );
    }

    /// With nothing learned yet — a fresh install, or the first pane after a restart — the
    /// default still has to be there, or derivation would have nowhere to look.
    #[test]
    fn the_default_root_stands_alone_when_nothing_has_been_learned() {
        let roots = transcript_roots(UNSET, std::path::PathBuf::from("/home/.codex"), Vec::new());
        assert_eq!(roots, vec![std::path::PathBuf::from("/home/.codex")]);
    }

    #[tokio::test]
    async fn a_pane_with_no_transcript_path_is_served_from_the_ring() {
        let state = test_state();
        state
            .transcripts
            .lock()
            .unwrap()
            .record(&payload_with_path(""));
        let body = get_transcript(state, "").await;
        assert_eq!(body["source"], "ring");
        assert_eq!(body["entries"][0]["body"], "from the ring");
        // The ring is a window that slides on its own, so there is nothing stable to page
        // backwards through — saying so beats offering a cursor that walks moving ground.
        assert!(body["oldestCursor"].is_null());
        assert_eq!(body["hasMore"], false);
        assert!(body["totalEver"].is_null());
    }

    #[tokio::test]
    async fn a_readable_transcript_wins_over_the_ring_and_can_be_paged() {
        let dir = tempfile::TempDir::new().unwrap();
        // `.claude/` in the path is what `TranscriptFormat::detect` keys on.
        let nested = dir.path().join(".claude").join("projects");
        std::fs::create_dir_all(&nested).unwrap();
        let file = nested.join("s.jsonl");
        let lines: String = (0..10)
            .map(|i| {
                format!(
                    r#"{{"type":"user","timestamp":"2026-08-13T10:00:0{}.000Z","message":{{"role":"user","content":"p{}"}}}}"#,
                    i % 10,
                    i
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&file, lines).unwrap();

        let state = test_state();
        state
            .transcripts
            .lock()
            .unwrap()
            .record(&payload_with_path(file.to_str().unwrap()));

        let first = get_transcript(state.clone(), "?limit=4").await;
        assert_eq!(first["source"], "file", "the durable source wins");
        assert_eq!(first["entries"].as_array().unwrap().len(), 4);
        assert_eq!(first["entries"][0]["userPrompt"], "p6");
        assert_eq!(first["oldestCursor"], 6);
        assert_eq!(first["hasMore"], true);
        assert_eq!(first["totalEver"], 10, "what `total` could never say");

        let second = get_transcript(state, "?limit=4&before=6").await;
        assert_eq!(second["entries"][0]["userPrompt"], "p2", "no repeat");
        assert_eq!(second["entries"][3]["userPrompt"], "p5", "no gap");
    }

    /// A path can name a file the CLI has since rotated away. Losing the last sixty steps
    /// to that would be a worse answer than serving them.
    #[tokio::test]
    async fn an_unreadable_path_falls_back_to_the_ring_rather_than_failing() {
        let state = test_state();
        state
            .transcripts
            .lock()
            .unwrap()
            .record(&payload_with_path("/nonexistent/.claude/gone.jsonl"));
        let body = get_transcript(state, "").await;
        assert_eq!(body["source"], "ring");
        assert_eq!(body["entries"][0]["body"], "from the ring");
    }
}

#[cfg(test)]
mod runner_reports_tests {
    use super::{runner_reports_answer, transcript_outlook_for};

    /// The measured defect. The pane→runner map is pushed by the desktop UI, so it is
    /// empty after every restart and until a board is on screen — and the old field
    /// answered that with silence, which the contract defines as "steps are coming".
    #[test]
    fn a_pane_the_host_cannot_place_is_unknown_not_a_promise() {
        assert_eq!(transcript_outlook_for(None), Some("unknown"));
    }

    #[test]
    fn a_runner_that_reports_leaves_the_outlook_absent() {
        assert_eq!(transcript_outlook_for(Some((Some(true), "claude"))), None);
        assert_eq!(transcript_outlook_for(Some((None, "claude"))), None);
    }

    /// Codex moved from `"never"` to reporting on 2026-08-13, when `codex_hooks` registered
    /// the agent-notify pipeline against `~/.codex/hooks.json`. Its payload feeds the same
    /// extractors unchanged, so a Codex cell now produces the same transcript entries a
    /// Claude cell does.
    #[test]
    fn codex_reports_steps_now_that_its_hooks_are_registered() {
        assert_eq!(transcript_outlook_for(Some((Some(true), "codex"))), None);
        assert_eq!(transcript_outlook_for(Some((None, "codex"))), None);
    }

    #[test]
    fn a_runner_with_nothing_to_report_with_is_never_not_unknown() {
        // The distinction the operator acts on: `never` means stop waiting and open the
        // raw terminal; `unknown` means the host could not tell and might yet.
        assert_eq!(
            transcript_outlook_for(Some((Some(false), "claude"))),
            Some("never")
        );
        // A runner with no hook pipeline at all — an arbitrary custom command Lotus knows
        // nothing about. (Cursor used to be the example here; it runs the Claude-format
        // hooks and joined `provider_reports_steps` on 2026-08-27.)
        assert_eq!(
            transcript_outlook_for(Some((None, "custom"))),
            Some("never")
        );
        assert_eq!(transcript_outlook_for(Some((None, "cursor"))), None);
    }

    /// The bug this function exists for. A custom runner wrapping a second Claude account
    /// publishes as `claude` by design, and so does one the frontend has not named yet —
    /// so the old provider-only answer claimed both report steps, and Chat waited for a
    /// transcript that was never coming.
    #[test]
    fn the_frontends_answer_beats_a_provider_label_that_collapsed_the_family() {
        assert_eq!(runner_reports_answer(Some(false), "claude"), Some(false));
    }

    /// `None` on the wire means "it reports" — the healthy Claude case stays silent.
    #[test]
    fn a_runner_that_reports_says_nothing() {
        assert_eq!(runner_reports_answer(Some(true), "claude"), None);
        assert_eq!(runner_reports_answer(Some(true), "custom"), None);
    }

    #[test]
    fn a_runner_that_does_not_report_is_named_whatever_the_label_says() {
        assert_eq!(runner_reports_answer(Some(false), "codex"), Some(false));
        assert_eq!(runner_reports_answer(Some(false), "cursor"), Some(false));
    }

    /// Without the flag we are back to the label, and `codex` now sits on the reporting
    /// side of it. `custom` stays silent-by-default for the reason above: it is the label a
    /// frontend uses before it has named the runner, so guessing "reports" there would put
    /// Chat back to waiting forever.
    #[test]
    fn an_older_frontend_falls_back_to_the_label() {
        assert_eq!(runner_reports_answer(None, "claude"), None);
        assert_eq!(runner_reports_answer(None, "codex"), None);
        assert_eq!(runner_reports_answer(None, "custom"), Some(false));
    }
}

pub async fn read_cell(
    State(state): State<ApiState>,
    _: RequireAuth,
    Json(req): Json<ReadCellRequest>,
) -> Result<Json<ReadCellResponse>, ApiError> {
    let snapshot = state.mcp_state.fleet_snapshot();
    let member = snapshot
        .into_iter()
        .find(|m| m.pane_id == req.pane_id)
        .ok_or_else(|| ApiError::not_found(format!("pane {}", req.pane_id)))?;

    let max_bytes = req
        .tail_bytes
        .unwrap_or(DEFAULT_TAIL_BYTES)
        .min(MAX_TAIL_BYTES);

    let tail = match &member.session_id {
        Some(sid) => pty::read_output_tail(sid, max_bytes, &state.pty_state),
        None => String::new(),
    };

    Ok(Json(ReadCellResponse {
        pane_id: member.pane_id,
        bytes: tail.len(),
        tail,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackRequest {
    pub pane_id: String,
    /// Absolute byte offset to read from. The ring buffer is byte-addressed, so this
    /// is the only form of resume that matches how the data is actually stored.
    pub from_byte: u64,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollbackResponse {
    pub pane_id: String,
    pub text: String,
    /// Where [text] actually starts. **Greater than the requested `fromByte` when the
    /// ring buffer has moved on** — that difference is what a client reports as
    /// `cell.truncated` rather than pretending the gap did not happen.
    pub offset: u64,
    /// Total bytes this session has ever produced, so a caller knows where it stands
    /// without reading the whole buffer.
    pub total_bytes: u64,
}

/// `POST /api/fleet/scrollback` — output from an absolute offset.
///
/// `/api/fleet/read` answers "the last N bytes", which cannot resume: after a phone
/// reconnects it needs *what it missed*, and only an offset expresses that. The
/// machinery existed already (`pty::read_scrollback`) but was reachable from Tauri
/// alone — so the mobile façade, which talks HTTP, had no source for `cell.output`
/// at all.
pub async fn read_scrollback(
    State(state): State<ApiState>,
    _: RequireAuth,
    Json(req): Json<ScrollbackRequest>,
) -> Result<Json<ScrollbackResponse>, ApiError> {
    let snapshot = state.mcp_state.fleet_snapshot();
    let member = snapshot
        .into_iter()
        .find(|m| m.pane_id == req.pane_id)
        .ok_or_else(|| ApiError::not_found(format!("pane {}", req.pane_id)))?;

    let max_bytes = req
        .max_bytes
        .unwrap_or(DEFAULT_TAIL_BYTES)
        .min(MAX_TAIL_BYTES);

    // A pane whose PTY has not started yet is normal, not an error: the caller polls,
    // and an empty answer at offset 0 says "nothing yet" without inventing a failure.
    let Some(session_id) = member.session_id else {
        return Ok(Json(ScrollbackResponse {
            pane_id: member.pane_id,
            text: String::new(),
            offset: req.from_byte,
            total_bytes: 0,
        }));
    };

    let chunk = pty::read_scrollback(&session_id, req.from_byte, max_bytes, &state.pty_state)?;

    Ok(Json(ScrollbackResponse {
        pane_id: member.pane_id,
        text: chunk.text,
        offset: chunk.offset,
        total_bytes: chunk.total_bytes,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    pub pane_id: String,
    pub command: String,
    /// Defaults to true so the cell executes the command on submit.
    #[serde(default)]
    pub append_newline: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResponse {
    pub pane_id: String,
    pub bytes_written: usize,
    /// Last 1 KB of cell output after the dispatch — lets the operator see
    /// the immediate result without a follow-up `/read`.
    pub tail_preview: String,
}

const TAIL_PREVIEW_BYTES: usize = 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseCellRequest {
    pub pane_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnCellRequest {
    /// Which agent to launch: `claude`, `codex`, …
    pub provider: String,
    /// Optional workspace target; the window uses its active one when absent.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// First task, typed into the cell once it is up (the orchestrator pattern).
    #[serde(default)]
    pub initial_prompt: Option<String>,
    /// Runner id when it is not the provider's own — how a **custom** runner is named
    /// (`custom-acme`). The window resolves it against the runner registry; without
    /// it a custom runner silently becomes whatever `provider` said instead.
    #[serde(default)]
    pub runner_id: Option<String>,
    /// `safe` or `yolo`. **The only moment this can be chosen** — the flag that turns
    /// the gate off is a process argument, so a running cell cannot be turned back.
    #[serde(default)]
    pub permission_mode: Option<String>,
    /// Model alias and effort, as `bootstrap.runners[]` advertised them (`spawn-tuning` in
    /// `contract/README.md`). Process arguments too, so this is their one moment as well.
    /// Absent keeps the CLI's own defaults; the window turns them into the runner's flags.
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// Claude only: the account to run as (`runners[].profiles`, issues/07). Absent = the one
    /// chosen on this desktop; `default` = `CLAUDE_CONFIG_DIR` unset.
    #[serde(default)]
    pub profile_id: Option<String>,
    /// The agent pane that asked for this spawn. Carried as on `/v1/spawn-cell`, so a pane an
    /// agent opens through this route also lands in that agent's Code group (#319). The phone
    /// itself sends none.
    #[serde(default)]
    pub from_pane_id: Option<String>,
}

/// `POST /api/fleet/dispatch` — writes `command` to the cell's PTY input.
///
/// Status semantics aligned with `withFocus` in lotus-remote:
/// - **404 Not Found** when `paneId` is not in the current fleet snapshot
///   (never seen — operator typo or stale focus from a different workspace).
/// - **410 Gone** when the cell exists in the fleet but has no live PTY
///   session id (cell exited / was closed; client clears focus).
pub async fn dispatch(
    State(state): State<ApiState>,
    _: RequireAuth,
    Json(req): Json<DispatchRequest>,
) -> Result<Json<DispatchResponse>, ApiError> {
    let snapshot = state.mcp_state.fleet_snapshot();
    let member = snapshot
        .into_iter()
        .find(|m| m.pane_id == req.pane_id)
        .ok_or_else(|| ApiError::not_found(format!("pane {}", req.pane_id)))?;

    let session_id = member
        .session_id
        .clone()
        .ok_or_else(|| ApiError::Gone(format!("pane {} has no live PTY session", req.pane_id)))?;

    // The same plan the MCP dispatch tool builds, rather than a second idea of what
    // "submit" means. This route used to append `\n`, and a TUI agent — which is what
    // `claude` and `codex` are — leaves that in its prompt buffer without submitting:
    // measured on 2026-08-06 against a live Claude Code cell, where the text sat at
    // the prompt until a single `\r` was written after it. Enter on a real keyboard is
    // CR, and `build_dispatch_write_plan` has been sending CR all along on the path
    // the desktop itself uses.
    let plan = crate::mcp_ipc::build_dispatch_write_plan(
        &member,
        req.command.clone(),
        req.append_newline.unwrap_or(true),
        None,
        None,
        None,
    );
    let bytes_written = plan.bytes;

    for (index, write) in plan.writes.iter().enumerate() {
        // A TUI target gets its submit key as a separate write after a pause, because
        // one write carrying both can be swallowed while the app is still handling the
        // paste. Single-write plans never reach this branch.
        if index > 0 && plan.delay_before_submit_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(
                plan.delay_before_submit_ms,
            ))
            .await;
        }
        pty::write_to_session(session_id.clone(), write.clone(), &state.pty_state)
            .map_err(ApiError::from)?;
    }

    let tail_preview = pty::read_output_tail(&session_id, TAIL_PREVIEW_BYTES, &state.pty_state);

    // Ask the window to bring this pane's project on screen.
    //
    // **Only this route, deliberately.** Agent-to-agent dispatch goes through the MCP
    // server's own `/v1/dispatch-to-cell`, and a swarm talks constantly — following every
    // one of those would leave the board thrashing between projects all day. This route is
    // the remote operator's, and they are the one person whose attention the view should
    // track.
    //
    // Best-effort, and it must stay that way: the prompt is already in the PTY by now. A
    // window that is closed, on another route, or slow to answer changes nothing about
    // what the agent received, so a failure here is not the caller's problem and never
    // becomes an error they see.
    let _ = state.mcp_state.emit_to_frontend(
        "mcp://follow-pane",
        serde_json::json!({ "paneId": &member.pane_id }),
    );

    Ok(Json(DispatchResponse {
        pane_id: member.pane_id,
        bytes_written,
        tail_preview,
    }))
}

/// `POST /api/fleet/close` — ends a cell: its process stops and the pane leaves its
/// workspace.
///
/// **The work is not done here, and cannot be.** Panes belong to the workspace UI, so
/// this asks the Lotus window over the same `mcp://close-cell` event the MCP sidecar's
/// `lotus_close_cell` uses, and waits for it to answer. Sharing that path rather than
/// adding a second one is what keeps one pane-removal story: the frontend already
/// dedupes by request id and reports its own failure text.
///
/// Two refusals that are not faults, and are worded as such:
/// - no fleet snapshot has ever been pushed, so no window is on a workspace;
/// - the window did not answer inside the budget.
///
/// Both answer **503**, because both are true of the machine right now and untrue a
/// moment later. A phone that received a 500 would tell its operator something broke.
pub async fn close_cell(
    State(state): State<ApiState>,
    _: RequireAuth,
    Json(req): Json<CloseCellRequest>,
) -> Result<Json<Value>, ApiError> {
    // Asks whether a board is listening, not whether cells exist. Those are different
    // questions, and keying on the second is what refused a spawn into an empty project.
    if !state.mcp_state.workspace_ui_seen() {
        return Err(ApiError::unavailable(
            "no active Lotus workspace UI — open the Lotus window on a workspace so it can close cells",
        ));
    }

    let (request_id, rx) = state.mcp_state.register_pending();
    state
        .mcp_state
        .emit_to_frontend(
            "mcp://close-cell",
            serde_json::json!({ "requestId": request_id, "paneId": req.pane_id }),
        )
        .map_err(|err| ApiError::unavailable(format!("cannot reach the Lotus window: {err}")))?;

    // Six seconds, the same budget the MCP route uses: removing a pane is local work,
    // and a longer wait only makes a hung window look like a slow one.
    match tokio::time::timeout(Duration::from_secs(6), rx).await {
        Ok(Ok(result)) if result.ok => {
            Ok(Json(result.data.unwrap_or_else(
                || serde_json::json!({ "ok": true, "paneId": req.pane_id }),
            )))
        }
        // The window's own words. It knows things this route does not — that the pane
        // was already gone, that it belongs to another workspace — and paraphrasing
        // them here would lose the only diagnosis anyone has.
        Ok(Ok(result)) => Err(ApiError::internal(
            result.error.unwrap_or_else(|| "close failed".into()),
        )),
        Ok(Err(_)) => Err(ApiError::internal("close channel closed")),
        Err(_) => {
            state.mcp_state.forget_pending(&request_id);
            Err(ApiError::unavailable(
                "the Lotus workspace UI did not close the cell within 6s (is the window open on a workspace?)",
            ))
        }
    }
}

/// `POST /api/fleet/spawn` — starts a new cell in the workspace the window is on.
///
/// The twin of [`close_cell`], and the same shape for the same reason: panes belong to
/// the Lotus window, so this asks it over `mcp://spawn-cell` and waits. Ten seconds
/// rather than six, matching the MCP route, because the window has a runner to launch
/// and a pane to register before it can answer with an id.
///
/// Answers as soon as the pane is **registered**, not when the agent inside is ready.
/// That is the contract the MCP tool already documents, and a client that needs more
/// waits for the fleet snapshot to carry the cell.
pub async fn spawn_cell(
    State(state): State<ApiState>,
    _: RequireAuth,
    Json(req): Json<SpawnCellRequest>,
) -> Result<Json<Value>, ApiError> {
    if req.provider.trim().is_empty() {
        return Err(ApiError::bad_request("provider is required"));
    }
    // Checked for shape, not for vocabulary. This route used to insist on `safe`/`yolo`, and
    // it was a **third** copy of a list that had already moved: the host advertises each
    // runner's own stops through `bootstrap.runners[].permissions[]`, so a phone offering
    // `manual` — a stop its own host had just named — was refused here with a 400 that the
    // host then rethrew as an opaque `Internal Server Error` (measured 2026-08-27).
    //
    // The vocabulary belongs to whatever turns a stop into flags, which is
    // `resolveRunnerCommand` in the window. What is still refused here is the one thing that
    // is wrong regardless of vocabulary: a field present but empty, which is a caller
    // asking for a posture and naming none.
    if let Some(mode) = req.permission_mode.as_deref() {
        if mode.trim().is_empty() {
            return Err(ApiError::bad_request(
                "permissionMode must name a stop from the runner's scale, or be omitted",
            ));
        }
    }
    // Refused by name here: the window would start the cell and only its PTY would fail, after
    // the phone had been told it started.
    if let Some(id) = req.profile_id.as_deref() {
        if crate::accounts::find(id).is_none() {
            let known: Vec<String> = crate::accounts::claude_accounts().into_iter().map(|a| a.id).collect();
            return Err(ApiError::bad_request(format!("no account named \"{id}\" — this machine has {}", known.join(", "))));
        }
    }
    if !state.mcp_state.workspace_ui_seen() {
        return Err(ApiError::unavailable(
            "no active Lotus workspace UI — open the Lotus window on a workspace so it can start agents",
        ));
    }

    let (request_id, rx) = state.mcp_state.register_pending();
    state
        .mcp_state
        .emit_to_frontend(
            "mcp://spawn-cell",
            serde_json::json!({
                "requestId": request_id,
                "provider": req.provider,
                "workspaceId": req.workspace_id,
                "initialPrompt": req.initial_prompt,
                "runnerId": req.runner_id,
                "permissionMode": req.permission_mode,
                "model": req.model,
                "effort": req.effort,
                "profileId": req.profile_id,
                "fromPaneId": req.from_pane_id,
            }),
        )
        .map_err(|err| ApiError::unavailable(format!("cannot reach the Lotus window: {err}")))?;

    match tokio::time::timeout(Duration::from_secs(10), rx).await {
        Ok(Ok(result)) if result.ok => {
            Ok(Json(result.data.unwrap_or_else(|| serde_json::json!({}))))
        }
        Ok(Ok(result)) => Err(ApiError::internal(
            result.error.unwrap_or_else(|| "spawn failed".into()),
        )),
        Ok(Err(_)) => Err(ApiError::internal("spawn channel closed")),
        Err(_) => {
            state.mcp_state.forget_pending(&request_id);
            Err(ApiError::unavailable(
                "the Lotus workspace UI did not start the agent within 10s (is the window open on a workspace?)",
            ))
        }
    }
}

/// The last line a human would call output, from the tail of a pane's PTY ring.
pub(crate) fn tail_preview(pty: &crate::pty::PtyState, session_id: &str) -> Option<String> {
    let raw = crate::pty::read_output_tail(session_id, 4096, pty);
    last_meaningful_line(&raw)
}

/// Strips escapes, then walks back to the last line a human would call output.
///
/// A TUI's final frame ends in chrome, not output: box-drawing around the prompt, block
/// glyphs in a progress bar, and a status footer (`Claude Code v2.1.247 … Opus 5`). Measured
/// on a paired phone (2026-08-27) — the first version of this shipped that footer, blocks
/// and all, as the "headline" of three idle agents. So: block/box/braille runs are removed
/// outright, whitespace collapsed, lines with fewer than three letters or digits skipped,
/// and lines that read as a CLI's own status bar skipped by phrase. Capped at 120 chars.
pub(crate) fn last_meaningful_line(raw: &str) -> Option<String> {
    let clean = crate::pane_title::strip_ansi_and_controls(raw);
    let lines: Vec<&str> = clean.lines().collect();
    // First choice: the agent's own last utterance. Claude Code marks every assistant and
    // tool line with `⏺`, so the last such line is what the agent most recently said or
    // did — measured 2026-08-27 after the generic pass returned the permission footer for
    // four different agents at once, because an idle TUI's final frame *is* its chrome.
    if let Some(said) = lines
        .iter()
        .rev()
        .map(|l| l.trim_start())
        .find(|l| l.starts_with('\u{23FA}'))
        .map(|l| tidy_line(l.trim_start_matches('\u{23FA}')))
        .filter(|l| l.chars().filter(|c| c.is_alphanumeric()).count() >= 3)
    {
        return Some(said.chars().take(120).collect());
    }
    // A Claude TUI that has drawn ⏺ anywhere but said nothing yet has nothing worth
    // quoting — its remaining lines are banner and prompt — so the generic pass is for
    // runners that do not mark their lines at all (Codex, a plain shell).
    if lines.iter().any(|l| l.trim_start().starts_with('\u{23FA}')) {
        return None;
    }
    lines
        .iter()
        .rev()
        .map(|l| tidy_line(l))
        .find(|line| line.chars().filter(|c| c.is_alphanumeric()).count() >= 3 && !is_cli_chrome(line))
        .map(|line| line.chars().take(120).collect::<String>())
}

/// `ccs 3.2.0`, `codex v0.150.1`, `Claude Code v2.1.247 …`: a name followed by a dotted
/// version is a banner whatever the tool. Two tokens are enough to tell.
fn is_version_banner(lower: &str) -> bool {
    let mut words = lower.split_whitespace();
    let (Some(name), Some(version)) = (words.next(), words.next()) else { return false };
    let v = version.trim_start_matches('v');
    name.chars().all(|c| c.is_alphabetic() || c == '-')
        && v.contains('.')
        && v.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Drops the glyph ranges TUIs draw frames and bars with, then collapses whitespace.
fn tidy_line(line: &str) -> String {
    let kept: String = line
        .chars()
        .map(|c| match c as u32 {
            0x2500..=0x25FF | 0x2700..=0x27BF | 0x2800..=0x28FF | 0xE000..=0xF8FF => ' ', // box, blocks, geometric, dingbats, braille, private-use icons
            _ => c,
        })
        .collect();
    let mut out = String::with_capacity(kept.len());
    for word in kept.split_whitespace() {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    // Leading prompt glyphs go (`✓`, `❯`, `•`); trailing sentence punctuation stays — a
    // headline that lost its full stop reads as cut off.
    out.trim_start_matches(|c: char| !c.is_alphanumeric() && !"$~/\"'".contains(c))
        .trim_end_matches(|c: char| !c.is_alphanumeric() && !".!?)]\"'…".contains(c))
        .to_string()
}

/// A CLI's own status bar, version banner or keymap hint — about the tool, not the work.
fn is_cli_chrome(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    is_version_banner(&l)
        || l.starts_with("claude code v")
        || l.starts_with("codex v")
        || l.starts_with("permission allow rule")
        || l.contains("ccs update") // Lotus's own ccs wrapper nagging about its version
        || l.contains("update available")
        || l.contains("new version")
        || l.contains("for shortcuts")
        || l.contains("esc to interrupt")
        || l.contains("bypass permissions")
        || l.contains("auto-accept")
        || l.contains("plan mode on")
        || l.contains("auto-compact")
        || l.contains("context left")
        || l.contains("shift+tab")
        || l.contains("ctrl+c")
}

#[cfg(test)]
mod tests {
    #[test]
    fn last_meaningful_line_skips_chrome_and_strips_escapes() {
        use super::last_meaningful_line;
        let raw = "\x1b[32m✓ 12 tests passed\x1b[0m\n╭──────╮\n│      │\n╰──────╯\n❯ \n";
        assert_eq!(last_meaningful_line(raw).as_deref(), Some("12 tests passed"));
        assert_eq!(last_meaningful_line("╭──╮\n│  │\n"), None);
        assert_eq!(last_meaningful_line(""), None);
        // The idle Claude TUI's last frame, as measured: banner, blocks, keymap hint.
        let idle = "Wrote 3 files and ran the suite.\n╭───╮\n│ > │\n╰───╯\n? for shortcuts\nClaude Code v2.1.247 ▀▄█████▄▀ Opus 5 (1M context)\n";
        assert_eq!(last_meaningful_line(idle).as_deref(), Some("Wrote 3 files and ran the suite."));
        // The frame measured on 2026-08-27: the agent's own lines carry ⏺, the footer is a
        // permission hint. The utterance wins even though the footer is the last text.
        let measured = "⏺ Read(src/pty.rs)\n⏺ The ring owns its cursor now; tests pass.\n\n╭───╮\n│ > │\n╰───╯\nPermission allow rule (.claude/settings.local.json)\n";
        assert_eq!(last_meaningful_line(measured).as_deref(), Some("The ring owns its cursor now; tests pass."));
        assert_eq!(last_meaningful_line("Permission allow rule (.claude/settings.local.json)\n"), None);
        // A ccs-wrapped Claude that has not spoken: banner, an update nag, prompt — nothing to quote.
        assert_eq!(last_meaningful_line("ccs 3.2.0\nRun ccs update to update\n╭───╮\n│ > │\n╰───╯\n"), None);
        assert_eq!(last_meaningful_line("▀▄█████▄▀ ab\n"), None, "two letters and blocks is not a line");
        let long = "a".repeat(300);
        assert_eq!(last_meaningful_line(&long).unwrap().chars().count(), 120);
    }

    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use serde_json::Value;
    use tower::ServiceExt;

    use crate::api_server::tests_support::{auth_header, test_state};
    use crate::mcp_ipc::McpFleetMember;

    fn member(pane: &str) -> McpFleetMember {
        McpFleetMember {
            pane_id: pane.into(),
            agent_address: None,
            surface: None,
            runtime_id: None,
            team_id: None,
            member_id: None,
            address: None,
            workspace_label: Some("Lotus".into()),
            fleet_schema_version: None,
            workspace_id: "ws-1".into(),
            cwd: "/tmp/proj".into(),
            provider: "claude".into(),
            display_name: "Chase".into(),
            legacy_aliases: vec![],
            aliases: vec![],
            status: "live".into(),
            is_alive: true,
            last_output_preview: Some("Running tests…".into()),
            headline: None,
            session_id: Some("conv-1".into()),
            can_reply: None,
            can_queue: None,
            mcp_tools_available: None,
            reports_steps: None,
            gating: Some("asks".into()),
            runner_label: Some("Claude Code".into()),
        }
    }

    /// A close attempt with no workspace UI behind it.
    ///
    /// 503 and not 500, because the machine is fine: the window is closed or sitting on
    /// no workspace. The phone words that as an instruction rather than as a fault, and
    /// it can only do so if this route keeps the two apart.
    #[tokio::test]
    async fn close_refuses_politely_when_no_window_is_on_a_workspace() {
        let state = test_state();
        let app = Router::new()
            .route("/api/fleet/close", axum::routing::post(close_cell))
            // `RequireAuth` reads the key from an extension the real router installs.
            .layer(axum::Extension(crate::api_auth::ApiKey(
                "test-secret-key".to_string(),
            )))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/close")
                    .header("content-type", "application/json")
                    .header(auth_header().0, auth_header().1)
                    .body(Body::from(r#"{"paneId":"p-1"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// An empty posture is refused before anything is launched.
    ///
    /// 400 rather than a silent fallback to the runner's default: the caller asked for a
    /// posture, and quietly giving it another one is exactly the lie the whole
    /// permission-mode field exists to prevent.
    ///
    /// **What is no longer refused is a stop this route has never heard of.** Until
    /// 2026-08-27 this compared against `safe`/`yolo`, which was a third copy of a list the
    /// host had already outgrown — and the phone's own `manual` died here, as a 500 with no
    /// message. Which stops exist is the host's to advertise and the window's to honour.
    #[tokio::test]
    async fn spawn_refuses_a_permission_mode_it_does_not_understand() {
        let state = test_state();
        let app = Router::new()
            .route("/api/fleet/spawn", axum::routing::post(spawn_cell))
            .layer(axum::Extension(crate::api_auth::ApiKey(
                "test-secret-key".to_string(),
            )))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/spawn")
                    .header("content-type", "application/json")
                    .header(auth_header().0, auth_header().1)
                    .body(Body::from(
                        r#"{"provider":"claude","permissionMode":"   "}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    /// The regression this route caused: a stop the host advertised must reach the window.
    ///
    /// It cannot be launched in a test — there is no workspace UI — so the assertion is that
    /// it gets *past the vocabulary check* and dies on the missing window instead. A 400 here
    /// would mean the third list is back.
    #[tokio::test]
    async fn spawn_lets_a_stop_from_the_runners_scale_through() {
        let state = test_state();
        let app = Router::new()
            .route("/api/fleet/spawn", axum::routing::post(spawn_cell))
            .layer(axum::Extension(crate::api_auth::ApiKey(
                "test-secret-key".to_string(),
            )))
            .with_state(state);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fleet/spawn")
                    .header("content-type", "application/json")
                    .header(auth_header().0, auth_header().1)
                    .body(Body::from(
                        r#"{"provider":"claude","permissionMode":"acceptEdits"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_ne!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    /// `model` and `effort` ride this route, not only the MCP sidecar's `/v1/spawn-cell`.
    ///
    /// Measured 2026-08-27: the phone's spawn arrived with both set, the host's audit
    /// line carried both, and the codex process still launched without `-m` — because
    /// this struct did not know the fields and serde dropped them silently. This test is
    /// the deserialisation half of that; the emit payload mirrors the struct above.
    #[test]
    fn spawn_request_carries_the_tuning_fields() {
        let req: SpawnCellRequest = serde_json::from_str(
            r#"{"provider":"codex","model":"gpt-5.4-mini","effort":"low","permissionMode":"safe"}"#,
        )
        .unwrap();
        assert_eq!(req.model.as_deref(), Some("gpt-5.4-mini"));
        assert_eq!(req.effort.as_deref(), Some("low"));

        let bare: SpawnCellRequest = serde_json::from_str(r#"{"provider":"claude"}"#).unwrap();
        assert!(bare.model.is_none() && bare.effort.is_none());
        assert!(bare.from_pane_id.is_none());
    }

    /// #319: the spawner's pane id rides this route too, so its new pane joins the spawner's group.
    #[test]
    fn spawn_request_carries_the_spawner_pane() {
        let req: SpawnCellRequest = serde_json::from_str(r#"{"provider":"codex","fromPaneId":"pane-7"}"#).unwrap();
        assert_eq!(req.from_pane_id.as_deref(), Some("pane-7"));
    }

    async fn fleet_json(state: crate::api_server::state::ApiState) -> Value {
        let app = Router::new()
            .route("/api/fleet", get(list_fleet))
            .layer(axum::Extension((*state.api_key).clone()))
            .with_state(state);
        let (k, v) = auth_header();
        let res = app
            .oneshot(
                Request::builder()
                    .uri("/api/fleet")
                    .header(k, v)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// The regression this whole change exists to prevent: a client that starts
    /// cold must be able to see *which agents are waiting on a human* from the
    /// snapshot alone, without having been subscribed to the notification stream
    /// when the hook fired.
    #[tokio::test]
    async fn exposes_needs_input_turn_state_from_the_stop_hook() {
        let state = test_state();
        state.mcp_state.replace_fleet("w", vec![member("p-1")]);
        state
            .mcp_state
            .record_hook_turn("p-1", "needs-input", now_ms());

        let body = fleet_json(state).await;
        let item = &body["items"][0];

        assert_eq!(item["turn"], "needs-input");
        assert!(
            item["turnAgeMs"].as_u64().is_some(),
            "turn age must travel with the value — a stale needs-input reads very differently from a fresh one"
        );
        // `status` is launch phase, not turn phase. Both must be present and distinct.
        assert_eq!(item["status"], "live");
    }

    /// ADR-8 requires the gating posture to be legible, and the three values are
    /// not interchangeable: `skipped` can be fixed by respawning a cell in safe
    /// mode, `runner_cannot` never can.
    #[tokio::test]
    async fn forwards_gating_so_the_ui_can_show_which_cells_ask_first() {
        let state = test_state();
        state.mcp_state.replace_fleet("w", vec![member("p-1")]);

        let body = fleet_json(state).await;

        assert_eq!(body["items"][0]["gating"], "asks");
    }

    /// Absent must read as *unknown*, never as *ungated*: a client that treats a
    /// missing value as "will not ask" would understate the risk of a custom runner.
    #[tokio::test]
    async fn omits_gating_when_the_frontend_did_not_report_it() {
        let state = test_state();
        let mut unknown = member("p-1");
        unknown.gating = None;
        state.mcp_state.replace_fleet("w", vec![unknown]);

        let body = fleet_json(state).await;

        assert!(body["items"][0].get("gating").is_none(), "absent, not null");
    }

    #[tokio::test]
    async fn omits_turn_when_no_hook_has_fired() {
        let state = test_state();
        state.mcp_state.replace_fleet("w", vec![member("p-1")]);

        let body = fleet_json(state).await;
        let item = &body["items"][0];

        assert!(item.get("turn").is_none(), "absent, not null");
        assert!(item.get("turnAgeMs").is_none());
    }

    #[tokio::test]
    async fn forwards_the_cell_card_fields_the_snapshot_already_had() {
        let state = test_state();
        state.mcp_state.replace_fleet("w", vec![member("p-1")]);

        let body = fleet_json(state).await;
        let item = &body["items"][0];

        assert_eq!(item["cwd"], "/tmp/proj");
        assert_eq!(item["lastOutputPreview"], "Running tests…");
        assert_eq!(item["sessionId"], "conv-1");
        assert_eq!(item["workspaceLabel"], "Lotus");
    }

    /// `packages/host` parses this payload. Renaming `agentType`/`title` would
    /// break it silently, so the old names are pinned by a test.
    #[tokio::test]
    async fn keeps_the_pre_existing_field_names_stable() {
        let state = test_state();
        state.mcp_state.replace_fleet("w", vec![member("p-1")]);

        let body = fleet_json(state).await;
        let item = &body["items"][0];

        assert_eq!(
            item["agentType"], "claude",
            "provider is exposed as agentType"
        );
        assert_eq!(item["title"], "Chase", "display_name is exposed as title");
        assert_eq!(item["paneId"], "p-1");
        assert_eq!(item["workspaceId"], "ws-1");
        assert_eq!(item["isAlive"], true);
        assert!(
            item.get("provider").is_none() && item.get("displayName").is_none(),
            "no second name for a value that already has one"
        );
    }
}
