use crate::AppError;
use std::fs::OpenOptions;
use std::path::{Component, Path, PathBuf};

const MAX_EDITOR_FILE_SIZE_BYTES: u64 = 10 * 1024 * 1024;
/// The cap once the user chose "Open anyway" on a large file. Monaco turns its heavy features
/// off past ~20 MB by itself (`largeFileOptimizations`); past this it is no longer usable.
pub const MAX_EDITOR_LARGE_FILE_SIZE_BYTES: u64 = 50 * 1024 * 1024;
/// The media viewer's cap (images, audio, video). Larger than the text cap: the bytes go straight
/// to a Blob for an `<img>`/`<video>`, never into a text buffer or a Monaco model.
pub const MAX_EDITOR_MEDIA_SIZE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_LISTED_ENTRIES: usize = 10000;
/// Never shown, as VS Code's default `files.exclude`: version-control internals and OS litter.
/// Everything else is shown — the tree used to drop every dot-folder (`.claude`, `.github`,
/// `.lotus`) and every folder below by name, so a repo's own config was simply not there.
const HIDDEN_ENTRIES: &[&str] = &[".git", ".svn", ".hg", ".DS_Store", "Thumbs.db"];
/// Shown, but marked `ignored` (drawn dimmed), never walked by a multi-level listing, and left
/// out of the Go-to-file index: build output and dependency folders that dwarf the source.
const HEAVY_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".next",
    "out",
    "dist",
    "build",
    "target",
    ".turbo",
    ".cache",
    "coverage",
    ".venv",
    "__pycache__",
    ".dart_tool",
    ".gradle",
];

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorReadFileResult {
    pub content: String,
    pub mtime: i64,
    pub size_bytes: u64,
    pub binary: bool,
    /// How the text is stored on disk (`editor_encoding` ids); the save writes it back so.
    pub encoding: String,
    /// Not read because of its size (`binary` is set too). With `allow_large` it can be.
    pub too_large: bool,
}

impl EditorReadFileResult {
    /// What a read returns for bytes it will not show as text.
    pub fn not_text(mtime: i64, size_bytes: u64, too_large: bool) -> Self {
        Self {
            content: String::new(),
            mtime,
            size_bytes,
            binary: true,
            encoding: crate::editor_encoding::UTF8.to_string(),
            too_large,
        }
    }

    /// Text when the bytes decode as text, binary otherwise.
    pub fn from_bytes(bytes: &[u8], mtime: i64, size_bytes: u64) -> Self {
        match crate::editor_encoding::decode(bytes) {
            Some(text) => Self {
                content: text.content,
                mtime,
                size_bytes,
                binary: false,
                encoding: text.encoding.to_string(),
                too_large: false,
            },
            None => Self::not_text(mtime, size_bytes, false),
        }
    }
}

/// The largest file a read returns as text: 10 MB, or 50 MB after "Open anyway".
pub fn text_size_cap(allow_large: bool) -> u64 {
    if allow_large {
        MAX_EDITOR_LARGE_FILE_SIZE_BYTES
    } else {
        MAX_EDITOR_FILE_SIZE_BYTES
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorWriteFileResult {
    pub mtime: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorCreateEntryResult {
    pub path: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorListEntry {
    pub path: String,
    pub kind: EditorListEntryKind,
    /// Git-ignored, or a heavy folder (see `HEAVY_DIRECTORIES`). The tree dims it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub ignored: bool,
}

#[derive(Debug, Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EditorListEntryKind {
    File,
    Directory,
}

fn file_mtime(path: &Path) -> Result<i64, AppError> {
    let metadata = std::fs::metadata(path).map_err(|err| AppError::Other(err.to_string()))?;
    let modified = metadata
        .modified()
        .map_err(|err| AppError::Other(err.to_string()))?;
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| AppError::Other(err.to_string()))?;
    Ok(duration.as_millis() as i64)
}

fn resolve_workspace_child(root: &str, relative_path: &str) -> Result<PathBuf, AppError> {
    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {root}")));
    }

    let relative_path = relative_path.trim().replace('\\', "/");
    let candidate = Path::new(&relative_path);
    if relative_path.is_empty() || candidate.is_absolute() {
        return Err(AppError::Other(
            "Path must be relative to the workspace".to_string(),
        ));
    }

    let mut clean = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(AppError::Other(
                    "Path must stay inside the workspace".to_string(),
                ));
            }
        }
    }

    if clean.as_os_str().is_empty() {
        return Err(AppError::Other("Path cannot be empty".to_string()));
    }

    Ok(root_path.join(clean))
}

