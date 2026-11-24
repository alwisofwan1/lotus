// CodeCanvas Artisan Theme Engine — user/agent-authored theme storage (ADR-0023,
// Phase 3). Themes live at ~/.lotus/canvas-themes/<id>/theme.json. This is the
// trusted write boundary the `lotus_save_canvas_theme` MCP tool round-trips to.
//
// Storage is opaque JSON (a constrained token bag). Rust performs light structural
// validation so the agent gets immediate feedback on the common mistakes; the full
// schema (font whitelist, glass-when-glass, media rules) is enforced in the
// frontend loader, which skips anything invalid (canvas-theme-schema.ts).

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::Serialize;
use serde_json::Value;

use crate::error::{other, AppError};
use crate::json::{collect_json_entries, write_json};
use crate::paths::canvas_themes_dir;

#[derive(Serialize)]
pub struct SaveCanvasThemeResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<String>,
}

/// Every `<id>/theme.json` as raw JSON. The frontend validates + skips invalid ones.
pub fn list_canvas_themes() -> Vec<Value> {
    collect_json_entries(&canvas_themes_dir(), |e| e.path().join("theme.json"))
}

fn is_kebab(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Validate (lightly) + persist a theme spec. Validation failures return
/// `ok: false` with messages (data, not an error) so the caller can react; only
/// genuine IO failures surface as `Err`.
pub fn save_canvas_theme(spec: Value) -> Result<SaveCanvasThemeResult, AppError> {
    let Some(obj) = spec.as_object() else {
        return Ok(SaveCanvasThemeResult {
            ok: false,
            id: None,
            errors: vec!["theme must be a JSON object".into()],
        });
    };

    let mut errors: Vec<String> = Vec::new();
    let id = obj.get("id").and_then(Value::as_str).unwrap_or("");
    if !is_kebab(id) {
        errors.push("id must be a non-empty kebab-case string".into());
    }
    if obj.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        errors.push("schemaVersion must be 1".into());
    }
    let material = obj.get("material").and_then(Value::as_str).unwrap_or("");
    if !["glass", "solid", "grain", "paper"].contains(&material) {
        errors.push("material must be one of glass/solid/grain/paper".into());
    }
    match obj.get("palette").and_then(Value::as_object) {
        Some(palette) => {
            for role in ["accent", "agent", "task", "note", "info"] {
                let ok = palette
                    .get(role)
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty());
                if !ok {
                    errors.push(format!("palette.{role} is required"));
                }
            }
        }
        None => errors.push("palette is required".into()),
    }

    if !errors.is_empty() {
        return Ok(SaveCanvasThemeResult {
            ok: false,
            id: None,
            errors,
        });
    }

    // Stamp origin=user (never trust an authored origin), then write the file.
    let mut to_write = spec.clone();
    if let Some(map) = to_write.as_object_mut() {
        map.insert("origin".into(), Value::String("user".into()));
    }
    write_json(&canvas_themes_dir().join(id).join("theme.json"), &to_write)?;

    Ok(SaveCanvasThemeResult {
        ok: true,
        id: Some(id.to_string()),
        errors: Vec::new(),
    })
}

/// A theme media asset (paper image/video) read as a base64 data payload. The
/// frontend builds a `data:` URI — mirrors the note-assets convention (no Tauri
/// asset-protocol infrastructure exists), so it works under the static export + CSP.
#[derive(Serialize)]
pub struct CanvasThemeAsset {
    pub mime: String,
    pub base64: String,
}

fn mime_for(rel: &str) -> &'static str {
    match rel
        .rsplit('.')
        .next()
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Read a theme's media asset (relative to its `<id>/` folder) as base64.
/// Guards against path traversal — `rel` may not contain `..` or be absolute.
pub fn read_canvas_theme_asset(
    theme_id: String,
    rel: String,
) -> Result<CanvasThemeAsset, AppError> {
    if !is_kebab(&theme_id) {
        return Err(other("invalid theme id"));
    }
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(other("invalid asset path"));
    }
    let path = canvas_themes_dir().join(&theme_id).join(&rel);
    let bytes = std::fs::read(&path).map_err(AppError::Io)?;
    Ok(CanvasThemeAsset {
        mime: mime_for(&rel).to_string(),
        base64: BASE64.encode(bytes),
    })
}

/// Absolute path to a theme media asset, for the frontend to feed `convertFileSrc`
/// (asset-protocol streaming — preferred for video; supports Range requests so the
/// `<video>` element streams instead of loading the whole file). Same guards as
/// `read_canvas_theme_asset`. The path is exposed only within the assetProtocol
/// scope (`$HOME/.lotus/canvas-themes/**`), so it cannot serve arbitrary files.
pub fn canvas_theme_asset_path(theme_id: String, rel: String) -> Result<String, AppError> {
    if !is_kebab(&theme_id) {
        return Err(other("invalid theme id"));
    }
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') || rel.starts_with('\\') {
        return Err(other("invalid asset path"));
    }
    Ok(canvas_themes_dir()
        .join(&theme_id)
        .join(&rel)
        .to_string_lossy()
        .into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_traversal_and_absolute() {
        for bad in ["../secret", "a/../../etc/passwd", "/etc/passwd", ""] {
            assert!(read_canvas_theme_asset("lakeside".into(), bad.into()).is_err());
        }
    }

    #[test]
    fn rejects_bad_theme_id() {
        assert!(read_canvas_theme_asset("../evil".into(), "x.mp4".into()).is_err());
    }

    #[test]
    fn maps_known_mime_types() {
        assert_eq!(mime_for("hanami.mp4"), "video/mp4");
        assert_eq!(mime_for("a/b/poster.JPG"), "image/jpeg");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }

    #[test]
    fn asset_path_guards_traversal_and_returns_path() {
        assert!(canvas_theme_asset_path("lakeside".into(), "../x".into()).is_err());
        assert!(canvas_theme_asset_path("../evil".into(), "x.mp4".into()).is_err());
        let ok = canvas_theme_asset_path("lakeside".into(), "hanami.mp4".into()).unwrap();
        assert!(ok.ends_with("canvas-themes/lakeside/hanami.mp4"));
    }
}
