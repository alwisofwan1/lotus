//! The app's side of a Factory Run (ADR-0049 §1, §4, §9): the two ports of
//! `lotus_graph_run::factory`, backed by the real agent CLI and `gh`, and the worktree reaper loop.
//!
//! - [`CliImplementer`]: one implement attempt = one full-access run of the ticket's delegation
//!   preset in the run's worktree (`CliAgentRunner`, as Automations run agents), with its cost.
//! - [`CliSpecAgent`]: one intake turn (FI2), triage turn (FI3) or review turn (FI7) = one read-only
//!   run of the role's preset in the run's worktree, in a session later turns resume, with its cost.
//! - [`CliJudge`]: the Chief of Staff's Judge (CoS 5) = one sealed, one-shot run (no tools, no
//!   MCP, no session) of the preset and model in `chief-of-staff.md` at `origin/<base>`.
//! - [`GhPullRequests`]: `gh` as the Ticket Source's account, its token read from gh's keyring per
//!   call (never stored). Opens draft PRs only.
//!
//! Not unit-tested (real tokens, real network); the crate's tests cover the step with fakes, and
//! F2b's by-hand run covers these.

use crate::no_window::NoWindow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use lotus_automation::agent::{Access, AgentRequest, AgentRunner, AgentSession, CliAgentRunner, PresetLookup, AgentProcessEvent, ProcessSink, StepSink};
use lotus_automation::github::Gh;
use lotus_graph_run::factory::{
    DraftPr, Fetched, ImplementOutcome, ImplementRequest, Implementer, IssueComment, IssueContext, LinkedPr, PrState, PullRequests, SpecAgent,
    SpecOutcome, SpecRequest, REVIEW_LABEL,
};
use lotus_graph_run::factory::judge::{judge_prompt, task_instructions, Judge, JudgeRequest};
use lotus_graph_run::factory::kit::KitSources;
use lotus_graph_run::factory::{read_definition_for, CHEAP_MODEL};
use lotus_graph_run::triage::mentions_key;
use lotus_graph_run::BoxFuture;

/// `<Lotus state dir>/factory`: worktrees and their sidecars.
pub fn factory_root() -> PathBuf {
    crate::paths::lotus_state_dir().join("factory")
}

/// What the implementer's `summary` must say; the draft PR's body carries it, so a reviewer reads
/// the agent's reasoning instead of digging for it.
const SUMMARY_ASK: &str = "For the pull request, in plain Markdown, at most about 10 lines: what you changed; why \
     (the cause you found, or which side was wrong and the evidence); and how you checked it. Describe the whole \
     change in the worktree, not only this attempt.";

/// The `summary` of the implementer's schema-bound reply.
fn summary_of(reply: &serde_json::Value) -> Option<String> {
    reply.get("summary")?.as_str().map(str::to_string)
}

/// The presets, each run on `model` (a role's `model:`) in place of its own `--model`.
pub(crate) fn with_model(presets: &PresetLookup, model: Option<String>) -> PresetLookup {
    let Some(model) = model else { return Arc::clone(presets) };
    let inner = Arc::clone(presets);
    Arc::new(move |id: &str| {
        inner(id).map(|mut preset| {
            preset.args = lotus_automation::agent::set_flag(&preset.args, "--model", &model);
            preset
        })
    })
}


pub struct CliImplementer {
    pub presets: PresetLookup,
    /// The login shell's environment (PATH for the agent and the tools it runs).
    pub env: HashMap<String, String>,
}

/// Each step the agent takes ("Edited src/a.rs") reaches the run's progress, so a working run is
/// never called stalled by the Chief of Staff.
fn step_sink(steps: lotus_graph_run::ProgressSink) -> StepSink {
    Arc::new(move |_run, step| steps.send(lotus_graph_run::ProgressEvent::Output(step)))
}

