use serde::Serialize;
use thiserror::Error;

use crate::remote_error::RemoteError;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
    #[error("{0}")]
    Remote(#[from] RemoteError),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        match self {
            AppError::Remote(e) => e.serialize(serializer),
            _ => serializer.serialize_str(&self.to_string()),
        }
    }
}

pub fn other(msg: impl Into<String>) -> AppError {
    AppError::Other(msg.into())
}
