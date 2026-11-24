# 0036 — Hapus modul CodeSwarm

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Alwi
- **Supersedes:** 0016 (swarm-workflow-evolves-canvas-team-template), 0017 (swarm-teams-are-global-catalog-not-project-scoped)
- **Menyempitkan:** 0026 (codecanvas-standalone-ade-swarm-optional-consumer) — konsumen opsionalnya sudah tidak ada

## Konteks

Surface CodeSwarm (`/swarm`) sudah lama tidak dipakai dan tidak akan dipakai lagi. Ia membawa 158
file, 10.653 LOC non-test, dan 62 file test. ADR-0026 sudah lebih dulu membalik arah dependensinya,
jadi batas modulnya bersih: hanya tiga file di luar swarm yang meng-import `@/modules/swarm/**`.

## Keputusan

Hapus modulnya, route-nya, dan permukaan backend yang tidak punya pemanggil lain. Fitur
**workflow-di-canvas ikut dimatikan** — ia hanya bisa dijalankan dari Swarm.

### Yang dihapus

- `src/modules/swarm/**`, `src/app/swarm/`, `src/app/swarm-detail.css`, token `.swarm-panel` di `globals.css`
- `public/assets/agents/` — 15 PNG, 704 KB, nol renderer di luar swarm
- Rust: `logs.rs`, `tasks.rs`, command `list_logs` / `read_log_chunk` / `list_tasks` / `create_task` /
  `create_team` / `update_team`, model `TaskFile` / `LogEntry` / `LogChunk`
- `tauri-api.ts`: 195 baris — blok agent-status, log streaming, task legacy, lima wrapper bridge task
- Port workflow canvas: `canvas-workflow-integration.ts`, `useCanvasWorkflowLaunch`,
  `useCanvasWorkflowCommands`, tombol Save / Save-copy / Exit di `CanvasTopBar`,
  `CanvasWorkflowAutoRun` di `CanvasGraphRunProvider`
- `getTeamBuilderModelOptions` dan `TeamBuilderModelOption`

### Yang sengaja TIDAK dihapus

Bagian ini yang menentukan penghapusan ini tidak jadi breaking change.

- **`teams.rs`, `TeamConfig`, `list_teams` / `get_team` / `delete_team`.** BridgeBoard membacanya
  lewat `useBoardData`, dan `launch.rs` menulis config tim saat menyalakan agent.
- **Command Rust `bridge_*_task`.** Itu backend MCP `lotus_create_task` / `lotus_list_tasks` yang
  dipakai agent di canvas. Hanya wrapper TS-nya yang dibuang.
- **Mesin Graph Run (`useCanvasGraphRun`).** Ia berdiri sendiri; workflow swarm cuma salah satu
  pemicunya. Yang hilang hanya auto-run saat canvas dibuka dari `?run=`.
- **Kolom `workflow_id` di tabel graph run (SQLite).** Sudah ada isinya di disk user. Ia dibiarkan
  nullable dan berhenti diisi — men-drop kolom adalah migrasi skema, bukan pembersihan.
- **Mode kolaborasi `swarm-task` / `swarm-workflow`.** Prefix `swarm-task:` adalah `runId` yang
  tersimpan di ledger, mailbox, dan SQLite. Menamai ulang berarti mengorbankan record yang sudah ada.
- **CSS class `canvas-workflow-save-notice`.** Namanya menyebut workflow, tapi `sessionNotice` yang
  memakainya sekarang.
- **Tag `teamBuilder` di `config/models/catalog.ts`** (9 entri). Tidak ada lagi yang membacanya
  setelah `getTeamBuilderModelOptions` hilang; dibiarkan sebagai data agar diff-nya tetap kecil.

## Konsekuensi

- Bundle, diukur dengan membangun `main` dan branch ini di mesin yang sama
  (`TAURI_ENV_TARGET_TRIPLE=… next build`, lalu `du -sk out`):

  | | main (a771b4fb) | tanpa swarm (5676a4e5) | selisih |
  |---|---|---|---|
  | `out/` | 109.708 KB | 108.020 KB | **−1.688 KB** |
  | `out/_next/static/chunks` | 27.364 KB | 26.544 KB | −820 KB |
  | `out/assets/agents` | 704 KB | 0 | −704 KB |
  | entri route `swarm*` di `out/` | 3 | 0 | — |

  Yang paling terasa bukan ukurannya melainkan prefetch-nya: `<Link href="/swarm">` ada di sidebar
  yang muncul di hampir setiap halaman, jadi Next memuat chunk itu walau menunya tidak pernah
  dibuka.
- Data di `~/.claude/teams/**` **tidak** disentuh — masih dipakai. `~/.claude/tasks/<teamId>/**` dan
  log per-tim jadi yatim; aman dihapus manual, tidak ada kode yang melakukannya otomatis.
- Workflow swarm yang tersimpan di canvas template store tetap ada sebagai template.
- **Terbuka:** tidak ada lagi kode di luar swarm yang memproduksi URL `?collab=`, sehingga subsistem
  kolaborasi canvas (ledger, mailbox, MCP bridge, overlay) praktis tak terjangkau. Itu penghapusan
  tersendiri yang belum diputuskan.
- **Terbuka:** `src/lib/claude-fs.ts` (219 LOC, Node `fs` di app Tauri) nol importer — sisa era
  pra-Tauri, tidak terkait swarm.

## Guard

`src/modules/shell/__tests__/no-swarm-route.guard.test.ts`. Link ke `/swarm` adalah string, bukan
import, jadi TypeScript tidak bisa menangkapnya — ia hanya gagal sebagai 404 saat runtime. Guard itu
memindai teks sumber.