fn process_sink(handle: lotus_graph_run::factory::execution::ProcessHandle) -> ProcessSink {
    Arc::new(move |event| match event {
        AgentProcessEvent::Spawned(pid) => handle.spawned(pid),
        AgentProcessEvent::Exited(pid) => handle.exited(pid),
    })
}
impl Implementer for CliImplementer {
    fn implement(&self, request: ImplementRequest) -> BoxFuture<ImplementOutcome> {
        let Some(execution) = request.execution.clone() else {
            return Box::pin(async { ImplementOutcome { result: Err("Factory execution owner unavailable".into()), cost_usd: None, summary: None, transient: false } });
        };
        // The agent builds in the worktree: its cargo output stays there, never in a repo's target/.
        let mut env = self.env.clone();
        env.insert("CARGO_TARGET_DIR".into(), request.worktree.join("target").to_string_lossy().into_owned());
        // The worktree's mise.toml must be trusted, or the agent's `bun`/`node` are not on PATH.
        let trusted = lotus_graph_run::factory::mise_trusted_paths(env.get("MISE_TRUSTED_CONFIG_PATHS").map(String::as_str), &factory_root());
        env.insert("MISE_TRUSTED_CONFIG_PATHS".into(), trusted);
        let session_id = uuid::Uuid::new_v4().to_string();
        let runner = CliAgentRunner::new(with_model(&self.presets, request.model), env)
            .with_process_events(process_sink(execution.with_session(session_id.clone())))
            .with_steps(step_sink(request.steps));
        let run_id = Some(request.graph_run_id);
        let agent_request = AgentRequest {
            preset_id: request.ticket.implementer.clone(),
            prompt: request.prompt,
            schema: serde_json::json!({
                "type": "object",
                "properties": { "summary": { "type": "string", "description": SUMMARY_ASK } },
                "required": ["summary"],
            }),
            tools: vec![],
            access: Access::Full,
            session: Some(AgentSession { id: session_id, cwd: request.worktree, resume: false }),
            workspace: None,
            repo: Some(request.ticket.repo),
            run_id,
            // Only the implement role's MCP servers and skills (FI4), not every server the user has.
            mcp_config: request.kit.as_ref().map(|k| k.mcp_config.clone()),
            plugin_dirs: request.kit.iter().flat_map(|k| k.plugin_dir.clone()).collect(),
        };
        // The runner bounds the attempt's time (`timeout_minutes`) and retries a short outage once.
        Box::pin(async move {
            let (result, cost_usd) = runner.run_metered(agent_request).await;
            let summary = result.as_ref().ok().and_then(summary_of);
            let transient = result.as_ref().is_err_and(|e| lotus_automation::agent::is_transient_error(e));
            ImplementOutcome { result: result.map(|_| ()), cost_usd, summary, transient }
        })
    }
}

/// The spec agent: reads the worktree, never edits it (ADR-0051 §6), with only the MCP servers and
/// skills its role names (FI4). The runner bounds each turn's time.
pub struct CliSpecAgent {
    pub presets: PresetLookup,
    pub env: HashMap<String, String>,
}

impl SpecAgent for CliSpecAgent {
    fn turn(&self, request: SpecRequest) -> BoxFuture<SpecOutcome> {
        let Some(execution) = request.execution.clone() else {
            return Box::pin(async { SpecOutcome { reply: Err("Factory execution owner unavailable".into()), cost_usd: None } });
        };
        let runner = CliAgentRunner::new(with_model(&self.presets, request.model), self.env.clone())
            .with_process_events(process_sink(execution.with_session(request.session_id.clone())))
            .with_steps(step_sink(request.steps));
        let run_id = Some(request.graph_run_id);
        let agent_request = AgentRequest {
            preset_id: request.preset,
            prompt: request.prompt,
            schema: request.schema,
            tools: vec![],
            // Each chosen server is allowed whole (`mcp__<name>`); the kit's config starts only those.
            access: Access::ReadOnly {
                mcp_tools: request.kit.iter().flat_map(|k| k.mcp.iter().map(|name| format!("mcp__{name}"))).collect(),
                github_account: None,
                run_tests: false,
            },
            // `--resume` finds a session only from the folder it began in: always the worktree.
            session: Some(AgentSession { id: request.session_id, cwd: request.worktree, resume: request.resume }),
            workspace: None,
            repo: Some(request.ticket.repo),
            run_id,
            mcp_config: request.kit.as_ref().map(|k| k.mcp_config.clone()),
            plugin_dirs: request.kit.iter().flat_map(|k| k.plugin_dir.clone()).collect(),
        };
        Box::pin(async move {
            let (reply, cost_usd) = runner.run_metered(agent_request).await;
            SpecOutcome { reply, cost_usd }
        })
    }
}

