use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::AppError;

/// One frontmatter key/value, in file order. Mirrors the `metadata` field the
/// frontend's `SkillEntry` has always declared but never received.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SkillMetadataEntry {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    pub content: String,
    pub source: String, // "project" or "global"
    pub path: String,
    /// Every frontmatter key, in file order — the reader node renders this table.
    pub metadata: Vec<SkillMetadataEntry>,
}

fn canonicalize_skill_name(name: &str) -> String {
    name.trim()
        .to_lowercase()
        .chars()
        .map(|ch| match ch {
            'a'..='z' | '0'..='9' | ':' | '-' => ch,
            '_' | ' ' => '-',
            _ => '\0',
        })
        .filter(|ch| *ch != '\0')
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

/// The two YAML block-scalar styles a skill description is written in.
/// `description: >` (folded — newlines become spaces) is by far the most common;
/// `description: |` (literal — newlines kept) shows up in longer skills.
#[derive(Clone, Copy, PartialEq)]
enum BlockScalarStyle {
    Folded,
    Literal,
}

/// Recognise a block-scalar header — `>`, `|`, and their chomping/indent
/// indicators (`>-`, `|+`, `>2`). Anything else is a plain scalar.
fn block_scalar_style(rest: &str) -> Option<BlockScalarStyle> {
    let mut chars = rest.chars();
    let style = match chars.next()? {
        '>' => BlockScalarStyle::Folded,
        '|' => BlockScalarStyle::Literal,
        _ => return None,
    };
    // Only chomping (`-`/`+`) and explicit-indent digits may follow. A trailing
    // comment is allowed; real text after the indicator means this was not a header.
    let tail = chars.as_str().trim();
    if tail.is_empty()
        || tail.starts_with('#')
        || tail
            .chars()
            .all(|ch| ch == '-' || ch == '+' || ch.is_ascii_digit())
    {
        Some(style)
    } else {
        None
    }
}

/// Strip YAML quoting from a plain scalar. `name: "imagegen"` must not surface
/// as `/"imagegen"` in the UI — that literal quote was visible in the skills panel.
fn unquote_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 {
        if bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
            let inner = &trimmed[1..trimmed.len() - 1];
            return inner
                .replace("\\\"", "\"")
                .replace("\\n", "\n")
                .replace("\\\\", "\\");
        }
        if bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'' {
            return trimmed[1..trimmed.len() - 1].replace("''", "'");
        }
    }
    trimmed.to_string()
}

fn line_indent(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// Consume the indented block that follows a `>`/`|` header, starting at `start`.
/// Returns the folded/literal text and how many lines were consumed.
fn read_block_scalar(
    lines: &[&str],
    start: usize,
    style: BlockScalarStyle,
) -> (String, usize) {
    let mut block: Vec<&str> = Vec::new();
    let mut index = start;
    let mut indent: Option<usize> = None;

    while index < lines.len() {
        let line = lines[index];
        if line.trim().is_empty() {
            block.push("");
            index += 1;
            continue;
        }
        let current = line_indent(line);
        match indent {
            // The first non-empty line sets the block's indentation. A line at
            // column 0 is the next top-level key, not part of this block.
            None => {
                if current == 0 {
                    break;
                }
                indent = Some(current);
            }
            Some(base) => {
                if current < base {
                    break;
                }
            }
        }
        block.push(&line[indent.unwrap_or(0).min(current)..]);
        index += 1;
    }

    // Drop trailing blank lines — YAML's default "clip" chomping, and the only
    // sensible reading for the `-`/`+` variants in a one-line description too.
    while block.last().is_some_and(|line| line.trim().is_empty()) {
        block.pop();
    }

    let text = match style {
        BlockScalarStyle::Literal => block.join("\n"),
        // Folded: consecutive non-empty lines join with a space, a blank line
        // becomes a paragraph break.
        BlockScalarStyle::Folded => {
            let mut out = String::new();
            for line in &block {
                if line.trim().is_empty() {
                    out.push_str("\n\n");
                } else {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push(' ');
                    }
                    out.push_str(line.trim_end());
                }
            }
            out
        }
    };

    (text.trim_end().to_string(), index - start)
}

