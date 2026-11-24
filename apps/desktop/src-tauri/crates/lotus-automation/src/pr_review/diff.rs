use std::collections::{HashMap, HashSet};

/// What a unified diff (from `git diff` or GitHub) allows a review to say:
/// which new-side lines sit inside a hunk, how big the change is, and which files it touches.
#[derive(Debug, Default, Clone)]
pub struct Diff {
    commentable: HashMap<String, HashSet<u64>>,
    changed_lines: usize,
    files: Vec<FileChange>,
}

/// One file of a diff, for the review's file list (ADR-0052 §1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    /// The new path (the old one for a deleted file).
    pub path: String,
    pub status: FileStatus,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Deleted,
    Renamed,
    Modified,
    Binary,
}

impl FileStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Deleted => "deleted",
            Self::Renamed => "renamed",
            Self::Modified => "modified",
            Self::Binary => "binary",
        }
    }
}

impl Diff {
    pub fn parse(text: &str) -> Self {
        let mut diff = Diff::default();
        let mut file: Option<String> = None;
        // Lines still owed by the current hunk, per side. Header-looking lines
        // (`+++ ...`) inside a hunk are content, so hunk bounds come from the
        // `@@` counts, never from pattern matching.
        let (mut old_left, mut new_left, mut new_line) = (0u64, 0u64, 0u64);

        for line in text.lines() {
            if old_left > 0 || new_left > 0 {
                match line.as_bytes().first() {
                    Some(b'+') => {
                        diff.changed_lines += 1;
                        if let Some(f) = diff.files.last_mut() {
                            f.added += 1;
                        }
                        diff.mark(&file, new_line);
                        new_line += 1;
                        new_left = new_left.saturating_sub(1);
                    }
                    Some(b'-') => {
                        diff.changed_lines += 1;
                        if let Some(f) = diff.files.last_mut() {
                            f.removed += 1;
                        }
                        old_left = old_left.saturating_sub(1);
                    }
                    Some(b'\\') => {} // "\ No newline at end of file"
                    _ => {
                        diff.mark(&file, new_line);
                        new_line += 1;
                        old_left = old_left.saturating_sub(1);
                        new_left = new_left.saturating_sub(1);
                    }
                }
                continue;
            }
            if let Some(path) = line.strip_prefix("+++ ") {
                file = path.strip_prefix("b/").map(str::to_string);
            } else if let Some(paths) = line.strip_prefix("diff --git ") {
                file = None;
                // `a/<old> b/<new>`; git quotes a path with unusual characters.
                let new = paths.rsplit_once(" b/").or_else(|| paths.rsplit_once(" \"b/")).map(|(_, p)| p.trim_end_matches('"'));
                if let Some(path) = new {
                    diff.files.push(FileChange { path: path.to_string(), status: FileStatus::Modified, added: 0, removed: 0 });
                }
            } else if let Some(f) = diff.files.last_mut() {
                if line.starts_with("new file mode") {
                    f.status = FileStatus::Added;
                } else if line.starts_with("deleted file mode") {
                    f.status = FileStatus::Deleted;
                } else if line.starts_with("rename from ") {
                    f.status = FileStatus::Renamed;
                } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
                    f.status = FileStatus::Binary;
                } else if let Some((old_count, new_start, new_count)) = parse_hunk_header(line) {
                    old_left = old_count;
                    new_left = new_count;
                    new_line = new_start;
                }
            } else if let Some((old_count, new_start, new_count)) = parse_hunk_header(line) {
                old_left = old_count;
                new_left = new_count;
                new_line = new_start;
            }
        }
        diff
    }

    pub fn is_commentable(&self, path: &str, line: u64) -> bool {
        self.commentable.get(path).is_some_and(|lines| lines.contains(&line))
    }

    /// Added plus removed lines.
    pub fn changed_lines(&self) -> usize {
        self.changed_lines
    }

    /// Every file the diff touches, in its order.
    pub fn files(&self) -> &[FileChange] {
        &self.files
    }

    fn mark(&mut self, file: &Option<String>, line: u64) {
        if let Some(path) = file {
            self.commentable.entry(path.clone()).or_default().insert(line);
        }
    }
}

/// `@@ -a[,b] +c[,d] @@ ...` → (b, c, d). A missing count means 1.
fn parse_hunk_header(line: &str) -> Option<(u64, u64, u64)> {
    let rest = line.strip_prefix("@@ -")?;
    let (ranges, _) = rest.split_once(" @@")?;
    let (old, new) = ranges.split_once(" +")?;
    let count = |range: &str| -> Option<(u64, u64)> {
        match range.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((range.parse().ok()?, 1)),
        }
    };
    let (_, old_count) = count(old)?;
    let (new_start, new_count) = count(new)?;
    Some((old_count, new_start, new_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_list_names_each_file_with_its_status_and_counts() {
        let text = "\
diff --git a/src/a.rs b/src/a.rs
index 1..2 100644
--- a/src/a.rs
+++ b/src/a.rs
@@ -1,2 +1,3 @@
 keep
-old
+new
+more
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old.rs b/moved.rs
similarity index 100%
rename from old.rs
rename to moved.rs
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
";
        let diff = Diff::parse(text);
        let got: Vec<_> = diff.files().iter().map(|f| (f.path.as_str(), f.status, f.added, f.removed)).collect();
        assert_eq!(
            got,
            [
                ("src/a.rs", FileStatus::Modified, 2, 1),
                ("new.txt", FileStatus::Added, 1, 0),
                ("gone.txt", FileStatus::Deleted, 0, 1),
                ("moved.rs", FileStatus::Renamed, 0, 0),
                ("logo.png", FileStatus::Binary, 0, 0),
            ]
        );
        assert_eq!(diff.changed_lines(), 5);
        assert!(diff.is_commentable("src/a.rs", 2) && diff.is_commentable("new.txt", 1));
    }
}
