#![allow(dead_code)]
//! Fakes at the two system boundaries (GitHub, the agent) and a world
//! builder, shared by the pr_review integration tests.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lotus_automation::agent::{AgentRequest, AgentRunner};
use lotus_automation::github::{Discussion, GitHub, PrState, PrSummary, PullRequest, ReviewThread};
use lotus_automation::pr_review::{self, PrRef, PrReviewAction, PrReviewLimits};
use lotus_automation::{
    BoxFuture, Clock, Engine, EngineConfig, NewAutomation, Registry, Run, Spec, Store, Submitted,
};
use serde_json::{json, Value};

pub const REPO: &str = "initech/orbit-app";
pub const ME: &str = "alwisofwan1";
pub const TEAM: &str = "initech/team-orbit";

pub const DIFF: &str = "\
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,2 +10,3 @@
   const a = 1;
+  const b = eval(input);
   return a;
";

// ---------- fakes at the two system boundaries ----------

pub struct FakeGitHub {
    pub pr: Mutex<PullRequest>,
    pub diff: Mutex<String>,
    pub move_on_diff: Mutex<Option<String>>,
    pub files: HashMap<String, String>,
    /// `(pr, request body)` of every review posted.
    pub posted: Mutex<Vec<(PrRef, Value)>>,
    /// When set, `post_review` fails with this error.
    pub fail_post: Mutex<Option<String>>,
    /// How many next `pull_request` calls fail, like a GitHub outage.
    pub fail_pull_request: Mutex<u32>,
    /// What a review-request search returns, and the searches made.
    pub review_requests: Mutex<Vec<PrSummary>>,
    pub searches: Mutex<Vec<(String, Option<String>)>>,
    /// The threads each review id has (a re-review reads them), and the diffs between commits.
    pub threads: Mutex<HashMap<u64, Vec<ReviewThread>>>,
    pub compares: Mutex<HashMap<(String, String), String>>,
    /// `(comment id, body)` of every thread reply posted.
    pub thread_replies: Mutex<Vec<(u64, String)>>,
    /// What everyone has said on the PR, and the review ids dismissed.
    pub discussion: Mutex<Discussion>,
    pub dismissed: Mutex<Vec<u64>>,
}

impl GitHub for FakeGitHub {
    fn pull_request(&self, _account: &str, _pr: &PrRef) -> BoxFuture<Result<PullRequest, String>> {
        let pr = self.pr.lock().unwrap().clone();
        let fail = {
            let mut left = self.fail_pull_request.lock().unwrap();
            let fail = *left > 0;
            *left = left.saturating_sub(1);
            fail
        };
        Box::pin(async move {
            if fail {
                return Err("502 Bad Gateway".to_string());
            }
            // A real network call suspends; so does this, so concurrent callers interleave.
            tokio::task::yield_now().await;
            Ok(pr)
        })
    }
    fn diff(&self, _account: &str, _pr: &PrRef) -> BoxFuture<Result<String, String>> {
        if let Some(head) = self.move_on_diff.lock().unwrap().take() {
            self.pr.lock().unwrap().head_sha = head;
        }
        let diff = self.diff.lock().unwrap().clone();
        Box::pin(async move { Ok(diff) })
    }
    fn file(&self, _account: &str, _repo: &str, path: &str, _git_ref: &str) -> BoxFuture<Result<Option<String>, String>> {
        let file = self.files.get(path).cloned();
        Box::pin(async move { Ok(file) })
    }
    fn review_requests(&self, account: &str, team: Option<&str>) -> BoxFuture<Result<Vec<PrSummary>, String>> {
        self.searches.lock().unwrap().push((account.to_string(), team.map(str::to_string)));
        let found = self.review_requests.lock().unwrap().clone();
        Box::pin(async move { Ok(found) })
    }
    fn post_review(&self, _account: &str, pr: &PrRef, body: Value) -> BoxFuture<Result<String, String>> {
        if let Some(err) = self.fail_post.lock().unwrap().clone() {
            return Box::pin(async move { Err(err) });
        }
        let mut posted = self.posted.lock().unwrap();
        posted.push((pr.clone(), body));
        let url = format!("https://github.com/{}/pull/{}#pullrequestreview-{}", pr.repo, pr.number, posted.len());
        Box::pin(async move { Ok(url) })
    }
    fn review_threads(&self, _account: &str, _pr: &PrRef, review_id: u64) -> BoxFuture<Result<Vec<ReviewThread>, String>> {
        let threads = self.threads.lock().unwrap().get(&review_id).cloned().unwrap_or_default();
        Box::pin(async move { Ok(threads) })
    }
    fn compare_diff(&self, _account: &str, _repo: &str, base: &str, head: &str) -> BoxFuture<Result<Option<String>, String>> {
        let diff = self.compares.lock().unwrap().get(&(base.to_string(), head.to_string())).cloned();
        Box::pin(async move { Ok(diff) })
    }
    fn reply_to_comment(&self, _account: &str, _pr: &PrRef, comment_id: u64, body: &str) -> BoxFuture<Result<(), String>> {
        self.thread_replies.lock().unwrap().push((comment_id, body.to_string()));
        Box::pin(async { Ok(()) })
    }
    fn discussion(&self, _account: &str, _pr: &PrRef) -> BoxFuture<Result<Discussion, String>> {
        let d = self.discussion.lock().unwrap().clone();
        Box::pin(async move { Ok(d) })
    }
    fn dismiss_review(&self, _account: &str, _pr: &PrRef, review_id: u64, _message: &str) -> BoxFuture<Result<(), String>> {
        self.dismissed.lock().unwrap().push(review_id);
        Box::pin(async { Ok(()) })
    }
}

