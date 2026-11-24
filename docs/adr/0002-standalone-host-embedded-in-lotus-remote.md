# Standalone Host Embedded Inside lotus-remote Process

When deploying to a VPS without the Lotus desktop app, the Standalone Host (PTY management, Claude CLI spawning, bridge chat) runs as an embedded HTTP server inside the same `lotus-remote` process rather than as a separate service. The `LOTUS_MODE=standalone` env var activates it; the Telegram adapter then connects to `localhost` instead of an external Lotus API URL.

## Why not a separate service?

A two-process design (a dedicated `lotus-server` binary + `lotus-remote`) would require operators to configure, start, and supervise two processes, manage two env files, and handle inter-process connectivity. The Bot Operator benefit — a single `bun run` on VPS with a single `.env` — outweighs the separation-of-concerns argument. The server and adapter share one lifecycle: if the bot stops, the PTY sessions stop too, which is the desired behavior for a single-operator coding tool.

The same `ApiClient` code path is preserved: the adapter never calls server internals directly; it always goes through HTTP. This means the Standalone Host can be extracted into a separate service later with no adapter changes — only the `LOTUS_API_URL` env var needs to point elsewhere.
