# 0069 — Lampiran chat di mesin lain adalah salinan di folder data host

- **Status:** Accepted (2026-11-23)
- **Deciders:** Alwi
- **Terkait:** `plans/chat-remote-host/PARITY-RESEARCH.md` (bagian 5), ADR untuk Chat di VPS (Opsi B)

Di chat lokal, file yang di-drop dikirim dengan path aslinya, jadi agent mengubah file milik user.
Untuk chat di mesin lain (Lotus Host di VPS), file dari Mac **diunggah sebagai salinan** ke folder data
host (`<state dir host>/chat-attachments/<thread>/`, nama = sha256), bukan ke folder project. Agent
hanya melihat path di VPS dan nama asli file; path Mac tidak pernah dikirim. Pengecualian: file yang
sudah ada di mesin itu (dipilih dari tab Files) dikirim dengan path-nya, tanpa unggah.

Alasan: agent di VPS tidak bisa membuka path Mac; menyimpan di folder project membuat `git status`
kotor dan bisa ikut ter-commit. Harga yang dibayar: perubahan agent pada file lampiran tidak kembali ke
Mac. Composer menandai lampiran seperti itu dengan "salinan" supaya ini tidak mengejutkan.
