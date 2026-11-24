use lotus_automation::github::{Gh, GhRefusal};

const TOKEN: &str = "gho_SECRETSECRETSECRET";

#[test]
fn the_account_token_is_fetched_for_that_account_only() {
    let gh = Gh::new("gh");
    let inv = gh.token_invocation("alwisofwan1").unwrap();
    assert_eq!(inv.program, "gh");
    assert_eq!(inv.args, vec!["auth", "token", "--hostname", "github.com", "--user", "alwisofwan1"]);
}

#[test]
fn an_api_call_carries_the_token_in_the_environment_never_in_arguments_or_logs() {
    let gh = Gh::new("/opt/homebrew/bin/gh")
        .with_base_env([("PATH".to_string(), "/usr/bin".to_string()), ("GITHUB_TOKEN".to_string(), "ghp_OTHER".to_string())]);

    let inv = gh.api_invocation(TOKEN, &["repos/initech/orbit-app/pulls/42"]);

    assert!(inv.args.iter().all(|a| !a.contains(TOKEN)));
    assert_eq!(inv.env.get("GH_TOKEN").map(String::as_str), Some(TOKEN));
    assert_eq!(inv.env.get("GH_PROMPT_DISABLED").map(String::as_str), Some("1"));
    assert!(!inv.env.contains_key("GITHUB_TOKEN"), "an ambient token must not leak in");
    assert_eq!(inv.env.get("PATH").map(String::as_str), Some("/usr/bin"));
    assert!(!format!("{inv:?}").contains(TOKEN), "Debug output must redact the token");
}

#[test]
fn an_account_name_that_could_act_as_a_flag_is_refused() {
    let gh = Gh::new("gh");
    for account in ["--hostname=evil.dev", "", "a b", "alwi;rm"] {
        assert!(matches!(gh.token_invocation(account), Err(GhRefusal::BadAccount(_))), "{account:?}");
    }
}

#[test]
fn a_github_pull_request_response_is_read_into_the_gate_facts() {
    use lotus_automation::github::{parse_pull_request, PrState};
    let body = serde_json::json!({
        "state": "closed", "merged": true, "draft": false,
        "user": { "login": "teammate" }, "head": { "sha": "abc123" },
        "title": "Fix", "body": null,
        "requested_reviewers": [{ "login": "alwisofwan1" }],
        "requested_teams": [{ "slug": "team-orbit" }]
    });

    let pr = parse_pull_request(&body.to_string(), "initech/orbit-app").unwrap();

    assert_eq!(pr.state, PrState::Merged, "closed + merged is merged");
    assert_eq!(pr.author, "teammate");
    assert_eq!(pr.head_sha, "abc123");
    assert_eq!(pr.body, "", "a null body reads as empty");
    assert_eq!(pr.requested_users, vec!["alwisofwan1"]);
    assert_eq!(pr.requested_teams, vec!["initech/team-orbit"], "teams are qualified by the repo's org");
}

#[test]
fn a_review_is_always_posted_as_a_comment_anchored_to_the_reviewed_commit() {
    use lotus_automation::github::{review_request_body, ReviewComment};
    let body = review_request_body(
        "sha1",
        "Two things to check.",
        &[ReviewComment { path: "src/app.ts".into(), line: 11, severity: None, body: "eval is RCE".into() }],
    );

    assert_eq!(
        body,
        serde_json::json!({
            "commit_id": "sha1",
            "body": "Two things to check.",
            "event": "COMMENT",
            "comments": [{ "path": "src/app.ts", "line": 11, "side": "RIGHT", "body": "eval is RCE" }]
        })
    );
}

