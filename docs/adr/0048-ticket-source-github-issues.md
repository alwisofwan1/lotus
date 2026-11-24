# 0048 — Ticket source GitHub Issues: satu repo, read only, lewat akun `gh`

- **Status:** Accepted (implemented — slice 01–07, diuji nyata 2026-10-05)
- **Date:** 2026-10-04
- **Deciders:** Alwi
- **Terkait:** [ADR-0045](0045-ticket-sources-notion-and-obsidian.md) (bentuk ticket source; bullet
  terakhirnya: "GitHub dan Linear nanti menjadi sumber baru lewat bentuk yang sama"),
  [ADR-0039](0039-review-automation-read-only.md) / [ADR-0041](0041-review-request-sources.md)
  (akun `gh` per automation), `plans/github-issues-source/PLAN.md` (G1–G18).

## Konteks

Dialog "Add a ticket source" sudah menampilkan GitHub Issues, tapi sebagai teks tetap "Later"
(`AddTicketSourceModal.tsx:65`). Kode ticket source hanya mengenal `obsidian | notion`. Lotus sudah
punya jalan ke GitHub yang teruji: `lotus_automation::github` memanggil `gh api` dengan token per
akun (`gh auth token --user <login>`), membuang `GH_TOKEN`/`GITHUB_TOKEN` dari lingkungan, dan
menangani rate limit. Jalan itu hanya dipakai untuk PR.

Fakta GitHub yang menentukan bentuk keputusan:

- Issue hanya punya `state` `open | closed`, plus `state_reason` (`completed`, `not_planned`,
  `reopened`). Kolom status yang lebih kaya hanya ada di label (konvensi tim) atau GitHub Projects
  (GraphQL, API lain).
- `GET /repos/{owner}/{repo}/issues` juga mengembalikan pull request (item dengan `pull_request`).
- Parameter `since` memfilter berdasarkan `updated_at`, jadi sinkron incremental mungkin.
- Lotus tidak punya endpoint HTTPS publik, jadi webhook tidak bisa dipakai (sama dengan Notion).

## Keputusan

1. **Kind ketiga: `github`.** Satu sumber = **satu repo** (`owner/name`), satu project di tracker.
   Banyak repo = banyak sumber. Repo yang sama tidak bisa ditambah dua kali.
2. **Akun = akun `gh` yang sudah ada.** Setiap sumber menyimpan satu `account` (login GitHub), sama
   dengan Automation. Lotus tidak menyimpan token GitHub baru dan tidak meminta token. Repo dipilih
   dari daftar repo akun itu (dengan pencarian), atau diketik `owner/name`.
3. **Issue saja, bukan pull request.** Item dengan `pull_request` dibuang. PR sudah punya jalurnya
   sendiri (review automation).
4. **Dua status: Open dan Closed.** Closed menampilkan alasannya (`completed` / `not planned`).
   Pemetaan label → status dan GitHub Projects tidak ada di v1.
5. **Nama di board: `#123`.** Issue punya `number`, tidak punya `key` (`parseTaskKey` hanya membaca
   `PREFIX-123`, dan tidak perlu diubah).
6. **Read only.** Lotus tidak pernah menulis ke GitHub dari sumber ini: tidak ada mode Manage di v1.
   Alasan: `PATCH` issue tidak punya precondition, jadi Manage butuh pekerjaan cek-sebelum-tulis
   seperti Notion; itu langkah terpisah.
7. **Yang dimuat:** semua issue open, plus issue yang ditutup ≤ 30 hari terakhir. Repo besar tetap
   cepat.
8. **Sinkron sama dengan Notion:** tiap 60 detik selama Tasks terbuka dan jendela fokus, incremental
   (`since` = sinkron terakhir − 2 menit, `state=all`); baca penuh tiap 15 menit dan saat dibuka /
   Refresh. Semua panggilan ada di Rust; frontend hanya memanggil command Tauri.
9. **Kesehatan sumber memakai kata yang sama** (ADR-0045 §5): `gh` logout / akun hilang / repo tidak
   bisa diakses = `lost_access`; rate limit = `slowed_down`; jaringan = `offline`. Salinan terakhir
   yang baik disimpan di `<state dir>/ticket-sources/<source id>.json` dan tidak pernah mengosongkan
   list.
10. **Panel detail read only:** judul, status, label, assignee, body, dan komentar, dengan tombol
    "Open on GitHub". Komentar dibaca saat panel dibuka, tidak saat sinkron.
11. **Agent yang di-Delegate tidak menulis ke issue.** Perintah tulis issue lewat `gh` diblok di
    command line agent (`--disallowedTools`), begitu pula tool tulis issue dari GitHub MCP server
    mana pun. Agent tetap boleh push kode dan membuka PR; PR dengan "Fixes #123" menutup issue saat
    di-merge oleh manusia. Hanya preset yang bisa diberi larangan itu (Claude) yang boleh dipakai.
12. **Tidak ada catatan vault yang terhubung di v1.** GitHub dan Obsidian tidak bertemu; tidak ada
    `## From GitHub`. Bisa ditambah nanti lewat bentuk yang sama dengan Notion.

## Konsekuensi

- **Larangan `gh` untuk agent adalah best effort, tidak sekuat larangan Notion.** Tool MCP Notion
  hilang dari konteks agent; perintah Bash hanya dicocokkan berdasarkan prefix. `gh api -X PATCH …`
  dengan urutan flag lain, atau `curl` dengan token, bisa lolos. Yang dijamin: Lotus sendiri tidak
  pernah menulis, dan cara yang umum (`gh issue close/edit/comment/…`) diblok.
- Issue yang ditutup lebih dari 30 hari lalu tidak tampil. Issue yang dihapus atau dipindah
  (transfer) hilang di baca penuh berikutnya (≤ 15 menit, selama Tasks terbuka dan jendela fokus).
- Akun yang di-logout dari `gh` di terminal membuat sumber "Lost access"; perbaikannya `gh auth
  login`, bukan di Lotus.
- Kolom board hanya dua. Tim yang memakai label status perlu pemetaan label (keputusan berikutnya).
- `TaskSource.kind` di TS diperluas dengan `"github"`; di Rust sudah string bebas, jadi tidak ada
  migrasi. Pocket tidak membaca ticket source: tidak berubah.
