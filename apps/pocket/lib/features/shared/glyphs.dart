library;

import 'package:flutter/material.dart';

/// The shapes this app draws for itself, rather than borrowing from a font.
///
/// **Why paint instead of type a character.** Pocket's chrome has always come from the
/// type stack — `⌄`, `‹`, `∗` — and that was cheap until two things went wrong with it.
/// `agent_header.dart` records the first: `✳` (U+2733) sits in a range Android's
/// fallback serves from the **emoji** font, so it rendered green and ignored the colour
/// it was given, twice, on a real device. A glyph that paints itself breaks the one rule
/// `MVP.md` will not bend — colour means *something is asked of you*.
///
/// The second is plainer: a text `⌄` is a character, not a control. Its weight, its
/// size, and where it sits on the line are whatever the font decided, so it reads as a
/// stray mark next to a 23px title rather than as something pressable. And `◍` (U+25CD),
/// which stood in for a microphone, is a circle with vertical hatching — it is not a
/// microphone by any reading.
///
/// Painted shapes take the colour they are given, cannot be re-served by a fallback
/// font, and can be aligned to the optical centre rather than to a baseline. **This is
/// not an icon font**, so the rule these widgets replace — *no icon set on this screen*
/// — is kept rather than broken: there is no glyph table, no ligature, and nothing here
/// that a designer could reach into for a shape this app did not decide to draw.

/// Which way a [Chevron] points.
enum ChevronDirection { down, up, right, left }

/// The affordance that says *this opens something*.
///
/// Stroked rather than filled, with round caps, because at this size a filled triangle
/// reads as a solid blob while two strokes stay legible — and the round cap is what
/// keeps it from looking like a cursor artefact.
class Chevron extends StatelessWidget {
  const Chevron({
    required this.color,
    this.direction = ChevronDirection.down,
    this.size = 11,
    this.stroke = 1.6,
    super.key,
  });

  final Color color;
  final ChevronDirection direction;

  /// The box it draws inside. The chevron itself uses about two thirds of it, which is
  /// what gives it optical breathing room without the caller doing arithmetic.
  final double size;

  final double stroke;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _ChevronPainter(color: color, direction: direction, stroke: stroke),
        ),
      );
}

class _ChevronPainter extends CustomPainter {
  const _ChevronPainter({
    required this.color,
    required this.direction,
    required this.stroke,
  });

  final Color color;
  final ChevronDirection direction;
  final double stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    final path = Path();
    switch (direction) {
      case ChevronDirection.down:
        path
          ..moveTo(w * 0.22, h * 0.38)
          ..lineTo(w * 0.5, h * 0.64)
          ..lineTo(w * 0.78, h * 0.38);
      case ChevronDirection.up:
        path
          ..moveTo(w * 0.22, h * 0.62)
          ..lineTo(w * 0.5, h * 0.36)
          ..lineTo(w * 0.78, h * 0.62);
      case ChevronDirection.right:
        path
          ..moveTo(w * 0.38, h * 0.22)
          ..lineTo(w * 0.64, h * 0.5)
          ..lineTo(w * 0.38, h * 0.78);
      // Cermin dari `right`, bukan rotasi: memutar kotaknya akan memindahkan pusat optisnya,
      // dan chevron ini sudah pernah membayar mahal untuk berada satu piksel dari tempatnya.
      case ChevronDirection.left:
        path
          ..moveTo(w * 0.62, h * 0.22)
          ..lineTo(w * 0.36, h * 0.5)
          ..lineTo(w * 0.62, h * 0.78);
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_ChevronPainter old) =>
      old.color != color || old.direction != direction || old.stroke != stroke;
}

/// The dispatch, pointing the way the words go.
///
/// Replaces `↑` (U+2191). The character was the same bargain `◍` made — a shape borrowed
/// from the type stack because it takes the colour it is given — and it carried the same
/// cost: a character is positioned and weighted by whatever font serves it, so its size
/// is a number about the *em box*, not about the arrow. The one drawn here is 15px of
/// arrow when it is asked for 15.
class ArrowGlyph extends StatelessWidget {
  const ArrowGlyph({required this.color, this.size = 15, this.stroke = 1.8, super.key});