/// Parse the YAML frontmatter of a skill.md into ordered key/value pairs.
///
/// Deliberately a small hand-rolled reader rather than a YAML dependency: skill
/// frontmatter is a flat scalar map, and the two things that actually broke in
/// practice were quoting and block scalars. Nested maps and sequences are skipped
/// rather than mis-parsed.
pub(crate) fn parse_frontmatter(front: &str) -> Vec<SkillMetadataEntry> {
    let lines: Vec<&str> = front.lines().collect();
    let mut entries: Vec<SkillMetadataEntry> = Vec::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        let trimmed = line.trim();
        // Blank lines, comments, and anything indented (a nested map's children,
        // a sequence item) are not top-level keys.
        if trimmed.is_empty() || trimmed.starts_with('#') || line_indent(line) > 0 {
            index += 1;
            continue;
        }
        let Some(colon) = line.find(':') else {
            index += 1;
            continue;
        };
        let key = line[..colon].trim().to_string();
        if key.is_empty() {
            index += 1;
            continue;
        }
        let rest = line[colon + 1..].trim();

        let (value, consumed) = match block_scalar_style(rest) {
            Some(style) => read_block_scalar(&lines, index + 1, style),
            None => (unquote_scalar(rest), 0),
        };
        index += 1 + consumed;

        entries.push(SkillMetadataEntry { key, value });
    }

    entries
}

pub(crate) fn frontmatter_value(entries: &[SkillMetadataEntry], key: &str) -> Option<String> {
    entries
        .iter()
        .find(|entry| entry.key.eq_ignore_ascii_case(key))
        .map(|entry| entry.value.clone())
        .filter(|value| !value.is_empty())
}

/// Parse a skill.md file into (name, description, body, frontmatter).
/// A file without frontmatter keeps its whole text as the body.
fn parse_skill_md(
    raw: &str,
    fallback_name: &str,
) -> (String, String, String, Vec<SkillMetadataEntry>) {
    if let Some(after) = raw.strip_prefix("---") {
        if let Some(end) = after.find("\n---") {
            let front = &after[..end];
            let body = after[end + 4..].trim_start().to_string();
            let metadata = parse_frontmatter(front);

            let name = frontmatter_value(&metadata, "name")
                .unwrap_or_else(|| fallback_name.to_string());
            let description = frontmatter_value(&metadata, "description").unwrap_or_default();

            return (name, description, body, metadata);
        }
    }
    // No frontmatter — use whole file as content
    (
        fallback_name.to_string(),
        String::new(),
        raw.to_string(),
        Vec::new(),
    )
}

/// Scan a directory for skill subdirectories (each containing skill.md).
fn scan_skills_dir(dir: &Path, source: &str) -> Vec<SkillEntry> {
    let mut skills = Vec::new();

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return skills,
    };

    for entry in entries.flatten() {
        let path = entry.path();

        // Resolve symlinks
        let resolved = fs::canonicalize(&path).unwrap_or(path.clone());

        // Resolve skill file: try skill.md and SKILL.md (case-insensitive repos like paperclip)
        let skill_file = if resolved.is_dir() {
            let lower = resolved.join("skill.md");
            let upper = resolved.join("SKILL.md");
            if lower.exists() {
                lower
            } else if upper.exists() {
                upper
            } else {
                continue;
            }
        } else if resolved.extension().map(|e| e == "md").unwrap_or(false) {
            resolved.clone()
        } else {
            continue;
        };

        if !skill_file.exists() {
            continue;
        }

        let raw = match fs::read_to_string(&skill_file) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let fallback_name = resolved
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let (name, description, content, metadata) = parse_skill_md(&raw, &fallback_name);

        skills.push(SkillEntry {
            name,
            description,
            content,
            source: source.to_string(),
            path: skill_file.to_string_lossy().to_string(),
            metadata,
        });
    }

    skills
}

fn sort_skills(skills: &mut [SkillEntry]) {
    skills.sort_by(|left, right| {
        canonicalize_skill_name(&left.name)
            .cmp(&canonicalize_skill_name(&right.name))
            .then_with(|| left.path.cmp(&right.path))
    });
}

fn dedupe_skills(skills: Vec<SkillEntry>) -> Vec<SkillEntry> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(skills.len());

    for skill in skills {
        let canonical_name = canonicalize_skill_name(&skill.name);
        if seen.insert(canonical_name) {
            deduped.push(skill);
        }
    }

    deduped
}

