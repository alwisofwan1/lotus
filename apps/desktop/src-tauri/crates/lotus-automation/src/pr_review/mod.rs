//! The `pr_review` action kind: review one GitHub pull request with a full
//! agent (tools, skills, the repo in its working folder), given the diff Lotus
//! fetched, and leave the result as a draft that waits for Send.

mod action;
pub mod brief;
pub mod reply_style;
pub mod rereview;
mod diff;
mod form;
pub mod auto;
pub mod others;
mod prefetch;
mod prompt;
mod run_now;
mod send;
pub mod skill;
pub mod slack_reply;
pub mod thread;
mod url;
mod watch;

pub use action::{Coverage, PrReviewAction, PrReviewConfig, PrReviewLimits, SkillCheck, OFF_DIFF_HEADING};
pub use diff::{Diff, FileChange, FileStatus};
pub use form::{new_pr_review_automation, PrReviewForm};
pub(crate) use form::is_owner_slash_name;
pub use prefetch::{Prefetch, Worktree};
pub use prompt::{build_pane_prompt, build_prompt, LocalDiff, PanePromptInput, PromptInput};
pub use run_now::{pr_key, precheck, run_now, review_again, submit_pr, submit_round, RunNowError};
pub use send::{send_draft, EditedReview, SendError, SendRequest};
pub use url::{parse_pr_url, repo_from_remote_url, PrRef};
pub use watch::repo_is_watched;
