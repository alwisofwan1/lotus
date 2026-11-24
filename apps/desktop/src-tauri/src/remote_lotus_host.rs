//! Talking to a Standalone Host that is already running on another machine.
//!
//! **Why this is a bonus and never a requirement.** The scope decided for this connector is that it
//! works against *any* SSH host. Tickets 01–10 assume nothing but `sh`, `git` and an agent CLI. This
//! module is the one place that asks "does this machine happen to run a Lotus Host?", and the whole
//! answer it is allowed to give when the answer is no is: nothing at all.
//!
//! **What adoption is actually for.** Spawning is not the prize — SSH already spawns. The prize is
//! continuity: a cell started from the phone shows up on the canvas, and the other way round.
//!
//! **How it reaches the host without a tunnel.** The host binds loopback on the machine it runs on
//! and writes `{port, secret}` to `~/.lotus/lotus-mcp-ipc.json` — the same discovery file its own
//! MCP sidecar reads. So the round trip is: `cat` the file and `curl` loopback, both on the far
//! side, over the SSH master connection that is already open. No forward tunnel, no pairing, and
//! **the secret never crosses the wire** — it stays in a shell variable on the machine that owns it.
//!
//! **Measured on devbox-vps, 2026-09-17**, because the port in particular cannot be guessed:
//!
//! ```text
//! ~/.lotus/lotus-mcp-ipc.json  →  {"port": 45477, ...}   # not 8787
//! POST /v1/list-fleet  + bearer →  200 {"fleet":[],"snapshot_age_ms":0}
//! POST /v1/list-fleet  no bearer →  401
//! GET  /v1/health      + bearer →  401   # health is not an unauthenticated endpoint
//! POST /v1/dispatch-to-cell, unknown pane → 200 {"ok":false,"error":"no live session for paneId"}
//! ```

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::cli_tools::{run_ssh_shell_command, SshCommandMode, SshToolTarget};
use crate::error::{other, AppError};
use crate::remote_transport::RemoteTransport;

fn quote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Markers around the real answer. A remote shell may greet, and a JSON body cannot be told apart
/// from a motd by looking at it.
pub(crate) const REPORT_BEGIN: &str = "---LOTUS-HOST-BEGIN---";
pub(crate) const REPORT_END: &str = "---LOTUS-HOST-END---";

/// Emitted instead of a report when the machine simply does not run a host.
///
/// Distinct from every failure on purpose: "there is no host here" is the ordinary case for most
/// machines and must never be shown to the operator as something going wrong.
const NO_HOST: &str = "LOTUS_HOST_ABSENT";

/// One cell the host is running, as `/v1/list-fleet` describes it.
/// The two sides of this struct do not agree on spelling, and that is not a mistake.
///
/// `/v1/list-fleet` is an MCP-IPC surface and answers in `snake_case` (`pane_id`, `is_alive`); every
/// other type crossing into the frontend here is `camelCase`. A single `rename_all` would have to
/// pick one and break the other — silently, as an empty fleet from a host that is answering fine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all(serialize = "camelCase", deserialize = "snake_case"))]
pub struct RemoteHostCell {
    pub pane_id: String,
    pub workspace_id: String,
    pub cwd: String,
    pub provider: String,
    pub status: String,
    pub is_alive: bool,
    /// What the host calls it, when `verbose` gave us one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// The tail of its output, when the host had one to offer. A preview, never a transcript.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_output_preview: Option<String>,
    /// Whether this cell has a terminal at all.
    ///
    /// **The field adoption turns on.** A `tui` cell runs under tmux, so a canvas node attaches
    /// to it over ssh and gets the bytes. A headless one has no terminal to attach to — its
    /// runner speaks a structured protocol and the host holds the turns in memory — so it is
    /// adopted as a conversation instead, read through `/v1/cell-conversation`.
    ///
    /// Defaults to `true` for a host that predates the field: every cell such a host could
    /// report on `/v1/list-fleet` came from its PTY manager, so a terminal is the right guess.
    #[serde(default = "yes")]
    pub tui: bool,
}