fn collect_skills(
    project_path: Option<&Path>,
    global_skills_dir: Option<&Path>,
) -> Vec<SkillEntry> {
    let mut project_skills = project_path
        .map(|path| scan_skills_dir(&path.join(".agents").join("skills"), "project"))
        .unwrap_or_default();
    let mut global_skills = global_skills_dir
        .map(|path| scan_skills_dir(path, "global"))
        .unwrap_or_default();

    sort_skills(&mut project_skills);
    sort_skills(&mut global_skills);

    let mut aggregated = Vec::with_capacity(project_skills.len() + global_skills.len());
    aggregated.extend(project_skills);
    aggregated.extend(global_skills);

    dedupe_skills(aggregated)
}

/// List skills from project `.agents/skills/` (project-first) and `~/.claude/skills/` (global).
pub fn list_skills(project_path: Option<String>) -> Result<Vec<SkillEntry>, AppError> {
    let project_dir = project_path.as_deref().map(Path::new);
    let global_dir = dirs::home_dir()
        .map(|home| home.join(".claude").join("skills"))
        .filter(|dir| dir.exists());

    Ok(collect_skills(project_dir, global_dir.as_deref()))
}

/// Write a new skill.md to the appropriate directory.
pub fn create_skill(
    name: String,
    description: String,
    content: String,
    scope: String,
    project_path: Option<String>,
) -> Result<(), AppError> {
    let dir = resolve_skills_dir(&scope, project_path.as_deref())?;
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::Other(format!("Failed to create skills dir: {e}")))?;

    let skill_dir = dir.join(&name);
    fs::create_dir_all(&skill_dir)
        .map_err(|e| AppError::Other(format!("Failed to create skill dir: {e}")))?;

    let frontmatter = format!("---\nname: {name}\ndescription: {description}\n---\n\n{content}");
    fs::write(skill_dir.join("skill.md"), frontmatter)
        .map_err(|e| AppError::Other(format!("Failed to write skill.md: {e}")))?;

    Ok(())
}

/// Import a skill from a local path or remote GitHub URL.
///
/// Local path (starts with `/` or `~/`):
///   Copies `skill.md`/`SKILL.md` from the given directory into the target skills dir.
///   e.g. `/Users/me/paperclip/skills/paperclip`
///
/// Remote URL / npx command:
///   Fetches from GitHub raw with branch + filename fallbacks.
pub fn import_skill_from_url(
    input: String,
    scope: String,
    project_path: Option<String>,
) -> Result<(), AppError> {
    let trimmed = input.trim();
    let target_dir = resolve_skills_dir(&scope, project_path.as_deref())?;
    fs::create_dir_all(&target_dir)
        .map_err(|e| AppError::Other(format!("Failed to create skills dir: {e}")))?;

    if is_local_path(trimmed) {
        return import_from_local(trimmed, &target_dir);
    }

    // Remote GitHub import via GitHub API
    let imp = parse_github_import(trimmed)?;
    let skills = fetch_via_github_api(&imp)?;

    for (skill_name, content) in skills {
        let skill_dir = target_dir.join(&skill_name);
        fs::create_dir_all(&skill_dir).map_err(|e| {
            AppError::Other(format!("Failed to create skill dir '{skill_name}': {e}"))
        })?;
        fs::write(skill_dir.join("skill.md"), &content).map_err(|e| {
            AppError::Other(format!("Failed to write skill.md for '{skill_name}': {e}"))
        })?;
    }

    Ok(())
}

fn is_local_path(s: &str) -> bool {
    s.starts_with('/') || s.starts_with("~/") || s.starts_with('.')
}

