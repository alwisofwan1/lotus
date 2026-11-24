#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PrRef {
    /// `owner/name`.
    pub repo: String,
    pub number: u64,
}

impl PrRef {
    pub fn url(&self) -> String {
        format!("https://github.com/{}/pull/{}", self.repo, self.number)
    }
}

/// Reads `https://github.com/<owner>/<name>/pull/<n>[/...]`. Slack wraps
/// links in `<...>`; anything after the number (`/files`, `#diff-...`) is
/// ignored. Returns `None` for anything else, including look-alike hosts.
pub fn parse_pr_url(raw: &str) -> Option<PrRef> {
    let raw = raw.trim().trim_start_matches('<').trim_end_matches('>');
    // Slack's `<url|label>` form.
    let raw = raw.split('|').next()?;
    let rest = raw.strip_prefix("https://github.com/")?;
    let rest = rest.split(['#', '?']).next()?;
    let mut parts = rest.split('/');
    let owner = parts.next()?;
    let name = parts.next()?;
    if parts.next()? != "pull" {
        return None;
    }
    let number: u64 = parts.next()?.parse().ok()?;
    if number == 0 || !is_name(owner) || !is_name(name) {
        return None;
    }
    Some(PrRef { repo: format!("{owner}/{name}"), number })
}

fn is_name(part: &str) -> bool {
    !part.is_empty()
        && !part.starts_with('.')
        && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The `owner/name` a git remote URL points at, in any of the forms git
/// writes: `https://github.com/o/r(.git)`, `git@github.com:o/r.git`,
/// `ssh://git@github.com/o/r.git`. An SSH host may be an alias from
/// `~/.ssh/config` (`git@github-work:o/r.git`, used for a second GitHub
/// account), so for SSH forms any host is accepted; over HTTPS only github.com.
/// Only ever compared with a GitHub PR's repo, to find its checkout.
pub fn repo_from_remote_url(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) {
        let (host, path) = rest.split_once('/')?;
        let host = host.rsplit('@').next()?;
        if !host.eq_ignore_ascii_case("github.com") && !host.eq_ignore_ascii_case("www.github.com") {
            return None;
        }
        path
    } else if let Some(rest) = url.strip_prefix("ssh://") {
        rest.split_once('/')?.1
    } else {
        // scp-like `[user@]host:owner/name`; a `/` before the `:` would make it a local path.
        let (host, path) = url.split_once(':')?;
        if host.is_empty() || host.contains('/') {
            return None;
        }
        path
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    (parts.next().is_none() && is_name(owner) && is_name(name)).then(|| format!("{owner}/{name}"))
}
