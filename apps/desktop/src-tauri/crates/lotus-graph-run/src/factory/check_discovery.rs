//! Bounded metadata discovery, not a shell probe or a check execution engine.
use super::settings::CheckSuggestion;
use serde_json::Value;
use std::io::Read;
use std::path::Path;

fn metadata(root: &Path, relative: &str) -> Result<Option<String>, String> {
    let mut current = root.to_path_buf();
    for part in Path::new(relative).components() {
        current.push(part);
        match std::fs::symlink_metadata(&current) {
            Ok(m) if m.file_type().is_symlink() => {
                return Err("Check metadata must not use symlinked paths".into())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Cannot inspect repository check metadata".into()),
            _ => {}
        }
    }
    let mut bytes = Vec::new();
    std::fs::File::open(current)
        .and_then(|f| f.take(1_048_577).read_to_end(&mut bytes))
        .map_err(|_| "Cannot read repository check metadata")?;
    if bytes.len() > 1_048_576 {
        return Err("Repository check metadata exceeds 1 MB per file".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Repository check metadata is not UTF-8".into())
}

fn manager(root: &Path, prefix: &str, json: &Value, inherited: Option<&str>) -> Option<String> {
    if let Some(declared) = json.get("packageManager").and_then(Value::as_str) {
        let name = declared.split('@').next()?;
        return ["npm", "pnpm", "yarn", "bun"]
            .contains(&name)
            .then(|| name.to_string());
    }
    let dir = root.join(prefix);
    let mut names: Vec<_> = [
        ("npm", "package-lock.json"),
        ("pnpm", "pnpm-lock.yaml"),
        ("yarn", "yarn.lock"),
        ("bun", "bun.lock"),
    ]
    .into_iter()
    .filter(|(_, file)| dir.join(file).is_file())
    .map(|(name, _)| name)
    .collect();
    if dir.join("bun.lockb").is_file() && !names.contains(&"bun") {
        names.push("bun");
    }
    match names.as_slice() {
        [one] => Some((*one).into()),
        [] => inherited.map(str::to_string),
        _ => None,
    }
}

fn node_checks(
    root: &Path,
    prefix: &str,
    inherited: Option<&str>,
) -> Result<(Vec<CheckSuggestion>, Option<String>), String> {
    let file = if prefix.is_empty() {
        "package.json".into()
    } else {
        format!("{prefix}/package.json")
    };
    let Some(text) = metadata(root, &file)? else {
        return Ok((Vec::new(), None));
    };
    let json: Value =
        serde_json::from_str(&text).map_err(|_| "Repair package.json to discover checks")?;
    let Some(manager) = manager(root, prefix, &json, inherited) else {
        return Ok((Vec::new(), None));
    };
    let has = |key| {
        json.get("scripts")
            .and_then(|s| s.get(key))
            .and_then(Value::as_str)
            .is_some_and(|s| {
                let s = s.to_lowercase();
                !s.trim().is_empty()
                    && !s.contains("--watch")
                    && !s.contains(":watch")
                    && !(s.contains("vitest")
                        && !s.split_whitespace().any(|w| w == "run" || w == "--run"))
            })
    };
    let runner = if prefix.is_empty() {
        manager.clone()
    } else {
        match manager.as_str() {
            "npm" => format!("npm --prefix {prefix}"),
            "pnpm" => format!("pnpm --dir {prefix}"),
            "yarn" => format!("yarn --cwd {prefix}"),
            _ => format!("bun --cwd {prefix}"),
        }
    };
    let scope = if prefix.is_empty() {
        ""
    } else {
        " Covers this module, not the whole repository."
    };
    let evidence = format!("Detected from {file} · {manager}.{scope} Not executed or verified.");
    let mut found = Vec::new();
    let mut add = |label: &str, command: String| {
        found.push(CheckSuggestion {
            label: if prefix.is_empty() {
                label.into()
            } else {
                format!("{label} · {prefix}")
            },
            command,
            evidence: evidence.clone(),
        })
    };
    for (key, label) in [
        ("check", "Project checks"),
        ("verify", "Project verification"),
        ("validate", "Project validation"),
        ("test:ci", "CI tests"),
    ] {
        if has(key) {
            add(label, format!("{runner} run {key}"));
        }
    }
    if has("test") && has("typecheck") {
        add(
            "Tests + type checking",
            format!("{runner} run test && {runner} run typecheck"),
        );
    }
    if has("test") {
        add("Tests", format!("{runner} run test"));
    } else if has("typecheck") {
        add("Type checking", format!("{runner} run typecheck"));
    }
    if ![
        "check",
        "verify",
        "validate",
        "test:ci",
        "test",
        "typecheck",
    ]
    .iter()
    .any(|key| has(*key))
        && has("lint")
    {
        add("Lint only", format!("{runner} run lint"));
    }
    Ok((found, Some(manager)))
}

pub(super) fn discover(checkout: &Path) -> Result<Vec<CheckSuggestion>, String> {
    let mut found = Vec::new();
    for file in [
        "tools/gates.sh",
        "tools/checks.sh",
        "scripts/check.sh",
        "scripts/checks.sh",
    ] {
        if let Some(text) = metadata(checkout, file)? {
            let interpreter = match text.lines().next().unwrap_or("").trim() {
                "#!/bin/sh" | "#!/usr/bin/env sh" => Some("sh"),
                "#!/bin/bash" | "#!/usr/bin/env bash" => Some("bash"),
                _ => None,
            };
            let command = if let Some(program) = interpreter {
                Some(format!("{program} {file}"))
            } else {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::metadata(checkout.join(file))
                        .ok()
                        .filter(|m| m.permissions().mode() & 0o111 != 0)
                        .map(|_| format!("./{file}"))
                }
                #[cfg(not(unix))]
                {
                    None
                }
            };
            if let Some(command) = command {
                found.push(CheckSuggestion {
                    label: "Repository check script".into(),
                    command,
                    evidence: format!("Detected {file}. Not executed or verified."),
                });
            }
        }
    }
    if let Some(text) = metadata(checkout, "composer.json")? {
        let composer: Value =
            serde_json::from_str(&text).map_err(|_| "Repair composer.json to discover checks")?;
        let mut php_found = false;
        for target in ["ci:check", "check", "verify", "validate", "test"] {
            let usable = composer
                .get("scripts")
                .and_then(|s| s.get(target))
                .is_some_and(|v| match v {
                    Value::String(s) => !s.trim().is_empty(),
                    Value::Array(items) => {
                        !items.is_empty()
                            && items
                                .iter()
                                .all(|i| i.as_str().is_some_and(|s| !s.trim().is_empty()))
                    }
                    _ => false,
                });
            if usable {
                php_found = true;
                found.push(CheckSuggestion {
                    label: format!("PHP project {target}"),
                    command: format!("composer run {target}"),
                    evidence: format!(
                        "Detected composer.json script {target}. Not executed or verified."
                    ),
                });
            }
        }
        if !php_found
            && composer
                .get("require")
                .and_then(|r| r.get("laravel/framework"))
                .is_some()
            && metadata(checkout, "artisan")?.is_some()
            && (metadata(checkout, "phpunit.xml")?.is_some()
                || metadata(checkout, "phpunit.xml.dist")?.is_some())
        {
            found.push(CheckSuggestion { label: "Laravel tests".into(), command: "php artisan test".into(), evidence: "Detected laravel/framework in composer.json, artisan and PHPUnit configuration. Not executed or verified.".into() });
        }
    }
    let (node, inherited) = node_checks(checkout, "", None)?;
    found.extend(node);
    if let Some(text) = metadata(checkout, "Makefile")? {
        for target in ["check", "test"] {
            if text.lines().any(|line| {
                !line.starts_with(char::is_whitespace)
                    && line
                        .strip_prefix(target)
                        .is_some_and(|rest| rest.trim_start().starts_with(':'))
            }) {
                found.push(CheckSuggestion {
                    label: format!("Make {target}"),
                    command: format!("make {target}"),
                    evidence: format!(
                        "Detected Makefile target {target}. Not executed or verified."
                    ),
                });
                break;
            }
        }
    }
    if let Some(text) = metadata(checkout, "Cargo.toml")? {
        let manifest: toml::Value =
            toml::from_str(&text).map_err(|_| "Repair Cargo.toml to discover checks")?;
        if manifest.get("package").is_some() || manifest.get("workspace").is_some() {
            found.push(CheckSuggestion {
                label: "Rust tests".into(),
                command: "cargo test".into(),
                evidence: "Detected Cargo.toml. Not executed or verified.".into(),
            });
        }
    }
    // Root policy wins. Only offer scoped module checks when there is no root candidate.
    if found.is_empty() {
        let mut modules = 0;
        for parent in ["apps", "packages"] {
            let dir = checkout.join(parent);
            if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
                continue;
            }
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            let mut names: Vec<_> = entries
                .take(64)
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .filter_map(|e| e.file_name().into_string().ok())
                .filter(|n| {
                    !n.starts_with('.')
                        && n.chars()
                            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                })
                .collect();
            names.sort();
            for name in names {
                if modules >= 12 {
                    break;
                }
                modules += 1;
                found.extend(
                    node_checks(checkout, &format!("{parent}/{name}"), inherited.as_deref())?.0,
                );
            }
        }
    }
    found.truncate(24);
    Ok(found)
}

#[cfg(test)]
#[path = "check_discovery_tests.rs"]
mod tests;
