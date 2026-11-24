//! Reads the options a Claude permission prompt is currently offering.
//!
//! **The hazard this exists to remove.** Answering a prompt means writing a digit
//! to the PTY (ADR-8). The digits differ per tool, so hard-coding "Deny is 3"
//! is a guess whose failure mode is the worst available: a wrong digit
//! **approves the thing the operator meant to refuse.**
//!
//! So nothing here is invented. The options are read from the terminal, labels
//! included, and the caller renders them verbatim — the operator sees the exact
//! words Claude offered, and the digit sent is the digit printed beside them. Our
//! own vocabulary never enters the decision. (The mockups had a "No, and tell
//! Claude what to do differently" button; the captured prompt in `PLAN.md` just
//! says "No". That is precisely the kind of invention this avoids.)
//!
//! And it **fails closed**: anything unexpected yields `None`, which the UI shows
//! as no buttons at all, sending the operator to the raw terminal. A missing
//! button costs one tap; a wrong one costs a deleted file.

use serde::{Deserialize, Serialize};

use crate::permission_prompt_wrap::{filled_to_edge, indent_of, wrap_separator};

/// Fewest options a real prompt offers. One numbered line is far more likely to
/// be ordinary output (`1. install deps`) than a prompt.
const MIN_OPTIONS: usize = 2;

/// Most options to accept. Real prompts offer three; a long numbered list is
/// something else being misread.
const MAX_OPTIONS: usize = 6;

/// Longest label kept, so a mangled line cannot become a giant button.
const MAX_LABEL: usize = 120;

/// Physical rows a single label may span. Two is what claude's longest option needs at 60
/// columns; three leaves room without letting a run eat the output above it.
const MAX_CONTINUATION_LINES: usize = 3;

/// Physical rows the question may span, for the same reason.
const MAX_QUESTION_LINES: usize = 3;

/// Longest label once its wrapped pieces are back together. Larger than [`MAX_LABEL`], which
/// guards a single mangled ROW: the longest real label measured is 111 characters and arrives in
/// two or three rows, so the per-row cap cannot also serve as the per-label one.
const MAX_JOINED_LABEL: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptOption {
    /// The digit to write, exactly as printed. Not derived from the position.
    pub key: String,
    /// The option's own words, verbatim. The UI must not paraphrase these.
    pub label: String,
    /// Whether the prompt's cursor (`❯`) currently rests on this option.
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPrompt {
    /// The question line, verbatim.
    pub question: String,
    pub options: Vec<PromptOption>,
}

/// Parses the trailing permission prompt out of a PTY tail, or `None`.
///
/// `None` is the safe answer and covers every uncertainty: no question line, a
/// numbered run that does not start at 1, gaps in the numbering, too few or too
/// many options, or a prompt that scrolled away.
/// Lines of the screen kept for a prompt whose options could not be named. Enough for a boxed
/// question with per-option descriptions, and no more.
const TAIL_MAX_LINES: usize = 40;

/// And a hard cap in characters, because a line can be as wide as the pane.
const TAIL_MAX_CHARS: usize = 4_000;

/// What the terminal drew, for a prompt [`parse_permission_prompt`] could not read.
///
/// **Reading is safe; answering is not.** The digits still come from a successful parse alone
/// (ADR-8), so nothing here can make a wrong button appear — the worst it can do is show the
/// operator a few lines of their own terminal. What it replaces is a card that said the options
/// could not be read and nothing else, which is honest and useless: the question was on the
/// screen the whole time.
///
/// Measured 2026-09-08: the parser needs the question on the line directly above the options, so
/// a blank line or a box border defeats it. That is every `AskUserQuestion` and most gated tools
/// on a modern CLI.
///
/// ANSI is stripped, which is safe **here** because this is a rendered screen rather than a
/// stream: the emulator has already placed every character in its column, so removing the colour
/// leaves the layout standing. The same operation on a raw `pipe-pane` log destroys it
/// (`issues/18`).
pub fn prompt_tail(screen: &str) -> Option<String> {
    let plain = strip_ansi(screen);
    let mut lines: Vec<&str> = plain.lines().map(|line| line.trim_end()).collect();
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if lines.is_empty() {
        return None;
    }
    let from = lines.len().saturating_sub(TAIL_MAX_LINES);
    let kept = lines[from..].join("\n");
    let tail = if kept.chars().count() > TAIL_MAX_CHARS {
        kept.chars()
            .skip(kept.chars().count() - TAIL_MAX_CHARS)
            .collect::<String>()
    } else {
        kept
    };
    if tail.trim().is_empty() {
        None
    } else {
        Some(tail)
    }
}

pub fn parse_permission_prompt(tail: &str, columns: Option<usize>) -> Option<PermissionPrompt> {
    let plain = strip_ansi(tail);
    let lines: Vec<&str> = plain.lines().collect();

    // Search from the end: a long tail can hold several past prompts, and only
    // the last one is the one being asked now.
    let end = lines.iter().rposition(|l| parse_option_line(l).is_some())?;

    let (options, start) = read_option_run(&lines, end, columns)?;

    if options.len() < MIN_OPTIONS || options.len() > MAX_OPTIONS {
        return None;
    }
    // Numbering must be 1..=n with no gaps. A run like `2. b` / `3. c` means the
    // first option scrolled off, and sending a digit against a partial list is
    // exactly the mistake this module exists to prevent.
    for (index, option) in options.iter().enumerate() {
        if option.key != (index + 1).to_string() {
            return None;
        }
    }

    let question = read_question(&lines, start, columns)?;

    Some(PermissionPrompt { question, options })
}

/// An option row plus the wrapped remainder of its label, still in physical rows.
struct RunEntry<'a> {
    option: PromptOption,
    /// The numbered row itself, raw, because the wrap test measures where it ended on screen.
    raw_first: &'a str,
    /// Rows of the label below the numbered one, top to bottom.
    continuation: Vec<&'a str>,
}

