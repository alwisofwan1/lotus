# `contract/` — the `/m/*` surface shared by host and Pocket

This directory is the agreement between **`packages/host`** (which serves it) and
**`apps/pocket`** (which consumes it). Decided in
[`plans/lotus-pocket/PLAN.md`](../plans/lotus-pocket/PLAN.md) ADR-10.

## What this is, and what it deliberately is not

The contract is **a set of real payloads plus this document**. There is no OpenAPI
file, no JSON Schema, and no code generation.

That is a decision, not an omission:

- Dart 3's `sealed class` + exhaustive `switch` is the idiom Flutter's own docs
  use, and it is checked at compile time. Hand-written `fromJson` factories with
  pattern matching are what Flutter's networking cookbook teaches — codegen is not
  the paved road here.
- OpenAPI has no first-class WebSocket support, and half of this surface is a
  message union, so it would only describe the REST half.
- With one operator, one repository and one commit per change, the only risk left
  is a hand-written Dart model drifting from what the host actually sends. That
  needs a shared payload, not a schema language.

So: `fixtures/` holds one real payload per message shape, and **both sides test
against the same files**.

| Side | Test asserts |
|---|---|
| `packages/host` | "the façade produces this" — `src/adapters/mobile/__tests__/contract-fixtures.test.ts` (WS + pair/bootstrap) and `contract-rest-fixtures.test.ts` (the rest) |
| `apps/pocket` | "my sealed classes parse this" — lands with the Flutter app |

Change a shape on either side without updating the fixture and the other side
goes red. The failure mode is a red test, not a `null` field on a phone far from
a debugger.

### What is on disk

| Fixture | Produced by |
|---|---|
| `stream-hello` · `stream-fleet-changed` · `stream-cell-output` · `stream-cell-truncated` · `stream-notification` · `stream-conversation` | every `ServerEvent` variant — a test fails if the union grows past this list |
| `stream-conversation-text` | the same frame carrying a **`text` delta** rather than a part: the shape streaming prose actually arrives in |
| `rest-pair` · `rest-bootstrap` | `POST /m/pair`, `GET /m/bootstrap` |
| `rest-bootstrap-headless` | the same route on a host that can run agents **without a terminal** — `structured-spawn` in `features`, and `headless: true` on the runners it actually reaches (`codex`, `cursor`), and `terminal: false` on `cursor`, which this host can only run headless. `rest-bootstrap` is the host that cannot, and is kept because absent-means-no is the rule a client must keep parsing. |
| `rest-transcript` · `rest-permission` | the two routes Chat mode reads |
| `rest-permission-question` | the same route on a cell holding a **question** — carried whole, with the digit that answers each option |
| `rest-transcript-unsupported` · `rest-permission-unsupported` | the same routes on a host with no hook pipeline |
| `rest-conversation` | the transcript page as turns of typed parts — what a runner-agnostic Chat renders |
| `rest-conversation-unsupported` | the same route on a desktop without the transcript read |
| `rest-conversation-native` | the page for a cell this host runs itself over `codex app-server` — provenance `native`, streaming text, tool output, a `result` |
| `rest-devices-refresh` | `POST /m/devices/refresh` — the 72-hour TTL renewal |
| `rest-stt` · `rest-stt-unsupported` | dictation, and a host that transcribes on the device instead |
| `stream-hello-standalone` | the same first frame from a **bare** VPS host — no Codex, no agent hook — with **five** fewer features: `transcript`, `permission`, `stt`, `spawn-tuning`, `conversation` (`adapters/mobile/events.ts` → `DESKTOP_ONLY_FEATURES`). Was seven until 2026-09-05, when `spawn` and `close` became base for both modes: a standalone host now serves `/api/fleet/spawn` and `/api/fleet/close` itself against its own `HostedProject` (`routes/fleet-lifecycle.ts`). Note `spawn` without `spawn-tuning` is a supported shape: the phone draws the summon sheet with no model or effort knobs. |
| `stream-hello-standalone-hooked` | the same VPS **as it actually runs**: the host installs an agent hook for itself on startup, and since 2026-09-06 that hook buys the Chat capabilities back — `permission`, `transcript`, `conversation`, and since 2026-09-07 `conversation-stream` (`HOOK_FEATURES`). It is what lets the phone draw Chat against a machine with no desktop behind it. A standalone host running Codex reclaims the same three by the other route, `STRUCTURED_FEATURES`. Neither reclaims `stt` or `spawn-tuning`: those need a desktop, and no hook can conjure one. |
| `usage-snapshot` | `POST /v1/usage` on a host (`/v1/*`, not `/m/*`): `{ machine, accounts: UsageAccount[] }`, the desktop's own camelCase `UsageAccount`. Three rows: a fresh Claude account with a model-scoped window and `identity`, an idle one showing last-known numbers (`asOfMs`), and a Codex row. Produced by `core/accounts/__tests__/usage-service.test.ts`; the desktop's Rust check is added separately. |

Routes with no fixture are **waived by name** in `contract-rest-fixtures.test.ts`,
each with its reason, and the waiver list is checked against the router's own
route table. So a new route cannot ship undocumented: it either names a fixture or
states why it needs none. That guard exists because the first three routes on the
Chat surface did ship undocumented, and every unit test stayed green.

### Regenerating

Fixtures are **generated from the live handlers**, never hand-edited:

```bash
cd packages/host
UPDATE_CONTRACT_FIXTURES=1 bunx vitest run src/adapters/mobile/__tests__/contract-fixtures.test.ts
UPDATE_CONTRACT_FIXTURES=1 bunx vitest run src/adapters/mobile/__tests__/contract-rest-fixtures.test.ts
```

Review the diff before committing. A diff you did not expect is the signal this
mechanism exists to produce.

## Transport shape

One WebSocket per host for everything push-shaped; HTTP for every mutation.
Mutations stay on HTTP so each carries its own bearer and lands in the audit trail
as one request (ADR-8).