#[test]
fn the_logged_in_gh_accounts_are_read_from_hosts_yml_without_any_token() {
    use lotus_automation::github::{parse_gh_hosts, GhAccount};
    let hosts = "\
github.com:
    git_protocol: ssh
    users:
        alwisofwan1:
        masjidubk13:
            oauth_token: gho_SHOULD_NEVER_BE_READ
            nested:
                deeper: value
    user: alwisofwan1
ghe.example.com:
    users:
        someone:
    user: someone
";
    assert_eq!(
        parse_gh_hosts(hosts),
        vec![
            GhAccount { login: "alwisofwan1".into(), active: true },
            GhAccount { login: "masjidubk13".into(), active: false },
        ],
        "github.com accounts only, active one marked"
    );
    assert_eq!(parse_gh_hosts(""), vec![]);
}

#[test]
fn a_review_request_search_is_read_into_pr_summaries() {
    use lotus_automation::github::parse_search_prs;
    let body = serde_json::json!({ "items": [{
        "number": 7, "title": "Fix login", "html_url": "https://github.com/acme/acme-web/pull/7",
        "user": { "login": "teammate" }, "updated_at": "2026-09-24T01:00:00Z",
        "repository_url": "https://api.github.com/repos/acme/acme-web"
    }]});
    let prs = parse_search_prs(&body.to_string()).unwrap();
    assert_eq!(prs.len(), 1);
    assert_eq!((prs[0].repo.as_str(), prs[0].number, prs[0].author.as_str()), ("acme/acme-web", 7, "teammate"));
}

#[test]
fn the_threads_of_our_review_are_read_with_their_replies_oldest_first() {
    use lotus_automation::github::parse_review_threads;
    // Shaped like GET /repos/acme/acme-web/pulls/2511/comments on 2026-09-28.
    let body = r#"[
      {"id": 10, "pull_request_review_id": 1, "in_reply_to_id": null, "path": "a.tsx", "line": null, "original_line": 824, "user": {"login": "someone-else"}, "body": "Not ours"},
      {"id": 20, "pull_request_review_id": 7, "in_reply_to_id": null, "path": "b.tsx", "line": null, "original_line": 1394, "user": {"login": "alwisofwan1"}, "body": "**[should-fix]** Name overflows."},
      {"id": 21, "pull_request_review_id": 7, "in_reply_to_id": null, "path": "c.tsx", "line": 238, "original_line": 238, "user": {"login": "alwisofwan1"}, "body": "**[should-fix]** Hard-coded 960px."},
      {"id": 31, "pull_request_review_id": 8, "in_reply_to_id": 20, "path": "b.tsx", "line": null, "original_line": 1394, "user": {"login": "doni255"}, "body": "Good catch, fixed in 927ad011."},
      {"id": 30, "pull_request_review_id": 9, "in_reply_to_id": 10, "path": "a.tsx", "line": null, "original_line": 824, "user": {"login": "doni255"}, "body": "reply to someone else"},
      {"id": 32, "pull_request_review_id": 9, "in_reply_to_id": 20, "path": "b.tsx", "line": null, "original_line": 1394, "user": {"login": "orange-devbox[bot]"}, "body": "Confirmed."}
    ]"#;
    let threads = parse_review_threads(body, 7).unwrap();
    assert_eq!(threads.len(), 2);
    assert_eq!((threads[0].comment_id, threads[0].path.as_str(), threads[0].line), (20, "b.tsx", 1394));
    let replies: Vec<(&str, &str)> = threads[0].replies.iter().map(|r| (r.author.as_str(), r.body.as_str())).collect();
    assert_eq!(replies, [("doni255", "Good catch, fixed in 927ad011."), ("orange-devbox[bot]", "Confirmed.")]);
    assert_eq!((threads[1].comment_id, threads[1].line, threads[1].replies.len()), (21, 238, 0));
    assert!(parse_review_threads("not json", 7).is_err());
}

#[test]
fn a_review_id_is_read_from_its_url() {
    use lotus_automation::github::review_id_from_url;
    assert_eq!(review_id_from_url("https://github.com/acme/acme-web/pull/2511#pullrequestreview-5334221515"), Some(5334221515));
    assert_eq!(review_id_from_url("https://github.com/x/y/pull/1"), None);
}

