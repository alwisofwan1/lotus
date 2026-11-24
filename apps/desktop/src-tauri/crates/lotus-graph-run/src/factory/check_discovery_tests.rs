use super::*;
fn write(root: &Path, file: &str, value: &str) {
    std::fs::create_dir_all(root.join(file).parent().unwrap()).unwrap();
    std::fs::write(root.join(file), value).unwrap();
}
#[test]
fn discovers_explicit_check_scripts_and_prefers_comprehensive_checks() {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        "package.json",
        r#"{"scripts":{"check":"tsc && secret-fixture","test":"vitest run","typecheck":"tsc"}}"#,
    );
    write(tmp.path(), "package-lock.json", "{}");
    let found = discover(tmp.path()).unwrap();
    assert_eq!(found[0].command, "npm run check");
    assert!(found
        .iter()
        .any(|s| s.command == "npm run test && npm run typecheck"));
    assert!(!serde_json::to_string(&found)
        .unwrap()
        .contains("secret-fixture"));
}
#[test]
fn does_not_recommend_development_or_watch_mode() {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        "package.json",
        r#"{"packageManager":"bun@1","scripts":{"test":"vitest --watch","typecheck":"tsc","dev":"next dev","build":"next build"}}"#,
    );
    let found = discover(tmp.path()).unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].command, "bun run typecheck");
}
#[test]
fn reads_make_and_cargo_metadata_without_running_anything() {
    let tmp = tempfile::tempdir().unwrap();
    write(tmp.path(), "Makefile", "check:\n\ttouch should-not-exist\n");
    assert_eq!(discover(tmp.path()).unwrap()[0].command, "make check");
    assert!(!tmp.path().join("should-not-exist").exists());
    std::fs::remove_file(tmp.path().join("Makefile")).unwrap();
    write(
        tmp.path(),
        "Cargo.toml",
        "[package]\nname = 'example'\nversion = '0.1.0'\n",
    );
    assert_eq!(discover(tmp.path()).unwrap()[0].command, "cargo test");
}
#[test]
fn finds_scoped_workspace_checks_when_root_has_only_dev_and_build() {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        "package.json",
        r#"{"scripts":{"dev":"next dev","build":"next build"}}"#,
    );
    write(tmp.path(), "package-lock.json", "{}");
    write(
        tmp.path(),
        "apps/web/package.json",
        r#"{"scripts":{"test":"vitest run","typecheck":"tsc"}}"#,
    );
    let found = discover(tmp.path()).unwrap();
    assert_eq!(
        found[0].command,
        "npm --prefix apps/web run test && npm --prefix apps/web run typecheck"
    );
    assert!(found[0].evidence.contains("apps/web/package.json"));
    assert!(found[0].evidence.contains("not the whole repository"));
}
#[test]
fn detects_laravel_checks_even_when_node_only_has_asset_build_scripts() {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        "package.json",
        r#"{"scripts":{"dev":"vite","build":"vite build"}}"#,
    );
    write(tmp.path(), "package-lock.json", "{}");
    write(
        tmp.path(),
        "composer.json",
        r#"{"require":{"laravel/framework":"^12"}}"#,
    );
    write(tmp.path(), "artisan", "<?php");
    write(tmp.path(), "phpunit.xml", "<phpunit/>");
    assert_eq!(discover(tmp.path()).unwrap()[0].command, "php artisan test");
    write(
        tmp.path(),
        "composer.json",
        r#"{"require":{"laravel/framework":"^12"},"scripts":{"test":["@php artisan test"]}}"#,
    );
    assert_eq!(
        discover(tmp.path()).unwrap()[0].command,
        "composer run test"
    );
    write(
        tmp.path(),
        "composer.json",
        r#"{"scripts":{"ci:check":"@php artisan test","test":"@php artisan test"}}"#,
    );
    assert_eq!(
        discover(tmp.path()).unwrap()[0].command,
        "composer run ci:check"
    );
}

#[cfg(unix)]
#[test]
fn conventional_gate_scripts_are_detected_but_never_read_through_external_symlinks() {
    let tmp = tempfile::tempdir().unwrap();
    write(
        tmp.path(),
        "tools/gates.sh",
        "#!/bin/sh\ntouch should-not-exist\n",
    );
    assert_eq!(
        discover(tmp.path()).unwrap()[0].command,
        "sh tools/gates.sh"
    );
    assert!(!tmp.path().join("should-not-exist").exists());
    let external = tempfile::tempdir().unwrap();
    write(external.path(), "checks.sh", "#!/bin/sh\n");
    std::fs::remove_file(tmp.path().join("tools/gates.sh")).unwrap();
    std::os::unix::fs::symlink(
        external.path().join("checks.sh"),
        tmp.path().join("tools/gates.sh"),
    )
    .unwrap();
    assert!(discover(tmp.path()).is_err());
}
