use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeTaskIntakeDecision {
    Assign,
    AskHuman,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTaskIntake {
    pub brief_xml: String,
    pub confidence: f64,
    pub decision: BridgeTaskIntakeDecision,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeTaskBlockerPhase {
    Intake,
    Assignment,
    Execution,
    Review,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeTaskBlockerType {
    HumanInput,
    Ambiguity,
    Auth,
    Dependency,
    VerificationFailed,
    SystemError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTaskBlocker {
    pub phase: BridgeTaskBlockerPhase,
    #[serde(rename = "type")]
    pub kind: BridgeTaskBlockerType,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeTaskFeedbackActor {
    Director,
    Human,
    Agent,
    Reviewer,
    System,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BridgeTaskFeedbackKind {
    IntakeCreated,
    HitlQuestion,
    HitlAnswer,
    AssignmentPlanCreated,
    AssignmentDispatched,
    AgentResult,
    ReviewRequested,
    ReviewVerdict,
    RevisionRequested,
    TaskBlocked,
    TaskStatusChanged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTaskFeedbackEvent {
    pub id: String,
    pub at: u64,
    pub actor: BridgeTaskFeedbackActor,
    pub kind: BridgeTaskFeedbackKind,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}
