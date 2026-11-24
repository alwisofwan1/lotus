# 0046 — Note Node memakai tampilan kertas, bukan idiom kaca Terminal

- **Status:** Accepted
- **Date:** 2026-09-30
- **Deciders:** Alwi
- **Terkait:** ADR-0033 (bahasa visual Canvas Terminal — diganti **hanya untuk Note**), ADR-0014
  (note asset), ADR-0034 (voice selected-text transform), Lotus Task LOT2-67, mockup
  `mockups/lotus-canvas.pen` → board "07 · Note Node revamp".

## Konteks

Sejak ADR-0033 Note memakai idiom yang sama dengan Terminal dan Live Agent: header mono 2rem, badan
mono di atas lantai gelap turunan tema, aksen per tema (`palette.note`). Hasilnya note terlihat
seperti output terminal. Judulnya slug nama file (`plan · 3 items`), mode read/edit tersembunyi di
balik hover, dan checkbox kecil persegi. Note adalah satu-satunya node yang terutama **dibaca**, jadi
idiom konsol tidak cocok untuknya.

## Keputusan

1. Note menjadi **halaman kertas tetap**: token `--nv-*` (paper `#f7f4ec`, ink `#262b26`, sage
   `#7d9170`, forest `#34463a`, …) berasal dari referensi desain yang dipilih Alwi. Nilainya literal,
   **sama di semua tema**, gelap maupun terang. Aksen per tema tidak lagi mewarnai note.
2. Tipografi: judul **Source Serif 4** (self-hosted, `@fontsource-variable/source-serif-4`), badan dan
   UI **Inter**. Tidak ada font mono di note kecuali `code` inline.
3. Kertas dibuat dengan mengarahkan ulang token shell (`--node-glass-*`, `--node-accent`,
   `--node-scrim`) pada `.codecanvas-shell .canvas-note-node`, bukan dengan menyalin aturan shell.
   Aturan selected/focus di `node-shell.css` tetap berlaku, kini berwarna sage.
4. Kontrak drag tidak berubah: header tetap `canvas-node-header` (`NOTE_DRAG_HANDLE`), badan tetap
   `nodrag nowheel`.
5. Dua penyesuaian aksesibilitas terhadap referensi: abu-abu muted `#80857c` (3.4:1 di kertas) menjadi
   `#6b7067` (4.6:1), dan sage sebagai **teks** memakai `--nv-sage-ink` `#62745a` (4.6:1). Sage asli
   tetap dipakai untuk isian dan ikon.

## Konsekuensi

- Tema Artisan yang meng-override `palette.note` tidak lagi mengubah warna note. Itu disengaja.
- Cabang `[data-canvas-mode="light"]` untuk note dihapus: kertasnya tetap, jadi tidak ada yang perlu
  dikoreksi per mode.
- Di kanvas gelap note terlihat seperti kertas terang di atas meja gelap. Bayangannya lebih dalam
  daripada node kaca, supaya tepinya tetap terbaca.
- Popover yang di-mount di shell (slash menu) belum ikut token note; itu slice 10 LOT2-67.
