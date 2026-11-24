# 0039 — Review PR oleh automation: alat baca saja, MCP lewat allow list

- **Status:** Accepted
- **Date:** 2026-09-26
- **Deciders:** Alwi
- **Mengganti sebagian:** ADR-0038 (aturan "`--dangerously-skip-permissions` tidak pernah dipakai") dan
  keputusan "Opsi B" 2026-09-25 untuk `pr_review`
- **Konteks plan:** `plans/automation/PLAN.md` § 7 (grilling blind spot 2026-09-26)

## Konteks

ADR-0038 dan PLAN Q35 menetapkan agent automation tanpa alat. Pada 2026-09-25 ("Opsi B") keduanya
dilonggarkan: setiap run berjalan seperti agent biasa, dengan flag preset apa adanya — termasuk
`--dangerously-skip-permissions` — semua tool, skill, dan MCP server user.

Untuk `agent_prompt` itu wajar: prompt-nya ditulis user sendiri. Untuk `pr_review` tidak: agent membaca
judul, deskripsi, komentar, dan diff yang ditulis orang lain. Satu-satunya pengaman adalah kalimat
"jangan posting" di prompt. Selain itu `~/.claude/settings.json` user memakai `defaultMode: auto`,
jadi mencabut flag bahaya saja tidak cukup — mode auto tetap menyetujui banyak alat tanpa bertanya.

## Keputusan

1. **`pr_review` tidak pernah menerima `--dangerously-skip-permissions`** (atau
   `--permission-mode bypassPermissions`) dari preset. Flag itu dibuang dan dicatat seperti flag lain
   yang dimiliki Lotus.
2. **Headless:** `--permission-mode dontAsk` + `--allowedTools` baca saja: `Read`, `Grep`, `Glob`,
   `Bash(gh pr view:*)`, `Bash(gh pr diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`,
   `Bash(git fetch origin:*)` (ditambahkan 2026-09-26: agent perlu commit PR untuk `git show`; hanya
   menulis ref remote-tracking). Alat lain ditolak
   otomatis — kecuali yang sudah diizinkan oleh `permissions.allow` di setting user sendiri
   (`~/.claude/settings.json`) atau setting project di folder kerja. Itu pilihan user, bukan isi PR, jadi
   dibiarkan: mematikan setting (`--setting-sources`) juga mematikan plugin dan skill. Mode `auto` user
   tidak berlaku lagi, karena `--permission-mode dontAsk` menimpanya (dicek live 2026-09-26: `Read` dan
   `git log` jalan, `touch` dan `Write` ditolak, tidak ada file dibuat).
3. **Pane:** allow list yang sama dengan `--permission-mode manual`: alat lain meminta izin user di pane.
   Membuka ulang run review (`--resume`) memakai aturan yang sama. Sejak keputusan 7 pane hanya dibuka
   bila automation memintanya.
4. **MCP lewat allow list per automation** (`mcpTools`: nama tool atau satu server utuh, mis.
   `mcp__context7`). Default kosong = tanpa MCP. Semua MCP server user dimuat, tetapi hanya yang ada di
   daftar bisa dipanggil tanpa izin. Di pane, server `lotus` selalu tersedia untuk
   `lotus_automation_submit`. `lotus_automation_options` menampilkan MCP server user; agent pembuat
   automation menyarankan yang baca saja.
5. `agent_prompt` tetap "Opsi B": preset apa adanya.
6. **Tanpa konteks pribadi user** (ditambahkan 2026-09-26). Run review — headless, pane, dan membuka
   ulang — memakai `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` dan `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`: tidak ada
   `CLAUDE.md` / `.claude/rules` yang dimuat (global user, folder induk tempat checkout berada, maupun
   checkout itu sendiri) dan tidak ada auto-memory. Aturan repo PR dibaca Lotus dari GitHub di head
   commit (`.github/REVIEW.md`, `CLAUDE.md`, `CONTRIBUTING.md`) dan diberikan di dalam pagar data, baik
   headless maupun pane. Tidak ada file itu → prompt menyebut "repo ini tidak punya aturan". Prompt juga
   menyuruh agent tidak mengutip instruksi dari setup-nya sendiri, sebagai cadangan.

   Pemicunya: review `acme/acme-api` mengutip `.claude/rules/prohibited-code.md` milik repo
   induk pribadi (`acme-main`) sebagai aturan tim. Transcript run membuktikan file itu dimuat otomatis
   karena checkout ada di dalam folder `acme-main`; repo PR sendiri tidak punya file aturan.
   Preferensi review pribadi ditulis di `instructions` automation.
