//! How a wrapped permission prompt is put back together.
//!
//! Mirror of `packages/host/src/adapters/mobile/permission/wrapping.ts`, and the reasoning lives
//! there in full. The short of it: Claude's TUI draws rows, so a label too long for the pane
//! arrives as two physical lines with the separator between them gone — `tmux capture-pane -J`
//! refuses to join them, because they are hard rows and not soft wraps.
//!
//! Rejoining therefore has to decide whether a space was eaten, and that cannot come from the
//! text. It comes from the pane width, and only when two independent signals agree (ADR-8's rule
//! one level down): the upper row is filled to the edge, AND the token straddling the break is
//! too long to have fitted on a row of its own. Measured on `devbox-vps` 2026-09-06 at two pane
//! widths across two tools; both hold for the wrapped question and neither for any wrapped label.
//!
//! Without a known width the first signal is missing, so every join keeps its space.

/// Columns of slack allowed when asking "was this row filled to the edge?".
const EDGE_SLACK: usize = 1;

/// How far under the pane width a straddling token still counts as "could have fitted".
const FIT_SLACK: usize = 4;

/// The separator a break consumed: a space, or nothing when it cut a token in half. Takes the
/// raw rows, indentation included, because the edge test is about where the row ended on screen.
pub fn wrap_separator(upper: &str, lower: &str, columns: Option<usize>) -> &'static str {
    if broke_mid_token(upper, lower, columns) {
        ""
    } else {
        " "
    }
}

fn broke_mid_token(upper: &str, lower: &str, columns: Option<usize>) -> bool {
    let Some(columns) = columns else { return false };
    if !filled_to_edge(upper, Some(columns)) {
        return false;
    }
    let straddling = last_token(upper).chars().count() + first_token(lower).chars().count();
    straddling > columns.saturating_sub(FIT_SLACK)
}

/// Filled to the edge — the shape a hard break leaves behind.
pub fn filled_to_edge(line: &str, columns: Option<usize>) -> bool {
    match columns {
        Some(columns) => line.chars().count() >= columns.saturating_sub(EDGE_SLACK),
        None => false,
    }
}

/// Leading spaces, the only thing separating a continuation row from ordinary output.
pub fn indent_of(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ').count()
}

fn last_token(line: &str) -> &str {
    line.trim_end().rsplit(' ').next().unwrap_or("")
}

fn first_token(line: &str) -> &str {
    line.trim_start().split(' ').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_space_a_word_wrap_consumed() {
        // Measured at 60 columns: the row stopped 4 short of the edge.
        let upper = "   2. Yes, and switch to accept edits (auto-approve file";
        assert_eq!(wrap_separator(upper, "      edits and common", Some(60)), " ");
    }

    #[test]
    fn drops_the_space_a_hard_break_never_had() {
        let upper = " Do you want to create sangat-panjang-untuk-menguji-pembung";
        assert_eq!(wrap_separator(upper, " kusan-baris-pertanyaan.txt?", Some(60)), "");
    }

    /// One signal alone is a guess: a row at the edge whose straddling token would have fitted
    /// on a line of its own was word-wrapped.
    #[test]
    fn needs_both_signals_to_drop_a_space() {
        let upper = format!("{} a", "x".repeat(56));
        assert_eq!(wrap_separator(&upper, "short", Some(60)), " ");
    }

    #[test]
    fn keeps_every_space_when_the_width_is_unknown() {
        let upper = " Do you want to create sangat-panjang-untuk-menguji-pembung";
        assert_eq!(wrap_separator(upper, " kusan-baris-pertanyaan.txt?", None), " ");
    }

    #[test]
    fn indent_counts_only_leading_spaces() {
        assert_eq!(indent_of("      commands) for this"), 6);
        assert_eq!(indent_of("   2. Yes"), 3);
        assert_eq!(indent_of(""), 0);
    }
}
