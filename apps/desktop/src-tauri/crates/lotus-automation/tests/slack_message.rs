use lotus_automation::pr_review::PrRef;
use lotus_automation::slack::read_message_text;

fn pr(repo: &str, number: u64) -> PrRef {
    PrRef { repo: repo.into(), number }
}

#[test]
fn every_pull_request_link_in_a_message_is_found_once_in_order() {
    let text = "<!subteam^S0TEAM|@team-orbit> please review:\n\
                • <https://github.com/acme/acme-web/pull/2498|acme-web#2498>\n\
                • <https://github.com/acme/acme-api/pull/77>\n\
                • <https://github.com/acme/acme-web/pull/2498/files> (same PR again)\n\
                docs: <https://notion.so/x|spec> and an issue <https://github.com/acme/acme-api/issues/5>";

    let read = read_message_text(text);

    assert_eq!(read.pull_requests, vec![pr("acme/acme-web", 2498), pr("acme/acme-api", 77)]);
}

#[test]
fn user_and_team_mentions_are_read_with_or_without_a_label() {
    let read = read_message_text("hi <@U0REVIEWER1> and <@U0SLACKUSR1|budi>, cc <!subteam^S0TEAM> <!subteam^S0OTHER|@qa>");

    assert_eq!(read.users, vec!["U0REVIEWER1", "U0SLACKUSR1"]);
    assert_eq!(read.teams, vec!["S0TEAM", "S0OTHER"]);
}

#[test]
fn escaped_text_and_bare_urls_are_understood() {
    // Slack escapes & < > inside text; a URL pasted without Slack's <> wrapping still counts.
    let read = read_message_text("fix &amp; ship https://github.com/acme/acme-infra/pull/9?w=1 &lt;3");
    assert_eq!(read.pull_requests, vec![pr("acme/acme-infra", 9)]);
}

#[test]
fn a_message_with_no_links_or_mentions_reads_as_empty() {
    let read = read_message_text("lunch?");
    assert!(read.pull_requests.is_empty() && read.users.is_empty() && read.teams.is_empty());
}
