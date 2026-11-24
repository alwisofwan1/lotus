# 0055 — Factory PR dibuka sebagai Open saat semua pagar lolos

- **Status:** Accepted (belum diimplementasi)
- **Date:** 2026-10-13
- **Deciders:** Alwi
- **Mengganti sebagian:** [ADR-0049](0049-graph-run-factory-run-rust-engine.md) §4 (bagian "Draft PR" dan
  "Ready for review") dan [ADR-0051](0051-factory-roles-and-intake.md) §8 (bagian "tidak pernah menandai
  PR Ready").
- **Diubah oleh:** [ADR-0063](0063-factory-meta-repo-routing-and-workflow.md) §7 — repo tanpa gate
  dibuka Open kalau review `accepted`.
- **Terkait:** `plans/factory-chief-of-staff/` (map Chief of Staff), audit
  `plans/factory-chief-of-staff/research/audit-2026-10-13.md`.

## Konteks

ADR-0049 §4 menghentikan Factory Run di Draft PR dan melarang "Ready for review" lewat config. Setelah
F2, FI6 dan FI7 (test per AC, review terhadap spec dengan model berbeda, source digest), Factory sudah
punya pagar sendiri sebelum PR. Langkah manual "mark ready" menambah satu klik per PR, dan reviewer
tidak mendapat notifikasi atau request dari CODEOWNERS selama PR masih Draft.

Hari ini PR tetap dibuat walaupun review gagal, di-skip, atau verdict-nya "Human". Kalau semua PR
langsung Open, engineer mendapat notifikasi untuk PR yang belum layak.

## Keputusan

1. **Factory PR** = PR berlabel `factory:review`, dibuka sebagai **Open** atau **Draft**.
2. Dibuka **Open** hanya jika gate hijau **dan** review verdict `accepted`. Selain itu (review gagal,
   di-skip, verdict "Human", tidak ada spec) tetap **Draft**, dengan catatan review di atas.
3. Per repo: `.lotus/factory.toml` → `pr = "open" | "draft"`. Default `open`. `draft` memaksa semua
   Factory PR tetap Draft (perilaku lama).
4. Source GitHub milik Automation PR-review **melewati** PR berlabel `factory:review`. Feedback pada
   Factory PR adalah tugas Chief of Staff, bukan Automation PR-review.
5. Tetap: Factory tidak pernah merge. Komentar ke orang lain diputuskan terpisah di map Chief of Staff
   (area "aturan menulis ke GitHub"); ADR ini tidak mengubahnya.

## Alternatif yang ditolak

- **Selalu Open apa pun hasil review**: engineer menerima PR yang reviewer Factory sendiri belum
  terima.
- **Open untuk semua repo tanpa setting**: repo yang belum percaya Factory tidak punya jalan kembali
  ke Draft.
- **Biarkan Automation PR-review me-review Factory PR**: satu PR punya dua pemilik di Lotus, dan Lotus
  me-review PR buatannya sendiri.

## Konsekuensi

- Glossary: "Draft PR" diganti **Factory PR**.
- Runner perlu verdict review sebelum memilih `--draft` di `gh pr create`.
- Filter `factory:review` di source PR-review (`sources/github.rs`).
- UI Runs/Board perlu membedakan Factory PR Open dan Draft.
- **Review yang di-skip = Draft.** Review di-skip kalau preset dan model Review sama dengan Implement,
  kecuali `same_model` dinyalakan (`crates/lotus-graph-run/src/factory/runner.rs:654`). Repo tanpa
  `.lotus/factory/agents/` (termasuk Lotus sendiri, 2026-10-13) memakai default yang sama untuk keduanya,
  jadi setiap Factory PR tetap Draft. Supaya `pr = "open"` terasa: beri Review preset/model lain di
  Factory › Settings › Pipeline, atau izinkan model yang sama. UI perlu menjelaskan *kenapa* PR tetap
  Draft ("Review skipped: same model").
- **Base branch per repo (LOT2-192, 2026-10-14).** `.lotus/factory.toml` → `base = "develop"` memilih
  branch tujuan Factory PR. Tanpa key = default branch GitHub (`origin/HEAD`), seperti sebelumnya.
  Key dibaca dari salinan file di default branch; sisa definisi (gate, agent, cap) dibaca dari
  `origin/<base>`. Kalau salinan di `origin/<base>` berbeda, salinan default branch menang dan tab
  Agents memberi peringatan. `origin/<base>` tidak ada = run ditolak dengan file:baris key-nya. Factory
  tetap tidak pernah push ke base; selalu branch `factory/*` sendiri + PR.
