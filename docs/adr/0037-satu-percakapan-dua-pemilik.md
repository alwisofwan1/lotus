# 0037 — Satu percakapan, dua pemilik

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Alwi
- **Konteks plan:** `plans/unified-workspace-shell/PLAN.md` §3, bukti di `VERIFICATION.md`

## Konteks

Shell terpadu di `/` menampilkan CodeSpace dan CodeChat sekaligus: mode **Code** berisi grid pane,
mode **Chat** berisi percakapan — dan sebuah percakapan kini juga bisa menjadi **pane** di dalam
Code. Artinya satu thread yang sama dapat tampil di dua tempat pada saat yang sama, di satu window.

Sebelum ini tiap permukaan berdiri sendiri, jadi pertanyaan "siapa yang memiliki percakapan" tidak
pernah perlu dijawab. `useCodeChatSessions` menyimpan state di `useReducer` dan menulis ke
repository, sehingga **setiap pemanggil mendapat salinannya sendiri**; dua mount akan menyimpang
pada suntingan pertama dan yang terakhir mem-persist yang menang. Daftar anotasi punya masalah yang
sama, satu tingkat lebih dalam: ia `useState` di dalam `CodeChatPage`.

Menyalin `ChatView` untuk dipakai di pane pernah dipertimbangkan dan ditolak sejak awal: model
picker, lampiran, prefiks konteks, checkpoint runtime dan pembatalan stream semuanya hidup di
dalamnya. Dua salinan berarti dua tempat yang harus dijaga tetap sama, selamanya.

## Keputusan

### 1. Satu implementasi, tiga permukaan

`ChatView` adalah satu-satunya percakapan. Route `/codechat`, mode Chat di shell, dan pane chat di
Code me-mount komponen yang sama — bukan tiruan dan bukan tampilan read-only.

### 2. Satu pemilik per pohon, untuk state yang dibagi

`CodeChatSessionsProvider` dan `CodeChatAnnotationsProvider` menerapkan aturan yang sama: satu store
per pohon, **provider bersarang menunda ke yang di atasnya**, dan konsumen tanpa provider mendapat
**error keras** alih-alih diam-diam membuat salinan.

Menunda, bukan melarang bersarang: tiap permukaan tetap harus bisa di-mount sendirian sebagai
route-nya sendiri, sementara shell yang meng-host keduanya tidak boleh menghasilkan dua store.

### 3. Pane menyimpan referensi, bukan percakapan

`CodeSpaceStoredPane.sessionId` adalah satu-satunya yang ditulis snapshot workspace. Pesan tetap
milik store CodeChat (SQLite). Konsekuensinya sengaja: snapshot tidak pernah memegang salinan thread
yang basi, dan menghapus snapshot tidak pernah menghapus percakapan siapa pun.

Kompatibel dua arah tanpa bump skema — field yang hilang dibaca sebagai `None`, dan build lama yang
belum kenal tipe pane `"chat"` membawanya apa adanya alih-alih membuangnya.

### 4. Pemuatan pesan mengikuti yang MENAMPILKAN, bukan yang aktif

Pesan dimuat malas. Semula hanya untuk sesi **aktif**, yang benar selama satu percakapan hanya
tampil ketika ia aktif. Pane melanggar asumsi itu: ia menampilkan percakapan tanpa mengaktifkannya.

Aturannya sekarang: permukaan yang menampilkan sesi **meminta pesannya sendiri**
(`ensureSessionMessages`) dan tidak menanam percakapan sampai pesannya ada. Pengisiannya lewat aksi
`load-messages` — pengisian hasil baca, bukan suntingan: tidak menurunkan judul, tidak menyentuh
checkpoint, tidak pernah menimpa pesan yang sudah dipegang, dan **tidak memindahkan sesi aktif**
(itu sebabnya ia bukan `remember`).

### 5. Mode yang tidak tampil tetap hidup

Code selalu ter-mount karena ia memiliki sesi PTY-nya. Chat dibangun **malas** — tidak pernah dibuka
berarti berbiaya nol — lalu **tinggal**. Alasannya bukan kecepatan melainkan kebenaran: `ChatView`
memanggil `stop()` di cleanup unmount, jadi mode yang dibongkar saat berpindah **membatalkan balasan
yang sedang mengalir**.

