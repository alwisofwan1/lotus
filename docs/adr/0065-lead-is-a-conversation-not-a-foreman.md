# 0065 — Lead adalah lawan bicara, bukan foreman

- **Status:** Accepted
- **Date:** 2026-11-06
- **Deciders:** Alwi
- **Memperkuat:** ADR-0051 §5 dan ADR-0056 — aksi engine tetap milik aturan di kode dan klik
  pengguna, bukan milik agen LLM yang hidup lama.
- **Terkait:** `plans/lead-orchestrator/RESEARCH.md` (§7 opsi A, §11), `plans/lead-orchestrator/PLAN.md`

## Konteks

Alwi ingin satu agen utama ala "Katana": cukup brainstorming dengan satu agen, lalu agen itu yang
membagi kerja ke Claude Code, Codex, Factory Run, Automation, browser dan computer use, memantau, dan
melapor balik. Sekitar 70% mesinnya sudah ada di Lotus (delegate, fleet, task, Factory Run, Voice Core,
browser node, Automation, Pocket/Telegram, Notes). Yang kurang adalah satu wajah. ADR-0051/0056 menolak
agen LLM foreman yang hidup lama karena mahal, sulit dites, dan menyimpan state di sesi.

## Keputusan

1. **Lead adalah satu Chat thread dengan peran `lead`.** Pengguna memilih **Runs on** (Claude atau
   Codex), **Model** dan **Effort** di Settings › Lead (ditambahkan 2026-11-06, meniru Katana). Default
   Claude. Model dan effort berlaku langsung (giliran berikutnya); ganti runner memulai percakapan Lead
   baru, karena runner sebuah thread tetap seumur hidupnya. Runner mana pun bisa mendelegasikan ke
   keduanya lewat `lotus_chat_delegate`.
2. **Satu Lead global**, lintas workspace. Selalu tersemat di rail. Hanya ada satu thread berperan
   `lead` yang aktif; membuat Lead baru saat sudah ada membuka yang lama. Lead lama setelah ganti
   runner pindah ke Archived.
3. **Nama yang terlihat dan diucapkan: "Lotus".** Live Voice sudah memakai Composer Target "→ Lotus"
   (ADR-0064), jadi pengguna sudah berbicara kepada Lotus; Lead hanya memberinya ingatan dan tangan.
   "Lead" tetap istilah internal (kode, GLOSSARY).
4. **Lead hanya memakai tool Lotus yang sudah ada** (delegate/wait/stop, task, fleet, Factory Run,
   Automation, browser, Notes). Lead tidak mendapat jalur khusus ke engine.
5. **Aksi berisiko tetap butuh konfirmasi pengguna**: merge, menghapus chat/task/cell, Abort atau Raise
   cap Factory Run, mengirim ke luar (Slack, Notion, PR comment), dan menutup banyak agen sekaligus. Lead
   mengusulkan dan menunggu jawaban "ya" di thread, kecuali tool itu sendiri sudah memintanya lewat UI.
6. **State tidak tinggal di sesi Lead.** Gambaran kerja dibangun ulang dari store Lotus (chat, task,
   fleet, run) di setiap giliran. Sesi Lead boleh mati atau di-reset tanpa kehilangan apa pun yang
   penting.
7. **Halaman rencana live adalah Lotus Note** yang ditulis Lead (fase 3), bukan HTML bebas.
8. **Urutan:** monitoring dulu (fase 1–3), suara (fase 4), Codex app-server (fase 5), computer use
   desktop terakhir (fase 6). Sampai fase 6, browser node sudah cukup.

## Alternatif yang ditolak

- **Lead otonom penuh (opsi B)**: paling "effortless", tetapi membalik ADR-0051/0056; aksi berisiko
  (uang, merge, hapus) tanpa klik tidak bisa diulang dan tidak bisa dites.
- **Lead per workspace atau per hari**: memecah satu wajah menjadi banyak; Alwi ingin satu tempat.
- **Halaman rencana HTML bebas**: lebih mirip Katana, tetapi butuh renderer dan watcher baru, sementara
  Notes sudah ada dan bisa dibaca dari Pocket.
- **Lead terkunci di Claude**: ditolak 2026-11-06; Alwi ingin bisa memindahkan Lead ke Codex seperti Katana.
- **Nama persona baru (mis. Seroja, Padma)**: lebih berkarakter, tetapi menambah nama kedua untuk hal yang sama dengan "→ Lotus" di Live Voice.

## Konsekuensi

- `ThreadRecord` butuh field `role`; bridge menambahkan catatan sistem khusus Lead.
- Biaya Lead sebanding dengan jumlah giliran, bukan durasi; ringkasan proaktif (fase 2) dibuat oleh
  aturan tetap, LLM hanya dipanggil saat ada event baru.
- Konfirmasi aksi berisiko di fase 1 dijaga oleh prompt, bukan kode. Ini lubang yang disadari: tool yang
  menghapus atau mengirim keluar tetap harus punya penjaga sendiri.
