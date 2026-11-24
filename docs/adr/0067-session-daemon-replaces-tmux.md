# 0067 — Daemon sesi `lotus-sessiond` memiliki PTY, menggantikan tmux

- **Status:** Accepted (2026-11-17, after phase 5 ran on devbox-vps and passed the phone smoke)
- **Date:** 2026-11-15
- **Deciders:** Alwi
- **Menggantikan (bila Accepted):** ADR-B di `plans/pocket-without-laptop/PLAN.md` (durabilitas lewat tmux)
- **Pelaksanaan:** host standalone lepas dari tmux sejak 2026-11-17 (fase 5 langkah 6): kode tmux dicabut,
  ADR-B tidak berlaku lagi untuk host. Desktop masih in-process / daemon opt-in (fase 6).
- **Terkait:** `plans/session-daemon/PLAN.md`, `apps/desktop/src-tauri/src/pty.rs`, `packages/host/src/server/pty/`

## Konteks

Desktop memiliki PTY di dalam proses Tauri, jadi quit/update/crash membunuh semua agent. Host VPS
memakai tmux untuk durabilitas, dengan harga: polling output 100ms, `pipe-pane` yang toggle dan bukan
layar, input lewat `send-keys -H`, dependensi tmux di setiap VPS. Dua mesin sesi untuk satu konsep.

## Keputusan

1. Satu daemon Rust, `lotus-sessiond`, memiliki semua PTY di macOS, Linux, dan Windows.
2. App desktop dan host VPS adalah **klien** lewat Unix socket (macOS/Linux) atau named pipe (Windows),
   hanya untuk user yang sama.
3. Daemon memegang layar (vt100) + ring + log append-only per sesi; `attach` mengirim snapshot layar
   lalu byte sejak `from_seq`, lalu live.
4. Quit Lotus saat ada agent jalan **menanyakan** "Biarkan jalan" / "Hentikan semua", dengan opsi
   "ingat pilihan". Tanpa agent jalan, quit langsung. (Diputuskan Alwi 2026-11-15; agent yang tetap
   jalan memakai kuota dan mengubah file, jadi tidak boleh terjadi diam-diam.) Logout/shutdown/update
   tidak bisa bertanya → pakai pilihan yang diingat, tanpa pilihan = "Hentikan semua" (Alwi 2026-11-17).

## Konsekuensi

- tmux dan `node-pty` hilang dari host; desktop dapat durabilitas yang sama dengan VPS.
- PTY selalu dibuka di Rust (`portable_pty`). Host TS tetap tanpa modul native, jadi ADR-F (satu
  berkas) tetap berlaku: biner daemon di-embed ke `lotus-remote-bin` dan diekstrak saat start;
  cadangannya artefak dua berkas, **bukan** kembali ke `node-pty`.
- Reboot mesin tetap membunuh agent, seperti dengan tmux. Yang selamat hanya log sesi + `--resume`.
- Kita kini memiliki kode durabilitas yang dulu "gratis" dari tmux. Daemon crash = semua sesi hilang,
  jadi daemon dijaga kecil (tanpa logika agent).
- Binary kedua yang harus di-sign, di-notarize, dan di-upgrade dengan handshake versi protokol.

## Kapan keputusan ini salah

Kalau spike fase 2 menunjukkan macOS TCC memperlakukan agent di bawah daemon sebagai proses asing
(prompt izin baru), atau Windows tidak bisa melepas daemon dari Job app secara andal, maka cakupan
dipersempit ke host VPS saja dan desktop tetap in-process.
