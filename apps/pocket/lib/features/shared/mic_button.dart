import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import '../../data/dictation.dart';
import '../../models/host_id.dart';
import 'held_paste.dart';

/// The microphone, in the composer's one trailing slot.
///
/// **A bare glyph, not a filled circle**, and that is the argument for it being a widget
/// of its own rather than a branch inside the composer: only two shapes in this app are
/// filled, and both of them commit something. Choosing an input method commits nothing.
/// The filled circle beside it ([SendButton]) exists exactly when there is something to
/// dispatch — see `Composer._trailing` for the one-slot rule the two of them share.
///
/// Left `composer.dart` on 2026-09-17, the same way `SendButton` did and for the same
/// reason: the file was at the repo's 300-line ceiling and this is a piece that reads
/// nothing of the field's state.
class MicButton extends StatelessWidget {
  const MicButton({required this.dictation, required this.enabled, super.key});

  final Dictation dictation;

  /// False while a send is in flight. The glyph stays drawn and goes quiet rather than
  /// disappearing — the slot must not change shape under a thumb already moving to it.
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: 'Dictate',
      child: InkResponse(
        onTap: enabled ? () => unawaited(dictation.start()) : null,
        radius: 22,
        child: SizedBox(
          width: kMinHitTarget,
          height: kMinHitTarget,
          child: Center(child: MicGlyph(color: enabled ? t.dim : t.faint)),
        ),
      ),
    );
  }
}

/// Ends the recording and puts the words in the field, **unsent**.
///
/// Appended rather than replacing: an operator who typed half a sentence and then spoke
/// the rest meant both halves. Speech recognition mishears often enough that sending on
/// its own would put words no human read in front of an agent with a shell.
///
/// Written through [PasteCatch] rather than straight onto the controller, so a long
/// transcription is never mistaken for something the operator pasted.
Future<void> appendDictated({
  required Dictation dictation,
  required HostId on,
  required PasteCatch into,
}) async {
  final text = await dictation.stop(on);
  if (text == null) return;
  final existing = into.field.text.trim();
  into.write(existing.isEmpty ? text : '$existing $text');
}

/// A microphone that is actually shaped like one.
///
/// Replaces `◍` (U+25CD, "circle with vertical fill"), which was reached for because it
/// came from a text font and so took the colour it was given — the right constraint,
/// solved with the wrong shape. Nobody reads a hatched circle as *speak*.
///
/// Three parts, and the cradle is the one that carries the recognition: a capsule alone
/// is a pill, and it is the arc under it plus the stem that make the silhouette read as
/// a microphone at 20px, which is the only size that matters here.
class MicGlyph extends StatelessWidget {
  const MicGlyph({required this.color, this.size = 20, this.stroke = 1.6, super.key});

  final Color color;
  final double size;
  final double stroke;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(painter: _MicPainter(color: color, stroke: stroke)),
      );
}

class _MicPainter extends CustomPainter {
  const _MicPainter({required this.color, required this.stroke});

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

    // The capsule the voice goes into.
    final capsuleWidth = w * 0.38;
    final capsule = RRect.fromRectAndRadius(
      Rect.fromLTWH((w - capsuleWidth) / 2, h * 0.08, capsuleWidth, h * 0.46),
      Radius.circular(capsuleWidth / 2),
    );
    canvas.drawRRect(capsule, paint);

    // The cradle — wider than the capsule, which is what makes the shape read.
    canvas.drawArc(
      Rect.fromCenter(center: Offset(w / 2, h * 0.50), width: w * 0.70, height: h * 0.58),
      0,
      math.pi,
      false,
      paint,
    );

    // The stem down to the stand.
    canvas.drawLine(Offset(w / 2, h * 0.79), Offset(w / 2, h * 0.93), paint);
  }

  @override
  bool shouldRepaint(_MicPainter old) => old.color != color || old.stroke != stroke;
}
