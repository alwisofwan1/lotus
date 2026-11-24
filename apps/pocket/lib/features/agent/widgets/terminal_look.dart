import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../shared/tactile.dart';
import '../terminal_geometry.dart';
import 'bar_button.dart';
import 'terminal_metrics.dart';

/// Cara pane ini **terlihat**: seberapa besar selnya, dan bagaimana ia dipasang di layar.
///
/// **Ada karena bar-nya tidak muat, dan itu diukur bukan diduga.** Temuan §9 no. 9 di
/// `revamp-audit.html` menghitung di kertas bahwa set kontrol lengkap butuh lebih dari 360dp;
/// tesnya membuktikannya pada 2026-08-12 — **luap 16px** dengan keys mati dan **44px** dengan
/// keys hidup. Empat kontrol pindah ke sini: `FIT`, `1:1`, `A−`, `A+`. Delapan target jadi
/// lima, dan barisnya lega bahkan di konfigurasi terburuk.
///
/// **Pembelahannya bukan soal mana yang jarang dipakai, melainkan soal jenis.** Yang tinggal
/// di bar adalah *tindakan* — kirim tuts, cari, buka palet, penuhi layar. Yang pindah ke sini
/// adalah *setelan tampilan*: ia diatur sekali sampai nyaman, lalu tidak disentuh lagi. Itu
/// juga yang membuat kepindahan ini aman untuk `⌨`, satu-satunya kontrol yang audit sebut
/// wajib tidak boleh diragukan: ia **tidak** ikut pindah.
///
/// Inline, bukan sheet modal, mengikuti `FindBar` di berkas sebelahnya. Sebuah sheet adalah
/// route tersendiri, jadi ia tidak akan ikut rebuild ketika `RawTerminal` mengubah ukuran
/// font — dan sheet yang menyimpan salinan angkanya sendiri adalah dua sumber kebenaran untuk
/// satu fakta.
class TerminalLook extends StatelessWidget {
  const TerminalLook({
    required this.fit,
    required this.zoom,
    required this.fontSize,
    required this.onZoom,
    required this.onFontSize,
    super.key,
  });

  final TerminalFit fit;
  final TerminalZoom zoom;
  final double fontSize;
  final ValueChanged<TerminalZoom> onZoom;
  final ValueChanged<double> onFontSize;

  bool get _canShrink => fontSize > terminalFontSteps.first;
  bool get _canGrow => fontSize < terminalFontSteps.last;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      decoration: BoxDecoration(
        color: t.raise,
        border: Border(top: BorderSide(color: t.line)),
      ),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Row(
        children: [
          // Tidak ada yang bisa dipilih selama pane-nya dibungkus ke layar: permukaannya
          // **adalah** layar itu, jadi tidak ada cara kedua untuk melihatnya. Aturan yang
          // sama seperti sebelum pindah ke sini.
          if (fit == TerminalFit.pinned) ...[
            _zoomOption(t, 'FIT', TerminalZoom.fit),
            _zoomOption(t, '1:1', TerminalZoom.actual),
            const SizedBox(width: 12),
          ],
          const Spacer(),
          BarButton(
            label: 'A−',
            semantics: 'Smaller text',
            enabled: _canShrink,
            onTap: () => _step(-1),
          ),
          // Angkanya disebut, bukan disimpan sendiri. Di bar dulu ia tidak pernah muat;
          // di sini ada ruang, dan sebuah kontrol yang mengubah ukuran tanpa mengatakan
          // ukurannya memaksa operator menghitung dengan mata.
          SizedBox(
            width: 44,
            child: Text(
              '${fontSize.toStringAsFixed(0)}px',
              textAlign: TextAlign.center,
              style: t.mono.copyWith(fontSize: 11, color: t.dim),
            ),
          ),
          BarButton(
            label: 'A+',
            semantics: 'Larger text',
            enabled: _canGrow,
            onTap: () => _step(1),
          ),
        ],
      ),
    );
  }

  Widget _zoomOption(AppTokens t, String label, TerminalZoom option) =>
      BarButton(
        label: label,
        semantics: label == 'FIT' ? 'Fit to screen' : 'Actual size',
        enabled: zoom != option,
        on: zoom == option,
        onTap: () {
          Tactile.chose();
          onZoom(option);
        },
      );

  /// Satu langkah pada tangga ukuran, dan berhenti di ujungnya tanpa menghilang.
  void _step(int by) {
    final from = terminalFontSteps.indexOf(fontSize);
    final next = (from + by).clamp(0, terminalFontSteps.length - 1);
    if (next == from) return;
    Tactile.chose();
    onFontSize(terminalFontSteps[next]);
  }
}