/// The Chief of Staff's Judge. Each call reads the repo's factory again, so an edited
/// `chief-of-staff.md` applies at the next batch.
pub struct CliJudge {
    pub presets: PresetLookup,
    pub env: HashMap<String, String>,
    /// Where a repo's private factory is (#169), when it has none of its own.
    pub kit: KitSources,
}

impl Judge for CliJudge {
    fn judge(&self, request: JudgeRequest) -> BoxFuture<Result<serde_json::Value, String>> {
        let (presets, env) = (Arc::clone(&self.presets), self.env.clone());
        let private = self.kit.private_dir(&request.ticket.repo);
        Box::pin(async move {
            let (checkout, base, read_env) = (request.ticket.checkout.clone(), request.ticket.base.clone(), env.clone());
            let definition = tokio::task::spawn_blocking(move || read_definition_for(&checkout, &base, private.as_deref(), &read_env))
                .await
                .map_err(|e| format!("cannot read the factory definition: {e}"))??;
            let chief = definition.chief;
            let preset_id = chief.preset.unwrap_or(request.ticket.implementer);
            let preset = presets(&preset_id).ok_or_else(|| format!("no delegation preset \"{preset_id}\""))?;
            // Labelling is a small task: a cheap model unless the file names one. Only on Claude,
            // whose model names Lotus knows.
            let model = chief.model.or_else(|| (preset.agent.trim() == "claude").then(|| CHEAP_MODEL.to_string()));
            let runner = CliAgentRunner::new(with_model(&presets, model), env);
            runner
                .run(AgentRequest {
                    preset_id,
                    prompt: judge_prompt(task_instructions(request.task, &chief.prompt), &request.context),
                    schema: request.schema,
                    tools: vec![],
                    access: Access::Sealed,
                    session: None,
                    workspace: None,
                    repo: None,
                    run_id: None,
                    mcp_config: None,
                    plugin_dirs: vec![],
                })
                .await
        })
    }
}

pub struct GhPullRequests {
    pub gh: Gh,
}

struct Output {
    ok: bool,
    stdout: String,
    stderr: String,
}

async fn run(program: &str, args: &[String], env: &HashMap<String, String>, stdin: Option<&str>) -> Result<Output, String> {
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(program)
        .no_window()
        .args(args)
        .env_clear()
        .envs(env)
        .stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("could not start {program}: {e}"))?;
    if let (Some(text), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(text.as_bytes()).await.map_err(|e| format!("could not write to {program}: {e}"))?;
    }
    let out = child.wait_with_output().await.map_err(|e| format!("{program} did not finish: {e}"))?;
    Ok(Output {
        ok: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).trim().to_string(),
    })
}

impl GhPullRequests {
    async fn token(&self, account: &str) -> Result<String, String> {
        let no_login = || format!("gh has no usable login for {account}; run `gh auth login` for that account");
        // gh still hands out the token of an account logged out of it (see `Gh::is_logged_out`).
        if self.gh.is_logged_out(account) {
            return Err(no_login());
        }
        let inv = self.gh.token_invocation(account).map_err(|e| e.to_string())?;
        let out = run(&inv.program, &inv.args, &inv.env, None).await?;
        if !out.ok || out.stdout.is_empty() {
            return Err(no_login());
        }
        Ok(out.stdout)
    }

    /// `gh <args>` with a token already fetched (one lookup serves a whole PR call).
    async fn gh(&self, token: &str, args: &[&str], stdin: Option<&str>) -> Result<Output, String> {
        // `api_invocation` carries the token env; only its program and env are used.
        let inv = self.gh.api_invocation(token, &[]);
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        run(&inv.program, &args, &inv.env, stdin).await
    }
}

/// The `gh pr create` arguments: `--draft` only for a Draft (ADR-0063 §7).
fn pr_create_args(pr: &DraftPr) -> Vec<&str> {
    let mut args = vec!["pr", "create"];
    if pr.draft {
        args.push("--draft");
    }
    args.extend(["--repo", &pr.repo, "--head", &pr.head, "--base", &pr.base, "--title", &pr.title, "--body-file", "-", "--label", REVIEW_LABEL]);
    args
}

impl PullRequests for GhPullRequests {
    fn push_token(&self, account: &str) -> BoxFuture<Result<String, String>> {
        let (this, account) = (GhPullRequests { gh: self.gh.clone() }, account.to_string());
        Box::pin(async move { this.token(&account).await })
    }