  final Color color;
  final double size;
  final double stroke;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(painter: _ArrowPainter(color: color, stroke: stroke)),
      );
}

class _ArrowPainter extends CustomPainter {
  const _ArrowPainter({required this.color, required this.stroke});

  final Color color;
  final double stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    canvas
      ..drawLine(Offset(w * 0.5, h * 0.82), Offset(w * 0.5, h * 0.20), paint)
      ..drawPath(
        Path()
          ..moveTo(w * 0.24, h * 0.46)
          ..lineTo(w * 0.5, h * 0.20)
          ..lineTo(w * 0.76, h * 0.46),
        paint,
      );
  }

  @override
  bool shouldRepaint(_ArrowPainter old) =>
      old.color != color || old.stroke != stroke;
}

/// Which way the two corners travel.
enum ExpandDirection {
  /// Outwards — take the whole screen.
  out,

  /// Inwards — give it back.
  into,
}

/// The pair that moves a draft between the composer and the full screen.
///
/// Replaces `⤢` / `⤡` (U+2922 / U+2921). Those sit in *Supplemental Arrows-B*, the same
/// neighbourhood that served `✳` from the emoji font and rendered it green twice on a
/// real device (`agent_header.dart`). They happened to render correctly on the phone
/// tested, which is one phone — and the fix for that class of bug is not to test more
/// phones, it is to stop asking a font.
///
/// The shape is the mockup's `maximize-2` / `minimize-2`: two corner brackets and the
/// diagonals between them. Drawn rather than imported — this file's rule is that no icon
/// *set* lands on this screen, not that no shape may come from one.
class ExpandGlyph extends StatelessWidget {
  const ExpandGlyph({
    required this.color,
    this.direction = ExpandDirection.out,
    this.size = 17,
    this.stroke = 1.6,
    super.key,
  });

  final Color color;
  final ExpandDirection direction;
  final double size;
  final double stroke;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _ExpandPainter(color: color, direction: direction, stroke: stroke),
        ),
      );
}

class _ExpandPainter extends CustomPainter {
  const _ExpandPainter({
    required this.color,
    required this.direction,
    required this.stroke,
  });

  final Color color;
  final ExpandDirection direction;
  final double stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    Offset p(double x, double y) => Offset(w * x, h * y);

    // Both are the same two brackets and the same two diagonals; what changes is whether
    // the brackets sit at the corners (out) or step in from them (into).
    final path = Path();
    switch (direction) {
      case ExpandDirection.out:
        path
          ..moveTo(w * 0.625, h * 0.125)
          ..lineTo(w * 0.875, h * 0.125)
          ..lineTo(w * 0.875, h * 0.375)
          ..moveTo(w * 0.375, h * 0.875)
          ..lineTo(w * 0.125, h * 0.875)
          ..lineTo(w * 0.125, h * 0.625);
      case ExpandDirection.into:
        path
          ..moveTo(w * 0.833, h * 0.417)
          ..lineTo(w * 0.583, h * 0.417)
          ..lineTo(w * 0.583, h * 0.167)
          ..moveTo(w * 0.167, h * 0.583)
          ..lineTo(w * 0.417, h * 0.583)
          ..lineTo(w * 0.417, h * 0.833);
    }
    canvas.drawPath(path, paint);

    // The same two diagonals either way; only the brackets moved.
    canvas
      ..drawLine(p(0.875, 0.125), p(0.583, 0.417), paint)
      ..drawLine(p(0.125, 0.875), p(0.417, 0.583), paint);
  }

  @override
  bool shouldRepaint(_ExpandPainter old) =>
      old.color != color || old.direction != direction || old.stroke != stroke;
}
