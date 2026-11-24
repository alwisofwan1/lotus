//! A Notion page, read as a ticket row through a [`FieldMapping`].
//!
//! Property values arrive keyed by NAME, each carrying its `id`; the mapping
//! is by id, so each value is found by its id and a rename changes nothing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::schema::{plain_text, FieldMapping};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotionRow {
    pub page_id: String,
    pub url: Option<String>,
    /// `TKT-1008`, from the `unique_id` property when one is mapped.
    pub key: Option<String>,
    pub title: String,
    /// The status option's id — stable when the option is renamed.
    pub status: Option<String>,
    pub assignees: Vec<String>,
    /// The same people's user ids, in the same order — what a write sends back (S41).
    #[serde(default)]
    pub assignee_ids: Vec<String>,
    pub labels: Vec<String>,
    /// Page ids of the rows this one is a sub-ticket of.
    pub parents: Vec<String>,
    pub created_time: String,
    pub last_edited_time: String,
}

impl NotionRow {
    pub fn from_page(page: &Value, mapping: &FieldMapping) -> Option<Self> {
        let page_id = page["id"].as_str()?.to_string();
        let value = |id: &Option<String>| id.as_deref().and_then(|id| property_by_id(page, id));

        let title = value(&mapping.title).map(|v| plain_text(&v["title"])).unwrap_or_default();
        let key = value(&mapping.key).and_then(|v| {
            let number = v["unique_id"]["number"].as_i64()?;
            Some(match v["unique_id"]["prefix"].as_str().filter(|p| !p.is_empty()) {
                Some(prefix) => format!("{prefix}-{number}"),
                None => number.to_string(),
            })
        });
        let status = value(&mapping.status).and_then(|v| v["status"]["id"].as_str().map(str::to_string));
        let names = |v: Option<&Value>, kind: &str| -> Vec<String> {
            v.and_then(|v| v[kind].as_array())
                .map(|items| items.iter().filter_map(|i| i["name"].as_str().map(str::to_string)).collect())
                .unwrap_or_default()
        };
        let parents = value(&mapping.parent)
            .and_then(|v| v["relation"].as_array())
            .map(|items| items.iter().filter_map(|i| i["id"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();

        Some(Self {
            page_id,
            url: page["url"].as_str().map(str::to_string),
            key,
            title,
            status,
            assignees: names(value(&mapping.assignee), "people"),
            assignee_ids: value(&mapping.assignee)
                .and_then(|v| v["people"].as_array())
                .map(|people| people.iter().filter_map(|p| p["id"].as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            labels: names(value(&mapping.labels), "multi_select"),
            parents,
            created_time: page["created_time"].as_str().unwrap_or_default().to_string(),
            last_edited_time: page["last_edited_time"].as_str().unwrap_or_default().to_string(),
        })
    }
}

fn property_by_id<'a>(page: &'a Value, id: &str) -> Option<&'a Value> {
    page["properties"].as_object()?.values().find(|v| v["id"].as_str() == Some(id))
}

/// Every property of `page` but its title, as `(name, value)` sorted by name, for an agent to read
/// (a Factory Run of a Notion ticket, #168). Empty values are left out; a relation shows how many
/// pages it links, not their names (that would be one more read each).
pub fn property_lines(page: &Value) -> Vec<(String, String)> {
    let Some(properties) = page["properties"].as_object() else { return Vec::new() };
    let mut lines: Vec<(String, String)> = properties
        .iter()
        .filter_map(|(name, v)| Some((name.clone(), property_text(v)?)))
        .filter(|(_, text)| !text.trim().is_empty())
        .collect();
    lines.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    lines
}

fn property_text(v: &Value) -> Option<String> {
    let names = |items: &Value, key: &str| -> String {
        items.as_array().into_iter().flatten().filter_map(|i| i[key].as_str()).collect::<Vec<_>>().join(", ")
    };
    let date = |d: &Value| -> Option<String> {
        let start = d["start"].as_str()?;
        Some(match d["end"].as_str() {
            Some(end) => format!("{start} → {end}"),
            None => start.to_string(),
        })
    };
    let kind = v["type"].as_str()?;
    let value = &v[kind];
    Some(match kind {
        "title" => return None,
        "rich_text" => plain_text(value),
        "select" | "status" => value["name"].as_str()?.to_string(),
        "multi_select" => names(value, "name"),
        "people" => names(value, "name"),
        "date" => date(value)?,
        "number" => value.as_f64().map(|n| if n.fract() == 0.0 { format!("{}", n as i64) } else { n.to_string() })?,
        "checkbox" => if value.as_bool()? { "yes" } else { "no" }.to_string(),
        "url" | "email" | "phone_number" => value.as_str()?.to_string(),
        "unique_id" => {
            let number = value["number"].as_i64()?;
            match value["prefix"].as_str().filter(|p| !p.is_empty()) {
                Some(prefix) => format!("{prefix}-{number}"),
                None => number.to_string(),
            }
        }
        "relation" => match value.as_array().map(Vec::len).unwrap_or(0) {
            0 => return None,
            1 => "1 linked page".to_string(),
            n => format!("{n} linked pages"),
        },
        "formula" => {
            let inner = value["type"].as_str()?;
            match inner {
                "string" => value["string"].as_str()?.to_string(),
                "number" => value["number"].as_f64()?.to_string(),
                "boolean" => if value["boolean"].as_bool()? { "yes" } else { "no" }.to_string(),
                "date" => date(&value["date"])?,
                _ => return None,
            }
        }
        "created_time" | "last_edited_time" => value.as_str()?.to_string(),
        "created_by" | "last_edited_by" => value["name"].as_str()?.to_string(),
        _ => return None,
    })
}