fn yes() -> bool {
    true
}

/// What the host on a machine has to offer, or the fact that there is none.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostFleet {
    /// `false` means this machine runs no host. The UI shows nothing at all in that case.
    pub available: bool,
    pub cells: Vec<RemoteHostCell>,
}

impl RemoteHostFleet {
    fn absent() -> Self {
        RemoteHostFleet {
            available: false,
            cells: Vec::new(),
        }
    }
}

/// The shell prelude that finds the host and puts its port and secret in variables.
///
/// Release profile first, then dev: a machine running both is running the release one for real
/// work. `sed` rather than a JSON parser because `jq` is not a thing we may require — the file is
/// written by `JSON.stringify(_, null, 2)`, so each field is on its own line and the shape is ours.
///
/// The secret is read into a variable and never echoed. That is the whole reason this is a prelude
/// and not two round trips: fetching the secret to the desktop just to send it back would put a
/// credential on the wire that had no reason to leave the machine.
pub(crate) fn discovery_prelude() -> String {
    format!(
        concat!(
            "_lh_file=\"\"\n",
            "for _f in \"$HOME/.lotus/lotus-mcp-ipc.json\" \"$HOME/.lotus-dev/lotus-mcp-ipc.json\"; do\n",
            "  if [ -r \"$_f\" ]; then _lh_file=\"$_f\"; break; fi\n",
            "done\n",
            "if [ -z \"$_lh_file\" ]; then printf '%s\\n' '{absent}'; exit 0; fi\n",
            "_lh_port=$(sed -n 's/.*\"port\"[ ]*:[ ]*\\([0-9][0-9]*\\).*/\\1/p' \"$_lh_file\" | head -n 1)\n",
            "_lh_secret=$(sed -n 's/.*\"secret\"[ ]*:[ ]*\"\\([^\"]*\\)\".*/\\1/p' \"$_lh_file\" | head -n 1)\n",
            "if [ -z \"$_lh_port\" ] || [ -z \"$_lh_secret\" ]; then printf '%s\\n' '{absent}'; exit 0; fi\n",
        ),
        absent = NO_HOST,
    )
}

/// `curl` one `/v1/*` endpoint with the discovered credentials, wrapped in the markers.
///
/// `-w` appends the status code as its own trailing line, so a 401 (a secret that went stale under
/// us) can be told from a 200 with an empty body and from a host that has stopped answering.
pub(crate) fn call_host(path: &str, body: &serde_json::Value) -> String {
    format!(
        concat!(
            "{prelude}",
            "printf '%s\\n' '{begin}'\n",
            "curl -s -m 8 -X POST \"http://127.0.0.1:$_lh_port{path}\" ",
            "-H \"Authorization: Bearer $_lh_secret\" ",
            "-H 'Content-Type: application/json' ",
            "-d {body} -w '\\nHTTP=%{{http_code}}\\n'\n",
            "printf '%s\\n' '{end}'\n",
        ),
        prelude = discovery_prelude(),
        begin = REPORT_BEGIN,
        end = REPORT_END,
        path = path,
        // Built by serde and quoted whole, so a prompt containing quotes, `$`, or a newline is one
        // shell argument and one JSON string — not two problems stacked on each other.
        body = quote_shell_arg(&body.to_string()),
    )
}

/// This machine's subscription usage (Lotus Host `/v1/usage`, portable accounts step 5).
pub(crate) fn build_usage_script() -> String {
    call_host("/v1/usage", &json!({}))
}

pub(crate) fn build_fleet_script() -> String {
    call_host("/v1/list-fleet", &json!({ "verbose": true }))
}

/// A headless cell's conversation, as `ConversationPage` — the same shape the phone reads.
pub(crate) fn build_conversation_script(pane_id: &str) -> String {
    call_host("/v1/cell-conversation", &json!({ "pane_id": pane_id }))
}

