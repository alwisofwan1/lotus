use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::api_auth::RequireAuth;
use crate::api_server::state::ApiState;
use crate::notification_event::NotificationEvent;

/// `GET /api/notifications/stream` — SSE stream of notification events.
///
/// Each event is a JSON object with a `kind` discriminant field:
///   `agent_stop`   — agent process exited (sourced from hook drop files)
///   `cell_stalled` — cell produced no output beyond the stall threshold
///   `lagged`       — subscriber fell behind; N events were dropped; re-sync recommended
///
/// The stream stays open until the client disconnects.  Keep-alive pings fire
/// every 20 seconds so reverse-proxies and mobile connections stay alive.
/// Authentication uses the same Bearer token as all other API endpoints.
pub async fn stream_notifications(
    _auth: RequireAuth,
    State(state): State<ApiState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.notification_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| match result {
        Ok(event) => encode_event(&event),
        Err(BroadcastStreamRecvError::Lagged(missed)) => {
            encode_event(&NotificationEvent::Lagged { missed })
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(20))
            .text("ping"),
    )
}

/// Serializes a `NotificationEvent` to an SSE `data:` frame.
/// `json_data` uses `serde_json::to_string` internally, which escapes any
/// literal `\r`/`\n` in string fields — the frame therefore never contains
/// raw newlines, satisfying axum's `Event` invariants.
/// Returns `None` only on serialization failure (unreachable in practice).
fn encode_event(event: &NotificationEvent) -> Option<Result<Event, Infallible>> {
    match Event::default().json_data(event) {
        Ok(ev) => Some(Ok(ev)),
        Err(_) => None,
    }
}