/// An existing entry inside `root`, for commands that act on it outside Lotus (Reveal in Finder).
pub fn resolve_workspace_entry(root: &str, relative_path: &str) -> Result<PathBuf, AppError> {
    let path = resolve_workspace_child(root, relative_path)?;
    if std::fs::symlink_metadata(&path).is_err() {
        return Err(AppError::Other(format!(
            "Path does not exist: {}",
            path.to_string_lossy()
        )));
    }
    Ok(path)
}

pub fn editor_create_file(
    root: String,
    relative_path: String,
) -> Result<EditorCreateEntryResult, AppError> {
    let file_path = resolve_workspace_child(&root, &relative_path)?;
    if file_path.exists() {
        return Err(AppError::Other(format!(
            "Path already exists: {}",
            file_path.to_string_lossy()
        )));
    }

    if let Some(parent) = file_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| AppError::Other(err.to_string()))?;
    }

    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file_path)
        .map_err(|err| AppError::Other(err.to_string()))?;

    Ok(EditorCreateEntryResult {
        path: file_path.to_string_lossy().to_string(),
    })
}

pub fn editor_create_directory(
    root: String,
    relative_path: String,
) -> Result<EditorCreateEntryResult, AppError> {
    let directory_path = resolve_workspace_child(&root, &relative_path)?;
    if directory_path.exists() {
        return Err(AppError::Other(format!(
            "Path already exists: {}",
            directory_path.to_string_lossy()
        )));
    }

    std::fs::create_dir_all(&directory_path).map_err(|err| AppError::Other(err.to_string()))?;

    Ok(EditorCreateEntryResult {
        path: directory_path.to_string_lossy().to_string(),
    })
}

pub fn editor_delete_entry(
    root: String,
    relative_path: String,
) -> Result<EditorCreateEntryResult, AppError> {
    let entry_path = resolve_workspace_child(&root, &relative_path)?;
    let metadata =
        std::fs::symlink_metadata(&entry_path).map_err(|err| AppError::Other(err.to_string()))?;
    let file_type = metadata.file_type();

    if file_type.is_dir() {
        std::fs::remove_dir_all(&entry_path).map_err(|err| AppError::Other(err.to_string()))?;
    } else {
        std::fs::remove_file(&entry_path).map_err(|err| AppError::Other(err.to_string()))?;
    }

    Ok(EditorCreateEntryResult {
        path: entry_path.to_string_lossy().to_string(),
    })
}

/// Moves an entry to the Trash, where Finder can put it back. macOS only: elsewhere it is refused
/// rather than deleted for good.
pub fn editor_trash_entry(
    root: String,
    relative_path: String,
) -> Result<EditorCreateEntryResult, AppError> {
    let entry_path = resolve_workspace_entry(&root, &relative_path)?;
    move_to_trash(&entry_path)?;
    Ok(EditorCreateEntryResult {
        path: entry_path.to_string_lossy().to_string(),
    })
}

#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> Result<(), AppError> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|err| AppError::Other(err.localizedDescription().to_string()))
}

#[cfg(not(target_os = "macos"))]
fn move_to_trash(_path: &Path) -> Result<(), AppError> {
    Err(AppError::Other("Move to Trash is only available on macOS".to_string()))
}

#[cfg(unix)]
fn same_entry(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::symlink_metadata(left), std::fs::symlink_metadata(right)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn same_entry(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

pub fn editor_rename_entry(
    root: String,
    from_relative_path: String,
    to_relative_path: String,
) -> Result<EditorCreateEntryResult, AppError> {
    let from_path = resolve_workspace_child(&root, &from_relative_path)?;
    let to_path = resolve_workspace_child(&root, &to_relative_path)?;
    if !from_path.exists() {
        return Err(AppError::Other(format!(
            "Path does not exist: {}",
            from_path.to_string_lossy()
        )));
    }
    // On a case-insensitive disk (the macOS default) `readme.md` → `README.md` finds the source
    // itself at the target. That is a rename, not an overwrite.
    let case_only = from_relative_path.to_lowercase() == to_relative_path.to_lowercase()
        && from_relative_path != to_relative_path;
    if to_path.exists() && !(case_only && same_entry(&from_path, &to_path)) {
        return Err(AppError::Other(format!(
            "Path already exists: {}",
            to_path.to_string_lossy()
        )));
    }
    if let Some(parent) = to_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| AppError::Other(err.to_string()))?;
    }
    std::fs::rename(&from_path, &to_path).map_err(|err| AppError::Other(err.to_string()))?;
    Ok(EditorCreateEntryResult {
        path: to_path.to_string_lossy().to_string(),
    })
}