/// Copy a skill from a local directory (supports both skill.md and SKILL.md).
fn import_from_local(source_path: &str, target_dir: &Path) -> Result<(), AppError> {
    // Expand ~/
    let expanded = if let Some(rest) = source_path.strip_prefix("~/") {
        dirs::home_dir()
            .ok_or_else(|| AppError::Other("Could not determine home directory".into()))?
            .join(rest)
    } else {
        PathBuf::from(source_path)
    };

    if !expanded.exists() {
        return Err(AppError::Other(format!(
            "Path does not exist: {}",
            expanded.display()
        )));
    }

    // Resolve to a directory
    let skill_source_dir = if expanded.is_file() {
        expanded
            .parent()
            .ok_or_else(|| AppError::Other("Cannot determine parent directory".into()))?
            .to_path_buf()
    } else {
        expanded.clone()
    };

    // Find the skill file (skill.md or SKILL.md)
    let skill_file = ["skill.md", "SKILL.md"]
        .iter()
        .map(|n| skill_source_dir.join(n))
        .find(|p| p.exists())
        .ok_or_else(|| {
            AppError::Other(format!(
                "No skill.md or SKILL.md found in {}",
                skill_source_dir.display()
            ))
        })?;

    let body = fs::read_to_string(&skill_file)
        .map_err(|e| AppError::Other(format!("Failed to read {}: {e}", skill_file.display())))?;

    // Derive skill name from the directory name
    let skill_name = skill_source_dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("imported-skill")
        .to_string();

    let dest_dir = target_dir.join(&skill_name);
    fs::create_dir_all(&dest_dir)
        .map_err(|e| AppError::Other(format!("Failed to create skill dir: {e}")))?;

    fs::write(dest_dir.join("skill.md"), body)
        .map_err(|e| AppError::Other(format!("Failed to write skill.md: {e}")))?;

    Ok(())
}

/// Parsed representation of a GitHub skill import request.
struct GitHubImport {
    owner: String,
    repo: String,
    /// Explicit branch/ref from the URL, or None → use repo default branch.
    branch: Option<String>,
    /// Sub-path within the repo (after branch) if the URL pointed into a subdir.
    subpath: Option<String>,
    /// --skill <name> filter (only import this skill slug).
    skill_filter: Option<String>,
}

/// Parse all supported input formats into a GitHubImport descriptor.
///
/// Supported:
///   1. `npx skills add https://github.com/u/r [--skill name]`
///   2. `https://github.com/u/r`
///   3. `https://github.com/u/r/tree/branch`
///   4. `https://github.com/u/r/tree/branch/subpath`
///   5. `https://github.com/u/r/blob/branch/path/SKILL.md`
///   6. `https://raw.githubusercontent.com/u/r/branch/path/SKILL.md`
fn parse_github_import(input: &str) -> Result<GitHubImport, AppError> {
    // ── npx command ───────────────────────────────────────────────────────────
    if input.starts_with("npx ") {
        let tokens: Vec<&str> = input.split_whitespace().collect();
        let gh_url = tokens
            .iter()
            .find(|t| t.starts_with("https://github.com/") || t.starts_with("https://raw."))
            .copied()
            .ok_or_else(|| AppError::Other("No GitHub URL found in the command".into()))?;
        let skill_filter = tokens
            .iter()
            .position(|t| *t == "--skill")
            .and_then(|i| tokens.get(i + 1))
            .map(|s| s.to_string());
        let mut parsed = parse_github_import(gh_url)?;
        if skill_filter.is_some() {
            parsed.skill_filter = skill_filter;
        }
        return Ok(parsed);
    }

    // ── raw.githubusercontent.com ─────────────────────────────────────────────
    if input.starts_with("https://raw.githubusercontent.com/") {
        let stripped = input.trim_start_matches("https://raw.githubusercontent.com/");
        let segs: Vec<&str> = stripped.split('/').filter(|s| !s.is_empty()).collect();
        // owner / repo / branch / ...path
        if segs.len() < 3 {
            return Err(AppError::Other(format!("Cannot parse raw URL: {input}")));
        }
        let owner = segs[0].to_string();
        let repo = segs[1].to_string();
        let branch = Some(segs[2].to_string());
        let subpath = if segs.len() > 3 {
            let p = segs[3..].join("/");
            // Drop trailing filename so subpath is a dir
            let dir = if p.ends_with(".md") {
                p.rsplit_once('/')
                    .map(|(d, _)| d.to_string())
                    .unwrap_or_default()
            } else {
                p
            };
            if dir.is_empty() {
                None
            } else {
                Some(dir)
            }
        } else {
            None
        };
        return Ok(GitHubImport {
            owner,
            repo,
            branch,
            subpath,
            skill_filter: None,
        });
    }

    // ── github.com URL ────────────────────────────────────────────────────────
    if input.starts_with("https://github.com/") {
        let stripped = input.trim_start_matches("https://github.com/");
        let segs: Vec<&str> = stripped.split('/').filter(|s| !s.is_empty()).collect();
        if segs.len() < 2 {
            return Err(AppError::Other(format!("Invalid GitHub URL: {input}")));
        }
        let owner = segs[0].to_string();
        let repo = segs[1].to_string();

        // /tree/<branch>[/<subpath>]  or  /blob/<branch>/<path>
        let (branch, subpath) = if segs.len() >= 4 && (segs[2] == "tree" || segs[2] == "blob") {
            let br = segs[3].to_string();
            let rest: Vec<&str> = segs[4..]
                .iter()
                .filter(|s| **s != "SKILL.md" && **s != "skill.md")
                .copied()
                .collect();
            let sp = if rest.is_empty() {
                None
            } else {
                Some(rest.join("/"))
            };
            (Some(br), sp)
        } else {
            (None, None)
        };

        return Ok(GitHubImport {
            owner,
            repo,
            branch,
            subpath,
            skill_filter: None,
        });
    }

    Err(AppError::Other(
        "Unsupported format. Use a GitHub URL (https://github.com/owner/repo) or:\n  npx skills add https://github.com/owner/repo --skill skill-name".to_string(),
    ))
}

