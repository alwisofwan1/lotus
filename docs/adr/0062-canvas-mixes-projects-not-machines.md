# 0062 — Satu canvas mencampur proyek, bukan mesin: tuan rumah + proyek tertaut

- **Status:** Accepted
- **Date:** 2026-10-20
- **Deciders:** Alwi
- **Terkait:** `plans/codecanvas-vps-connector/PLAN.md` (Fase 0), `issues/01-mesin-jadi-bagian-dari-project.md`,
  `design/vps-connector.html` (aturan `hostQualifier`), board 22 (chip mesin)

## Konteks

Plan VPS connector menulis "satu canvas boleh mencampur mesin; lokasi melekat pada project". Kode
yang terbangun berbeda: satu canvas = satu baris `codecanvas_projects` = satu mesin. Snapshot node
disimpan per `project_id`, node tidak menyimpan mesin, dan ±15 tempat membaca mesin board lewat
`getActiveProjectLocation()` (spawn agen/terminal, git/worktree, ⌘K, tunnel, hook). Jadi
"mencampur" tidak pernah ada di kode.

Skenario yang dicari: satu repo, agen di `devbox-vps`, terminal/browser di Mac, satu board.

Fakta yang membatasi pilihan:

- Identitas proyek di Rust sudah = mesin + root (`UNIQUE(location_key, root_dir)`,
  `project_id_for`). Sesi, resume dan worktree bergantung padanya.
- `remote_tunnel.rs` sudah menyimpan tunnel per host; dua host berbeda tidak bentrok port.
- Laporan hook diatribusikan lewat pane id, bukan lewat mesin.

## Keputusan

1. **Yang dicampur adalah proyek.** Node milik tepat satu proyek dan mewarisi mesinnya. Repo yang
   sama di Mac dan di VPS adalah dua proyek. Override mesin per node ditolak: node akan punya
   identitas yang tidak cocok dengan `project_id`, dan sesi/resume/worktree jadi ambigu.
2. **Board = canvas milik proyek tuan rumah + proyek tamu yang ditautkan.** Daftar tamu disimpan di
   baris tuan rumah; node tamu disimpan di snapshot tuan rumah dengan `projectId` tamu. Tidak ada
   entitas Board baru, tidak ada migrasi; board lama = board dengan 0 tamu.
3. **Tunnel:** satu per mesin remote yang tertaut, terbuka selama board aktif, tanpa refcount per
   node. Hook dipasang sekali per mesin.
4. **Chip:** satu chip board 22 per mesin remote; mesin ke-3 dan seterusnya dilipat jadi `+N`.
   Mac sendiri tanpa chip.
5. **Edge/dispatch antar mesin boleh**, tanpa aturan khusus. Worktree tetap per proyek.
6. **Menautkan:** menu proyek → "Tautkan proyek…" — proyek yang ada dulu, lalu mesin/folder baru
   (panel tambah-proyek).
7. **Node baru default ke tuan rumah.** ⌘K mengelompokkan runner per proyek hanya bila board punya
   tamu.
8. **Label mesin** hanya di node yang mesinnya berbeda dari tuan rumah (`hostQualifier`).
9. **Lepas tautan / tamu dihapus:** konfirmasi "N node di <mesin> akan ditutup", lalu node tamu
   ditutup; sesi agen tetap bisa di-resume.
10. **Node tamu hanya ada di board tuan rumah**, tidak muncul di canvas milik tamu; sesi, resume dan
    worktree-nya tercatat atas `project_id` tamu.
11. **Batas v1:** diuji dengan 1 tamu; tanpa memindahkan node antar mesin; tanpa tautan bertingkat.
    Pocket menampilkan node tamu dengan label mesin, tanpa fitur menautkan.

## Konsekuensi

- Setiap consumer `getActiveProjectLocation()` yang bekerja atas nama sebuah node harus membaca
  proyek milik node itu. Consumer level board (tunnel, chip, probe ⌘K) harus menjadi per mesin.
- `canvas-active-project.ts` berhenti menjadi "satu mesin per board"; ia menjadi "proyek tuan rumah"
  ditambah lookup proyek per node.
- Komentar "a board only ever has one machine" di `useMachineTunnel.ts` menjadi tidak benar dan
  diganti.
