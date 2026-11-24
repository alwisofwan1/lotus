# 0058 — Yang boleh ditulis Lotus di Factory PR dan Slack: draft + Send, tidak pernah resolve thread

- **Status:** Accepted (belum diimplementasi)
- **Date:** 2026-10-13
- **Deciders:** Alwi
- **Mengganti sebagian:** [ADR-0049](0049-graph-run-factory-run-rust-engine.md) §4 (bagian "komentar ke
  orang lain tidak ada").
- **Terkait:** [ADR-0052](0052-pr-review-agent-first-sandboxed.md) (model Send di PR-review Automation),
  [ADR-0056](0056-chief-of-staff-deterministic-watcher.md),
  [ADR-0057](0057-factory-pr-revision-runs.md),
  `plans/factory-chief-of-staff/issues/06-github-write-policy.md`.

## Konteks

Chief of Staff membawa Factory PR lewat review engineer, jadi Lotus perlu membalas thread dan meminta
review ulang. ADR-0049 §4 melarang komentar ke orang lain. Semua yang ditulis Lotus muncul atas nama
akun GitHub pengguna (login `gh`); tidak ada akun bot.

## Keputusan

1. **Draft + Send secara default.** Balasan di bawah thread dan komentar ringkasan ronde adalah draf;
   pengguna mengirim per item atau "Send all" (model yang sama dengan ADR-0052).
2. **Auto-send opt-in per repo:** `replies = "auto-addressed"` di `.lotus/factory.toml` (default
   `draft`). Hanya balasan untuk item `addressed` dan ringkasan ronde yang terkirim otomatis. Jawaban
   untuk `question` dan penolakan `spec-change` selalu butuh Send.
3. **Tidak pernah resolve thread.** Engineer me-resolve thread-nya sendiri. Tidak ada jalur tulis
   GraphQL.
4. **Re-request review** ke reviewer yang item-nya `addressed`, sebagai bagian dari Send all (atau
   auto-send kalau nyala). **Tidak pernah menambah reviewer** baru.
5. **Tanpa footer "drafted by Lotus"** secara default; repo boleh menambah lewat `reply_footer`.
6. Tetap: Factory tidak pernah merge, tidak pernah force push (ADR-0057), dan Ticket Source tetap
   read-only.

7. **Slack** (ditambahkan 2026-10-13, tiket "Chief of Staff on Slack"). Lotus menulis ke Slack atas
   nama pengguna (token `xoxp-`).
   - **Ke pengguna:** hanya item "Needs you", dikumpulkan, maksimal satu ping per 15 menit, lewat
     DM dari bot aplikasi Slack (`xoxb-`, `chat:write`) plus notifikasi macOS. Tanpa token bot: hanya
     notifikasi macOS. Slackbot reminder ditolak: `reminders.*` disebut "degraded or useless" oleh
     Slack. Scope `search:read` ikut ditambahkan di instal ulang yang sama.
   - **Ke engineer:** hanya balasan di thread Slack tempat link PR dibagikan (dicari lewat Slack
     search). Tidak ada thread → tidak ada pesan Slack; tidak pernah DM dingin. Draf + Send, ikut
     Send all; ikut `replies = "auto-addressed"` kalau nyala.
   - **Identitas:** GitHub → Slack ditanya sekali di "Needs you", lalu diingat.

## Alternatif yang ditolak

- **Auto-send `addressed` sebagai default**: teks atas nama pengguna terkirim tanpa dilihat.
- **Lotus me-resolve thread**: mengambil keputusan milik reviewer; tidak ada vendor yang melakukannya.
- **Lotus menambah reviewer**: tugas CODEOWNERS dan tim.
- **Footer wajib**: bertentangan dengan preferensi pengguna; teks yang di-Send adalah kata pengguna.

## Konsekuensi

- `PullRequests` butuh tulis: balasan di thread review, komentar PR, request reviewers.
- Draf disimpan di record (ledger per item) sampai dikirim atau dibuang.
- Pembacaan status thread resolved tetap lewat GraphQL (read-only).