/// Use the GitHub API to find and fetch SKILL.md files in a repo.
///
/// Steps (mirrors the paperclip approach):
///   1. GET /repos/{owner}/{repo}  → determine default branch
///   2. GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1  → list all files
///   3. Filter for SKILL.md / skill.md files, optionally by subpath or skill_filter
///   4. Fetch raw content of matching file(s)
///
/// Returns Vec<(skill_name, content)>
fn fetch_via_github_api(imp: &GitHubImport) -> Result<Vec<(String, String)>, AppError> {
    let owner = &imp.owner;
    let repo = &imp.repo;

    // ── 1. Resolve branch ────────────────────────────────────────────────────
    let branch = match &imp.branch {
        Some(b) => b.clone(),
        None => {
            let url = format!("https://api.github.com/repos/{owner}/{repo}");
            let resp = ureq::get(&url)
                .set("Accept", "application/vnd.github+json")
                .set("User-Agent", "orchids-agent-teams/1.0")
                .call()
                .map_err(|e| match e {
                    ureq::Error::Status(404, _) => {
                        AppError::Other(format!("Repository not found: github.com/{owner}/{repo}"))
                    }
                    other => AppError::Other(format!("GitHub API error: {other}")),
                })?;
            let body: serde_json::Value = serde_json::from_str(
                &resp
                    .into_string()
                    .map_err(|e| AppError::Other(format!("Failed to read repo info: {e}")))?,
            )
            .map_err(|e| AppError::Other(format!("Failed to parse repo info: {e}")))?;
            body["default_branch"]
                .as_str()
                .unwrap_or("main")
                .to_string()
        }
    };

    // ── 2. Get recursive file tree ────────────────────────────────────────────
    let tree_url =
        format!("https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1");
    let tree_resp = ureq::get(&tree_url)
        .set("Accept", "application/vnd.github+json")
        .set("User-Agent", "orchids-agent-teams/1.0")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(404, _) => AppError::Other(format!(
                "Branch '{branch}' not found in github.com/{owner}/{repo}"
            )),
            other => AppError::Other(format!("GitHub API tree error: {other}")),
        })?;

    let tree_body: serde_json::Value = serde_json::from_str(
        &tree_resp
            .into_string()
            .map_err(|e| AppError::Other(format!("Failed to read tree: {e}")))?,
    )
    .map_err(|e| AppError::Other(format!("Failed to parse tree: {e}")))?;

    // ── 3. Find SKILL.md / skill.md blobs ────────────────────────────────────
    let all_paths: Vec<String> = tree_body["tree"]
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|item| {
            if item["type"].as_str() != Some("blob") {
                return None;
            }
            let path = item["path"].as_str()?;
            let fname = path.rsplit('/').next().unwrap_or("");
            if fname.eq_ignore_ascii_case("skill.md") {
                Some(path.to_string())
            } else {
                None
            }
        })
        .collect();

    if all_paths.is_empty() {
        return Err(AppError::Other(format!(
            "No SKILL.md files found in github.com/{owner}/{repo} (branch: {branch})"
        )));
    }

    // ── 4. Filter by subpath / skill_filter ──────────────────────────────────
    let filtered: Vec<String> = all_paths
        .into_iter()
        .filter(|path: &String| {
            // subpath filter — path must start with the subpath prefix
            if let Some(ref sp) = imp.subpath {
                if !path.starts_with(sp.as_str()) {
                    return false;
                }
            }
            // --skill filter — the skill directory name must match
            if let Some(ref sf) = imp.skill_filter {
                let skill_dir = if path.ends_with("/SKILL.md") || path.ends_with("/skill.md") {
                    path.rsplit('/').nth(1).unwrap_or("")
                } else {
                    // flat file: the filename without extension
                    path.rsplit('/')
                        .next()
                        .unwrap_or("")
                        .trim_end_matches(".md")
                };
                if !skill_dir.eq_ignore_ascii_case(sf) {
                    return false;
                }
            }
            true
        })
        .collect();

    if filtered.is_empty() {
        let filter_desc = imp
            .skill_filter
            .as_deref()
            .map(|s| format!(" with --skill '{s}'"))
            .unwrap_or_default();
        return Err(AppError::Other(format!(
            "No matching skill found in github.com/{owner}/{repo}{filter_desc}"
        )));
    }

    // ── 5. Fetch raw content for each match ───────────────────────────────────
    let mut results = Vec::new();
    for skill_path in filtered {
        let raw_url =
            format!("https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{skill_path}");
        let content = ureq::get(&raw_url)
            .set("User-Agent", "orchids-agent-teams/1.0")
            .call()
            .map_err(|e| AppError::Other(format!("Failed to fetch {raw_url}: {e}")))?
            .into_string()
            .map_err(|e| AppError::Other(format!("Failed to read skill content: {e}")))?;

        // Derive skill name: directory containing SKILL.md, or filename without .md
        let skill_name: String = if skill_path.contains('/') {
            skill_path
                .rsplit('/')
                .nth(1) // parent dir of SKILL.md
                .unwrap_or("imported-skill")
                .to_string()
        } else {
            skill_path
                .trim_end_matches(".md")
                .trim_end_matches("SKILL")
                .trim_end_matches("skill")
                .to_string()
                .to_lowercase()
        };

        results.push((skill_name, content));
    }

    Ok(results)
}

