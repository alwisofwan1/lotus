use lotus_automation::slack::{outgoing, rich_text_blocks};
use serde_json::{json, Value};

fn elements(wire: &str) -> Vec<Value> {
    let blocks = rich_text_blocks(wire).expect("blocks");
    assert_eq!(blocks.as_array().unwrap().len(), 1);
    assert_eq!(blocks[0]["type"], "rich_text");
    blocks[0]["elements"].as_array().unwrap().clone()
}

fn text(t: &str) -> Value {
    json!({ "type": "text", "text": t })
}

fn bold(t: &str) -> Value {
    json!({ "type": "text", "text": t, "style": { "bold": true } })
}

fn item(els: Vec<Value>) -> Value {
    json!({ "type": "rich_text_section", "elements": els })
}

#[test]
fn a_daily_report_becomes_sections_and_real_lists() {
    // The shape `/daily` writes, through the same conversion a Send uses.
    let raw = "<@U0OWNERUSR1> -san\n\n**Daily Report — 14 October, 2026**\n**Ticket:** TKT-1 (QA setup)\n**Detail:**\n\n\
               **a. TKT-1 — QA setup on t02 (~1.5h)**\n- The flag is ON for all orgs on t02.\n- Side finding: ai_call rows <@U0BOSS>\n\n\
               **b. Code review (~4h)**\n- Sam-san — back#3052, 3 rounds:\n  - The uninstall filter had no test.\n  - The back PR deploys first.\n  All fixed.\n\n\
               Thank you! :pray:";
    let wire = outgoing(raw, "start with <@U0OWNERUSR1> -san");
    let els = elements(&wire);

    let expected = json!([
        { "type": "rich_text_section", "elements": [
            { "type": "user", "user_id": "U0OWNERUSR1" },
            text(" -san\n\n"),
            bold("Daily Report — 14 October, 2026"), text("\n"),
            bold("Ticket:"), text(" TKT-1 (QA setup)\n"),
            bold("Detail:"), text("\n\n"),
            bold("a. TKT-1 — QA setup on t02 (~1.5h)"),
        ]},
        { "type": "rich_text_list", "style": "bullet", "elements": [
            item(vec![text("The flag is ON for all orgs on t02.")]),
            // An agent's ping is a literal text element: `outgoing` escaped it, so it never
            // becomes a user element, and Slack shows a text element as written.
            item(vec![text("Side finding: ai_call rows <@U0BOSS>")]),
        ]},
        { "type": "rich_text_section", "elements": [text("\n"), bold("b. Code review (~4h)")] },
        { "type": "rich_text_list", "style": "bullet", "elements": [
            item(vec![text("Sam-san — back#3052, 3 rounds:")]),
        ]},
        { "type": "rich_text_list", "style": "bullet", "indent": 1, "elements": [
            item(vec![text("The uninstall filter had no test.")]),
            item(vec![text("The back PR deploys first.")]),
        ]},
        { "type": "rich_text_section", "elements": [
            text("All fixed.\n\nThank you! "),
            { "type": "emoji", "name": "pray" },
        ]},
    ]);
    assert_eq!(Value::Array(els), expected);
}

#[test]
fn snake_case_math_and_times_are_not_styles_or_emoji() {
    let els = elements("call_history and human_call, 5 * 3 * 2, at 10:30:45 and 17:10");
    assert_eq!(els, vec![item(vec![text("call_history and human_call, 5 * 3 * 2, at 10:30:45 and 17:10")])]);
}

#[test]
fn styles_nest_and_code_is_literal() {
    let els = elements("*bold _both_* ~gone~ `a *b* &lt;c&gt;` _it_.");
    assert_eq!(
        els,
        vec![item(vec![
            bold("bold "),
            json!({ "type": "text", "text": "both", "style": { "bold": true, "italic": true } }),
            text(" "),
            json!({ "type": "text", "text": "gone", "style": { "strike": true } }),
            text(" "),
            json!({ "type": "text", "text": "a *b* <c>", "style": { "code": true } }),
            text(" "),
            json!({ "type": "text", "text": "it", "style": { "italic": true } }),
            text("."),
        ])]
    );
}

