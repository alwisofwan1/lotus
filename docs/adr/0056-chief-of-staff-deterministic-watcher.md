# 0056 — Chief of Staff adalah watcher dengan aturan tetap, LLM hanya menilai

- **Status:** Accepted (belum diimplementasi)
- **Date:** 2026-10-13
- **Deciders:** Alwi
- **Memperkuat:** [ADR-0051](0051-factory-roles-and-intake.md) §5 (urutan tahap milik state machine
  Rust, bukan agen foreman).
- **Terkait:** `plans/factory-chief-of-staff/issues/03-chief-of-staff-form.md`, riset
  `plans/factory-chief-of-staff/research/prior-art-pr-feedback.md`.

## Konteks

Chief of Staff menjaga Factory Run dari atas: membaca feedback di Factory PR dan mengawasi run yang
menunggu, macet, atau menghabiskan budget. Ada dua bentuk: agen LLM yang hidup lama dan memutuskan
sendiri, atau watcher dengan aturan tetap yang memanggil LLM hanya untuk menilai. Prior art: vendor
memakai routing dengan aturan tetap dan LLM hanya untuk klasifikasi dan draf; satu-satunya foreman LLM
(Warp) dilewati di jalur komentar PR.

## Keputusan

1. **Watcher dengan aturan tetap.** Aksi engine (revisi, Resume, Abort, dan sebagainya) dipilih oleh
   aturan di kode, bukan oleh LLM.
2. **LLM hanya menilai satu hal per panggilan**: memberi label pada satu komentar, menulis satu draf
   balasan. Panggilan sekali jalan, read-only, tanpa MCP, tanpa sesi; semua konteks dikirim setiap
   kali; hasil berupa JSON terstruktur. Hasil yang tidak valid jatuh ke "Needs you", tidak pernah ke
   aksi.
3. **Satu aktor di UI bernama Chief of Staff**, dengan log kegiatan. Setiap entri log disimpan di record
   Factory Run yang dibicarakannya, jadi bertahan saat restart.
4. **Diatur per repo** lewat `.lotus/factory/agents/chief-of-staff.md` (preset, model, prompt), dibaca
   dari `origin/<base>` seperti peran lain. Default: model murah. Chief of Staff **bukan** tahap run:
   tidak masuk urutan triage → spec → implement → review → handoff.
5. **Aksi engine hanya diusulkan** (ditambahkan 2026-10-13, tiket "Run supervision"). Resume, Raise
   cap, Abort, Try again selalu butuh satu klik pengguna di "Needs you", dengan alasan. Satu-satunya
   pengecualian: memulai Revision Run untuk item yang jelas (`change` / `nit` / CI), lihat ADR-0057 dan
   tiket "Classifying review feedback".

## Alternatif yang ditolak

- **Aksi engine otomatis (mis. Resume setelah restart)**: Raise cap adalah uang, Abort tidak bisa
  dibatalkan, dan Resume otomatis masih berisiko run ganda (recovery-hardening slice 1–3 belum ada).
- **Agen LLM yang hidup lama**: fleksibel, tetapi mahal, sulit dites, sulit di-resume, dan state-nya
  tersembunyi di sesi. Sama alasannya dengan penolakan foreman di ADR-0051.
- **Satu sesi LLM per PR yang di-resume**: konteks lebih kaya, tetapi state tersembunyi dan hasilnya
  tidak bisa diulang dalam test.
- **Setting global di aplikasi**: tidak bisa memuat norma review per repo, dan tanpa versi.
- **Tanpa aktor; tanda tersebar di Run detail dan Board**: pengguna tidak tahu siapa yang mengusulkan.

## Konsekuensi

- Aturan routing bisa dites tanpa LLM; panggilan LLM bisa diganti fake di test.
- Biaya per PR terbatas: jumlah panggilan = jumlah komentar baru + draf, bukan durasi sesi.
- Parser definisi Factory perlu menerima `chief-of-staff.md` di folder agents tanpa menjadikannya
  `Role` tahap.
- Record Factory Run butuh daftar entri log Chief of Staff.
