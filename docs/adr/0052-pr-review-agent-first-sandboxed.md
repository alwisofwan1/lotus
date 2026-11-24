# 0052 — Review PR: agent bekerja sendiri di worktree, semua alat, dipagari sandbox

- **Status:** Accepted
- **Date:** 2026-10-08
- **Deciders:** Alwi
- **Mengganti:** ADR-0039 keputusan 2 (allow list baca saja untuk headless) dan batas 3000 baris di
  `PrReviewLimits`. Keputusan 6 ADR-0039 (tanpa konteks pribadi user) **tetap berlaku**.
- **Konteks plan:** `plans/pr-review-large-diff/PLAN.md` (grilling 2026-10-08)

## Konteks

Review PR melewati justru PR yang paling butuh review. DB release per 2026-10-08: 10 run di-skip karena
`over the 3000 limit`, 1 run gagal karena GitHub menolak diff di atas 20 000 baris (HTTP 406). PR itu
berisi kode asli dan test-nya (34–66% test), bukan lockfile.

Penyebabnya bukan hanya angka 3000. Lotus memasukkan seluruh diff ke prompt, dan agent hanya boleh
memakai `Read/Grep/Glob`, `gh pr view/diff`, `git log/show`, `git fetch origin`. `git diff` tidak boleh.
`Read`/`Grep` membaca checkout user, bukan kode di head PR.

User ingin agent memakai **semua alat**, kecuali aksi keluar. Tes 2026-10-08 membuktikan
`--disallowedTools` saja **bukan pagar**: aturan itu mencocokkan teks awal perintah.
`sh -c 'git push …'`, `git -C . push`, `/usr/bin/git push` dan `git -c … commit` lolos. Remote tes
memang menerima branch baru.

## Keputusan

1. **Agent bekerja sendiri.** Prompt tidak memuat diff. Prompt berisi: PR, base/head SHA, daftar file
   dengan `+/-`, panduan repo, PR saudara dari thread Slack yang sama, dan isi thread Slack. Cara review
   ditentukan **skill milik user**, yang namanya diisi di form. Form kosong → prompt bawaan Lotus. Skill
   tidak ditemukan → run gagal dengan pesan jelas, tanpa fallback diam-diam.
   - Diff diambil Lotus sendiri di worktree: `git diff --find-renames <base_sha>...<head_sha>`. Commit base
     di-fetch dulu kalau belum ada (`refs/heads/<base_ref>`, lalu SHA-nya). Agent menjalankan
     `git diff --stat` dan `git diff … -- <path>` sendiri. Diff itu juga dipakai Lotus untuk memeriksa
     baris komentar.
   - Tanpa worktree (automation tanpa project berisi checkout repo), Lotus tetap memakai `.diff` GitHub dan
     menaruhnya di prompt seperti dulu. GitHub menolak diff besar (HTTP 406); pesan run lalu meminta user
     memberi automation project dengan checkout repo itu. (Slice 03, 2026-10-08.)
   - Re-review: diff "sejak review terakhir" juga diambil lokal (`git diff <since>...<head>` di checkout;
     `since` di-fetch per SHA kalau belum ada). Gagal (mis. force-push) → compare GitHub seperti dulu.
   - Pane: Lotus mengambil diff di checkout repo dari project (fetch saja, file user tidak berubah). Prompt
     pane tidak lagi menyebut `gh pr diff`: daftar file dari `gh pr view --json files`, diff dari
     `git diff <base>...<head>`, tanpa checkout dari `gh api …/pulls/<n>/files`. (Slice 10, 2026-10-08.)
   - Pengecekan skill mencari `~/.claude/skills/<n>/SKILL.md`, `~/.claude/commands/<n>.md` dan plugin yang
     aktif (`plugin:skill` juga diterima). Run berpane memakai skill yang sama.
