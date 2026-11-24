# 0047 — Notes dibaca lewat satu tool MCP module-neutral: `lotus_notes_read`

- **Status:** Accepted
- **Date:** 2026-10-01
- **Deciders:** Alwi
- **Terkait:** ADR-0046 (Note Node tampilan kertas), ADR-0038 (Automation sebagai service
  module-neutral — pola yang ditiru di sini), ADR-0014 (note asset), Lotus Task LOT2-67.

## Konteks

Chip "Agent" di note (LOT2-67) membuat agent baru dan memasang wire note → agent bertipe `context`.
Di aplikasi, agent itu **tidak bisa membaca note-nya**. Penyebabnya terverifikasi di kode: teks note
yang di-wire hanya masuk ke prompt lewat `buildAgentRunPrompt`, dan itu hanya dipakai saat graph run
dimulai atau saat live agent punya *role*. Agent runner-first yang diajak bicara langsung tidak
pernah menerima teks note, dan tidak ada tool MCP untuk memintanya.

Alwi meminta tool-nya bisa dipakai di mode Canvas, Code, maupun Chat — bukan khusus canvas.

## Keputusan

1. **Satu tool, `lotus_notes_read`**, namanya module-neutral (`lotus_notes_*`, seperti
   `lotus_automation_*`), bukan `lotus_canvas_*`.
2. **Rust membaca langsung dari store** (`codecanvas_snapshots.nodes_json` + `edges_json`), bukan
   dari UI canvas. Jadi tool bekerja walau canvas tidak sedang dibuka — syarat untuk mode Code dan
   Chat. Kesegaran: edit note sampai ke store dalam ±1 detik (commit editor 300 ms + autosave
   canvas 800 ms).
3. **Scope:**
   - `linked` — note yang ter-wire ke agent pemanggil (arah wire mana pun). Default untuk agent
     canvas.
   - `project` — semua note di satu project. Default untuk pemanggil lain.
   - Tanpa `projectId` dan bukan agent canvas → tool mengembalikan daftar project beserta jumlah
     note, supaya agent bisa memilih.
4. **Identitas pemanggil diambil dari `LOTUS_PANE_ID` di env sidecar, tidak pernah dari argumen.**
   Itulah yang membuat `linked` berarti "ter-wire ke SAYA"; agent tidak bisa membaca atas nama node
   lain.
5. **Route berbasis action** (`/v1/notes`, `action: "read"`), seperti `/v1/canvas-memory`. Aksi note
   berikutnya (search, write) masuk ke route yang sama. Logika ada di `src-tauri/src/notes.rs`
   (murni, teruji unit), adapter HTTP di `mcp_notes.rs`.
6. Judul dan progres checklist dihitung di Rust dengan aturan yang sama dengan
   `deriveNoteTitle` / `noteTaskProgress` di TS. Keduanya harus tetap sama.
7. Agent canvas diberi satu kalimat di system prompt (`CANVAS_NOTES_CAPABILITY`, juga di bootstrap
   runner non-Claude). Mode Code dan Chat menemukan tool lewat deskripsinya sendiri.

## Konsekuensi

- Logika judul ada di dua bahasa. Tes di kedua sisi memakai contoh yang sama.
- Teks note yang dikembalikan dipotong per note (`maxChars`, default 20 000), supaya satu note
  besar tidak menghabiskan konteks agent.
- **Jebakan yang ditemukan saat verifikasi (2026-10-01):** Rust menyematkan
  `scripts/lotus-mcp-server.bundle.mjs` (`include_str!` di `mcp_config.rs`), bukan sumbernya.
  `tauri dev` membangun ulang Rust saat file berubah tanpa menjalankan `mcp:bundle`, jadi tool baru
  di sumber tidak sampai ke agent. Agent lalu memanggil app lewat `curl` dan sandbox-nya menolak.
  Pengaman: tes `lotus-mcp-bundle.test.mjs` gagal kalau ada tool di sumber yang tidak ada di bundle,
  dan prompt agent melarang jalan memutar itu (pakai ToolSearch, jangan HTTP/file).

## Tambahan 2026-10-01 — menulis: `lotus_notes_write`

Alwi meminta agent juga bisa menulis. Masalah satu-satunya adalah race: selama canvas membuka project,
note hidup di editor dan autosave canvas menyimpan node di memori — tulisan langsung ke store akan
tertimpa sedetik kemudian.

1. **Rust memutuskan, lalu merutekan.** `notes_write.rs` me-resolve target (noteId, atau satu-satunya
   note yang ter-wire ke pemanggil), cek konflik `expectedEditedAt`, dan isi barunya. Lalu:
   - project sedang dibuka sebuah window → event `mcp://notes-write` ke **window itu saja**
     (`emit_to`); canvas menerapkannya di editor (`useMcpNotesBridge`), autosave membawanya.
   - tidak ada canvas yang membuka project itu (mode Code / Chat) → tulis langsung ke snapshot.
2. **Registry "canvas mana yang terbuka"** (`notes_bridge_set_canvas`, per label window): di-set saat
   mount / ganti project, dikosongkan saat unmount, dihapus saat window ditutup. `active_workspace_id`
   tidak dipakai karena tidak pernah dikosongkan.
3. **Pengaman di canvas**, atas state-nya sendiri yang lebih segar dari store: tolak saat user sedang
   mengetik di note itu (editor fokus dalam mode edit), tolak konflik `editedAt`, batas 100 000
   karakter. Append dihitung ulang dari isi editor, bukan dari store.
4. **Mode:** `append` (default), `replace`, `create` (note baru di samping agent, ter-wire ke agent,
   tidak mengambil caret user).
5. **Penanda penulis:** `editedBy` (nama agen di fleet) disimpan bersama note; footer menulis
   "Edited by Ivo · today at 15:42". Edit oleh user menghapusnya lagi.
6. Prompt agent canvas: tulis sendiri dengan `lotus_notes_write`, jangan minta user menempel.
7. **Ditemukan saat verifikasi:** command Tauri baru wajib masuk
   `src-tauri/permissions/main-app-commands.toml`. Tanpa itu `notes_bridge_set_canvas` ditolak, Rust
   mengira tidak ada canvas yang terbuka, dan tulisan agent masuk ke store — lalu tertimpa autosave.
   Tes `tauri-command-permissions.test.ts` menangkapnya. Kegagalan registrasi kini di-log.
8. **Jaring pengaman:** setiap tulisan ke store disiarkan sebagai `notes://written`. Canvas yang ternyata
   membuka project itu mengadopsinya (update atau create), jadi tulisan agent tidak hilang walau
   registrasi gagal atau balapan.

