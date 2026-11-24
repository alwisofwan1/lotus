# 0051 — Factory Run punya peran agen dan tahap intake (brainstorm + spec) sebelum coding

- **Status:** Proposed (belum diimplementasi)
- **Date:** 2026-10-08
- **Deciders:** Alwi
- **Terkait:** [ADR-0049](0049-graph-run-factory-run-rust-engine.md) (Factory Run, mesin Rust),
  [ADR-0039](0039-review-automation-read-only.md) (resep read-only), `plans/factory-intake/PLAN.md`.

## Konteks

Factory Run (F1–F2) memberi judul + isi issue langsung ke satu agen dengan akses penuh, lalu gate, lalu
draft PR. Audit 2026-10-08 (`plans/factory-intake/research/audit-2026-10-08.md`) menemukan: tidak ada
intake, spec, atau persetujuan sebelum coding; gate bisa hijau tanpa test; agen memegang semua MCP
pengguna; tidak ada reviewer. Semua tool besar (Spec Kit, Kiro, Devin, Copilot, Warp Factories)
menaruh klarifikasi + spec yang disetujui manusia sebelum implementasi.

## Keputusan

1. Factory Run punya **lima peran**: triage, spec, implement, review, handoff. Tiap peran = preset CLI
   + model + prompt + skill + MCP + mode akses.
2. **Definisi di repo**: `.lotus/factory.toml` + `.lotus/factory/agents/<peran>.md` (frontmatter +
   prompt), dibaca dari `origin/<base>`. Tanpa file → default bawaan Lotus.
3. **Brainstorm async sebagai default**, lewat jalur Ask Automations dan status run baru
   `waiting-for-you`; **Brainstorm live** di terminal canvas sebagai pilihan.
4. **Approve spec selalu eksplisit.** Tidak ada auto-approve karena diam.
5. **Urutan tahap ditentukan state machine Rust**, bukan agen foreman. Agen hanya menyarankan skip.
6. **MCP per peran** lewat `--mcp-config` + `--strict-mcp-config`; agen tidak lagi otomatis memegang
   semua MCP pengguna. Triage, spec, review, handoff read-only.
7. Reviewer menilai **terhadap spec**, per AC, dengan model berbeda dari implement (menggantikan F3).
8. Factory tetap tidak pernah merge dan tidak pernah menandai PR "Ready".

## Alternatif yang ditolak

- **Agen foreman LLM ala Warp**: fleksibel, tetapi mahal, sulit dites, dan sulit di-resume. Bisa
  ditambah nanti di atas state machine yang sama.
- **Definisi di setting app**: lebih cepat dibangun, tetapi tanpa versi, tidak per repo, dan agen bisa
  saja menyentuhnya.
- **Brainstorm live saja**: run berhenti sampai pengguna duduk di depan Lotus; tidak cocok dengan
  Automation (F4) yang jalan saat jendela tertutup.

## Konsekuensi

- `RunStatus` butuh status baru dengan payload pertanyaan; record run menyimpan triage, Q&A, spec,
  verdict.
- Lotus perlu membaca plugin skill dan server MCP pengguna (hari ini belum).
- Run jadi lebih lama untuk tiket besar; tiket XS + 🟢 boleh melewati brainstorm, tetapi tetap lewat
  Approve.
