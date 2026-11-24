# 0050 — Canvas Frames: satu konsep, keanggotaan logis, bukan `parentId`

- **Status:** Accepted (desain; belum diimplementasi)
- **Date:** 2026-10-06
- **Deciders:** Alwi
- **Terkait:** `plans/codecanvas-frames/AUDIT.md`, `plans/codecanvas-frames/DECISIONS.md`,
  `plans/codecanvas-grouping/plan.md` (group lama), mockup `mockups/lotus-canvas.pen` (Spaces).

## Keputusan

CodeCanvas punya **satu** konsep pengelompokan: **Frame** — area bernama yang terlihat, berisi node
jenis apa pun. Frame **menggantikan** group lama (Cmd+G, hanya shape, tanpa nama) dan ide "Space" di
mockup. Frame adalah node sendiri yang digambar di belakang isinya; keanggotaan disimpan sebagai
penanda di tiap node anggota (satu node maksimal satu Frame, tidak bertingkat). ReactFlow
`parentId` / sub-flow **tidak** dipakai. Data lama dimigrasi saat load: group terluar → Frame tanpa
nama, diagram frame agent → Frame asli berjudul label diagram.

## Kenapa

- Dua model (Group + Space) membingungkan user: mockup menaruh "Group ⌘G" dan "New space ⌥N"
  berdampingan tanpa beda yang jelas.
- `parentId` membuat posisi anak relatif ke induk: tiap masuk/keluar Frame harus menghitung ulang
  koordinat, dan tidy layout, snapping, serialize, dan alat MCP semuanya membaca posisi absolut. Run
  Node dan grouping lama sudah memakai keanggotaan logis dengan posisi absolut, dan
  `groupDragChanges` sudah bisa menggeser anggota jenis apa pun.
- Tanpa nesting, drag, tidy, dan alat agent tetap sederhana.

## Alternatif yang ditolak

- **Dua konsep** (Group ringan + Space bernama): lebih kuat, tapi user harus belajar dua hal.
- **Space dengan mode pudar** (hanya Space aktif yang terang): membuat Space setengah filter,
  setengah tempat, dan bentrok dengan focus mode yang sudah ada. Gantinya: semua Frame selalu
  terlihat, berpindah = kamera terbang.
- **ReactFlow `parentId`**: lihat alasan di atas.

## Konsekuensi

- Field keanggotaan harus ada di **semua** jenis record node (bukan hanya shape), plus
  serialize/codec/factory, undo, tidy, snapping, dan readback MCP.
- Bug reload (angle + tanda diagram hilang) dan bug duplicate harus diperbaiki **sebelum** Frame,
  karena migrasi diagram frame bergantung pada tanda diagram yang bertahan setelah reload.
