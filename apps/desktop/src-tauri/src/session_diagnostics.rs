//! Fase 0 counters for `plans/session-history-hardening` — how much session history is
//! actually lost, where, and how often.
//!
//! **This exists to be deleted.** It is measurement, not a feature. ADR-3 of that plan
//! forbids choosing any new retention number before one has been measured, because every
//! limit in place today (64KB of PTY tail, 60 transcript entries, a 400ms poll) was
//! plausible on paper and failed in production. Replacing them with bigger guesses would
//! only move the failure. When Fase 2–4 land and the numbers have done their job, this
//! module goes with them.
//!
//! **Why not `mcp_telemetry`.** That one is a 32-event in-memory ring emitted to the Bridge
//! health surface — human-facing, bounded, deliberately forgetful. This one has the opposite
//! requirements: nothing is shown to anybody, and it must survive the session so counts can
//! be summed offline. Sharing a module would have meant one of the two doing its job badly.
//!
//! **What it never records.** Metric name, a number, and short labels — pane ids, runner
//! names, event names. No prompts, no assistant messages, no file paths, no `cwd`. The
//! file stays on the machine that wrote it and nothing transmits it. That restraint is
//! deliberate: an operator should not have to audit a diagnostics file before turning it on.
//!
//! Set `LOTUS_DIAGNOSTICS=0` to turn it off.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Records held before a flush. Small enough that a crash loses little, large enough that a
/// busy pane does not turn into a write per hook event.
const FLUSH_AT: usize = 64;

/// How large the log may get before it rotates. One previous generation is kept, so the
/// worst case on disk is twice this. A measurement run is hours, not weeks — this is a
/// backstop against a runaway loop, not a retention policy.
const ROTATE_BYTES: u64 = 5 * 1024 * 1024;

/// One measurement. Shape is fixed across all three layers (`desktop`, `host`, `pocket`)
/// so the three files merge into one timeline without a translation step.
struct Record {
    at: i64,
    metric: &'static str,
    value: u64,
    labels: Vec<(String, String)>,
}

static PENDING: OnceLock<Mutex<Vec<Record>>> = OnceLock::new();

fn pending() -> &'static Mutex<Vec<Record>> {
    PENDING.get_or_init(|| Mutex::new(Vec::new()))
}

fn enabled() -> bool {
    // Inert under `cargo test`, and that is load-bearing rather than tidy-minded. The call
    // sites are `TranscriptStore::record` and the payload clamp — both exercised heavily by
    // unit tests — so without this a test run would append thousands of fabricated counts to
    // the same file a real measurement writes to, and quietly poison the result it exists to
    // produce. The module's own tests target `serialize` directly and are unaffected.
    if cfg!(test) {
        return false;
    }
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var("LOTUS_DIAGNOSTICS").as_deref() != Ok("0"))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Where the log lands. Instance-scoped like everything else under the state dir, so a dev
/// build and a release build do not interleave their counts into one file and make the
/// result unreadable.
pub fn log_path() -> PathBuf {
    crate::paths::lotus_state_dir()
        .join("diagnostics")
        .join("session-history.jsonl")
}

/// Record one measurement.
///
/// **Must never panic and must never block meaningfully**, because the callers are the hook
/// pipeline and the PTY sampler — paths where a diagnostics fault would become a real
/// regression caused by measuring. A poisoned lock is dropped on the floor rather than
/// unwrapped: losing a counter is acceptable, taking down output streaming is not.
pub fn record(metric: &'static str, value: u64, labels: &[(&str, &str)]) {
    if !enabled() {
        return;
    }
    let rec = Record {
        at: now_ms(),
        metric,
        value,
        labels: labels
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect(),
    };
    let full = match pending().lock() {
        Ok(mut buf) => {
            buf.push(rec);
            buf.len() >= FLUSH_AT
        }
        Err(_) => return,
    };
    if full {
        flush();
    }
}

/// Write everything buffered. Safe to call at any time; a no-op when there is nothing held.
pub fn flush() {
    let batch = match pending().lock() {
        Ok(mut buf) if !buf.is_empty() => std::mem::take(&mut *buf),
        _ => return,
    };
    write_batch(&log_path(), &batch);
}

