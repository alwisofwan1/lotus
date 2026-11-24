# 0040 — Automation Ask: satu klik melanjutkan percakapan agent

- **Status:** Accepted
- **Date:** 2026-09-27
- **Deciders:** Alwi
- **Terkait:** ADR-0038 (engine automation), ADR-0039 (review PR baca saja — tetap berlaku penuh)
- **Konteks plan:** `plans/automation/PLAN.md` § 8 (grilling "Needs you" 2026-09-27)

## Konteks

Automation "HR Portal ticket runner" berhenti setelah fase rencana dengan tiket `Status: needs-info`
dan menunggu user menyetujui seams. Hasilnya hanya berupa `text` di DM, masuk "Recent results" (bukan
"Waiting for you"), tidak dihitung di badge, dan persetujuan harus dilakukan dengan pindah branch, edit
file tiket, lalu menunggu jadwal berikutnya (09:00 / 13:00) — bisa berjam-jam. Agent juga tidak punya
cara terstruktur untuk mengatakan "saya butuh kamu".

Fakta dari kode (2026-09-27): setiap run sudah punya `session_id` buatan Lotus (`--session-id`, disimpan
di `runs.session_json`), dan `resume_command` / `read_only_resume_command` sudah ada untuk "Open
conversation". Plugin notifikasi (2.3.3) tidak punya callback klik di macOS.

## Keputusan

1. **Ask adalah akhir run milik engine**, bukan fitur satu action: `ActionResult::Asked` di samping
   Succeeded / Drafted / Skipped / Failed. Semua action kind — `agent_prompt`, `pr_review`, dan yang
   akan datang — bisa bertanya. Satu run berakhir dengan Ask **atau** hasil/draft, tidak keduanya.
2. **Bentuk Ask satu saja:** pertanyaan, 0–4 label pilihan, dan kotak catatan yang selalu ada. Lotus
   generik: tidak tahu soal tiket atau seams; agent yang menafsirkan jawaban.
3. **Menjawab memulai Follow-up Run seketika** yang melanjutkan percakapan yang sama (`--resume <id>`)
   dengan jawaban sebagai pesan berikutnya. Semua pilihan (termasuk "Reject") memulai run; "Dismiss"
   menutup Ask tanpa run. Idempotency key berisi id Ask, jadi klik ganda = satu run. Berjalan juga saat
   automation dimatikan (aksi langsung user, seperti "Run now"). Transcript hilang (atau run penanya tidak menyimpan sesi) → run baru
   di tempat yang sama dengan pertanyaan agent di dalam pagar data dan jawaban user di luarnya
   (kata-kata user sendiri, bukan konten pihak luar).
4. **Follow-up memakai setelan yang tersimpan di run asal** (preset, folder, project), bukan config
   automation saat ini, dan batas waktu yang sama (review 10 menit, prompt 30 menit).
5. **Follow-up review tetap baca saja.** Memakai semua aturan ADR-0039: headless lewat
   `build_read_only_resume_command` (flag sama persis dengan review pertama, `--resume` menggantikan
   `--session-id`, mode `dontAsk`); dibuka di pane lewat `read_only_resume_command` (`manual`).
   Jawaban user tidak pernah membuka alat tulis. Ini aturan keras.
6. **Pertanyaan dari review diperlakukan sebagai buatan pihak luar** (PR orang lain bisa menyuntikkan
   teks): Ask menyebut "Asked by the agent reviewing owner/repo#N", label tombol teks polos, link
   menampilkan URL lengkap. Ask review tidak pernah diposting ke Slack atau GitHub.

## Konsekuensi

- Satu klik bisa memulai agent dengan izin penuh (`agent_prompt` = preset user apa adanya, "Opsi B").
  Ini diterima: pertanyaannya datang dari prompt user sendiri, dan klik adalah keputusan user yang
  eksplisit. Untuk review, risiko dibatasi oleh keputusan 5 dan 6 serta Send yang tetap wajib.
- Mengubah ini nanti (mis. membatasi izin follow-up `agent_prompt`) mengubah perilaku yang sudah
  diandalkan prompt automation user — karena itu dicatat sebagai ADR.
- Klik notifikasi tidak bisa dideteksi langsung; Lotus memakai "fokus dalam 10 menit setelah notifikasi
  Ask" sebagai gantinya (perlu dicek live). Plugin native diganti hanya bila cara ini terasa salah.
