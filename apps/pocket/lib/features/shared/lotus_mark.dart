import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// The Lotus mark: eight petals and a core, drawn as strokes only.
///
/// **Strokes, not fills, and that is the whole design constraint.** A filled shape has
/// to be read by its colour or its value, and this app has spent both: `MVP.md` gives
/// amber exactly one meaning and forbids colour used as decoration, and the value
/// range between `bg` and `text` is what the three ink weights already divide up. A
/// 1.4 px contour in one ink is the version of this mark that cannot compete with a
/// waiting agent for attention.
///
/// [bloom] runs 0 → 1 and is owned by the caller, so this is a pure painter with no
/// clock of its own: `SplashScreen` drives it from an [AnimationController], the intro
/// hands it a constant 1, and a test can pin it to any frame without waiting.
class LotusMark extends StatelessWidget {
  const LotusMark({required this.color, this.size = 74, this.bloom = 1, super.key});

  final Color color;
  final double size;

  /// 0 is closed and invisible; 1 is fully open. Values between are the petals
  /// arriving in sequence — see [_LotusPainter] for the stagger.
  final double bloom;

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: size,
    // Excluded rather than labelled: the wordmark beside it already says
    // "Lotus", and a screen reader announcing the name twice is worse than a
    // decorative image announcing nothing.
    child: ExcludeSemantics(
      child: CustomPaint(
        painter: _LotusPainter(color: color, bloom: bloom),
      ),
    ),
  );
}

class _LotusPainter extends CustomPainter {
  _LotusPainter({required this.color, required this.bloom});

  final Color color;
  final double bloom;

  static const int petals = 8;

  /// Each petal's slice of [bloom]. Eight petals over 0 → 0.72 leaves the last
  /// quarter to the core, which is why the eye settles in the middle rather than on
  /// whichever petal happened to finish last.
  static const double _petalSpan = 0.72;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    final centre = Offset(size.width / 2, size.height / 2);
    final stroke = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = s * 0.019
      ..color = color
      ..isAntiAlias = true;

    for (var i = 0; i < petals; i++) {
      final t = _stagger(i);
      if (t <= 0) continue;

      canvas.save();
      canvas.translate(centre.dx, centre.dy);
      canvas.rotate(i * 2 * math.pi / petals);
      // Scaled about the centre, so the petals open outwards from the core rather
      // than sliding into place — the difference between a flower and a menu.
      canvas.scale(0.36 + 0.64 * t);
      stroke.color = color.withValues(alpha: color.a * t);
      canvas.drawOval(
        Rect.fromCenter(
          // Pushed clear of the middle rather than crossing it. The first draft put
          // the petal's inner end 5% *past* centre, and eight of those overlapping
          // read as one dense blob at the 52 px the intro uses rather than as a
          // flower. Found by looking at it, not at the geometry.
          center: Offset(0, -s * 0.225),
          width: s * 0.155,
          height: s * 0.34,
        ),
        stroke,
      );
      canvas.restore();
    }

    final core = _core();
    if (core > 0) {
      stroke.color = color.withValues(alpha: color.a * core);
      canvas.drawCircle(centre, s * 0.042, stroke);
    }
  }

  /// Petal [i]'s own 0 → 1, carved out of [bloom].
  ///
  /// The petals overlap by design: each one takes a third longer than its slot, so
  /// three are in motion at any moment. Non-overlapping stagger reads as a list being
  /// spelled out; this reads as one gesture.
  double _stagger(int i) {
    final slot = _petalSpan / petals;
    final start = i * slot;
    return _ease(((bloom - start) / (slot * 4)).clamp(0.0, 1.0));
  }

  double _core() => _ease(((bloom - _petalSpan) / (1 - _petalSpan)).clamp(0.0, 1.0));

  /// easeOutCubic, inline rather than a `Curve`, because a painter that reached for
  /// `Curves` would be holding an animation concept it does not otherwise need.
  static double _ease(double t) => 1 - math.pow(1 - t, 3).toDouble();

  @override
  bool shouldRepaint(_LotusPainter old) => old.bloom != bloom || old.color != color;
}