/// Append a batch to `path`, rotating first if the file has grown past [`ROTATE_BYTES`].
///
/// Split out from [`flush`] so the part that touches the filesystem is reachable from a
/// test with a temp directory. That matters more here than usual: [`enabled`] makes every
/// counter inert under `cargo test`, so without this seam the entire write path — the thing
/// a measurement run depends on — would ship having never once been executed.
fn write_batch(path: &std::path::Path, batch: &[Record]) {
    if batch.is_empty() {
        return;
    }
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    rotate_if_large(path);

    let mut body = String::with_capacity(batch.len() * 96);
    for rec in batch {
        body.push_str(&serialize(rec));
        body.push('\n');
    }

    // Append-only, and a failure is swallowed: a full disk must not propagate out of a
    // counter. The batch is already taken by the caller, so a failed write drops it rather
    // than retrying forever against a filesystem that is not going to start working.
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(body.as_bytes());
    }
}

/// Hand-rolled rather than `serde_json`, because the shape is three fields and a flat string
/// map, and every call site is a hot path that should not pay for a `Value` tree.
fn serialize(rec: &Record) -> String {
    let mut out = format!(
        "{{\"at\":{},\"layer\":\"desktop\",\"metric\":\"{}\",\"value\":{},\"labels\":{{",
        rec.at, rec.metric, rec.value
    );
    for (i, (k, v)) in rec.labels.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!("\"{}\":\"{}\"", escape(k), escape(v)));
    }
    out.push_str("}}");
    out
}

/// Labels are pane ids and runner names, so a quote or a backslash is not expected — but
/// "not expected" is how a log stops being parseable three hours into a measurement run.
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn rotate_if_large(path: &std::path::Path) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() >= ROTATE_BYTES)
        .unwrap_or(false);
    if too_big {
        let _ = std::fs::rename(path, path.with_extension("jsonl.1"));
    }
}

// ─── Call-site helpers ────────────────────────────────────────────────────────────────
//
// Named functions rather than raw `record` calls at each site, so the metric vocabulary
// lives in one place and a typo in a metric name cannot silently create a second series
// that nothing sums.

/// One hook event appended to a pane's transcript ring.
pub fn transcript_appended(pane_id: &str) {
    record("transcript.appended", 1, &[("paneId", pane_id)]);
}

/// One entry pushed out of a pane's ring by [`crate::agent_hooks::MAX_ENTRIES_PER_PANE`].
///
/// Paired with [`transcript_appended`] on purpose: the gap between the first append and the
/// first eviction is the answer to "how many turns does Chat actually remember", which the
/// ring's own comment currently guesses at ("roughly 5-30 events" per turn).
pub fn transcript_evicted(pane_id: &str) {
    record("transcript.evicted", 1, &[("paneId", pane_id)]);
}

/// The length of every body that arrives, with whether `BODY_MAX` had already cut it.
///
/// **Length of all of them, not a count of the cut ones**, because the consumer cannot see
/// what was removed: `drop-file.mjs` clamps at the producer and this side's clamp is an
/// idempotent second pass that almost always finds nothing left to cut. A counter here
/// would read zero and be believed.
///
/// One series with a `truncated` label answers both open questions at once. The share that
/// is `true` re-measures the 15.8%-at-1000-bytes figure in `payload.rs`, which came from 279
/// messages in August 2026 and ages with the model. The distribution of the `false` ones is
/// what a better cap would be chosen from — so Fase 3 gets its number from the same series
/// rather than another guess.
pub fn body_seen(agent: &str, event: &str, len: u64, truncated: bool) {
    record(
        "body.length",
        len,
        &[
            ("agent", agent),
            ("event", event),
            ("truncated", if truncated { "true" } else { "false" }),
        ],
    );
}