    fn open_draft(&self, account: &str, pr: DraftPr) -> BoxFuture<Result<String, String>> {
        let (this, account) = (GhPullRequests { gh: self.gh.clone() }, account.to_string());
        Box::pin(async move {
            let token = this.token(&account).await?;
            let create_args = pr_create_args(&pr);
            let mut out = this.gh(&token, &create_args, Some(&pr.body)).await?;
            // `gh pr create --label` fails on a repo without the label: make it, then retry once.
            if !out.ok && label_is_missing(&out.stderr) {
                let _ = this
                    .gh(
                        &token,
                        &["label", "create", REVIEW_LABEL, "--repo", &pr.repo, "--color", "C5DEF5", "--description", "PR opened by a Lotus Factory Run"],
                        None,
                    )
                    .await;
                out = this.gh(&token, &create_args, Some(&pr.body)).await?;
            }
            if !out.ok {
                return Err(format!("gh pr create failed: {}", out.stderr));
            }
            // gh prints the PR URL as its last line.
            Ok(out.stdout.lines().last().unwrap_or_default().to_string())
        })
    }

    fn state(&self, account: &str, repo: &str, branch: &str) -> BoxFuture<Result<PrState, String>> {
        let (this, account, repo, branch) = (GhPullRequests { gh: self.gh.clone() }, account.to_string(), repo.to_string(), branch.to_string());
        Box::pin(async move {
            let token = this.token(&account).await?;
            let out = this
                .gh(&token, &["pr", "list", "--repo", &repo, "--head", &branch, "--state", "all", "--json", "state", "--limit", "1"], None)
                .await?;
            if !out.ok {
                return Err(format!("gh pr list failed: {}", out.stderr));
            }
            parse_pr_state(&out.stdout)
        })
    }

    fn issue_context(&self, account: &str, repo: &str, issue: u64) -> BoxFuture<Result<IssueContext, String>> {
        let (this, account, repo) = (GhPullRequests { gh: self.gh.clone() }, account.to_string(), repo.to_string());
        Box::pin(async move {
            let token = this.token(&account).await?;
            let number = issue.to_string();
            let view = this.gh(&token, &["issue", "view", &number, "--repo", &repo, "--json", "state,labels,comments"], None).await?;
            if !view.ok {
                return Err(format!("gh issue view failed: {}", view.stderr));
            }
            // `closedByPullRequestsReferences` carries no PR state: the open PRs are listed instead.
            let prs = this
                .gh(
                    &token,
                    &["pr", "list", "--repo", &repo, "--state", "open", "--limit", "100", "--json", "number,url,headRefName,closingIssuesReferences"],
                    None,
                )
                .await?;
            if !prs.ok {
                return Err(format!("gh pr list failed: {}", prs.stderr));
            }
            parse_issue_context(&view.stdout, &prs.stdout, &repo, issue)
        })
    }

    fn prs_mentioning(&self, account: &str, repo: &str, key: &str) -> BoxFuture<Result<Vec<LinkedPr>, String>> {
        let (this, account, repo, key) = (GhPullRequests { gh: self.gh.clone() }, account.to_string(), repo.to_string(), key.to_string());
        Box::pin(async move {
            let token = this.token(&account).await?;
            // GitHub's search is loose (it may split `TKT-123`): it narrows, the exact match is ours.
            let search = format!("\"{key}\" in:title,body");
            let prs = this
                .gh(
                    &token,
                    &["pr", "list", "--repo", &repo, "--state", "open", "--search", &search, "--limit", "100", "--json", "number,url,headRefName,title,body"],
                    None,
                )
                .await?;
            if !prs.ok {
                return Err(format!("gh pr list failed: {}", prs.stderr));
            }
            parse_mentions(&prs.stdout, &key)
        })
    }

    fn get(&self, account: &str, path: &str, etag: Option<&str>) -> BoxFuture<Result<Fetched, String>> {
        let (this, account, path) = (GhPullRequests { gh: self.gh.clone() }, account.to_string(), path.to_string());
        let condition = etag.map(|etag| format!("If-None-Match: {etag}"));
        Box::pin(async move {
            let token = this.token(&account).await?;
            let mut args = vec!["api", "--include"];
            if let Some(condition) = &condition {
                args.extend(["-H", condition.as_str()]);
            }
            args.push(&path);
            let out = this.gh(&token, &args, None).await?;
            parse_fetched(&path, &out)
        })
    }

