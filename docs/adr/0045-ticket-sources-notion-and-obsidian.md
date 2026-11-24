# 0045 — Ticket sources: Notion dan Obsidian sebagai sumber tiket yang setara dan independen

- **Status:** Accepted
- **Date:** 2026-09-29
- **Deciders:** Alwi
- **Terkait:** `plans/ticket-sources/PLAN.md` (S1–S50), `plans/ticket-sources/CHECKPOINTS.md`,
  `research/notion-connector.md` (§7, §8), `plans/notion-connector/PLAN.md` (jalur A tetap; jalur B
  digantikan ADR ini). Nomor 0045 tadinya dipesan untuk Notion Connector; dipakai di sini karena
  keputusan itu menjadi bagian dari keputusan ini.

## Konteks

Tasks dulu mengenal satu hal dari luar Lotus: satu vault Obsidian, lewat cabang
`projectId === VAULT_PROJECT_ID` di beberapa tempat. Tim memegang tiket di Notion (source of truth),
dan Alwi memakai vault sebagai lapisan pribadi. Pertanyaannya: bisakah Tasks memakai Notion tanpa
Obsidian, Obsidian tanpa Notion, dua-duanya, atau tidak ada sama sekali, tanpa satu sumber bergantung
pada yang lain — dan kemudian (revisi 2026-09-28) juga **mengelola** tiket di Notion, bukan hanya
membacanya.

Batasan yang menentukan bentuk jawabannya (fakta API dengan URL: riset §7, §8):

- Lotus tidak punya endpoint HTTPS publik, jadi **webhook Notion tidak bisa dipakai**.
- OAuth publik Notion mewajibkan `client_secret` di token endpoint; secret itu tidak bisa disimpan
  aman di binary desktop. **Personal access token** (PAT) bertindak sebagai pengguna, tanpa share
  page ke bot — tapi PAT **tidak bisa dibatasi read only** dari sisi Notion.
- `PATCH /v1/pages/{id}` dan `PATCH /v1/pages/{id}/markdown` **tidak punya** If-Match, ETag, atau
  precondition apa pun. Docs tidak menyebut "last-write-wins", tapi tanpa precondition itulah yang
  harus diasumsikan.
- Tulisan yang menjawab 503 **bisa sudah tersimpan**.
- Markdown page memakai tag Notion sendiri, dan blok yang tidak bisa dinyatakan kembali sebagai
  `<unknown …/>`. Apa yang terjadi pada blok itu saat seluruh page diganti tidak didokumentasikan.

## Keputusan

1. **Konsep "ticket source".** Satu sumber = satu project di tracker, dengan `kind`
   (`obsidian` | `notion`), kosakata status sendiri, dan kemampuan sendiri (`ProjectCapabilities`).
   Tracker bertanya "sumber jenis apa", tidak pernah "apakah ini id vault". Nol sumber adalah keadaan
   normal. v1: maksimal satu vault, banyak database Notion. Daftar sumber disimpan di
   `~/.claude/settings.json` `ticketSources`; folder vault tetap hanya di `vault.path`, supaya build
   Lotus lama tidak pernah berselisih dengannya.
2. **Akun di Connectors, sumber di Tasks.** Satu akun Notion per Lotus, dengan PAT (token integrasi
   juga diterima). Token hanya di secret store (`notion-token`), disamarkan `redact()`, dan **tidak
   pernah masuk ke proses agent**.
3. **Semua panggilan Notion ada di Rust** (`lotus_automation::notion`, `notion_host.rs`), dengan satu
   `Notion-Version` yang dipatok (`2026-03-11`). Frontend hanya memanggil command Tauri.
4. **Polling incremental, bukan webhook.** Tiap 60 detik selama Tasks terbuka dan jendela fokus:
   query `last_edited_time ≥ sync terakhir − 2 menit`. Docs tidak menyebut pembulatan, tapi diukur:
   875 dari 875 baris board nyata punya detik `:00.000`, jadi nilainya per menit. Baca penuh
   tiap 15 menit dan saat dibuka/Refresh, karena page di trash tidak muncul di query. 429 dihormati
   lewat `Retry-After` tanpa tidur di dalam request. Diukur: sinkron incremental board 873 baris = 1
   request.
5. **Sumber yang gagal tidak pernah mengosongkan list.** Salinan terakhir yang baik ada di
   `<state dir>/ticket-sources/<source id>.json` dan tampil dengan keadaannya ("source health":
   healthy, syncing, offline, slowed down, lost access, fields changed, failed), dengan kata yang sama
   di baris nav, banner list, dan Connectors.
6. **Mapping field per property id, bukan nama.** Rename di Notion tidak mengubah apa pun; field yang
   hilang membuat sumber masuk "Fields changed", dan **semua** penulisan berhenti sampai di-remap.
7. **Read only dijaga oleh Lotus sendiri.** Karena PAT selalu bisa menulis, izin per database
   (`read_only` default, atau `manage`) dibaca Rust dari settings — tidak pernah dari pemanggil — dan
   setiap penulisan ke database Read only ditolak **sebelum** request dibuat.
8. **Manage: cek sebelum tulis.** Setiap penulisan melewati gerbang yang sama: izin Manage, tidak
   sedang "Fields changed", field ter-map. Lalu per jenis:
   - **Properti:** `GET` page, bandingkan field yang diubah dengan yang terakhir dilihat pengguna;
     beda = conflict, tanpa `PATCH`; sama = satu `PATCH` yang hanya membawa field itu. Per field, bukan
     per `last_edited_time`, karena `PATCH` hanya menyentuh property itu: suntingan di tempat lain
     tidak tertimpa dan tidak menghalangi.
   - **Body:** `GET` markdown, bandingkan **seluruh** body dengan yang dibuka pengguna; suntingan di
     mana pun di body = conflict.
   - **Trash / Undo dan create:** tidak membandingkan apa pun dengan yang dilihat pengguna (trash hanya
     memastikan page ada di database ini); keduanya perubahan utuh yang tidak bisa menimpa isi.
