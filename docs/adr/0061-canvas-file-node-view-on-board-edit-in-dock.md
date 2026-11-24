# 0061 — File di canvas: dilihat di board, diedit di Dock, tanpa Monaco di dalam viewport

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** Alwi
- **Terkait:** ADR-0060 (Canvas Dock), ADR-0003 (canvas terminal memakai runtime CodeSpace),
  ADR-0025 (shared kernel tanpa pemilik), `plans/canvas-code/PLAN.md` (S0 result, LOT2-227)

## Konteks

User ingin kode berada di sebelah agen yang mengerjakannya. Dua opsi:

- **A:** File Node read-only di board (Shiki), edit di Code (Dock app).
- **B:** Monaco yang bisa diedit langsung di dalam node.

S0 mengukur Monaco 0.55.1 di dalam pane ber-`transform: scale(z)` pada zoom 0.6 / 1 / 1.5
(hasil lengkap di `plans/canvas-code/PLAN.md`, "S0 result"). Input (klik, drag, ketik, caret) akurat
dalam satu kolom di Chromium. Yang gagal adalah widget overflow:

- suggest dan hover hidup di dalam DOM editor, jadi `overflow: hidden` node memotongnya di semua zoom,
  termasuk 1;
- penempatan hover (atas/bawah) dihitung dalam px tanpa skala, sehingga pada 1.5 kotaknya melayang
  28 px dari glyph dan bisa hilang sepenuhnya;
- `fixedOverflowWidgets: true` memperburuk: `position: fixed` di bawah ancestor yang di-transform
  relatif terhadap ancestor itu, jadi offset tumbuh dengan zoom (+17 px di 0.6, +85 px di 1.5);
- semua angka itu dari Chromium Playwright, bukan WKWebView aplikasi.

## Keputusan

1. **Opsi A.** File Node hanya melihat: highlight Shiki, tanda git, update live. Editing terjadi di
   Code (Dock app) pada skala 100%, di luar transform viewport. Tidak ada Monaco di dalam viewport
   ReactFlow.
2. **Jalur pulang dua arah.** File Node → Code lewat ⏎ (hotkey canvas `dive-into-node`) atau tombol
   Edit (`openInCode`). Code → board lewat "Show on board", yang menutup Dock, membuat node bila belum
   ada, lalu memfokuskannya.
3. **Satu sumber kebenaran sesi.** Code memakai `useWorkbenchSession` yang sama dengan Workbench
   CodeSpace, sehingga buffer, dirty state, dan banner konflik tidak punya salinan kedua.
4. **Wire File → agen adalah wire `context`.** Agen menerima path, bukan isi file; ia membaca disk
   sendiri. Disk adalah titik temu dengan agen, dan banner konflik adalah merge-nya.

## Konsekuensi

- Satu hop (File Node → Code) untuk mengedit. Diterima: itu harga dari tidak adanya widget yang
  terpotong atau meleset.
- Opsi B hanya dibuka lagi jika S0 terulang di WKWebView tanpa drift **dan** hop itu terbukti terlalu
  lambat. Syaratnya: `overflowWidgetsDomNode` di luar viewport dengan koordinat yang di-counter-transform
  sendiri, tanpa `overflow: hidden` pada node.
- Node `file` tidak pernah menyimpan isi file, sehingga snapshot canvas tidak membengkak dan tidak
  menyimpan rahasia di disk lewat jalur baru.
