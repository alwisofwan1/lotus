use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::mcp_config;

const PLAYWRIGHT_MCP_KEY: &str = "playwright-browser-automation";
const LEGACY_PLAYWRIGHT_MCP_KEYS: &[&str] = &["lotus-browser-automation"];
const PLAYWRIGHT_MCP_OPT_IN_ENV: &str = "LOTUS_ENABLE_PLAYWRIGHT_BROWSER_MCP";

pub fn playwright_mcp_command() -> (&'static str, Vec<String>) {
    ("npx", vec!["-y".into(), "@playwright/mcp@latest".into()])
}

pub fn sync_browser_mcp_entries() -> Result<PathBuf, mcp_config::McpConfigError> {
    let path = mcp_config::mcp_config_path()?;
    let mut root = read_or_empty_object(&path)?;
    let (command, args) = playwright_mcp_command();
    apply_browser_mcp_entries(&mut root, command, &args, playwright_mcp_opted_in());
    atomic_write(
        &path,
        serde_json::to_vec_pretty(&Value::Object(root))?.as_slice(),
    )?;
    Ok(path)
}

fn playwright_mcp_opted_in() -> bool {
    matches!(
        std::env::var(PLAYWRIGHT_MCP_OPT_IN_ENV).as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES")
    )
}

fn apply_browser_mcp_entries(
    root: &mut Map<String, Value>,
    command: &str,
    args: &[String],
    install_playwright: bool,
) {
    remove_playwright_mcp_entries(root);
    if install_playwright {
        apply_playwright_mcp_entry(root, command, args);
    }
}

fn remove_playwright_mcp_entries(root: &mut Map<String, Value>) {
    let Some(servers) = root.get_mut("mcpServers") else {
        return;
    };
    let Value::Object(servers) = servers else {
        return;
    };
    servers.remove(PLAYWRIGHT_MCP_KEY);
    for legacy_key in LEGACY_PLAYWRIGHT_MCP_KEYS {
        servers.remove(*legacy_key);
    }
}

fn apply_playwright_mcp_entry(root: &mut Map<String, Value>, command: &str, args: &[String]) {
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = match servers {
        Value::Object(map) => map,
        _ => {
            *servers = Value::Object(Map::new());
            servers.as_object_mut().expect("mcpServers object")
        }
    };
    for legacy_key in LEGACY_PLAYWRIGHT_MCP_KEYS {
        servers.remove(*legacy_key);
    }
    servers.insert(
        PLAYWRIGHT_MCP_KEY.to_string(),
        json!({ "type": "stdio", "command": command, "args": args }),
    );
}

