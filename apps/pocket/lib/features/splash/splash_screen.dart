import 'package:flutter/material.dart';

import '../../app/theme/app_tokens.dart';
import '../shared/lotus_mark.dart';

/// The first frame Flutter draws, on the same colour the OS launch window already
/// holds — so the handover from `launch_background.xml` to Dart is invisible.
///
/// It draws three things and decides nothing. How long it stays up, and what [line]
/// says, belong to `SplashGate` in `app/`: this is `features/`, and the rule there is
/// render and copy only.
///
/// **The mark blooms and then stops.** A spinner means *waiting*; something that opens
/// and holds means *ready*, and that stillness is the cue that the next screen is
/// about to arrive. It is also honest — by the time the bloom finishes there is
/// usually nothing left to wait for.
class SplashScreen extends StatefulWidget {
  const SplashScreen({required this.line, super.key});

  /// One short, lower-case, true sentence about what is happening — `reading
  /// keychain`, `2 machines · dialing`. Never a percentage and never `Loading…`: this
  /// app has a Diagnostics screen because it refuses to hide state, and a splash that
  /// invented progress would contradict the whole discipline.
  final String line;

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> with SingleTickerProviderStateMixin {
  /// 760 ms covers the eight staggered petals (610 ms) plus the core.
  static const Duration _bloom = Duration(milliseconds: 760);

  /// **The mark is already half open when this screen appears, and it is drawn at the
  /// size the system just drew it.** Both were found by recording a cold start rather
  /// than by reasoning about the widget: Android's platform SplashScreen draws the
  /// launcher icon — which is now this same mark — at roughly 116 dp, holds it, then
  /// cross-fades to the app. A mark that then blooms from nothing at 74 dp reads as the
  /// logo collapsing and reopening, which is worse than no animation at all.
  ///
  /// Starting at 0.55 keeps a gesture without restarting one: the outer petals are
  /// already there, the last few arrive, and the core lands. On a device that shows no
  /// icon first, this is simply a shorter bloom.
  static const double _handover = 0.55;

  /// Matches what the platform splash draws, so the mark does not change size across
  /// the handover. Measured off the recording, not taken from a spec.
  static const double _markSize = 116;

  /// How far below the screen's centre the wordmark sits: half the mark, a 22 dp gap,
  /// and half the wordmark's own line. Written as a number because the mark's position
  /// is now fixed to the centre and must not depend on what is drawn beneath it.
  static const double _wordmarkDrop = _markSize / 2 + 22 + 14;

  late final AnimationController _c = AnimationController(vsync: this, duration: _bloom);

  @override
  void initState() {
    super.initState();
    // Drawn already open when the OS says animations are off. There is no slow
    // variant: half a gesture on a screen whose job is to cover a gap makes the gap
    // feel longer, not shorter.
    if (WidgetsBinding.instance.platformDispatcher.accessibilityFeatures.disableAnimations) {
      _c.value = 1;
    } else {
      _c.forward(from: _handover);
    }
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      backgroundColor: t.bg,
      body: Stack(
        children: [
          // **The mark is centred on the screen, and the wordmark is hung off that
          // centre rather than sharing a column with it.** A `Column` would push the
          // mark up by half the wordmark's height — about 22 dp — and the platform
          // splash's icon is dead centre, so the two marks cross-faded past each
          // other as a visible double exposure for ~130 ms. Seen on a recording; the
          // widget looked correct either way.
          Center(
            child: AnimatedBuilder(
              animation: _c,
              builder: (_, _) => LotusMark(
                color: t.text.withValues(alpha: 0.82),
                size: _markSize,
                bloom: _c.value,
              ),
            ),
          ),
          Center(
            child: Transform.translate(
              offset: const Offset(0, _wordmarkDrop),
              child: _wordmark(t),
            ),
          ),
          Positioned(
            left: 0,
            right: 0,
            bottom: 52,
            child: Text(
              widget.line,
              textAlign: TextAlign.center,
              style: t.mono.copyWith(
                fontSize: 10,
                letterSpacing: 1.3,
                // `faint` is ornament-only for text, but this is the one place the
                // rule is met from the other side: the line is a whisper by intent,
                // and `muted` is the floor for anything genuinely readable.
                color: t.muted,
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Arrives last, and is the only thing on this screen that moves in a straight
  /// line — 6 px up as it fades in, once the petals have settled.
  Widget _wordmark(AppTokens t) {
    final entry = CurvedAnimation(
      parent: _c,
      curve: const Interval(0.82, 1, curve: Curves.easeOut),
    );

    return AnimatedBuilder(
      animation: entry,
      builder: (_, child) => Opacity(
        opacity: entry.value,
        child: Transform.translate(offset: Offset(0, 6 * (1 - entry.value)), child: child),
      ),
      child: Text(
        'LOTUS',
        style: t.serif.copyWith(
          fontSize: 21,
          fontWeight: FontWeight.w500,
          letterSpacing: 6.3,
          color: t.text.withValues(alpha: 0.92),
        ),
      ),
    );
  }
}
