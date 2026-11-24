//! The Slack text a scheduled prompt's result posts as (slack::outgoing).

use lotus_automation::slack::{outgoing, trusted_targets};

#[test]
fn only_mentions_written_in_the_instructions_stay_live() {
    let trusted = "Start with <@U0OWNERUSR1> -san and tag <!subteam^S09D7F05NQG|team>.";
    assert_eq!(trusted_targets(trusted), vec!["@U0OWNERUSR1".to_string(), "!subteam^S09D7F05NQG".to_string()]);
    let text = "<@U0OWNERUSR1> -san <@U0OWNERUSR1|Daffa> <!subteam^S09D7F05NQG> <@U0BOSS> <!channel> <#C0SECRET>";
    assert_eq!(
        outgoing(text, trusted),
        "<@U0OWNERUSR1> -san <@U0OWNERUSR1> <!subteam^S09D7F05NQG> &lt;@U0BOSS&gt; &lt;!channel&gt; &lt;#C0SECRET&gt;"
    );
}

#[test]
fn nothing_is_live_without_instructions_and_a_link_always_shows_where_it_goes() {
    assert_eq!(
        outgoing("see <https://evil.example|the fix> and <https://github.com/o/r/pull/1> & [PR](https://x.dev/1)", ""),
        "see the fix (https://evil.example) and https://github.com/o/r/pull/1 &amp; PR (https://x.dev/1)"
    );
    assert_eq!(outgoing("a < b > c, <not a token", ""), "a &lt; b &gt; c, &lt;not a token");
}

#[test]
fn github_markdown_becomes_slack_mrkdwn() {
    let text = "## Daily Report\n**Ticket:** TKT-1\n- first\n  * nested\n+ third\n~~old~~ plain *already bold*";
    assert_eq!(outgoing(text, ""), "*Daily Report*\n*Ticket:* TKT-1\n• first\n  • nested\n• third\n~old~ plain *already bold*");
}

#[test]
fn code_is_kept_as_written_only_escaped() {
    let text = "run `a **b** <@U0X>` now\n```\n# not a heading\n- not a list <!here>\n```\n# heading";
    assert_eq!(
        outgoing(text, "<@U0X>"),
        "run `a **b** &lt;@U0X&gt;` now\n```\n# not a heading\n- not a list &lt;!here&gt;\n```\n*heading*"
    );
}

#[test]
fn lettered_sections_and_slack_bullets_are_left_alone() {
    let text = "a. TKT-1017 — hotfix (~4.5h)\n• Root cause: `skip=30`.\nThank you! :pray:";
    assert_eq!(outgoing(text, ""), text);
}

#[test]
fn a_quote_keeps_its_marker_but_nothing_inside_is_live() {
    assert_eq!(outgoing("> quoted <!here>\n>not a quote", ""), "> quoted &lt;!here&gt;\n&gt;not a quote");
}