```
WS   /m/stream          one connection per device
       ← hello              first frame, always
       ← fleet.changed
       ← cell.output
       ← cell.truncated
       ← notification
       → subscribe          { paneId: string | null }
       → resume             { paneId, fromByte }
       → ping

HTTP
  POST   /m/pair                    { pairingCode, deviceName } → credential + host identity
  GET    /m/bootstrap?workspaceId=  → cells, projects, workspaces, activeTasks, hostCaps
  POST   /m/cell/:paneId/dispatch   { text }         a sentence — submit key appended
  POST   /m/cell/:paneId/input      { data }         a key press — nothing appended
  POST   /m/cell/:paneId/stop       interrupts the current turn
  POST   /m/cell/:paneId/posture    { mode }  moves a running cell's stop, without restarting it
  GET    /m/cell/:paneId/transcript → what Chat renders: hook events, oldest first
  GET    /m/cell/:paneId/conversation → the same page as turns of typed parts, with per-runner capabilities
  POST   /m/cells                   { provider, workspaceId?, initialPrompt?, permissionMode?, runnerId?, model?, effort?, tui? }
                                    tui: false → this host runs the agent itself, no terminal (feature `structured-spawn`)
  GET    /m/cell/:paneId/permission → what the cell is asking, and the answers it offers
  GET    /m/cell/:paneId/result     → the closing words, and what differs from HEAD in its directory
  GET    /m/cell/:paneId/diff?file= → one file's unified diff against HEAD (64 KiB cap, `truncated`)
  GET    /m/fs?path=                → the roots this host opens, and one level of `path`
  POST   /m/projects                { path }  takes a folder already on the machine
  DELETE /m/projects/:id            forgets one — the directory is never touched
  POST   /m/projects/clone          { url, branch?, name? } → the clone job, not its result
  GET    /m/projects/clone/:taskId  → where that clone got to: state, step, and git's own error
  POST   /m/stt                     { audioBase64, mime, prompt? } → { text, provider }
  GET    /m/tasks?workspaceId=
  POST   /m/tasks                   { workspaceId, title, goal }
  PATCH  /m/tasks/:id               { workspaceId, … }
  GET    /m/devices
  POST   /m/devices/refresh
  POST   /m/devices/renew/challenge { deviceId } → { nonce, expiresAt }       (no bearer)
  POST   /m/devices/renew           { deviceId, nonce, signature } → token   (no bearer)
  POST   /m/devices/push-token    { token, platform: "fcm" } → { ok: true }
  DELETE /m/devices/push-token    stops wake-ups for the calling device
  DELETE /m/devices/:deviceId
```

`/m/pair` is the only route reachable without a bearer — and since `issues/07` chose a
route with no Cloudflare Access in front of it, the only unauthenticated door facing the
internet. It answers **429** in two cases a client must tell apart from 401: the source is
throttled (three attempts, one back every ten seconds), or redeeming is locked out after
five failures anywhere. Neither means the code is wrong, so a client that renders 429 as
"bad code" sends the operator to fetch a new one they did not need.

### Details worth knowing before writing a client

Every one of these is a place where the obvious model is the wrong model.

**A lapsed bearer can come back on a signature, if the phone registered a key.** `POST /m/pair`
takes an optional `refreshKey`: a base64 SubjectPublicKeyInfo of an EC P-256 key held in the phone's
hardware, usable only after the operator proves presence. A host that advertises `device-renew`
stores it. Renewal is two calls with no bearer: ask `/m/devices/renew/challenge` for a nonce, then
send `/m/devices/renew` a DER ECDSA/SHA-256 signature over the UTF-8 bytes of
`lotus-renew/v1\n<deviceId>\n<nonce>`. The nonce works once, for two minutes. Success restarts
**both** `expiresAt` and `hardExpiresAt`; every refusal is the same 401, so the route does not say
which device ids exist. A host without `device-renew` ignores `refreshKey` — so send it, and keep the
private half only if the reply advertises the feature.

**A refresh does not kill the bearer it replaces — the first use of the new one does.**
The host rotates before its reply leaves, so a reply lost on a dropping link used to leave
the phone holding a token the host had already forgotten. The previous bearer now keeps
working, and can refresh again, until the new one is presented or until the expiry it had
before the refresh — whichever comes first. A client needs no special handling: keep using
what you hold until a refresh reply actually arrives.

**`projects` and `workspaces` are not two names for one list.** `workspaces` is
grouped from the cells that are running right now, so a project whose agents have
all ended cannot appear in it — its group would be empty and there is nothing to
group. `projects` is the host's registry: what exists, running or not. A client
that lists workspaces loses a project the moment its last agent exits, which is
how a project became unreachable from the phone (ADR-14, `plans/lotus-pocket`).
Join the two on `workspaceId`, which is the same string on both sides. `projects`
is `[]` from a desktop older than the route — that host can only describe what is
running, and a client should degrade to that rather than refuse to start.

**`GET /m/fs` is a jail, and the shape says so.** It answers **directories only** — never a
file name, and there is no route anywhere that serves a file's contents. `roots` rides on
every answer, so a client draws the top level without a second call and can tell the
operator *which* places this machine opens. `page.parent` is **null at a root**: there is
nothing above it a client may offer a way up to, and a disabled control would teach the
operator that there is. **403** means outside every root — a wall; **404** means a wrong
turn inside one. Containment is decided on the *resolved* path, so a symlink inside a root
that points out of it is refused like any other outside path.

**Taking a folder copies nothing, and forgetting one deletes nothing.** `POST /m/projects`
registers a directory that was already there, and answers with the `HostedProject` it
became — `id` may not be the folder's name, because two directories on one machine can
share one and `workspaceId` is what a cell is addressed by (`pocket`, then `pocket-2`).
Its refusals are the browse ones plus one of its own: **403** outside every root, **404**
for a directory that is not there, **409** for one this host already holds — including one
the scan found, which is not an error so much as *it is already on your list*.
`DELETE /m/projects/:id` removes the claim and nothing else; a client that words it as
"delete project" is lying about what the host did.

**`projects-create` and `projects-browse` are two flags, and a host can have one without
the other.** Cloning needs a `PROJECTS_ROOT` to clone into; browsing needs a directory to
open, and a machine may have the first configured long before its operator names a single
`LOTUS_BROWSE_ROOTS` entry. One flag would draw a folder picker against a host that opens
no folders. A client that offers a way in per flag degrades correctly on both.

