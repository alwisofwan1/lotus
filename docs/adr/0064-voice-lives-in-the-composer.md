# 0064 — Suara tinggal di composer

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Alwi
- **Memperluas:** ADR-0034 — dikte yang ditahan menunggu di prompt agent itu sendiri, sekarang juga di
  Code. ADR-0053 tetap berlaku; ini menambah aturan di atas Voice Adapter.
- **Terkait:** `plans/composer-voice-ux/AUDIT.md`

## Keputusan

Suara tidak punya permukaan sendiri. Push-to-Talk berarti persis "ketik teks ini lalu tekan Enter di
composer ini", di setiap mode. Live Voice adalah keadaan composer, bukan panel atau halaman: tombolnya
ada di composer, selama aktif **Composer Target** berganti ke "→ Lotus", dan percakapannya tampil di
strip yang menempel pada composer. Polanya sama dengan ⌘K, yang juga mengambil alih field lalu
mengembalikannya.

Ucapan yang menjadi perintah untuk Lotus langsung dijalankan. Ucapan yang menjadi pesan untuk agent
menjadi **Held Prompt**: teksnya muncul, belum terkirim, **di prompt agent itu sendiri** — Agent Node di
Canvas, pane terminal atau thread di Code — kecuali **Send Right Away** menyala atau giliran itu
diakhiri dengan ⌘Enter. Fokus keyboard tetap di composer: selama ada Held Prompt, Enter di composer
yang kosong mengirimnya dan Escape menghapusnya; untuk mengedit, klik ke pane. `dictateAutoSubmit`
(Canvas) dan `sendRightAway` (Code) dilebur menjadi satu setting Send Right Away di Settings › Voice,
default off.

Teks tetap menunggu **di composer** dalam tiga kasus: composer sudah berisi teks yang diketik (dikte
melanjutkan pesan itu, tidak dipecah ke dua tempat); fokus berpindah selama giliran (target Push-to-Talk
dikunci saat mic dibuka, dan Enter di composer akan ambigu); atau target tidak bisa menerima teks yang
belum terkirim (agent headless, terminal tanpa sesi, thread yang belum siap). Selalu dengan alasannya.

## Kenapa

Sebelumnya ikon mic yang sama berarti tiga hal (perintah atau dikte di Canvas, hanya teks di Code,
tidak ada di Chat), Live Voice hanya bisa dicapai lewat ⌘⇧L, dan dikte yang ditahan menunggu di dua
tempat berbeda dengan dua saklar berbeda. Satu aturan, "bicara = ketik + Enter", membuat mic tidak
butuh arti per mode; yang perlu terlihat hanya ke mana Enter pergi, dan itu tugas Composer Target.

## Opsi yang ditolak

- **Live Voice sebagai panel/fitur terpisah.** Kotak kedua yang juga menerima bahasa, dengan konteks
  fokusnya sendiri; prinsip yang sama yang membuat ⌘K tinggal di composer.
- **Dikte selalu ditahan di composer** (keputusan awal grilling ini, dibalik hari yang sama). Satu
  tempat untuk Undo dan alasan, tapi hasil dikte tidak terlihat di agent yang dituju; Alwi memilih
  teks muncul langsung di Agent Node/pane supaya terasa seamless.
- **Langsung terkirim dengan jeda batal ~2 detik.** Paling sedikit langkah, tapi salah dengar menjadi
  kerja agent yang mahal, dan teks di PTY tidak bisa ditarik setelah jeda.
- **Ikuti fokus terbaru saat deliver** (perilaku Code sebelumnya). Klik pane lain sambil bicara
  mengirim kalimat ke agent yang salah.

## Konsekuensi

- Live Voice di Code (v1) tidak punya tool `close`/`close_all`: menutup pane mematikan sesi PTY, dan
  "spoken close runs as said" diputuskan untuk node Canvas.
- `CanvasNlCommandBar` dan `UnifiedComposer` tetap dua komponen; yang dibagi hanya bagian suara
  (baris listening, waveform, Composer Target, tombol Live Voice, strip). Peleburan penuh adalah
  pekerjaan terpisah.
- Chat mode menyusul lewat Chat Voice Adapter. Di sana composer adalah input thread itu sendiri, jadi
  teks sudah "di agent" tanpa aturan tambahan.
- Thread composer registry (`codechat/state/thread-composer-registry.tsx`) butuh `insert` di samping
  `send`. Pane terminal cukup menulis teks tanpa `\r` (penulisan teks dan Enter sudah terpisah).
- Undo untuk cleanup AI hanya ada saat teks menunggu di composer. Teks di prompt TUI tidak bisa
  disunting ulang dengan andal (Ctrl-U berbeda tiap CLI), jadi di sana catatannya hanya "Cleaned up by
  AI".
