# 0068 — Rename mengganti Agent Handle; satu Name Pool untuk semua mode

- **Status:** Accepted (2026-11-23)
- **Date:** 2026-11-23
- **Deciders:** Alwi
- **Terkait:** `plans/agent-naming/PLAN.md`, `mockups/agent-naming.html`, ADR-0026 §NP (auto-naming),
  `plans/codespace-agent-naming/PLAN.md`

## Konteks

Satu agent di Code bisa punya dua nama: `agentName` (Agent Handle, dikirim sekali ke agent saat pane
dibuka) dan `customDisplayName` (hasil rename, hanya label di layar). Setelah rename, layar bilang
"Kirana" tapi agent masih mengira dirinya "Nara", dan suara/dispatch bisa salah sasaran.

Name Pool juga terpecah: setting "Naming language" tinggal di store Canvas, Code membaca bahasa
device, Chat tidak memakai pool sama sekali.

## Keputusan

1. **Rename sebuah agent mengganti Agent Handle-nya**, di Canvas, Code, dan Chat. `customDisplayName`
   dilebur ke `agentName`. Agent diberi tahu nama barunya: di Code lewat satu pesan pendek ke pane,
   di Chat lewat preamble pesan berikutnya (tanpa giliran terpisah). Shell biasa bukan agent: rename
   di sana hanya mengganti judul pane.
2. **Agent Handle diberikan sekali** dari Name Pool aktif dan tidak berubah sendiri, termasuk saat
   pool aktif diganti atau dihapus.
3. **Satu setting Name Pool untuk seluruh app**, di modul `src/lib/agent-naming/`, disimpan di
   localStorage (`agent-naming-v1`). Bukan file Rust: semua nama dipilih di frontend desktop (thread
   Chat dan pane dari Pocket/MCP juga lewat frontend), jadi Rust tidak perlu membaca pool.

## Konsekuensi

- Data `customDisplayName` lama dipindah sekali ke `agentName`; field itu hilang dari tipe.
- Agent Handle thread Chat disimpan bersama thread di `chat.sqlite3`.
- Pool custom hilang kalau data webview terhapus, sama seperti setting UI lain.

## Kapan keputusan ini salah

Kalau Standalone Host (`packages/host`) mulai membuat agent sendiri tanpa desktop, ia butuh pool di
sisi Rust/host: pindahkan setting ke `~/.lotus/agent-naming.json`.