pub fn editor_read_file(path: String, allow_large: bool) -> Result<EditorReadFileResult, AppError> {
    let file_path = Path::new(&path);
    let metadata = std::fs::metadata(file_path).map_err(|err| AppError::Other(err.to_string()))?;

    if !metadata.is_file() {
        return Err(AppError::Other(format!("Not a file: {path}")));
    }

    let size_bytes = metadata.len();
    if size_bytes > text_size_cap(allow_large) {
        return Ok(EditorReadFileResult::not_text(
            file_mtime(file_path)?,
            size_bytes,
            true,
        ));
    }

    let raw = std::fs::read(file_path).map_err(|err| AppError::Other(err.to_string()))?;
    Ok(EditorReadFileResult::from_bytes(
        &raw,
        file_mtime(file_path)?,
        size_bytes,
    ))
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileStat {
    pub mtime: i64,
    /// Birth time; None where the filesystem keeps none.
    pub created: Option<i64>,
    pub size_bytes: u64,
}

/// Times and size only, for a chat's file cards: no read, so a big file costs the same as a small one.
pub fn editor_stat_file(path: String) -> Result<EditorFileStat, AppError> {
    let metadata = std::fs::metadata(&path).map_err(|err| AppError::Other(err.to_string()))?;
    if !metadata.is_file() {
        return Err(AppError::Other(format!("Not a file: {path}")));
    }
    let ms = |time: std::io::Result<std::time::SystemTime>| {
        time.ok()?.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_millis() as i64)
    };
    Ok(EditorFileStat {
        mtime: ms(metadata.modified()).ok_or_else(|| AppError::Other(format!("No mtime: {path}")))?,
        created: ms(metadata.created()),
        size_bytes: metadata.len(),
    })
}

/// The last `lines` lines of a file, for a log too large to read whole. Reads back from the end
/// and never more than `MAX_EDITOR_FILE_SIZE_BYTES`; a cut-off first line is dropped. `size_bytes`
/// is the whole file's, so the caller can tell how much was left out.
pub fn editor_read_file_tail(path: String, lines: usize) -> Result<EditorReadFileResult, AppError> {
    use std::io::{Read, Seek, SeekFrom};
    let io = |err: std::io::Error| AppError::Other(err.to_string());
    let file_path = Path::new(&path);
    let mut file = std::fs::File::open(file_path).map_err(io)?;
    let metadata = file.metadata().map_err(io)?;
    if !metadata.is_file() {
        return Err(AppError::Other(format!("Not a file: {path}")));
    }
    let size = metadata.len();
    let floor = size.saturating_sub(MAX_EDITOR_FILE_SIZE_BYTES);
    let mut start = size;
    let mut tail: Vec<u8> = Vec::new();
    // A newline that ends the file ends its last line; it does not start another.
    let mut newlines = 0usize;
    while start > floor && newlines <= lines {
        let step = (64 * 1024).min(start - floor);
        start -= step;
        let mut chunk = vec![0u8; step as usize];
        file.seek(SeekFrom::Start(start)).map_err(io)?;
        file.read_exact(&mut chunk).map_err(io)?;
        newlines += chunk.iter().filter(|b| **b == b'\n').count();
        chunk.extend_from_slice(&tail);
        tail = chunk;
    }
    let body = tail.strip_suffix(b"\n").unwrap_or(&tail);
    let mut cut = 0;
    let mut seen = 0;
    for (at, byte) in body.iter().enumerate().rev() {
        if *byte == b'\n' {
            seen += 1;
            if seen == lines {
                cut = at + 1;
                break;
            }
        }
    }
    // Stopped early or at the cap: the first line read is only part of one.
    if cut == 0 && start > 0 {
        cut = body.iter().position(|b| *b == b'\n').map_or(body.len(), |at| at + 1);
    }
    Ok(EditorReadFileResult::from_bytes(&tail[cut..], file_mtime(file_path)?, size))
}

/// The raw bytes of a file, for the media viewer. Refuses anything over
/// `MAX_EDITOR_MEDIA_SIZE_BYTES` instead of reading it.
pub fn editor_read_file_bytes(path: String) -> Result<Vec<u8>, AppError> {
    let file_path = Path::new(&path);
    let metadata = std::fs::metadata(file_path).map_err(|err| AppError::Other(err.to_string()))?;
    if !metadata.is_file() {
        return Err(AppError::Other(format!("Not a file: {path}")));
    }
    if metadata.len() > MAX_EDITOR_MEDIA_SIZE_BYTES {
        return Err(AppError::Other(format!(
            "File is too large to preview ({} bytes, limit {MAX_EDITOR_MEDIA_SIZE_BYTES})",
            metadata.len()
        )));
    }
    std::fs::read(file_path).map_err(|err| AppError::Other(err.to_string()))
}

