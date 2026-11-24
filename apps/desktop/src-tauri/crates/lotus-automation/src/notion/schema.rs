//! A Notion data source's shape, and which of its properties Lotus reads as a
//! ticket's fields (plans/ticket-sources PLAN S17–S20).
//!
//! Everything is keyed by property **id**, never by name: a property keeps its
//! id when it is renamed (the title's id is always `title`), so a mapping made
//! today still points at the right column after someone renames "Status" to
//! "Stage" (PLAN S19).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A data source the token can see, as `POST /v1/search` lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceSummary {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceSchema {
    pub id: String,
    pub title: String,
    pub url: Option<String>,
    pub properties: Vec<PropertySchema>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertySchema {
    pub id: String,
    pub name: String,
    /// Notion's property type: `title`, `status`, `unique_id`, `people`, …
    pub kind: String,
    /// For a `status` property: its options and the three groups they sit in.
    pub status: Option<StatusSchema>,
    /// For a `unique_id` property: the prefix Notion puts before the number.
    pub unique_prefix: Option<String>,
    /// For a `relation` property: the data source it points into.
    pub relation_target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSchema {
    /// In Notion's own order.
    pub options: Vec<StatusOption>,
    /// To-do, In progress, Complete — in Notion's order.
    pub groups: Vec<StatusGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusOption {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusGroup {
    pub id: String,
    pub name: String,
    pub option_ids: Vec<String>,
}

/// Which property is which ticket field, by property id.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldMapping {
    pub title: Option<String>,
    pub key: Option<String>,
    pub status: Option<String>,
    pub assignee: Option<String>,
    pub labels: Option<String>,
    /// A relation into the same data source: the ticket's parent.
    pub parent: Option<String>,
}

/// A mapped field Lotus can no longer read (PLAN S19): its property is gone, or is now another type.
/// A rename is neither — the id stays — so it never shows up here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldProblem {
    /// Lotus's name for the field: `title`, `key`, `status`, `assignee`, `labels`, `parent`.
    pub field: String,
    /// The type the property has now; `None` when it is gone.
    pub now_kind: Option<String>,
}

impl FieldProblem {
    pub fn missing(field: &str) -> Self {
        Self { field: field.into(), now_kind: None }
    }

    pub fn retyped(field: &str, now_kind: &str) -> Self {
        Self { field: field.into(), now_kind: Some(now_kind.into()) }
    }
}

impl FieldMapping {
    /// Each mapped field: its name, its property id, and the type that property must have.
    fn mapped(&self) -> impl Iterator<Item = (&'static str, &str, &'static str)> {
        [
            ("title", &self.title, "title"),
            ("key", &self.key, "unique_id"),
            ("status", &self.status, "status"),
            ("assignee", &self.assignee, "people"),
            ("labels", &self.labels, "multi_select"),
            ("parent", &self.parent, "relation"),
        ]
        .into_iter()
        .filter_map(|(field, id, kind)| Some((field, id.as_deref()?, kind)))
    }

    /// The mapped fields `schema` no longer has as they were mapped.
    pub fn problems(&self, schema: &DataSourceSchema) -> Vec<FieldProblem> {
        self.mapped()
            .filter_map(|(field, id, kind)| match schema.property(id) {
                None => Some(FieldProblem::missing(field)),
                Some(p) if p.kind != kind => Some(FieldProblem::retyped(field, &p.kind)),
                // A parent must point back into this same data source (S18).
                Some(p) if field == "parent" && p.relation_target.as_deref() != Some(schema.id.as_str()) => {
                    Some(FieldProblem::retyped(field, "relation to another database"))
                }
                Some(_) => None,
            })
            .collect()
    }

    /// Whether a page, as a query returns it, still carries every mapped property with its type.
    /// Free to ask — it needs no request — so a sync asks it of every page it reads, and reads the
    /// fields again only when a page says they changed.
    pub fn fits_page(&self, page: &Value) -> bool {
        let Some(properties) = page["properties"].as_object() else { return false };
        self.mapped().all(|(_, id, kind)| {
            properties.values().any(|p| p["id"].as_str() == Some(id) && p["type"].as_str() == Some(kind))
        })
    }
}

impl DataSourceSchema {
    /// From `GET /v1/data_sources/{id}`. `properties` there is an object keyed
    /// by name, and `serde_json` reads objects in name order — so "first of a
    /// type" below means first by name, which is at least the same every time.
    pub fn from_json(v: &Value) -> Result<Self, String> {
        let id = v["id"].as_str().ok_or("Notion's data source has no id")?.to_string();
        let properties = v["properties"]
            .as_object()
            .map(|props| props.values().filter_map(PropertySchema::from_json).collect())
            .unwrap_or_default();
        Ok(Self { id, title: plain_text(&v["title"]), url: v["url"].as_str().map(str::to_string), properties })
    }

    /// The status a new ticket starts in: the first option of the To-do group (S47) — found by name,
    /// failing that the first group, as Notion lists To-do first.
    pub fn first_to_do(&self, mapping: &FieldMapping) -> Option<String> {
        let status = self.property(mapping.status.as_deref()?)?.status.as_ref()?;
        let group = status
            .groups
            .iter()
            .find(|g| g.name.eq_ignore_ascii_case("to-do") || g.name.eq_ignore_ascii_case("to do"))
            .or_else(|| status.groups.first())?;
        group.option_ids.first().cloned()
    }

    pub fn property(&self, id: &str) -> Option<&PropertySchema> {
        self.properties.iter().find(|p| p.id == id)
    }

    /// The fields found automatically (PLAN S18). The person can change any.
    ///
    /// One property per field, the first of the right type — except Parent,
    /// which must be a relation into THIS data source, so a relation to some
    /// other database is never mistaken for it.
    pub fn suggest_mapping(&self) -> FieldMapping {
        let first = |kind: &str| self.properties.iter().find(|p| p.kind == kind).map(|p| p.id.clone());
        FieldMapping {
            title: first("title"),
            key: first("unique_id"),
            status: first("status"),
            assignee: first("people"),
            labels: first("multi_select"),
            parent: self
                .properties
                .iter()
                .find(|p| p.kind == "relation" && p.relation_target.as_deref() == Some(self.id.as_str()))
                .map(|p| p.id.clone()),
        }
    }
}

impl PropertySchema {
    fn from_json(v: &Value) -> Option<Self> {
        let kind = v["type"].as_str()?.to_string();
        let config = &v[kind.as_str()];
        let status = (kind == "status").then(|| StatusSchema {
            options: config["options"]
                .as_array()
                .map(|options| {
                    options
                        .iter()
                        .filter_map(|o| {
                            Some(StatusOption {
                                id: o["id"].as_str()?.to_string(),
                                name: o["name"].as_str()?.to_string(),
                                color: o["color"].as_str().map(str::to_string),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
            groups: config["groups"]
                .as_array()
                .map(|groups| {
                    groups
                        .iter()
                        .filter_map(|g| {
                            Some(StatusGroup {
                                id: g["id"].as_str()?.to_string(),
                                name: g["name"].as_str()?.to_string(),
                                option_ids: g["option_ids"]
                                    .as_array()
                                    .map(|ids| ids.iter().filter_map(|i| i.as_str().map(str::to_string)).collect())
                                    .unwrap_or_default(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default(),
        });
        Some(Self {
            id: v["id"].as_str()?.to_string(),
            name: v["name"].as_str().unwrap_or_default().to_string(),
            status,
            unique_prefix: (kind == "unique_id").then(|| config["prefix"].as_str().map(str::to_string)).flatten(),
            relation_target: (kind == "relation").then(|| config["data_source_id"].as_str().map(str::to_string)).flatten(),
            kind,
        })
    }
}

/// A rich text array as plain text.
pub(crate) fn plain_text(v: &Value) -> String {
    v.as_array()
        .map(|items| items.iter().filter_map(|t| t["plain_text"].as_str()).collect::<String>())
        .unwrap_or_default()
        .trim()
        .to_string()
}