fn resolve_skills_dir(scope: &str, project_path: Option<&str>) -> Result<PathBuf, AppError> {
    match scope {
        "project" => {
            let p = project_path
                .ok_or_else(|| AppError::Other("project_path required for project scope".into()))?;
            Ok(PathBuf::from(p).join(".agents").join("skills"))
        }
        _ => {
            let home = dirs::home_dir()
                .ok_or_else(|| AppError::Other("Could not determine home directory".into()))?;
            Ok(home.join(".claude").join("skills"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{canonicalize_skill_name, collect_skills, parse_skill_md};
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    struct TestDirs {
        root: PathBuf,
        project_root: PathBuf,
        global_skills_dir: PathBuf,
    }

    impl TestDirs {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("lotus-skills-test-{}", Uuid::new_v4()));
            let project_root = root.join("project");
            let global_skills_dir = root.join("global").join(".claude").join("skills");

            fs::create_dir_all(project_root.join(".agents").join("skills")).unwrap();
            fs::create_dir_all(&global_skills_dir).unwrap();

            Self {
                root,
                project_root,
                global_skills_dir,
            }
        }

        fn write_project_skill(&self, dir_name: &str, name: &str, description: &str) {
            self.write_skill(
                self.project_root
                    .join(".agents")
                    .join("skills")
                    .join(dir_name),
                name,
                description,
            );
        }

        fn write_global_skill(&self, dir_name: &str, name: &str, description: &str) {
            self.write_skill(self.global_skills_dir.join(dir_name), name, description);
        }

        fn write_skill(&self, dir: PathBuf, name: &str, description: &str) {
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                format!("---\nname: {name}\ndescription: {description}\n---\n\nUse {name}."),
            )
            .unwrap();
        }
    }

    impl Drop for TestDirs {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn parse_skill_md_strips_quotes_from_name_and_description() {
        let raw = "---\nname: \"imagegen\"\ndescription: \"Generate or edit raster images.\"\n---\n\nBody";
        let (name, description, body, _) = parse_skill_md(raw, "fallback");

        assert_eq!(name, "imagegen");
        assert_eq!(description, "Generate or edit raster images.");
        assert_eq!(body, "Body");
    }

    #[test]
    fn parse_skill_md_unescapes_inner_quotes_and_single_quoted_scalars() {
        let raw = "---\nname: 'it''s-fine'\ndescription: \"Say \\\"hi\\\" first\"\n---\nBody";
        let (name, description, _, _) = parse_skill_md(raw, "fallback");

        assert_eq!(name, "it's-fine");
        assert_eq!(description, "Say \"hi\" first");
    }

    #[test]
    fn parse_skill_md_folds_a_folded_block_scalar_description() {
        let raw = concat!(
            "---\n",
            "name: caveman\n",
            "description: >\n",
            "  Turn a ticket into a short\n",
            "  plain-language summary.\n",
            "---\n",
            "Body",
        );
        let (_, description, _, _) = parse_skill_md(raw, "fallback");

        assert_eq!(
            description,
            "Turn a ticket into a short plain-language summary."
        );
    }

    #[test]
    fn parse_skill_md_keeps_newlines_in_a_literal_block_scalar() {
        let raw = concat!(
            "---\n",
            "name: steps\n",
            "description: |-\n",
            "  first\n",
            "  second\n",
            "---\n",
            "Body",
        );
        let (_, description, _, _) = parse_skill_md(raw, "fallback");

        assert_eq!(description, "first\nsecond");
    }

    #[test]
    fn parse_skill_md_reads_the_key_after_a_block_scalar() {
        let raw = concat!(
            "---\n",
            "description: >-\n",
            "  folded text\n",
            "name: after-block\n",
            "---\n",
            "Body",
        );
        let (name, description, _, metadata) = parse_skill_md(raw, "fallback");

        assert_eq!(name, "after-block");
        assert_eq!(description, "folded text");
        assert_eq!(metadata.len(), 2);
    }

    #[test]
    fn parse_skill_md_returns_every_frontmatter_key_in_file_order() {
        let raw = "---\nname: teach\nmodel: opus\ndescription: Teach a concept.\n---\nBody";
        let (_, _, _, metadata) = parse_skill_md(raw, "fallback");

        let keys: Vec<&str> = metadata.iter().map(|entry| entry.key.as_str()).collect();
        assert_eq!(keys, vec!["name", "model", "description"]);
        assert_eq!(metadata[1].value, "opus");
    }

    #[test]
    fn parse_skill_md_falls_back_to_the_directory_name_without_frontmatter() {
        let (name, description, body, metadata) = parse_skill_md("# Just a doc", "on-disk-name");

        assert_eq!(name, "on-disk-name");
        assert_eq!(description, "");
        assert_eq!(body, "# Just a doc");
        assert!(metadata.is_empty());
    }

    #[test]
    fn canonicalize_skill_name_preserves_namespaces_and_normalizes_spacing() {
        assert_eq!(
            canonicalize_skill_name(" frontend_design "),
            "frontend-design"
        );
        assert_eq!(
            canonicalize_skill_name("GitHub:GH Fix CI"),
            "github:gh-fix-ci"
        );
    }

    #[test]
    fn collect_skills_prefers_project_skills_over_global_duplicates() {
        let dirs = TestDirs::new();
        dirs.write_global_skill(
            "frontend-design-global",
            "frontend-design",
            "Global version",
        );
        dirs.write_project_skill(
            "frontend-design-project",
            "frontend-design",
            "Project version",
        );

        let skills = collect_skills(Some(&dirs.project_root), Some(&dirs.global_skills_dir));

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].source, "project");
        assert_eq!(skills[0].description, "Project version");
    }

    #[test]
    fn collect_skills_keeps_namespaced_and_non_namespaced_skills_distinct() {
        let dirs = TestDirs::new();
        dirs.write_global_skill("grill-me", "grill-me", "Global grill me");
        dirs.write_project_skill(
            "github-gh-fix-ci",
            "github:gh-fix-ci",
            "Project github fix ci",
        );

        let skills = collect_skills(Some(&dirs.project_root), Some(&dirs.global_skills_dir));

        assert_eq!(skills.len(), 2);
        assert!(skills.iter().any(|skill| skill.name == "grill-me"));
        assert!(skills.iter().any(|skill| skill.name == "github:gh-fix-ci"));
    }
}
