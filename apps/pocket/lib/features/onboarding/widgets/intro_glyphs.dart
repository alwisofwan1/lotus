import 'dart:math' as math;

import 'package:flutter/widgets.dart';

/// The three shapes the second intro pane needs, painted rather than typed.
///
/// Same rule as `shared/glyphs.dart`, for the same reason it gives: a character picked
/// out of the type stack renders at whatever weight and colour the fallback font
/// decided, and this app has already been bitten by an emoji-range glyph ignoring the
/// colour it was handed. **This is not an icon set** — there are exactly three shapes
/// here, each drawn for one line of copy, and nothing else may reach for them.
enum IntroGlyph { machine, camera, fingerprint }

class IntroGlyphMark extends StatelessWidget {
  const IntroGlyphMark({
    required this.glyph,
    required this.color,
    this.size = 22,
    super.key,
  });

  final IntroGlyph glyph;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox.square(
        dimension: size,
        child: ExcludeSemantics(
          // The sentence beside each one already says what it is; a screen reader
          // announcing "camera, The camera reads that QR" is noise.
          child: CustomPaint(painter: _GlyphPainter(glyph: glyph, color: color)),
        ),
      );
}

class _GlyphPainter extends CustomPainter {
  _GlyphPainter({required this.glyph, required this.color});

  final IntroGlyph glyph;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final s = size.shortestSide;
    final p = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = s * 0.062
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..color = color
      ..isAntiAlias = true;

    switch (glyph) {
      case IntroGlyph.machine:
        _machine(canvas, s, p);
      case IntroGlyph.camera:
        _camera(canvas, s, p);
      case IntroGlyph.fingerprint:
        _fingerprint(canvas, s, p);
    }
  }

  /// A screen on a stand: the machine running Lotus, seen from the phone.
  void _machine(Canvas canvas, double s, Paint p) {
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(s * 0.10, s * 0.19, s * 0.80, s * 0.54),
        Radius.circular(s * 0.08),
      ),
      p,
    );
    canvas.drawLine(Offset(s * 0.33, s * 0.86), Offset(s * 0.67, s * 0.86), p);
  }

  /// A camera body with a lens. Not a QR square: the pane's subject is the permission
  /// the OS is about to ask for, and the QR belongs to the button on the next screen.
  void _camera(Canvas canvas, double s, Paint p) {
    final body = Path()
      ..moveTo(s * 0.10, s * 0.34)
      ..lineTo(s * 0.30, s * 0.34)
      ..lineTo(s * 0.38, s * 0.20)
      ..lineTo(s * 0.62, s * 0.20)
      ..lineTo(s * 0.70, s * 0.34)
      ..lineTo(s * 0.90, s * 0.34)
      ..lineTo(s * 0.90, s * 0.80)
      ..lineTo(s * 0.10, s * 0.80)
      ..close();
    canvas.drawPath(body, p);
    canvas.drawCircle(Offset(s * 0.50, s * 0.56), s * 0.15, p);
  }

  /// Three concentric arcs, open at the bottom — a fingerprint at 22 px, without
  /// pretending to be a whorl it is too small to render.
  void _fingerprint(Canvas canvas, double s, Paint p) {
    const start = math.pi * 0.86;
    const sweep = math.pi * 1.28;
    for (final r in [0.16, 0.28, 0.40]) {
      canvas.drawArc(
        Rect.fromCircle(center: Offset(s * 0.5, s * 0.52), radius: s * r),
        start,
        sweep,
        false,
        p,
      );
    }
    canvas.drawLine(Offset(s * 0.5, s * 0.36), Offset(s * 0.5, s * 0.74), p);
  }

  @override
  bool shouldRepaint(_GlyphPainter old) => old.glyph != glyph || old.color != color;
}
