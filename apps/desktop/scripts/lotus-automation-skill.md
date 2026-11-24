---
name: lotus-automation
description: Create, change, list or delete Lotus Automations (Trigger → Action → Output) with the lotus_automation_* MCP tools. Use when the user asks Lotus to do something automatically — "review PRs mentioned in Slack", "every weekday at 9 send me…", "buat automation", "jadwalkan".
---

# Lotus Automation

An Automation is **Trigger → Action → Output**. Lotus runs it while Lotus is open, even with no window.
You write it with the MCP tools below. **Everything you write is saved OFF.** Only the user can turn it
on, with **Turn on** in the Automation panel. You cannot, and must not claim you did.

## Tools

| Tool | What it does |
|---|---|
| `lotus_automation_list` | The automations that exist, with `enabled` and their current values. **Call it first.** |
| `lotus_automation_options` | What you may fill in: kinds, the system `timezone`, delegation preset ids, GitHub accounts, `projects`, `mcpServers`, Slack channel ids and user group ids, and `slack.warning` when Slack is not connected. Never guess an id. |
| `lotus_automation_create` | Saves a new automation, OFF. |
| `lotus_automation_update` | Replaces one automation (same kind) with the whole definition you send, and switches it OFF again. |
| `lotus_automation_delete` | Deletes one automation with its history. Ask first. |

## Steps

1. Call `lotus_automation_list`. If one already does what the user asks, offer to change it instead of
   adding a second.
2. Call `lotus_automation_options`. If `slack.warning` is set and the automation needs Slack (a Slack
   trigger, `dmSelf`, `slackChannel`), tell the user that warning before you go on.
3. Pick the kind. Fill the form from the user's words and the options. Ask about anything you cannot fill.
   Use `timezone` from the options unless the user names another.
