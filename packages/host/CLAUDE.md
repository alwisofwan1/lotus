# @lotus/host

The **host layer** of Lotus — the runtime that owns PTY sessions, agent runners, and the
Standalone Host for VPS deploys, plus the adapters that expose them remotely.

Lives at `packages/host/` (was `lotus-remote/` before the 2026-08-02 meta-repo restructure). The
directory rename landed with the restructure; the de-Telegram-isation of its *contents* is separate
work tracked in `plans/lotus-pocket/issues/07-blast-radius-hapus-telegram.md`, so the Telegram
adapter is still present here today.

Consumed by `apps/desktop`, which embeds a bundle of this package into its Tauri binary via
`apps/desktop/scripts/build-host-bundle.mjs`. The dependency is one-way: desktop → host.

## Commands

```bash
bun run dev            # hot-reload, auto-loads .env
bun run test           # vitest run (must pass before marking any work done)
bun run test:watch     # vitest watch
bun run build:bundle   # emit dist/lotus-remote.mjs (bundled for Tauri embed)
```

## Deployment modes

| Mode | Env | Behaviour |
|---|---|---|
| `client` | `LOTUS_MODE=client` (default) | Adapter only — delegates all API calls to a running Lotus desktop app |
| `standalone` | `LOTUS_MODE=standalone` | Adapter + embedded Standalone Host — runs fully on VPS without desktop |

## Module layout

```
src/
├── adapters/telegram/   Telegram UX: screens, commands, nav, auth
├── core/                Shared utilities: logging, streaming, stores, config
├── server/              Standalone Host: HTTP API, PTY, agent runners, projects
└── types/               Shared TypeScript types — no runtime code
```

Each module owns its concern fully. Cross-module imports flow inward only:
`adapters` → `core` → `types`, `server` → `core` → `types`. `adapters` never imports from `server` directly — it talks to the server through `ApiClient`.

---

## Non-negotiable rules

### File-size limit
**No source file may exceed 600 lines of code** (non-blank, non-comment) **or 1000 lines in total**, and no
code line may be wider than 200 characters (lines that are only string content, such as prompt prose, are
exempt). Above 400 code lines the test prints a warning: extract a collaborator at a real seam (a type, a
protocol step, a module) before you hit the wall. Keep functions under ~80 code lines. Tests are exempt.
The extra room is for cohesion, not a target — do not merge files that were split well.
Same numbers as `apps/pocket`. Enforced by `src/__tests__/line-limit.test.ts`.

### Comments
Code should read without them. A comment states one short non-obvious **why**; history, incident write-ups
and design rationale go to an ADR or `docs/`, linked in one line. No comment block over 5 lines: the
line-limit test ratchets the repo-wide count of such blocks — it may only go down. When you trim comments,
lower `LONG_COMMENT_BLOCK_CEILING` to the new count.

### Test-driven development
Write the test file before writing implementation code. Every public method on every exported class needs at least one unit test. Every HTTP route needs at least one handler test. `bun run test` must pass before any slice is marked complete.

Test files live in a `__tests__/` subdirectory beside their source module — e.g., `src/server/pty/__tests__/manager.test.ts` tests `src/server/pty/manager.ts`.

### No AI slop
- No `throw new Error("Not implemented")` in committed code
- No wrapper functions that only forward to another function with an identical name
- No defensive `try/catch` around code that structurally cannot throw
- No `any` — use `unknown` and narrow it, or define the type
- No multi-paragraph doc comments — one short line, only when the WHY is non-obvious (see Comments)
- No trailing summary comments that restate what the code already says

### Dependency injection
Every class receives its dependencies via the constructor. No module-level singletons. No `process.env` reads inside classes — read at the config boundary and inject values. This makes every class unit-testable without environment setup.

### Typed errors
Subclass `Error` when callers need to distinguish error kinds (e.g. `SessionNotFoundError`, `ProviderUnavailableError`). Never swallow errors silently. Map errors to the correct HTTP status code at the route layer.

### Logging
Use `createLogger` from `core/logger.ts`. Never use `console.log` or `console.error` directly.

---

## Extending the server

### Adding a new AgentRunner

1. Write `src/server/agent/runners/__tests__/<name>.test.ts` first — cover `chat()` and `spawnPty()`
2. Implement `src/server/agent/runners/<name>.ts` implementing `AgentRunner`
3. Add `"<name>"` to `AgentProviderId` union in `src/server/agent/types.ts`
4. Register in `AgentRunnerRegistry.build()` in `src/server/agent/registry.ts`
5. Add `"<name>"` to `KNOWN_PROVIDERS` in `src/adapters/telegram/screens/chat.ts`

### Adding a new HTTP route

1. Write the handler test in `src/server/routes/__tests__/<name>.test.ts`
2. Implement `src/server/routes/<name>.ts` — a Hono router factory that receives deps via closure
3. Register in `src/server/app.ts`
4. Add the client method to `src/core/api-client.ts` if adapter code needs it

---

## Pre-merge checklist

- [ ] No file over 600 code / 1000 total lines; no function over ~80 lines
- [ ] No new comment block over 5 lines (ratchet test passes)
- [ ] No `throw new Error("Not implemented")` remains
- [ ] All public methods have at least one test
- [ ] `bun run test` passes clean
- [ ] No `any` types
- [ ] No `console.log` / `console.error`
- [ ] New `AgentRunner` registered in `AgentRunnerRegistry.build()`
- [ ] New route registered in `app.ts` and covered by a handler test