fn read_or_empty_object(path: &Path) -> Result<Map<String, Value>, mcp_config::McpConfigError> {
    match fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(Map::new()),
        Ok(text) => match serde_json::from_str::<Value>(&text)? {
            Value::Object(map) => Ok(map),
            _ => Ok(Map::new()),
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
        Err(err) => Err(err.into()),
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playwright_mcp_command_uses_npx_no_prompt_install() {
        let (command, args) = playwright_mcp_command();
        assert_eq!(command, "npx");
        assert_eq!(args, vec!["-y", "@playwright/mcp@latest"]);
    }

    #[test]
    fn apply_playwright_mcp_entry_preserves_existing_servers() {
        let mut root = serde_json::json!({
            "theme": "dark",
            "mcpServers": { "lotus": { "type": "stdio", "command": "node", "args": ["lotus.mjs"] } }
        })
        .as_object()
        .unwrap()
        .clone();
        let (_, args) = playwright_mcp_command();

        apply_playwright_mcp_entry(&mut root, "npx", &args);

        assert_eq!(root["theme"], "dark");
        assert!(root["mcpServers"]["lotus"].is_object());
        assert_eq!(root["mcpServers"][PLAYWRIGHT_MCP_KEY]["command"], "npx");
        assert_eq!(
            root["mcpServers"][PLAYWRIGHT_MCP_KEY]["args"][1],
            "@playwright/mcp@latest"
        );
    }

    #[test]
    fn playwright_mcp_entry_uses_non_lotus_name_and_removes_legacy_alias() {
        let mut root = serde_json::json!({
            "mcpServers": {
                "lotus": { "type": "stdio", "command": "node", "args": ["lotus.mjs"] },
                "lotus-browser-automation": {
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "@playwright/mcp@old"]
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let (_, args) = playwright_mcp_command();

        apply_playwright_mcp_entry(&mut root, "npx", &args);

        let servers = root["mcpServers"].as_object().unwrap();
        assert!(servers.contains_key("lotus"));
        assert!(!servers.contains_key("lotus-browser-automation"));
        assert!(servers.contains_key("playwright-browser-automation"));
        assert_eq!(
            servers["playwright-browser-automation"]["args"][1],
            "@playwright/mcp@latest"
        );
    }

    #[test]
    fn browser_mcp_sync_removes_playwright_by_default() {
        let mut root = serde_json::json!({
            "theme": "dark",
            "mcpServers": {
                "lotus-dev": { "type": "stdio", "command": "node", "args": ["lotus.mjs"] },
                "lotus-browser-automation": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@old"] },
                "playwright-browser-automation": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let (_, args) = playwright_mcp_command();

        apply_browser_mcp_entries(&mut root, "npx", &args, false);

        let servers = root["mcpServers"].as_object().unwrap();
        assert!(servers.contains_key("lotus-dev"));
        assert!(!servers.contains_key("lotus-browser-automation"));
        assert!(!servers.contains_key("playwright-browser-automation"));
    }

    #[test]
    fn browser_mcp_sync_can_opt_into_playwright_with_clear_name() {
        let mut root = serde_json::json!({
            "mcpServers": {
                "lotus-browser-automation": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@old"] }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let (_, args) = playwright_mcp_command();

        apply_browser_mcp_entries(&mut root, "npx", &args, true);

        let servers = root["mcpServers"].as_object().unwrap();
        assert!(!servers.contains_key("lotus-browser-automation"));
        assert_eq!(servers["playwright-browser-automation"]["command"], "npx");
        assert_eq!(
            servers["playwright-browser-automation"]["args"][1],
            "@playwright/mcp@latest"
        );
    }

    #[test]
    fn sync_browser_mcp_entries_removes_playwright_config_by_default() {
        let _g = crate::paths::TEST_ENV_LOCK
            .lock()
            .expect("lock browser mcp env tests");
        let previous_home = std::env::var_os("HOME");
        let previous_opt_in = std::env::var_os(PLAYWRIGHT_MCP_OPT_IN_ENV);
        let test_home = tempfile::tempdir().expect("create browser MCP test home");
        let home = test_home.path().to_path_buf();
        std::env::set_var("HOME", &home);
        std::env::remove_var(PLAYWRIGHT_MCP_OPT_IN_ENV);

        let config_path = home.join(".claude.json");
        fs::write(
            &config_path,
            serde_json::json!({
                "mcpServers": {
                    "lotus-dev": { "type": "stdio", "command": "node", "args": ["lotus.mjs"] },
                    "lotus-browser-automation": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@old"] },
                    "playwright-browser-automation": { "type": "stdio", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }
                }
            })
            .to_string(),
        )
        .unwrap();

        let path = sync_browser_mcp_entries().expect("sync browser mcp entries");

        assert_eq!(path, home.join(".claude.json"));
        let config: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        assert!(config["mcpServers"]["lotus-dev"].is_object());
        assert!(config["mcpServers"]["lotus-browser-automation"].is_null());
        assert!(config["mcpServers"]["playwright-browser-automation"].is_null());

        match previous_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match previous_opt_in {
            Some(v) => std::env::set_var(PLAYWRIGHT_MCP_OPT_IN_ENV, v),
            None => std::env::remove_var(PLAYWRIGHT_MCP_OPT_IN_ENV),
        }
    }
}