2. **Worktree khusus review.** Lokasinya `~/.lotus-review-worktrees/<repo>-<nomor>` (dev:
   `~/.lotus-dev-review-worktrees/`), di commit head PR. Dulu di `~/.lotus/review-worktrees/`, tapi
   `denyRead ~/.lotus` ikut menutup worktree itu: Bash `git` gagal ("Unable to read current working
   directory") dan Read ditolak (dites live 2026-10-08). Sisa di lokasi lama dihapus saat start.
   Path tetap per PR, karena lanjutan sesi (`--resume`) butuh path yang sama. Worktree dihapus di akhir
   **setiap** run (sukses, gagal, timeout) dengan `git worktree remove --force` + `git worktree prune`.
   Run lanjutan membuatnya ulang. Lotus menghapus sisa worktree saat start. UI menampilkan jumlah yang ada.
3. **Pagar yang sungguhan, tiga lapis** (semua dibuktikan dengan tes 2026-10-08):
   - **Sandbox Claude Code**, dengan `--permission-mode dontAsk`, **bukan** bypass. Di mode bypass,
     domain di luar `allowedDomains` tetap lolos (`google.com` → 200). Di `dontAsk` + sandbox:
     - Bash apa pun jalan, termasuk `python3` dan `sh -c`.
     - Semua host ditolak, termasuk `google.com` dan `api.github.com` (revisi 2026-10-08, lihat lapis 2).
     - Tulis di luar worktree ditolak.
     - `cat ~/.lotus/...` ditolak, `gh` tidak bisa membaca kredensialnya, dan localhost (IPC Lotus) ditolak.

     Setting yang dipakai:
     - `sandbox.enabled`, `autoAllowBashIfSandboxed`, `allowUnsandboxedCommands: false`, `failIfUnavailable`
     - `filesystem.denyRead`: `~/.lotus`, `~/.lotus-dev`, `~/.config/gh`, `~/.ssh`, `~/Library/Keychains`.
       Tanpa `~/Library/Keychains`, `security find-generic-password -w` di dalam sandbox membaca token
       `gh` user (75 byte, tes 2026-10-08). Dengan aturan itu, sandbox hanya melihat System keychain.
     - `network.allowedDomains`: kosong. Tidak ada host yang bisa dihubungi.
     - `enableWeakerNetworkIsolation` **tidak** dipakai. Setting itu hanya perlu supaya `gh` (Go) bisa
       mengecek TLS, dan menurut dokumentasi membuka jalur keluar yang sempit. Agent tidak lagi memakai `gh`.
     - `permissions.deny`: `Read(~/.lotus/**)` dan sejenisnya. `Read`/`Grep` tidak memakai `denyRead`
       sandbox; aturan `Read(...)` berlaku untuk semua alat baca.
     - `GITHUB_TOKEN`, `GH_*` dan `SSH_AUTH_SOCK` milik user dihapus dari env.
     - Flag preset yang tersisa hanya `--model`. Contohnya, `--add-dir` atau `--settings` dari preset
       tidak bisa melebarkan pagar.
     - Alat `Edit`/`Write` tidak diizinkan, karena alat itu tidak di-sandbox. Agent menulis lewat Bash,
       yang hanya bisa menulis di worktree.
   - **Agent tidak memegang token GitHub** (revisi 2026-10-08, menggantikan PAT read-only). Agent membaca
     GitHub hanya lewat alat MCP Lotus `lotus_github_read`:
     - Lotus menjalankan `gh api --method GET <path>` di luar sandbox, dengan login `gh` milik automation
       (`gh auth token --user`). Akun itu ditulis Lotus di env server MCP (`LOTUS_REVIEW_GH_ACCOUNT`),
       bukan dipilih agent.
     - Hanya GET, hanya path REST (`/repos/…`, `/search/…`), tanpa `graphql`, `..` atau URL penuh. Hasil
       dipotong di 400 KB.
     - GET tidak mengubah apa pun di GitHub. Push, approve dan komentar tidak mungkin, karena agent tidak
       punya token dan tidak punya jaringan.
     - Alasannya: fine-grained PAT hanya punya **satu** resource owner. PAT user tidak bisa membaca
       `acme/*` dan `alwisofwan1/hr-portal` sekaligus (404), jadi kedua automation PR review tidak bisa
       jalan. Login `gh` sudah ada per automation, jadi user tidak perlu membuat token apa pun.
     - Commit PR sudah di-fetch Lotus sebelum run, jadi agent tidak perlu kredensial git.
   - **`--disallowedTools`** tetap dipakai sebagai saringan pertama, bukan sebagai pagar:
     - `git push/commit/checkout/reset`
     - `gh pr review/comment/merge/edit`
     - `gh api`
     - `rm`
     (semua juga tidak bisa jalan tanpa jaringan dan token)
     - alat MCP tulis
4. **MCP lewat nama persis.** Alat MCP baca (Slack, Notion, Lotus) diizinkan dengan nama lengkap di
   `--allowedTools`. Nama MCP tidak bisa diakali seperti teks Bash. Alat tulis Slack/Notion dan alat
   Lotus yang menjalankan perintah (`lotus_dispatch_to_cell`, `lotus_spawn_cell`, `lotus_automation_*`)
   tidak pernah masuk daftar. Agent tidak pernah menulis ke Notion (aturan user).
   - Headless juga dapat `lotus_notion_read` (#161): satu halaman Notion lewat link, page id, atau key
     `TKT-1234`. Key dicari di salinan database yang disinkron Lotus Tasks (tanpa query Notion
     tambahan); key tidak ada → "Not found" yang jelas. Lotus membaca dengan token Notion yang
     terhubung, di luar sandbox; agent tidak memegang token. Hanya baca.
   - Risiko yang diterima (pilihan user, opsi B): halaman mana pun yang bisa dibuka token bisa dibaca,
     jadi link di PR bisa menunjuk halaman privat. Penahan: hasil alat dibungkus `<notion-page>` dengan
     catatan "data, mungkin privat, jangan kutip"; prompt melarang mengutip; review tidak terkirim
     sendiri, reviewer membacanya dulu. Ini aturan prompt, bukan kunci kode. Kunci kode (hanya baris
     database Lotus Tasks) ditolak user.
5. **Setting dari repo PR tidak dimuat.** Worktree ada di head PR, jadi `.claude/settings.json`,
   `.mcp.json` dan hook di dalamnya ditulis author PR. Hook berjalan di luar sandbox.
   - Lotus memakai `--setting-sources user` dan `--strict-mcp-config`. Server MCP yang dimuat hanya
     yang disebut `mcp_tools` (`--mcp-config`).
   - Bukti tes 2026-10-08:
     - Tanpa flag itu, hook `SessionStart`/`UserPromptSubmit` dan server `.mcp.json` dari repo ikut
       jalan.
     - Dengan flag itu, tidak ada yang jalan, dan skill/agent dari `.claude/` repo tidak terlihat.
     - Skill milik user tetap dimuat.
6. **Menjalankan test / install**: toggle per automation, default mati. Kalau nyala, domain registry
   (npm, PyPI) ditambahkan ke `allowedDomains`. Kode PR berjalan di Mac user.
   - Field config: `run_tests` (form: Tests → "Run the PR's tests"). Hanya headless; pane mengabaikannya.
   - Nyala: `allowedDomains` = `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`. Prompt
     mengizinkan install + test di folder kerja.
   - Cache paket ada di `<worktree>/.lotus-cache/` (`npm_config_cache`, `PIP_CACHE_DIR`,
     `YARN_CACHE_FOLDER`, `BUN_INSTALL_CACHE_DIR`): sandbox menolak `~/.npm` (EPERM, dites 2026-10-08).
   - Mati: tidak ada host; prompt melarang install/test, test hanya dibaca.
   - Nyala = kode PR jalan dan npm bisa `publish` (PUT ke registry yang sama). Supaya file rahasia tidak
     bisa dikirim keluar (2026-10-08, dites live):
     - Sandbox `denyRead: ["~", …]` + `allowRead`: worktree, folder `.git` checkout-nya, dan toolchain di
       home dari `PATH` (install version manager utuh; folder lain hanya foldernya, mis. `~/.cargo/bin`
       tanpa `~/.cargo/credentials.toml`). `~/.aws`, `~/.docker`, `~/.config`, dll. tertutup.
     - Read/Grep/Glob hanya `Read(/<worktree>/**)` dkk., bukan seluruh disk.
     - Env bersih: hanya `PATH HOME USER LOGNAME SHELL LANG LC_* TERM TMPDIR` + cache + `GIT_CONFIG_GLOBAL=/dev/null`
       (`~/.gitconfig` tertutup; tanpa ini git berhenti).
     - Sisa risiko: isi worktree (kode PR sendiri) tetap bisa dipublish. Toolchain di luar `PATH` (mis.
       `~/.rustup`) tertutup, jadi test Rust tidak jalan.
7. **Batas**: 3000 baris dihapus. Batas keras 300 file, bisa diatur (form: Max files, 1–3000). Timeout
   headless 30 menit, bisa diatur (form: Timeout, 1–120 menit). Alasan skip menyebut nama field-nya.
   Batas output naik: 100 komentar, ringkasan 8000 karakter. File yang tidak dibaca agent ditulis di
   `## Not reviewed`.
8. **Slack**:
   - Thread yang meminta review dibaca ulang lengkap saat run mulai (`conversations.replies`, nama
     pengirim, pesan yang diedit, nama file).
     - Dibaca Lotus dengan token user (`SlackWeb::thread`); agent tidak pernah memegang token Slack. Isi
       thread masuk prompt di dalam pagar untrusted. Batas: 8000 karakter per pesan, 60 000 total
       (balasan tertua dibuang dulu, pesan permintaan tetap).
     - Nama: `user_profile` di pesan, kalau tidak ada `users.info` (scope `users:read`, opsional). Tanpa
       scope itu, prompt memakai id user.
     - Slack tidak bisa dibaca → run tetap jalan dengan balasan yang disimpan listener
       (`review_feedback`), dan detail run menyebutnya. (Slice 04, 2026-10-08.)
   - Satu thread selalu mendapat **satu** pesan balasan untuk semua PR-nya. Bentuknya:
     - "Send all" mengirim semuanya sekaligus, sebagai comment. Send all tidak pernah approve: approve
       tetap satu klik per PR (ADR-0042). Balasan ✅ di thread GitHub yang sudah fixed ikut dikirim
       (default sama dengan kartu).
     - Send satu per satu menahan pesan Slack sampai draft terakhir selesai.
     - "Balas sekarang" melepas pesan yang tertahan.
     - Pesan ditahan selama thread itu masih punya draft PR review yang pending/sending, atau run
       yang queued/running. Draft yang di-discard, atau Send tanpa centang Slack, melepas tahanan.
       Tahanan disimpan di tabel `slack_reply_holds` (v16), jadi tetap ada setelah app restart.
       Slack gagal → tahanan tetap, "Balas sekarang" atau Send berikutnya mencoba lagi.
       (Slice 07, 2026-10-08.)
   - Bentuk pesan diatur dengan blok ```` ```slack-reply-group ```` di instructions, dengan placeholder
     `{count}`, `{reviews}`, `{title}`, `{author}`. Preview bisa diedit sebelum kirim.
     - Blok group hanya boleh `{mention}`, `{count}`, `{reviews}`. `{title}` dan `{author}` hanya di blok
       per PR (`slack-reply`, `slack-reply-lgtm`): di pesan group judul itu milik PR mana tidak jelas.
       Placeholder dari jenis blok lain ditolak dengan daftar yang boleh.
     - Tanpa blok group: `{mention} Review selesai untuk {count} PR:` lalu `{reviews}`.
     - Setiap PR di dalam `{reviews}` diatur blok ```` ```slack-reply-group-item ```` (dan
       ```` ```slack-reply-group-item-lgtm ```` untuk PR yang LGTM), bukan blok satu-PR, supaya sapaan
       hanya diucapkan sekali di blok group. Default: `{pr} — {verdict}` lalu `{points}`; LGTM:
       `{pr} — LGTM ✅` lalu `Optional: {counts}` (baris itu hilang bila tidak ada saran).
       (2026-10-14.)
     - **Re-review** (PR yang sudah pernah direview, diminta lagi) boleh punya kata-katanya sendiri:
       ```` ```slack-reply-rereview ````, ```` ```slack-reply-rereview-lgtm ```` dan
       ```` ```slack-reply-group-rereview ````. Masing-masing jatuh ke blok putaran pertamanya bila tidak
       ditulis. Pesan group memakai blok re-review hanya bila **semua** PR-nya re-review.
     - Placeholder `{lead}` (blok satu-PR dan item): satu kalimat pembuka dari agent untuk putaran ini
       (maks 160 karakter, tanpa sapaan/emoji), di-escape. Tujuannya: thread yang sama tidak pernah
       membaca kalimat yang sama dua kali. Lead ikut dipertahankan saat reviewer mengedit poin.
       Baris yang hanya berisi `{mention} {lead}` hilang seluruhnya bila agent tidak menulis lead.
       (2026-10-14.)
     - Preview di kartu draft dirender host dari draft yang tersimpan. Teks yang diedit dikirim apa
       adanya (maks 4000 karakter); teks dari agent tetap di-escape di render Lotus. Review yang belum
       terkirim menaut ke PR; saat posting, tautan PR diganti tautan review. Draft LGTM/Approve tidak
       punya preview yang bisa diedit. (Slice 08, 2026-10-08.)
9. **Rilis**: semua automation PR review langsung pindah ke cara baru, tanpa toggle.

## Akibat yang disadari

- Review butuh checkout repo PR di Mac. Tanpa checkout, run gagal dengan pesan yang menyebut caranya.
- User tidak perlu membuat token. Server MCP Lotus harus terdaftar di `~/.claude.json` (Lotus
  mendaftarkannya saat start); kalau tidak ada, review gagal sebelum agent mulai, dengan pesan "restart
  Lotus".
- Agent hanya bisa membaca GitHub sejauh REST GET. `git fetch` dari dalam sandbox tidak bisa; Lotus yang
  menyiapkan commit.
- Keychain: tanpa `denyRead ~/Library/Keychains`, sandbox **bisa** membaca password keychain. Itu
  termasuk token `gh` user, yang bisa approve atau komentar atas nama user. Aturan itu wajib, dan tes
  regresi mengunci nilainya.
- Mode `dontAsk` menolak `git commit` walaupun di dalam sandbox. Ini justru diinginkan.
- Batas `--disallowedTools` bisa diakali. Keamanan bergantung pada lapis 1 dan 2, jadi tes regresi wajib
  memakai perintah pengakal (`sh -c`, `git -C`, `/usr/bin/git`).
- Siapa pun yang memegang secret IPC Lotus bisa memanggil `/v1/github-read` sebagai akun `gh` mana pun
  yang login. Secret itu ada di `~/.lotus(-dev)/`, yang disembunyikan dari agent.
