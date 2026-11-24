//! Wire protocol v1: a frame is `u32` BE header length + JSON header + `u32` BE payload
//! length + raw payload. Terminal bytes travel as the payload so they are never JSON-escaped.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::{self, Read, Write};

pub const PROTO_VERSION: u32 = 1;
/// Header plus payload. Larger frames are refused before anything is allocated.
pub const MAX_FRAME: usize = 8 * 1024 * 1024;
/// Requests added after v1 shipped. A daemon outlives host upgrades and drops a client on a
/// request it cannot parse, so a client sends one only when `hello.features` names it.
pub const FEATURES: &[&str] = &["snapshot"];

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct Owner {
    pub pane_id: Option<String>,
    pub canvas_terminal_id: Option<String>,
    pub window_label: String,
}

/// Everything the daemon needs to start a process. The app builds the complete env;
/// the daemon never reads its own.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct SpawnSpec {
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub owner: Owner,
    /// Opaque to the daemon, handed back in `SessionInfo`: the host keeps its session metadata
    /// here (provider, title, …). Optional fields keep v1 frames from older peers readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct SessionInfo {
    pub id: String,
    pub owner: Owner,
    pub cols: u16,
    pub rows: u16,
    pub total_bytes: u64,
    pub idle: bool,
    pub started_ago_ms: u64,
    pub pid: Option<u32>,
    /// The `cwd` the session was created with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
}

/// Client → daemon. `req` is echoed on the reply so a client can match it among live events.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Request {
    Hello {
        proto: u32,
    },
    Create {
        req: u64,
        spec: SpawnSpec,
    },
    /// Payload = bytes for the program's stdin.
    Write {
        id: String,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: String,
    },
    List {
        req: u64,
    },
    /// `from` is an absolute byte offset (`OutputTail::total_bytes_seen`).
    Attach {
        id: String,
        from: u64,
    },
    Detach {
        id: String,
    },
    /// Feature `snapshot`: the screen as plain text rows, for reading a prompt off it.
    Snapshot {
        req: u64,
        id: String,
    },
}

/// Daemon → client.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum Event {
    Hello {
        proto: u32,
        daemon_pid: u32,
        #[serde(default)]
        features: Vec<String>,
    },
    /// The creator is already attached from offset 0: its output follows without `attach`.
    Created {
        req: u64,
        id: String,
        pid: Option<u32>,
    },
    /// `id` names the session a request was about, e.g. one the daemon no longer has.
    Error {
        req: Option<u64>,
        id: Option<String>,
        message: String,
    },
    Sessions {
        req: u64,
        sessions: Vec<SessionInfo>,
    },
    /// Payload = vt100-formatted screen at `total_bytes`.
    Screen {
        id: String,
        total_bytes: u64,
    },
    /// Payload = output bytes starting at absolute `offset`. `offset > from` means a gap.
    Output {
        id: String,
        offset: u64,
    },
    Exited {
        id: String,
        code: i32,
    },
    /// Payload = the screen's rows as UTF-8 text, trailing blanks trimmed.
    Snapshot {
        req: u64,
        id: String,
        cols: u16,
        rows: u16,
    },
}

fn too_big(n: usize) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("frame of {n} bytes exceeds {MAX_FRAME}"),
    )
}

pub fn write_frame(w: &mut impl Write, header: &impl Serialize, payload: &[u8]) -> io::Result<()> {
    let head = serde_json::to_vec(header)?;
    if head.len() + payload.len() > MAX_FRAME {
        return Err(too_big(head.len() + payload.len()));
    }
    let mut buf = Vec::with_capacity(8 + head.len() + payload.len());
    buf.extend_from_slice(&(head.len() as u32).to_be_bytes());
    buf.extend_from_slice(&head);
    buf.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    buf.extend_from_slice(payload);
    // One write per frame so frames from concurrent writers never interleave on a shared stream.
    w.write_all(&buf)?;
    w.flush()
}

fn read_len(r: &mut impl Read) -> io::Result<usize> {
    let mut n = [0u8; 4];
    r.read_exact(&mut n)?;
    Ok(u32::from_be_bytes(n) as usize)
}