#[test]
fn links_lotus_made_stay_labelled_and_bare_urls_become_links() {
    // `<url|label>` in wire text is Lotus's own (a review link); an agent's was already rewritten.
    let els = elements("Changes needed on <https://github.com/o/r/pull/7|r#7>, see https://example.com/a_b.");
    assert_eq!(
        els,
        vec![item(vec![
            text("Changes needed on "),
            json!({ "type": "link", "url": "https://github.com/o/r/pull/7", "text": "r#7" }),
            text(", see "),
            json!({ "type": "link", "url": "https://example.com/a_b" }),
            text("."),
        ])]
    );
}

#[test]
fn an_agent_link_label_never_hides_where_it_goes() {
    let wire = outgoing("[click](https://evil.example) and <https://evil.example|safe>", "");
    let els = elements(&wire);
    let links: Vec<&Value> = els[0]["elements"].as_array().unwrap().iter().filter(|e| e["type"] == "link").collect();
    assert_eq!(links.len(), 2);
    assert!(links.iter().all(|l| l.get("text").is_none()), "{links:?}");
}

#[test]
fn mentions_and_broadcasts_come_only_from_trusted_markup() {
    let wire = outgoing("<!here> <@U0AB1> <#C0AB1|dev> <!subteam^S0AB1>", "ping <!here> and <@U0AB1> in <#C0AB1> to <!subteam^S0AB1>");
    let types: Vec<String> = elements(&wire)[0]["elements"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["type"] != "text")
        .map(|e| e["type"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(types, ["broadcast", "user", "channel", "usergroup"]);
    // Untrusted: all text.
    let wire = outgoing("<!here> <@U0AB1>", "");
    assert!(elements(&wire)[0]["elements"].as_array().unwrap().iter().all(|e| e["type"] == "text"));
}

#[test]
fn fences_and_quotes_keep_their_shape() {
    let els = elements("Look:\n```\nlet a = 1 &lt; 2;\n  b\n```\n> quoted *line*\n> second");
    assert_eq!(
        els,
        vec![
            item(vec![text("Look:")]),
            json!({ "type": "rich_text_preformatted", "elements": [text("let a = 1 < 2;\n  b")] }),
            json!({ "type": "rich_text_quote", "elements": [text("quoted "), bold("line"), text("\nsecond")] }),
        ]
    );
}

#[test]
fn blank_lines_split_lists_and_nothing_is_none() {
    let els = elements("• one\n\n• two");
    assert_eq!(els.len(), 2);
    assert!(rich_text_blocks("\n  \n").is_none());
}

#[test]
fn only_a_refusal_of_the_blocks_falls_back_to_text() {
    use lotus_automation::slack::web::refused_blocks;
    assert!(refused_blocks("Slack refused: invalid_blocks"));
    assert!(refused_blocks("Slack refused: msg_blocks_too_long"));
    assert!(!refused_blocks("Slack refused: channel_not_found"));
    assert!(!refused_blocks("Slack refused: not_in_channel"));
}

#[test]
fn untrusted_markup_only_ever_becomes_literal_text() {
    // Only user/broadcast/channel/usergroup elements ping; text elements are shown as written.
    let wire = outgoing("- ping <!here> <!channel> <@U0BOSS> <#C0AB1> R&D a < b\n```\n<!everyone>\n```\n`<!here>`", "");
    let blocks = rich_text_blocks(&wire).unwrap();
    let mut kinds = Vec::new();
    collect_kinds(&blocks, &mut kinds);
    for k in ["user", "broadcast", "channel", "usergroup"] {
        assert!(!kinds.iter().any(|t| t == k), "{k} made from untrusted text: {kinds:?}");
    }
    let shown = blocks.to_string();
    assert!(shown.contains("ping <!here> <!channel> <@U0BOSS> <#C0AB1> R&D a < b"), "{shown}");
}

fn collect_kinds(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => items.iter().for_each(|i| collect_kinds(i, out)),
        Value::Object(map) => {
            if let Some(t) = map.get("type").and_then(Value::as_str) {
                out.push(t.to_string());
            }
            map.values().for_each(|i| collect_kinds(i, out));
        }
        _ => {}
    }
}