**`projects-create` follows the workspace root, not the host mode.** A standalone host
advertises it only when it has a `PROJECTS_ROOT` to clone into; one configured with a
fixed `PROJECTS_JSON` list has nowhere to put a clone and would answer **503** to every
ask, so the flag stays off and a client draws no way in. A desktop never advertises it —
that route is not on its API at all, and `POST /m/projects/clone` passes its **404**
straight through, which a client reads as *not here* rather than as a failure.

The other three statuses are forks a client must tell apart, and none of them is a bug:
**400** names a folder name that cannot become a project (a separator, a dot entry, or one
starting with `.` — the registry scan skips dotfiles, so such a clone would succeed and
never appear), and **409** names one already taken. Both ask for a different name; neither
means the machine is broken.

**`result` is git's answer, not the agent's.** The transcript says which files an agent
*reported* editing; `/result` asks the working tree what actually differs from `HEAD`, and
lists untracked files the hook ring can never see. `changes: null` comes with a `reason`
— `no_cwd` (the fleet knows no directory for that pane), `not_a_repo`, `git_failed` — and
a client renders those as *not knowable here*, never as "nothing changed". `added`/
`removed` are `null` per file for a binary, or for an untracked file past the measuring
cap; the totals skip them. `closing` is the last `stop` body as the desktop kept it —
clipped at 8000 bytes and flagged `truncated` when so — and is `null` on a host with no
ring. Compare `rest-result.json` with `rest-result-no-cwd.json`.

**A cell's second line has three sources, in this order.** `headline` — the operator's
own ask, first line, as the desktop card shows it — says what the agent is *working on*;
it is absent for a pane the desktop never saw asked (a runner whose hooks do not reach
it). `lastOutputPreview` is the last meaningful line of the PTY ring, escapes stripped,
chrome skipped; the desktop fills it from the ring when the UI did not. Neither present,
a client falls back to `turn` plus `turnAgeMs` (`idle 12m`) and, failing that, draws
nothing — never a placeholder.