4. Write the prompt (see **Writing the prompt**). Never save the user's words as they came.
5. Show a short summary: **trigger, action, output, GitHub account, preset, project**, then the **full
   prompt text** you will save (or a review's full `instructions`), word for word. Wait for "ya" / "yes".
6. Call `lotus_automation_create`.
7. Tell the user: "Saved OFF. Open Automation and press **Turn on** after you check it."

## Changing one

1. Call `lotus_automation_list` and find it by name. Use its `id`.
2. `lotus_automation_update` replaces the whole definition. Start from the values `list` returned and
   send **every field again, unchanged**, except what the user asked to change. A field you leave out goes
   back to its default. `list` gives a schedule as `schedule.cron` + `schedule.timezone`: send them back
   as `cron` and `timezone`.
3. Show what changes (old → new) and wait for a yes, as for a new one.

Lotus keeps these when you leave them out, so you cannot wipe them by mistake: the project
(`workspaceId`), `openPane`, and a review's `mcpTools`, `slack` and `github`. To clear `mcpTools` send
`[]`; to stop a review listening in Slack send `"slack": { "channels": [] }`; to stop it watching GitHub
send `"github": false`.

## Writing the prompt

The user speaks in a hurry: "kirim ringkasan PR tiap pagi". The agent that runs it later has only what
you save, with nobody to ask. Rewrite it so it says:

- **Goal**: what the user wants to know or have done, and why.
- **Data**: where to look (repos, folders, a Slack channel, the PR list Lotus hands over).
- **Output shape**: the order, grouping and format — Slack DMs read `*bold*` and plain URLs, not
  markdown headings or tables.
- **The empty case**: what to do when there is nothing new. Usually: "If there is nothing worth telling
  me, report nothing to report" — the run then ends quietly (`nothing_to_report`), with no DM and no
  notification.
- **Length**: e.g. "at most 10 lines", "one line per PR". Results are cut at 8000 characters.
- **When to ask**: if the task can reach a decision only the user can make (merge? which option?), say
  "stop and ask me" — the run then waits in the Lotus Inbox with an **Automation Ask**, and the user's
  answer continues the same conversation.

Write it in the user's language. Keep their intent; do not add work they did not ask for.

If a tool returns an error, it starts with the field at fault (`kind:`, `form:`, `slack:`, `github:`, `tools:`…). Fix
that field and try again. Do not work around it.

## Kinds

### `pr_review` — draft a review for a GitHub PR

Asked for by any mix of: **Run now** with a PR URL; Slack (a message in a watched channel with a PR link
that mentions the user or their Slack user group, or the user's 👀 reaction); GitHub (a PR that requests
the account, or a GitHub team, as reviewer — Lotus checks every few minutes). Any of these is the request:
no GitHub review request is needed for a Slack or Run-now review. Output: a draft in the panel. The user
presses Send; it posts a GitHub review of type COMMENT (or, for a review that found nothing, the user may
press Approve). Nothing is sent without the user.

```json
{
  "kind": "pr_review",
  "form": {
    "name": "Orbit reviews",
    "account": "alwisofwan1",
    "presetId": "<preset id from options>",
    "repos": ["initech/orbit-app", "initech/*"],
    "instructions": "Focus on correctness and security.",
    "mcpTools": ["mcp__context7"]
  },
  "slack": { "channels": ["C0123ABC"], "team": "S0TEAM1" },
  "github": { "team": "initech/team-orbit" }
}
```

- The draft's comments each carry a `severity` — `blocker`, `should-fix` or `question` — and the review
  is written in the PR description's language. `instructions` can steer both ("only blockers", "write in
  English"); findings on unchanged lines go to the summary.
- `repos`: `owner/name`, or `owner/*` for a whole org.
- The reviewer reads other people's code, so it runs **read-only**: read and search files, `gh pr view`,
  `gh pr diff`, `git log`, `git show`, and the user's skills. Nothing else runs without asking.
- `mcpTools` (optional): MCP tools the reviewer may also use — a whole server `mcp__context7` or one
  tool `mcp__server__tool`. Pick from `mcpServers` in `lotus_automation_options`. Suggest only tools
  that read (docs, search); a PR's text could ask for the rest. Leave it out for no MCP.
- `workdir` (optional) is its working folder, e.g. a local clone `~/workspace/acme-api`, so it can
  read the code around the change. It must exist.
- `slack` is optional. `channels` are Slack channel **ids**. `team` is the **Slack user group id**
  (`S…`) from `lotus_automation_options`, whose mention counts as a request.
- `github` is optional: `{}` reviews each PR that requests the account on GitHub; `{ "team": "org/team-slug" }`
  also counts that GitHub team's requests (for `@team-orbit` the slug differs from the Slack group id).
  Each request is reviewed once; asked again after the user's review, it is reviewed again.
- Leave out both `slack` and `github` for Run-now only. There is no `reviewerTeam` field: the form refuses it.
- The Slack thread reply is Lotus's: a verdict, the finding counts and at most two points. To change its
  shape, put fenced blocks inside `instructions` — ` ```slack-reply ` for a review with findings and
  ` ```slack-reply-lgtm ` for an approval — using only `{mention} {verdict} {pr} {counts} {points} {title}
  {author}`. A thread that asked for several PRs gets one message, shaped by ` ```slack-reply-group `
  with only `{mention} {count} {reviews}`. The reviewer agent never sees them; an unknown placeholder
  is refused. Never ask the reviewer to write a
  "Slack reply" or "Verdict" inside the summary: the summary is posted to GitHub.
- Reviewing a PR again after its author pushed fixes is a re-review by itself: the agent is given its
  earlier findings, the author's thread replies and the changes since, and answers each first.

### `agent_prompt` — run a prompt on a schedule

Trigger: a schedule (days + time + time zone, or a raw cron). Output: the Results list and a macOS
notification. `dmSelf: true` also sends a Slack DM to the user. A `slackChannel` result waits in the panel
for the user to press Send.

```json
{
  "kind": "agent_prompt",
  "form": {
    "name": "Morning PR brief",
    "prompt": "Summarise the PRs waiting for my review. Most urgent first.",
    "presetId": "<preset id from options>",
    "days": ["mon", "tue", "wed", "thu", "fri"],
    "time": "09:00",
    "timezone": "Asia/Jakarta",
    "includeReviewRequests": true,
    "account": "alwisofwan1",
    "repos": ["initech/*"],
    "dmSelf": true
  }
}
```

- `cron` (five fields) replaces `days` + `time` when set.
- The agent runs like any agent the user starts: the preset's permission flags, every tool, the
  user's skills, settings and MCP servers. `tools` is ignored; leave it out.
- `workdir`: the folder it works in, e.g. `~/workspace/orbit-vault` when the prompt reads or writes
  notes there. It must exist. Leave it out when the task needs no files: the run gets an empty
  folder of its own.
- `includeReviewRequests` needs `account`. Lotus fetches the PR list itself and gives it to the agent.
- `slackChannel`: a Slack channel id. Its result is a draft until the user sends it.
- `googleSheet`: rows to the user's Google Sheet after each run, sent automatically.
  `{ "spreadsheetId": "new", "tab": "Daily", "columns": ["Date", "Service", "Status", "Note"] }`.
  `"new"` makes a sheet named after the automation when it is saved, with the columns as header; the
  agent of each run is then told the columns and returns `rows` next to `text`. Needs Google
  connected: `google.state` in the options is `connected`, else tell the user to connect Google in
  Connectors first. Lotus can only write sheets it made (scope `drive.file`), so use `"new"` unless
  the user pastes a link to one Lotus made before.
- `googleDrive`: one report file per run, named `<name> — YYYY-MM-DD HH.MM` (the run's time).
  `{ "folderId": "root", "format": "google_doc" }` — `root` is My Drive; `format` is `google_doc`,
  `markdown`, or `csv` (the rows, so it needs `googleSheet`).

## Project

An automation can belong to a Lotus project: `workspaceId` from `projects` in the options. Its runs
then work in that project's folder (a review uses the project's checkout of the repo). `openPane: true`
also opens a pane there for each run, so the user can watch; leave it out to run in the background.

Set it only when the user names a project or the task clearly lives in one (notes → the vault project).
Name the project in the summary. An id that is not in `projects` is refused. `projects` is empty while no
Lotus window is open: then leave it out and tell the user they can pick it in the panel (Edit settings →
Project).

## Rules

- Never ask for or write tokens. Slack and GitHub are already connected in Lotus.
- An agent that an automation started cannot use these tools. That is on purpose.
- To change the kind, delete and create again (ask first).
