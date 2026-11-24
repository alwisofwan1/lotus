# 0041 — Review PR tidak butuh review request GitHub; sumber permintaan bisa dipasang

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Alwi
- **Menggantikan:** `plans/automation/PLAN.md` § 2.3 Q10 dan Q4 (gate reviewer GitHub), dan baris
  "`@team-orbit` disimpan dua kali" di § 2.5
- **Terkait:** ADR-0038 (engine automation), ADR-0039 (review baca saja — tetap berlaku penuh)

## Konteks

Q10 menjadikan GitHub sumber kebenaran: review hanya jalan kalau PR meminta akun atau tim
(`reviewer_team`) sebagai reviewer. Pada 2026-09-28 dua PR yang diminta lewat `@team-orbit` di Slack
(`acme/acme-api#2867`, `acme/acme-web#2506`) dilewati dengan "review not requested from
alwisofwan1 or a watched team on GitHub". Bukti dari GitHub API:

- `requested_reviewers = []` dan `requested_teams = []` pada kedua PR;
- timeline berisi `review_requested acme by ditdot`, lalu tiga anggota lain sudah APPROVE — GitHub
  menghapus request tim begitu satu anggota me-review;
- `reviewer_team` di automation `null`.

Jadi gate itu menolak justru pola kerja tim: minta di Slack, request GitHub ke tim yang cepat habis.
Mengisi `reviewer_team` pun tidak menolong. Di sisi lain, pengguna Lotus lain mungkin tidak memakai
Slack sama sekali dan hanya mengandalkan review request GitHub, dan ke depan mungkin Notion atau lainnya.

## Keputusan

1. **Setiap pemicu sudah berarti permintaan.** Tombol Review, 👀 milik user, mention user atau user
   group Slack-nya, dan sumber permintaan mana pun cukup; review request GitHub tidak lagi dicek. GitHub
   tetap menjaga PR-nya: terbuka, bukan draft, bukan milik user, head tidak pindah selama run menunggu.
2. **`reviewer_team` dihapus** dari config `pr_review` dan form-nya (migrasi v9 membuangnya dari
   automation yang tersimpan). Form yang masih mengirim `reviewerTeam` ditolak dengan nama field-nya.
   `GitHub::has_reviewed` ikut dihapus: ia hanya ada untuk gate itu.
3. **Sumber permintaan (Request Source)** adalah trait `RequestSource` (`key`, `check`, `requests`)
   yang ditanya oleh `Poller` di tick host 30 detik, per automation paling sering tiap 5 menit. Sumber
   dinyalakan di `trigger.config.sources.<key>` di samping isi trigger (channel Slack, atau kosong untuk
   `manual`), jadi satu review bisa diminta dari Slack **dan** GitHub. Sumber pertama: `github` —
   PR terbuka, bukan draft (`draft:false`), yang meminta akun automation atau tim `org/slug` opsional.
4. **Satu permintaan, satu review.** Permintaan yang masih terdaftar tidak memulai run lagi, meski ada
   commit baru atau run-nya dilewati; hilang lalu diminta lagi (re-request setelah review) dihitung baru.
   Dicatat di `trigger_seen` (dulu `slack_seen`, kini untuk semua sumber) dengan kunci
   `<source>:<owner/repo>#<n>`. Kunci run tetap `repo#n@sha`, jadi PR yang sama dari Slack dan GitHub
   pada commit yang sama tetap satu run. PR yang pernah diminta di Slack tetap membalas di thread itu.
5. **Gagal bertanya ke sumber tidak melupakan apa-apa**: tanpa jawaban, catatan `trigger_seen` dibiarkan.

## Konsekuensi

- Siapa pun di channel yang mention user atau grupnya bisa memulai review (draft saja; Send tetap
  manusia, ADR-0039). Ini sama dengan yang diputuskan untuk Slack sejak awal; yang hilang hanya cek ganda.
- Query `review_requests` kini memakai `draft:false`, juga untuk antrean review `agent_prompt`.
- Menambah Notion dkk: satu `RequestSource` baru + registrasi di `automation_host.rs`; UI dan MCP
  memakai `automation_set_request_source` / field proposal per sumber.