/// Bytes a PTY session produced since the last sample, labelled by the runner detected in
/// its banner. This is the series that says whether a pane can outrun the 64KB ring between
/// two 400ms polls — the mechanism `issues/01` predicts makes gaps permanent rather than
/// occasional.
pub fn pty_bytes(session_id: &str, runner: &str, delta: u64) {
    record(
        "pty.bytes",
        delta,
        &[("sessionId", session_id), ("runner", runner)],
    );
}

/// App start. Cheap, and it is the denominator for the one Chat question that has nothing
/// to do with ring sizes: `TranscriptStore` is in-memory, so every restart with live
/// sessions costs the operator their whole Chat history.
pub fn app_started() {
    record("app.start", 1, &[]);
}

/// The main window's page started loading, after `app.start` that is a reload or a navigation
/// nobody asked for. Value = PTY sessions it reaped. On 2026-11-15 one such load (15:25:26,
/// JS-initiated, cause unknown) left WebKit's mouse queue stuck; the url is what names its source.
pub fn main_page_load(url: &str, reaped: u64) {
    record("page.load", reaped, &[("url", url)]);
}

/// `nav_guard` refused a main-window page load; the url names what asked for it.
pub fn main_page_blocked(url: &str) {
    record("page.blocked", 1, &[("url", url)]);
}

/// Command calls since the last sample, by name. Summed here and written once per sample
/// interval, because a record per call would be ~8 writes a second (2026-11-15 WebKit log).
static IPC_CALLS: Mutex<Option<std::collections::HashMap<String, u64>>> = Mutex::new(None);

/// One renderer → Rust command call. App commands only: `plugin:*` (events) bypass the handler.
pub fn ipc_call(command: &str) {
    if !enabled() {
        return;
    }
    let mut guard = IPC_CALLS.lock().unwrap_or_else(|e| e.into_inner());
    let calls = guard.get_or_insert_with(Default::default);
    match calls.get_mut(command) {
        Some(n) => *n += 1,
        None => {
            calls.insert(command.to_owned(), 1);
        }
    }
}

/// Write and reset the call counts: one `ipc.calls` record per command, value = calls in the interval.
fn flush_ipc_calls() {
    let drained = IPC_CALLS.lock().unwrap_or_else(|e| e.into_inner()).take();
    for (command, n) in drained.unwrap_or_default() {
        record("ipc.calls", n, &[("command", &command)]);
    }
}