**`status` and `turn` are different things.** `status` is launch phase ("this pane
exists and is running"); `turn` is turn phase ("this agent is waiting for a
human"). `turn` is absent for runners that do not report it — that means
*unknown*, not *not waiting*. Render those two differently.

**`terminal: false` means the cell has no terminal** — a Chat cell the host runs over a
structured protocol (`POST /m/cells` with `tui: false`). A client hides its Terminal view.
Absent means it has one, which is every cell before this field existed (added 2026-11-20).

**Resume is addressed by byte, not by event id.** The only replay source is the
64 KB PTY ring buffer, which is byte-addressed, so a client asks
`{ paneId, fromByte }`. When the buffer no longer reaches that far back the host
answers `cell.truncated` rather than silently serving a later position.

**Dictation sends audio, never a key, and can answer "not here".** ADR-11 keeps API
keys off the phone: the phone records, the host calls the provider, and the response
names the provider id only. A host set to transcribe on the device — `browser` is the
shipped default — answers `200 { text: null, hostSupports: false }`, which is a fork
rather than a failure: record again with the platform recognizer. A real provider
failure still arrives as 5xx. Bodies are capped at 8 MiB of base64 on both hops.

**`hostSupports: false` is not `false`-the-answer, it is "this host cannot know".**
The field is **absent** from a host whose hook pipeline is working, and `false` from
one whose is not. Two different hosts answer `false`, for the same reason:

- A **Standalone Host** on a VPS **whose agent hook is not installed.** It then has no
  `pane_turn`, and no way to learn where a runner keeps its history, so there is nothing it
  could read.

  The older text here said such a host "has no watcher, no transcript store and no `pane_turn`
  at all — it never will", and that was wrong twice over by 2026-09-06. It has a turn map and a
  drop-file watcher (`adapters/mobile/hooks/`), and it reads the runner's **own** transcript file
  rather than keeping a store of its own — which is the better source anyway: the desktop's
  60-entry ring evicted 11.7% of entries and started empty after every restart, and the CLI's
  file has neither limit. A hooked VPS host answers `/transcript` and `/conversation` with a real
  conversation and no desktop anywhere (`stream-hello-standalone-hooked.json`).
- A **desktop** whose hooks are installed somewhere its own agents do not read.
  Claude resolves its settings from `CLAUDE_CONFIG_DIR`, so an agent spawned under a
  ccs profile reads `~/.ccs/instances/<profile>/settings.json` *instead of*
  `~/.claude/settings.json` — and hooks in the second are hooks the agent never runs.
  Measured 2026-08-09: two `claude -p` runs differing only in that variable produced
  two hook events and zero. The desktop reports this on
  `GET /m/cell/:paneId/transcript`, and it is fixable on that machine.

So `awaiting: false, hostSupports: false` must never render as "nothing to do", and
`total: 0, hostSupports: false` must never render as "nothing happened yet". Both
render as "not knowable here", with Terminal as the way through. Compare
`rest-permission-unsupported.json` with `rest-permission.json` — the difference is
the whole point of the field.

**`runnerReports: false` is a third silence, and it is about the CLI, not the host.**
Same shape, same rule — absent means it reports, `false` is the host saying this pane's
runner has nothing to report *with*. Codex's entire surface into Lotus is one
`agent-turn-complete` notify carrying a pane id, so no prompt, no tool step and no prose
ever reach the ring: its transcript is empty forever on a perfectly healthy desktop.

Keep it apart from `hostSupports` because the operator's next move differs. That one
sends them to the desktop to fix a misinstalled hook; this one has nothing to fix, and
sending them there would waste the trip. `rest-transcript-runner-silent.json` is the
fixture; both fields can be `false` at once, and the host-wide fault is the one to name
first, since fixing it is what makes every *other* pane work.

**An empty `entries` with both fields absent means something else entirely**: the host
can record, this runner reports, and this pane has nothing yet. The transcript ring lives in memory, so
that is the normal state after a desktop restart, and a client that draws it the same
as the paragraph above is throwing away the only distinction that tells an operator
whether to wait or to go and fix something.

**`transcriptOutlook` is the same question with the missing third answer, and new
clients should prefer it.** `runnerReports` has two values and three cases: its absence
has to carry both "steps are coming" and "this host cannot say", and those are not the
same promise. The pane→runner map is pushed by the desktop UI (ADR-1), so it is empty
after every restart and until a Canvas board is on screen — measured 2026-08-10 on a
desktop twelve minutes up with `/canvas` loaded, answering absent for every pane,
including a Codex cell it had called `false` minutes before. A client that reads absence
as a promise waits forever on a screen nobody was going to fill.

| `transcriptOutlook` | meaning | what the operator should do |
|---|---|---|
| absent | a transcript is expected | wait, or pull to refresh |
| `"never"` | no Chat for this cell, ever — either the runner reports nothing, or this host has no reader for what it writes | stop waiting, open the raw terminal |
| `"unknown"` | this host cannot place the pane | neither — say so, and offer the terminal |

**Both roads to `"never"` are one answer on purpose.** A Standalone Host reads claude's
transcript file and not codex's, so a codex cell there has no Chat page — and until
2026-09-08 it said so with `hostSupports: false`, which is a claim about the *machine*.
A phone renders that as "this machine is not recording what its agents do — check Lotus on
that desktop", printed over a codex cell sitting beside a claude cell whose Chat was
working, on a host with no desktop behind it. Both answers are approximations of the one
fact that matters — there will never be a page for this cell — and this is the one whose
advice is the advice that works. It also stops two hosts disagreeing about the same cell:
a desktop already answers `"never"` for codex.

`runnerReports` is still sent, unchanged, so a client built before this field keeps
behaving exactly as it did. Do not derive one from the other: `runnerReports: false`
always implies `"never"`, but absent implies nothing at all.

**`awaiting: true` with `prompt: null` is an honest answer with its own meaning:**
it is waiting, but the options could not be read. Render a pointer to the raw
terminal, not an empty state and not a guessed pair of buttons.

**A push names the agent and says one sentence — nothing from the event itself.** The FCM
message is `notification: { title: "<agent name>", body: "needs you" | "finished" |
"stopped with an error" }` plus `data: { kind: "attention" | "finished", paneId }`. That is
the whole vocabulary: no project, no path, no command, no prompt. Android draws it without
the app running; `paneId` (an opaque uuid the host minted) is there so a tap can open the
right agent. The host module builds the message from a closed `PushMessage` shape with no
field for `tool_target`, `cwd` or `user_prompt`, so the events behind it —
`stream-notification.json` carries `tool_target: "rm src/legacy/shim.ts"` and
`cwd: "/Users/op/code/lotus"` — cannot leak through by accident. Two pushes from the same
pane share an Android `tag`, so the newer replaces the older; a *finished* push is sent
only for an ask that came from the phone (`issues/04`, 2026-08-27, which revised the
earlier nobody-is-named rule of 2026-08-06).

**Permission options are rendered verbatim and answered by their printed digit.**
`key` is what was printed next to the label, never derived from position — a prompt
whose first option scrolled away starts at `2`, and "the first button" sending `1`
would answer a different question than the one shown. Labels are not paraphrased
either: the mockup for this screen once invented an option label that the real
prompt does not use.

**`readback` is text, and it is absent whenever `prompt` is.** Speak it with the
device's own TTS — reading a known string aloud is easy anywhere, so no API key is
involved (ADR-11). It is built from the prompt's own words so that what is heard
matches what is pressed; the only thing dropped is a keyboard chord in parentheses.

**`/conversation` is `/transcript` with the guessing done host-side, once.** A
`TranscriptEntry` is one hook event, and its `body` is a path, a prompt or a reply depending
on `event`; a client rebuilt turns by watching `userPrompt` change and `stop` go by, and a
tool's call and result were two unrelated rows. `GET /m/cell/:paneId/conversation` serves the
same page — same `before`/`limit`, same cursor, same `source`/`hasMore`/`totalEver`/
`hostSupports`/`transcriptOutlook` — as `turns[]` of typed `parts[]` following the Agent
Client Protocol vocabulary: `user_message`, `assistant_text{state,truncated}`, `reasoning`,
`tool_call{toolName,title,kind,status,locations,diff?,output?}`, `permission`, `plan_update`,
`mode_change`, `status`, `result`, `error`, and `unknown{rawType,summary}` for an event the host
could not name (kept, never dropped). Every part has a stable `id`, a `seq`, and a `provenance`
— `hook` (rebuilt from the ring), `derived` (reshaped from the runner's file), `native` (not
yet produced by any host). Beside the turns rides `capabilities`, one of
`expected` / `partial` / `never` **per part kind per runner**: the question `transcriptOutlook`
answers with one bit for the whole pane, answered per section so a client can say "Codex does
not report reasoning here" instead of drawing an empty screen. `hostCaps.features` advertises
`conversation`; a client that knows the shape draws `/transcript` against a host that does
not. `/transcript` itself is unchanged and stays for phones already in pockets. Design and the
per-runner matrix: `plans/pocket-chat-conversation-model/RESEARCH.md`.

**A cell can have no terminal at all (`tui: false`, feature `structured-spawn`).** `POST /m/cells`
with `tui: false` makes *this host* — not the desktop — run the agent over its structured
protocol (`codex app-server`, JSON-RPC over stdio; Codex only today) and mint a `paneId` of its
own (`ss-…`). It then looks like any other cell: merged into `/m/bootstrap` `cells[]` and
`fleet.changed`, `turn` is `running` / `needs-input` / `idle` from the protocol rather than a
terminal, `/dispatch` starts a turn, `/stop` interrupts it, `DELETE` ends the process, and
`/permission` answers from a real approval request whose options are `1 Allow once · 2 Allow for
this session · 3 Decline`, answered through `/input` with the digit — the same shape a Claude
pane's terminal scrape produces, so a phone in the field needs no update. `/transcript` and the
`notification` frames are **derived from the native parts** (`entries-from-parts.ts`), stamped
with each part's own time so REST and live never draw one step twice; `/conversation` serves the
native page itself (`rest-conversation-native.json`: provenance `native`, streaming text, tool
`output` with `exitCode`, a `result` with `usage`). Advertised only when `codex` is on the
host's PATH, and in **every** mode — a Standalone Host on a VPS with Codex installed gets a Chat
for the first time.

**A `tool_call`'s `diff.files[].additions` / `deletions` follow the same rule as the entry
fields they come from:** absent when the pipeline had no count, never zeroed. A `tool_call`
left `in_progress` at the end of a page is inferred, not reported — no runner tells this host
that a call never returned — which is what `capabilities.toolStatus: "partial"` means.

**A transcript entry's `linesAdded` / `linesRemoved` are absent, not zero, when no
diff applies.** "Changed nothing" and "no diff here" are different claims, and a
`Read` step must not render `+0 −0`. Model them as nullable and omit the badge when
they are missing — `rest-transcript.json` carries one entry of each kind so a Dart
model cannot get this right by accident.

## Compatibility

`hostCaps` rides on the `hello` frame: `{ protocol, features[] }`.

| Situation | Expected behaviour |
|---|---|
| Host newer than app | App ignores unknown event types and unknown fields. Required — the store lag is real. |
| App newer than host | App hides whatever `hostCaps.features` does not advertise. |
| Breaking shape change | Bump `protocol`. Additions never bump it. |

**`features` depends on the host's mode, not only on its version.** A Standalone
Host has no hook pipeline, so it advertises neither `transcript` nor `permission`
and the app draws Terminal only for its cells (`PLAN.md` §7 no. 10). It has no STT
provider registry either, so `stt` is absent there too — dictation against a VPS host
falls to the device recognizer. Everything
else — `fleet`, `dispatch`, `stop`, `stream`, `tasks`, `device-refresh` — is
advertised by both modes, so Terminal is fully alive on a VPS.

**`push` depends on deployment, not on mode**, and it is the one feature whose absence
is silent if a client guesses: a host advertises it only when a Firebase service
account actually loaded (`LOTUS_FCM_SERVICE_ACCOUNT`). Registering a token with a host
that cannot send produces an app that waits for wake-ups which can never arrive —
indistinguishable, from the operator's side, from a fleet where nothing is happening.
So `POST /m/devices/push-token` is called **only** when `push` is in `features`.

Compare
`stream-hello.json` with `stream-hello-standalone.json`.

**`spawn-tuning` is a flag of its own, not a property of `spawn`.** With it, each
native runner in `bootstrap.runners[]` may carry `models[]` (`{ id, label, default? }`,
aliases the CLI resolves itself) and `efforts[]` (lowest first), and `POST /m/cells`
accepts `model` and `effort`. The scales are **per runner** because they differ: Codex
starts at `minimal`, Claude ends at `max`, and a slider with the wrong stops would send a value
the CLI rejects. Cases that send no `models`/`efforts`, and a client must not tell them
apart — a host older than the flag, a runner whose flags Lotus does not know (`cursor`,
`custom-opencode`), and any runner whose own launch command already fixes a model or an
effort (`pinsTuning: true`, e.g. `custom-acme`), because the flag the phone sent would
be appended after the operator's own and fight it. All mean the same thing: draw the
runner, draw no knob.

**`custom` is not one of those cases, and used to be treated as one.** A custom runner
that is claude-family and pins nothing — `ccs initech --dangerously-skip-permissions`,
the common second-account wrapper — carries the full claude picker, because the desktop
appends `--model`/`--effort` to exactly those runners. See `custom-hss` against
`custom-acme` and `custom-opencode` in `rest-bootstrap.json`: same `custom: true`,
three different answers. `pinsTuning` is absent on a desktop older than the field, and
absent reads as `false`.

The `default` entry is what the CLI would choose unasked; a client sends nothing for it,
so a default that moves later is still honoured.

**A cell nobody named gets a name, not a brand.** `POST /m/cells` has no name field, so until
2026-09-17 a `tui: false` cell fell back to its runner's label and every claude cell a phone
started was called *Claude Code* — two of them were one name, in `cells[].title`, in the push that
said one of them needed you, and in the desktop's adopt list. The host now draws an unused persona
name from its own pool (`Atlas`, `Nova`, `Kai`, …), so `title` means what its type has always said
it means: the persona, never the binary. `runnerLabel` still carries which runner it is — that was
the field answering the question all along. Nothing addresses a cell by name, so the pool only has
to read cleanly and not repeat.

**`headless` is per runner, and `structured-spawn` alone does not imply it.** The host cap
says the machine has a structured path; `runners[].headless` says which runners that path
reaches, and only those may be spawned with `POST /m/cells {tui: false}`. The two were one
question while Codex was the only bridge, and a client that still infers "the host can, so
Codex can" is wrong the moment a second runner appears — `cursor` over ACP was the first.
Absent reads as `false`, like every other tuning field. A host that refuses a `tui: false`
spawn names the runners it does have, so a stale client gets a legible answer rather than a
flat no. Compare `rest-bootstrap.json` with `rest-bootstrap-headless.json`.

**A claude-family runner is headless too, when this machine has the account behind it.**
`ccs initech` is the claude binary under another config dir, so the Claude bridge runs it with
that `profileId` — same streaming prose, same structured permission, same titles as a native
claude cell. Its fleet row says `agentType: "claude"` (the family a client routes on) and
`runnerLabel: "initech"` (what the operator reads). It was excluded until 2026-09-08 on the
reasoning that the bridges are keyed by the native runner id, which was true of the wiring and
not of the runner. A command the operator invented stays out: Lotus does not know what it speaks.

**`chatInTerminal: false` says a terminal cell of this runner has no Chat page, ever.**
Codex is the case: its whole surface into Lotus is one end-of-turn notify and no host reads
its transcript file, so a terminal codex cell shows *"codex does not report the steps it
takes"* — while the same runner over its bridge streams a whole conversation. A limit of the
**path**, not of the runner, which is why the answer is not to hide it: a client should rest
such a runner on `tui: false` whenever `headless` is true, and keep the terminal one tap away.
Said only about runners the host knows: a command the operator invented may be a claude
wrapper they did not mark as one, and the per-cell `transcriptOutlook` stays the authority
there. **Absent reads as `true`.**

**`terminal: false` is the other half: a runner that can *only* be spawned headless.** Some
providers reach a host as a bridge and nothing else — `cursor` has no PTY runner behind it —
and until 2026-09-08 such a provider never appeared in `runners[]` at all, so Chat could not
be opened on an agent the machine was able to run. It is advertised now, and advertised
honestly: the client must rest it on Chat and must not offer a terminal the spawn would
refuse. **Absent reads as `true`** — the opposite default to every field above, and for the
obvious reason: every runner any host has ever named had a terminal.

One consequence that has no feature flag: `turn` is produced by the same hook
pipeline, so a host with none reports **no `turn` at all** — `unknown`, exactly
like a `codex` cell, never a silent `not waiting`.

**Corrected 2026-09-08: a standalone host that installs its own hook does report `turn`.**
It always knew — the hook route records every turn — and the fleet row simply never asked, so a
phone drew *state unknown* over a cell whose hooks were arriving fine. It now carries `turn` and
`turnAgeMs` for any pane a hook has spoken for, and stays absent for one that none has. Absent
is still the honest answer, not `idle`.

**`headline` on a terminal cell comes from the runner's own transcript.** The claude CLI writes
its own one-line summary of the conversation there (`ai-title` — *"Pantun tentang hujan"*), and
falls back to the operator's last prompt. Until 2026-09-08 a terminal cell showed its project
name and nothing else, beside a Codex cell that had a line under it, while the title the
operator was looking for sat in a file this host already reads on every hook fire.

**The conversation lane is resumable, and a gap it cannot fill is named.** Every
`{type: "conversation"}` frame carries a `cursor` — monotonic per cell for the life of the host
process. A client that reconnects sends
`{type: "conversation.resume", cursors: [{paneId, cursor}]}` — a list, because the phone follows
a window of neighbouring cells and one round trip has to repair them all — and the host replays
what came after each, to that connection alone.

When the asked-for cursor has fallen off the host's bounded tail, the answer is
`{type: "conversation.truncated", paneId, requestedFromCursor, oldestCursor}` and **no deltas**.
One REST fetch repairs it. Replaying the oldest deltas still held would look like success and
leave the transcript missing its middle — the same contract `cell.truncated` has held for PTY
output, which is where the shape comes from.

`cursor: 0` from a client means *I have nothing*, and is answered with everything held rather
than a truncation. A host older than this lane sends no cursor at all, and a client that sees
none simply cannot resume: it refetches, which is the behaviour it always had.

Compare `stream-conversation.json` with `stream-conversation-truncated.json`.

**`profiles` is account *selection*, not account pooling.** `runners[].profiles[]` is
`{id, label}` — the accounts that machine is logged into for that runner, `default` being the
CLI's own config dir. `POST /m/cells` takes `profileId` (terminal cells too, since 2026-11-13;
absent = the account the machine has chosen, `default` = `CLAUDE_CONFIG_DIR` unset), and a headless
cell reports it back as `cells[].profileId`. One cell runs as one account, chosen at spawn and unchangeable
after; each account's limits stay its own.