/// Walks the option run upward from its last row, folding wrapped label rows into the option
/// they belong to. Returns the finished options and the index of the row above the run.
///
/// Direction matters: a continuation row is read **before** the option that owns it, so it is
/// held back and only accepted once that option turns up directly above it, indented to exactly
/// its label column. A row that never finds its option is not a label — it is output.
fn read_option_run<'a>(
    lines: &[&'a str],
    end: usize,
    columns: Option<usize>,
) -> Option<(Vec<PromptOption>, isize)> {
    let mut entries: Vec<RunEntry<'a>> = Vec::new();
    let mut held: Vec<&'a str> = Vec::new();
    let mut lowest_option_indent = usize::MAX;
    let mut last_option = end as isize;
    let mut i = end as isize;

    while i >= 0 {
        let raw = lines[i as usize];
        if let Some((option, label_column)) = parse_option_line_at(raw) {
            // Every held row must sit at this option's label column. One that does not means the
            // rows between belong to something else, so the run stops rather than guessing.
            if held.iter().any(|row| indent_of(row) != label_column) {
                break;
            }
            held.reverse();
            entries.push(RunEntry {
                option,
                raw_first: raw,
                continuation: std::mem::take(&mut held),
            });
            last_option = i;
            lowest_option_indent = lowest_option_indent.min(indent_of(raw));
            i -= 1;
            continue;
        }
        // Only a row indented deeper than the options themselves can be a wrapped label. The
        // question sits at or left of them, which is what stops the walk.
        if held.len() >= MAX_CONTINUATION_LINES
            || raw.trim().is_empty()
            || indent_of(raw) <= lowest_option_indent
        {
            break;
        }
        held.push(raw);
        i -= 1;
    }

    // Rows held with no option above them were never label rows. Rather than reject outright,
    // the run rewinds to the last option it did read — a prompt drawn inside a box has its
    // question indented too, and the checks above still have to pass for anything to come of it.
    if !held.is_empty() {
        i = last_option - 1;
    }
    if entries.is_empty() {
        return None;
    }
    entries.reverse();

    let mut options = Vec::with_capacity(entries.len());
    for entry in &entries {
        options.push(join_label(entry, columns)?);
    }
    Some((options, i))
}

