# 0060 — Canvas Dock: Automation, Factory dan Tasks dibuka di dalam canvas, chrome tetap sepi

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Alwi
- **Mencabut sebagian:** `plans/unified-workspace-shell/PLAN.md:273,342` ("CodeCanvas tidak berubah sama
  sekali"), **hanya untuk chrome canvas**: control cluster, panel Dock, dan corner controls. Perilaku
  graph (node, wire, frame, drag, zoom) tetap di luar keputusan ini.
- **Terkait:** ADR-0038 (Automation module-neutral), ADR-0049/0051 (Factory, brainstorm di canvas
  terminal), ADR-0054 (satu Settings modal), `plans/canvas-dock/PLAN.md`
- **Desain:** `mockups/lotus-canvas.pen`, frame "15 · Canvas Dock (option 1)"

## Konteks

Automation, Factory dan Tasks hanya hidup di shell Code/Chat (`WorkspaceShellPage.tsx`: `tasksNav` +
`columnOverlay`). Dari canvas:

- Automation tidak punya UI sama sekali; hanya MCP dari terminal. Notifikasi Ask memanggil
  `router.push("/")` (`AppShell.tsx:155`) dan membawa user keluar canvas.
- Factory hanya punya node read-only; double-click juga `router.push("/")` (`FactoryNode.tsx:31-34`).
- Task node canvas tidak pernah tertaut ke `BridgeTask`; Delegate hanya membuka pane Code.

Aturan "CodeCanvas tidak berubah" dibuat saat shell Code/Chat disatukan, supaya pekerjaan shell tidak
merusak canvas. Aturan itu sekarang memaksa user meninggalkan canvas untuk setiap keputusan kecil
(approve spec, jawab Ask, kirim draft), padahal canvas adalah tempat agennya bekerja.

Sisi lain: canvas harus tetap bersih. Layar sudah memuat Tool Rail, command bar, dan corner controls;
menambah sidebar atau widget permanen membuatnya ramai. Opsi sidebar kiri sudah ditolak.

## Keputusan

1. **Tanpa sidebar baru.** Tiga App Button (Automation, Factory, Tasks) masuk ke `CanvasControlCluster`,
   grup baru di antara Frames dan Fleet/Settings. Tile 28px yang sama dengan kontrol lain, sehingga
   tampil di command bar maupun Top Bar tanpa kode kedua. Badge violet (`needs-you`) hanya muncul bila
   ada yang menunggu.
2. **Satu Dock panel, di kanan, menggantikan Fleet.** Panel melayang 400px (⌘\ melebar ke 640px),
   screen-fixed (tidak ikut pan/zoom), satu surface sekaligus. Membuka Dock menutup Fleet dan
   sebaliknya. Esc menutup dan mengembalikan fokus ke canvas.
3. **Panel, bukan node, untuk fitur utuh.** Daftar runs/automations/tasks selalu di panel. Node hanya
   untuk satu item kerja (satu Factory run, satu task tertaut) dan double-click node membuka panel pada
   item itu.
4. **Canvas tidak pernah pindah ke Home** karena node, notifikasi Ask, atau verb ⌘K. Hanya tanda Lotus
   (dan ⌘2/⌘3) yang mengganti mode.
5. **Pakai surface modul, bukan salinan.** Dock memasang `AutomationPanel`, `FactorySurface` /
   `FactoryRunDetailPane`, dan daftar Tasks lewat index publik masing-masing modul. Kode canvas baru
   berada di `CanvasDock`, tidak ditambahkan ke `CanvasPage.tsx`.
6. **Corner controls tersembunyi secara default.** Bar zoom/memory/sessions di kanan bawah
   (`CanvasCornerControlBar`) diam di `opacity: 0` dan `pointer-events: none` (sekarang 0.62). Ia
   muncul bila:
   - pointer masuk **hot zone** pojok kanan bawah (sekitar 280×96px dari tepi);
   - viewport **zoom** berubah (tombol, ⌘+/⌘−/⌘0, pinch, scroll-zoom): bar tampil, persentase disorot,
     lalu memudar 1.6 s setelah perubahan terakhir;
   - fokus keyboard masuk ke bar (`:focus-within`), atau popover Memory/Sessions terbuka — tetap
     tampil selama itu.

   Pan saja tidak memunculkannya. Lebar bar tetap dipublikasikan (`--canvas-corner-bar-w`) dan ruang
   command bar tetap dicadangkan, supaya command bar tidak bergeser saat bar muncul. Reduced motion:
   muncul/hilang tanpa transisi.

## Konsekuensi

- Approve spec, jawab Ask, kirim draft, dan update status task bisa dilakukan tanpa meninggalkan
  canvas. Keputusan 4 menghapus dua `router.push("/")`.
- Dua surface satu modul bisa ter-mount bersamaan (shell yang diparkir + Dock). Keduanya wajib memakai
  hook bersama modul (`useSharedFactoryRuns`, change feed automation), bukan poller sendiri.
- Tracker board Tasks harus diangkat ke provider bersama, dan `TasksSurface.tsx` dipecah menjadi
  bagian netral host dan glue shell.
- Corner controls tidak lagi terlihat sebagai pengingat bahwa zoom ada. Diterima: zoom tetap tercapai
  lewat keyboard, pinch, dan scroll; begitu dipakai, bar muncul. Mouse yang menuju pojok juga
  memunculkannya.
- Menggantikan Fleet berarti Fleet dan Dock tidak bisa terbuka bersamaan. Needs-you tetap satu daftar
  (⌘J) yang mencakup agen, Factory, Automation dan Tasks.

## Alternatif yang ditolak

- **Sidebar kiri dengan App Rail + panel kiri.** Menambah chrome permanen dan bertabrakan dengan Tool
  Rail; ditolak user.
- **Semua fitur sebagai node besar.** Daftar tidak terbaca saat zoom kecil, menutupi pekerjaan lain,
  dan memenuhi canvas.
- **Corner controls di opacity rendah permanen (status sekarang, 0.62).** Tetap terlihat sebagai
  widget di setiap layar; tidak memenuhi tujuan canvas yang bersih.

## Amandemen 2026-10-16 — satu tombol Dock, app di dalam Dock

Mengganti keputusan 1 dan 2. Desain: `mockups/lotus-canvas.pen` section "16 v2" dan "17".

1. **Satu tombol Dock** di `CanvasControlCluster`, menggantikan tiga App Button dan tombol Fleet.
   Badge = jumlah semua yang menunggu; tooltip menyebut per app. **⌘B** membuka/menutup (bebas di
   `/canvas`; di dalam editor teks ⌘B tetap Bold). Fitur baru menambah item rail, bukan tombol bar.
2. **Dock punya App Rail sendiri** (Automation, Factory, Tasks, Connectors, Fleet, ⋯ More), di
   **tepi luar kanan** — cermin dari Tool Rail di kiri. Close di atas rail. Hanya layout yang dicermin;
   teks tetap kiri-ke-kanan.
3. **Lebar:** 452 (kolom 400 + rail), detail menutupi list; ⌘\ melebar ke 852 ke arah canvas:
   detail | list | rail. Rail tidak pernah bergeser. Tidak pernah layar penuh; pekerjaan berat tetap di
   Code/Chat.
4. **Fleet menjadi app di Dock.** Aturan "membuka Dock menutup Fleet" tidak berlaku lagi.

Ditolak: layout tiga kolom Slack dengan detail di tengah layar (mengambil tempat canvas), dan Dock di
kiri (bertabrakan dengan Tool Rail).