Absent means **offer no picker**, and the ways to get there must not be told apart: a host
older than the field, a runner whose accounts Lotus cannot enumerate (Codex has its own login,
so its rows carry none), or a machine with only one account — a picker with a single row is a
decision the operator cannot make.

The host validates `profileId` against its own list and refuses an unknown one by name. That
refusal matters more than it looks: a cell started on the wrong account does not fail, it
works — as somebody else, against another keychain entry — and the operator reads the mismatch
as an expired session.

**`usage` on a cell is what the runner said about its plan, and absence is not health.**
`cells[].usage` is `{status, window, resetsAt?}` in the **runner's own words** — `allowed`,
`allowed_warning`, `rejected`; `five_hour`, `weekly`; epoch seconds. Not an enum of ours,
because the vocabularies differ per provider and a normalised one would be wrong for whichever
provider moved next: a client renders the pair and decides nothing.

Absent means **this runner does not say**. Only Claude volunteers it today (on every turn, in
its own stream); Codex reports token counts but no quota, and ACP carries no usage at all —
`usage_update` is still an RFD. Treating silence as "the plan is fine" is the bug this field
exists to prevent: run against an exhausted Cursor plan, a turn completed normally,
`stopReason: end_turn`, no error, and the agent's prose was "upgrade your plan to continue".
A wall that reads as an answer.