pub enum Reply {
    Json(Value),
    Hang,
    /// One reply per call, in order; the last one repeats.
    Seq(Vec<Value>),
    /// One reply per call, in order; after the last, every call hangs.
    ThenHang(Vec<Value>),
}

pub struct FakeAgent {
    pub reply: Reply,
    pub seen: Mutex<Vec<AgentRequest>>,
}

impl AgentRunner for FakeAgent {
    fn run(&self, request: AgentRequest) -> BoxFuture<Result<Value, String>> {
        let call = {
            let mut seen = self.seen.lock().unwrap();
            seen.push(request);
            seen.len() - 1
        };
        let reply = match &self.reply {
            Reply::Json(v) => Some(v.clone()),
            Reply::Hang => None,
            Reply::Seq(all) => all.get(call).or(all.last()).cloned(),
            Reply::ThenHang(all) => all.get(call).cloned(),
        };
        Box::pin(async move {
            match reply {
                Some(v) => Ok(v),
                None => {
                    tokio::time::sleep(Duration::from_secs(3600)).await;
                    Err("never".into())
                }
            }
        })
    }
}

pub struct FixedClock;
impl Clock for FixedClock {
    fn now_ms(&self) -> i64 {
        1_000
    }
}

// ---------- harness ----------

pub fn open_pr() -> PullRequest {
    PullRequest {
        state: PrState::Open,
        is_draft: false,
        author: "teammate".into(),
        head_sha: "sha1".into(),
        base_sha: "base1".into(),
        base_ref: "main".into(),
        title: "Add b".into(),
        body: "Please review".into(),
        requested_users: vec![ME.into()],
        requested_teams: vec![],
    }
}

pub fn good_review() -> Value {
    json!({
        "summary": "One risky line.",
        "comments": [
            { "path": "src/app.ts", "line": 11, "severity": "blocker", "body": "eval on user input is remote code execution." },
            { "path": "src/app.ts", "line": 99, "severity": "should-fix", "body": "Not in the diff." },
            { "path": "src/other.ts", "line": 1, "severity": "question", "body": "Not in the diff either." }
        ]
    })
}

pub struct World {
    pub _dir: tempfile::TempDir,
    pub store: Arc<Store>,
    pub github: Arc<FakeGitHub>,
    pub agent: Arc<FakeAgent>,
    pub engine: Engine,
    pub automation: lotus_automation::Automation,
}

pub fn world_with(pr: PullRequest, reply: Reply, limits: PrReviewLimits) -> World {
    build(pr, reply, limits, None, json!({}), None, None)
}

/// A world whose automation config also carries `extra`, and whose action checks skills with `skills`.
#[allow(dead_code)]
pub fn world_configured(extra: Value, skills: Option<lotus_automation::pr_review::SkillCheck>) -> World {
    world_configured_with(extra, skills, Reply::Json(good_review()), PrReviewLimits::default())
}

#[allow(dead_code)]
pub fn world_configured_with(
    extra: Value,
    skills: Option<lotus_automation::pr_review::SkillCheck>,
    reply: Reply,
    limits: PrReviewLimits,
) -> World {
    build(open_pr(), reply, limits, None, extra, skills, None)
}

