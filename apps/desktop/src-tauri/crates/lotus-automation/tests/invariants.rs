//! ADR-0038: the engine must stay free of Tauri so it can run as a daemon.

use std::path::Path;

fn rust_sources(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_engine_crate_never_depends_on_tauri() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let manifest = std::fs::read_to_string(root.join("Cargo.toml")).unwrap();
    let deps: Vec<&str> = manifest
        .lines()
        .filter(|l| l.trim_start().starts_with("tauri"))
        .collect();
    assert!(deps.is_empty(), "Cargo.toml declares tauri: {deps:?}");

    let mut sources = Vec::new();
    rust_sources(&root.join("src"), &mut sources);
    for file in sources {
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(!text.contains("tauri::"), "{} uses tauri", file.display());
    }
}