9. **5xx pada tulisan tidak pernah diulang buta.** Lotus membaca page lagi dan melaporkan apa yang
   ada di Notion; untuk properti dan trash, pesan membawa `additional_data.retry_guidance` (body dan
   create belum membawanya). Untuk create, page dibaca lewat
   `additional_data.committed_resource_id`; tanpa id itu jawabannya "unknown" — tidak ada `POST` kedua.
10. **Body diedit dengan `update_content`, tidak pernah `replace_content`.** Lotus mengirim potongan
    di sekitar yang berubah (cari-ganti, maks 100 per request): setiap `old_str` diperluas dengan baris
    tetangga sampai unik, dan kalau potongan tidak bisa dibuat aman, satu potongan dari perubahan
    pertama sampai terakhir. `replace_content` mengganti seluruh
    page dari markdown, dan markdown itu tidak memuat blok yang Lotus tidak bisa tampilkan
    (`<unknown>`: bookmark, embed). Docs tidak menjamin blok itu selamat, jadi Lotus tidak mengambil
    risikonya: bagian page di luar potongan itu tidak pernah dikirim. Page yang
    punya blok seperti itu atau terpotong (`truncated`) tidak bisa diedit bodynya dari Lotus.
11. **Hapus = pindah ke trash**, dengan konfirmasi dan Undo. Hapus permanen, komentar, mengubah
    `unique_id`, dan memindahkan page ke parent lain: tidak pernah.
12. **Agent yang di-Delegate tidak pernah menulis ke Notion.** Ia membaca Notion lewat MCP resminya
    sendiri;
    17 tool tulis MCP hosted Notion diblok dengan `--disallowedTools 'mcp__*__<tool>'`, dan preset
    yang tidak bisa diberi larangan itu ditolak.
13. **Notion dan Obsidian hanya bertemu di registry.** Kode Notion tidak meng-import kode vault, dan
    sebaliknya. Dua titik temu, dua-duanya opsional:
    - **Match notes by key** (per database): tiket `TKT-1008` ↔ catatan `TKT-1008.md` (nama file,
      lalu `ticket:` di frontmatter) → badge "notes" dan bagian Notes.
    - **Pull ke `## From Notion`**: dipicu manusia (Review changes → Update the vault note). Section
      itu milik Lotus dan ditulis utuh; section lain tidak disentuh satu byte pun; di frontmatter
      hanya `notion_pulled:` dan `updated:` yang berubah. Page dicari lewat key, lalu lewat link
      `notion:` — hanya kalau page itu baris di database yang terhubung. `notion_pulled:`
      menyimpan `last_edited_time` page, dibaca sebelum body, jadi "Notion is newer" membandingkan jam
      Notion dengan dirinya sendiri. Aturan vault diubah untuk satu pengecualian ini
      (`CONVENTIONS.md`, `~/.claude/CLAUDE.md`).

## Konsekuensi

- **Celah GET→PATCH tetap ada.** Di antara `GET` (cek) dan `PATCH` (tulis) ada jendela kecil tempat
  orang lain bisa mengubah field yang sama; Notion tidak menyediakan precondition untuk menutupnya.
  Untuk properti jendelanya sebesar satu round-trip dan satu field, tapi bukan nol: pada saat itu
  tulisan terakhir menang. Untuk body (`GET` markdown → `update_content`) ada pengaman tambahan:
  `old_str` harus cocok tepat sekali, jadi potongan yang sudah diubah orang lain membuat update gagal,
  bukan menimpa.
- **Blok `<unknown>` inline (ditutup 2026-09-29, task "Ticket Sources 16").** Bookmark, embed, dan
  link preview datang sebagai `<unknown …/>` di dalam markdown **tanpa** `truncated` atau
  `unknown_block_ids`. Page seperti itu sekarang juga tidak bisa diedit bodynya: panel menyembunyikan
  Edit body (hitungan `cleanNotionMarkdown`), dan Rust (`has_unknown_blocks`) menolak tulisan itu
  sebelum `PATCH`. Keduanya memakai aturan "di dalam kode" yang sama dan diuji dengan satu tabel kasus
  (`lotus-automation/tests/fixtures/notion-unknown-blocks.json`). Batas yang diterima: satu backtick
  nyasar di prosa bisa berpasangan dengan backtick berikutnya dan "menyembunyikan" tag di antaranya
  — kedua sisi sama-sama menganggapnya kode, jadi tidak pernah saling membantah.
- "Edit di menit yang sama" bisa baru terlihat di sinkron berikutnya (jendela tumpang tindih 2 menit
  menutup yang terlewat). Page yang di-trash di Notion hilang dari list di baca penuh berikutnya:
  sekitar 15–16 menit, dan hanya selama Tasks terbuka dan jendela fokus (atau saat dibuka/Refresh).
- Field yang dihapus di Notion saat tidak ada tiket yang berubah baru ketahuan di baca penuh
  berikutnya (≤ 15 menit), karena schema hanya dibaca ulang saat ada alasan.
- PAT kedaluwarsa (7 hari–1 tahun) tampil sebagai "Lost access" dengan Reconnect, bukan error teknis.
- Tidak ada event `ticket-sources://changed` (S29 berubah): frontend yang tahu kapan Tasks terbuka
  dan jendela fokus, jadi frontend yang memutuskan kapan sinkron, dan jawaban datang dari command itu.
- GitHub dan Linear nanti menjadi sumber baru lewat bentuk yang sama; lebih dari satu vault butuh
  watcher per folder.
