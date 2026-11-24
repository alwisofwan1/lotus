//! The one-shot server Google's desktop sign-in redirects to (PLAN G3):
//! `127.0.0.1` on a free port. The browser's own request carries the code;
//! the tab then shows whether Lotus is connected, so the user knows to go back.
//!
//! No timeout or cancel lives here: the caller drops [`Loopback::receive`]'s
//! future (a `select!` or `timeout`), which closes the port.

use std::future::Future;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::GoogleError;

/// Longest request line read; a redirect with a code is well under 2 KB.
const MAX_REQUEST: usize = 16 * 1024;

pub struct Loopback {
    listener: TcpListener,
    port: u16,
}

impl Loopback {
    pub async fn bind() -> Result<Self, GoogleError> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| GoogleError::Failed(format!("Lotus could not listen for Google's reply: {e}")))?;
        let port = listener.local_addr().map_err(|e| GoogleError::Failed(e.to_string()))?.port();
        Ok(Self { listener, port })
    }

    /// The `redirect_uri` for this attempt. Google allows any port on the
    /// loopback address for a Desktop client.
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Waits for the redirect, runs `handle` on its target (`/?state=…`), and
    /// answers the browser with the outcome. Any other request (a favicon, a
    /// probe) gets a 404 and the wait goes on.
    pub async fn receive<F, Fut>(self, handle: F) -> Result<String, GoogleError>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = Result<String, GoogleError>>,
    {
        loop {
            let (mut stream, _) = self
                .listener
                .accept()
                .await
                .map_err(|e| GoogleError::Failed(format!("Google's reply did not arrive: {e}")))?;
            let Some(target) = read_target(&mut stream).await else { continue };
            if !is_redirect(&target) {
                let _ = respond(&mut stream, "404 Not Found", "Not found").await;
                continue;
            }
            let outcome = handle(target).await;
            let body = match &outcome {
                Ok(message) => page("Lotus is connected to Google", message),
                Err(e) => page("Lotus is not connected", &e.to_string()),
            };
            let _ = respond(&mut stream, "200 OK", &body).await;
            return outcome;
        }
    }
}

/// Google's redirect: the root path with a `state` (sent with a code or an error).
fn is_redirect(target: &str) -> bool {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    path == "/" && query.split('&').any(|p| p.starts_with("state="))
}

/// The target of a `GET` request line, or `None` for anything else.
async fn read_target(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(2).any(|w| w == b"\r\n") {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 || buf.len() + n > MAX_REQUEST {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let line = String::from_utf8_lossy(&buf);
    let mut parts = line.lines().next()?.split(' ');
    (parts.next()? == "GET").then(|| parts.next().map(str::to_string)).flatten()
}

async fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    stream.shutdown().await
}

/// A plain page for the browser tab. Both texts are escaped: an error can
/// quote what Google sent.
fn page(title: &str, message: &str) -> String {
    let (title, message) = (escape(title), escape(message));
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#171613;color:#F7F2EA;\
         display:grid;place-items:center;min-height:100vh;margin:0}}main{{max-width:28rem;padding:2rem}}\
         h1{{font-size:18px;margin:0 0 .5rem}}p{{color:#B6B2AA;margin:0}}</style></head>\
         <body><main><h1>{title}</h1><p>{message}</p><p>You can close this tab and go back to Lotus.</p></main></body></html>"
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
