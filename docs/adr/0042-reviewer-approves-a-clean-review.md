# 0042 — Reviewer boleh Approve review yang tidak menemukan apa pun; thread Slack diberi LGTM

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Alwi
- **Mengubah:** `plans/automation/PLAN.md` § 2.4 Q12 ("AI tidak pernah Approve") — kini: AI tetap tidak
  pernah Approve; **reviewer** boleh, dengan satu tombol, hanya untuk review yang bersih
- **Terkait:** ADR-0039 (review baca saja — tetap berlaku penuh), ADR-0041

## Konteks

PR yang dinilai "looks good" tetap harus dikirim sebagai COMMENT, lalu reviewer membuka GitHub untuk
Approve secara manual, dan thread Slack menerima reply panjang. Alwi ingin PR yang bersih selesai
dalam satu klik: Approve di GitHub dan `@peminta LGTM ✅ repo#n` di thread.

Risiko yang menentukan bentuknya: agent membaca teks PR yang ditulis orang lain. Isi PR bisa
menyuntikkan instruksi (prompt injection) agar agent menyimpulkan "looks good". Approval atas nama
akun reviewer dapat membuka merge di branch protection. Approval otomatis tanpa manusia ditolak.

## Keputusan

1. **Hanya tombol reviewer yang meng-Approve.** `SendRequest.approve` diisi dari tombol "Approve on
   GitHub"; agent tidak punya field untuk memintanya (schema review tetap `additionalProperties:
   false`, dan agent yang mencoba lewat field tambahan tetap menggagalkan run).
2. **Hanya review yang bersih.** Engine memeriksa ulang saat Send, apa pun yang ditampilkan panel:
   tidak ada komentar (termasuk tanpa severity), tidak ada temuan yang dipindah dari luar diff
   (`off_diff_severities` kosong), dan verdict efektif `looks-good`. Selain itu Send ditolak
   (`SendError::Invalid`) dan tidak ada yang diposting.
3. **Approve diposting tanpa komentar per baris**: `approval_request_body` (event `APPROVE`,
   `comments: []`), di commit yang direview, seperti COMMENT. `review_request_body` tetap selalu COMMENT.
4. **Thread Slack:** draft yang terkirim ditandai `approved: true`; reply-nya menjadi
   `<@peminta> LGTM ✅ <review|repo#n>`, tanpa verdict, hitungan, atau poin.
5. Panel menampilkan "Approve on GitHub" (utama) dan "Send as comment" hanya untuk review bersih;
   review dengan temuan hanya punya "Send to GitHub".

## Konsekuensi

- Approval tetap keputusan manusia per PR; agent yang tertipu hanya bisa membuat draft bersih, yang
  masih harus dibaca dan di-Approve oleh reviewer.
- Kebijakan tim (misalnya approval harus dari reviewer yang membaca kodenya) tetap tanggung jawab
  reviewer yang menekan tombol.

## Amandemen 2026-10-14 — saran (suggestion), Slack saja, template menurut verdict

Retro 188 run (2026-10-14): PR yang "LGTM dengan saran kecil" tidak bisa di-Approve, karena satu
komentar apa pun menutup Approve. Alwi juga ingin bisa membalas di Slack saja.

1. **Severity baru `suggestion`**: perbaikan opsional yang boleh dilewati penulis. Tidak pernah
   menaikkan verdict (`Verdict::at_least` mengabaikannya). Agent boleh menulisnya; prompt melarang
   memakainya untuk hal yang wajib diubah.
2. **Keputusan 2 dilonggarkan**: engine mengizinkan Approve bila **semua** temuan adalah
   `suggestion` — komentar baris, temuan di luar diff, dan temuan lama yang masih terbuka. Komentar
   tanpa severity, question, should-fix, atau blocker tetap menolak Approve. Coverage tetap harus
   `complete`, verdict efektif tetap `looks-good`.
3. **Keputusan 3 diganti**: `approval_request_body` memposting komentar saran itu bersama APPROVE.
4. **Keputusan 5 diganti**: panel punya "Send to" dengan dua switch (GitHub, thread Slack). GitHub
   punya pilihan Comment / Approve; **default selalu Comment**, Approve harus dipilih reviewer
   sendiri, dan tidak pernah diingat. Pilihan switch diingat per automation (localStorage).
   Memilih LGTM saat masih ada temuan baris bertanya sekali: "Ubah N temuan jadi saran?".
5. **Slack saja**: `SendRequest.post_github = false` tidak memposting apa pun ke GitHub; draft
   ditandai terkirim dengan link PR (`github: "skipped"`), lalu thread Slack dibalas. Approve
   ditolak tanpa GitHub. Cek PR basi (stale) tetap berlaku.
6. **Keputusan 4 diganti**: template Slack dipilih menurut **verdict**, bukan tombol Approve.
   Review `looks-good` — di-Approve, dikirim sebagai komentar, atau Slack saja — memakai
   `slack-reply-lgtm`; `{counts}` di sana menyebut jumlah saran ("2 suggestions"), dan kosong
   bila tidak ada saran. Baris template yang semua placeholder-nya (selain `{mention}`) kosong
   dibuang beserta kata-katanya, jadi "Left {counts}, all optional" hanya muncul bila ada saran.
7. Kalau GitHub dimatikan dan masih ada komentar baris, kartu memperingatkan bahwa komentar itu
   tidak terkirim ke mana pun.

## Amandemen 2026-10-14 (2) — mode otomatis, Request changes, dismiss

Alwi ingin review bisa jalan penuh tanpa tombol Send, dan bisa memakai semua aksi review GitHub.
Ini mengganti "approval tetap keputusan manusia per PR" — **hanya** untuk automation yang menyalakan
mode otomatis.

1. **Request changes**: `SendRequest.request_changes` memposting `REQUEST_CHANGES`. Engine menolaknya
   bila tidak ada blocker atau should-fix (baru, atau temuan lama yang masih terbuka). Approve dan
   Request changes tidak bisa bersamaan.
2. **Mode otomatis** (`PrReviewConfig.auto_send`, default **mati**): run review yang sukses langsung
   dikirim, termasuk balasan Slack bila PR diminta dari Slack. Semua aksi atas nama akun automation.
3. **Lotus yang memilih aksi, bukan agent** (`pr_review::auto::decide`). Agent membaca teks tulisan
   penulis PR, jadi agent yang tertipu tidak boleh bisa meng-approve sendiri:
   - ada blocker/should-fix → Request changes;
   - verdict `looks-good` dan semua temuan `suggestion` → Approve;
   - selain itu (pertanyaan) → Comment;
   - coverage bukan `complete`, tanpa summary, PR bergerak saat review, atau send ditolak → **ditahan**:
     draft menunggu Send seperti biasa, alasannya dicatat di draft (`auto_held`).
4. **Dismiss**: Request changes dari akun ini tetap memblokir PR sampai akun ini approve atau review itu
   di-dismiss. Setelah kiriman Comment (tidak ada lagi yang wajib diubah), Lotus men-dismiss Request
   changes miliknya yang masih berdiri (`PUT …/reviews/{id}/dismissals`). Dismiss bisa gagal tanpa hak
   tulis di repo; kegagalan dicatat, kiriman tetap sah.
5. **Risiko yang diterima**: teks di PR masih bisa menipu agent sampai menulis review bersih yang lengkap,
   lalu Lotus meng-approve. Batasnya: coverage harus `complete` dan semua temuan hanya saran. Untuk repo
   yang penulisnya tidak dipercaya, biarkan mode otomatis mati.