pub fn editor_write_file(
    path: String,
    content: String,
    expected_mtime: Option<i64>,
    encoding: Option<String>,
) -> Result<EditorWriteFileResult, AppError> {
    let file_path = Path::new(&path);
    let bytes = crate::editor_encoding::encode(&content, encoding.as_deref())?;
    match std::fs::metadata(file_path) {
        Ok(metadata) if !metadata.is_file() => {
            return Err(AppError::Other(format!("Not a file: {path}")));
        }
        Ok(_) => {
            if let Some(expected) = expected_mtime {
                let current = file_mtime(file_path)?;
                if current != expected {
                    return Err(AppError::Other("File has changed on disk".to_string()));
                }
            }
        }
        // Deleted on disk while open: saving puts it back, as in VS Code. Its folder must
        // still be there; a save does not quietly rebuild a deleted tree.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(AppError::Other(err.to_string())),
    }

    write_file_atomically(file_path, &bytes).map_err(|err| AppError::Other(err.to_string()))?;
    Ok(EditorWriteFileResult {
        mtime: file_mtime(file_path)?,
    })
}

/// Saves without a window where the file is half written: the bytes go to a temp file beside
/// the target, are flushed to disk, and only then replace it in one `rename`. A crash, a full
/// disk or a power cut mid-save leaves the old file whole (a plain `fs::write` truncates first).
///
/// A symlink is followed, so the link stays a link and its target gets the new text; the
/// target's permissions (an executable script stays executable) carry over to the new file.
/// A file that is not there (deleted on disk) is created in its folder.
pub(crate) fn write_file_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;

    let target = match std::fs::canonicalize(path) {
        Ok(target) => target,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| std::io::Error::other("The file has no parent folder"))?;
            let name = path
                .file_name()
                .ok_or_else(|| std::io::Error::other("The path has no file name"))?;
            std::fs::canonicalize(parent)?.join(name)
        }
        Err(err) => return Err(err),
    };
    let directory = target
        .parent()
        .ok_or_else(|| std::io::Error::other("The file has no parent folder"))?;
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let permissions = std::fs::metadata(&target).ok().map(|metadata| metadata.permissions());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    // `.lotus.tmp.` in the name: the editor watcher drops it as scratch (`editor_watcher.rs`).
    let temp = directory.join(format!(".{name}.lotus.tmp.{}-{nonce}", std::process::id()));

    let result = (|| {
        let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Some(permissions) = permissions {
            std::fs::set_permissions(&temp, permissions)?;
        }
        std::fs::rename(&temp, &target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

pub fn editor_list_files(root: String, max_depth: Option<u32>) -> Result<Vec<String>, AppError> {
    Ok(editor_list_entries(root, max_depth)?
        .into_iter()
        .filter_map(|entry| match entry.kind {
            EditorListEntryKind::File => Some(entry.path),
            EditorListEntryKind::Directory => None,
        })
        .collect())
}

pub fn editor_list_entries(
    root: String,
    max_depth: Option<u32>,
) -> Result<Vec<EditorListEntry>, AppError> {
    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Ok(Vec::new());
    }
    if !root_path.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {root}")));
    }

    let mut output = Vec::new();
    collect_entries(root_path, max_depth.unwrap_or(4) as usize, 0, &mut output)?;
    mark_git_ignored(root_path, &mut output);
    Ok(output)
}

/// Marks what git ignores, so the tree can dim it as VS Code does. One `git check-ignore` for
/// the whole listing; outside a work tree, or without git, nothing is marked and nothing fails.
fn mark_git_ignored(directory: &Path, entries: &mut [EditorListEntry]) {
    use std::collections::HashSet;
    use std::io::Write;
    use std::process::Stdio;

    let candidates: Vec<usize> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| !entry.ignored)
        .map(|(index, _)| index)
        .collect();
    if candidates.is_empty() {
        return;
    }
    let Ok(mut child) = crate::codespace_git::git_command()
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let mut input = Vec::new();
    for &index in &candidates {
        input.extend_from_slice(entries[index].path.as_bytes());
        input.push(0);
    }
    // A write error (git exited early: not a repository) just means nothing is marked.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&input);
    }
    let Ok(output) = child.wait_with_output() else { return };
    // Exit 1 = none ignored, 128 = not a work tree; only 0 carries paths.
    if !output.status.success() {
        return;
    }
    let ignored: HashSet<&[u8]> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .collect();
    for index in candidates {
        if ignored.contains(entries[index].path.as_bytes()) {
            entries[index].ignored = true;
        }
    }
}

/// Most files a Go-to-file index returns. Far above the tree's listing cap: the index is only
/// paths, and a PHP or JS project with its `vendor/` easily passes 10,000 files.
const MAX_INDEXED_FILES: usize = 200_000;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFileIndex {
    /// Every file under the root, relative to it with `/`, ignored folders left out. Relative
    /// because the root repeated 200,000 times was ~40% of the payload; the caller joins it back.
    pub files: Vec<String>,
    /// True when `MAX_INDEXED_FILES` was reached and some files are missing.
    pub truncated: bool,
}

