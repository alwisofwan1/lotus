# 0043 — Re-review menjawab temuan lama, bentuk reply Slack di instructions, dan run yang terputus dilanjutkan

- **Status:** Accepted
- **Date:** 2026-09-28
- **Deciders:** Alwi
- **Terkait:** ADR-0039 (review baca saja), ADR-0041, ADR-0042

## Konteks

Bukti dari `~/.lotus/automations.db` untuk `acme/acme-web#2511` (2026-09-28):

- 12:05 review pertama dikirim di `0dc8e66` (3 temuan). Author membalas di tiap thread GitHub dan
  menulis di Slack "All three points are fixed … could you check it again?".
- 12:15 pesan itu memicu run baru di `927ad011`, tapi agent mereview dari nol: tidak menyebut status
  3 temuan lama, tidak membaca balasan author (`gh pr view --comments` tidak memuat balasan thread
  review), dan memunculkan 2 pertanyaan baru di baris yang tidak dipersoalkan sebelumnya.
- 11:51 satu run berstatus `interrupted` karena Lotus ditutup untuk install ulang; tidak dilanjutkan.

Owner juga ingin mengatur bentuk reply Slack dari instructions automation.

## Keputusan

1. **Re-review.** Bila automation yang sama pernah mengirim review PR ini di head lain
   (`Store::last_sent_review`), run berikutnya adalah re-review:
   - agent diberi setiap temuan lama (komentar terkirim dan yang dipindah ke summary), balasan di
     thread review kita (`pulls/{n}/comments`, disaring `in_reply_to_id`), dan diff sejak head lama
     (`compare/{old}...{new}`; hilang karena force-push → seluruh PR dianggap berubah). Balasan dan
     diff berada di dalam pagar untrusted-data;
   - agent wajib menjawab `previous`: `fixed`, `answered` atau `not-fixed` per temuan. Engine yang
     menegakkannya (bukan schema), supaya re-review tetap boleh Ask;
   - temuan baru hanya di sekitar perubahan sejak head lama (hunk diff, termasuk konteks); di luar
     itu hanya blocker. Sisanya dipindah ke summary (`## Outside the changes since the last review`)
     dan tidak dihitung;
   - temuan lama yang `not-fixed` dihitung seperti temuan baru: verdict tidak lebih lunak, dan Approve
     (ADR-0042) ditolak engine;
   - summary GitHub diawali `## Since the last review (<sha>)` dengan status tiap temuan;
   - reply Slack: `… · 2/3 resolved · 1 still open · 1 new should-fix`;
   - saat Send, opsional (default aktif) membalas `Fixed ✅` / `Thanks, that answers it ✅` di thread
     GitHub temuan yang resolved. Best effort: review tetap terkirim bila balasan gagal.
2. **Bentuk reply di instructions.** Blok berpagar ` ```slack-reply ` dan ` ```slack-reply-lgtm `
   di dalam review instructions menentukan bentuk reply. Placeholder tetap: `{mention} {verdict} {pr}
   {counts} {points}`; teks owner dipakai apa adanya, isi dari agent tetap di-escape; placeholder yang
   kosong membawa jaraknya atau barisnya. Blok dibuang dari prompt agent, dan divalidasi saat
   disimpan (form, edit instructions, MCP).
3. **Resume.** Setiap run menyimpan payload-nya (`runs.payload_json`, migrasi v10). Saat start, run
   yang terputus dijalankan ulang **sekali** (`resumed = 1` tidak pernah di-resume lagi), kecuali
   automation-nya off, run-nya membuka pane, atau run itu Follow-up Run (Ask-nya yang kembali).

## Konsekuensi

- Follow-up Run dari Ask di tengah re-review belum membawa konteks re-review (review biasa).
- Thread di luar 100 komentar pertama PR tidak terbaca (satu halaman API).
- Diff "sejak" memakai compare tiga-titik GitHub: merge dari base branch ikut terlihat sebagai perubahan.
