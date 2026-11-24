import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';

/// Satu tombol di bar kerja terminal: sebuah teks, **atau** bentuk yang dilukis.
///
/// [glyph] ada karena satu tombol di bar ini tidak punya codepoint yang benar: `⌕` yang dulu
/// dipakai untuk "cari" adalah `U+2315 TELEPHONE RECORDER`. Diukur di HP operator 2026-08-12 —
/// codepoint itu **ada** di `NotoSansSymbols-Regular-Subsetted.ttf`, jadi ia tidak tofu; yang
/// salah bentuknya. Jadi bentuk itu dilukis (`SearchGlyph`).
///
/// Dikeluarkan dari `terminal_bar.dart` pada 2026-08-12 karena berkas itu menembus batas 300
/// baris repo ini. Memangkas komentarnya akan lebih murah dan salah: yang hilang justru alasan
/// kenapa satu tombol di bar ini dilukis dan yang lain tidak.
///
/// Sebuah kontrol di ujung jangkauannya tetap di tempatnya dan berhenti menanggapi alih-alih
/// menghilang: bar yang tombolnya bergeser saat dipakai harus dibaca ulang setiap kali
/// ditekan. [on] mengisinya, untuk satu kontrol yang memang melaporkan sebuah keadaan.
class BarButton extends StatelessWidget {
  const BarButton({
    required this.semantics,
    required this.enabled,
    required this.onTap,
    this.label,
    this.glyph,
    this.on = false,
    super.key,
  });

  /// Teks di tombol. Null ketika [glyph] yang dipakai; tepat satu dari keduanya ada.
  final String? label;
  final Widget? glyph;

  /// Yang dibacakan pembaca layar. Bukan turunan dari bentuknya — lihat [build].
  final String semantics;

  final bool enabled;
  final VoidCallback onTap;
  final bool on;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      enabled: enabled,
      toggled: on,
      label: semantics,
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          width: kMinHitTarget,
          height: kMinHitTarget,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: on ? t.text : null,
            borderRadius: BorderRadius.circular(8),
          ),
          // Dikecualikan dari semantik, dan angkanya diukur: tanpa ini node tombol ini
          // berlabel `Keys off — turn on\n⌨`, jadi pembaca layar membacakan hiasannya.
          // Dengan ini labelnya persis [semantics].
          child: ExcludeSemantics(
            child:
                glyph ??
                Text(
                  label!,
                  style: t.mono.copyWith(
                    fontSize: 13,
                    height: 1,
                    // `faint` is ornament-only by the token rules, and a spent control is
                    // exactly that: still visible, no longer a sentence.
                    color: on ? t.bg : (enabled ? t.dim : t.faint),
                  ),
                ),
          ),
        ),
      ),
    );
  }
}
