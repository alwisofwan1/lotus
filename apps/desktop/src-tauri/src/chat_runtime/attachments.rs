//! What a chat message can carry (#279, mockup page "04e Attachments", board B). Images go to the
//! provider as pictures and are read by the bridge; any other file goes by its path. Dropped and
//! picked files keep their own path, so Claude edits the user's file, not a copy. Only pasted
//! content has no file, and is saved under `<state dir>/chat-attachments/<thread>/`.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};

/// The API's limit for one image.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// A file copied to another machine (ADR-0069); the host refuses more.
pub const MAX_REMOTE_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// All of one message's copies together (decision 4).
pub const MAX_REMOTE_MESSAGE_BYTES: u64 = 25 * 1024 * 1024;
const IMAGE_MIME_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentKind {
    Image,
    File,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub kind: AttachmentKind,
    pub path: String,
    pub name: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<u64>,
    /// Where it is on the chat's machine, once there; `path` stays this Mac's copy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
}

/// Checks what the webview sent before it reaches the bridge: a real file, and an image Claude can
/// take. Returns the attachment with its size as the disk says, not as the webview said.
pub fn checked(attachment: Attachment) -> Result<Attachment, String> {
    let path = Path::new(&attachment.path);
    if !path.is_absolute() {
        return Err(format!("{} is not a full path", attachment.name));
    }
    let meta = std::fs::metadata(path).map_err(|_| format!("{} is no longer there", attachment.name))?;
    if !meta.is_file() {
        return Err(format!("{} is a folder; attach files", attachment.name));
    }
    if attachment.kind == AttachmentKind::Image {
        let known = attachment.mime_type.as_deref().is_some_and(|m| IMAGE_MIME_TYPES.contains(&m));
        if !known {
            return Err(format!("{}: Claude takes PNG, JPEG, GIF or WebP images", attachment.name));
        }
        if meta.len() > MAX_IMAGE_BYTES {
            return Err(format!("{} is too large; images go up to 5 MB", attachment.name));
        }
    }
    Ok(Attachment { size_bytes: Some(meta.len()), ..attachment })
}

/// Saves pasted content, which has no file of its own, and returns it as an attachment. The folder
/// goes when no chat names it any more (`reap_unused`).
pub fn save_pasted(dir: &Path, name: &str, mime_type: Option<String>, data_base64: &str) -> Result<Attachment, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("pasted data is not base64: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    // Only the last path segment of the name, so a crafted name cannot write outside `dir`.
    let safe: String = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .unwrap_or_else(|| "pasted".into());
    let path: PathBuf = dir.join(format!("{}-{safe}", &uuid::Uuid::new_v4().to_string()[..8]));
    std::fs::write(&path, &bytes).map_err(|e| format!("write {}: {e}", path.display()))?;
    let kind = if mime_type.as_deref().is_some_and(|m| IMAGE_MIME_TYPES.contains(&m)) {
        AttachmentKind::Image
    } else {
        AttachmentKind::File
    };
    Ok(Attachment {
        kind,
        path: path.display().to_string(),
        name: safe,
        mime_type,
        size_bytes: Some(bytes.len() as u64),
        remote: None,
    })
}