pub(crate) fn build_dispatch_script(pane_id: &str, command: &str) -> String {
    call_host(
        "/v1/dispatch-to-cell",
        &json!({ "pane_id": pane_id, "command": command, "append_newline": true }),
    )
}

/// `(body, http status)` from a wrapped answer, or `None` when the machine runs no host.
pub(crate) fn parse_host_answer(stdout: &str) -> Result<Option<(String, u16)>, AppError> {
    if stdout.contains(NO_HOST) {
        return Ok(None);
    }
    let begin = stdout
        .find(REPORT_BEGIN)
        .ok_or_else(|| other("The machine did not answer about its Lotus Host."))?;
    let rest = &stdout[begin + REPORT_BEGIN.len()..];
    let end = rest
        .find(REPORT_END)
        .ok_or_else(|| other("The machine's answer about its Lotus Host was cut off."))?;
    let body = rest[..end].trim();

    // The status rides on its own trailing line, so the body is everything before it.
    let (payload, status) = match body.rsplit_once("HTTP=") {
        Some((payload, code)) => (
            payload.trim().to_string(),
            code.trim().parse::<u16>().unwrap_or(0),
        ),
        None => (body.to_string(), 0),
    };
    Ok(Some((payload, status)))
}

/// Turn a status code into the sentence the operator needs, or `Ok(())` when it was fine.
pub(crate) fn check_status(status: u16, payload: &str) -> Result<(), AppError> {
    match status {
        200..=299 => Ok(()),
        // The file is there but the credential in it no longer opens the door — a host that was
        // restarted while we held an old read, most likely.
        401 | 403 => Err(other(
            "This machine's Lotus Host rejected the key in its own discovery file. \
             It was probably restarted — reopen the project to read the new one.",
        )),
        0 => Err(other(
            "This machine has a Lotus Host configured, but nothing is answering on its port. \
             The host is not running.",
        )),
        other_code => Err(other(format!(
            "This machine's Lotus Host answered {other_code}: {}",
            payload.chars().take(200).collect::<String>()
        ))),
    }
}

#[derive(Deserialize)]
struct FleetEnvelope {
    #[serde(default)]
    fleet: Vec<RemoteHostCell>,
}

/// What the host on `target` is running, or `available: false` when it runs none.
pub fn remote_host_fleet(
    target: SshToolTarget,
    transport: Option<&RemoteTransport>,
) -> Result<RemoteHostFleet, AppError> {
    let output = run_ssh_shell_command(
        &target,
        &build_fleet_script(),
        SshCommandMode::NoTty,
        transport,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(other(format!(
            "Could not ask {} about its Lotus Host: {}",
            target.host,
            stderr.trim()
        )));
    }

    let Some((payload, status)) = parse_host_answer(&String::from_utf8_lossy(&output.stdout))?
    else {
        return Ok(RemoteHostFleet::absent());
    };
    check_status(status, &payload)?;

    let envelope: FleetEnvelope = serde_json::from_str(&payload).map_err(|error| {
        other(format!(
            "This machine's Lotus Host answered something that is not a fleet ({error})."
        ))
    })?;
    Ok(RemoteHostFleet {
        available: true,
        cells: envelope.fleet,
    })
}

