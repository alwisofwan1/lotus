/// Whether `repo` (`owner/name`) is covered by an automation's `repos`.
/// An entry is either `owner/name` or `owner/*` — every repository of that
/// owner, including ones created later. GitHub names are case-insensitive.
pub fn repo_is_watched(watched: &[String], repo: &str) -> bool {
    let Some((owner, _)) = repo.split_once('/') else {
        return false;
    };
    watched.iter().any(|entry| match entry.strip_suffix("/*") {
        Some(org) => org.eq_ignore_ascii_case(owner),
        None => entry.eq_ignore_ascii_case(repo),
    })
}