/// Blocks until a whole frame has arrived. `UnexpectedEof` on a clean close between frames.
pub fn read_frame<H: DeserializeOwned>(r: &mut impl Read) -> io::Result<(H, Vec<u8>)> {
    let head_len = read_len(r)?;
    if head_len > MAX_FRAME {
        return Err(too_big(head_len));
    }
    let mut head = vec![0u8; head_len];
    r.read_exact(&mut head)?;
    let payload_len = read_len(r)?;
    if head_len + payload_len > MAX_FRAME {
        return Err(too_big(head_len + payload_len));
    }
    let mut payload = vec![0u8; payload_len];
    r.read_exact(&mut payload)?;
    let header = serde_json::from_slice(&head)?;
    Ok((header, payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<H: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug>(h: H, p: &[u8]) {
        let mut buf = Vec::new();
        write_frame(&mut buf, &h, p).unwrap();
        let (back, payload): (H, Vec<u8>) = read_frame(&mut buf.as_slice()).unwrap();
        assert_eq!(back, h);
        assert_eq!(payload, p);
    }

    fn spec() -> SpawnSpec {
        SpawnSpec {
            argv: vec!["/bin/zsh".into(), "-l".into()],
            env: vec![("TERM".into(), "xterm-256color".into())],
            cwd: Some("/tmp".into()),
            cols: 120,
            rows: 40,
            owner: Owner {
                pane_id: Some("pane-1".into()),
                canvas_terminal_id: None,
                window_label: "main".into(),
            },
            tag: Some(r#"{"title":"x"}"#.into()),
        }
    }

    #[test]
    fn every_request_roundtrips() {
        let id = || "s1".to_string();
        for (r, p) in [
            (
                Request::Hello {
                    proto: PROTO_VERSION,
                },
                &b""[..],
            ),
            (
                Request::Create {
                    req: 7,
                    spec: spec(),
                },
                b"",
            ),
            (Request::Write { id: id() }, b"ls\r\x1b[A\xe2\x82"),
            (
                Request::Resize {
                    id: id(),
                    cols: 80,
                    rows: 24,
                },
                b"",
            ),
            (Request::Kill { id: id() }, b""),
            (Request::List { req: 8 }, b""),
            (
                Request::Attach {
                    id: id(),
                    from: 1 << 40,
                },
                b"",
            ),
            (Request::Detach { id: id() }, b""),
            (Request::Snapshot { req: 9, id: id() }, b""),
        ] {
            roundtrip(r, p);
        }
    }

    #[test]
    fn every_event_roundtrips() {
        let id = || "s1".to_string();
        let info = SessionInfo {
            id: id(),
            owner: spec().owner,
            cols: 80,
            rows: 24,
            total_bytes: 300_000,
            idle: true,
            started_ago_ms: 5,
            pid: Some(9),
            cwd: Some("/tmp".into()),
            tag: Some(r#"{"provider":"claude"}"#.into()),
        };
        for (e, p) in [
            (
                Event::Hello {
                    proto: PROTO_VERSION,
                    daemon_pid: 42,
                    features: vec!["snapshot".into()],
                },
                &b""[..],
            ),
            (
                Event::Snapshot {
                    req: 9,
                    id: id(),
                    cols: 80,
                    rows: 24,
                },
                b"$ ls\nREADME",
            ),
            (
                Event::Created {
                    req: 7,
                    id: id(),
                    pid: None,
                },
                b"",
            ),
            (
                Event::Error {
                    req: None,
                    id: Some(id()),
                    message: "no such session".into(),
                },
                b"",
            ),
            (
                Event::Sessions {
                    req: 8,
                    sessions: vec![info],
                },
                b"",
            ),
            (
                Event::Screen {
                    id: id(),
                    total_bytes: 9,
                },
                b"\x1b[H\x1b[2Jhi",
            ),
            (
                Event::Output {
                    id: id(),
                    offset: 9,
                },
                &[0u8, 255, 0x1b][..],
            ),
            (Event::Exited { id: id(), code: -1 }, b""),
        ] {
            roundtrip(e, p);
        }
    }

    #[test]
    fn the_tag_is_t_in_snake_case() {
        let v = serde_json::to_value(Request::List { req: 1 }).unwrap();
        assert_eq!(v["t"], "list");
    }

    /// A socket hands over a frame in pieces; the reader must stitch them.
    struct OneByteAtATime<'a>(&'a [u8]);
    impl Read for OneByteAtATime<'_> {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.0.is_empty() || out.is_empty() {
                return Ok(0);
            }
            out[0] = self.0[0];
            self.0 = &self.0[1..];
            Ok(1)
        }
    }

    #[test]
    fn a_frame_arriving_byte_by_byte_is_read_whole() {
        let mut buf = Vec::new();
        write_frame(
            &mut buf,
            &Event::Output {
                id: "a".into(),
                offset: 3,
            },
            b"one",
        )
        .unwrap();
        write_frame(&mut buf, &Request::Detach { id: "b".into() }, b"").unwrap();
        let mut r = OneByteAtATime(&buf);
        let (e, p): (Event, _) = read_frame(&mut r).unwrap();
        assert_eq!(
            e,
            Event::Output {
                id: "a".into(),
                offset: 3
            }
        );
        assert_eq!(p, b"one");
        let (q, _): (Request, _) = read_frame(&mut r).unwrap();
        assert_eq!(q, Request::Detach { id: "b".into() });
        let end = read_frame::<Request>(&mut r).unwrap_err();
        assert_eq!(end.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn a_truncated_frame_is_an_error_not_a_message() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &Request::Kill { id: "s".into() }, b"xyz").unwrap();
        buf.truncate(buf.len() - 1);
        let err = read_frame::<Request>(&mut buf.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[test]
    fn a_frame_over_8mb_is_refused_both_ways() {
        let big = vec![0u8; MAX_FRAME];
        let err =
            write_frame(&mut Vec::new(), &Request::Write { id: "s".into() }, &big).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);

        // A hostile length prefix must fail before allocating 4 GB.
        let mut wire = Vec::new();
        wire.extend_from_slice(&2u32.to_be_bytes());
        wire.extend_from_slice(b"{}");
        wire.extend_from_slice(&u32::MAX.to_be_bytes());
        let err = read_frame::<serde_json::Value>(&mut wire.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);

        let mut wire = Vec::new();
        wire.extend_from_slice(&u32::MAX.to_be_bytes());
        let err = read_frame::<serde_json::Value>(&mut wire.as_slice()).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[test]
    fn exactly_8mb_passes() {
        let head = serde_json::to_vec(&Request::Write { id: "s".into() }).unwrap();
        let payload = vec![7u8; MAX_FRAME - head.len()];
        roundtrip(Request::Write { id: "s".into() }, &payload);
    }

    #[test]
    fn frames_without_tag_or_cwd_still_parse() {
        // A v1 peer from before these fields: SessionInfo and SpawnSpec as they were.
        let info: SessionInfo = serde_json::from_str(
            r#"{"id":"s1","owner":{"pane_id":null,"canvas_terminal_id":null,"window_label":"main"},
                "cols":80,"rows":24,"total_bytes":0,"idle":true,"started_ago_ms":0,"pid":null}"#,
        )
        .unwrap();
        assert_eq!((info.cwd, info.tag), (None, None));
        let spec: SpawnSpec = serde_json::from_str(
            r#"{"argv":["sh"],"env":[],"cwd":null,"cols":80,"rows":24,
                "owner":{"pane_id":null,"canvas_terminal_id":null,"window_label":"main"}}"#,
        )
        .unwrap();
        assert_eq!(spec.tag, None);
        // And without them set, nothing new goes on the wire for an older peer to meet.
        let out = serde_json::to_string(&SessionInfo {
            cwd: None,
            tag: None,
            ..info
        })
        .unwrap();
        assert!(!out.contains("tag") && !out.contains("cwd"), "{out}");
        // A daemon from before `features` offers none.
        let hello: Event =
            serde_json::from_str(r#"{"t":"hello","proto":1,"daemon_pid":7}"#).unwrap();
        assert!(matches!(hello, Event::Hello { features, .. } if features.is_empty()));
    }
}