#[derive(Deserialize)]
struct DispatchEnvelope {
    #[serde(default)]
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

/// Send a prompt to a cell the host owns.
///
/// A pane the host has never heard of comes back as `{"ok":false}` with HTTP 200 — an answer, not a
/// transport failure — so it is turned into an error here rather than reported as a success.
pub fn remote_host_dispatch(
    target: SshToolTarget,
    pane_id: String,
    command: String,
    transport: Option<&RemoteTransport>,
) -> Result<(), AppError> {
    let output = run_ssh_shell_command(
        &target,
        &build_dispatch_script(&pane_id, &command),
        SshCommandMode::NoTty,
        transport,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(other(format!(
            "Could not reach {}'s Lotus Host: {}",
            target.host,
            stderr.trim()
        )));
    }

    let Some((payload, status)) = parse_host_answer(&String::from_utf8_lossy(&output.stdout))?
    else {
        return Err(other(format!(
            "{} does not run a Lotus Host any more.",
            target.host
        )));
    };
    check_status(status, &payload)?;

    let envelope: DispatchEnvelope = serde_json::from_str(&payload)
        .map_err(|error| other(format!("Unreadable answer from the Lotus Host ({error}).")))?;
    if !envelope.ok {
        return Err(other(
            envelope
                .error
                .unwrap_or_else(|| "The Lotus Host refused the dispatch.".to_string()),
        ));
    }
    Ok(())
}

/// The turns of a cell the host runs without a terminal.
///
/// Returned as the raw `ConversationPage` the host sent, not a reshaped one: the phone already
/// renders this exact shape, and a second Rust-side model would be a copy to keep in step with a
/// format that is not ours.
pub fn remote_host_conversation(
    target: SshToolTarget,
    pane_id: String,
    transport: Option<&RemoteTransport>,
) -> Result<serde_json::Value, AppError> {
    let output = run_ssh_shell_command(
        &target,
        &build_conversation_script(&pane_id),
        SshCommandMode::NoTty,
        transport,
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(other(format!(
            "Could not reach {}'s Lotus Host: {}",
            target.host,
            stderr.trim()
        )));
    }

    let Some((payload, status)) = parse_host_answer(&String::from_utf8_lossy(&output.stdout))?
    else {
        return Err(other(format!(
            "{} does not run a Lotus Host any more.",
            target.host
        )));
    };
    check_status(status, &payload)?;

    let page: serde_json::Value = serde_json::from_str(&payload)
        .map_err(|error| other(format!("Unreadable conversation from the host ({error}).")))?;
    if page.get("ok").and_then(serde_json::Value::as_bool) == Some(false) {
        // The host runs this pane with a terminal, or not at all. Either way there is no
        // conversation to render, and which of the two it is belongs in the caller's words.
        return Err(other(
            page.get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("that cell has no conversation on this host")
                .to_string(),
        ));
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Run a built script against a throwaway `$HOME` and a `curl` that records what it was asked
    /// to do instead of doing it.
    ///
    /// The point of executing rather than asserting on text: the discovery prelude is `sed` with
    /// three levels of quoting between Rust, `format!` and the shell, and every one of them is a
    /// place where the port silently comes back empty. Only running it can say.
    struct FakeMachine {
        dir: tempfile::TempDir,
    }

    impl FakeMachine {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp dir");
            std::fs::create_dir_all(dir.path().join("bin")).expect("bin");
            FakeMachine { dir }
        }

        fn with_host(self, port: u16, secret: &str) -> Self {
            let lotus = self.dir.path().join(".lotus");
            std::fs::create_dir_all(&lotus).expect("lotus dir");
            // Byte-for-byte the shape `writeMcpIpcDiscovery` produces: JSON.stringify(_, null, 2).
            std::fs::write(
                lotus.join("lotus-mcp-ipc.json"),
                format!("{{\n  \"port\": {port},\n  \"secret\": \"{secret}\"\n}}"),
            )
            .expect("discovery");
            self
        }

        /// A `curl` that writes its arguments and its `-d` body to files, then prints `reply`.
        fn with_curl_replying(self, reply: &str) -> Self {
            let bin = self.dir.path().join("bin");
            let argv = self.dir.path().join("curl-argv");
            std::fs::write(
                bin.join("curl"),
                format!(
                    "#!/bin/sh\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done > {argv}\nprintf '%s' {reply}\n",
                    argv = argv.display(),
                    reply = shell_quote(reply),
                ),
            )
            .expect("fake curl");
            chmod_x(&bin.join("curl"));
            self
        }

        fn run(&self, script: &str) -> String {
            let output = std::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(script)
                .env("HOME", self.dir.path())
                .env(
                    "PATH",
                    format!(
                        "{}:{}",
                        self.dir.path().join("bin").display(),
                        crate::cli_tools::TEST_PATH
                    ),
                )
                .output()
                .expect("run script");
            assert!(
                output.status.success(),
                "script failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).into_owned()
        }

        fn curl_args(&self) -> Vec<String> {
            std::fs::read_to_string(self.dir.path().join("curl-argv"))
                .expect("curl was called")
                .lines()
                .map(ToOwned::to_owned)
                .collect()
        }
    }

    fn shell_quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }

    fn chmod_x(path: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).expect("chmod");
    }

