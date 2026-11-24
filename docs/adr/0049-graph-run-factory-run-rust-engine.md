# 0049 — Graph Run menuju Factory Run: ticket → Draft PR, mesin di Rust, Automation sebagai pemicu

- **Status:** Accepted (belum diimplementasi — urutan irisan di bawah)
- **Date:** 2026-10-06
- **Deciders:** Alwi
- **Terkait:** `plans/canvas-graph-run/PLAN.md` (P1–P6), [ADR-0036](0036-remove-swarm-module.md)
  (Swarm dihapus karena tidak dipakai), [ADR-0038](0038-automation-engine-rust-crate.md) (Automation
  di crate Rust, jendela boleh tertutup), [ADR-0039](0039-review-automation-read-only.md),
  [ADR-0041](0041-review-request-sources.md) (polling, bukan webhook),
  [ADR-0045](0045-ticket-sources-notion-and-obsidian.md),
  [ADR-0048](0048-ticket-source-github-issues.md) (GitHub Issues read-only),
  `research/software-factory-2026-10.md`.

## Konteks

Graph Run (Run Node di canvas) sudah punya scope per run (#74), kartu Run Node, dan budget cap (#76).
Arah berikutnya belum jelas: plan lama (P4–P6) menganggap run sebagai graph bebas yang dirakit
pengguna, dengan Mission Control sebagai tujuan akhir. Swarm dihapus (ADR-0036) karena dibangun
sebelum ada pemakaian nyata; Graph Run berisiko mengulanginya.

Bukti yang ada: trial Archon 2026-10-05, dua run nyata di Lotus, keduanya ticket → implement →
gates → PR, keduanya di-merge.

| Run | Task | Hasil |
|---|---|---|
| 1 | #75 (`archon-implement`) | 17 menit, gates hijau; hanya CSS diperbaiki manual (agent tidak bisa membaca `.pen`) |
| 2 | #76 (`archon-deliver`) | 34 menit, PR #79, CI hijau; self-review "Ready" meleset dari satu celah: biaya step gagal tidak dihitung (`checkpoint.failed` hanya menyimpan id) |

Fakta kode yang menentukan:

- Mesin Graph Run hidup di TypeScript dalam webview (`graph-run-session.ts`,
  `canvas-run-scheduler.ts`); Rust (`codecanvas_graph_runs.rs`) hanya menyimpan record dan checkpoint
  sebagai JSON opaque.
- Automation berjalan di crate Rust selama proses hidup, jendela boleh tertutup (ADR-0038).
- Ticket Source GitHub read-only dan tanpa webhook (ADR-0048).

## Keputusan

1. **Graph Run dirancang pertama untuk Factory Run:** satu ticket → satu Draft PR lewat worktree
   terisolasi, implement, Check, Review. Graph bebas tetap ada, tetapi tidak mengarahkan prioritas.
2. **Dimulai dua cara:** manual dari kartu ticket, dan oleh Automation lewat Automation Action baru
   `graph_run`. Automation tetap satu-satunya mesin trigger; Run Node tidak punya trigger sendiri.
3. **Trigger `ticket_ready`:** label `factory:ready` pada issue GitHub, dideteksi lewat polling
   Ticket Source. Lotus tidak menulis apa pun ke issue; PR memuat `Closes #N`. Melepas label sebelum
   run mulai = dilewati; run yang sudah jalan dihentikan lewat Abort. Notion/Obsidian menyusul lewat
   bentuk yang sama.
4. **Batas otonomi: berhenti di Draft PR.** Satu-satunya yang keluar dari Lotus adalah draft PR
   berlabel `factory:review`. Auto-merge, "Ready for review", dan komentar ke orang lain tidak ada
   dan tidak bisa dinyalakan lewat config.
5. **Lima pagar untuk run yang dimulai Automation:**
   a. Back-pressure: ≥ 3 PR `factory:review` terbuka → trigger dilewati dan ticket tampil "antre"
      (dicatat sebagai skip reason, tidak hilang).
   b. Budget cap wajib; tanpa cap run ditolak.
   c. Batas harian N run otomatis.
   d. Idempotency: kunci = repo + nomor issue + commit dasar; issue yang sama tidak membuat dua PR.
   e. Biaya setiap percobaan, termasuk yang gagal, masuk ke cap.
6. **Mesin eksekusi Factory Run pindah ke Rust.** Scheduler dengan scope, slot pool bersama, budget,
   checkpoint, dan resume hidup di crate Rust; React hanya menggambar status dan mengirim keputusan
   (Ship, Send back, Raise cap). Alasan: run otomatis harus tetap jalan tanpa webview. Jalur graph
   bebas (PlanNode, replay) tetap di TS sampai dipindah belakangan lewat kontrak yang sama.
7. **Check node = gate yang dideklarasikan repo.** Satu file konvensi di repo target (mis.
   `.lotus/factory.toml`, `gate = "tools/gates.sh"`) dijalankan di worktree. Merah → kembali ke
   implement dengan output gate, maksimal 2 percobaan; masih merah → run berhenti sebagai Automation
   Ask dengan output terlampir, tanpa PR. Repo tanpa gate: Factory Run ditolak saat dimulai.
8. **Review node memakai model/CLI berbeda dari implementer**, read-only (ADR-0039). Temuan blocker
   → satu putaran balik ke implement lalu Check ulang; tidak ada putaran kedua. Temuan non-blocker
   dilampirkan ke deskripsi PR sebagai "Review notes". Reviewer tidak pernah menyatakan "Ready".
   Perubahan UI otomatis membawa catatan "perlu cek visual" (agent tidak bisa membaca `.pen`).
9. **Worktree per run** di bawah direktori state Lotus, tidak pernah di checkout utama, dengan
   target-dir sendiri; dibersihkan setelah PR di-merge atau ditutup.
10. **Urutan: mesin dulu, irisan vertikal.** (1) mesin Rust: scope, slot pool, budget, checkpoint,
    resume; (2) Factory Run manual dari ticket sampai Draft PR; (3) Review node + satu putaran;
    (4) Automation `graph_run` + `ticket_ready` + semua pagar; (5) Mission Control (P4–P6) paling
    akhir. P4–P6 tidak dibuang tetapi ditulis ulang setelah irisan 3.

## Alternatif yang ditolak

- **Graph bebas sebagai tujuan utama** (plan lama): tanpa bukti pemakaian, risiko seperti Swarm.
- **Trigger sendiri di Run Node:** menggandakan mesin Automation (idempotency, catch-up, recursion
  guard sudah ada di sana).
- **Eksekusi tetap di TS dengan webview tersembunyi:** run otomatis bergantung pada webview yang
  bisa tidak ada.
- **Self-review atau tanpa review di dalam run:** self-review meleset di #76; tanpa review
  memindahkan seluruh beban ke pengguna.
- **UI dulu (urutan P4 → P6):** pola yang menghapus Swarm.

## Konsekuensi

- **Penulisan ulang mesin ke Rust itu mahal.** Mesin TS punya ribuan test (±6000 di
  `src/modules/codecanvas`); kontrak yang dipindah harus dipertahankan perilakunya, dan sementara
  ada dua mesin (Rust untuk Factory Run, TS untuk graph bebas).
- Status tidak tampil di issue (tidak ada komentar "sedang dikerjakan"); itu harga menjaga Ticket
  Source read-only.
- Run otomatis hanya berjalan selama proses Lotus hidup; Mac tidur berarti run menunggu, bukan
  hilang (checkpoint + resume).
- Repo tanpa file gate tidak bisa dipakai untuk Factory Run sampai gate dideklarasikan.
- Review lintas model menambah biaya per run; batas satu putaran dan budget cap membatasinya.
- Trial Archon berhenti di dua run: cukup untuk arah ini, tetapi jalur run yang gagal di tengah
  belum teruji nyata; irisan 1–2 harus mengujinya.