/// Every file under `root`, at any depth: hidden and heavy folders skipped, symlinked folders not
/// followed (a link back up the tree would never end).
pub fn editor_index_files(root: String) -> Result<EditorFileIndex, AppError> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {root}")));
    }
    let mut files = Vec::new();
    let mut pending = vec![root_path.to_path_buf()];
    while let Some(directory) = pending.pop() {
        // A folder that cannot be read is skipped, not fatal: the index is a search aid.
        let Ok(entries) = std::fs::read_dir(&directory) else { continue };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else { continue };
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if is_hidden(&name) || (file_type.is_dir() && is_heavy(&name)) {
                continue;
            }
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() || (file_type.is_symlink() && entry.path().is_file()) {
                if files.len() >= MAX_INDEXED_FILES {
                    return Ok(EditorFileIndex { files, truncated: true });
                }
                let path = entry.path();
                // The walk starts at `root_path`, so every entry is under it.
                let Ok(relative) = path.strip_prefix(root_path) else { continue };
                files.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(EditorFileIndex { files, truncated: false })
}

fn is_hidden(name: &str) -> bool {
    HIDDEN_ENTRIES.contains(&name)
}

fn is_heavy(name: &str) -> bool {
    HEAVY_DIRECTORIES.contains(&name)
}

/// What a directory entry is, symlinks resolved. `file_type()` does not follow links, so a
/// symlinked skill folder (`.claude/skills/*`) used to be neither file nor directory and vanished.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ListedKind {
    File,
    Directory,
    LinkedFile,
    LinkedDirectory,
    Other,
}

impl ListedKind {
    fn of(entry: &std::fs::DirEntry, file_type: std::fs::FileType) -> Self {
        if file_type.is_dir() {
            return Self::Directory;
        }
        if file_type.is_file() {
            return Self::File;
        }
        if file_type.is_symlink() {
            // A broken link still shows, as a file, so it can be seen and deleted.
            return match std::fs::metadata(entry.path()) {
                Ok(target) if target.is_dir() => Self::LinkedDirectory,
                _ => Self::LinkedFile,
            };
        }
        Self::Other
    }

    fn is_dir(self) -> bool {
        matches!(self, Self::Directory | Self::LinkedDirectory)
    }
}

