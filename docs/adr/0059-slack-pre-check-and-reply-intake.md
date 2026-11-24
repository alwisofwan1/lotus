# 0059 — Slack: cek PR sebelum bereaksi, dan baca dulu maksud balasan di thread

- **Status:** Accepted
- **Date:** 2026-10-15
- **Deciders:** Alwi
- **Mempersempit:** ADR-0041 keputusan 1 ("setiap pemicu sudah berarti permintaan") untuk balasan
  thread. Mention di pesan dengan link PR sendiri dan 👀 milik user tidak berubah.
- **Terkait:** ADR-0039 (Send tetap manusia), ADR-0052 (run review)

## Konteks

Lotus bereaksi sebagai user. Bukti dari `~/.lotus/automations.db` per 2026-10-15 (automation "Orbit
reviews"): 95 dari 241 run di-skip. 41 karena "this is your own pull request", 39 karena "already
merged". Dua sebab:

1. `submit` memasang 👀 begitu engine menerima run; `gate` baru menolak sesudahnya, lalu `watch`
   memasang ⏭️. Jadi Lotus memberi 👀 lalu ⏭️ pada pesan orang yang cuma berterima kasih.
2. `thread_event` menambahkan link PR thread ke **setiap** balasan. Balasan apa pun yang menyebut user
   atau timnya jadi permintaan review: "Reviewed! LGTM @me", "I re-reviewed both" (di thread PR milik
   user), "Merged, thank you @team". Beberapa balasan seperti itu bahkan menjalankan review penuh
   ("thank you very much! I'll keep it on all envs and merge the PR :pray:").

Permintaan review ulang yang sungguhan tetap ada dan harus jalan: "Resolved! Please review again",
"Please re-review the fix", "the suggestion has been implemented. Please check it, ya", "Ready for
re-review", dan laporan tanpa kata minta seperti "All findings are fixed and replied to on both PRs".
Tim menulis dalam Inggris, Indonesia (tolong/mohon cek/review lagi, sudah diperbaiki), dan sedikit
Jepang (-san, :dogeza:).

## Keputusan

1. **Pre-check sebelum reaksi apa pun.** `SlackListener::submit` memanggil `pr_review::precheck`
   (ambil PR, lalu `not_reviewable`) sebelum mengirim run. PR yang tertutup, merged, draft, atau milik
   akun automation: tidak ada run, tidak ada 👀, tidak masuk antrean retry, satu baris log. Aturannya
   satu fungsi, `not_reviewable`, yang juga dipakai `gate`, jadi keduanya tidak bisa berbeda.
   - **Pengecualian:** 👀 milik user sendiri (`by_me`) tidak dicek. Run tetap dibuat, di-skip dengan
     alasannya, dan ⏭️ muncul, supaya user tahu kenapa tidak terjadi apa-apa.
   - Tombol Review dan sumber lain memakai `submit_pr`/`submit_round` apa adanya: run di-skip dengan
     alasan yang tampil di UI. `RunNowError::NotReviewable` hanya dihasilkan `precheck`.
2. **Intake balasan** (`slack/intake.rs`), hanya untuk balasan yang mendapat link PR dari thread
   (balasan dengan link sendiri tetap memakai aturan lama). Urutannya, murah ke mahal, dan berhenti di
   tahap pertama yang yakin:
   1. **Fakta.** Requester thread (`root_requester`, orang pertama yang meminta di thread itu) adalah
      kemungkinan besar penulis PR. Balasannya masuk ke aturan penuh di bawah. Balasan orang lain
      (rekan, ko-author, penulis PR yang di-post kolega) **tidak dihentikan mentah-mentah**: ia hanya
      lolos bila aturan menemukan permintaan eksplisit (confidence 1,0) dan tidak ada sinyal laporan
      (merged, LGTM, "I reviewed", "I've feedback on"). Jalur implisit "fixed/addressed" (0,9) dan model
      tidak berlaku untuk mereka; selain itu hasilnya diskusi. Tanpa mention: bukan permintaan.
   2. **Aturan.** Frasa multibahasa; permintaan eksplisit ("please re-review", "review lagi",
      "ready for re-review", "PTAL", "tolong/mohon cek lagi") mengalahkan sinyal negatif kuat (merged,
      LGTM/approved, "I reviewed"), keduanya mengalahkan laporan "sudah diperbaiki" tanpa kata minta
      (confidence 0.9), lalu terima kasih saja. Kata dicocokkan utuh: "re-reviewed" bukan "re-review"; "thanks for the re-check" bukan permintaan.
   3. **Model murah**, hanya bila aturan ragu. `AgentClassifier` lewat `AgentRunner`: `Access::Sealed`,
      tanpa tool, tanpa sesi, JSON schema, preset automation dengan `--model haiku` (`CHEAP_MODEL`).
      Prompt memuat balasan, siapa penulisnya dibanding requester dan penulis PR, pesan pertama thread,
      dan balasan Lotus terakhir. Bertindak hanya bila `rereview_request` dengan confidence ≥ 0,75.
      Batas 30 detik.
   4. **Ragu, error, atau timeout: tidak melakukan apa-apa**, tanpa run dan tanpa reaksi, dengan log.
      Tanpa classifier terpasang (default, juga untuk tes), aturan saja yang memutuskan.
3. **Balasan tetap dicatat** sebagai review feedback apa pun maksudnya, supaya review berikutnya
   melihatnya. Pesan sudah ditandai "dilihat" sebelum intake, jadi satu balasan dibaca sekali (model
   tidak dipanggil ulang tiap catch-up).
4. Keputusan dicatat satu baris di log: `intent`, `confidence`, `source` (facts|rules|model), `reason`.

## Konsekuensi

- Tidak ada lagi 👀/⏭️ pada pesan orang yang tidak akan menghasilkan review. Satu panggilan GitHub
  tambahan per permintaan; untuk balasan thread yang diterima intake, dua (cek, lalu submit).
- Mention biasa di balasan tanpa kata minta dan tanpa laporan perbaikan dari requester kini tidak
  menjalankan review, kecuali model yakin. User masih bisa memakai 👀 atau tombol Review.
- Requester diambil dari konteks thread yang tersimpan (`Store::thread_requester`), bukan dipetakan
  ke login GitHub: Lotus tidak punya pemetaan Slack ke GitHub. `remember_pr_thread` kini menyimpan
  `root_requester` terpisah dari `requester` (yang terakhir meminta, dipakai Send untuk menandai):
  sebelumnya setiap balasan yang dijalankan menimpa requester dengan penulis balasan, sehingga
  requester thread tak bisa dipercaya. Baris lama (tanpa `root_requester`) jatuh ke `requester`.
- Bukti replay 2026-10-15 atas 296 balasan di DB (65 menyebut user/tim): data lama sudah tercemar
  penimpaan itu, jadi fakta hanya diuji sebagai skenario terburuk (semua balasan dianggap bukan
  requester): 18 dimulai, semuanya permintaan sungguhan; 47 tidak.
- Keputusan intake belum disimpan di database, hanya di log; menyimpannya butuh tabel atau kolom baru.
