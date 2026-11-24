fn main() {
    check_host_executable_signature();
    tauri_build::build()
}

/// Refuse to embed a host executable that macOS will kill on exec.
///
/// `host_runtime/bundle.rs` `include_bytes!`s this file and writes it to
/// `~/.lotus/lotus-remote-bin`. A Mach-O whose signature does not match its
/// contents is SIGKILLed by the kernel before it runs (exit 137, no output), and
/// Mobile Access then shows "Not running" with nothing anywhere to say why —
/// which is how it shipped once (2026-10-04). `scripts/build-host-bundle.mjs`
/// signs it; this catches a binary produced any other way.
fn check_host_executable_signature() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") || !cfg!(target_os = "macos")
    {
        return;
    }
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let exe = std::path::Path::new(&manifest).join("../../../packages/host/dist/lotus-remote-bin");
    println!("cargo:rerun-if-changed={}", exe.display());
    // Missing is reported by `include_bytes!` with a clearer message than we could give.
    if !exe.exists() {
        return;
    }
    let output = match std::process::Command::new("codesign")
        .args(["--verify", "--strict"])
        .arg(&exe)
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            println!("cargo:warning=could not run codesign to check {}: {error}", exe.display());
            return;
        }
    };
    if !output.status.success() {
        panic!(
            "\n\n{} has an invalid code signature:\n  {}\nmacOS kills it on launch, so Mobile Access \
             could never start.\nRebuild it with `bun apps/desktop/scripts/build-host-bundle.mjs`, \
             which re-signs it.\n\n",
            exe.display(),
            String::from_utf8_lossy(&output.stderr).trim(),
        );
    }
}
