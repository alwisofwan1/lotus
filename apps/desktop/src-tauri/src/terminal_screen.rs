//! The screen itself lives in `lotus_pty::screen`; what stays here is the proof that it renders a
//! real claude stream the way tmux did, which needs the app's permission-prompt parser.

use lotus_pty::screen::*;

#[cfg(test)]
mod tests {
    use super::*;

    /// The pair that decides whether this module is honest: the **raw stream** a real claude
    /// session wrote, and the screen **tmux rendered from that same stream**, taken from
    /// `devbox-vps` at the same instant (2026-09-06, claude 2.1.263, 80x24).
    ///
    /// Anything less is self-confirming — an emulator judged against its own output.
    const RAW: &[u8] = include_bytes!("permission_prompt_fixtures/live-stream-80x24.bin");
    const TMUX_SCREEN: &str =
        include_str!("permission_prompt_fixtures/live-stream-80x24.screen.txt");

    #[test]
    fn renders_what_tmux_rendered_from_the_same_bytes() {
        let mut screen = TerminalScreen::new(24, 80);
        screen.push_bytes(RAW);

        // The only normalisation is the fixture's own trailing newline — it is a FILE; the pane
        // never had one. Every row inside must match tmux exactly, padding included.
        let rendered = screen.contents();
        let ours: Vec<&str> = rendered.trim_end().lines().collect();
        let tmux: Vec<&str> = TMUX_SCREEN.trim_end().lines().collect();

        assert_eq!(ours, tmux);
    }

    /// The point of the exercise: the same stream that is unparseable raw yields the prompt once
    /// it has been drawn.
    #[test]
    fn the_rendered_screen_is_what_the_prompt_parser_needs() {
        let mut screen = TerminalScreen::new(24, 80);
        screen.push_bytes(RAW);

        let prompt = crate::permission_prompt::parse_permission_prompt(&screen.contents(), Some(80))
            .expect("a rendered screen parses");

        assert_eq!(prompt.question, "Do you want to create gate17.txt?");
        assert_eq!(
            prompt.options.iter().map(|o| o.label.as_str()).collect::<Vec<_>>(),
            vec![
                "Yes",
                "Yes, and switch to accept edits (auto-approve file edits and common file \
commands) for this session (shift+tab)",
                "No",
            ]
        );
    }

    /// The raw bytes are not merely harder to read — they carry no layout at all.
    #[test]
    fn the_same_bytes_are_unparseable_undrawn() {
        let raw = String::from_utf8_lossy(RAW);
        assert!(crate::permission_prompt::parse_permission_prompt(&raw, Some(80)).is_none());
    }
}