    /// The whole promise of "optional": a machine that runs no host says so, quietly, and nothing
    /// downstream has anything to draw.
    #[test]
    fn a_machine_without_a_host_reports_absence_and_never_calls_curl() {
        let machine = FakeMachine::new().with_curl_replying("should never run");
        let stdout = machine.run(&build_fleet_script());

        assert!(stdout.contains(NO_HOST));
        assert!(
            !stdout.contains(REPORT_BEGIN),
            "there is nothing to report, so there must be no report"
        );
        assert_eq!(parse_host_answer(&stdout).expect("parsed"), None);
        assert!(
            !machine.dir.path().join("curl-argv").exists(),
            "asking a machine with no host must cost no request at all"
        );
    }

    /// The port cannot be guessed — measured 45477 on devbox-vps, while 8787 is only the client's
    /// fallback. This is the test that would have caught that.
    #[test]
    fn the_port_and_key_come_out_of_the_discovery_file() {
        let machine = FakeMachine::new()
            .with_host(45477, "s3cr3t-key")
            .with_curl_replying("{\"fleet\":[]}\nHTTP=200\n");
        machine.run(&build_fleet_script());

        let args = machine.curl_args();
        assert!(
            args.iter().any(|a| a == "http://127.0.0.1:45477/v1/list-fleet"),
            "the discovered port must be the one called: {args:?}"
        );
        assert!(
            args.iter().any(|a| a == "Authorization: Bearer s3cr3t-key"),
            "the discovered key must be the bearer: {args:?}"
        );
    }

    /// The key belongs to the machine that wrote it. Nothing here has a reason to bring it home, so
    /// nothing here may print it.
    #[test]
    fn the_key_never_appears_in_anything_we_read() {
        let machine = FakeMachine::new()
            .with_host(45477, "s3cr3t-key")
            .with_curl_replying("{\"fleet\":[]}\nHTTP=200\n");
        let stdout = machine.run(&build_fleet_script());

        assert!(!stdout.contains("s3cr3t-key"), "the secret leaked into stdout");
        assert!(
            !build_fleet_script().contains("s3cr3t-key"),
            "and it is not in the script either — it is read on the far side"
        );
    }

    #[test]
    fn a_fleet_comes_back_as_cells() {
        let machine = FakeMachine::new().with_host(45477, "k").with_curl_replying(
            r#"{"fleet":[{"pane_id":"p1","workspace_id":"/srv/api","cwd":"/srv/api","provider":"claude","status":"running","is_alive":true,"display_name":"Rowan","last_output_preview":"done"}],"snapshot_age_ms":0}
HTTP=200
"#,
        );
        let stdout = machine.run(&build_fleet_script());
        let (payload, status) = parse_host_answer(&stdout).expect("parsed").expect("present");
        assert_eq!(status, 200);

        let envelope: FleetEnvelope = serde_json::from_str(&payload).expect("a fleet");
        assert_eq!(envelope.fleet.len(), 1);
        assert_eq!(envelope.fleet[0].pane_id, "p1");
        assert_eq!(envelope.fleet[0].display_name.as_deref(), Some("Rowan"));
        assert!(envelope.fleet[0].is_alive);
    }

