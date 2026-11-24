use crate::no_window::NoWindow;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

use crate::codecanvas_store::CodeCanvasStoreResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteAssetRow {
    pub id: String,
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "originalName")]
    pub original_name: String,
    #[serde(rename = "fileName")]
    pub file_name: String,
    pub mime: String,
    #[serde(rename = "byteSize")]
    pub byte_size: i64,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SaveNoteAssetInput {
    #[serde(rename = "projectId")]
    pub project_id: String,
    #[serde(rename = "originalName")]
    pub original_name: String,
    pub mime: String,
    pub base64: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ImportNoteAssetPathInput {
    #[serde(rename = "projectId")]
    pub project_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadNoteAssetOutput {
    pub asset: NoteAssetRow,
    pub base64: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PruneNoteAssetsOutput {
    pub deleted: Vec<NoteAssetRow>,
}

fn read_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteAssetRow> {
    Ok(NoteAssetRow {
        id: row.get(0)?,
        project_id: row.get(1)?,
        original_name: row.get(2)?,
        file_name: row.get(3)?,
        mime: row.get(4)?,
        byte_size: row.get(5)?,
        created_at: row.get(6)?,
    })
}

pub fn save_note_asset(connection: &Connection, row: &NoteAssetRow) -> CodeCanvasStoreResult<()> {
    connection.execute(
        "INSERT INTO codecanvas_note_assets
           (id, project_id, original_name, file_name, mime, byte_size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           original_name = excluded.original_name,
           file_name = excluded.file_name,
           mime = excluded.mime,
           byte_size = excluded.byte_size",
        params![
            row.id,
            row.project_id,
            row.original_name,
            row.file_name,
            row.mime,
            row.byte_size,
            row.created_at
        ],
    )?;
    Ok(())
}

pub fn list_note_assets(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<Vec<NoteAssetRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, original_name, file_name, mime, byte_size, created_at
         FROM codecanvas_note_assets WHERE project_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = statement.query_map([project_id], read_row)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_note_asset(
    connection: &Connection,
    id: &str,
) -> CodeCanvasStoreResult<Option<NoteAssetRow>> {
    let mut statement = connection.prepare(
        "SELECT id, project_id, original_name, file_name, mime, byte_size, created_at
         FROM codecanvas_note_assets WHERE id = ?1",
    )?;
    statement
        .query_row([id], read_row)
        .optional()
        .map_err(Into::into)
}

pub fn delete_note_asset_row(connection: &Connection, id: &str) -> CodeCanvasStoreResult<()> {
    connection.execute("DELETE FROM codecanvas_note_assets WHERE id = ?1", [id])?;
    Ok(())
}

pub fn referenced_note_asset_ids(
    connection: &Connection,
    project_id: &str,
) -> CodeCanvasStoreResult<HashSet<String>> {
    let nodes: Option<String> = connection
        .query_row(
            "SELECT nodes_json FROM codecanvas_snapshots WHERE project_id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(nodes) = nodes else {
        return Ok(HashSet::new());
    };
    let value: Value = serde_json::from_str(&nodes).unwrap_or(Value::Null);
    let mut refs = HashSet::new();
    collect_asset_refs(&value, &mut refs);
    Ok(refs)
}

pub fn delete_note_asset(
    connection: &Connection,
    root: &Path,
    asset_id: &str,
    force: bool,
) -> CodeCanvasStoreResult<Option<NoteAssetRow>> {
    let Some(asset) = get_note_asset(connection, asset_id)? else {
        return Ok(None);
    };
    if !force && referenced_note_asset_ids(connection, &asset.project_id)?.contains(asset_id) {
        return Err(crate::codecanvas_store::CodeCanvasStoreError::Path(
            "Note Asset is still referenced by a note".into(),
        ));
    }
    delete_note_asset_file(root, &asset)?;
    delete_note_asset_row(connection, asset_id)?;
    Ok(Some(asset))
}

pub fn prune_unused_note_assets(
    connection: &Connection,
    root: &Path,
    project_id: &str,
) -> CodeCanvasStoreResult<PruneNoteAssetsOutput> {
    let referenced = referenced_note_asset_ids(connection, project_id)?;
    let mut deleted = Vec::new();
    for asset in list_note_assets(connection, project_id)? {
        if referenced.contains(&asset.id) {
            continue;
        }
        delete_note_asset_file(root, &asset)?;
        delete_note_asset_row(connection, &asset.id)?;
        deleted.push(asset);
    }
    Ok(PruneNoteAssetsOutput { deleted })
}

pub fn assets_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("codecanvas-assets")
}

pub fn save_note_asset_bytes(
    root: &Path,
    input: SaveNoteAssetInput,
) -> Result<NoteAssetRow, String> {
    let bytes = BASE64
        .decode(input.base64.as_bytes())
        .map_err(|err| err.to_string())?;
    write_asset_bytes(
        root,
        input.project_id,
        input.original_name,
        input.mime,
        &bytes,
    )
}

pub fn import_note_asset_path(
    root: &Path,
    input: ImportNoteAssetPathInput,
) -> Result<NoteAssetRow, String> {
    let source = PathBuf::from(input.path);
    let original_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Imported Note Asset path has no file name".to_string())?
        .to_string();
    let mime = mime_for(&original_name)
        .ok_or_else(|| "Only image files can become Note Assets".to_string())?
        .to_string();
    let bytes = fs::read(source).map_err(|err| err.to_string())?;
    write_asset_bytes(root, input.project_id, original_name, mime, &bytes)
}

fn write_asset_bytes(
    root: &Path,
    project_id: String,
    original_name: String,
    mime: String,
    bytes: &[u8],
) -> Result<NoteAssetRow, String> {
    let id = format!("asset_{}", Uuid::new_v4().simple());
    let file_name = format!("{}.{}", id, extension_for(&original_name, &mime));
    let dir = root.join(&project_id);
    fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    fs::write(dir.join(&file_name), bytes).map_err(|err| err.to_string())?;
    Ok(NoteAssetRow {
        id,
        project_id,
        original_name,
        file_name,
        mime,
        byte_size: bytes.len() as i64,
        created_at: now_ms(),
    })
}

pub fn read_note_asset_bytes(
    root: &Path,
    asset: NoteAssetRow,
) -> Result<ReadNoteAssetOutput, String> {
    let path = note_asset_path(root, &asset);
    let bytes = fs::read(path).map_err(|err| err.to_string())?;
    Ok(ReadNoteAssetOutput {
        asset,
        base64: BASE64.encode(bytes),
    })
}

pub fn note_asset_path(root: &Path, asset: &NoteAssetRow) -> PathBuf {
    root.join(&asset.project_id).join(&asset.file_name)
}

/// A clean, readable, space-free file name for handing an asset to an agent prompt:
/// `<sanitized original stem>-<short id>.<ext>`. The short id keeps it collision-free while the
/// original stem keeps it recognizable (vs the opaque `asset_<uuid>` on-disk name).
pub fn agent_drop_file_name(asset: &NoteAssetRow) -> String {
    let ext = Path::new(&asset.file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let stem_src = Path::new(&asset.original_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let mut stem = String::new();
    let mut prev_dash = false;
    for ch in stem_src.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            stem.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            stem.push('-');
            prev_dash = true;
        }
    }
    let stem = stem.trim_matches('-');
    let stem = if stem.is_empty() { "image" } else { stem };
    let short: String = asset
        .id
        .trim_start_matches("asset_")
        .chars()
        .take(8)
        .collect();
    format!("{stem}-{short}.{ext}")
}

/// Copy an asset into a space-free "agent drops" directory under a clean name, returning the
/// destination path. Deterministic per asset (idempotent re-drops). The caller passes the drops
/// root (`~/.lotus/agent-drops`) — space-free, unlike the app-data assets dir on macOS.
pub fn stage_asset_for_agent(
    source: &Path,
    drops_dir: &Path,
    asset: &NoteAssetRow,
) -> Result<PathBuf, String> {
    fs::create_dir_all(drops_dir).map_err(|err| err.to_string())?;
    let dest = drops_dir.join(agent_drop_file_name(asset));
    fs::copy(source, &dest).map_err(|err| err.to_string())?;
    Ok(dest)
}

pub fn project_asset_dir(root: &Path, project_id: &str) -> PathBuf {
    root.join(project_id)
}

pub fn delete_note_asset_file(root: &Path, asset: &NoteAssetRow) -> CodeCanvasStoreResult<()> {
    let path = note_asset_path(root, asset);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub fn remove_project_asset_dir(root: &Path, project_id: &str) -> CodeCanvasStoreResult<()> {
    let dir = project_asset_dir(root, project_id);
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

pub fn reveal_path(path: &Path, select_file: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let status = if select_file {
        Command::new("open").no_window().arg("-R").arg(path).status()
    } else {
        Command::new("open").no_window().arg(path).status()
    };

    #[cfg(target_os = "windows")]
    let status = if select_file {
        Command::new("explorer")
            .no_window()
            .arg(format!("/select,{}", path.display()))
            .status()
    } else {
        Command::new("explorer").no_window().arg(path).status()
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .no_window()
        .arg(if select_file {
            path.parent().unwrap_or(path)
        } else {
            path
        })
        .status();

    status.map_err(|err| err.to_string()).and_then(|status| {
        if status.success() {
            Ok(())
        } else {
            Err(format!("reveal command exited with {status}"))
        }
    })
}

fn collect_asset_refs(value: &Value, refs: &mut HashSet<String>) {
    match value {
        Value::String(text) => collect_asset_refs_from_text(text, refs),
        Value::Array(items) => items.iter().for_each(|item| collect_asset_refs(item, refs)),
        Value::Object(map) => map.values().for_each(|item| collect_asset_refs(item, refs)),
        _ => {}
    }
}

fn collect_asset_refs_from_text(text: &str, refs: &mut HashSet<String>) {
    let mut rest = text;
    while let Some(start) = rest.find("lotus-note-asset://") {
        let after = &rest[start + "lotus-note-asset://".len()..];
        let id: String = after
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
            .collect();
        let len = id.len();
        if !id.is_empty() {
            refs.insert(id);
        }
        rest = &after[len..];
    }
}

fn mime_for(original_name: &str) -> Option<&'static str> {
    let lower = original_name.to_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        Some("image/jpeg")
    } else if lower.ends_with(".gif") {
        Some("image/gif")
    } else if lower.ends_with(".webp") {
        Some("image/webp")
    } else if lower.ends_with(".svg") {
        Some("image/svg+xml")
    } else if lower.ends_with(".png") {
        Some("image/png")
    } else {
        None
    }
}

fn extension_for(original_name: &str, mime: &str) -> &'static str {
    let lower = original_name.to_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "jpg"
    } else if lower.ends_with(".gif") {
        "gif"
    } else if lower.ends_with(".webp") {
        "webp"
    } else if lower.ends_with(".svg") {
        "svg"
    } else if mime == "image/jpeg" {
        "jpg"
    } else if mime == "image/gif" {
        "gif"
    } else if mime == "image/webp" {
        "webp"
    } else if mime == "image/svg+xml" {
        "svg"
    } else {
        "png"
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, original: &str, file: &str) -> NoteAssetRow {
        NoteAssetRow {
            id: id.into(),
            project_id: "cp_x".into(),
            original_name: original.into(),
            file_name: file.into(),
            mime: "image/png".into(),
            byte_size: 1,
            created_at: 0,
        }
    }

    #[test]
    fn agent_drop_name_is_clean_readable_and_unique() {
        // Spaces + punctuation → dashes; opaque uuid → short suffix; ext from the stored file.
        assert_eq!(
            agent_drop_file_name(&row(
                "asset_64ebe507de144deb85cdbc2631857ce6",
                "Kajian Subuh Berkah.png",
                "asset_64ebe507de144deb85cdbc2631857ce6.png"
            )),
            "Kajian-Subuh-Berkah-64ebe507.png",
        );
        // Empty/odd original name falls back to "image".
        assert_eq!(
            agent_drop_file_name(&row("asset_abcdef12", "  .png", "asset_abcdef12.jpg")),
            "image-abcdef12.jpg",
        );
    }
}