/// A data URL for an image thumbnail; only image files Claude could take.
pub fn preview(path: &str) -> Result<String, String> {
    let lower = path.to_ascii_lowercase();
    let mime = [("png", "image/png"), ("jpg", "image/jpeg"), ("jpeg", "image/jpeg"), ("gif", "image/gif"), ("webp", "image/webp")]
        .iter()
        .find(|(ext, _)| lower.ends_with(&format!(".{ext}")))
        .map(|(_, mime)| *mime)
        .ok_or("not an image")?;
    let meta = std::fs::metadata(path).map_err(|_| "no longer there".to_string())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("too large to preview".into());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

const DIR: &str = "chat-attachments";

/// Adds every `chat-attachments/<id>` folder named in `text` (an event's JSON: `/` on macOS, an
/// escaped `\\` on Windows) to `out`.
pub fn named_dirs(text: &str, out: &mut HashSet<String>) {
    for (at, _) in text.match_indices(DIR) {
        let rest = text[at + DIR.len()..].trim_start_matches(['/', '\\']);
        if let Some(id) = rest.get(..36).filter(|id| uuid::Uuid::parse_str(id).is_ok()) {
            out.insert(id.to_string());
        }
    }
}

/// Removes the folders under `root` that no chat uses: not in `in_use` (thread ids and the folders
/// events name). With `only`, just those ids, at any age (a chat just deleted). Otherwise every
/// folder untouched for `min_age`, so a new chat's draft being written now stays. Only folders named
/// by a UUID are ever touched. Returns what was removed.
pub fn reap_unused(root: &Path, in_use: &HashSet<String>, only: Option<&[String]>, min_age: Duration) -> Vec<PathBuf> {
    let candidates: Vec<PathBuf> = match only {
        Some(ids) => ids.iter().map(|id| root.join(id)).filter(|p| p.is_dir()).collect(),
        None => std::fs::read_dir(root).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect(),
    };
    let stale = |path: &Path| {
        only.is_some()
            || std::fs::metadata(path).and_then(|m| m.modified()).is_ok_and(|t| t.elapsed().unwrap_or_default() >= min_age)
    };
    let mut removed = Vec::new();
    for path in candidates {
        let Some(id) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if uuid::Uuid::parse_str(id).is_err() || in_use.contains(id) || !stale(&path) {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed.push(path),
            Err(e) => eprintln!("[chat-runtime] kept attachments {}: {e}", path.display()),
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(path: &Path) -> Attachment {
        Attachment {
            kind: AttachmentKind::Image,
            path: path.display().to_string(),
            name: "shot.png".into(),
            mime_type: Some("image/png".into()),
            size_bytes: Some(1),
            remote: None,
        }
    }

    #[test]
    fn checks_the_file_on_disk_not_what_the_webview_said() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("shot.png");
        std::fs::write(&file, b"12345").unwrap();
        assert_eq!(checked(image(&file)).unwrap().size_bytes, Some(5));

        assert!(checked(image(&dir.path().join("gone.png"))).unwrap_err().contains("no longer there"));
        assert!(checked(image(dir.path())).unwrap_err().contains("folder"));
        assert!(checked(Attachment { mime_type: Some("image/heic".into()), ..image(&file) }).is_err());
        assert!(checked(Attachment { path: "shot.png".into(), ..image(&file) }).is_err());

        std::fs::write(&file, vec![0u8; MAX_IMAGE_BYTES as usize + 1]).unwrap();
        assert!(checked(image(&file)).unwrap_err().contains("too large"));
        // Any size is fine for a file Claude reads by its path.
        assert!(checked(Attachment { kind: AttachmentKind::File, ..image(&file) }).is_ok());
    }

    #[test]
    fn a_pasted_name_cannot_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let saved = save_pasted(dir.path(), "../../escape.png", Some("image/png".into()), "aGk=").unwrap();
        assert_eq!(saved.kind, AttachmentKind::Image);
        assert_eq!(saved.name, "escape.png");
        assert!(Path::new(&saved.path).starts_with(dir.path()));
        assert_eq!(std::fs::read(&saved.path).unwrap(), b"hi");
        assert_eq!(preview(&saved.path).unwrap(), "data:image/png;base64,aGk=");
    }

    #[test]
    fn finds_the_folders_an_event_names() {
        let (a, b) = ("0837d63e-57f8-485e-8660-9f0a5892cc5c", "194def46-768b-4941-afff-904d6d3a99b0");
        let mut out = HashSet::new();
        named_dirs(&format!(r#"{{"path":"/Users/x/.lotus/chat-attachments/{a}/2a00dedd-div.png"}}"#), &mut out);
        named_dirs(&format!(r#"{{"path":"C:\\Users\\x\\chat-attachments\\{b}\\shot.png"}}"#), &mut out);
        named_dirs("chat-attachments/not-a-uuid and chat-attachments/ at the end chat-attachments", &mut out);
        assert_eq!(out, HashSet::from([a.to_string(), b.to_string()]));
    }

    #[test]
    fn removes_only_folders_no_chat_uses() {
        let root = tempfile::tempdir().unwrap();
        let ids: Vec<String> = (0..3).map(|_| uuid::Uuid::new_v4().to_string()).collect();
        for name in ids.iter().map(String::as_str).chain(["not-a-uuid"]) {
            std::fs::create_dir_all(root.path().join(name)).unwrap();
            std::fs::write(root.path().join(name).join("f"), b"x").unwrap();
        }
        let in_use = HashSet::from([ids[0].clone()]);

        // Too new: a draft may still be filling it.
        assert!(reap_unused(root.path(), &in_use, None, Duration::from_secs(3600)).is_empty());
        // Named: removed at any age, unless something still uses it.
        assert_eq!(reap_unused(root.path(), &in_use, Some(&[ids[0].clone(), ids[1].clone()]), Duration::MAX).len(), 1);
        assert!(root.path().join(&ids[0]).exists() && !root.path().join(&ids[1]).exists());

        assert_eq!(reap_unused(root.path(), &in_use, None, Duration::ZERO), vec![root.path().join(&ids[2])]);
        assert!(root.path().join(&ids[0]).exists() && root.path().join("not-a-uuid").exists());
    }
}