    /// The field adoption turns on, and the default that keeps an older host usable.
    #[test]
    fn a_cell_says_whether_it_has_a_terminal_at_all() {
        let with_terminal: RemoteHostCell = serde_json::from_str(
            r#"{"pane_id":"p1","workspace_id":"w","cwd":"/srv","provider":"claude","status":"live","is_alive":true,"tui":true}"#,
        ).expect("parse");
        assert!(with_terminal.tui);

        let headless: RemoteHostCell = serde_json::from_str(
            r#"{"pane_id":"ss-9f3a","workspace_id":"w","cwd":"/srv","provider":"claude","status":"live","is_alive":true,"tui":false}"#,
        ).expect("parse");
        assert!(!headless.tui);

        // A host that predates the field could only ever report cells from its PTY manager,
        // so a terminal is the right guess — and guessing the other way would make canvas try
        // to read a conversation from a cell that has none.
        let older: RemoteHostCell = serde_json::from_str(
            r#"{"pane_id":"p1","workspace_id":"w","cwd":"/srv","provider":"claude","status":"live","is_alive":true}"#,
        ).expect("parse");
        assert!(older.tui);

        assert_eq!(serde_json::to_value(&headless).expect("serialize")["tui"], false);
    }

    #[test]
    fn the_conversation_is_asked_for_by_pane_on_its_own_route() {
        let machine = FakeMachine::new()
            .with_host(45477, "k")
            .with_curl_replying("{\"ok\":true,\"paneId\":\"ss-9f3a\",\"turns\":[]}\nHTTP=200\n");
        machine.run(&build_conversation_script("ss-9f3a"));

        let args = machine.curl_args();
        assert!(
            args.iter().any(|a| a == "http://127.0.0.1:45477/v1/cell-conversation"),
            "{args:?}"
        );
        let body = args.iter().position(|a| a == "-d").and_then(|i| args.get(i + 1)).expect("body");
        let sent: serde_json::Value = serde_json::from_str(body).expect("json");
        assert_eq!(sent["pane_id"], "ss-9f3a");
    }