    fn reply_in_thread(&self, account: &str, repo: &str, number: u64, comment_id: u64, body: &str) -> BoxFuture<Result<u64, String>> {
        let path = format!("repos/{repo}/pulls/{number}/comments/{comment_id}/replies");
        let post = self.post(account, path, serde_json::json!({ "body": body }));
        Box::pin(async move { posted_id(&post.await?) })
    }

    fn comment(&self, account: &str, repo: &str, number: u64, body: &str) -> BoxFuture<Result<u64, String>> {
        let post = self.post(account, format!("repos/{repo}/issues/{number}/comments"), serde_json::json!({ "body": body }));
        Box::pin(async move { posted_id(&post.await?) })
    }

    fn request_review(&self, account: &str, repo: &str, number: u64, reviewers: &[String]) -> BoxFuture<Result<(), String>> {
        let post = self.post(account, format!("repos/{repo}/pulls/{number}/requested_reviewers"), serde_json::json!({ "reviewers": reviewers }));
        Box::pin(async move { post.await.map(|_| ()) })
    }
}

impl GhPullRequests {
    /// `gh api -X POST <path>` with a JSON body on stdin, as the account's `gh` login (CoS 9).
    fn post(&self, account: &str, path: String, body: serde_json::Value) -> BoxFuture<Result<serde_json::Value, String>> {
        let (this, account) = (GhPullRequests { gh: self.gh.clone() }, account.to_string());
        Box::pin(async move {
            let token = this.token(&account).await?;
            let out = this.gh(&token, &["api", "-X", "POST", &path, "--input", "-"], Some(&body.to_string())).await?;
            if !out.ok {
                return Err(format!("gh api {path} failed: {}", out.stderr.trim()));
            }
            serde_json::from_str(&out.stdout).map_err(|e| format!("gh api {path} printed no JSON: {e}"))
        })
    }
}

/// The id of the comment GitHub just made.
fn posted_id(answer: &serde_json::Value) -> Result<u64, String> {
    answer["id"].as_u64().ok_or_else(|| "GitHub's answer has no comment id".to_string())
}

/// `gh api --include` → what GitHub answered. gh exits 1 on a 304 (`gh: HTTP 304`), so the
/// status decides, never the exit code.
fn parse_fetched(path: &str, out: &Output) -> Result<Fetched, String> {
    let Some((status, headers, body)) = lotus_automation::github::split_included(out.stdout.as_bytes()) else {
        return Err(format!("gh api {path} failed: {}", out.stderr));
    };
    match status {
        304 => Ok(Fetched::Unchanged),
        200 => {
            let etag = headers.into_iter().find(|(name, _)| name == "etag").map(|(_, value)| value);
            let body = serde_json::from_slice(&body).map_err(|e| format!("gh api {path} printed no JSON: {e}"))?;
            Ok(Fetched::Changed { etag, body })
        }
        other => Err(format!("gh api {path}: HTTP {other} {}", out.stderr)),
    }
}

/// `gh pr list --json number,url,headRefName,title,body` → the PRs whose title or body names `key`
/// as a whole word (`TKT-12` is not `TKT-123`).
fn parse_mentions(prs: &str, key: &str) -> Result<Vec<LinkedPr>, String> {
    let prs: Vec<serde_json::Value> = serde_json::from_str(prs).map_err(|e| format!("gh pr list printed no JSON: {e}"))?;
    let text = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_string();
    Ok(prs
        .iter()
        .filter(|pr| mentions_key(&text(&pr["title"]), key) || mentions_key(&text(&pr["body"]), key))
        .filter_map(|pr| Some(LinkedPr { number: pr["number"].as_u64()?, url: text(&pr["url"]), branch: text(&pr["headRefName"]) }))
        .collect())
}

