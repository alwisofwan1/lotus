import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/theme.dart';
import 'swipe_to_close.dart';

/// Tombol yang mengakhiri satu agen, tersingkap oleh geseran dan **ditahan** untuk komit.
///
/// **Tipe, bukan ikon.** Tong sampah adalah elemen paling generik yang bisa ditaruh di sini,
/// dan di app ini ia juga salah: tidak ada yang terhapus, satu pane yang diakhiri. Dua baris
/// tipe memakai dua suara yang app ini sudah punya — serif untuk siapa, mono untuk apa — jadi
/// kontrolnya terlihat seperti Lotus alih-alih seperti daftar mana pun.
///
/// **Ditahan, bukan diketuk, dan itu yang menggantikan dialognya.** `Close` hari ini meminta
/// konfirmasi karena ia mengakhiri agen. Satu ketukan sesudah geser terlalu tipis: satu
/// ketukan salah sasaran pada target selebar ini tetap mengakhirinya. Menahan memindahkan
/// deliberasi **ke dalam kontrolnya**, jadi tidak perlu permukaan kedua — dan pembatalannya
/// adalah hal paling alami yang bisa dilakukan jari, yaitu melepas.
///
/// **Tetap tanpa undo.** Host membunuh pane-nya; tidak ada yang bisa dibatalkan. Menawarkan
/// `UNDO` yang tidak bekerja lebih buruk daripada menahan yang jujur.
class CloseAction extends StatefulWidget {
  const CloseAction({
    required this.agent,
    required this.progress,
    required this.onCommit,
    super.key,
  });

  final String agent;

  /// Sejauh mana barisnya sudah tergeser, 0..1. Dipakai untuk parallax, skala, dan kekuatan
  /// tint — jadi tiga keadaan (petunjuk, terkunci, komit) benar-benar bertahap.
  final double progress;

  final VoidCallback onCommit;

  /// Lama tahan untuk komit.
  static const Duration holdFor = Duration(milliseconds: 450);

  /// Berapa jauh tombolnya tertinggal dari jari. Bergerak lebih lambat membuatnya terbaca
  /// sebagai benda yang ditarik masuk alih-alih lapisan yang kebetulan tersingkap.
  static const double parallax = 26;

  @override
  State<CloseAction> createState() => _CloseActionState();
}

class _CloseActionState extends State<CloseAction>
    with SingleTickerProviderStateMixin {
  late final AnimationController _hold = AnimationController(
    vsync: this,
    duration: CloseAction.holdFor,
    reverseDuration: SwipeToClose.closeIn,
  )..addStatusListener(_onHold);

  @override
  void dispose() {
    _hold.dispose();
    super.dispose();
  }

  void _onHold(AnimationStatus status) {
    if (status != AnimationStatus.completed) return;
    // Lebih tegas dari denyut di ambang, karena ia melaporkan hal yang berbeda: yang di
    // ambang mengatakan *melepas sekarang akan mengunci*, yang ini mengatakan *sudah*.
    HapticFeedback.mediumImpact();
    // Dikembalikan ke nol lebih dulu, supaya baris yang ternyata bertahan (host menolak,
    // gerbang dibatalkan) tidak tertinggal dengan sapuan penuh yang mengklaim sudah selesai.
    _hold.value = 0;
    widget.onCommit();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final p = widget.progress;

    return Semantics(
      container: true,
      button: true,
      // Menyebut agennya, karena `Close` sendirian tidak memberi tahu pembaca layar apa yang
      // akan berakhir — dan menyebut caranya, karena satu ketukan di sini tidak melakukan
      // apa pun.
      //
      // `container` supaya ia benar-benar menjadi satu node, dan isinya dikecualikan: dua
      // baris tipe di dalam tombol mengucapkan hal yang sama dengan label ini, dan membacakan
      // keduanya berarti mengatakannya dua kali.
      label: 'Hold to close ${widget.agent}',
      child: ExcludeSemantics(
        child: GestureDetector(
          onTapDown: (_) => _hold.forward(),
          onTapUp: (_) => _hold.reverse(),
          onTapCancel: () => _hold.reverse(),
          child: Opacity(
            opacity: (p / 0.22).clamp(0.0, 1.0),
            child: Transform.translate(
              offset: Offset((1 - p) * CloseAction.parallax, 0),
              child: Transform.scale(
                scale: 0.88 + p * 0.12,
                child: Container(
                  width: SwipeToClose.actionWidth - 8,
                  margin: const EdgeInsets.fromLTRB(0, 8, 8, 8),
                  clipBehavior: Clip.antiAlias,
                  decoration: BoxDecoration(
                    color: t.error.withValues(alpha: 0.09 + p * 0.09),
                    borderRadius: BorderRadius.circular(20),
                  ),
                  child: Stack(
                    fit: StackFit.passthrough,
                    children: [_sweep(t), _label(t, p)],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /// Sapuan yang tumbuh selama ditahan. Ini bagian yang membuat gerakannya bisa dipelajari
  /// sekali dan dipahami selamanya: ia mengatakan *berapa lama lagi*.
  ///
  /// Diskalakan, bukan dilebarkan: lebar adalah properti tata letak, dan menganimasikannya
  /// berarti me-layout ulang tiap frame.
  Widget _sweep(AppTokens t) => AnimatedBuilder(
    animation: _hold,
    builder: (context, _) => Align(
      alignment: Alignment.centerLeft,
      child: FractionallySizedBox(
        widthFactor: 1,
        child: Transform.scale(
          scaleX: _hold.value,
          alignment: Alignment.centerLeft,
          child: ColoredBox(color: t.error.withValues(alpha: 0.30)),
        ),
      ),
    ),
  );

  Widget _label(AppTokens t, double p) => Column(
    mainAxisAlignment: MainAxisAlignment.center,
    children: [
      Text(
        widget.agent,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: t.serif.copyWith(
          fontSize: 15,
          fontWeight: FontWeight.w600,
          letterSpacing: -0.2,
          color: t.error,
        ),
      ),
      // Muncul hanya setelah terkunci: sebelum ambang, satu ikon dan satu nama sudah
      // mengatakan apa yang akan terjadi; kata itu mengatakan *kapan*.
      Opacity(
        opacity: p >= 0.5 ? 1 : 0,
        child: Text(
          'HOLD TO CLOSE',
          maxLines: 1,
          style: t.mono.copyWith(
            fontSize: 8.5,
            letterSpacing: 0.12 * 8.5,
            color: t.error.withValues(alpha: 0.62),
          ),
        ),
      ),
    ],
  );
}