// LOT2-109: `gh auth logout --user X`, while X is not the active account, takes X out of gh's
// hosts.yml but leaves X's token in the keyring (gh v2.87.3, internal/config/config.go Logout), and
// `gh auth token --user X` still returns it. Lotus reads gh's account list so a logout is honoured.

const HOSTS: &str = "\
github.com:
    git_protocol: ssh
    users:
        alwisofwan1:
        masjidubk13:
            oauth_token: gho_kept_in_file
    user: alwisofwan1
ghe.example.com:
    users:
        someone:
    user: someone
";

#[test]
fn gh_accounts_are_read_from_the_github_com_section_only() {
    use lotus_automation::github::gh_hosts_accounts;
    assert_eq!(gh_hosts_accounts(HOSTS), Some(vec!["alwisofwan1".to_string(), "masjidubk13".to_string()]));
}

#[test]
fn an_account_list_that_cannot_be_read_is_unknown_not_empty() {
    use lotus_automation::github::gh_hosts_accounts;
    // Before gh 2.40 there was no `users:` map: say nothing rather than lock every account out.
    assert_eq!(gh_hosts_accounts("github.com:\n    user: alwi\n    oauth_token: x\n"), None);
    assert_eq!(gh_hosts_accounts("github.com: [not, a, map]\n"), None);
}

#[test]
fn no_github_com_section_means_no_account_is_logged_in() {
    use lotus_automation::github::gh_hosts_accounts;
    // gh removes the whole host when its last account logs out.
    assert_eq!(gh_hosts_accounts(""), Some(vec![]));
    assert_eq!(gh_hosts_accounts("ghe.example.com:\n    users:\n        someone:\n"), Some(vec![]));
    assert_eq!(gh_hosts_accounts("github.com:\n    users: {}\n    git_protocol: ssh\n"), Some(vec![]));
}

#[test]
fn gh_config_dir_follows_gh_precedence_in_the_environment_gh_runs_in() {
    use lotus_automation::github::gh_config_dir;
    use std::path::PathBuf;
    let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
    let all = env(&[("GH_CONFIG_DIR", "/c"), ("XDG_CONFIG_HOME", "/x"), ("APPDATA", "/a"), ("HOME", "/h")]);
    assert_eq!(gh_config_dir(&all, false), Some(PathBuf::from("/c")));
    assert_eq!(gh_config_dir(&all[1..], false), Some(PathBuf::from("/x/gh")));
    assert_eq!(gh_config_dir(&all[2..], true), Some(PathBuf::from("/a/GitHub CLI")));
    assert_eq!(gh_config_dir(&all[2..], false), Some(PathBuf::from("/h/.config/gh")));
    assert_eq!(gh_config_dir(&env(&[("GH_CONFIG_DIR", ""), ("HOME", "/h")]), false), Some(PathBuf::from("/h/.config/gh")));
    assert_eq!(gh_config_dir(&[], false), None);
}

#[test]
fn an_account_gh_logged_out_is_known_as_logged_out() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("hosts.yml"), HOSTS.replace("        masjidubk13:\n            oauth_token: gho_kept_in_file\n", "")).unwrap();
    let gh = Gh::new("gh").with_base_env([("GH_CONFIG_DIR".to_string(), dir.path().display().to_string())]);
    assert!(gh.is_logged_out("masjidubk13"));
    assert!(!gh.is_logged_out("alwisofwan1"));
}

#[test]
fn without_a_readable_hosts_file_no_account_is_called_logged_out() {
    let dir = tempfile::tempdir().unwrap();
    let gh = Gh::new("gh").with_base_env([("GH_CONFIG_DIR".to_string(), dir.path().display().to_string())]);
    assert!(!gh.is_logged_out("alwisofwan1"), "no file: leave it to gh");
    assert!(!Gh::new("gh").is_logged_out("alwisofwan1"), "no environment: leave it to gh");
}
