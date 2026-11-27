import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';

/// Agen yang menunggu operator, di puncak layar pertama.
///
/// **Blok inilah yang memikul properti yang ADR-3 revisi pertama lindungi**, sekarang setelah
/// indeks project meletakkan agen satu tingkat di dalam: seorang agen yang menunggu tidak
/// pernah bisa duduk di balik satu ketukan. Ia menyebut **agen dan pertanyaannya**, bukan
/// project-nya, karena yang dituju operator adalah jawabannya — bukan tempatnya.
///
/// **Ia hanya ada ketika ada yang menunggu.** Itu bukan penghematan piksel, itu yang membuat
/// `Nobody needs you` di strap menjadi keterangan alih-alih lelucon: kalimat itu dicetak tepat
/// ketika blok ini tidak ada.
///
/// Amber di tepi, latar, dan nama semuanya menandai satu hal yang sama — seorang agen menunggu
/// operator — jadi aturan `MVP.md` tidak dilanggar. Yang dilarang adalah amber untuk hal
/// *lain*, bukan amber di lebih dari satu tempat untuk satu hal.
class NeedsYou extends StatelessWidget {
  const NeedsYou({
    required this.waiting,
    required this.onOpen,
    required this.where,
    super.key,
  });

  /// Dalam urutan `FleetStore`, jadi yang paling mendesak paling dekat dengan jempol.
  /// Tidak pernah kosong: pemanggilnya tidak membangun blok ini ketika tidak ada isinya.
  final List<Cell> waiting;

  final void Function(Cell cell) onOpen;

  /// `CNVS`, atau `Lotus · vps` — project-nya, dengan mesin hanya ketika ia membedakan
  /// sesuatu. Diserahkan sebagai fungsi supaya aturan itu tetap tinggal di satu tempat.
  final String Function(Cell cell) where;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      margin: const EdgeInsets.fromLTRB(12, 18, 12, 0),
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: t.waiting.withValues(alpha: 0.045),
        border: Border.all(color: t.waiting.withValues(alpha: 0.28)),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 11, 14, 9),
            child: Text(
              'Needs you',
              style: t.mono.copyWith(
                fontSize: 10,
                letterSpacing: 0.16 * 10,
                color: t.waiting,
              ),
            ),
          ),
          for (final cell in waiting) _row(t, cell),
        ],
      ),
    );
  }

  Widget _row(AppTokens t, Cell cell) => InkWell(
    onTap: () => onOpen(cell),
    child: Container(
      decoration: BoxDecoration(
        border: Border(
          top: BorderSide(color: t.waiting.withValues(alpha: 0.16)),
        ),
      ),
      constraints: const BoxConstraints(minHeight: kMinHitTarget),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      // Ketiga teks di baris ini bisa panjang, dan dua di antaranya sempat tidak dibatasi
      // apa pun — sebuah project bernama `project-with-a-long-name-0` meluapkan blok ini
      // 80px ke kanan di lebar 360. Ditemukan oleh tesnya, bukan di HP.
      //
      // Mockup-nya tidak menjawab ini: ia memakai `flex:none` untuk keduanya persis seperti
      // kode ini, lalu memasang `overflow:hidden` pada bloknya — jadi ia **memotong** dengan
      // diam alih-alih memutuskan mana yang mengalah. Jadi ini keputusan Lotus, bukan
      // terjemahan: **pertanyaannya yang paling berhak atas ruang sisa** (ia satu-satunya
      // yang operator harus baca untuk bisa menjawab), nama mengalah lebih dulu dengan
      // elipsis, dan `where` paling akhir. Batasnya fraksi, bukan piksel tetap, supaya
      // sebuah tablet tidak mewarisi angka yang dipilih untuk 360.
      child: LayoutBuilder(
        builder: (context, box) => Row(
          children: [
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth * 0.42),
              child: Text(
                cell.title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: t.serif.copyWith(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  letterSpacing: -0.2,
                  color: t.text,
                ),
              ),
            ),
            const SizedBox(width: 12),
            // Pertanyaannya, dalam sans: ini yang agen *katakan*, bukan yang ia lakukan.
            // Baris yang menunggu adalah satu-satunya tempat preview bukan output mesin.
            Expanded(
              child: Text(
                cell.lastOutputPreview ?? '',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: t.ui.copyWith(fontSize: 13, color: t.dim),
              ),
            ),
            const SizedBox(width: 10),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: box.maxWidth * 0.34),
              child: Text(
                where(cell),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: t.mono.copyWith(fontSize: 10.5, color: t.muted),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
