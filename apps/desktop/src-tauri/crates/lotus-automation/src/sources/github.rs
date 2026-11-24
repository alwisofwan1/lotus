//! The `github` source: pull requests GitHub lists as waiting for the review
//! account's review, or its team's.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use super::RequestSource;
use crate::github::GitHub;
use crate::pr_review::{is_owner_slash_name, PrRef, PrReviewConfig};
use crate::registry::BoxFuture;

/// `trigger.config.sources.github`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Settings {
    /// `org/slug` of a GitHub team whose review requests count too.
    #[serde(default)]
    team: Option<String>,
}

pub struct GitHubRequests {
    github: Arc<dyn GitHub>,
}

impl GitHubRequests {
    pub const KEY: &'static str = "github";

    pub fn new(github: Arc<dyn GitHub>) -> Self {
        Self { github }
    }

    /// [`RequestSource::check`], without a GitHub to ask.
    pub fn check_settings(settings: &Value) -> Result<(), String> {
        parse(settings).map(drop)
    }
}

fn parse(settings: &Value) -> Result<Settings, String> {
    let settings: Settings = serde_json::from_value(settings.clone()).map_err(|e| format!("github: {e}"))?;
    if let Some(team) = settings.team.as_deref().filter(|t| !is_owner_slash_name(t)) {
        return Err(format!("github: team {team:?} is not org/team-slug"));
    }
    Ok(settings)
}

impl RequestSource for GitHubRequests {
    fn key(&self) -> &str {
        Self::KEY
    }

    fn check(&self, settings: &Value) -> Result<(), String> {
        Self::check_settings(settings)
    }

    fn requests(&self, review: &PrReviewConfig, settings: &Value) -> BoxFuture<Result<Vec<PrRef>, String>> {
        let (github, account, settings) = (Arc::clone(&self.github), review.account.clone(), parse(settings));
        Box::pin(async move {
            let settings = settings?;
            let found = github.review_requests(&account, settings.team.as_deref()).await?;
            Ok(found.into_iter().map(|pr| PrRef { repo: pr.repo, number: pr.number }).collect())
        })
    }
}
