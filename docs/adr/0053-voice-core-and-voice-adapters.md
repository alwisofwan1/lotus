# 0053 — Voice Core + Voice Adapter: satu mesin suara untuk semua mode

- **Status:** Accepted (sedang diimplementasi; kerangka Voice Core + Tauri Voice Port sejak Lotus #173)
- **Date:** 2026-10-08
- **Deciders:** Alwi
- **Menggantikan sebagian:** baris "Realtime di luar scope" di ADR-0028/ADR-0031 — Live Voice sudah
  dikirim di CodeCanvas.
- **Terkait:** `plans/voice-*` (ditandai digantikan oleh plan refactor voice core).

## Keputusan

Suara dipisah jadi **Voice Core** (`apps/desktop/src/modules/voice-core/`) dan satu **Voice Adapter** per
mode (canvas, code, lalu chat). Voice Core memegang mic, STT, TTS, sesi Live Voice, **Speaker Queue**,
dan barge-in, dan **tidak pernah** meng-import `codecanvas`, `codespace`, `codechat`, atau
`workspace-shell`; mode yang bergantung pada core, tidak sebaliknya. Aturan ini dijaga test otomatis.
Voice Adapter menjawab tiga hal saja: ke mana prompt dikirim, target apa yang ada, tool apa yang boleh.

Suara yang keluar hanya lewat satu **Speaker Queue** berprioritas (Live Voice > balasan perintah >
Agent-Done Callout > narasi), menggantikan speaker "latest wins". Saat Live Voice aktif, suara lain
berhenti — supaya TTS tidak bocor ke mic Live Voice dan terbaca sebagai giliran user.

Aturan antrean (sejak Lotus #176, `voice-core/speaker-queue.ts`): satu kalimat diputar sampai
selesai; prioritas yang lebih tinggi hanya menyalip antrean, tidak memotong kalimat yang sedang
diputar. Live Voice bukan antrean, tapi `hold()`/`release()`: saat mulai, kalimat yang diputar
langsung dihentikan dan semua suara lain diam; callout disimpan, balasan dan narasi dibuang (sudah
basi). Saat selesai, callout yang tersimpan diputar sebagai satu kalimat — kalimat aslinya bila
hanya satu, ringkasan nama bila ≤3 agen, jumlah bila lebih atau ada callout tanpa nama. Barge-in
(`stop`) hanya menghentikan balasan; "Stop All Speech" di ⌘K menghentikan semuanya. Satu antrean per
Tauri Voice Port, dipakai bersama semua pemakai `useVoiceFeedback` (canvas dan pratinjau Settings).

Satu giliran Push-to-Talk dijalankan oleh satu reducer murni (sejak Lotus #177,
`voice-core/push-to-talk-session.ts`): mic dibuka → merekam → transkripsi → kirim → diam. Hanya satu
giliran pada satu waktu: Enter yang ditekan dua kali cepat hanya jalan sekali. Rekaman baru
membatalkan giliran lama yang masih transkripsi atau kirim; hasil lamanya tidak pernah dipakai. Escape
membatalkan giliran yang masih hidup. Giliran yang kirimnya lewat 90 detik dihentikan lewat signal
dan dilaporkan. Tiap giliran punya `AbortSignal`, jadi panggilan model dan
rewrite catatan ikut berhenti, dan tiap cabang async memeriksa `isCurrent()` sebelum menerapkan hasil.
Error saat kirim ditangkap dan ditampilkan, tidak pernah lolos.

Sesi Live Voice juga satu reducer murni (sejak Lotus #179, `voice-core/s2s-session.ts`). Bila koneksi putus tanpa diminta, sesi masuk fase `reconnecting`: mic berhenti, lalu satu kali sambung ulang diam-diam (setelah jeda 1 detik) dengan instruksi dan tool yang sama. Error baca socket (jaringan
putus) juga dihitung putus, bukan error. Putus lagi dalam 15 detik setelah sambung ulang dihitung gagal
kedua. Suara dari jeda itu dibuang, tidak pernah dikirim. Event dari socket lama diabaikan lewat nomor generasi. Gagal kedua kali → error dengan alasannya dan tombol Retry. Update konteks (tool dan instruksi) ditunda 400 ms dan hanya dikirim bila nilainya berubah. Status "Live Voice aktif" dibagi lewat React context (`voice-core/live-voice-status.tsx`), bukan flag global; `useHoldSpeechWhileLive` menyambungkannya ke `hold()`/`release()` Speaker Queue.

Perintah tutup lewat suara dijalankan persis seperti yang diucapkan, tanpa konfirmasi, di semua mode
(Live Voice dan Push-to-Talk): "tutup Atlas" menutup satu node, "tutup semua agen" menutup semua agen,
"tutup semua" mengosongkan canvas. Hanya command bar yang diketik yang tetap meminta konfirmasi
sebelum menutup semua.

*Revisi 2026-10-09:* versi awal ADR ini melarang suara menutup lebih dari satu node (Lotus #171).
Dalam pemakaian, batas itu terasa aneh — user harus menutup agen satu per satu. Alwi memutuskan suara
mengikuti perintah apa adanya.

*Pengaman sementara:* selama dikte Push-to-Talk masih bisa memotong ucapan, Push-to-Talk tetap meminta
konfirmasi sebelum menutup lebih dari satu node atau semua node ("tutup semua agen kecuali Atlas"
bisa terbaca "tutup semua agen"). Live Voice tidak memakai jalur dikte itu, jadi langsung jalan.
Konfirmasi ini dicabut setelah dikte terpotong diperbaiki.

## Kenapa

Sebelumnya semua controller suara terikat ke canvas (`@xyflow/react`, NL stack canvas,
`agentStatusRegistry`, state global `live-voice-activity`), jadi mode Code dan Chat tidak bisa memakai
suara tanpa menyalin kode. Bagian bawah (STT/TTS/sesi S2S, backend Rust) sudah bebas canvas; yang
kurang adalah seam yang jelas di atasnya.

## Opsi yang ditolak

- **Salin voice per mode** — tiga salinan state machine yang sudah sulit dijaga.
- **Konfirmasi suara untuk `close_all`** — menambah satu giliran bicara untuk perintah yang sudah jelas.
- **Batas satu node per giliran suara** (dikirim di #171, lalu dicabut) — aman, tapi user merasa
  suara tidak mengikuti perintahnya.
- **Tulis ulang sekaligus** — migrasi bertahap: tiap bagian pindah ke core dan canvas langsung
  memakainya, canvas tetap jalan di setiap langkah.

## Konsekuensi

- Live Voice di v1 hanya di canvas; Code dapat Push-to-Talk (teks masuk composer, opsi "kirim
  langsung"); Chat masuk plan berikutnya. Hotkey Push-to-Talk dan Live Voice milik seluruh aplikasi.
- Setting suara pindah ke tab **Voice** di Settings aplikasi (migrasi otomatis dari key
  `canvas-voice-*`); yang khusus canvas tetap di canvas.