/// Puts a wrapped label back together, or `None` when the result is too long to trust.
fn join_label(entry: &RunEntry<'_>, columns: Option<usize>) -> Option<PromptOption> {
    let mut label = entry.option.label.clone();
    let mut previous = entry.raw_first;
    for row in &entry.continuation {
        label.push_str(wrap_separator(previous, row, columns));
        label.push_str(row.trim());
        previous = row;
    }
    if label.chars().count() > MAX_JOINED_LABEL {
        return None;
    }
    Some(PromptOption {
        label,
        ..entry.option.clone()
    })
}

/// Reads the question above the run, folding its own wrapped rows in.
///
/// A question row wraps mid-token when it carries a long filename, so the row above is only
/// taken when it was **filled to the edge** — the shape a hard break leaves. Without a known
/// pane width that signal is unavailable, and the question stays the single row it always was.
fn read_question(lines: &[&str], start: isize, columns: Option<usize>) -> Option<String> {
    if start < 0 {
        return None; // the run reached row 0, so there is no question above it
    }
    let first = *lines.get(start as usize)?;
    if parse_option_line(first).is_some() {
        return None;
    }

    let mut rows: Vec<&str> = vec![first];
    let indent = indent_of(first);
    let mut i = start - 1;
    while i >= 0 && rows.len() < MAX_QUESTION_LINES {
        let above = lines[i as usize];
        if !filled_to_edge(above, columns) || indent_of(above) != indent {
            break;
        }
        if above.trim().is_empty() || parse_option_line(above).is_some() {
            break;
        }
        rows.insert(0, above);
        i -= 1;
    }

    let mut question = rows[0].trim().to_string();
    for pair in rows.windows(2) {
        question.push_str(wrap_separator(pair[0], pair[1], columns));
        question.push_str(pair[1].trim());
    }
    if question.ends_with('?') {
        Some(question)
    } else {
        None
    }
}

/// `❯ 1. Yes` / `  2. Yes, allow all edits during this session (shift+tab)`
fn parse_option_line(line: &str) -> Option<PromptOption> {
    parse_option_line_at(line).map(|(option, _)| option)
}

/// The same, plus the column the label starts at on screen. Wrapped rows line up with it
/// exactly, which is the only thing separating them from ordinary output.
fn parse_option_line_at(line: &str) -> Option<(PromptOption, usize)> {
    let trimmed = line.trim();
    let (selected, rest) = match trimmed.strip_prefix('❯') {
        Some(rest) => (true, rest.trim_start()),
        None => (false, trimmed),
    };

    let (digits, after) = rest.split_once('.')?;
    let key = digits.trim();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_digit()) || key.len() > 2 {
        return None;
    }

    let label = after.trim();
    if label.is_empty() || label.len() > MAX_LABEL {
        return None;
    }

    let marker = trimmed.chars().count() - rest.chars().count();
    let gap = after.chars().count() - after.trim_start().chars().count();
    let label_column =
        indent_of(line) + marker + digits.chars().count() + 1 + gap;

    Some((
        PromptOption {
            key: key.to_string(),
            label: label.to_string(),
            selected,
        },
        label_column,
    ))
}

/// Builds a sentence an operator can act on without looking at the screen.
///
/// **Nothing is paraphrased, for the same reason the buttons are not** (§7 no. 8):
/// what you hear has to be what you would be approving. The question and every
/// option keep their own words; the digits come along so the answer can be spoken
/// or tapped.
///
/// One transformation only: parenthesised keyboard hints like `(shift+tab)` are
/// dropped. They are noise read aloud and they do not change what the option
/// means. Anything else stays.
pub fn spoken_readback(prompt: &PermissionPrompt) -> String {
    let mut out = String::from(&prompt.question);
    for option in &prompt.options {
        let label = strip_key_hints(&option.label);
        out.push_str(&format!(" Option {}: {}.", option.key, label));
    }
    out
}

