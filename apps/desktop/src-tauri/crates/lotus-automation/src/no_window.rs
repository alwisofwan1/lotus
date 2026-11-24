//! Windows: Lotus is a GUI-subsystem app with no console, so every console child (bun, git,
//! node, claude…) spawned without `CREATE_NO_WINDOW` gets a fresh console window of its own —
//! the window that kept popping up in Chat mode. Every `Command::new` goes through `.no_window()`.

pub trait NoWindow {
    /// No-op off Windows.
    fn no_window(self) -> Self;
}

impl NoWindow for std::process::Command {
    #[allow(unused_mut)]
    fn no_window(mut self) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    #[allow(unused_mut)]
    fn no_window(mut self) -> Self {
        #[cfg(windows)]
        self.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        self
    }
}