fn collect_entries(
    directory: &Path,
    max_depth: usize,
    depth: usize,
    output: &mut Vec<EditorListEntry>,
) -> Result<(), AppError> {
    if output.len() >= MAX_LISTED_ENTRIES {
        return Ok(());
    }

    let entries = std::fs::read_dir(directory).map_err(|err| AppError::Other(err.to_string()))?;
    let mut entries = entries
        .map(|entry| {
            let entry = entry.map_err(|err| AppError::Other(err.to_string()))?;
            let file_type = entry
                .file_type()
                .map_err(|err| AppError::Other(err.to_string()))?;
            let kind = ListedKind::of(&entry, file_type);
            Ok((entry, kind))
        })
        .collect::<Result<Vec<_>, AppError>>()?;

    entries.retain(|(entry, kind)| {
        *kind != ListedKind::Other && !is_hidden(&entry.file_name().to_string_lossy())
    });
    entries.sort_by(|(left_entry, left_type), (right_entry, right_type)| {
        right_type.is_dir().cmp(&left_type.is_dir()).then_with(|| {
            left_entry
                .file_name()
                .to_string_lossy()
                .to_lowercase()
                .cmp(&right_entry.file_name().to_string_lossy().to_lowercase())
        })
    });

    for (entry, file_type) in &entries {
        if output.len() >= MAX_LISTED_ENTRIES {
            return Ok(());
        }
        output.push(EditorListEntry {
            path: entry.path().to_string_lossy().to_string(),
            kind: if file_type.is_dir() {
                EditorListEntryKind::Directory
            } else {
                EditorListEntryKind::File
            },
            ignored: file_type.is_dir() && is_heavy(&entry.file_name().to_string_lossy()),
        });
    }

    if depth >= max_depth {
        return Ok(());
    }

    for (entry, file_type) in entries {
        if output.len() >= MAX_LISTED_ENTRIES {
            return Ok(());
        }
        // A heavy folder is listed but not walked; a symlinked one is not walked either (loops).
        // Both still open one level at a time when the user expands them.
        if file_type != ListedKind::Directory || is_heavy(&entry.file_name().to_string_lossy()) {
            continue;
        }

        collect_entries(&entry.path(), max_depth, depth + 1, output)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        editor_create_directory, editor_create_file, editor_delete_entry, editor_trash_entry, editor_list_entries,
        editor_read_file, editor_read_file_bytes, editor_rename_entry, editor_stat_file, editor_write_file,
        EditorListEntryKind, MAX_EDITOR_FILE_SIZE_BYTES,
    };
    use std::fs;
    use std::path::Path;

    fn create_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, "test").unwrap();
    }

    #[test]
    fn read_file_tail_returns_the_last_lines_without_a_partial_one() {
        let path = std::env::temp_dir().join(format!("lotus-editor-tail-{}.log", std::process::id()));
        // ~1.6 MB over many 64 KB chunks, so the read stops long before the start.
        let text: String = (1..=200_000).map(|n| format!("line {n}\n")).collect();
        fs::write(&path, &text).unwrap();
        let read = |n| super::editor_read_file_tail(path.to_string_lossy().to_string(), n).unwrap();

        let tail = read(3);
        assert_eq!(tail.content, "line 199998\nline 199999\nline 200000\n");
        assert_eq!(tail.size_bytes, text.len() as u64);
        assert!(!tail.binary);
        assert_eq!(read(1).content, "line 200000\n");
        // More lines than the file has: all of it.
        fs::write(&path, "a\nb").unwrap();
        assert_eq!(read(10).content, "a\nb");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn index_files_finds_every_file_at_any_depth_and_skips_ignored_folders() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-index-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        create_file(&root.join("a/b/c/d/e/f/deep.ts"));
        create_file(&root.join("README.md"));
        create_file(&root.join(".env"));
        create_file(&root.join("node_modules/pkg/index.js"));
        create_file(&root.join(".git/HEAD"));
        create_file(&root.join("target/debug/out"));
        create_file(&root.join(".github/workflows/ci.yml"));
        create_file(&root.join(".DS_Store"));

        let index = super::editor_index_files(root.to_string_lossy().to_string()).unwrap();
        let mut found = index.files.clone();
        found.sort();

        assert_eq!(
            found,
            vec![".env", ".github/workflows/ci.yml", "README.md", "a/b/c/d/e/f/deep.ts"]
        );
        assert!(!index.truncated);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_entries_with_depth_zero_returns_only_direct_children() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-list-one-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        create_file(&root.join("src/deep/a.ts"));
        create_file(&root.join("node_modules/pkg/index.js"));
        create_file(&root.join(".git/HEAD"));
        create_file(&root.join(".env"));
        create_file(&root.join(".claude/settings.json"));
        create_file(&root.join(".DS_Store"));
        create_file(&root.join("README.md"));

        let entries = editor_list_entries(root.to_string_lossy().to_string(), Some(0)).unwrap();
        let names = entries
            .iter()
            .map(|entry| {
                (
                    entry
                        .path
                        .strip_prefix(root.to_str().unwrap())
                        .unwrap()
                        .trim_start_matches('/')
                        .to_string(),
                    matches!(entry.kind, EditorListEntryKind::Directory),
                )
            })
            .collect::<Vec<_>>();

        // One level: folders are listed, nothing inside them. Dot-folders and heavy folders are
        // shown; only `.git` and `.DS_Store` are hidden.
        assert_eq!(
            names,
            vec![
                (".claude".to_string(), true),
                ("node_modules".to_string(), true),
                ("src".to_string(), true),
                (".env".to_string(), false),
                ("README.md".to_string(), false),
            ],
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_entries_returns_top_level_directories_before_deep_files() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-list-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        create_file(&root.join("acme-extension/src/a.ts"));
        create_file(&root.join("acme-web/src/app.tsx"));
        create_file(&root.join("temp/readme.md"));
        create_file(&root.join("Makefile"));

        let entries = editor_list_entries(root.to_string_lossy().to_string(), Some(2)).unwrap();
        let top_level = entries
            .iter()
            .take(4)
            .map(|entry| {
                (
                    entry
                        .path
                        .strip_prefix(root.to_str().unwrap())
                        .unwrap()
                        .trim_start_matches('/')
                        .to_string(),
                    matches!(entry.kind, EditorListEntryKind::Directory),
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            top_level,
            vec![
                ("acme-extension".to_string(), true),
                ("acme-web".to_string(), true),
                ("temp".to_string(), true),
                ("Makefile".to_string(), false),
            ],
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_entries_shows_heavy_directories_dimmed_but_never_walks_them() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-ignore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        create_file(&root.join("node_modules/pkg/index.js"));
        create_file(&root.join("src/index.ts"));

        let entries = editor_list_entries(root.to_string_lossy().to_string(), Some(2)).unwrap();
        assert!(entries.iter().any(|entry| entry.path.ends_with("/src")));
        let heavy = entries
            .iter()
            .find(|entry| entry.path.ends_with("/node_modules"))
            .expect("node_modules is shown");
        assert!(heavy.ignored, "a heavy folder is marked so the tree dims it");
        assert!(!entries
            .iter()
            .any(|entry| entry.path.contains("node_modules/")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_entries_shows_dot_entries_but_hides_vcs_internals() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-dotfile-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        create_file(&root.join(".env"));
        create_file(&root.join(".gitignore"));
        create_file(&root.join(".prettierrc"));
        create_file(&root.join("src/index.ts"));
        create_file(&root.join(".git/config"));
        create_file(&root.join(".github/workflows/ci.yml"));

        let entries = editor_list_entries(root.to_string_lossy().to_string(), Some(2)).unwrap();
        let paths: Vec<_> = entries.iter().map(|e| e.path.as_str()).collect();

        assert!(
            paths.iter().any(|p| p.ends_with("/.github/workflows/ci.yml")),
            "dot-folders are listed and walked"
        );
        // Dotfile files must be visible
        assert!(
            paths.iter().any(|p| p.ends_with("/.env")),
            ".env must be visible"
        );
        assert!(
            paths.iter().any(|p| p.ends_with("/.gitignore")),
            ".gitignore must be visible"
        );
        assert!(
            paths.iter().any(|p| p.ends_with("/.prettierrc")),
            ".prettierrc must be visible"
        );
        // Only version-control internals are hidden
        assert!(
            !paths
                .iter()
                .any(|p| p.ends_with("/.git") || p.contains("/.git/")),
            ".git directory must be hidden"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn list_entries_keeps_symlinks_and_does_not_walk_linked_folders() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-symlink-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        create_file(&root.join("real/skill.md"));
        std::os::unix::fs::symlink(root.join("real"), root.join("linked")).unwrap();
        std::os::unix::fs::symlink(root.join("real/skill.md"), root.join("note.md")).unwrap();
        std::os::unix::fs::symlink(root.join("missing"), root.join("broken")).unwrap();
        // A link back up the tree: walking it would never end.
        std::os::unix::fs::symlink(&root, root.join("real/loop")).unwrap();

        let entries = editor_list_entries(root.to_string_lossy().to_string(), Some(3)).unwrap();
        let kind_of = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.path.ends_with(&format!("/{name}")))
                .map(|entry| matches!(entry.kind, EditorListEntryKind::Directory))
        };
        assert_eq!(kind_of("linked"), Some(true), "a linked folder shows as a folder");
        assert_eq!(kind_of("note.md"), Some(false), "a linked file shows as a file");
        assert_eq!(kind_of("broken"), Some(false), "a broken link still shows");
        assert!(!entries.iter().any(|entry| entry.path.contains("/linked/")));

        // Opening the linked folder lists its contents.
        let inside = editor_list_entries(root.join("linked").to_string_lossy().to_string(), Some(0)).unwrap();
        assert!(inside.iter().any(|entry| entry.path.ends_with("/linked/skill.md")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn list_entries_marks_git_ignored_entries() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-gitignore-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let init = crate::codespace_git::git_command()
            .args(["init", "-q"])
            .current_dir(&root)
            .status();
        if !matches!(init, Ok(status) if status.success()) {
            eprintln!("git unavailable; skipping");
            return;
        }
        fs::write(root.join(".gitignore"), "tmp/\n*.log\n").unwrap();
        create_file(&root.join("tmp/scratch.txt"));
        create_file(&root.join("debug.log"));
        create_file(&root.join("src/main.rs"));

        let entries = editor_list_entries(root.to_string_lossy().to_string(), Some(0)).unwrap();
        let ignored = |name: &str| {
            entries
                .iter()
                .find(|entry| entry.path.ends_with(&format!("/{name}")))
                .map(|entry| entry.ignored)
        };
        assert_eq!(ignored("tmp"), Some(true));
        assert_eq!(ignored("debug.log"), Some(true));
        assert_eq!(ignored("src"), Some(false));
        assert_eq!(ignored(".gitignore"), Some(false));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn create_file_creates_parent_directories() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-create-file-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();

        let created = editor_create_file(
            root.to_string_lossy().to_string(),
            "src/components/Button.tsx".to_string(),
        )
        .unwrap();

        assert!(Path::new(&created.path).is_file());
        assert!(root.join("src/components/Button.tsx").is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn create_directory_rejects_parent_traversal() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-create-dir-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();

        let error =
            editor_create_directory(root.to_string_lossy().to_string(), "../outside".to_string())
                .unwrap_err();

        assert!(error.to_string().contains("inside the workspace"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_entry_removes_nested_directories() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-delete-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        create_file(&root.join("src/components/Button.tsx"));

        let deleted = editor_delete_entry(
            root.to_string_lossy().to_string(),
            "src/components".to_string(),
        )
        .unwrap();

        assert_eq!(deleted.path, root.join("src/components").to_string_lossy());
        assert!(!root.join("src/components").exists());
        assert!(root.join("src").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_entry_rejects_parent_traversal() {
        let root = std::env::temp_dir().join(format!(
            "lotus-editor-delete-reject-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();

        let error =
            editor_delete_entry(root.to_string_lossy().to_string(), "../outside".to_string())
                .unwrap_err();

        assert!(error.to_string().contains("inside the workspace"));
        let error =
            editor_trash_entry(root.to_string_lossy().to_string(), "../outside".to_string())
                .unwrap_err();
        assert!(error.to_string().contains("inside the workspace"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stat_reports_size_and_times_without_reading() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("card.html");
        fs::write(&file, "<p>hi</p>").unwrap();
        let stat = editor_stat_file(file.to_string_lossy().to_string()).unwrap();
        assert_eq!(stat.size_bytes, 9);
        assert!(stat.mtime > 0);
        assert!(stat.created.map_or(true, |c| c <= stat.mtime + 1000));
        assert!(editor_stat_file(dir.path().to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn rename_changes_only_the_letter_case() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("readme.md"), "x").unwrap();

        let renamed = editor_rename_entry(root.clone(), "readme.md".into(), "README.md".into()).unwrap();

        assert!(renamed.path.ends_with("README.md"));
        let names: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["README.md".to_string()]);
    }

    #[test]
    fn write_file_replaces_the_text_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "old text that is longer").unwrap();

        editor_write_file(file.to_string_lossy().to_string(), "new".into(), None, None).unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "new");
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("a.txt")]);
    }

    #[cfg(unix)]
    #[test]
    fn write_file_keeps_permissions_and_writes_through_a_symlink() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("run.sh");
        fs::write(&script, "echo old").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let link = dir.path().join("link.sh");
        std::os::unix::fs::symlink(&script, &link).unwrap();

        editor_write_file(link.to_string_lossy().to_string(), "echo new".into(), None, None).unwrap();

        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_to_string(&script).unwrap(), "echo new");
        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o755);
    }

    #[test]
    fn write_file_refuses_a_stale_mtime_and_keeps_the_disk_text() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        fs::write(&file, "theirs").unwrap();

        let result = editor_write_file(file.to_string_lossy().to_string(), "mine".into(), Some(1), None);

        assert!(result.is_err());
        assert_eq!(fs::read_to_string(&file).unwrap(), "theirs");
    }

    #[test]
    fn write_file_puts_back_a_file_deleted_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("gone.txt");

        editor_write_file(file.to_string_lossy().to_string(), "back".into(), Some(1), None).unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "back");
        let missing_folder = dir.path().join("nope/gone.txt");
        assert!(editor_write_file(missing_folder.to_string_lossy().to_string(), "x".into(), None, None).is_err());
    }

    #[test]
    fn a_windows_1252_file_opens_as_text_and_saves_in_its_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("latin.txt");
        fs::write(&file, b"caf\xE9").unwrap();
        let path = file.to_string_lossy().to_string();

        let read = editor_read_file(path.clone(), false).unwrap();
        assert!(!read.binary);
        assert_eq!(read.content, "café");
        assert_eq!(read.encoding, "windows1252");

        editor_write_file(path, "café!".into(), None, Some(read.encoding)).unwrap();
        assert_eq!(fs::read(&file).unwrap(), b"caf\xE9!");
    }

    #[test]
    fn a_large_file_opens_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("big.log");
        fs::write(&file, vec![b'a'; (MAX_EDITOR_FILE_SIZE_BYTES + 1) as usize]).unwrap();
        let path = file.to_string_lossy().to_string();

        let refused = editor_read_file(path.clone(), false).unwrap();
        assert!(refused.binary && refused.too_large && refused.content.is_empty());
        let opened = editor_read_file(path, true).unwrap();
        assert!(!opened.binary && !opened.too_large);
        assert_eq!(opened.content.len() as u64, MAX_EDITOR_FILE_SIZE_BYTES + 1);
    }

    #[test]
    fn read_file_bytes_returns_raw_bytes_and_refuses_directories() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("pixel.png");
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];
        std::fs::write(&file, png).unwrap();

        let bytes = editor_read_file_bytes(file.to_string_lossy().to_string()).unwrap();
        assert_eq!(bytes, png);
        assert!(editor_read_file_bytes(dir.path().to_string_lossy().to_string()).is_err());
    }

    #[test]
    fn rename_refuses_to_overwrite_another_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        fs::write(dir.path().join("a.ts"), "a").unwrap();
        fs::write(dir.path().join("b.ts"), "b").unwrap();

        assert!(editor_rename_entry(root, "a.ts".into(), "b.ts".into()).is_err());
        assert_eq!(fs::read_to_string(dir.path().join("b.ts")).unwrap(), "b");
    }
}
