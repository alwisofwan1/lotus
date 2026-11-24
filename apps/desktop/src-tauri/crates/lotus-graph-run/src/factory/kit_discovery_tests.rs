use super::*;

fn write(path: &Path, value: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, value).unwrap();
}
fn skill(root: &Path, path: &str) {
    write(&root.join(path).join("SKILL.md"), "---\nname: tdd\ndescription: Test first.\n---\nDo it.");
}
fn sources(home: &Path) -> KitSources {
    KitSources { claude_dir: Some(home.join(".claude")), ..Default::default() }
}
fn installed(home: &Path, plugins: Value) {
    write(&home.join(".claude/plugins/installed_plugins.json"), &serde_json::json!({"version": 2, "plugins": plugins}).to_string());
}
fn catalog(home: &Path, checkout: &Path) -> Catalog {
    read_catalog(&sources(home), checkout, None, &HashMap::new())
}

#[test]
fn enabled_plugin_for_another_project_explains_scope_without_importing_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/tdd");
    write(&tmp.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"mattpocock-skills@market":true}}"#);
    installed(tmp.path(), serde_json::json!({"mattpocock-skills@market": [
        {"scope":"local","projectPath":"/other-secret-project","installPath":root}
    ]}));
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.skills.is_empty());
    let warning = c.notes.iter().find(|n| n.contains("enabled but has no applicable installation")).expect("missing scope diagnostic");
    assert!(warning.contains("another project"));
    assert!(warning.contains("user scope"));
    assert!(warning.contains("refresh integrations"));
    assert!(!serde_json::to_string(&c).unwrap().contains("other-secret-project"));
}

#[test]
fn missing_marketplace_entry_explains_the_available_sibling_without_aliasing_it() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/tdd");
    write(&root.join(".mcp.json"), r#"{"docs":{"command":"node"}}"#);
    write(&tmp.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"tools@old":true,"tools@official":true}}"#);
    installed(tmp.path(), serde_json::json!({"tools@official":[{"scope":"project","projectPath":tmp.path(),"installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.skills[0].id, "tools:tdd");
    let json = serde_json::to_value(&c).unwrap();
    assert_eq!(json["skills"][0]["plugin"], "tools@official");
    assert_eq!(json["mcp"][0]["plugin"], "tools@official");
    let warning = c.notes.iter().find(|n| n.contains("tools@old")).unwrap();
    assert!(warning.contains("tools@official is available"));
    assert!(warning.contains("not interchangeable"));
    assert!(warning.contains("disable the unused entry"));
    assert!(!warning.contains("Install it in Claude Code"));
}

#[test]
fn unregistered_builtin_entry_does_not_claim_it_can_be_installed_like_a_marketplace_plugin() {
    let tmp = tempfile::tempdir().unwrap();
    write(&tmp.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"helper@builtin":true}}"#);
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.notes.len(), 1);
    assert!(c.notes[0].contains("cannot verify this built-in entry"));
    assert!(!c.notes[0].contains("Install it in Claude Code"));
}

#[test]
fn enabled_plugin_missing_from_registry_is_not_silently_omitted() {
    let tmp = tempfile::tempdir().unwrap();
    write(&tmp.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"tools@market":true}}"#);
    for registry in [false, true] {
        if registry { installed(tmp.path(), serde_json::json!({})); }
        let c = catalog(tmp.path(), tmp.path());
        assert!(c.notes.iter().any(|n| n.contains("Plugin tools@market is enabled but has no applicable installation")));
    }
}

#[test]
fn enabled_plugin_user_fallback_and_local_disablement_do_not_raise_scope_warnings() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/tdd");
    write(&tmp.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"tools@market":true}}"#);
    installed(tmp.path(), serde_json::json!({"tools@market":[
        {"scope":"project","projectPath":"/another-project","installPath":root},
        {"scope":"user","installPath":root}
    ]}));
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.skills.len(), 1);
    assert!(c.notes.is_empty());
    write(&tmp.path().join(".claude/settings.local.json"), r#"{"enabledPlugins":{"tools@market":false}}"#);
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.skills.is_empty());
    assert!(c.notes.is_empty());
    assert_eq!(c.notices.len(), 1);
    assert!(c.notices[0].contains("disabled"));
}

