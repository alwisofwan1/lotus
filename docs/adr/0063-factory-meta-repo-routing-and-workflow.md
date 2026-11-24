# 0063 — Factory di meta-repo: triage memilih sub-repo, aturan induk lewat prompt, workflow per project

- **Status:** Accepted; tahap 1 sudah diimplementasi (satu run = satu sub-repo; lebih dari satu berhenti di Needs you), tahap 2 belum
- **Date:** 2026-10-20
- **Deciders:** Alwi
- **Mengubah:** [ADR-0055](0055-factory-pr-open-when-gates-pass.md) §2 (repo tanpa gate).
- **Terkait:** [ADR-0051](0051-factory-roles-and-intake.md) (roles, intake),
  [ADR-0049](0049-graph-run-factory-run-rust-engine.md) (satu run = satu worktree), `plans/factory-meta-repo/PLAN.md`.

## Konteks

`acme-main` (`acme/acme-main`) adalah **meta-repo**: repo git yang memuat ±15 repo git lain
(`acme-api`, `acme-web`, …) yang di-gitignore dan punya remote sendiri. Semua aturan kerja ada
di induk: `CLAUDE.md` 1135 baris, `.claude/rules/*.md`, `.agents/skills`. Sub-repo tidak punya
`CLAUDE.md`.

Fakta di kode (2026-10-20):

- New Run memilih satu repo ("Code in"); untuk database Notion, satu repo diingat per database.
  `find_checkout` sudah mencari satu tingkat sub-folder git, jadi run di `acme-api` bisa jalan.
- Worktree ada di `~/.lotus/factory/<run>`, di luar `acme-main`, jadi `CLAUDE.md` induk tidak
  ikut terbaca. Triage, spec dan review sengaja jalan tanpa CLAUDE.md apa pun
  (`CLAUDE_CODE_DISABLE_CLAUDE_MDS`, `lotus-automation/src/agent.rs:49-57`).
- Branch `factory/tkt-123-ab12cd34` gagal di CI `check-branch-name` acme
  (`^(feat|fix|refactor|chore)/[A-Za-z]+-[0-9]+-…`). Base acme = `develop`. Judul PR, isi PR dan
  format commit Factory tetap di kode; acme memakai `TKT-123 - Judul`,
  `.github/pull_request_template.md` dan Conventional Commits.
- Satu ticket TKT sering mengubah back dan front sekaligus.

## Keputusan

1. **Workspace, bukan repo.** New Run memilih workspace (folder lokal). Sub-repo = setiap folder git
   satu tingkat di bawahnya; semua boleh dipilih. Workspace dengan satu repo jalan seperti sekarang.
2. **Triage memilih sub-repo** dari teks ticket, daftar sub-repo dan rules-nya; field Notion `Repos`
   hanya petunjuk. Triage tidak membaca kode. Triage juga memilih `{type}` (feat/fix/refactor/chore).
3. **Spec boleh menambah sub-repo.** Daftar sub-repo tampil di Spec dan disetujui bersama Spec; setelah
   itu dikunci. Tidak ada kode ditulis sebelum user menyetujui repo-nya.
4. **Aturan induk lewat prompt Lotus, untuk semua role.** Tidak pernah ditulis ke worktree, jadi tidak
   bisa masuk PR. Isolasi CLAUDE.md pada triage/spec/review tetap utuh. Yang dikirim: rules milik
   sub-repo (`[repos.<nama>].rules`), atau `CLAUDE.md` induk kalau sub-repo tidak punya setting.
   Dibaca dari `origin/<default>` meta-repo, bukan folder lokal.
5. **Setting di meta-repo, di-push.** `acme-main/.lotus/factory.toml`:
   `[workflow]` (`branch`, `commit`, `pr_title`, `pr`, `base`) berlaku untuk semua sub-repo;
   `[repos.<nama>]` (`rules`, `base`, `gate`) menimpanya. Repo biasa memakai kunci yang sama.
   Skill `.agents/skills` induk masuk katalog.
6. **Workflow = bentuk hasil saja**: nama branch, commit, judul PR, isi PR, base, Open/Draft. Langkah
   proses (plan, link PRD, update docs, migrasi, feature flag) tetap teks di rules yang dibaca agent,
   bukan tahap engine. Isi PR: role Handoff mengisi `.github/pull_request_template.md` sub-repo; blok
   Factory (review, checks) di bawahnya. Tanpa template kunci = format sekarang.
7. **Repo tanpa gate tetap boleh Open** kalau review `accepted` (mengubah ADR-0055 §2). Review yang
   menolak, di-skip atau "Human" tetap Draft. Gate yang tidak menguji worktree (mis.
   `docker compose exec app` yang membaca checkout user) tidak dipakai: lebih baik tanpa gate daripada
   lulus palsu.
8. **Satu ticket, satu run aktif per workspace**, apa pun sub-repo-nya.
9. **Dua tahap.** Tahap 1: keputusan 1–8; Spec dengan lebih dari satu sub-repo berhenti dengan
   "multi-repo belum didukung". Tahap 2: satu run, satu agent, banyak worktree
   (`<run>/<sub-repo>/`), satu PR per sub-repo yang saling menaut; satu sub-repo gagal checks = tidak
   ada PR yang dibuka.

## Alternatif yang ditolak

- **Copy aturan induk ke worktree**: bisa ikut ter-commit ke PR sub-repo.
- **Kirim `CLAUDE.md` induk utuh ke semua sub-repo**: ditulis untuk folder induk ("`cd <sub-repo>`"),
  panjang, sebagian besar tidak relevan.
- **Chip repo di New Run, dipilih sebelum Start**: user tetap harus menebak; triage bisa menebak dari
  isi ticket dan Spec sudah jadi titik persetujuan.
- **Satu run per sub-repo yang saling terhubung**: agent front tidak melihat perubahan back, kontrak API
  bisa tidak cocok.
- **Engine workflow dengan tahap yang bisa ditambah**: jauh lebih besar; rules sudah membawa proses.
- **Path induk di setting privat**: setting tidak bisa dipakai bersama tim.

## Konsekuensi

- Glossary: **Meta-repo**, **Sub-repo**, **Factory Workflow**; **Factory PR** diperbarui.
- `FactoryToml` (`deny_unknown_fields`) mendapat `[workflow]` dan `[repos]`.
- Branch, commit, judul dan isi PR berhenti jadi konstanta (`mod.rs:266`, `runner.rs:860-923`).
- Kunci "issue sedang dipakai" berpindah dari per-repo ke per-workspace.
- Hotfix (PR ke `main` + label `hotfix`), merge, dan update status Notion di luar cakupan.
