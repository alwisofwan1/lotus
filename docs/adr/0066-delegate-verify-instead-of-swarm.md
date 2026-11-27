# 0066 — Verifikasi lintas provider pada delegate, bukan /swarm

- **Status:** Accepted
- **Date:** 2026-11-11
- **Deciders:** Alwi
- **Memperkuat:** ADR-0051 §5, ADR-0056, ADR-0065 §5–6 — loop dijalankan aturan di kode; merge tetap klik pengguna.
- **Terkait:** `plans/chat-swarm/TRIAL.md`, `mockups/chat-swarm.html`, GLOSSARY › Chat Swarm

## Konteks

Antigravity merilis `/swarm` (coordinator, worker, verifier, monitor, Board bersama dengan @mention).
Kami menguji ide itu secara manual di Lotus sebelum membangun apa pun: 4 worker memperbaiki 12 temuan
audit, dan 2 verifier dari provider lain memeriksa hasilnya (run 1, 2026-11-11).

Hasilnya:
- **Board tidak memberi apa-apa.** Tidak ada Member yang membaca Board untuk bertindak; ketujuh wake
  adalah `lotus_chat_tell` dari coordinator. Board malah menambah gesekan (sandbox, format shell).
- **Verifier dari provider lain sangat bernilai.** Ia menemukan 4 cacat nyata yang lolos dari worker,
  termasuk fix P1 yang hanya menyamarkan bug. Worker pocket menyatakan selesai tiga kali dengan test
  hijau, dan tiga kali dibantah.

## Keputusan

1. **/swarm dan Board tidak dibangun.** Istilah Chat Swarm di GLOSSARY tetap tercatat sebagai ide
   yang ditolak, bukan sebagai fitur.
2. **`lotus_chat_delegate` mendapat opsi `verify`.** Saat child selesai, Lotus otomatis men-spawn
   verifier dari **provider lain**. Verifier bersifat read-only, menjalankan ulang **full suite**
   package yang disentuh, dan boleh menulis probe sendiri. Ia mengembalikan `pass` atau `fail`
   beserta alasannya.
3. **Bounce dijalankan kode, bukan LLM.** Kalau verifier menyatakan `fail`, alasannya dikirim ke child
   lewat `tell`. Setelah child selesai lagi, verifier memeriksa ulang. Batas default 3 ronde (pocket
   butuh 3 di uji coba). Melewati batas → berhenti dan lapor ke parent sebagai `unverified`.
4. **Hasil akhir tetap usulan.** `lotus_chat_wait` mengembalikan verdict dan jumlah ronde; merge
   tetap keputusan pengguna (ADR-0065 §5).

## Konsekuensi

- Tujuh wake manual di uji coba digantikan satu flag. Coordinator tidak perlu menyalin hasil review
  ke pesan.
- Biaya: satu sesi verifier per ronde. Karena itu `verify` opt-in per delegate, bukan default.
- Brief verifier yang bisa dipakai ulang ada di `plans/chat-swarm/briefs/verify.md`. Pelajaran yang
  wajib dibawa: full suite, bukan subset milik worker, dan pengecualian test-merah untuk penghapusan
  kode mati.
- Belum terukur: biaya token. `lotus_chat_wait` belum mengembalikan token.
- **Tambahan 2026-11-12:** `/swarm` ditambahkan sebagai skill bawaan Lotus
  (`apps/desktop/scripts/lotus-swarm-skill.md`). Skill ini dipasang ke `~/.claude/skills` dan
  `~/.agents/skills` setiap kali app start, supaya user baru tahu polanya. Isinya hanya instruksi
  untuk lead: memecah tugas, menjalankan delegate dengan `worktree` + `verify`, `wait`, lalu
  melapor. Board, @mention dan peran baru tetap tidak ada. Keputusan 1 tidak berubah.
- **Tambahan 2026-11-28 (efisiensi):** data nyata menunjukkan dua pemborosan. (a) Worker yang menyerah
  ("task incomplete", tanpa commit) tetap dikirim ke verifier tiga kali. (b) Setiap ronde memakai
  verifier baru tanpa ingatan, sehingga tiap ronde menemukan masalah *lain* walau semua test hijau.
  Perubahan: worker yang memakai verify mengakhiri laporan dengan `STATUS: done|blocked`, dan
  `blocked` langsung kembali ke lead (status `blocked`). Branch tanpa commit baru tidak dikirim ke
  verifier. Satu sesi verifier dipakai untuk semua ronde, dan ronde berikutnya hanya memeriksa
  ulang alasannya sendiri. Fail hanya untuk cacat yang memblokir; temuan lain masuk `Notes:`.
  Default turun ke 2 ronde. Chat yang didelegasikan tidak lagi diberi catatan cara mendelegasikan.
  Di rail, verifier dilipat ke baris worker ("verifying 1/2", "verified ✓").