#[test]
fn invalid_enabled_plugin_identity_is_not_echoed_in_diagnostics() {
    let tmp = tempfile::tempdir().unwrap();
    write(&tmp.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"https://user:secret-fixture@example.test":true}}"#);
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.notes.iter().any(|n| n.contains("invalid plugin identity")));
    assert!(!serde_json::to_string(&c).unwrap().contains("secret-fixture"));
}

#[test]
fn plugin_capability_limits_are_information_not_discovery_failures() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/tdd");
    std::fs::create_dir_all(root.join("agents")).unwrap();
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.skills.len(), 1);
    assert!(c.notes.is_empty());
    assert!(serde_json::to_value(&c).unwrap()["notices"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains("not plugin commands")));
}

#[test]
fn manifest_paths_find_nested_matt_pocock_skills_and_materialize_them() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/engineering/tdd");
    write(&root.join(".claude-plugin/plugin.json"), r#"{"name":"mattpocock-skills","skills":["./skills/engineering/tdd"]}"#);
    installed(tmp.path(), serde_json::json!({"mattpocock-skills@market": [{"scope":"user", "installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.skills.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["mattpocock-skills:tdd"]);
    let kit = c.resolve(&["mattpocock-skills:tdd".into()], &[]).unwrap();
    let paths = materialize(&kit, &tmp.path().join("kit"), tmp.path(), &HashMap::new()).unwrap();
    assert!(paths.plugin_dir.unwrap().join("skills/mattpocock-skills--tdd/SKILL.md").exists());
}

#[test]
fn plugin_mcp_reads_file_and_inline_manifest_expands_root_and_keeps_secrets_private() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    write(
        &root.join(".mcp.json"),
        r#"{"file":{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/server.mjs"],"env":{"KEY":"secret-fixture"}}}"#,
    );
    write(
        &root.join(".claude-plugin/plugin.json"),
        r#"{"name":"tools","mcpServers":{"inline":{"type":"http","url":"https://u:secret-fixture@example.test/mcp?token=secret-fixture"}}}"#,
    );
    installed(tmp.path(), serde_json::json!({"tools@market": [{"scope":"user", "installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.mcp.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["plugin-tools--file", "plugin-tools--inline"]);
    assert!(!format!("{:?} {}", c, serde_json::to_string(&c).unwrap()).contains("secret-fixture"));
    let kit = c.resolve(&[], &["plugin-tools--file".into()]).unwrap();
    let paths = materialize(&kit, &tmp.path().join("kit"), tmp.path(), &HashMap::new()).unwrap();
    let config: Value = serde_json::from_str(&std::fs::read_to_string(paths.mcp_config).unwrap()).unwrap();
    assert_eq!(config["mcpServers"]["plugin-tools--file"]["args"][0], root.join("server.mjs").to_string_lossy().as_ref());
    assert_eq!(config["mcpServers"].as_object().unwrap().len(), 1);
}

#[test]
fn matching_project_scope_wins_skipping_stale_paths_and_other_projects() {
    let tmp = tempfile::tempdir().unwrap();
    let user = tmp.path().join("user");
    let project = tmp.path().join("project");
    let other = tmp.path().join("other");
    skill(&user, "skills/user-skill");
    skill(&project, "skills/project-skill");
    skill(&other, "skills/other-skill");
    installed(
        tmp.path(),
        serde_json::json!({"tools@market": [
            {"scope":"local","projectPath":tmp.path(),"installPath":tmp.path().join("gone")},
            {"scope":"project","projectPath":"/another-repo","installPath":other},
            {"scope":"user","installPath":user},
            {"scope":"project","projectPath":tmp.path(),"installPath":project}
        ]}),
    );
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.skills.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["tools:project-skill"]);
    assert!(c.notes.iter().any(|n| n.contains("unavailable")));
}

#[test]
fn marketplace_collisions_are_qualified_instead_of_silently_dropped() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    skill(&a, "skills/tdd");
    skill(&b, "skills/tdd");
    installed(
        tmp.path(),
        serde_json::json!({
            "tools@one":[{"scope":"user","installPath":a}],
            "tools@two":[{"scope":"user","installPath":b}]
        }),
    );
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.skills.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["tools@one:tdd", "tools@two:tdd"]);
    assert!(c.notes.is_empty());
    assert!(c.notices.iter().any(|n| n.contains("marketplace")));
    assert_eq!(c.skills[0].plugin.as_deref(), Some("tools@one"));
    assert_eq!(c.skills[1].plugin.as_deref(), Some("tools@two"));
    let kit = c.resolve(&["tools@one:tdd".into(), "tools@two:tdd".into()], &[]).unwrap();
    let paths = materialize(&kit, &tmp.path().join("kit"), tmp.path(), &HashMap::new()).unwrap();
    assert_eq!(paths.skills, ["lotus-factory:tools_40one--tdd", "lotus-factory:tools_40two--tdd"]);
}

#[test]
fn disabled_plugins_and_escaping_manifest_paths_are_reported_without_secret_values() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/tdd");
    write(&root.join(".claude-plugin/plugin.json"), r#"{"skills":["../secret-fixture"]}"#);
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.skills.is_empty());
    assert!(c.notes.iter().any(|n| n.contains("outside")));
    assert!(!c.notes.join(" ").contains("secret-fixture"));
    write(&tmp.path().join(".claude/settings.json"), r#"{"enabledPlugins":{"tools@market":false}}"#);
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.skills.is_empty());
    assert!(c.notes.is_empty());
    assert!(serde_json::to_value(&c).unwrap()["notices"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains("disabled")));
}

#[test]
fn discovery_uses_the_agents_config_profile_instead_of_default_home() {
    let tmp = tempfile::tempdir().unwrap();
    let profile = tmp.path().join("ccs-profile");
    skill(&tmp.path().join(".claude"), "skills/default-only");
    skill(&profile, "skills/profile-only");
    write(&profile.join(".claude.json"), r#"{"mcpServers":{"profile-server":{"command":"node"}}}"#);
    let env = HashMap::from([("CLAUDE_CONFIG_DIR".into(), profile.to_string_lossy().into_owned())]);
    let c = read_catalog(&sources(tmp.path()), tmp.path(), None, &env);
    assert_eq!(c.skills.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["profile-only"]);
    assert_eq!(c.mcp.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["profile-server"]);
}

#[test]
fn plugin_mcp_manifest_file_paths_and_wrapped_configs_are_supported() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    write(&root.join(".claude-plugin/plugin.json"), r#"{"skills":"./custom-skills/","mcpServers":["./config/mcp.json"]}"#);
    skill(&root, "custom-skills/tdd");
    write(&root.join("config/mcp.json"), r#"{"mcpServers":{"docs":{"command":"node"}}}"#);
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.skills[0].id, "tools:tdd");
    assert_eq!(c.mcp.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["plugin-tools--docs"]);
}

#[cfg(unix)]
#[test]
fn plugin_skill_cannot_copy_a_resource_symlink_outside_its_installation() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/tdd");
    write(&tmp.path().join("outside.txt"), "secret-fixture");
    std::os::unix::fs::symlink(tmp.path().join("outside.txt"), root.join("skills/tdd/resource.txt")).unwrap();
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    let kit = c.resolve(&["tools:tdd".into()], &[]).unwrap();
    let error = materialize(&kit, &tmp.path().join("kit"), tmp.path(), &HashMap::new()).unwrap_err();
    assert!(error.contains("outside"));
    assert!(!error.contains("secret-fixture"));
}

#[test]
fn missing_selected_profile_is_reported_instead_of_falling_back_to_home() {
    let tmp = tempfile::tempdir().unwrap();
    skill(&tmp.path().join(".claude"), "skills/default-only");
    let env = HashMap::from([("CLAUDE_CONFIG_DIR".into(), tmp.path().join("missing").to_string_lossy().into_owned())]);
    let c = read_catalog(&sources(tmp.path()), tmp.path(), None, &env);
    assert!(c.skills.is_empty());
    assert!(c.notes.iter().any(|n| n.contains("Claude config directory is unavailable")));
}

#[test]
fn plugin_mcp_names_cannot_collide_at_the_namespace_separator() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a");
    let b = tmp.path().join("b");
    write(&a.join(".mcp.json"), r#"{"x":{"command":"node"}}"#);
    write(&b.join(".mcp.json"), r#"{"-x":{"command":"node"}}"#);
    installed(
        tmp.path(),
        serde_json::json!({
            "tools-@one":[{"scope":"user","installPath":a}],
            "tools@two":[{"scope":"user","installPath":b}]
        }),
    );
    let c = catalog(tmp.path(), tmp.path());
    assert_eq!(c.mcp.len(), 2);
    assert_ne!(c.mcp[0].name, c.mcp[1].name);
    assert!(c.mcp.iter().all(|m| m.name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')));
}

#[test]
fn unsafe_plugin_identity_is_refused_before_it_can_become_a_kit_path() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    skill(&root, "skills/tdd");
    installed(tmp.path(), serde_json::json!({"../escape@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.skills.is_empty());
    assert!(c.notes.iter().any(|n| n.contains("invalid plugin identity")));
}

#[test]
fn explicit_mcp_configuration_wins_a_plugin_namespace_conflict_with_a_warning() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    write(&root.join(".mcp.json"), r#"{"docs":{"command":"plugin-server"}}"#);
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let config = tmp.path().join(".claude.json");
    write(&config, r#"{"mcpServers":{"plugin-tools--docs":{"command":"explicit-server"}}}"#);
    let mut sources = sources(tmp.path());
    sources.claude_json = Some(config);
    let c = read_catalog(&sources, tmp.path(), None, &HashMap::new());
    assert_eq!(c.mcp[0].target, "explicit-server");
    assert!(c.notes.iter().any(|n| n.contains("duplicate MCP server")));
}

#[cfg(unix)]
#[test]
fn plugin_mcp_default_file_cannot_follow_an_external_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    std::fs::create_dir_all(&root).unwrap();
    write(&tmp.path().join("external.json"), r#"{"external":{"command":"secret-fixture"}}"#);
    std::os::unix::fs::symlink(tmp.path().join("external.json"), root.join(".mcp.json")).unwrap();
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.mcp.is_empty());
    assert!(c.notes.iter().any(|n| n.contains("outside")));
    assert!(!c.notes.join(" ").contains("secret-fixture"));
}

#[cfg(unix)]
#[test]
fn skill_metadata_cannot_read_an_external_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    std::fs::create_dir_all(root.join("skills/tdd")).unwrap();
    write(&tmp.path().join("external.md"), "---\ndescription: secret-fixture\n---\n");
    std::os::unix::fs::symlink(tmp.path().join("external.md"), root.join("skills/tdd/SKILL.md")).unwrap();
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.skills.is_empty());
    assert!(c.notes.iter().any(|n| n.contains("outside")));
    assert!(!serde_json::to_string(&c).unwrap().contains("secret-fixture"));
}

#[test]
fn malformed_plugin_json_is_diagnostic_not_raw_content() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("plugin");
    write(&root.join(".mcp.json"), "secret-fixture");
    installed(tmp.path(), serde_json::json!({"tools@market":[{"scope":"user","installPath":root}]}));
    let c = catalog(tmp.path(), tmp.path());
    assert!(c.notes.iter().any(|n| n.contains("invalid JSON")));
    assert!(!c.notes.join(" ").contains("secret-fixture"));
}