### 6. Pane hanya dilepas saat kotaknya benar-benar hilang

Memberi tahu pane bahwa ia tidak terlihat **melepasnya dari pool renderer** — slot diparkir, konteks
GPU dikembalikan — sehingga menampilkannya lagi berarti memasang ulang: re-parent DOM, pasang ulang
ResizeObserver, fit, promosikan lagi renderernya.

Jadi "tidak terlihat" hanya untuk kasus yang kotaknya memang lenyap: workspace lain (`display:none`)
dan pane yang disembunyikan focus mode. Mode yang sekadar tersembunyi bukan salah satunya — dan agar
itu sah, **kedua permukaan mode ditumpuk** dan yang tersembunyi disembunyikan dengan `opacity: 0`
(bukan `display:none` yang membongkar geometri, bukan pula `visibility:hidden` yang bisa dibatalkan
anak).

## Konsekuensi

**Terukur di window native, 2026-09-20** (detail dan cara mengulangnya di `VERIFICATION.md`):

| | sebelum | sesudah |
|---|---|---|
| switch mode, 2 terminal hidup + 2 thread (chat→code) | p50 192 ms / p95 213 | **p50 36 ms / p95 40** |
| switch mode, arah sebaliknya | p50 92 ms / p95 102 | **p50 30 ms / p95 41** |
| dua pane chat menjawab bersamaan | — | dua `run_id`, dua pid, urutan start/start/end/end |

- **Satu bug kehilangan data terjadi sebelum aturan §4 ada**, dan itu yang membuatnya jadi aturan:
  pane kedua mendapat seed kosong dari `messages: undefined` ("belum dibaca", yang terlihat persis
  seperti "tidak punya pesan"), lalu mem-persist kekosongan itu di atas baris yang asli. Percakapan
  yang hilang tidak bisa dikembalikan.
- **Permukaan tersembunyi tetap ikut layout dan tetap dikomposit.** Itu harga yang dibayar untuk
  §6 — biaya tetap yang kecil, ditukar dengan hilangnya hentakan ~150 ms tiap kali berpindah.
- **Pane chat tetap menahan sesi PTY tetangganya hidup**, karena Code tidak pernah dibongkar. Sudah
  begitu sejak §5 dan tidak berubah di sini.
- **Terbuka:** `ChatMode` belum punya panel kanan seperti Code; inspector percakapan baru ada
  sebagai mode kelima `CodeSpaceRightPanel`.
- **Terbuka:** route lama `/terminal` dan `/codechat` sengaja dibiarkan dengan chrome-nya sendiri.
  Menyatukan atau menghapusnya adalah keputusan tersendiri.

## Guard

Aturan di atas gagal dengan cara yang tidak terlihat — dua daftar yang berbeda diam-diam, sebuah
percakapan yang kembali kosong — jadi masing-masing dijaga tes, bukan konvensi:

- `state/__tests__/sessions-store-ownership.test.ts` dan `annotations-context.test.ts` — satu store
  per pohon, provider bersarang menunda, konsumen tanpa provider melempar.
- `components/__tests__/ChatCell.test.tsx` — pane meminta pesannya sendiri, tidak menanam percakapan
  sebelum pesannya ada, dan **bertanya lagi** begitu sesinya muncul (gerbang yang tidak pernah
  terbuka adalah cara kedua aturan ini gagal).
- `hooks/__tests__/useCodeChatSessions.test.tsx` — sesi non-aktif bisa dimuat sesuai permintaan,
  dua pane pada satu percakapan menghasilkan satu pembacaan, dan pengisian **tidak** memindahkan
  sesi aktif.
- `services/__tests__/pane-visibility.test.ts` — mode yang sekadar tersembunyi tidak melepas pane;
  workspace lain dan focus mode tetap melepas.
- `services/__tests__/shell-tokens.css.test.ts` — `.ws-surface` wajib `opacity: 0`, dilarang
  `visibility: hidden` (anak bisa membatalkannya — terminal pernah menembus ke mode Chat) dan
  dilarang `display: none` (membongkar layout — itu 192 ms-nya).
- `codespace_store.rs` — pane chat round-trip sebagai referensi, snapshot pra-chat tetap termuat,
  tipe pane yang tak dikenal dibawa, bukan ditolak.