A runner that reports it also says so **in the transcript**, as an `error` part with
`recoverable: true`, the moment the status stops being `allowed` — once per change, not per
turn. See `p-2` in `stream-fleet-changed.json`.

**A cell's posture can move while it runs, and a refusal says so rather than pretending.**
`--permission-mode` is a spawn flag for every runner here, so a stop used to be fixed for the life
of a cell — loosening one meant killing it and losing the conversation. `POST /m/cell/:paneId/posture`
moves it instead: the Claude bridge asks the runner over its own control channel, and **the runner
keeps deciding what the mode means**. Probed 2026-09-09 — a cell spawned `manual` stopped gating
`rm -f` once the change landed, on the same process and the same thread.

Two refusals a client must tell apart from success. **400** is a stop this host does not advertise.
**409** is a cell whose posture cannot be moved — no such pane here, or a runner with no way to take
one back (Codex and the ACP agents today). Neither is an error to show as a fault: they both mean
*the posture on screen is still the posture in force*, which is the only thing a client can act on.

**A question is its own part, never a permission with a flag.** `{type: "question", questions: […]}`
carries what the agent is asking and every option as the agent wrote it — `label`, an optional
`description`, an optional `header`, and `multiSelect` when more than one may be chosen. `answered`
is absent while it is still open.

