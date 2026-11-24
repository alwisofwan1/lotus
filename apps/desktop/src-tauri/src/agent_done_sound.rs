//! Plays the Agent-Done Alert sound natively (`afplay`), outside the webview.
//!
//! Why not the webview's `<audio>`: on 2026-11-15 two freezes started the moment a seek+play on that
//! element ran. WebContent blocked on the WebKit GPU process (`seekToTarget` was its last log line),
//! WebKit killed the GPU process as unresponsive, and WebKit's mouse-event queue never recovered, so
//! no click landed until the app was quit. Native playback keeps the media pipeline out of WebKit.

/// Ids match `AGENT_DONE_SOUNDS` in `src/modules/voice-core/agent-done-chime.ts` (a test checks).
const SOUNDS: &[(&str, &[u8])] = &[
    ("classic", include_bytes!("../../public/sounds/agent-done.wav")),
    ("chime", include_bytes!("../../public/sounds/agent-done-chime.wav")),
    ("rise", include_bytes!("../../public/sounds/agent-done-rise.wav")),
    ("hollow", include_bytes!("../../public/sounds/agent-done-hollow.wav")),
    ("droplet", include_bytes!("../../public/sounds/agent-done-droplet.wav")),
    ("pickup", include_bytes!("../../public/sounds/agent-done-pickup.wav")),
    ("notify1", include_bytes!("../../public/sounds/agent-done-notify1.wav")),
    ("notify2", include_bytes!("../../public/sounds/agent-done-notify2.wav")),
];

fn sound(id: &str) -> Result<&'static [u8], String> {
    SOUNDS
        .iter()
        .find(|(k, _)| *k == id)
        .map(|(_, b)| *b)
        .ok_or_else(|| format!("unknown agent-done sound: {id}"))
}

/// Starts playback and returns at once; an error tells the renderer to fall back to `<audio>`.
pub fn play(id: &str) -> Result<(), String> {
    let bytes = sound(id)?;
    #[cfg(target_os = "macos")]
    {
        let path = std::env::temp_dir().join(format!("lotus-agent-done-{id}.wav"));
        // Rewrite when missing or from another build (content compare: ~100 KB, once per chime).
        if std::fs::read(&path).ok().as_deref() != Some(bytes) {
            std::fs::write(&path, bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
        }
        let mut child = std::process::Command::new("/usr/bin/afplay")
            .args(["-v", "0.6"])
            .arg(&path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("afplay: {e}"))?;
        // Reap it so a chime never leaves a zombie behind.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = bytes;
        Err("native agent-done sound is macOS-only".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_match_the_renderer_list() {
        let ts = include_str!("../../src/modules/voice-core/agent-done-chime.ts");
        let ts_ids: Vec<&str> = ts
            .split("{ id: \"")
            .skip(1)
            .map(|rest| rest.split('"').next().unwrap())
            .collect();
        let rust_ids: Vec<&str> = SOUNDS.iter().map(|(k, _)| *k).collect();
        assert_eq!(ts_ids, rust_ids);
    }

    #[test]
    fn unknown_id_is_an_error() {
        assert!(play("nope").is_err());
    }
}
