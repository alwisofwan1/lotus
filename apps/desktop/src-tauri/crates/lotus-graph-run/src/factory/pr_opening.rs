//! Open or Draft (ADR-0055, ADR-0063 §7): the one place that decides how a Factory PR is opened.
//!
//! A Factory PR opens **Open** only when the review accepted the change and the gate is green or the
//! repo has no gate. Everything else opens as a **Draft**, and the reason goes on top of the PR and
//! into the run's progress, so the Runs and Board views can say why.

/// What the review step ended with.
///
/// Built from the runner's own `Reviewed` by `impl From<&Reviewed> for ReviewState` there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewState {
    Accepted,
    /// A person must decide.
    Human,
    /// The reviewer still wants changes after the one revision.
    Revision,
    /// Not run (for example the same model as implement).
    Skipped,
    /// The reviewer failed or replied wrong.
    Failed,
    /// No reviewer, or no approved spec to review against.
    NotAsked,
}

/// The repo's gate on the final source. A red gate never gets here: the run stops at the gate
/// (check failed) and opens no PR, so there is no `Red` to decide on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateState {
    Green,
    /// The repo declares no gate: only the review guards the change.
    NoGate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrOpening {
    Open,
    /// Opens as a Draft; why.
    Draft(String),
}

impl PrOpening {
    pub fn is_draft(&self) -> bool {
        matches!(self, PrOpening::Draft(_))
    }
    pub fn reason(&self) -> Option<&str> {
        match self {
            PrOpening::Draft(why) => Some(why),
            PrOpening::Open => None,
        }
    }
}

/// `force_draft`: the repo's `pr = "draft"`; it wins over everything.
pub fn decide(force_draft: bool, review: ReviewState, gate: GateState) -> PrOpening {
    if force_draft {
        return PrOpening::Draft("The repo's factory settings say `pr = \"draft\"`: every Factory PR stays a Draft.".into());
    }
    let why = match review {
        ReviewState::Accepted => None,
        ReviewState::Human => Some("The review needs a person to decide."),
        ReviewState::Revision => Some("The review still asks for changes after one revision."),
        ReviewState::Skipped => Some("The review did not run."),
        ReviewState::Failed => Some("The review failed."),
        ReviewState::NotAsked => Some("The change was not reviewed: there is no approved spec to review against."),
    };
    if let Some(why) = why {
        return PrOpening::Draft(why.into());
    }
    match gate {
        GateState::Green | GateState::NoGate => PrOpening::Open,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepted_review_with_a_green_gate_or_no_gate_opens() {
        assert_eq!(decide(false, ReviewState::Accepted, GateState::Green), PrOpening::Open);
        assert_eq!(decide(false, ReviewState::Accepted, GateState::NoGate), PrOpening::Open);
    }

    #[test]
    fn any_review_but_accepted_is_a_draft_with_its_reason() {
        for review in [ReviewState::Human, ReviewState::Revision, ReviewState::Skipped, ReviewState::Failed, ReviewState::NotAsked] {
            for gate in [GateState::Green, GateState::NoGate] {
                let opening = decide(false, review, gate);
                assert!(opening.is_draft() && !opening.reason().unwrap().is_empty(), "{review:?} {gate:?}");
            }
        }
    }

    #[test]
    fn forced_draft_wins_and_names_the_setting() {
        let opening = decide(true, ReviewState::Accepted, GateState::Green);
        assert!(opening.reason().unwrap().contains("pr = \"draft\""));
    }
}
