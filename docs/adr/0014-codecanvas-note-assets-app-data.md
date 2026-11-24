# ADR 0014 — CodeCanvas Note Assets live in app data and use custom Markdown URIs

**Status**: Accepted

## Context

Rich Markdown Notes can embed images that must survive app reloads and remain available to downstream agent runs. The Markdown content is the canonical note body, so image references need to be durable without turning persisted notes into HTML or storing large base64 blobs inside canvas snapshots.

Options considered:

1. Store image files beside the repository. This makes assets discoverable, but mutates user repos and creates cleanup/version-control surprises.
2. Store image files under `~/.lotus`. This is familiar to existing Lotus state, but is less OS-native for app-owned support data and harder to keep colocated with CodeCanvas SQLite lifecycle.
3. Store image files in the app data/Application Support CodeCanvas area with SQLite metadata and custom Markdown references.

## Decision

CodeCanvas Note Assets are stored under the app data directory, colocated with the CodeCanvas SQLite store:

```txt
{app_data_dir}/codecanvas-assets/{projectId}/{assetId}.{ext}
```

SQLite stores Note Asset metadata in `codecanvas_note_assets`, keyed by asset id and project id. Rich Markdown Notes persist image references as custom Markdown URIs:

```md
![alt](lotus-note-asset://asset_123)
```

The app exposes reveal/delete/prune commands so users and future UI surfaces can discover or manage assets without knowing the app-data path manually.

## Consequences

- Canvas snapshots stay compact and Markdown-first; embedded images are not persisted as HTML or base64.
- Repositories are not mutated by note screenshots or pasted images.
- Asset metadata follows the existing CodeCanvas project lifecycle through SQLite foreign keys; project close/delete removes metadata and the command path also removes the project asset folder.
- Agent context can resolve `lotus-note-asset://` references into image attachments while retaining a text manifest fallback for non-vision paths.
- Users need app affordances to find assets because app data is intentionally not a working-directory location.
- Future export/import features must copy both Markdown and referenced Note Asset files, not only the canvas snapshot.
