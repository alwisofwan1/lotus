# CodeCanvas Collaboration Services

## Purpose
Own pure collaboration projections for optional CodeCanvas collaboration runs, including Swarm/Bridge task context, participant state, assignment evidence, and inbox-style read models.

## Ownership
- Pure TypeScript services that derive view models and spawn definitions from Canvas AgentNode snapshots and shared Bridge/Swarm task records.
- No React components, hooks, Tauri IPC, or Swarm module imports live here.

## Local Contracts
- CodeCanvas remains Swarm-free: consume shared contracts from `@/lib/tauri-api` only.
- Normal Canvas routes must stay clean; collaboration services support opt-in launch contexts and must not create UI side effects.
- Participant projections must distinguish expected task assignees from extra live Canvas agents, surface missing assignees as `not-spawned` instead of hiding them, and expose a `nodeId` only when the participant is backed by a real Canvas AgentNode.
- Missing-assignee spawn projections may build ad-hoc AgentDefinitions and initial task briefs, but must not perform mutations directly; UI/runtime command seams own creation and delivery.
- Collaboration ledgers record durable assignee-to-AgentNode mappings so renamed nodes can still be resolved, sync assignment lifecycle states from participant projections (`assigned`, `running`, `done`, `blocked`), and may expose lightweight ledger metadata for overlay indicators; storage/adapters live outside pure projection functions.
- Collaboration context records persist launch/task summaries for native MCP reads after Canvas closes; overlays may expose copyable projectId/runId MCP context, and direct MCP project-backed responses should include run/task context, refresh from the native task store when workspaceId/taskId are available, report task freshness, and include participant status, mailbox thread, evidence/blocker summary, and next-action guidance for assignment reads.
- Collaboration mailboxes record durable per-assignment messages (`handoff`, `reply`, `evidence`, `blocker`, `note`) and structured evidence metadata; pure mailbox services own filtering/indexing plus idempotent Swarm feedback ingestion, participant projections may use mailbox evidence/blockers to update visible assignment state, pure MCP planners may describe frontend-mediated mailbox actions, spawned briefs should include projectId/runId when available so MCP can write directly to project-backed records, hooks own project-backed storage with localStorage fallback/migration, native update-event refresh, and storage freshness state; overlays may show recent mailbox/evidence read models without making normal Canvas routes noisy.

## Work Guidance
- Keep projection policies pure and unit-tested.
- Prefer small, explicit status vocabularies over leaking raw AgentNode or Bridge task statuses into UI.

## Verification
- Run `bun run test -- src/modules/codecanvas/services/collaboration` after changing collaboration projections.

## Child DOX Index
- None.
