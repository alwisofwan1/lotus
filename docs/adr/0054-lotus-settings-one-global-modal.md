# 0054 — Lotus Settings: satu modal global dengan sidebar bergrup

- **Status:** Accepted (belum diimplementasi)
- **Date:** 2026-10-11
- **Deciders:** Alwi
- **Terkait:** ADR-0053 (Voice Core — setting suara mode-neutral), Lotus #174 / #180 (mockup dan tab Voice).

## Keputusan

Lotus punya **satu** tempat setting: **Lotus Settings**, sebuah modal yang bisa dibuka dari setiap mode
(⌘,). Halaman `/settings` dihapus; route dan link `?section=` lama membuka modal di seksi itu. Modal
canvas yang ada sekarang menjadi kerangkanya.

Navigasinya **satu sidebar bergrup**, bukan tab mode di atas: grup *Lotus* untuk setting yang berlaku di
mana pun (Editor, Appearance, Voice, Runners, Agents, Lotus Agent, Hotkeys, Mobile Access, About), lalu
grup *Canvas*, *Code*, *Chat* yang hanya berisi setting milik mode itu. Setting yang dipakai lebih dari
satu mode selalu masuk grup *Lotus*.

Semua kontrol **menyimpan langsung** (tulisan ke `~/.claude/settings.json` di-debounce); tombol Save
halaman hilang. Pengecualian: field rahasia atau panjang (API key, prompt) punya Save di field itu
sendiri.

⌘, membuka seksi terakhir yang dilihat; entry point yang berkonteks (gear canvas, gear rail Code, tombol
Dictate yang belum disetel) membuka seksi yang relevan. Maximize tetap; occlusion lock canvas hanya
aktif saat modal terbuka di atas canvas.

## Kenapa

Sebelumnya ada dua permukaan: halaman `/settings` (Save eksplisit) dan modal canvas (simpan langsung,
hanya ter-mount di `/canvas`). Voice, Runners, Agents dan Mobile Access berlaku untuk seluruh app tapi
hanya bisa diedit dari canvas, sehingga mode Code dan Chat tidak bisa menjangkaunya.

## Opsi yang ditolak

- **Tab mode di atas (Canvas / Code / Chat) + sidebar per tab.** Sebagian besar setting tidak milik satu
  mode; tab mode memaksa setting global diulang di tiap tab atau disembunyikan di tab keempat, dan
  menambah satu level navigasi. Mode Code dan Chat hampir tidak punya setting sendiri.
- **Modal untuk yang sering dipakai, halaman untuk sisanya.** Tetap dua pintu; masalah yang ingin
  dihilangkan.

## Konsekuensi

- Setting yang tidak dibaca siapa pun dihapus saat dipindah (audit 2026-10-11): Max Teammates, Require
  plan approval global, Display Mode agent teams, duplikat Auto Pane Titles dan tema Workbench Editor,
  salinan kedua field NL model key, seksi Remote Workspaces. "Dangerously skip permissions" pindah ke
  grup Chat karena hanya CodeChat yang membacanya. "General" berganti nama menjadi **Editor**.
- Kotak cari di sidebar belum ada; ditambah bila jumlah seksi tumbuh.
