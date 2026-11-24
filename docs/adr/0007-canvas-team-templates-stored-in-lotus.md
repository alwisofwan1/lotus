# Canvas Team Templates stored under ~/.lotus/, not ~/.claude/

## Status

accepted

## Context

**Canvas Team Templates** need persistent, cross-project storage — they must survive
browser cache clears and be available to any canvas regardless of which project
directory is open. Two filesystem locations were candidates:

- `~/.claude/` — already hosts `teams/`, `tasks/`, `settings.json`, and agent logs.
  Familiar pattern, and `teams.rs` / `tasks.rs` show the exact file-per-record shape
  to follow.
- `~/.lotus/` — Lotus-owned subtree (`lotus-mcp-server.mjs`, `lotus-remote.mjs`,
  `telegram-bot.json`). Isolated from Claude Code's own config tree; a `claude`
  CLI reset or reinstall does not touch it.

The key constraint: `~/.claude/` is Claude Code's config home and can be reset,
partially wiped, or migrated by Claude Code tooling without Lotus's knowledge.
Canvas Team Templates are Lotus-authored data (the user built them inside the Lotus
app), not Claude Code config. Storing them in `~/.claude/` would make them
collateral damage in a Claude Code reset.

## Decision

Store **Canvas Team Templates** under `~/.lotus/canvas-templates/{id}.json`,
implementing read/write via a new `canvas_templates.rs` Tauri module that mirrors
the file-per-record pattern of `teams.rs`.

## Consequences

- Templates survive `claude` CLI reinstalls and `~/.claude/` resets.
- Consistent with the `~/.lotus/` principle: Lotus-managed data lives in
  `~/.lotus/`, Claude Code config lives in `~/.claude/`.
- One new Rust module (`canvas_templates.rs`) and matching Tauri commands
  (`list_canvas_templates`, `save_canvas_template`, `delete_canvas_template`).
- No SQLite dependency — templates are small named JSON objects with no
  cross-template querying requirement.
