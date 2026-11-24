//! Smoke test against real GitHub and a real agent. Creates a draft only;
//! nothing is posted anywhere.
//!
//! ```sh
//! cargo run -p lotus-automation --example review_pr -- \
//!   https://github.com/<owner>/<repo>/pull/<n> <gh-account> "<agent>" ["<preset args>"]
//! # e.g. ... alwisofwan1 "ccs acme" "--model sonnet"
//! ```
//!
//! Uses the current shell's environment (PATH must find `gh` and the agent).
//! The review request is not required here: the gate is bypassed by
//! pretending the account was asked, so any PR you can read works.

use std::collections::HashMap;
use std::sync::Arc;

use lotus_automation::agent::{CliAgentRunner, Preset};
use lotus_automation::github::{Gh, GhCli, GitHub, PullRequest};
use lotus_automation::pr_review::{self, PrRef, PrReviewAction, PrReviewLimits};
use lotus_automation::{BoxFuture, Engine, EngineConfig, NewAutomation, Registry, Spec, Store, Submitted, SystemClock};
use serde_json::json;

/// Real GitHub, except the review request is assumed so the gate passes.
struct AssumeRequested {
    real: GhCli,
    account: String,
}

impl GitHub for AssumeRequested {
    fn pull_request(&self, account: &str, pr: &PrRef) -> BoxFuture<Result<PullRequest, String>> {
        let fut = self.real.pull_request(account, pr);
        let me = self.account.clone();
        Box::pin(async move {
            let mut pr = fut.await?;
            pr.requested_users.push(me);
            Ok(pr)
        })
    }
    fn diff(&self, account: &str, pr: &PrRef) -> BoxFuture<Result<String, String>> {
        self.real.diff(account, pr)
    }
    fn file(&self, account: &str, repo: &str, path: &str, git_ref: &str) -> BoxFuture<Result<Option<String>, String>> {
        self.real.file(account, repo, path, git_ref)
    }
    fn review_requests(
        &self,
        account: &str,
        team: Option<&str>,
    ) -> BoxFuture<Result<Vec<lotus_automation::github::PrSummary>, String>> {
        self.real.review_requests(account, team)
    }
    fn post_review(&self, _account: &str, _pr: &PrRef, _body: serde_json::Value) -> BoxFuture<Result<String, String>> {
        // This smoke test never posts.
        Box::pin(async { Err("review_pr never posts".into()) })
    }
    fn review_threads(
        &self,
        account: &str,
        pr: &PrRef,
        review_id: u64,
    ) -> BoxFuture<Result<Vec<lotus_automation::github::ReviewThread>, String>> {
        self.real.review_threads(account, pr, review_id)
    }
    fn compare_diff(&self, account: &str, repo: &str, base: &str, head: &str) -> BoxFuture<Result<Option<String>, String>> {
        self.real.compare_diff(account, repo, base, head)
    }
    fn reply_to_comment(&self, _account: &str, _pr: &PrRef, _comment_id: u64, _body: &str) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Err("review_pr never posts".into()) })
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [url, account, agent, rest @ ..] = args.as_slice() else {
        eprintln!("usage: review_pr <pr-url> <gh-account> <agent> [preset-args]");
        std::process::exit(2);
    };
    let preset = Preset { agent: agent.clone(), args: rest.first().cloned().unwrap_or_default(), ..Default::default() };
    let pr = pr_review::parse_pr_url(url).expect("not a GitHub PR URL");

    let env: HashMap<String, String> = std::env::vars().collect();
    let github = Arc::new(AssumeRequested { real: GhCli::new(Gh::new("gh").with_base_env(env.clone())), account: account.clone() });
    let runner = Arc::new(CliAgentRunner::new(Arc::new(move |_| Some(preset.clone())), env));

    let dir = std::env::temp_dir().join(format!("lotus-review-smoke-{}", std::process::id()));
    let store = Arc::new(Store::open(&dir.join("automations.db")).unwrap());
    let automation = store
        .create_automation(
            NewAutomation {
                name: "smoke".into(),
                trigger: Spec::new("manual", json!({})),
                action: Spec::new(
                    "pr_review",
                    json!({ "account": account, "preset_id": "smoke", "repos": [pr.repo], "instructions": "Be brief." }),
                ),
                outputs: vec![Spec::new("draft", json!({}))],
            },
            SystemClockNow::now(),
        )
        .unwrap();
    let engine = Engine::new(
        Arc::clone(&store),
        Registry::new().with_action(PrReviewAction::new(github.clone(), runner, PrReviewLimits::default())),
        Arc::new(SystemClock),
        EngineConfig::default(),
    );

    let submitted = pr_review::run_now(&engine, &store, github.as_ref(), &automation, url).await.expect("run_now");
    let Submitted::Started { run_id } = submitted else { unreachable!("fresh store") };
    eprintln!("reviewing {url} ... (up to 10 minutes)");
    engine.drain().await;

    let run = store.get_run(&run_id).unwrap().unwrap();
    println!("status: {:?}\ndetail: {}", run.status, run.detail.unwrap_or_default());
    if let Some(draft) = store.draft_for_run(&run_id).unwrap() {
        println!("{}", serde_json::to_string_pretty(&draft.content).unwrap());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

struct SystemClockNow;
impl SystemClockNow {
    fn now() -> i64 {
        use lotus_automation::Clock;
        SystemClock.now_ms()
    }
}