/// `gh issue view --json state,labels,comments` and `gh pr list --json
/// number,url,headRefName,closingIssuesReferences` → the issue's context, with only the open PRs
/// that close this issue of this repo.
fn parse_issue_context(view: &str, prs: &str, repo: &str, issue: u64) -> Result<IssueContext, String> {
    let view: serde_json::Value = serde_json::from_str(view).map_err(|e| format!("gh issue view printed no JSON: {e}"))?;
    let prs: Vec<serde_json::Value> = serde_json::from_str(prs).map_err(|e| format!("gh pr list printed no JSON: {e}"))?;
    let text = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_string();
    let labels = view["labels"].as_array().into_iter().flatten().map(|l| text(&l["name"])).filter(|l| !l.is_empty()).collect();
    let comments = view["comments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| IssueComment { author: text(&c["author"]["login"]), body: text(&c["body"]), at: text(&c["createdAt"]) })
        .collect();
    let closes_this = |pr: &serde_json::Value| {
        pr["closingIssuesReferences"].as_array().into_iter().flatten().any(|i| {
            let same_repo = format!("{}/{}", text(&i["repository"]["owner"]["login"]), text(&i["repository"]["name"]));
            i["number"].as_u64() == Some(issue) && same_repo.eq_ignore_ascii_case(repo)
        })
    };
    let open_prs = prs
        .iter()
        .filter(|pr| closes_this(pr))
        .filter_map(|pr| Some(LinkedPr { number: pr["number"].as_u64()?, url: text(&pr["url"]), branch: text(&pr["headRefName"]) }))
        .collect();
    Ok(IssueContext { state: text(&view["state"]), labels, comments, open_prs })
}

/// True when `gh pr create --label` failed because the repo has no such label.
fn label_is_missing(stderr: &str) -> bool {
    let text = stderr.to_lowercase();
    text.contains("label") && (text.contains("not found") || text.contains("could not add label"))
}

/// `gh pr list --json state` → the state of the newest PR of a branch.
fn parse_pr_state(stdout: &str) -> Result<PrState, String> {
    let list: Vec<serde_json::Value> = serde_json::from_str(stdout).map_err(|e| format!("gh pr list printed no JSON: {e}"))?;
    Ok(match list.first().and_then(|pr| pr["state"].as_str()) {
        None => PrState::Missing,
        Some("OPEN") => PrState::Open,
        Some("MERGED") => PrState::Merged,
        Some("CLOSED") => PrState::Closed,
        Some(other) => return Err(format!("unknown PR state {other}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_roles_model_replaces_the_presets_own() {
        assert_eq!(lotus_automation::agent::set_flag("--dangerously-skip-permissions", "--model", "opus"), "--dangerously-skip-permissions --model opus");
        assert_eq!(lotus_automation::agent::set_flag("--model sonnet --verbose", "--model", "opus"), "--verbose --model opus");
        assert_eq!(lotus_automation::agent::set_flag("--model=sonnet", "--model", "opus"), "--model opus");
        let presets: PresetLookup = Arc::new(|id: &str| {
            (id == "p").then(|| lotus_automation::agent::Preset { agent: "claude".into(), args: "--model sonnet".into(), ..Default::default() })
        });
        assert_eq!(with_model(&presets, Some("opus".into()))("p").unwrap().args, "--model opus");
        assert_eq!(with_model(&presets, None)("p").unwrap().args, "--model sonnet");
    }

    #[test]
    fn a_304_is_unchanged_although_gh_exits_1() {
        // As `gh api --include` printed it on 2026-10-13 (research/github-read-surface.md §3).
        let not_modified = Output { ok: false, stdout: "HTTP/2.0 304 Not Modified\r\nEtag: W/\"abc\"\r\nX-Ratelimit-Used: 8".into(), stderr: "gh: HTTP 304".into() };
        assert_eq!(parse_fetched("p", &not_modified), Ok(Fetched::Unchanged));
        let fresh = Output { ok: true, stdout: "HTTP/2.0 200 OK\r\nEtag: W/\"abc\"\r\n\r\n[{\"id\":1}]".into(), stderr: String::new() };
        assert_eq!(parse_fetched("p", &fresh), Ok(Fetched::Changed { etag: Some("W/\"abc\"".into()), body: serde_json::json!([{ "id": 1 }]) }));
        let missing = Output { ok: false, stdout: "HTTP/2.0 404 Not Found\r\n\r\n{}".into(), stderr: "gh: Not Found (HTTP 404)".into() };
        assert!(parse_fetched("p", &missing).unwrap_err().contains("HTTP 404"));
        let offline = Output { ok: false, stdout: String::new(), stderr: "error connecting to api.github.com".into() };
        assert!(parse_fetched("p", &offline).unwrap_err().contains("error connecting"));
    }

    #[test]
    fn pr_state_reads_gh_pr_list_json() {
        assert_eq!(parse_pr_state("[]"), Ok(PrState::Missing));
        assert_eq!(parse_pr_state(r#"[{"state":"OPEN"}]"#), Ok(PrState::Open));
        assert_eq!(parse_pr_state(r#"[{"state":"MERGED"}]"#), Ok(PrState::Merged));
        assert_eq!(parse_pr_state(r#"[{"state":"CLOSED"}]"#), Ok(PrState::Closed));
        assert!(parse_pr_state(r#"[{"state":"WEIRD"}]"#).is_err());
        assert!(parse_pr_state("not json").is_err());
    }

    #[test]
    fn the_prs_naming_a_notion_ticket_are_matched_as_a_whole_word_in_title_or_body() {
        let prs = r#"[
            {"number": 1, "url": "u1", "headRefName": "a", "title": "Login (TKT-123)", "body": ""},
            {"number": 2, "url": "u2", "headRefName": "b", "title": "Other", "body": "Ticket: [tkt-123](https://www.notion.so/x)"},
            {"number": 3, "url": "u3", "headRefName": "c", "title": "TKT-1234", "body": "see XTKT-123"}
        ]"#;
        let found: Vec<u64> = parse_mentions(prs, "TKT-123").unwrap().iter().map(|p| p.number).collect();
        assert_eq!(found, [1, 2]);
        assert!(parse_mentions("nope", "TKT-1").is_err());
    }

    #[test]
    fn the_issue_context_reads_gh_json_and_keeps_only_prs_closing_this_issue() {
        let view = r#"{"state":"OPEN","labels":[{"name":"bug","color":"d73a4a"}],
            "comments":[{"author":{"login":"maria"},"body":"Keep it empty","createdAt":"2026-10-01T09:00:00Z"}]}"#;
        let repo_ref = |owner: &str, name: &str, n: u64| format!(r#"{{"number":{n},"repository":{{"name":"{name}","owner":{{"login":"{owner}"}}}}}}"#);
        let prs = format!(
            r#"[{{"number":12,"url":"u12","headRefName":"fix/copy","closingIssuesReferences":[{}]}},
                {{"number":13,"url":"u13","headRefName":"other","closingIssuesReferences":[{}]}},
                {{"number":14,"url":"u14","headRefName":"fork","closingIssuesReferences":[{}]}},
                {{"number":15,"url":"u15","headRefName":"none","closingIssuesReferences":[]}}]"#,
            repo_ref("Acme", "widgets", 7),
            repo_ref("acme", "widgets", 8),
            repo_ref("someone", "widgets", 7)
        );
        let context = parse_issue_context(view, &prs, "acme/widgets", 7).unwrap();
        assert_eq!(context.state, "OPEN");
        assert_eq!(context.labels, ["bug"]);
        assert_eq!(context.comments, [IssueComment { author: "maria".into(), body: "Keep it empty".into(), at: "2026-10-01T09:00:00Z".into() }]);
        assert_eq!(context.open_prs, [LinkedPr { number: 12, url: "u12".into(), branch: "fix/copy".into() }]);
        assert!(parse_issue_context("nope", "[]", "acme/widgets", 7).is_err());
        assert!(parse_issue_context("{}", "nope", "acme/widgets", 7).is_err());
        assert_eq!(parse_issue_context("{}", "[]", "acme/widgets", 7).unwrap(), IssueContext::default());
    }

    #[test]
    fn the_summary_is_read_from_the_implementers_reply() {
        assert_eq!(summary_of(&serde_json::json!({ "summary": "Fixed it." })), Some("Fixed it.".into()));
        assert_eq!(summary_of(&serde_json::json!({ "other": 1 })), None);
        assert_eq!(summary_of(&serde_json::json!({ "summary": 3 })), None);
    }

    #[test]
    fn gh_pr_create_gets_draft_only_for_a_draft() {
        let mut pr = DraftPr { repo: "a/b".into(), head: "h".into(), base: "main".into(), title: "t".into(), body: String::new(), draft: true };
        assert!(pr_create_args(&pr).contains(&"--draft"));
        pr.draft = false;
        let args = pr_create_args(&pr);
        assert!(!args.contains(&"--draft") && args.contains(&"--label"), "{args:?}");
    }

    #[test]
    fn a_missing_label_is_told_from_other_pr_create_failures() {
        assert!(label_is_missing("could not add label: 'factory:review' not found"));
        assert!(!label_is_missing("a pull request for branch \"x\" already exists"));
        assert!(!label_is_missing("GraphQL: Resource not accessible by integration"));
    }
}
