use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

/// Unified error type for all HTTP API handlers.
///
/// 401 Unauthorized is NOT represented here — auth rejection flows through the
/// `RequireAuth` extractor's own `Rejection = StatusCode` type, so handler code
/// never needs to construct an unauthorized error.
#[derive(Debug)]
pub enum ApiError {
    NotFound(String),
    /// Resource existed at one point but is no longer available — used by
    /// fleet endpoints when a paneId is in the snapshot but its PTY session
    /// is gone, so clients can clear stale focus state.
    Gone(String),
    BadRequest(String),
    /// The host is working, but is not configured for what was asked — a state the
    /// operator can change, not a fault. Kept distinct from `Internal` so a client
    /// can offer the alternative instead of reporting a broken host.
    Unavailable(String),
    Internal(String),
}

impl ApiError {
    pub fn not_found(what: impl Into<String>) -> Self {
        Self::NotFound(what.into())
    }

    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self::BadRequest(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    pub fn unavailable(msg: impl Into<String>) -> Self {
        Self::Unavailable(msg.into())
    }
}

impl From<AppError> for ApiError {
    fn from(e: AppError) -> Self {
        let msg = e.to_string();
        if msg.contains("not found") {
            Self::NotFound(msg)
        } else {
            Self::Internal(msg)
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::NotFound(msg) => (StatusCode::NOT_FOUND, msg),
            Self::Gone(msg) => (StatusCode::GONE, msg),
            Self::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg),
            Self::Unavailable(msg) => (StatusCode::SERVICE_UNAVAILABLE, msg),
            Self::Internal(msg) => (StatusCode::INTERNAL_SERVER_ERROR, msg),
        };
        (status, Json(ErrorBody { error: message })).into_response()
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;

    #[test]
    fn not_found_maps_to_404() {
        let err = ApiError::not_found("session xyz");
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn bad_request_maps_to_400() {
        let err = ApiError::bad_request("invalid input");
        let resp = err.into_response();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    // A capability the operator has not turned on is not a fault, and it must not
    // read as one: a phone that sees 500 shows "something broke", where the truth
    // is "this host transcribes on the device — do that instead".
    #[test]
    fn unavailable_maps_to_503() {
        let resp = ApiError::unavailable("no server-side STT provider is active").into_response();
        assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn app_error_not_found_converts_to_not_found() {
        let app_err = crate::error::other("session not found");
        let api_err = ApiError::from(app_err);
        assert!(matches!(api_err, ApiError::NotFound(_)));
    }

    #[test]
    fn app_error_other_converts_to_internal() {
        let app_err = crate::error::other("lock poisoned");
        let api_err = ApiError::from(app_err);
        assert!(matches!(api_err, ApiError::Internal(_)));
    }
}