/// A world whose action reads Slack threads with `reader`.
#[allow(dead_code)]
pub fn world_with_threads(reader: Arc<dyn lotus_automation::pr_review::thread::ThreadReader>) -> World {
    build(open_pr(), Reply::Json(good_review()), PrReviewLimits::default(), None, json!({}), None, Some(reader))
}

pub fn world_with_notifier(pr: PullRequest, notifier: Arc<dyn lotus_automation::Notifier>) -> World {
    build(pr, Reply::Json(good_review()), PrReviewLimits::default(), Some(notifier), json!({}), None, None)
}

fn build(
    pr: PullRequest,
    reply: Reply,
    limits: PrReviewLimits,
    notifier: Option<Arc<dyn lotus_automation::Notifier>>,
    extra: Value,
    skills: Option<lotus_automation::pr_review::SkillCheck>,
    threads: Option<Arc<dyn lotus_automation::pr_review::thread::ThreadReader>>,
) -> World {
    let dir = tempfile::tempdir().unwrap();
    let mut config = json!({
        "account": ME,
        "preset_id": "preset_alwi",
        "repos": [REPO],
        "instructions": "Focus on security."
    });
    config.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
    let store = Arc::new(Store::open(&dir.path().join("automations.db")).unwrap());
    let automation = store
        .create_automation(
            NewAutomation {
                name: "Review orbit PRs".into(),
                trigger: Spec::new("manual", json!({})),
                action: Spec::new("pr_review", config),
                outputs: vec![Spec::new("draft", json!({}))],
            },
            1,
        )
        .unwrap();
    let github = Arc::new(FakeGitHub {
        pr: Mutex::new(pr),
        diff: Mutex::new(DIFF.into()),
        move_on_diff: Mutex::new(None),
        files: HashMap::from([(".github/REVIEW.md".to_string(), "Flag any eval().".to_string())]),
        posted: Mutex::new(vec![]),
        fail_post: Mutex::new(None),
        fail_pull_request: Mutex::new(0),
        review_requests: Mutex::new(vec![]),
        searches: Mutex::new(vec![]),
        threads: Mutex::new(HashMap::new()),
        compares: Mutex::new(HashMap::new()),
        thread_replies: Mutex::new(vec![]),
        discussion: Mutex::new(Discussion::default()),
        dismissed: Mutex::new(vec![]),
    });
    let agent = Arc::new(FakeAgent { reply, seen: Mutex::new(vec![]) });
    // With its history, as the host builds it: a re-review reads the review sent before.
    let action = PrReviewAction::new(github.clone(), agent.clone(), limits);
    let action = match skills {
        Some(check) => action.with_skill_check(check),
        None => action,
    };
    let action = match threads {
        Some(reader) => action.with_threads(reader),
        None => action,
    };
    let action = action.with_history(Arc::clone(&store));
    let engine = Engine::new(
        Arc::clone(&store),
        Registry::new().with_action(action),
        Arc::new(FixedClock),
        EngineConfig { retry_delays: vec![], ..EngineConfig::default() },
    );
    let engine = match notifier {
        Some(n) => engine.with_notifier(n),
        None => engine,
    };
    World { _dir: dir, store, github, agent, engine, automation }
}

pub fn world(pr: PullRequest) -> World {
    world_with(pr, Reply::Json(good_review()), PrReviewLimits::default())
}

pub const URL: &str = "https://github.com/initech/orbit-app/pull/42";

pub async fn review(w: &World) -> Run {
    let submitted = pr_review::run_now(&w.engine, &w.store, w.github.as_ref(), &w.automation, URL).await.unwrap();
    let Submitted::Started { run_id } = submitted else { panic!("expected a new run, got {submitted:?}") };
    w.engine.drain().await;
    w.store.get_run(&run_id).unwrap().unwrap()
}

/// Like [`review`], but asked by someone else (a Slack mention).
pub async fn review_asked_by_someone(w: &World) -> Run {
    let pr = pr_review::parse_pr_url(URL).unwrap();
    let submitted = pr_review::submit_pr(&w.engine, w.github.as_ref(), &w.automation, &pr, None).await.unwrap();
    let Submitted::Started { run_id } = submitted else { panic!("expected a new run, got {submitted:?}") };
    w.engine.drain().await;
    w.store.get_run(&run_id).unwrap().unwrap()
}
