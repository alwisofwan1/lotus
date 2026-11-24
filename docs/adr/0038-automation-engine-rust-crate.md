# 0038 — Mesin Automation: crate Rust tanpa Tauri, Slack lewat Socket Mode, agent tanpa alat

- **Status:** Accepted
- **Date:** 2026-09-24
- **Deciders:** Alwi
- **Konteks plan:** `plans/automation/PLAN.md`, riset di `research/automation-pr-review.md`

## Konteks

Lotus butuh **Automation**: pekerjaan agent yang dimulai sendiri oleh Trigger (pesan/reaksi Slack,
jadwal, manual) dan menghasilkan Output (draft, review GitHub, balasan Slack). Kasus pertama:
review PR yang diminta tim di Slack. Fitur ini harus tetap jalan saat jendela tertutup, dipakai
dari mode Chat, Code, dan Canvas, dan suatu hari bisa pindah ke server.

Tiga pertanyaan arsitektur harus dijawab sebelum kode pertama:

1. **Di proses mana mesinnya hidup?** Ada dua kandidat. Rust (`src-tauri`) hidup selama proses Lotus
   hidup, juga dengan nol jendela (`windowing.rs:47-52`), dan sudah punya `rusqlite`, tokio, dan
   `tokio-tungstenite`. `packages/host` bisa jalan di VPS, tetapi di desktop ia **opt-in dan mati
   secara default** (`host_runtime/config.rs:46`). Ia juga berjalan dalam client mode yang
   meneruskan panggilan ke Rust, tidak punya database dan Keychain, dan tidak bisa dijangkau
   langsung dari UI (UI hanya memanggil `invoke`).
2. **Bagaimana Slack masuk?** Webhook (Events API) butuh URL publik atau tunnel, seperti contoh
   `bb/examples/plugins/slack-bot`. Socket Mode membuka WebSocket keluar dan tidak butuh keduanya.
3. **Apa yang boleh dilakukan agent terhadap konten yang tidak tepercaya?** Judul PR, deskripsi,
   diff, dan pesan Slack ditulis orang lain. `bridge_chat::run_claude` yang ada berjalan dengan
   `--dangerously-skip-permissions` dan batas 180 detik (`bridge_chat.rs:23,157`).

## Keputusan

### 1. Crate Rust `lotus-automation`, tanpa ketergantungan Tauri

Inti Automation mencakup model, store SQLite, engine, trigger, action, dan output. Semuanya hidup
di crate Rust sendiri yang **tidak mengimpor `tauri`**. Semua efek samping lewat trait port:
`GitHub`, `Slack`, `AgentRunner`, `SecretStore`, `Clock`, `Notifier`.

Tauri hanya memasang crate itu (`automation_host.rs`). Pemasang itu menyediakan Keychain, memetakan
preset delegasi ke `AgentRunner`, meneruskan event ke frontend, dan mendaftarkan
`#[tauri::command]` di dalam `pub mod commands` seperti biasa.

`src-tauri` saat ini bukan Cargo workspace. Crate ditambahkan sebagai path dependency. Menjadikan
`src-tauri` workspace (supaya `target/` dipakai bersama) diputuskan di slice pertama.

### 2. Registry, bukan `match` yang tumbuh

`TriggerSource`, `ActionKind`, dan `OutputSink` adalah trait yang didaftarkan. Jenis baru berarti
satu modul baru. Jenis pertama:
- trigger: `slack_message`, `slack_reaction`, `cron`, `manual`;
- action: `pr_review`, `agent_prompt`;
- output: `draft`, `github_review`, `slack_thread`, `slack_dm_self`, `macos_notify`.

### 3. Slack lewat Socket Mode, dengan token akun pengguna

Satu Slack App, dua token di macOS Keychain:
- `xapp-` untuk koneksi Socket Mode;
- `xoxp-` untuk membaca channel dan reaksi, serta membalas atas nama pengguna.

Tidak ada bot. Pesan yang terlewat saat Lotus mati dikejar dari riwayat channel sejak kursor
terakhir.

### 4. Agent tanpa alat, konten sebagai data

Untuk `pr_review`, Lotus sendiri yang mengambil diff, metadata, dan file panduan repo lewat `gh`,
dengan token akun per automation yang hanya ada di env proses anak. Semua itu masuk ke prompt
sebagai data berpagar.

Agent dijalankan lewat preset delegasi **tanpa alat**. Jawabannya wajib sesuai schema, dan komentar
yang menunjuk baris di luar diff dibuang. `agent_prompt` juga default tanpa alat, dan alat hanya
dibuka per automation secara eksplisit. `--dangerously-skip-permissions` tidak pernah dipakai oleh
Automation.

### 5. Manusia memegang semua yang keluar ke orang lain

Output ke GitHub, channel, atau thread selalu melewati draft dan tombol "Kirim". Review GitHub
selalu bertipe COMMENT. Output yang hanya untuk pengguna sendiri, yaitu notifikasi macOS dan DM ke
diri sendiri, boleh otomatis.

Agent yang dijalankan automation tidak boleh membuat, mengubah, atau menghapus automation.

### 6. Anti-dobel di database, bukan di memori

Setiap run punya kunci idempotensi, misalnya `repo+PR+headSHA`, `channel+ts`, atau
`automation+scheduled_at`. Kunci itu diklaim secara atomik di `~/.lotus/automations.db`. Run yang
terputus oleh restart dibereskan saat startup.

## Konsekuensi

- Automation jalan saat jendela tertutup, tetapi **berhenti saat Lotus di-quit**. Jalur ke 24/7
  adalah binary daemon yang memakai crate yang sama. Jalur ini bukan porting ke `packages/host`.
- Ada dua implementasi runner headless: TS di `packages/host` dan Rust di sini. Itu harga yang
  diterima demi tidak mewajibkan host menyala. Kalau suatu hari host menjadi wajib, keputusan ini
  perlu ditinjau ulang.
- Perlu crate Keychain baru. Periksa major versi terbaru sebelum menambahkannya.
- Frontend `src/modules/automation` adalah modul netral. Chat dan Code memakainya lewat `navSlot`
  bersama, dan Canvas lewat MCP dulu. UI boleh berbeda per mode, tetapi service-nya satu.
- Review berbasis diff saja tidak melihat konteks di luar diff. Ini diterima untuk MVP. Checkout
  (menjalankan kode tak tepercaya) memerlukan ADR sendiri.

## Alternatif yang ditolak

- **Mesin di `packages/host`.** Memaksa host selalu menyala dan membangun ulang database, Keychain,
  Slack, dan jalur UI→host yang belum ada.
- **Webhook Slack/GitHub.** Butuh URL publik atau tunnel plus verifikasi signature. Socket Mode
  memberi kecepatan yang sama tanpa itu.
- **Memakai `bridge_chat::run_claude` apa adanya.** Mode YOLO dan batas 180 detik tidak cocok untuk
  konten tak tepercaya dan review panjang.
- **Langkah-langkah yang bisa disusun bebas (gaya Zapier/n8n).** Terlalu besar untuk MVP. Registry
  jenis Action membuka jalan ke sana nanti.
