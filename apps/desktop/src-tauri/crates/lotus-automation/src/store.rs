use std::path::Path;
use std::sync::Mutex;

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::error::{Error, Result};
use crate::model::{Automation, ClaimOutcome, Draft, DraftStatus, NewAutomation, NewDraft, Run, RunStatus, Spec};

const MIGRATIONS: &[&str] = &[
    // v1
    "
    CREATE TABLE automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      action_json TEXT NOT NULL,
      outputs_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at_ms INTEGER NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      detail TEXT,
      UNIQUE (automation_id, idempotency_key)
    );
    CREATE INDEX runs_by_status ON runs(status);
    ",
    // v2: drafts. Never edit a shipped migration; append a new one.
    "
    CREATE TABLE drafts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );
    ",
    // v3: draft lifecycle.
    "
    ALTER TABLE drafts ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE drafts ADD COLUMN sent_url TEXT;
    CREATE INDEX drafts_by_status ON drafts(status);
    ",
    // v4: Slack trigger state.
    "
    CREATE TABLE slack_seen (
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      PRIMARY KEY (automation_id, key)
    );
    CREATE TABLE slack_cursors (channel TEXT PRIMARY KEY, ts TEXT NOT NULL);
    CREATE TABLE slack_own_reactions (
      channel TEXT NOT NULL, ts TEXT NOT NULL, name TEXT NOT NULL,
      PRIMARY KEY (channel, ts, name)
    );
    ",
    // v5: schedule triggers — the instant each automation was last checked up to.
    "
    CREATE TABLE schedule_cursors (
      automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
      at_ms INTEGER NOT NULL
    );
    ",
    // v6: failed runs in a row pause an automation; only runs after this rowid count.
    "
    ALTER TABLE automations ADD COLUMN streak_floor INTEGER NOT NULL DEFAULT 0;
    ",
    // v7: the Slack thread each PR was last asked about in, whatever its run did,
    // so a later review of that PR (the Review button) can still reply there;
    // and when a draft was sent.
    "
    CREATE TABLE pr_slack_threads (
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      pr TEXT NOT NULL,
      context_json TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      PRIMARY KEY (automation_id, pr)
    );
    ALTER TABLE drafts ADD COLUMN sent_at_ms INTEGER;
    ",
    // v8: the agent session a run kept, so it can be reopened in a pane.
    "
    ALTER TABLE runs ADD COLUMN session_json TEXT;
    ",
    // v9: what any request source acted on, not only Slack; and a PR review no longer needs a
    // GitHub review request, so its `reviewer_team` goes (ADR-0041).
    "
    ALTER TABLE slack_seen RENAME TO trigger_seen;
    UPDATE automations SET action_json = json_remove(action_json, '$.config.reviewer_team')
      WHERE json_extract(action_json, '$.kind') = 'pr_review';
    ",
    // v10: what each run was handed, so one cut off by a shutdown can run again at the next start —
    // once: `resumed` marks the second try, which is never resumed itself.
    "
    ALTER TABLE runs ADD COLUMN payload_json TEXT;
    ALTER TABLE runs ADD COLUMN resumed INTEGER NOT NULL DEFAULT 0;
    ",
    // v11: feedback in the existing Slack review thread, retained across restarts.
    "CREATE TABLE review_feedback (
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        pr TEXT NOT NULL, event_id TEXT NOT NULL, content_json TEXT NOT NULL,
        PRIMARY KEY (automation_id, pr, event_id)
    );",
    // v12: how far each review thread has been read, so a catch-up also sees replies.
    "CREATE TABLE slack_thread_cursors (
        channel TEXT NOT NULL, thread_ts TEXT NOT NULL, ts TEXT NOT NULL,
        PRIMARY KEY (channel, thread_ts)
    );",
    // v13: Slack requests GitHub or the engine could not take yet, tried again at the next catch-up.
    "CREATE TABLE slack_retries (
        automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, message_ts TEXT NOT NULL,
        request_json TEXT NOT NULL, attempts INTEGER NOT NULL, at_ms INTEGER NOT NULL,
        PRIMARY KEY (automation_id, channel, message_ts)
    );",
    // v14: a PR keeps every Slack thread it was asked about in, so a second engineer's thread
    // is still read for replies after a first one asked about the same PR.
    "
    CREATE TABLE pr_slack_threads_v14 (
      automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      pr TEXT NOT NULL,
      channel TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      context_json TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      PRIMARY KEY (automation_id, pr, channel, thread_ts)
    );
    INSERT INTO pr_slack_threads_v14 (automation_id, pr, channel, thread_ts, context_json, at_ms)
      SELECT automation_id, pr, COALESCE(json_extract(context_json, '$.channel'), ''),
             COALESCE(json_extract(context_json, '$.thread_ts'), ''), context_json, at_ms
      FROM pr_slack_threads;
    DROP TABLE pr_slack_threads;
    ALTER TABLE pr_slack_threads_v14 RENAME TO pr_slack_threads;
    ",
    // v15: other Slack threads that asked for a run's review while it was already under way;
    // Send replies in each of them too.
    "CREATE TABLE run_slack_threads (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, thread_ts TEXT NOT NULL, context_json TEXT NOT NULL,
        PRIMARY KEY (run_id, channel, thread_ts)
    );",
    // v16: a sent review's Slack reply, held until every review of its thread is sent or
    // dismissed, so the thread gets one message (ADR-0052 §8).
    "CREATE TABLE slack_reply_holds (
        draft_id TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, thread_ts TEXT NOT NULL, context_json TEXT NOT NULL,
        review_url TEXT NOT NULL, held_at_ms INTEGER NOT NULL, posted_at_ms INTEGER,
        PRIMARY KEY (draft_id, channel, thread_ts)
    );",
];

/// A run the last process never finished, to be run again once (see [`Store::reconcile_for_resume`]).
#[derive(Debug, Clone, PartialEq)]
pub struct Resumable {
    pub automation_id: String,
    pub key: String,
    pub payload: serde_json::Value,
}

/// A run with the name of its automation, for history lists.
#[derive(Debug, Clone, PartialEq)]
pub struct RunEntry {
    pub run: Run,
    pub automation_name: String,
    /// The agent session it kept, if any.
    pub session: Option<crate::session::RunSession>,
}

