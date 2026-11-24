# ADR-0035: Agent Canvas Draw — agents menggambar shape & diagram di CodeCanvas

- **Status:** accepted (plan: `plans/agent-canvas-draw/PLAN.md`)
- **Date:** 2026-07-08
- **Context owners:** CodeCanvas

## Context

CodeCanvas sudah punya whiteboard layer lengkap (shape sebagai first-class ReactFlow node:
`rectangle/diamond/ellipse/text/arrow/line/draw/image`, style rough.js, grouping, persistence SQLite)
dan jalur kontrol agent→canvas yang terbukti (`lotus_focus_cell`/`lotus_arrange_canvas` via
`/v1/canvas-control` round-trip). Yang belum ada: agent bisa **membuat/mengubah konten** board —
menggambar shape dan meng-auto-generate flowchart ala Miro AI / Excalidraw text-to-diagram.

Riset industri (tldraw Agent Starter Kit, tldraw MCP App 2026, Excalidraw mermaid-to-excalidraw,
Miro AI) konvergen pada pola: tool surface kecil + scene read-back, koordinat lokal & dibulatkan,
sanitize/repair sebelum apply, dan — untuk konten graph — **LLM mengemit relasi, layout engine
deterministik yang menghitung posisi** (LLM terbukti buruk pada koordinat absolut: overlap,
out-of-bounds, token mahal — Excalidraw JSON ~500 token vs DSL ~50 untuk diagram yang sama).

## Decision

1. **Transport:** replikasi pola `canvas-control` — tool MCP baru `lotus_canvas_draw`,
   `lotus_canvas_draw_diagram`, `lotus_canvas_read_shapes` → route `/v1/canvas-draw` (+read) di
   `mcp_ipc.rs` dengan `register_pending`/`resolve_pending` → event `mcp://canvas-draw` →
   `useMcpCanvasDrawBridge`. Full round-trip dengan ack per-op, bukan fire-and-forget.

2. **Konektor diagram = ReactFlow edge (Opsi B), bukan arrow-shape.** Shape adalah node, jadi
   konektor flowchart memakai edge `wireKind: "connector"` yang menumpang `CanvasWireEdge`
   (floating bezier — otomatis mengikuti node saat digeser, label editing sudah ada). Arrow-shape
   standalone tetap untuk anotasi bebas. Ini yang membuat diagram tetap hidup pasca-generate,
   setara Miro, tanpa engine binding baru.

3. **Semantic-first untuk diagram:** agent mengemit graph JSON (`nodes[] {id,label,kind} +
   edges[] {from,to,label}`); **dagre** menghitung layout di frontend (seam pure-function —
   ELK.js bisa swap tanpa ubah API tool). `kind` dipetakan deterministik ke shape kind existing.
   Mode primitif (`lotus_canvas_draw`) memakai koordinat **lokal terhadap anchor** + rounding +
   clamp, bukan koordinat flow absolut.

4. **Gate terpisah:** flag baru `allowAgentCanvasDraw` (default `false`) di
   `useCanvasBehaviorSettings`. Menggerakkan kamera (`allowAgentCanvasControl`) dan memutasi
   konten board adalah level trust berbeda.

5. **Draft-first apply:** batch > 3 ops dibuat sebagai node nyata bertanda `agentDraft`
   (opacity + dashed) dengan satu pill minimal Apply/Discard (visual language ADR-0033).
   Ledger `draftBatchId` memungkinkan revert per-batch — pengganti minimum selama canvas belum
   punya undo/redo umum.

6. **Guardrails:** max 60 ops/call, cap delete per batch, sanitizer berbasis
   `normalizeShapeFields` + `ensureShapeIdExists`, reject per-op (bukan gagal seluruh batch),
   satu functional `setNodes`/`setEdges` update per batch (atomik terhadap autosave & drag user).

## Consequences

- (+) Fitur "auto-generate flowchart seperti Miro" jatuh keluar dari arsitektur ini hampir gratis:
  rendering, persistence, dan edge-follow semuanya reuse.
- (+) Tool surface kecil (3 tool) + read-back loop = pola yang paling terbukti di industri.
- (−) Perubahan sidecar butuh `mcp:bundle` + **Rust rebuild** (embed `include_str!` di
  `mcp_config.rs`) — iterasi tool lebih lambat dari perubahan frontend murni.
- (−) Dependensi baru: `dagre` (~30KB gzip). ELK.js (~1.4MB) ditunda sampai terbukti perlu.
- (−) Revert per-batch bukan undo umum; undo/redo canvas menyeluruh tetap utang terpisah.

## Alternatives considered

- **Arrow-shape sebagai konektor (Opsi A):** murah, tapi konektor mati saat node digeser —
  kalah dari standar Miro/Excalidraw. Ditolak.
- **LLM mengemit koordinat penuh untuk diagram:** failure mode terdokumentasi (overlap,
  out-of-bounds, token 10–24× lebih mahal). Ditolak untuk konten graph; hanya untuk primitif
  ber-anchor lokal.
- **Mermaid sebagai satu-satunya input:** parser Mermaid penuh berat; graph JSON lebih
  robust untuk delta-update diagram existing. Mermaid flowchart subset jadi fase opsional.
- **Menumpang `allowAgentCanvasControl`:** menyembunyikan perbedaan trust kamera vs konten. Ditolak.
