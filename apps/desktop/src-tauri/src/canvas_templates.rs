use crate::error::AppError;
use crate::json::{collect_json_entries, write_json};
use crate::paths::canvas_templates_dir;
use serde::{Deserialize, Serialize};

/// Stored blueprint for a CodeCanvas board: node structure + Note content.
/// Positions are excluded — Dagre computes them on apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanvasTeamTemplate {
    pub id: String,
    pub name: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    /// Blueprint v2 fields are intentionally schema-light on the Rust side. The
    /// frontend owns validation and migration; Rust preserves the JSON envelope.
    #[serde(
        rename = "schemaVersion",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub schema_version: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trigger: Option<serde_json::Value>,
    #[serde(
        rename = "sourceTemplateId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub source_template_id: Option<String>,
    #[serde(rename = "updatedAt", default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variables: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub roster: Vec<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub guardrails: Vec<String>,
    #[serde(
        rename = "contextSources",
        default,
        skip_serializing_if = "Vec::is_empty"
    )]
    pub context_sources: Vec<serde_json::Value>,
    #[serde(
        rename = "promptDefaults",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub prompt_defaults: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<serde_json::Value>,
    /// Serialized CanvasTemplateNode union (terminal | agent | note).
    /// Kept as raw JSON so the Rust side stays decoupled from the TS schema.
    pub nodes: Vec<serde_json::Value>,
    /// Serialized CanvasTemplateEdge records (source/target/kind).
    pub edges: Vec<serde_json::Value>,
}

fn template_path(id: &str) -> std::path::PathBuf {
    canvas_templates_dir().join(format!("{id}.json"))
}

pub fn list_templates() -> Vec<CanvasTeamTemplate> {
    collect_json_entries(&canvas_templates_dir(), |e| e.path())
        .into_iter()
        .filter(|t: &CanvasTeamTemplate| !t.id.is_empty())
        .collect()
}

pub fn save_template(template: CanvasTeamTemplate) -> Result<CanvasTeamTemplate, AppError> {
    write_json(&template_path(&template.id), &template)?;
    Ok(template)
}

pub fn delete_template(id: String) -> Result<(), AppError> {
    let path = template_path(&id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(AppError::Io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::read_json;
    use tempfile::TempDir;

    fn make_template(id: &str, name: &str) -> CanvasTeamTemplate {
        CanvasTeamTemplate {
            id: id.to_string(),
            name: name.to_string(),
            created_at: 0,
            schema_version: None,
            description: None,
            category: None,
            tags: vec![],
            icon: None,
            status: None,
            trigger: None,
            source_template_id: None,
            updated_at: None,
            variables: vec![],
            roster: vec![],
            guardrails: vec![],
            context_sources: vec![],
            prompt_defaults: None,
            layout: None,
            nodes: vec![],
            edges: vec![],
        }
    }

    fn with_temp_dir<F: FnOnce(&TempDir)>(f: F) {
        let dir = TempDir::new().unwrap();
        f(&dir);
    }

    #[test]
    fn save_and_list_roundtrip() {
        with_temp_dir(|dir| {
            let path = dir.path().join("t1.json");
            let t = make_template("t1", "My Team");
            write_json(&path, &t).unwrap();
            let loaded: CanvasTeamTemplate = read_json(&path).unwrap();
            assert_eq!(loaded.id, "t1");
            assert_eq!(loaded.name, "My Team");
        });
    }

    #[test]
    fn v2_blueprint_fields_are_preserved() {
        with_temp_dir(|dir| {
            let path = dir.path().join("v2.json");
            let mut t = make_template("v2", "Blueprint");
            t.schema_version = Some(2);
            t.description = Some("A v2 blueprint".into());
            t.category = Some("user".into());
            t.tags = vec!["launch".into()];
            t.status = Some("active".into());
            t.trigger = Some(serde_json::json!({ "kind": "manual" }));
            t.source_template_id = Some("builtin-review".into());
            t.updated_at = Some(99);
            t.variables = vec![serde_json::json!({ "key": "objective", "required": true })];
            t.roster = vec![serde_json::json!({ "key": "lead", "name": "Lead" })];
            t.guardrails = vec!["No deploys".into()];
            t.context_sources = vec![
                serde_json::json!({ "label": "README", "kind": "file", "value": "README.md" }),
            ];
            t.prompt_defaults = Some(serde_json::json!({ "mission": "Ship {{objective}}" }));
            t.layout = Some(serde_json::json!({ "engine": "dagre", "direction": "LR" }));

            write_json(&path, &t).unwrap();
            let loaded: CanvasTeamTemplate = read_json(&path).unwrap();
            assert_eq!(loaded.schema_version, Some(2));
            assert_eq!(loaded.description.as_deref(), Some("A v2 blueprint"));
            assert_eq!(loaded.category.as_deref(), Some("user"));
            assert_eq!(loaded.tags, vec!["launch"]);
            assert_eq!(loaded.status.as_deref(), Some("active"));
            assert_eq!(loaded.trigger.unwrap()["kind"], "manual");
            assert_eq!(loaded.source_template_id.as_deref(), Some("builtin-review"));
            assert_eq!(loaded.updated_at, Some(99));
            assert_eq!(loaded.variables[0]["key"], "objective");
            assert_eq!(loaded.roster[0]["name"], "Lead");
            assert_eq!(loaded.guardrails, vec!["No deploys"]);
            assert_eq!(loaded.context_sources[0]["label"], "README");
            assert_eq!(
                loaded.prompt_defaults.unwrap()["mission"],
                "Ship {{objective}}"
            );
            assert_eq!(loaded.layout.unwrap()["direction"], "LR");
        });
    }

    #[test]
    fn nodes_and_edges_preserved() {
        with_temp_dir(|dir| {
            let path = dir.path().join("t2.json");
            let node = serde_json::json!({ "kind": "terminal", "id": "n1" });
            let edge = serde_json::json!({ "source": "n1", "target": "n2" });
            let t = CanvasTeamTemplate {
                id: "t2".into(),
                name: "T2".into(),
                created_at: 42,
                schema_version: None,
                description: None,
                category: None,
                tags: vec![],
                icon: None,
                status: None,
                trigger: None,
                source_template_id: None,
                updated_at: None,
                variables: vec![],
                roster: vec![],
                guardrails: vec![],
                context_sources: vec![],
                prompt_defaults: None,
                layout: None,
                nodes: vec![node.clone()],
                edges: vec![edge.clone()],
            };
            write_json(&path, &t).unwrap();
            let loaded: CanvasTeamTemplate = read_json(&path).unwrap();
            assert_eq!(loaded.nodes.len(), 1);
            assert_eq!(loaded.edges.len(), 1);
            assert_eq!(loaded.nodes[0]["kind"], "terminal");
        });
    }
}
