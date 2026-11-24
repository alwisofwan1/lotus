#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    /// The file was migrated by a newer Lotus. Opening it would risk an
    /// older build writing rows the newer schema does not expect.
    #[error("automations database schema v{found} is newer than this build supports (v{supported})")]
    SchemaTooNew { found: usize, supported: usize },
    #[error("automations database holds an unreadable value: {0}")]
    Corrupt(String),
    #[error("no automation with id {0}")]
    UnknownAutomation(String),
    #[error("internal: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, Error>;