/// How often every live PTY session is sampled for its output rate.
///
/// Ten seconds, which is coarse on purpose. The question is "can a pane outrun a 64KB ring
/// between two 400ms polls", and that is answered by a sustained rate — a sampler fine
/// enough to catch individual bursts would cost more than the thing it measures and still
/// need averaging to be read.
const PTY_SAMPLE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// Start the PTY output-rate sampler. Call once, at app start.
///
/// A thread rather than an async task because it does nothing but sleep and take a short
/// lock, and hanging it off the Tokio runtime would put a blocking `Mutex` acquisition on a
/// worker thread for no gain.
pub fn spawn_pty_sampler(state: crate::pty::PtyState) {
    if !enabled() {
        return;
    }
    std::thread::Builder::new()
        .name("lotus-session-diagnostics".into())
        .spawn(move || {
            let mut last: std::collections::HashMap<String, u64> = std::collections::HashMap::new();
            loop {
                std::thread::sleep(PTY_SAMPLE_INTERVAL);
                // One sweep per tick. Sampling twice would both double the lock traffic and
                // let a session that ended between the two sweeps be counted against a
                // membership list it is no longer in.
                let sample = crate::pty::sample_output_totals(&state);
                let mut live = std::collections::HashSet::with_capacity(sample.len());
                for (session_id, total, runner) in sample {
                    let previous = last.get(&session_id).copied().unwrap_or(0);
                    // Saturating: a session id can be reused after a restart, and a total
                    // that went backwards means a different session, not negative output.
                    let delta = total.saturating_sub(previous);
                    last.insert(session_id.clone(), total);
                    live.insert(session_id.clone());
                    // Silence is not a measurement. A pane that produced nothing this
                    // interval says nothing rather than logging a zero every ten seconds
                    // for every idle pane on the board.
                    if delta > 0 {
                        pty_bytes(&session_id, runner.as_deref().unwrap_or("unknown"), delta);
                    }
                }
                // Forget sessions that have gone away, so a long-running app does not
                // accumulate one entry per pane ever opened.
                last.retain(|id, _| live.contains(id));
                flush_ipc_calls();
                flush();
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(metric: &'static str, value: u64, labels: &[(&str, &str)]) -> Record {
        Record {
            at: 1_700_000_000_000,
            metric,
            value,
            labels: labels
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect(),
        }
    }

    #[test]
    fn a_record_is_one_line_of_valid_json() {
        let line = serialize(&rec("transcript.evicted", 1, &[("paneId", "canvas:p:a1")]));
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["layer"], "desktop");
        assert_eq!(parsed["metric"], "transcript.evicted");
        assert_eq!(parsed["value"], 1);
        assert_eq!(parsed["labels"]["paneId"], "canvas:p:a1");
        assert!(!line.contains('\n'), "one record must be one line");
    }

    #[test]
    fn a_record_with_no_labels_is_still_valid_json() {
        let line = serialize(&rec("app.start", 1, &[]));
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["labels"], serde_json::json!({}));
    }

    /// A label that carries a quote must not end the measurement run by making every
    /// subsequent line unparseable.
    #[test]
    fn a_hostile_label_cannot_break_the_log() {
        let line = serialize(&rec("pty.bytes", 7, &[("runner", "we\"ird\\one")]));
        let parsed: serde_json::Value = serde_json::from_str(&line).expect("valid JSON");
        assert_eq!(parsed["labels"]["runner"], "we\"ird\\one");
    }

    /// The write path itself, end to end, because `enabled()` makes every counter inert
    /// under `cargo test` — so nothing else in this file would ever execute it.
    #[test]
    fn a_batch_lands_on_disk_as_readable_jsonl() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("nested").join("session-history.jsonl");

        write_batch(
            &path,
            &[
                rec("transcript.appended", 1, &[("paneId", "p-1")]),
                rec(
                    "pty.bytes",
                    4096,
                    &[("sessionId", "s-1"), ("runner", "codex")],
                ),
            ],
        );
        // A second flush must append, not replace: a measurement run is many batches.
        write_batch(&path, &[rec("app.start", 1, &[])]);

        let body = std::fs::read_to_string(&path).expect("file written");
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 3, "two batches, three records");
        let parsed: Vec<serde_json::Value> = lines
            .iter()
            .map(|l| serde_json::from_str(l).expect("each line parses alone"))
            .collect();
        assert_eq!(parsed[0]["metric"], "transcript.appended");
        assert_eq!(parsed[1]["labels"]["runner"], "codex");
        assert_eq!(parsed[2]["metric"], "app.start");
        assert!(
            body.ends_with('\n'),
            "a partial last line would break parsing"
        );
    }

    #[test]
    fn an_empty_batch_does_not_create_a_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session-history.jsonl");
        write_batch(&path, &[]);
        assert!(!path.exists(), "nothing to say means no file");
    }

    /// Rotation keeps exactly one previous generation, so a runaway loop costs bounded disk
    /// rather than filling the volume the app is running on.
    #[test]
    fn an_oversized_log_rotates_and_keeps_one_generation() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("session-history.jsonl");
        std::fs::write(&path, vec![b'x'; ROTATE_BYTES as usize + 1]).unwrap();

        write_batch(&path, &[rec("app.start", 1, &[])]);

        let rotated = path.with_extension("jsonl.1");
        assert!(rotated.exists(), "previous generation kept");
        let body = std::fs::read_to_string(&path).unwrap();
        assert_eq!(body.lines().count(), 1, "current file starts fresh");
    }

    #[test]
    fn the_log_is_scoped_to_this_instance() {
        let path = log_path();
        assert!(
            path.ends_with("diagnostics/session-history.jsonl"),
            "{path:?}"
        );
        assert!(
            path.starts_with(crate::paths::lotus_state_dir()),
            "dev and release must not interleave counts: {path:?}"
        );
    }
}