    /// `ok:false` is HTTP 200 here too — a pane the host runs with a terminal instead. Reading
    /// only the status would hand the canvas an empty conversation and call it a success.
    #[test]
    fn a_pane_with_no_conversation_is_a_failure_not_an_empty_page() {
        let page: serde_json::Value =
            serde_json::from_str(r#"{"ok":false,"error":"no headless cell with that paneId on this host","paneId":"sess-1"}"#)
                .expect("parse");
        assert_eq!(page["ok"], false);
        assert!(check_status(200, "").is_ok(), "the request itself was fine");
    }

    /// A prompt is arbitrary text. It has to survive being a JSON string inside a shell argument,
    /// and neither layer may get to interpret it.
    /// The other half of the spelling split, pinned from the frontend's side: what the host calls
    /// `pane_id` must reach TypeScript as `paneId`, or every adopted cell arrives without an id.
    #[test]
    fn what_the_host_spells_snake_case_reaches_the_frontend_camel_case() {
        let from_host: RemoteHostCell = serde_json::from_str(
            r#"{"pane_id":"p1","workspace_id":"/srv/api","cwd":"/srv/api","provider":"claude","status":"running","is_alive":true,"last_output_preview":"ok"}"#,
        )
        .expect("the host's spelling");

        let to_frontend = serde_json::to_value(&from_host).expect("serialize");
        assert_eq!(to_frontend["paneId"], "p1");
        assert_eq!(to_frontend["workspaceId"], "/srv/api");
        assert_eq!(to_frontend["isAlive"], true);
        assert_eq!(to_frontend["lastOutputPreview"], "ok");
        assert!(to_frontend.get("pane_id").is_none(), "no snake_case may survive the trip");

        // And a cell the host gave no name is absent rather than null, so the UI falls back to cwd.
        assert!(to_frontend.get("displayName").is_none());
    }

    #[test]
    fn a_prompt_with_quotes_and_newlines_arrives_intact() {
        let nasty = "Say \"hello\" and don't $STOP\nsecond line";
        let machine = FakeMachine::new()
            .with_host(45477, "k")
            .with_curl_replying("{\"ok\":true}\nHTTP=200\n");
        machine.run(&build_dispatch_script("pane-1", nasty));

        let args = machine.curl_args();
        // The body arrives as one argument; `-d` is the flag before it.
        let body = args
            .iter()
            .position(|a| a == "-d")
            .and_then(|i| args.get(i + 1))
            .expect("a body was sent");
        let sent: serde_json::Value = serde_json::from_str(body).expect("the body is JSON");
        assert_eq!(sent["command"], nasty);
        assert_eq!(sent["pane_id"], "pane-1");
    }

    /// Measured live: an unknown pane is HTTP 200 with `ok:false`. Reading only the status would
    /// report that as a dispatch that worked.
    #[test]
    fn an_ok_false_answer_is_a_failure_even_though_the_request_succeeded() {
        let envelope: DispatchEnvelope =
            serde_json::from_str(r#"{"ok":false,"error":"no live session for paneId"}"#)
                .expect("parse");
        assert!(!envelope.ok);
        assert_eq!(envelope.error.as_deref(), Some("no live session for paneId"));
        assert!(check_status(200, "").is_ok(), "the request itself was fine");
    }

    #[test]
    fn a_stale_key_and_a_dead_host_are_told_apart() {
        let stale = check_status(401, "").unwrap_err().to_string();
        assert!(stale.contains("restarted"), "{stale}");

        let dead = check_status(0, "").unwrap_err().to_string();
        assert!(dead.contains("not running"), "{dead}");

        assert!(check_status(200, "").is_ok());
    }

    #[test]
    fn shell_chatter_around_the_answer_is_dropped() {
        let stdout = format!(
            "Welcome to Ubuntu\n{REPORT_BEGIN}\n{{\"fleet\":[]}}\nHTTP=200\n{REPORT_END}\nlogout\n"
        );
        let (payload, status) = parse_host_answer(&stdout).expect("parsed").expect("present");
        assert_eq!(payload, "{\"fleet\":[]}");
        assert_eq!(status, 200);
    }

    #[test]
    fn a_truncated_answer_is_an_error_not_an_empty_fleet() {
        assert!(parse_host_answer("nothing at all").is_err());
        assert!(parse_host_answer(&format!("{REPORT_BEGIN}\n{{}}")).is_err());
    }

    /// A dev-profile host is found too, but only when there is no release one — a machine running
    /// both is doing real work in the release one.
    #[test]
    fn the_release_host_wins_over_a_dev_one() {
        let machine = FakeMachine::new().with_curl_replying("{\"fleet\":[]}\nHTTP=200\n");
        let dev = machine.dir.path().join(".lotus-dev");
        std::fs::create_dir_all(&dev).expect("dev dir");
        std::fs::write(
            dev.join("lotus-mcp-ipc.json"),
            "{\n  \"port\": 1111,\n  \"secret\": \"dev\"\n}",
        )
        .expect("dev discovery");

        machine.run(&build_fleet_script());
        assert!(
            machine.curl_args().iter().any(|a| a.contains(":1111/")),
            "a dev-only machine is still a machine with a host"
        );

        let both = FakeMachine::new()
            .with_host(45477, "release")
            .with_curl_replying("{\"fleet\":[]}\nHTTP=200\n");
        let dev2 = both.dir.path().join(".lotus-dev");
        std::fs::create_dir_all(&dev2).expect("dev dir");
        std::fs::write(
            dev2.join("lotus-mcp-ipc.json"),
            "{\n  \"port\": 1111,\n  \"secret\": \"dev\"\n}",
        )
        .expect("dev discovery");

        both.run(&build_fleet_script());
        assert!(
            both.curl_args().iter().any(|a| a.contains(":45477/")),
            "with both present the release host is the one that matters"
        );
    }
}
