# 0044 — Google Connector: login Google milik Lotus, scope `drive.file`, output ditulis oleh Rust

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Alwi
- **Terkait:** ADR-0038 (engine automation di crate Rust), `plans/google-connector/PLAN.md`,
  `research/google-workspace-connector.md`

## Konteks

Alwi ingin automation terjadwal (mis. laporan monitoring harian) menyimpan hasilnya langsung ke
Google Sheet dan Google Drive, dengan cara connect yang semudah Claude.ai / ChatGPT / Zapier.

Dua jalan diteliti (riset § 3):

- **Memakai connector Google Drive milik claude.ai.** Terbukti terlihat di `claude -p` headless,
  tapi hanya bisa membuat file baru — tidak ada tool untuk menambah baris ke Sheet yang sudah ada —
  hanya jalan dengan login langganan claude.ai, dan model yang memutuskan kapan menulis.
- **Login Google milik Lotus.** Satu OAuth client Desktop milik Lotus; Lotus sendiri yang menulis.

Scope menentukan biaya: `spreadsheets` sensitif (review), `drive` restricted (review berminggu-minggu
+ audit CASA berbayar). `drive.file` non-sensitive: hanya file yang dibuat Lotus atau dipilih user.

## Keputusan

1. **Lotus punya login Google sendiri**, satu client tipe Desktop: redirect loopback
   `127.0.0.1:<port acak>` + PKCE S256, consent di browser sistem, timeout 5 menit, Cancel.
   Client dibaca dari `LOTUS_GOOGLE_CLIENT_ID/SECRET` saat build, atau dari
   `<state dir>/google-oauth-client.json` (di luar repo).
2. **Scope hanya `openid email drive.file`.** Grant tanpa `drive.file` (user menghapus centang di
   layar consent) ditolak. Konsekuensinya Lotus hanya bisa menulis Sheet/folder yang ia buat atau
   yang user pilih: form membuat sheet baru **saat automation disimpan** (`spreadsheetId: "new"`),
   Drive default ke My Drive (`folderId: "root"`, upload tanpa `parents`).
3. **Refresh token di secret store yang sama dengan Slack** (Keychain; dev macOS: file 0600);
   access token hanya di memori. Email + scope (tanpa token) di `google-account.json` supaya
   Connectors tidak membaca keychain. Token Google (`ya29.`, `1//`) disamarkan oleh `redact()`.
4. **Agent tidak pernah memegang token dan tidak menulis ke Google.** Agent membalas `text` (+
   `rows` bila ada Sheet Output, tepat sejumlah kolom); Rust yang menulis lewat port
   `GoogleWriter`. Teks yang diawali `=` `+` `@` atau `-` (bukan angka) diberi apostrof agar data
   luar yang dikutip agent tidak menjadi formula di sheet user.
5. **Output Google dikirim otomatis** seperti DM ke diri sendiri (ruang milik user), dan **gagal ke
   Google tidak menggagalkan run**: dicatat `not_sent` + alasan; "Send again to Google" mengulang
   hanya bagian yang gagal, satu per satu, tanpa menjalankan agent lagi — tidak ada baris dobel.
6. **Satu jalur untuk panel dan agent** (`google::output::ready_form`): Google harus terhubung, dan
   sheet baru hanya dibuat setelah seluruh form valid.

## Konsekuensi

- Tanpa review scope dan tanpa CASA. Selama consent screen masih **Testing** (External), refresh
  token mati tiap 7 hari dan user harus Connect ulang; hilang setelah app di-*publish*, yang butuh
  domain + halaman privacy policy (task #19, belum).
- Memilih Sheet yang sudah ada (bukan buatan Lotus) butuh Google Picker (slice 05, ditunda);
  sampai itu, hanya sheet/folder buatan Lotus yang bisa ditempel linknya.
- Crate tetap tanpa Tauri (ADR-0038): sign-in, loopback, klien Sheets/Drive, dan output ada di
  `lotus-automation/src/google/`; Tauri hanya memegang siklus hidup (browser, cancel, status).
- `OutputSink` registry dari ADR-0038 tetap belum dibangun; output Google menempel di
  `agent_prompt` seperti `dm_self` / `slack_channel`.