It exists because the same question kept arriving as something else. Through the approval channel
it reached a phone as `AskUserQuestion` above **Allow once** / **Deny**, with the question and its
five options dropped. Through the hook lane it reached one as a bare `askuserquestion` step, and
Chat fell back to scraping the terminal for words that were **already on disk**: the CLI writes the
tool's whole input to its own transcript, and the reader was looking only for `command`,
`file_path`, `path`, `pattern`, `url`, `prompt` — none of which a question has. Both reported from a
device, 2026-09-09.

So the transcript lane now keeps that input (`TranscriptEntry.questions`) and converts it to this
part. A client draws the options from `questions`, never by re-parsing a title — `bb` reaches the
same shape from the other direction, where a question has always been an interaction of its own
(`user-question-form-state.ts`).

**Both readers had to learn it, the same way `tail` did.** A cell with a terminal has its
transcript read by whichever host is behind it: `packages/host`'s `claude-transcript.ts` on a
machine with no desktop, the desktop's own Rust (`agent_hooks/transcript_source.rs`) otherwise —
and the two had the same fixed key list. Fixing only the first left a desktop-backed cell showing
the raw terminal exactly as before, which is how this was reported a second time on 2026-09-09.
The hook **ring** still carries no questions and cannot: a drop file records the event, never the
tool's input. It is the fallback until the transcript path is known, and a question read from it
says only the tool's name.

**A question ends, and the runner's own file is what ends it.** `TranscriptEntry.toolCallId`
rides on both halves of a call — the `tool_use` and the `tool_result` answering it — so a result
settles the step it actually belongs to rather than the last one wearing the same tool name. On a
question that gives the part its resolution, the way `bb` gives every interaction one
(`domain/pending-interactions.ts`): `answered` carries what was chosen, read from
`TranscriptEntry.answers`; `cancelled: true` says the operator refused it, which arrives as the
existing `tool-post-failed` event. Neither means it is still open, and **open is the only state a
client may draw a control for**.