/// Durable state for automations and their runs, in one SQLite file.
pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    /// Opens (creating if needed) the database at `path` and brings its
    /// schema up to date.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut conn = Connection::open(path)?;
        // Several connections (engine, UI commands, a future daemon) may share
        // the file: WAL lets readers proceed, busy_timeout makes writers queue
        // instead of failing with SQLITE_BUSY.
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&mut conn)?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn create_automation(&self, new: NewAutomation, now_ms: i64) -> Result<Automation> {
        self.insert_automation(new, true, now_ms)
    }

    /// Saves an automation switched OFF: it runs only once the user turns it
    /// on. Used for everything an agent writes (PLAN §2.5 Q33).
    pub fn create_automation_off(&self, new: NewAutomation, now_ms: i64) -> Result<Automation> {
        self.insert_automation(new, false, now_ms)
    }

    fn insert_automation(&self, new: NewAutomation, enabled: bool, now_ms: i64) -> Result<Automation> {
        let automation = Automation {
            id: uuid::Uuid::new_v4().to_string(),
            name: new.name,
            trigger: new.trigger,
            action: new.action,
            outputs: new.outputs,
            enabled,
            created_at_ms: now_ms,
        };
        self.conn().execute(
            "INSERT INTO automations (id, name, trigger_json, action_json, outputs_json, enabled, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                automation.id,
                automation.name,
                serde_json::to_string(&automation.trigger)?,
                serde_json::to_string(&automation.action)?,
                serde_json::to_string(&automation.outputs)?,
                automation.enabled,
                automation.created_at_ms,
            ],
        )?;
        Ok(automation)
    }

    /// Replaces everything but the id and creation time, and switches the
    /// automation OFF: a changed automation needs the user's OK again.
    pub fn replace_automation_off(&self, id: &str, new: NewAutomation) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE automations SET name = ?2, trigger_json = ?3, action_json = ?4, outputs_json = ?5, enabled = 0
             WHERE id = ?1",
            params![
                id,
                new.name,
                serde_json::to_string(&new.trigger)?,
                serde_json::to_string(&new.action)?,
                serde_json::to_string(&new.outputs)?,
            ],
        )?;
        if changed == 0 {
            return Err(Error::UnknownAutomation(id.to_string()));
        }
        Ok(())
    }

    /// Replaces the definition (name, trigger, action, outputs) and keeps
    /// whether it is on: the user edited it in the panel.
    pub fn replace_definition(&self, id: &str, new: NewAutomation) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE automations SET name = ?2, trigger_json = ?3, action_json = ?4, outputs_json = ?5 WHERE id = ?1",
            params![
                id,
                new.name,
                serde_json::to_string(&new.trigger)?,
                serde_json::to_string(&new.action)?,
                serde_json::to_string(&new.outputs)?,
            ],
        )?;
        if changed == 0 {
            return Err(Error::UnknownAutomation(id.to_string()));
        }
        Ok(())
    }

    /// Turning a schedule on starts its clock again, so occurrences missed
    /// while it was off are not run.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        if tx.execute("UPDATE automations SET enabled = ?2 WHERE id = ?1", params![id, enabled])? == 0 {
            return Err(Error::UnknownAutomation(id.to_string()));
        }
        if enabled {
            tx.execute("DELETE FROM schedule_cursors WHERE automation_id = ?1", params![id])?;
            // Failures from before the user turned it back on no longer count towards a pause.
            tx.execute(
                "UPDATE automations SET streak_floor = (SELECT COALESCE(MAX(rowid), 0) FROM runs) WHERE id = ?1",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Removes the automation with its runs, drafts and trigger state.
    /// `false` when there was nothing to remove.
    pub fn delete_automation(&self, id: &str) -> Result<bool> {
        Ok(self.conn().execute("DELETE FROM automations WHERE id = ?1", params![id])? > 0)
    }

    /// Replaces an automation's trigger (e.g. manual → slack).
    pub fn set_trigger(&self, id: &str, trigger: &Spec) -> Result<()> {
        let changed = self.conn().execute(
            "UPDATE automations SET trigger_json = ?2 WHERE id = ?1",
            params![id, serde_json::to_string(trigger)?],
        )?;
        if changed == 0 {
            return Err(Error::UnknownAutomation(id.to_string()));
        }
        Ok(())
    }

    pub fn get_automation(&self, id: &str) -> Result<Option<Automation>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, name, trigger_json, action_json, outputs_json, enabled, created_at_ms
                 FROM automations WHERE id = ?1",
                params![id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, bool>(5)?,
                        r.get::<_, i64>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, name, trigger, action, outputs, enabled, created_at_ms)) = row else {
            return Ok(None);
        };
        Ok(Some(Automation {
            id,
            name,
            trigger: serde_json::from_str::<Spec>(&trigger)?,
            action: serde_json::from_str::<Spec>(&action)?,
            outputs: serde_json::from_str::<Vec<Spec>>(&outputs)?,
            enabled,
            created_at_ms,
        }))
    }

    /// Atomically claims the unit of work `key` for `automation_id`. Exactly
    /// one caller ever gets `Claimed` for a given pair, across threads and
    /// connections; everyone else gets `Duplicate` with the winner's run id.
    ///
    /// A run that ended without a result (skipped, failed, interrupted) does
    /// not hold the key: asking again claims it anew. The old run stays in
    /// history under its key with `~<its id>` appended.
    pub fn claim_run(&self, automation_id: &str, key: &str, now_ms: i64) -> Result<ClaimOutcome> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "UPDATE runs SET idempotency_key = idempotency_key || '~' || id
             WHERE automation_id = ?1 AND idempotency_key = ?2 AND status IN (?3, ?4, ?5)",
            params![
                automation_id,
                key,
                RunStatus::Skipped.as_str(),
                RunStatus::Failed.as_str(),
                RunStatus::Interrupted.as_str()
            ],
        )?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let inserted = tx.execute(
            "INSERT INTO runs (id, automation_id, idempotency_key, status, created_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (automation_id, idempotency_key) DO NOTHING",
            params![run_id, automation_id, key, RunStatus::Queued.as_str(), now_ms],
        )?;
        let outcome = if inserted == 1 {
            ClaimOutcome::Claimed(Run {
                id: run_id,
                automation_id: automation_id.to_string(),
                idempotency_key: key.to_string(),
                status: RunStatus::Queued,
                created_at_ms: now_ms,
                finished_at_ms: None,
                detail: None,
            })
        } else {
            let existing_run_id = tx.query_row(
                "SELECT id FROM runs WHERE automation_id = ?1 AND idempotency_key = ?2",
                params![automation_id, key],
                |r| r.get(0),
            )?;
            ClaimOutcome::Duplicate { existing_run_id }
        };
        tx.commit()?;
        Ok(outcome)
    }

    pub fn mark_running(&self, run_id: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE runs SET status = ?2 WHERE id = ?1 AND status = ?3",
            params![run_id, RunStatus::Running.as_str(), RunStatus::Queued.as_str()],
        )?;
        Ok(())
    }

    pub fn finish_run(&self, run_id: &str, status: RunStatus, detail: Option<&str>, now_ms: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE runs SET status = ?2, detail = ?3, finished_at_ms = ?4 WHERE id = ?1",
            params![run_id, status.as_str(), detail.map(crate::secrets::redact), now_ms],
        )?;
        Ok(())
    }

    /// How many of `automation_id`'s latest finished runs failed in a row,
    /// counting only runs since the user last turned it on.
    pub fn failure_streak(&self, automation_id: &str) -> Result<usize> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT status, detail FROM runs
             WHERE automation_id = ?1 AND finished_at_ms IS NOT NULL
               AND rowid > (SELECT streak_floor FROM automations WHERE id = ?1)
             ORDER BY rowid DESC LIMIT 100",
        )?;
        let rows = stmt.query_map(params![automation_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        let mut streak = 0;
        for row in rows {
            let (status, detail) = row?;
            if status != "failed" {
                break;
            }
            // A usage limit is the account's, not the automation's: it neither counts nor breaks the streak.
            if crate::failure::classify(detail.as_deref().unwrap_or_default()).counts_toward_pause() {
                streak += 1;
            }
        }
        Ok(streak)
    }

    /// The newest `limit` runs across all automations.
    pub fn list_runs(&self, limit: usize) -> Result<Vec<RunEntry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT r.id, r.automation_id, r.idempotency_key, r.status, r.created_at_ms, r.finished_at_ms, r.detail, a.name, r.session_json
             FROM runs r JOIN automations a ON a.id = r.automation_id
             ORDER BY r.created_at_ms DESC, r.rowid DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<i64>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Option<String>>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (id, automation_id, idempotency_key, status, created_at_ms, finished_at_ms, detail, automation_name, session) =
                row?;
            let session = session.map(|s| serde_json::from_str(&s)).transpose()?;
            let status = RunStatus::parse(&status).ok_or_else(|| Error::Corrupt(format!("run status {status:?}")))?;
            Ok(RunEntry {
                run: Run { id, automation_id, idempotency_key, status, created_at_ms, finished_at_ms, detail },
                automation_name,
                session,
            })
        })
        .collect()
    }

    pub fn list_automations(&self) -> Result<Vec<Automation>> {
        let ids: Vec<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id FROM automations ORDER BY created_at_ms, rowid")?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        ids.iter().filter_map(|id| self.get_automation(id).transpose()).collect()
    }

    pub fn get_run(&self, run_id: &str) -> Result<Option<Run>> {
        let row = self
            .conn()
            .query_row(
                "SELECT id, automation_id, idempotency_key, status, created_at_ms, finished_at_ms, detail
                 FROM runs WHERE id = ?1",
                params![run_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, Option<i64>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((id, automation_id, idempotency_key, status, created_at_ms, finished_at_ms, detail)) = row else {
            return Ok(None);
        };
        let status = RunStatus::parse(&status).ok_or_else(|| Error::Corrupt(format!("run status {status:?}")))?;
        Ok(Some(Run { id, automation_id, idempotency_key, status, created_at_ms, finished_at_ms, detail }))
    }

    pub fn save_draft(&self, new: NewDraft, now_ms: i64) -> Result<Draft> {
        let draft = Draft {
            id: uuid::Uuid::new_v4().to_string(),
            run_id: new.run_id,
            automation_id: new.automation_id,
            kind: new.kind,
            subject: new.subject,
            content: new.content,
            created_at_ms: now_ms,
            status: DraftStatus::Pending,
            sent_url: None,
            sent_at_ms: None,
        };
        self.conn().execute(
            "INSERT INTO drafts (id, run_id, automation_id, kind, subject, content_json, created_at_ms, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                draft.id,
                draft.run_id,
                draft.automation_id,
                draft.kind,
                draft.subject,
                serde_json::to_string(&draft.content)?,
                draft.created_at_ms,
                draft.status.as_str(),
            ],
        )?;
        Ok(draft)
    }

    pub fn draft_for_run(&self, run_id: &str) -> Result<Option<Draft>> {
        self.one_draft("run_id = ?1", run_id)
    }

    pub fn get_draft(&self, id: &str) -> Result<Option<Draft>> {
        self.one_draft("id = ?1", id)
    }

    /// Drafts with `status`, newest first.
    pub fn list_drafts(&self, status: DraftStatus) -> Result<Vec<Draft>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("{DRAFT_SELECT} WHERE status = ?1 ORDER BY created_at_ms DESC"))?;
        let rows = stmt.query_map(params![status.as_str()], draft_row)?;
        rows.map(|r| r.map_err(Error::from).and_then(finish_draft)).collect()
    }

    /// Drafts of `kind` in any status, newest first — the Results list.
    pub fn list_results(&self, kind: &str, limit: usize) -> Result<Vec<Draft>> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare(&format!("{DRAFT_SELECT} WHERE kind = ?1 ORDER BY created_at_ms DESC, rowid DESC LIMIT ?2"))?;
        let rows = stmt.query_map(params![kind, limit as i64], draft_row)?;
        rows.map(|r| r.map_err(Error::from).and_then(finish_draft)).collect()
    }

    /// The newest result `automation_id` produced, whatever became of it.
    pub fn last_result(&self, automation_id: &str) -> Result<Option<Draft>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(&format!("{DRAFT_SELECT} WHERE automation_id = ?1 ORDER BY created_at_ms DESC, rowid DESC LIMIT 1"))?;
        let mut rows = stmt.query_map(params![automation_id], draft_row)?;
        rows.next().transpose()?.map(finish_draft).transpose()
    }

    /// Sent drafts of `kind`, most recently sent first — the Sent list.
    pub fn list_sent(&self, kind: &str, limit: usize) -> Result<Vec<Draft>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!(
            "{DRAFT_SELECT} WHERE kind = ?1 AND status = ?2
             ORDER BY COALESCE(sent_at_ms, created_at_ms) DESC, rowid DESC LIMIT ?3"
        ))?;
        let rows = stmt.query_map(params![kind, DraftStatus::Sent.as_str(), limit as i64], draft_row)?;
        rows.map(|r| r.map_err(Error::from).and_then(finish_draft)).collect()
    }

    /// Moves a pending draft to `sending` atomically. `Err(status)` when it
    /// was not pending: someone else is sending it, or it is done.
    pub fn claim_draft_for_sending(&self, id: &str) -> Result<std::result::Result<(), DraftStatus>> {
        self.transition(id, DraftStatus::Pending, DraftStatus::Sending)
    }

    /// A send failed: the draft may be sent again.
    pub fn release_draft(&self, id: &str) -> Result<()> {
        self.transition(id, DraftStatus::Sending, DraftStatus::Pending)?.ok();
        Ok(())
    }

    pub fn mark_draft_sent(&self, id: &str, url: &str, content: &serde_json::Value, now_ms: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE drafts SET status = ?2, sent_url = ?3, content_json = ?4, sent_at_ms = ?6 WHERE id = ?1 AND status = ?5",
            params![
                id,
                DraftStatus::Sent.as_str(),
                url,
                serde_json::to_string(content)?,
                DraftStatus::Sending.as_str(),
                now_ms
            ],
        )?;
        Ok(())
    }

    /// Records the Answer on an Ask this press claimed, whose kept Answer was attempt
    /// `prev_attempt` when claimed (0: none). `false` when it moved on meanwhile — its run already
    /// failed and brought it back, perhaps to be claimed by a later press, whose record must stand.
    pub fn mark_ask_answered(&self, id: &str, url: &str, content: &serde_json::Value, prev_attempt: u64, now_ms: i64) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE drafts SET status = ?2, sent_url = ?3, content_json = ?4, sent_at_ms = ?6
             WHERE id = ?1 AND status = ?5 AND COALESCE(json_extract(content_json, '$.answer.attempt'), 0) = ?7",
            params![
                id,
                DraftStatus::Sent.as_str(),
                url,
                serde_json::to_string(content)?,
                DraftStatus::Sending.as_str(),
                now_ms,
                prev_attempt as i64
            ],
        )?;
        Ok(changed == 1)
    }

    /// An answered Ask whose Follow-up Run failed waits again, with `content` (its kept Answer).
    /// Only an Ask on its way (sending or sent) comes back; a dismissed one stays dismissed.
    pub fn return_ask(&self, id: &str, content: &serde_json::Value) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE drafts SET status = ?2, content_json = ?3, sent_url = NULL, sent_at_ms = NULL
             WHERE id = ?1 AND status IN (?4, ?5)",
            params![
                id,
                DraftStatus::Pending.as_str(),
                serde_json::to_string(content)?,
                DraftStatus::Sending.as_str(),
                DraftStatus::Sent.as_str()
            ],
        )?;
        Ok(changed == 1)
    }

    /// Notes on a sent draft what happened after the send (e.g. the Slack
    /// reply), under `content[key]`. Drafts not yet sent are left alone.
    pub fn note_on_sent_draft(&self, id: &str, key: &str, value: serde_json::Value) -> Result<bool> {
        let Some(draft) = self.get_draft(id)? else { return Ok(false) };
        if draft.status != DraftStatus::Sent {
            return Ok(false);
        }
        let mut content = draft.content;
        content[key] = value;
        let changed = self.conn().execute(
            "UPDATE drafts SET content_json = ?2 WHERE id = ?1 AND status = ?3",
            params![id, serde_json::to_string(&content)?, DraftStatus::Sent.as_str()],
        )?;
        Ok(changed == 1)
    }

    /// A result that needed no Send (it went only to the user): pending → sent.
    pub fn mark_draft_delivered(&self, id: &str) -> Result<()> {
        self.transition(id, DraftStatus::Pending, DraftStatus::Sent)?.ok();
        Ok(())
    }

    /// Saves an edit to a pending draft. Edits to anything else are ignored.
    pub fn update_draft_content(&self, id: &str, content: &serde_json::Value) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE drafts SET content_json = ?2 WHERE id = ?1 AND status = ?3",
            params![id, serde_json::to_string(content)?, DraftStatus::Pending.as_str()],
        )?;
        Ok(changed == 1)
    }

    /// Records where a result's outputs went after the fact (a Google write sent again), whether
    /// it waits or went out. A discarded result stays as it was.
    pub fn update_result_content(&self, id: &str, content: &serde_json::Value) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE drafts SET content_json = ?2 WHERE id = ?1 AND status != ?3",
            params![id, serde_json::to_string(content)?, DraftStatus::Discarded.as_str()],
        )?;
        Ok(changed == 1)
    }

    pub fn discard_draft(&self, id: &str, _now_ms: i64) -> Result<std::result::Result<(), DraftStatus>> {
        self.discard_draft_because(id, None, _now_ms)
    }

    /// Discards a pending draft, keeping the reviewer's optional `reason` (a chip they picked) in
    /// its content as `discard_reason`, in the same write: for the retro, never sent anywhere.
    pub fn discard_draft_because(
        &self,
        id: &str,
        reason: Option<&str>,
        _now_ms: i64,
    ) -> Result<std::result::Result<(), DraftStatus>> {
        let Some(reason) = reason.map(str::trim).filter(|r| !r.is_empty()) else {
            return self.transition(id, DraftStatus::Pending, DraftStatus::Discarded);
        };
        let reason: String = reason.chars().take(200).collect();
        let changed = self.conn().execute(
            "UPDATE drafts SET status = ?2, content_json = json_set(content_json, '$.discard_reason', ?4) \
             WHERE id = ?1 AND status = ?3",
            params![id, DraftStatus::Discarded.as_str(), DraftStatus::Pending.as_str(), reason],
        )?;
        if changed == 1 {
            return Ok(Ok(()));
        }
        // Not pending: report what it is, as a plain discard would.
        self.transition(id, DraftStatus::Pending, DraftStatus::Discarded)
    }

    fn transition(&self, id: &str, from: DraftStatus, to: DraftStatus) -> Result<std::result::Result<(), DraftStatus>> {
        let conn = self.conn();
        let changed = conn.execute(
            "UPDATE drafts SET status = ?2 WHERE id = ?1 AND status = ?3",
            params![id, to.as_str(), from.as_str()],
        )?;
        if changed == 1 {
            return Ok(Ok(()));
        }
        let current: Option<String> =
            conn.query_row("SELECT status FROM drafts WHERE id = ?1", params![id], |r| r.get(0)).optional()?;
        let current = current.ok_or_else(|| Error::Corrupt(format!("no draft {id}")))?;
        Ok(Err(DraftStatus::parse(&current).ok_or_else(|| Error::Corrupt(format!("draft status {current:?}")))?))
    }

    /// The review `automation_id` last sent for `repo`#`number`, if it sent one.
    pub fn last_sent_review(&self, automation_id: &str, repo: &str, number: u64) -> Result<Option<Draft>> {
        let row = self
            .conn()
            .query_row(
                &format!(
                    "{DRAFT_SELECT} WHERE automation_id = ?1 AND kind = 'pr_review' AND status = ?2
                       AND lower(json_extract(content_json, '$.repo')) = lower(?3)
                       AND json_extract(content_json, '$.number') = ?4
                     ORDER BY sent_at_ms DESC LIMIT 1"
                ),
                params![automation_id, DraftStatus::Sent.as_str(), repo, number as i64],
                draft_row,
            )
            .optional()?;
        row.map(finish_draft).transpose()
    }

    /// One durable review room, including unpublished rounds, in chronological order.
    pub fn review_history(&self, automation_id: &str, repo: &str, number: u64) -> Result<Vec<Draft>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(&format!("{DRAFT_SELECT} WHERE automation_id = ?1 AND kind = 'pr_review'
            AND lower(json_extract(content_json, '$.repo')) = lower(?2)
            AND json_extract(content_json, '$.number') = ?3
            AND status IN ('pending', 'sending', 'sent') ORDER BY created_at_ms ASC, rowid ASC"))?;
        let rows = stmt.query_map(params![automation_id, repo, number as i64], draft_row)?;
        rows.map(|row| finish_draft(row?)).collect()
    }

    /// Recorded before the agent runs, so the next serialized round can continue it before the
    /// preceding draft is materialized by the engine. Queued and failed runs cannot own the pointer.
    pub fn latest_pr_session(&self, automation_id: &str, repo: &str, number: u64) -> Result<Option<crate::session::RunSession>> {
        let raw: Option<String> = self.conn().query_row("SELECT session_json FROM runs WHERE automation_id=?1
            AND lower(coalesce(json_extract(payload_json, '$.repo'), json_extract(payload_json, '$.follow_up.origin.repo')))=lower(?2)
            AND coalesce(json_extract(payload_json, '$.number'), json_extract(payload_json, '$.follow_up.origin.number'))=?3
            AND session_json IS NOT NULL AND status IN ('running', 'succeeded', 'asked') ORDER BY rowid DESC LIMIT 1",
            params![automation_id, repo, number as i64], |r| r.get(0)).optional()?;
        raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
    }

    pub fn record_review_feedback(&self, automation_id: &str, pr: &str, event: &serde_json::Value) -> Result<bool> {
        let id = event["id"].as_str().ok_or_else(|| Error::Corrupt("feedback has no id".into()))?;
        Ok(self.conn().execute("INSERT INTO review_feedback VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING",
            params![automation_id, pr.to_ascii_lowercase(), id, serde_json::to_string(event)?])? == 1)
    }

    pub fn review_feedback(&self, automation_id: &str, pr: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT content_json FROM review_feedback WHERE automation_id=?1 AND pr=?2 ORDER BY rowid")?;
        let rows = stmt.query_map(params![automation_id, pr.to_ascii_lowercase()], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    /// Holds `draft_id`'s Slack reply in thread `context` (its review is at `review_url`).
    pub fn hold_slack_reply(&self, draft_id: &str, context: &serde_json::Value, review_url: &str, now_ms: i64) -> Result<()> {
        let (channel, thread) = (context["channel"].as_str().unwrap_or_default(), context["thread_ts"].as_str().unwrap_or_default());
        self.conn().execute(
            "INSERT INTO slack_reply_holds (draft_id, channel, thread_ts, context_json, review_url, held_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT DO NOTHING",
            params![draft_id, channel, thread, serde_json::to_string(context)?, review_url, now_ms],
        )?;
        Ok(())
    }

    /// The replies held in a thread and not posted yet: `(draft_id, context, review_url)`, first held first.
    pub fn held_slack_replies(&self, channel: &str, thread: &str) -> Result<Vec<(String, serde_json::Value, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT draft_id, context_json, review_url FROM slack_reply_holds
             WHERE channel = ?1 AND thread_ts = ?2 AND posted_at_ms IS NULL ORDER BY held_at_ms, rowid",
        )?;
        let rows = stmt.query_map(params![channel, thread], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (id, context, url) = row?;
            out.push((id, serde_json::from_str(&context)?, url));
        }
        Ok(out)
    }

    /// The threads where `draft_id`'s reply is held and not posted yet.
    pub fn held_threads_of(&self, draft_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT channel, thread_ts FROM slack_reply_holds WHERE draft_id = ?1 AND posted_at_ms IS NULL ORDER BY rowid",
        )?;
        let rows = stmt.query_map(params![draft_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    pub fn mark_slack_replies_posted(&self, channel: &str, thread: &str, draft_ids: &[String], now_ms: i64) -> Result<()> {
        let conn = self.conn();
        for id in draft_ids {
            conn.execute(
                "UPDATE slack_reply_holds SET posted_at_ms = ?4 WHERE draft_id = ?1 AND channel = ?2 AND thread_ts = ?3",
                params![id, channel, thread, now_ms],
            )?;
        }
        Ok(())
    }

    /// What a thread still waits on before its one reply: pending review drafts (other than
    /// `except`) and review runs not finished yet, that answer this thread.
    pub fn waiting_in_thread(&self, channel: &str, thread: &str, except: &str) -> Result<(Vec<String>, usize)> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT d.id FROM drafts d
             WHERE d.kind = 'pr_review' AND d.status IN ('pending', 'sending') AND d.id != ?3
               AND ((json_extract(d.content_json, '$.slack.channel') = ?1 AND json_extract(d.content_json, '$.slack.thread_ts') = ?2)
                    OR EXISTS (SELECT 1 FROM run_slack_threads t WHERE t.run_id = d.run_id AND t.channel = ?1 AND t.thread_ts = ?2))
             ORDER BY d.created_at_ms",
        )?;
        let drafts = stmt.query_map(params![channel, thread, except], |r| r.get::<_, String>(0))?.collect::<std::result::Result<Vec<_>, _>>()?;
        let runs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM runs r
             WHERE r.status IN ('queued', 'running')
               AND ((json_extract(r.payload_json, '$.slack.channel') = ?1 AND json_extract(r.payload_json, '$.slack.thread_ts') = ?2)
                    OR EXISTS (SELECT 1 FROM run_slack_threads t WHERE t.run_id = r.id AND t.channel = ?1 AND t.thread_ts = ?2))",
            params![channel, thread],
            |r| r.get(0),
        )?;
        Ok((drafts, runs as usize))
    }

    /// The other PRs asked about in any Slack thread `pr` was asked about in, first asked first.
    pub fn sibling_prs(&self, automation_id: &str, pr: &str) -> Result<Vec<crate::pr_review::PrRef>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT o.pr, MIN(o.rowid) AS first FROM pr_slack_threads t
             JOIN pr_slack_threads o ON o.automation_id = t.automation_id AND o.channel = t.channel AND o.thread_ts = t.thread_ts
             WHERE t.automation_id = ?1 AND t.pr = ?2 AND o.pr != ?2 AND t.channel != '' AND t.thread_ts != ''
             GROUP BY o.pr ORDER BY first",
        )?;
        let rows = stmt.query_map(params![automation_id, pr], |r| r.get::<_, String>(0))?;
        let mut prs = Vec::new();
        for row in rows {
            if let Some((repo, number)) = row?.rsplit_once('#') {
                if let Ok(number) = number.parse() { prs.push(crate::pr_review::PrRef { repo: repo.into(), number }); }
            }
        }
        Ok(prs)
    }

    pub fn prs_in_thread(&self, automation_id: &str, channel: &str, thread: &str) -> Result<Vec<crate::pr_review::PrRef>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT pr FROM pr_slack_threads WHERE automation_id=?1 AND channel=?2 AND thread_ts=?3")?;
        let rows = stmt.query_map(params![automation_id, channel, thread], |r| r.get::<_, String>(0))?;
        let mut prs = Vec::new();
        for row in rows {
            if let Some((repo, number)) = row?.rsplit_once('#') {
                if let Ok(number) = number.parse() { prs.push(crate::pr_review::PrRef { repo: repo.into(), number }); }
            }
        }
        Ok(prs)
    }

    fn one_draft(&self, filter: &str, value: &str) -> Result<Option<Draft>> {
        let row = self
            .conn()
            .query_row(&format!("{DRAFT_SELECT} WHERE {filter}"), params![value], draft_row)
            .optional()?;
        row.map(finish_draft).transpose()
    }

    /// Call once at startup, before the engine accepts work: any run still
    /// queued or running belonged to a process that is gone. Returns how many
    /// runs were settled. A draft caught mid-send goes back to pending: the
    /// post may or may not have reached GitHub, and a human decides again.
    pub fn reconcile_interrupted(&self, now_ms: i64) -> Result<usize> {
        // A Follow-up Run cut off here has failed like any other (PLAN §8 Q14): its Ask comes back.
        let cut_off: Vec<String> = {
            let conn = self.conn();
            let mut stmt = conn.prepare("SELECT id FROM runs WHERE status IN (?1, ?2) AND idempotency_key LIKE 'answer@%'")?;
            let ids = stmt
                .query_map(params![RunStatus::Queued.as_str(), RunStatus::Running.as_str()], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            ids
        };
        self.conn().execute(
            "UPDATE drafts SET status = ?1 WHERE status = ?2",
            params![DraftStatus::Pending.as_str(), DraftStatus::Sending.as_str()],
        )?;
        let settled = self.conn().execute(
            "UPDATE runs SET status = ?1, finished_at_ms = ?2,
                    detail = 'Lotus stopped before this run finished'
             WHERE status IN (?3, ?4)",
            params![
                RunStatus::Interrupted.as_str(),
                now_ms,
                RunStatus::Queued.as_str(),
                RunStatus::Running.as_str(),
            ],
        )?;
        for run_id in cut_off {
            let Some(ask) = self.one_draft("kind = 'ask' AND json_extract(content_json, '$.answer.follow_up_run_id') = ?1", &run_id)? else { continue };
            let mut content = ask.content;
            content["answer"]["failed_run_id"] = serde_json::json!(run_id);
            self.return_ask(&ask.id, &content)?;
        }
        Ok(settled)
    }

    /// [`Store::reconcile_interrupted`], also returning the runs it cut off that may run again:
    /// those with a payload that were not already a second try. A Follow-up Run is not among them:
    /// its Ask comes back instead.
    pub fn reconcile_for_resume(&self, now_ms: i64) -> Result<Vec<Resumable>> {
        let resumable: Vec<Resumable> = {
            let conn = self.conn();
            let mut stmt = conn.prepare(
                "SELECT automation_id, idempotency_key, payload_json FROM runs
                 WHERE status IN (?1, ?2) AND resumed = 0 AND payload_json IS NOT NULL
                   AND idempotency_key NOT LIKE 'answer@%'",
            )?;
            let rows = stmt.query_map(params![RunStatus::Queued.as_str(), RunStatus::Running.as_str()], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (automation_id, key, payload) = row?;
                out.push(Resumable { automation_id, key, payload: serde_json::from_str(&payload)? });
            }
            out
        };
        self.reconcile_interrupted(now_ms)?;
        Ok(resumable)
    }

    pub fn set_run_payload(&self, run_id: &str, payload: &serde_json::Value) -> Result<()> {
        self.conn()
            .execute("UPDATE runs SET payload_json = ?2 WHERE id = ?1", params![run_id, serde_json::to_string(payload)?])?;
        Ok(())
    }

    pub fn run_payload(&self, run_id: &str) -> Result<Option<serde_json::Value>> {
        let json: Option<Option<String>> = self
            .conn()
            .query_row("SELECT payload_json FROM runs WHERE id = ?1", params![run_id], |r| r.get(0))
            .optional()?;
        Ok(json.flatten().map(|j| serde_json::from_str(&j)).transpose()?)
    }

    /// Marks a run as the second try of one cut off by a shutdown.
    pub fn mark_resumed(&self, run_id: &str) -> Result<()> {
        self.conn().execute("UPDATE runs SET resumed = 1 WHERE id = ?1", params![run_id])?;
        Ok(())
    }

    pub fn set_run_session(&self, run_id: &str, session: &crate::session::RunSession) -> Result<()> {
        self.conn().execute(
            "UPDATE runs SET session_json = ?2 WHERE id = ?1",
            params![run_id, serde_json::to_string(session)?],
        )?;
        Ok(())
    }

    /// Where a pane run actually opened — the workspace (a checkout of the
    /// PR's repo, or the automation's project) and its folder — known only once
    /// the pane opened: records it on the run whose session is `session_id`.
    /// `false` when no run has that session.
    pub fn set_session_place(&self, session_id: &str, cwd: &str, workspace_id: &str) -> Result<bool> {
        let changed = self.conn().execute(
            "UPDATE runs SET session_json = json_set(session_json, '$.cwd', ?2, '$.workspace_id', ?3)
             WHERE session_json IS NOT NULL AND json_extract(session_json, '$.id') = ?1",
            params![session_id, cwd, workspace_id],
        )?;
        Ok(changed > 0)
    }

    pub fn run_session(&self, run_id: &str) -> Result<Option<crate::session::RunSession>> {
        let json: Option<Option<String>> = self
            .conn()
            .query_row("SELECT session_json FROM runs WHERE id = ?1", params![run_id], |r| r.get(0))
            .optional()?;
        Ok(json.flatten().map(|j| serde_json::from_str(&j)).transpose()?)
    }

    /// The newest run in conversation `session_id` (a run and the Follow-up Runs that resumed it
    /// share one), and whether a run in it is still queued or running — one that has not reached
    /// the agent yet is known by the run it follows up.
    pub fn session_head(&self, session_id: &str) -> Result<Option<(String, bool)>> {
        let conn = self.conn();
        let head: Option<String> = conn
            .query_row(
                "SELECT id FROM runs WHERE json_extract(session_json, '$.id') = ?1
                 ORDER BY created_at_ms DESC, rowid DESC LIMIT 1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(head) = head else { return Ok(None) };
        let busy: bool = conn.query_row(
            "SELECT EXISTS (SELECT 1 FROM runs WHERE status IN ('queued', 'running') AND (
                 json_extract(session_json, '$.id') = ?1
                 OR json_extract(payload_json, '$.follow_up.asked_run_id') IN
                    (SELECT id FROM runs WHERE json_extract(session_json, '$.id') = ?1)))",
            params![session_id],
            |r| r.get(0),
        )?;
        Ok(Some((head, busy)))
    }

    /// Records that `automation_id` acted on request `key`: a Slack message (`channel:ts`) or a
    /// polled source's request (`github:owner/repo#n`). `false` when it already had — Slack
    /// redelivered it, catch-up met it again, or the source still lists it.
    pub fn mark_seen(&self, automation_id: &str, key: &str, now_ms: i64) -> Result<bool> {
        let inserted = self.conn().execute(
            "INSERT INTO trigger_seen (automation_id, key, at_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT (automation_id, key) DO NOTHING",
            params![automation_id, key, now_ms],
        )?;
        Ok(inserted == 1)
    }

    pub fn has_seen(&self, automation_id: &str, key: &str) -> Result<bool> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM trigger_seen WHERE automation_id = ?1 AND key = ?2",
                params![automation_id, key],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Forgets the requests under `prefix` a source no longer lists, so the same request made
    /// again (a re-request after a review) counts as new. Other prefixes are left alone.
    pub fn forget_seen_except(&self, automation_id: &str, prefix: &str, keep: &[String]) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction()?;
        let seen: Vec<String> = {
            let mut stmt = tx.prepare("SELECT key FROM trigger_seen WHERE automation_id = ?1 AND substr(key, 1, ?3) = ?2")?;
            let rows = stmt.query_map(params![automation_id, prefix, prefix.len() as i64], |r| r.get(0))?;
            rows.collect::<std::result::Result<_, _>>()?
        };
        for key in seen.iter().filter(|k| !keep.contains(k)) {
            tx.execute("DELETE FROM trigger_seen WHERE automation_id = ?1 AND key = ?2", params![automation_id, key])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Remembers that `pr` (`owner/repo#n`) was asked about in the Slack
    /// thread `context`. Each thread is kept; [`Store::pr_thread`] gives the newest.
    pub fn remember_pr_thread(&self, automation_id: &str, pr: &str, context: &serde_json::Value, now_ms: i64) -> Result<()> {
        let (channel, thread) = (context["channel"].as_str().unwrap_or_default(), context["thread_ts"].as_str().unwrap_or_default());
        // `requester` is whoever asked last (Send tags them); `root_requester` stays whoever asked
        // first, since a reply's own context must not make its writer the thread's requester.
        let existing: Option<String> = self.conn().query_row(
            "SELECT context_json FROM pr_slack_threads WHERE automation_id = ?1 AND pr = ?2 AND channel = ?3 AND thread_ts = ?4",
            params![automation_id, pr, channel, thread], |r| r.get(0)).optional()?;
        let existing: Option<serde_json::Value> = existing.map(|j| serde_json::from_str(&j)).transpose()?;
        let mut context = context.clone();
        let first = existing.as_ref().and_then(|e| e["root_requester"].as_str().or(e["requester"].as_str())).map(str::to_string)
            .or_else(|| context["requester"].as_str().map(str::to_string));
        if let (Some(first), Some(map)) = (first, context.as_object_mut()) {
            map.insert("root_requester".into(), first.into());
        }
        let context = &context;
        self.conn().execute(
            "INSERT INTO pr_slack_threads (automation_id, pr, channel, thread_ts, context_json, at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (automation_id, pr, channel, thread_ts) DO UPDATE SET context_json = excluded.context_json, at_ms = excluded.at_ms",
            params![automation_id, pr, channel, thread, serde_json::to_string(context)?, now_ms],
        )?;
        Ok(())
    }

    /// Every Slack thread `pr` was asked about in, for this automation, oldest first.
    pub fn pr_threads(&self, automation_id: &str, pr: &str) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT channel, thread_ts FROM pr_slack_threads
             WHERE automation_id = ?1 AND pr = ?2 AND channel != '' AND thread_ts != ''
             ORDER BY at_ms, rowid",
        )?;
        let rows = stmt.query_map(params![automation_id, pr], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Who asked for the review in Slack thread `thread`, as first recorded for that thread (`root_requester`; rows from before it fall back to `requester`).
    pub fn thread_requester(&self, automation_id: &str, channel: &str, thread: &str) -> Result<Option<String>> {
        let json: Option<String> = self
            .conn()
            .query_row(
                "SELECT context_json FROM pr_slack_threads WHERE automation_id = ?1 AND channel = ?2 AND thread_ts = ?3
                 ORDER BY at_ms, rowid LIMIT 1",
                params![automation_id, channel, thread],
                |r| r.get(0),
            )
            .optional()?;
        let context: Option<serde_json::Value> = json.map(|j| serde_json::from_str(&j)).transpose()?;
        Ok(context.and_then(|c| c["root_requester"].as_str().or(c["requester"].as_str()).map(str::to_string)))
    }

    /// The Slack thread `pr` was last asked about in, for this automation.
    pub fn pr_thread(&self, automation_id: &str, pr: &str) -> Result<Option<serde_json::Value>> {
        let json: Option<String> = self
            .conn()
            .query_row(
                "SELECT context_json FROM pr_slack_threads WHERE automation_id = ?1 AND pr = ?2
                 ORDER BY at_ms DESC, rowid DESC LIMIT 1",
                params![automation_id, pr],
                |r| r.get(0),
            )
            .optional()?;
        Ok(json.map(|j| serde_json::from_str(&j)).transpose()?)
    }

    /// The newest message `ts` handled in `channel`, where catch-up resumes.
    pub fn slack_cursor(&self, channel: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT ts FROM slack_cursors WHERE channel = ?1", params![channel], |r| r.get(0))
            .optional()?)
    }

    /// Moves the cursor forward to `ts`; never backwards.
    pub fn advance_slack_cursor(&self, channel: &str, ts: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<String> =
            tx.query_row("SELECT ts FROM slack_cursors WHERE channel = ?1", params![channel], |r| r.get(0)).optional()?;
        if current.as_deref().is_none_or(|c| crate::slack::ts_after(ts, c)) {
            tx.execute(
                "INSERT INTO slack_cursors (channel, ts) VALUES (?1, ?2)
                 ON CONFLICT (channel) DO UPDATE SET ts = excluded.ts",
                params![channel, ts],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The newest reply read in a review thread; `None` for a thread never read.
    pub fn slack_thread_cursor(&self, channel: &str, thread_ts: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT ts FROM slack_thread_cursors WHERE channel = ?1 AND thread_ts = ?2",
                params![channel, thread_ts],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// Moves a thread's cursor forward to `ts`; never backwards.
    pub fn advance_slack_thread_cursor(&self, channel: &str, thread_ts: &str, ts: &str) -> Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<String> = tx
            .query_row(
                "SELECT ts FROM slack_thread_cursors WHERE channel = ?1 AND thread_ts = ?2",
                params![channel, thread_ts],
                |r| r.get(0),
            )
            .optional()?;
        if current.as_deref().is_none_or(|c| crate::slack::ts_after(ts, c)) {
            tx.execute(
                "INSERT INTO slack_thread_cursors (channel, thread_ts, ts) VALUES (?1, ?2, ?3)
                 ON CONFLICT (channel, thread_ts) DO UPDATE SET ts = excluded.ts",
                params![channel, thread_ts, ts],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Another Slack thread (`context`) waits for run `run_id`'s review. Kept once per thread.
    pub fn add_run_slack_thread(&self, run_id: &str, context: &serde_json::Value) -> Result<()> {
        let (channel, thread) = (context["channel"].as_str().unwrap_or_default(), context["thread_ts"].as_str().unwrap_or_default());
        self.conn().execute(
            "INSERT INTO run_slack_threads (run_id, channel, thread_ts, context_json) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (run_id, channel, thread_ts) DO NOTHING",
            params![run_id, channel, thread, serde_json::to_string(context)?],
        )?;
        Ok(())
    }

    /// The other Slack threads waiting for run `run_id`, in the order they asked.
    pub fn run_slack_threads(&self, run_id: &str) -> Result<Vec<serde_json::Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT context_json FROM run_slack_threads WHERE run_id = ?1 ORDER BY rowid")?;
        let rows = stmt.query_map(params![run_id], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    /// Keeps a Slack request to try again: `request` holds what is still to be submitted, and
    /// `attempts` how often it failed so far. Replaces an earlier row for the same message.
    pub fn retry_slack_request(&self, automation_id: &str, channel: &str, message_ts: &str, request: &serde_json::Value, attempts: u32, now_ms: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO slack_retries (automation_id, channel, message_ts, request_json, attempts, at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (automation_id, channel, message_ts) DO UPDATE
             SET request_json = excluded.request_json, attempts = excluded.attempts, at_ms = excluded.at_ms",
            params![automation_id, channel, message_ts, request.to_string(), attempts, now_ms],
        )?;
        Ok(())
    }

    /// Every Slack request waiting to be tried again, oldest first: (automation id, request, attempts).
    pub fn slack_retries(&self) -> Result<Vec<(String, serde_json::Value, u32)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT automation_id, request_json, attempts FROM slack_retries ORDER BY at_ms, message_ts")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, u32>(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().map(|(id, json, attempts)| (id, serde_json::from_str(&json).unwrap_or(serde_json::Value::Null), attempts)).collect())
    }

    pub fn drop_slack_retry(&self, automation_id: &str, channel: &str, message_ts: &str) -> Result<()> {
        self.conn().execute(
            "DELETE FROM slack_retries WHERE automation_id = ?1 AND channel = ?2 AND message_ts = ?3",
            params![automation_id, channel, message_ts],
        )?;
        Ok(())
    }

    /// The Slack threads `automation_id` reviewed in since `since_ms`, newest first, at most `limit`.
    pub fn recent_review_threads(&self, automation_id: &str, since_ms: i64, limit: usize) -> Result<Vec<(String, String)>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT channel, thread_ts, MAX(at_ms) AS last
             FROM pr_slack_threads
             WHERE automation_id = ?1 AND at_ms >= ?2 AND channel != '' AND thread_ts != ''
             GROUP BY channel, thread_ts ORDER BY last DESC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![automation_id, since_ms, limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }

    /// Up to when `automation_id`'s schedule has been handled; `None` before its first tick.
    pub fn schedule_cursor(&self, automation_id: &str) -> Result<Option<i64>> {
        Ok(self
            .conn()
            .query_row("SELECT at_ms FROM schedule_cursors WHERE automation_id = ?1", params![automation_id], |r| r.get(0))
            .optional()?)
    }

    pub fn set_schedule_cursor(&self, automation_id: &str, at_ms: i64) -> Result<()> {
        self.conn().execute(
            "INSERT INTO schedule_cursors (automation_id, at_ms) VALUES (?1, ?2)
             ON CONFLICT (automation_id) DO UPDATE SET at_ms = MAX(at_ms, excluded.at_ms)",
            params![automation_id, at_ms],
        )?;
        Ok(())
    }

    /// A reaction Lotus is about to add as the user, so its echo is not
    /// mistaken for the user asking for a review.
    pub fn record_own_reaction(&self, channel: &str, ts: &str, name: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO slack_own_reactions (channel, ts, name) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
            params![channel, ts, name],
        )?;
        Ok(())
    }

    /// Whether this reaction is the echo of one Lotus added. The record is
    /// used up by its echo, so my own later reaction there counts again.
    pub fn take_own_reaction(&self, channel: &str, ts: &str, name: &str) -> Result<bool> {
        let deleted = self.conn().execute(
            "DELETE FROM slack_own_reactions WHERE channel = ?1 AND ts = ?2 AND name = ?3",
            params![channel, ts, name],
        )?;
        Ok(deleted > 0)
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite half-written
        // (statements are atomic), so a poisoned lock is safe to reuse.
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

const DRAFT_SELECT: &str =
    "SELECT id, run_id, automation_id, kind, subject, content_json, created_at_ms, status, sent_url, sent_at_ms FROM drafts";

type DraftRow = (String, String, String, String, String, String, i64, String, Option<String>, Option<i64>);

fn draft_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DraftRow> {
    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?))
}

fn finish_draft(row: DraftRow) -> Result<Draft> {
    let (id, run_id, automation_id, kind, subject, content, created_at_ms, status, sent_url, sent_at_ms) = row;
    Ok(Draft {
        id,
        run_id,
        automation_id,
        kind,
        subject,
        content: serde_json::from_str(&content)?,
        created_at_ms,
        status: DraftStatus::parse(&status).ok_or_else(|| Error::Corrupt(format!("draft status {status:?}")))?,
        sent_url,
        sent_at_ms,
    })
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let current: usize = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    if current > MIGRATIONS.len() {
        return Err(Error::SchemaTooNew { found: current, supported: MIGRATIONS.len() });
    }
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}