/// Drops `(shift+tab)`-style hints. Only parentheses whose contents look like a
/// key chord: a parenthetical that is prose ("(this cannot be undone)") is part of
/// what the operator is agreeing to and must survive.
fn strip_key_hints(label: &str) -> String {
    let mut out = String::with_capacity(label.len());
    let mut rest = label;
    while let Some(open) = rest.find('(') {
        let Some(close_rel) = rest[open..].find(')') else {
            break;
        };
        let close = open + close_rel;
        let inner = &rest[open + 1..close];
        if looks_like_key_chord(inner) {
            out.push_str(&rest[..open]);
        } else {
            out.push_str(&rest[..=close]);
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out.trim().trim_end_matches(',').to_string()
}

/// `shift+tab`, `esc`, `ctrl-c`: short, no spaces around words, chord-shaped.
fn looks_like_key_chord(inner: &str) -> bool {
    let inner = inner.trim();
    if inner.is_empty() || inner.len() > 20 || inner.contains(' ') {
        return false;
    }
    const KEYS: &[&str] = &[
        "shift", "ctrl", "cmd", "alt", "opt", "tab", "esc", "enter", "return", "space",
    ];
    inner
        .split(['+', '-'])
        .all(|part| KEYS.contains(&part.trim().to_ascii_lowercase().as_str()))
}

/// Removes CSI/OSC escape sequences so a coloured prompt parses like a plain one.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.next() {
            // CSI — runs until a byte in @..~
            Some('[') => {
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // OSC — runs until BEL or ESC \
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **A card with no options must still carry the words.**
    ///
    /// The parser fails closed and is right to — a digit read off a half-understood screen
    /// approves the thing the operator meant to refuse (ADR-8). But failing closed was answered
    /// on the phone with one sentence saying so, and the question the terminal *had* printed
    /// never crossed. Reported from a device on 2026-09-09 against an `AskUserQuestion`: six
    /// options on screen, nothing on the phone.
    ///
    /// Reading is the half of this that is safe. The digits still come from a successful parse
    /// alone, so this can put words on screen and never a button.
    #[test]
    fn the_tail_carries_a_prompt_the_parser_could_not_name() {
        let screen = "File jenis apa yang mau dibuat?\n\n  1. Konfigurasi (JSON)\n  2. Catatan Markdown\n";

        assert!(
            parse_permission_prompt(screen, Some(80)).is_none(),
            "a blank line above the options defeats the parser — that is the case this exists for"
        );
        let tail = prompt_tail(screen).expect("the screen is not empty");
        assert!(tail.contains("File jenis apa yang mau dibuat?"));
        assert!(tail.contains("1. Konfigurasi (JSON)"));
    }

    #[test]
    fn the_tail_is_bounded_and_drops_what_the_screen_left_blank() {
        let long: String = (0..200).map(|i| format!("line {i}\n")).collect();
        let tail = prompt_tail(&format!("{long}\n\n\n")).expect("not empty");

        assert!(tail.lines().count() <= 40, "kept {} lines", tail.lines().count());
        assert!(tail.ends_with("line 199"), "trailing blanks are not content");
        assert!(!tail.contains("line 100"), "only the tail is kept");
    }

    #[test]
    fn an_empty_screen_has_no_tail_to_show() {
        assert!(prompt_tail("   \n\n").is_none());
    }

    /// Verbatim from the ADR-8 spike capture in `plans/lotus-pocket/PLAN.md`. Real
    /// output, not a reconstruction — which is why option 3 is "No" and not the
    /// longer label the mockups invented.
    const CAPTURED: &str = "Create file approved.txt\n\
        ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\
        \x201  hi\n\
        ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌\n\
        Do you want to create approved.txt?\n\
        ❯ 1. Yes\n\
        \x20 2. Yes, allow all edits during this session (shift+tab)\n\
        \x20 3. No\n";

    #[test]
    fn parses_the_captured_prompt() {
        let prompt = parse_permission_prompt(CAPTURED, None).expect("should parse");

        assert_eq!(prompt.question, "Do you want to create approved.txt?");
        assert_eq!(prompt.options.len(), 3);
        assert_eq!(prompt.options[0].key, "1");
        assert_eq!(prompt.options[0].label, "Yes");
        assert!(
            prompt.options[0].selected,
            "the cursor rests on the first option"
        );
        assert_eq!(
            prompt.options[1].label,
            "Yes, allow all edits during this session (shift+tab)"
        );
        assert_eq!(prompt.options[2].label, "No");
        assert!(!prompt.options[2].selected);
    }

    /// The labels are the product here. Paraphrasing them is how an operator
    /// loses the ability to check what they are about to press.
    #[test]
    fn labels_are_verbatim_and_differ_per_tool() {
        let bash = "Do you want to run this command?\n\
            ❯ 1. Yes\n\
            \x20 2. Yes, allow all Bash during this session\n\
            \x20 3. No\n";

        let prompt = parse_permission_prompt(bash, None).unwrap();

        assert_eq!(
            prompt.options[1].label,
            "Yes, allow all Bash during this session"
        );
    }

    #[test]
    fn takes_the_last_prompt_when_the_tail_holds_several() {
        let tail = "Do you want to run the first thing?\n\
            ❯ 1. Yes\n\
            \x20 2. No\n\
            some output in between\n\
            Do you want to run the second thing?\n\
            \x20 1. Yes\n\
            ❯ 2. No\n";

        let prompt = parse_permission_prompt(tail, None).unwrap();

        assert_eq!(prompt.question, "Do you want to run the second thing?");
        assert!(prompt.options[1].selected, "cursor is on the newest prompt");
    }

    #[test]
    fn survives_ansi_colouring() {
        let coloured = "\x1b[33mDo you want to run this command?\x1b[0m\n\
            \x1b[1m❯ 1. Yes\x1b[0m\n\
            \x1b[2m  2. No\x1b[0m\n";

        let prompt = parse_permission_prompt(coloured, None).unwrap();

        assert_eq!(prompt.question, "Do you want to run this command?");
        assert_eq!(prompt.options[1].label, "No");
    }

    // ─── Spoken read-back ────────────────────────────────────────────────────

    #[test]
    fn readback_keeps_the_question_and_every_option_verbatim() {
        let prompt = parse_permission_prompt(CAPTURED, None).unwrap();

        let spoken = spoken_readback(&prompt);

        assert_eq!(
            spoken,
            "Do you want to create approved.txt? \
             Option 1: Yes. \
             Option 2: Yes, allow all edits during this session. \
             Option 3: No."
        );
    }

    /// A keyboard hint is noise read aloud and changes nothing about the choice.
    #[test]
    fn readback_drops_keyboard_hints() {
        let prompt = PermissionPrompt {
            question: "Do you want to?".into(),
            options: vec![
                PromptOption {
                    key: "1".into(),
                    label: "Yes (enter)".into(),
                    selected: true,
                },
                PromptOption {
                    key: "2".into(),
                    label: "No (esc)".into(),
                    selected: false,
                },
            ],
        };

        let spoken = spoken_readback(&prompt);

        assert!(!spoken.contains("enter"), "got {spoken}");
        assert!(!spoken.contains("esc"));
        assert!(spoken.contains("Option 1: Yes."));
    }

    /// The line where stripping too eagerly would be dangerous: a parenthetical
    /// that is prose is part of what the operator is agreeing to.
    #[test]
    fn readback_keeps_a_parenthetical_that_is_prose() {
        let prompt = PermissionPrompt {
            question: "Do you want to reset?".into(),
            options: vec![
                PromptOption {
                    key: "1".into(),
                    label: "Yes (this cannot be undone)".into(),
                    selected: true,
                },
                PromptOption {
                    key: "2".into(),
                    label: "No".into(),
                    selected: false,
                },
            ],
        };

        let spoken = spoken_readback(&prompt);

        assert!(spoken.contains("(this cannot be undone)"), "got {spoken}");
    }

    #[test]
    fn readback_names_the_digits_so_the_answer_can_be_spoken() {
        let prompt = parse_permission_prompt(CAPTURED, None).unwrap();

        let spoken = spoken_readback(&prompt);

        for key in ["Option 1", "Option 2", "Option 3"] {
            assert!(spoken.contains(key), "missing {key} in {spoken}");
        }
    }

    // ─── Failing closed ──────────────────────────────────────────────────────

    /// A partial list is the dangerous case: option 1 scrolled away, so "the
    /// first button" would send `2` and mean something else entirely.
    #[test]
    fn refuses_a_run_that_does_not_start_at_one() {
        let tail = "Do you want to run this command?\n  2. Yes\n  3. No\n";

        assert_eq!(parse_permission_prompt(tail, None), None);
    }

    #[test]
    fn refuses_a_run_with_a_gap() {
        let tail = "Do you want to run this command?\n  1. Yes\n  3. No\n";

        assert_eq!(parse_permission_prompt(tail, None), None);
    }

    /// Ordinary numbered output is far more common than prompts, and treating it
    /// as one would put buttons on a cell that is not asking anything.
    #[test]
    fn refuses_a_single_numbered_line() {
        let tail = "Installing deps?\n  1. lodash\n";

        assert_eq!(parse_permission_prompt(tail, None), None);
    }

    #[test]
    fn refuses_a_numbered_list_with_no_question_above_it() {
        let tail = "Here is the plan.\n  1. Yes\n  2. No\n";

        assert_eq!(parse_permission_prompt(tail, None), None);
    }

    #[test]
    fn refuses_a_long_numbered_list() {
        let mut tail = String::from("Which one?\n");
        for i in 1..=(MAX_OPTIONS + 1) {
            tail.push_str(&format!("  {i}. option\n"));
        }

        assert_eq!(parse_permission_prompt(&tail, None), None);
    }

    #[test]
    fn refuses_when_the_options_reach_the_top_with_no_room_for_a_question() {
        let tail = "  1. Yes\n  2. No\n";

        assert_eq!(parse_permission_prompt(tail, None), None);
    }

    #[test]
    fn refuses_an_empty_or_optionless_tail() {
        assert_eq!(parse_permission_prompt("", None), None);
        assert_eq!(parse_permission_prompt("just some output\n", None), None);
    }

    #[test]
    fn refuses_an_absurdly_long_label() {
        let tail = format!(
            "Do you want to?\n  1. Yes\n  2. {}\n",
            "x".repeat(MAX_LABEL + 1)
        );

        assert_eq!(parse_permission_prompt(&tail, None), None);
    }

    /// The digit comes from the print, never from the index, so a renumbered
    /// prompt cannot be silently misaddressed.
    #[test]
    fn keys_come_from_the_printed_digits() {
        let prompt = parse_permission_prompt(CAPTURED, None).unwrap();

        let keys: Vec<&str> = prompt.options.iter().map(|o| o.key.as_str()).collect();
        assert_eq!(keys, vec!["1", "2", "3"]);
    }

    #[test]
    fn serializes_camel_case_for_the_wire() {
        let prompt = parse_permission_prompt(CAPTURED, None).unwrap();

        let json = serde_json::to_value(&prompt).unwrap();

        assert_eq!(json["options"][0]["selected"], true);
        assert_eq!(json["options"][0]["key"], "1");
        assert!(json["question"].is_string());
    }
    // ---- wrapped rows (`issues/17`) -------------------------------------------------------
    //
    // Captures from `devbox-vps`, claude 2.1.263, taken with `tmux capture-pane -p` and stored
    // byte for byte — whole panes, not excerpts, so a rule that swallows the output above a
    // prompt fails here rather than in front of an operator. The same four files back the
    // TypeScript port's suite.

    const WRITE_80: &str = include_str!("permission_prompt_fixtures/write-prompt-80col.txt");
    const WRITE_60: &str = include_str!("permission_prompt_fixtures/write-prompt-60col.txt");
    const BASH_60: &str = include_str!("permission_prompt_fixtures/bash-prompt-60col.txt");
    const QUESTION_60: &str =
        include_str!("permission_prompt_fixtures/wrapped-question-60col.txt");

    /// The label the issue was opened for: two rows at 80 columns, three at 60.
    const ACCEPT_EDITS: &str = "Yes, and switch to accept edits (auto-approve file edits and \
common file commands) for this session (shift+tab)";

    #[test]
    fn rejoins_a_label_split_across_two_rows() {
        let prompt = parse_permission_prompt(WRITE_80, Some(80)).expect("should parse");

        assert_eq!(prompt.question, "Do you want to create wrap-probe.txt?");
        assert_eq!(prompt.options.len(), 3);
        assert_eq!(prompt.options[1].label, ACCEPT_EDITS);
        assert_eq!(prompt.options[2].label, "No");
        assert!(prompt.options[0].selected);
    }

    #[test]
    fn rejoins_a_label_split_across_three_rows() {
        let prompt = parse_permission_prompt(WRITE_60, Some(60)).expect("should parse");
        assert_eq!(prompt.options[1].label, ACCEPT_EDITS);
    }

    #[test]
    fn handles_four_options_with_two_wrapped_labels() {
        let prompt = parse_permission_prompt(BASH_60, Some(60)).expect("should parse");

        assert_eq!(prompt.question, "Do you want to proceed?");
        let labels: Vec<&str> = prompt.options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(
            labels,
            vec![
                "Yes",
                "Yes, and always allow access to /home/alwi/lotus-probe from this project",
                "Yes, and switch to auto mode · auto mode handles these prompts for you",
                "No",
            ]
        );
    }

    /// The question breaks mid-token, so joining it with a space would hand the operator a
    /// filename that does not exist — worse than no buttons at all.
    #[test]
    fn rejoins_a_question_broken_mid_token_without_inserting_a_space() {
        let prompt = parse_permission_prompt(QUESTION_60, Some(60)).expect("should parse");

        assert_eq!(
            prompt.question,
            "Do you want to create sangat-panjang-untuk-menguji-pembungkusan-baris-pertanyaan.txt?"
        );
        assert_eq!(prompt.options.len(), 3);
    }

    /// Without a pane width the "filled to the edge" signal is gone, and one signal alone is a
    /// guess. The parser keeps the row it can see rather than inventing the rest.
    #[test]
    fn does_not_reconstruct_a_wrapped_question_without_a_width() {
        let prompt = parse_permission_prompt(QUESTION_60, None).expect("should parse");
        assert_eq!(prompt.question, "kusan-baris-pertanyaan.txt?");
    }

    #[test]
    fn refuses_a_run_whose_continuation_has_no_option_above_it() {
        let tail = "Do you want to proceed?\n\
                    \x20     commands) for this session (shift+tab)\n\
                    \x20 3. No\n";
        assert_eq!(parse_permission_prompt(tail, Some(80)), None);
    }

    #[test]
    fn refuses_output_indented_off_the_label_column() {
        let tail = "Do you want to proceed?\n\
                    ❯ 1. Yes\n\
                    \x20 2. Yes, and switch to accept edits\n\
                    \x20   off-by-two, so not this label's row\n\
                    \x20 3. No\n";
        assert_eq!(parse_permission_prompt(tail, Some(80)), None);
    }

    #[test]
    fn refuses_a_label_that_grows_past_the_joined_cap() {
        let tail = format!(
            "Do you want to proceed?\n❯ 1. Yes\n  2. {}\n     {}\n  3. No\n",
            "a".repeat(110),
            "b".repeat(110)
        );
        assert_eq!(parse_permission_prompt(&tail, Some(80)), None);
    }

}
