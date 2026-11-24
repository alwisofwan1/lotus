//! Filesystem watcher for agent-CLI hook drop files.
//!
//! Drop file producers (the `scripts/agent-notify/index.mjs` Node script) write
//! v1 JSON payloads into `~/.lotus/agent-hooks/global/`. This module:
//!
//! 1. Resolves the drop directory and creates it if missing.
//! 2. On startup, drains pre-existing files (delivering recent ones, unlinking
//!    stale ones beyond a TTL).
//! 3. Watches the directory with `notify-debouncer-mini` and handles each new
//!    drop: read, parse, validate, emit a Tauri event, then unlink.
//!
//! See `plans/agent-hooks/drop-file-schema.md` for the v1 payload contract.

mod drop_dir;
mod event_status;
mod payload;
mod processor;
mod session_facts;
mod session_title;
mod sinks;
mod transcript;
mod watcher;

#[allow(unused_imports)]
pub use drop_dir::{default_drop_dir, drain_pending, DrainOutcome};
#[allow(unused_imports)]
pub use event_status::event_status;
pub use payload::{parse_drop_payload, DropPayload, PAYLOAD_VERSION};
#[allow(unused_imports)]
pub use processor::{process_drop_file, HookEventSink, ProcessOutcome};
#[allow(unused_imports)]
pub use sinks::{BroadcastSink, MultiSink, TranscriptSink};
#[allow(unused_imports)]
mod transcript_source;
pub use session_facts::{facts_at as session_facts_at};
pub use session_title::{claude_config_dir_of, title_at as session_title_at};
pub use transcript::{TranscriptEntry, TranscriptStore};
pub use transcript_source::{
    derive_cursor_path, parse_at as parse_transcript_file_at,
    derive_claude_path, derive_codex_path, page as page_transcript,
    TranscriptFormat,
};
#[allow(unused_imports)]
pub use watcher::{spawn_watcher, AgentHooksWatcher, AgentHooksWatcherError, TauriSink};