7. **Headless sebagai default, pane opsional** (ditambahkan 2026-09-26). Automation dengan project
   berjalan headless di folder project (review: di checkout repo PR, dicari dari daftar workspace yang
   dikirim frontend); `openPane` (default mati) membuka pane untuk ditonton. Headless memakai `dontAsk`,
   jadi alat di luar daftar langsung ditolak dan tidak ada yang menunggu user. Output agent memakai
   `--output-format stream-json --verbose`; tiap tool call (dan tiap alat yang ditolak) menjadi satu
   langkah pendek yang dikirim ke UI (`automation://step`) dan ditampilkan di baris run yang berjalan.
   Percakapan tetap bisa dibuka di pane sesudahnya dari Runs atau dari kartu draft.

   Akibat yang disadari:
   - Review headless kini berjalan di checkout user, bukan folder kosong: `permissions.allow` di setting
     project checkout itu ikut berlaku (keputusan 2). Repo yang mengizinkan `Bash(*)` di
     `.claude/settings.json`-nya memperlebar review "baca saja" itu.
   - Automation lama yang punya project berpindah dari pane ke headless tanpa diminta. Untuk
     `agent_prompt` itu berarti agent penuh dengan flag preset apa adanya, tanpa ditonton — seperti
     sebelum pane ada (Opsi B 2026-09-25). Centang "Open a pane to watch each run" mengembalikannya.
   - Project yang belum dikenal Lotus (belum terbuka, remote, atau jendela belum melapor setelah start)
     menggagalkan run dengan alasannya dan run dicoba ulang; run tidak lagi jalan diam-diam di folder kosong.
   - Membuka percakapan run yang masih berjalan ditolak (UI dan host): agent kedua di sesi yang sama
     akan mencabangkan percakapannya.
   - Run `agent_prompt` di background boleh 30 menit, sama dengan di pane (2026-09-27): prompt terjadwal
     bisa berupa pekerjaan nyata (HR Portal ticket runner: TDD, e2e, review). Review PR tetap 10 menit.

   Pemicunya: run `acme-web#2506` di pane menunggu 18 menit sebelum agent menerima prompt, lalu
   berhenti meminta izin `git fetch`; user tidak melihat pane itu. Auto/bypass untuk review ditolak
   (user, 2026-09-26): teks PR tetap tidak dipercaya.

## Konsekuensi

- PR yang berisi perintah tersembunyi tidak bisa membuat agent mengedit file, menjalankan perintah
  sembarang, atau mengirim pesan lewat MCP. Skill user tetap jalan.
- Tool MCP yang menulis (Slack send, Notion update) hanya bisa dipakai kalau user sendiri
  memasukkannya ke `mcpTools`. Itu pilihan sadar, bukan default.
- Bergantung pada `--permission-mode dontAsk`/`manual` di CLI `claude`. Preset `ccs` meneruskannya ke
  `claude` yang sama; dicek saat implementasi.
- Dua env var di keputusan 6 tidak ada di `claude --help`. Dicek live di 2.1.283 (langsung dan lewat
  `ccs acme`): folder induk + repo anak dengan kata rahasia di tiap `CLAUDE.md`/rules → tanpa env
  ketiganya terbaca, dengan env tidak ada. Versi CLI baru bisa mengubahnya; kalimat di prompt tetap ada.
  `--bare` tidak dipakai: ia juga mematikan login OAuth/keychain.
- `CLAUDE.md` bersarang di subfolder repo tidak lagi dimuat; hanya tiga file di root yang dibaca.
- Aturan dibaca di head PR, jadi PR yang mengubah `CLAUDE.md` ikut menentukan aturannya. Isinya tetap
  di dalam pagar sebagai data.
- ADR-0038 tetap berlaku untuk hal lain (crate tanpa Tauri, Socket Mode).
