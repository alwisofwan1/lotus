//! A fake Google on 127.0.0.1: answers scripted replies in order and records
//! every request exactly as the real client sent it (method, path + query,
//! headers, body). Shared by `google_auth.rs` and `google_api.rs`.

#![allow(dead_code)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    /// Path and query, as sent.
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }
    pub fn query(&self, name: &str) -> Option<String> {
        let q = self.target.split_once('?')?.1;
        url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
    }
    pub fn form(&self, name: &str) -> Option<String> {
        url::form_urlencoded::parse(&self.body).find(|(k, _)| k == name).map(|(_, v)| v.into_owned())
    }
    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("a JSON body")
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Debug, Clone)]
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self { status, headers: vec![("Content-Type".into(), "application/json".into())], body: body.to_string() }
    }
    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }
}

pub struct FakeGoogle {
    pub base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    replies: Arc<Mutex<VecDeque<Reply>>>,
}

impl FakeGoogle {
    pub async fn start(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind the fake server");
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let replies = Arc::new(Mutex::new(VecDeque::from(replies)));
        let (s, r) = (seen.clone(), replies.clone());
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else { return };
                let (s, r) = (s.clone(), r.clone());
                tokio::spawn(async move {
                    let Some(request) = read_request(&mut socket).await else { return };
                    s.lock().unwrap().push(request);
                    let reply = r.lock().unwrap().pop_front().unwrap_or_else(|| Reply::json(599, serde_json::json!({"unscripted": true})));
                    let mut head = format!("HTTP/1.1 {} Fake\r\nContent-Length: {}\r\nConnection: close\r\n", reply.status, reply.body.len());
                    for (k, v) in &reply.headers {
                        head.push_str(&format!("{k}: {v}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(reply.body.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self { base, seen, replies }
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    pub fn unused_replies(&self) -> usize {
        self.replies.lock().unwrap().len()
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Option<Seen> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let head_end = loop {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target) = (first.next()?.to_string(), first.next()?.to_string());
    let headers: Vec<(String, String)> =
        lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_string(), v.trim().to_string())).collect();
    let length: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < length {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Some(Seen { method, target, headers, body })
}
