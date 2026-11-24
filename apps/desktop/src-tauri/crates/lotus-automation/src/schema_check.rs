//! Checks a value against the small JSON Schema subset the action kinds use
//! for an agent's reply: `type` (object, array, string, integer), `required`,
//! `properties`, `additionalProperties: false`, `minProperties`, `maxProperties`, `maxLength`, `maxItems`,
//! `minimum`, and a string `enum`. Used where a pane run's agent submits, so
//! it hears what is wrong while it can still fix it. Not a general validator:
//! a keyword outside the subset is ignored, and each action re-checks the
//! reply on its own anyway.

use serde_json::Value;

/// `Err` names the first field at fault, e.g. `comments[0].line: must be at least 1`.
pub fn check(schema: &Value, value: &Value) -> Result<(), String> {
    at(schema, value, "")
}

fn at(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let name = if path.is_empty() { "result" } else { path };
    match schema["type"].as_str() {
        Some("object") => {
            let object = value.as_object().ok_or_else(|| format!("{name}: must be an object"))?;
            let properties = schema["properties"].as_object();
            let fields = || properties.map(|p| p.keys().map(String::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            if let Some(min) = schema["minProperties"].as_u64() {
                if (object.len() as u64) < min {
                    return Err(format!("{name}: needs at least {min} of: {}", fields()));
                }
            }
            if let Some(max) = schema["maxProperties"].as_u64() {
                if object.len() as u64 > max {
                    return Err(format!("{name}: at most {max} of: {}, got {}", fields(), object.len()));
                }
            }
            for key in schema["required"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("{}: is required", join(path, key)));
                }
            }
            for (key, field) in object {
                match properties.and_then(|p| p.get(key)) {
                    Some(sub) => at(sub, field, &join(path, key))?,
                    None if schema["additionalProperties"] == Value::Bool(false) => {
                        return Err(format!("{}: is not a field this result has", join(path, key)));
                    }
                    None => {}
                }
            }
        }
        Some("array") => {
            let items = value.as_array().ok_or_else(|| format!("{name}: must be a list"))?;
            if let Some(max) = schema["maxItems"].as_u64() {
                if items.len() as u64 > max {
                    return Err(format!("{name}: at most {max} items, got {}", items.len()));
                }
            }
            for (i, item) in items.iter().enumerate() {
                at(&schema["items"], item, &format!("{name}[{i}]"))?;
            }
        }
        Some("string") => {
            let text = value.as_str().ok_or_else(|| format!("{name}: must be text"))?;
            if let Some(max) = schema["maxLength"].as_u64() {
                let len = text.chars().count() as u64;
                if len > max {
                    return Err(format!("{name}: at most {max} characters, got {len}"));
                }
            }
            if let Some(allowed) = schema["enum"].as_array() {
                if !allowed.iter().any(|a| a.as_str() == Some(text)) {
                    let names: Vec<&str> = allowed.iter().filter_map(Value::as_str).collect();
                    return Err(format!("{name}: must be one of {}, got {text:?}", names.join(", ")));
                }
            }
        }
        Some("integer") => {
            let n = value.as_i64().ok_or_else(|| format!("{name}: must be a whole number"))?;
            if let Some(min) = schema["minimum"].as_i64() {
                if n < min {
                    return Err(format!("{name}: must be at least {min}"));
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn join(path: &str, key: &str) -> String {
    if path.is_empty() { key.to_string() } else { format!("{path}.{key}") }
}