Probed against real transcripts on 2026-09-09: Esc writes `is_error: true` with *"The user
doesn't want to proceed with this tool use…"*, and answering writes *`Your questions have been
answered: "Q"="A"`*. Both were already on disk and neither was being read, so a card a phone drew
stayed on screen whatever the operator did at the keyboard.

A settled question is no longer a form. Its options are not something to choose between any
more, and a card full of roads not taken sits above the agent's reply taking half the screen —
`bb` draws its form for a **pending** interaction only, and a resolved one leaves the thread with
the ordinary event. A client should collapse it the same way: one line saying what was chosen, or
what was asked when the operator refused it.

**One interaction on screen, never two.** A question is drawn where it happened, in the flow; the
`/permission` card is for a permission, and a client must not draw it while a question is still
open — a phone showed a named three-option question above a second card apologising that the
options could not be named. `bb` cannot reach that state at all, because an approval and a
question are one interaction there with one resolution; here it is a rule the client keeps.

**`/permission` reports a question as a question, whole.** Since 2026-09-09 the response carries
`question: UserQuestion[]` beside `prompt` whenever the cell is holding one — the same shape the
`question` part uses, so a client draws one card from either lane. `rest-permission-question.json`
is that response.

Each option there may carry a `key`: **the digit that answers it**. Present on a cell this host
runs itself (the Claude bridge), where the host minted the digits and can release the runner with
one; absent on a cell with a terminal, where the digits belong to the screen and one derived from
position would answer a different question (ADR-8). A client makes an option tappable only where
the key is there, and reads it otherwise — the same rule `tail` follows.

`prompt` still rides alongside, carrying the labels and the same digits with the descriptions
dropped, so a phone built before `question` draws what it always drew (ADR-4). Nothing here is a
new route or a version gate.

**A permission may offer a standing grant, and its label is the only place the scope is stated.**
Since 2026-09-09 a gated tool on the Claude bridge offers three answers rather than two, the middle
one carrying `kind: "allow_always"` on the conversation part. It is enforced by the **runner**, not
by this host: the answer returns an `updatedPermissions` rule with `destination: "session"`, and the
CLI honours it — probed with two Bash calls behind one grant, asked about once against twice in the
control.

The rule Lotus can compose is the tool's own name and nothing narrower, because the approval channel
carries no `suggestions` to build a tighter one from. So granting one `rm` grants **every** `Bash`
in that cell. `PromptOption` on `/permission` carries no `kind` at all — a client sees three
labelled options and nothing else — which is why the label says the scope literally
(`Allow all Bash until this cell closes`) instead of "for session". A client must render it
verbatim; paraphrasing it into something shorter narrows a promise the grant does not keep.

Two grants that are never offered: `AskUserQuestion`, because letting a question through unasked
makes it return *"No answer received"* and silences every later one; and anything wider than
`session`, because a rule written to the operator's settings would outlive the cell that asked.

**`tail` is what the terminal drew, for a prompt whose options could not be named.** It rides on
`/permission` exactly where `awaiting` is true and `prompt` is null — the case a client used to
render as one sentence and a button to the raw terminal, with the question itself never crossing.
The parser fails closed for a good reason (a wrong digit approves what the operator meant to
refuse, ADR-8), and it fails often: it needs the question on the line directly above the options,
so a blank line or a box border defeats it — which is every `AskUserQuestion` and most gated tools
on a modern CLI.

So the tail is for **reading**, and for one narrow act besides: matching a question the client
already has, option by option, against the lines the terminal drew. Digits still never come from
the tail alone — a client may not turn its lines into buttons — but where a `question` part
(from the runner's own file) and the screen name the same options, the digit beside each is the
one the terminal will act on.

Every one of these must hold, or the card stays read-only: exactly one question is being asked;
the question's own text is on the screen, so a card left over from a question the terminal has
moved on from cannot be answered; every option is found; and no two resolve to the same digit.
A label cut short by the pane edge still counts, from six characters. The reason for the whole
rule is that the terminal writes options the tool never asked for — a live screen on 2026-09-09
carried `4. Type something.` and `5. Chat about this` under a three-option question — so a digit
taken from the card's own order answers a different option than the one tapped (ADR-8).

The terminal's own choices ride along the same way. `Type something.` and `Chat about this` are
printed under every question Claude asks, and they are how a question is answered *outside* the
list — so a client that draws only the agent's options leaves the operator holding fewer answers
than the person at the keyboard. They are read off the screen, never invented, and only where
they follow the agent's options **without a gap in the digits**, so a numbered line from
elsewhere on the screen cannot become a button. `bb` offers the same escape from the other
direction, as an "Other" option with a text box (`user-question-form-state.ts`).

Neither of those two answers the question, and a client must not draw them as if they did:
probed on two live cells 2026-09-10, `Type something.` ends the question with *"User declined to
answer questions"* and returns the cursor to the prompt, and `Chat about this` ends it too and
asks what needs clarifying. The digit only opens the way — what follows is typed. So a client
that offers them should put its own composer where the terminal put its cursor.

Answering is then a **keystroke**, the same one a permission takes: a bare digit, no Enter.
Probed against a live cell on 2026-09-09 — `2` alone selected the second option and the agent
replied *"Noted — Tabs."*

The tail is bounded at 40 lines and 4000 characters, ANSI stripped — safe here because this is a rendered *screen*
whose columns are already placed, unlike a raw `pipe-pane` stream (`issues/17`). Absent from a host
too old to send it, and the client then says what it always said.

**Both hosts send it**, and they had to be changed separately: a desktop-backed cell's `/permission`
is answered by the desktop's own Rust (`api_server/handlers/fleet.rs`), a VPS cell's by the host's
hook pipeline. Shipping one without the other is how the field came to be missing on the setup that
actually reported the gap.

**Do not widen the parser instead.** Measured against the prompt that reported this, an
`AskUserQuestion` with six options: it needs *two* rules relaxed, not one — the blank line above the
options, and a second blank line splitting option 5 from option 6. The second is the dangerous one,
because a run allowed to contain blank lines makes any numbered list on screen a candidate prompt.
Each real prompt breaks a different rule; the tail is the answer that does not have to keep up.

**`prompt.ask: "question"` says the agent is asking the operator to *choose*, not for leave to
act.** It appears on `/permission` and on a `permission` part, and only a runner that can tell the
two apart sets it — Claude's `AskUserQuestion` over the bridge. **Absent means a permission**, which
is what every client built before the field already reads, and it is the safe way round: a question
drawn as a permission is mislabelled, where a permission drawn as a question is a destructive action
wearing a softer word. `rest-permission.json` is a scraped terminal prompt and carries no `ask`,
deliberately — absent-means-permission is the rule a client has to keep parsing.

Answering one is not a grant. The host writes the chosen label back into the tool's own arguments
before releasing it (`bridges/claude/questions.ts`), because allowing the call without that makes it
run and report *"No answer received — question left unanswered."* — proved against the CLI on
2026-09-08. So a client that treats these options as allow/deny will silently tell the agent that
nobody replied.

**`conversation-stream` is a second lane for the same steps, not a replacement.** With it, every
step is broadcast twice: as `{type: "notification"}` in the hook vocabulary, which every shipped
phone reads, and as `{type: "conversation", paneId, agentType, update}` carrying the `Part`
deltas that step amounts to. A client reads one or the other, never both, or it will draw each
step twice.

It exists to end a duplication rather than to add a capability. The rule for turning entries into
parts was written twice — `conversation/parts-from-entries.ts` on the host and
`data/conversation_builder.dart` in the app, pinned equal by a test — and only the host can say
what an entry cannot: a text part revised as it streams, a tool status moving from
`in_progress` to `completed`, a turn closing with its stop reason. A cell the host runs itself
(`structured-spawn`) publishes its runner's **native** parts on this lane and no converted ones,
so a step never arrives twice under two ids. Compare `stream-notification.json` with
`stream-conversation.json`: the same step, both lanes.

**What a client may rely on about that lane, in five rules.** Four producers feed it — the
Claude bridge, the ACP bridge, the codex app-server bridge, and the hook lane that converts a
TUI cell's transcript — and each is held to the same grammar, over a real recording of the CLI
it speaks for (`conversation/grammar.ts`, `conversation/__tests__/bridge-conformance.test.ts`).
The host also checks as it publishes, and logs `conversation.grammar` with the rule when a
producer breaks one; the delta is still sent, because a rule the host states is not a reason to
withhold a step a client may render perfectly well.

| rule | a producer will not |
|---|---|
| `turn/starts-once` | reopen a turn that has ended |
| `turn/settles-once` | end the same turn twice |
| `turn/known` | send a part for a turn it never opened |
| `part/settles-once` | un-finish a part — prose back to streaming, a completed call back to running |
| `part/one-turn` | move a part to another turn |
| `part/opens-before-delta` | send a `text` delta for a part it never opened |

**`{kind: "text"}` is how streaming prose is actually carried, and it sends only what was added.**
A part that grows — prose, reasoning — is opened by a `part` update carrying its first chunk, and
every chunk after that arrives as `{kind: "text", turnId, partId, delta, seq}` holding the new
characters alone. It exists for one measured reason: re-sending the whole growing part per chunk
costs the sum of its prefixes, and the ACP capture is 46 chunks for two sentences — 46 copies of a
prefix, across a tailnet, to a phone. See `stream-conversation-text.json`.

**A client may ignore the kind entirely.** A `text` delta never carries information the client
cannot get another way: the whole part is re-sent when it settles, so a phone built before this
kind applies the `part` updates alone and ends the turn holding exactly the text the host holds.
That is what makes it additive (ADR-4), and it is why the grammar is strict about it — a client
that *does* apply deltas may do so blindly, because `part/opens-before-delta` guarantees the part
is already there and `part/settles-once` guarantees no delta arrives after it finished.

`part/one-turn` is the one worth stating out loud, because it is the bug this contract has already
had: on 2026-09-08 the same two parts arrived under a second turn id and a phone drew the
exchange twice. `bb`, whose `ThreadEventGrammar` these rules are taken from, cannot have that
bug — its timeline is items keyed by `itemId` with the turn as metadata on them, so an item
belongs to one place by construction. Lotus nests parts inside turns, so it is a rule instead.
A client is free to trust it and file parts by id.

There is **no minimum version that forces an update**. Locking the operator out of
their own machine is the situation Pocket exists to prevent.
