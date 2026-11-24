# 0057 — Revisi Factory PR lewat Revision Run, tanpa force push

- **Status:** Accepted (belum diimplementasi)
- **Date:** 2026-10-13
- **Deciders:** Alwi
- **Terkait:** [ADR-0049](0049-graph-run-factory-run-rust-engine.md),
  [ADR-0055](0055-factory-pr-open-when-gates-pass.md),
  [ADR-0056](0056-chief-of-staff-deterministic-watcher.md),
  `plans/factory-chief-of-staff/issues/04-revision-round.md`.

## Konteks

Factory Run berakhir `Completed` (status final) setelah PR dibuka. Engineer lalu memberi review di
Factory PR, dan Chief of Staff perlu meminta revisi pada PR yang sama. Hari ini push pertama memakai
`git push --force` (`factory/runner.rs:790`), tidak ada link parent/child antar run, dan "Try again"
selalu membuat run baru.

## Keputusan

1. **Revision Run.** Satu ronde revisi = satu Factory Run baru yang ter-link ke Factory PR (dan run
   sebelumnya). Status final tetap final; run lama tidak dibuka lagi.
2. **Mulai dari head di GitHub.** Revision Run membuat worktree baru dari `origin/<branch>` dan checkout
   branch PR yang ada (tidak membuat branch baru), karena engineer bisa menambah commit lewat GitHub.
   Worktree ronde lama boleh di-reaper; hanya worktree ronde terbaru dijaga selama PR open.
3. **Tidak pernah force push**, di ronde mana pun, termasuk push pertama. Commit baru ditumpuk, push
   biasa, tidak pernah rebase. Push ditolak atau PR konflik dengan base → "Needs you", bukan force dan
   bukan merge base otomatis.
4. **Batas:** maksimal 3 Revision Run per Factory PR (`max_rounds` di `.lotus/factory.toml`), masing-masing
   dengan cap repo (`cap_usd`). Setelah ronde habis, feedback baru → "Needs you".
5. **Review terhadap spec dan feedback.** Reviewer mendapat spec yang di-approve, daftar feedback ronde
   ini, diff ronde (head lama → head baru), dan diff penuh terhadap base. Verdict per AC **dan** per item
   feedback (`addressed` / `not addressed`); item yang belum → kembali ke implement, dengan batas attempt
   yang sama seperti sekarang.
6. **Menunggu review adalah state Factory PR**, bukan `RunStatus`. Board menampilkan "menunggu review",
   "revisi ronde N", "ronde habis" dari PR; run tidak pernah `Waiting` berhari-hari karena PR.

## Alternatif yang ditolak

- **Stage baru di run yang sama**: run `Completed` harus dibuka lagi, arti status berubah ("selesai"
  baru saat merge), engine dan recovery berubah lebih besar.
- **Rebase ke base + `--force-with-lease`**: history lebih rapi, tetapi history yang sudah di-review
  engineer hilang dan commit engineer bisa tertimpa.
- **Satu cap total per PR**: lebih tepat, tetapi butuh field cap baru di level PR; batas ronde sudah
  membatasi total (≈ 4× cap).
- **Pakai ulang worktree run pertama**: bisa sudah di-reaper, dan bisa lebih tua dari head remote.

## Konsekuensi

- `factory/runner.rs:790` berubah dari `--force` ke push biasa; push ditolak jadi jalur "Needs you".
- Record run butuh link ke Factory PR / run sebelumnya, dan Factory PR butuh nomor PR (hari ini hanya
  URL di `NodeResult.detail`).
- Pembuatan worktree butuh mode "checkout branch yang ada" di samping `worktree add -b`.
- Prompt review butuh daftar feedback dan diff ronde; parse verdict butuh status per item feedback.
- Board mengelompokkan run per Factory PR.
