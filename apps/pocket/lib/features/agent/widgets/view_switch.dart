import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../page_mode.dart';

/// Chat | Terminal as two small icon segments, always visible, one tap each.
///
/// Replaces the sheet's grip and the composer's `TERM` button (v4 tiket 03). The ADR-6
/// addendum of 2026-10-04 answers why a switch is allowed in the header again: Terminal
/// is now a place the operator works rather than peeks into, so it earns an entry that
/// does not depend on where they scrolled.
///
/// Icons in the header (2026-11-28) to leave room for the Stop / Done word; each segment
/// still says its name to a screen reader. [compact] is the mini bar's version (v4 tiket 04),
/// shown while keys are live: words `Chat | Term`, in a 36px hit box because the bar is 36.
class ViewSwitch extends StatelessWidget {
  const ViewSwitch({required this.shown, required this.onShow, this.compact = false, super.key});

  final AgentSurface shown;
  final ValueChanged<AgentSurface> onShow;
  final bool compact;

  static const double segmentWidth = 40;
  static const double segmentHeight = 32;
  static const double _track = 2;

  double get _width => compact ? 32 : segmentWidth;
  double get _height => compact ? 22 : segmentHeight;
  double get _box => compact ? 36 : kMinHitTarget;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    // One detector over a 44px box, choosing the segment by which half was hit. The track
    // stays 36px — a taller one would set the header's height — and a detector per
    // segment would stop at the visible 32px, under the thumb-sized minimum.
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapUp: (tap) {
        final to = tap.localPosition.dx < _track + _width
            ? AgentSurface.chat
            : AgentSurface.terminal;
        if (to != shown) onShow(to);
      },
      child: Padding(
        padding: EdgeInsets.symmetric(
          vertical: (_box - _height - 2 * _track) / 2,
        ),
        child: Container(
          padding: const EdgeInsets.all(_track),
          decoration: BoxDecoration(
            color: t.raise2,
            borderRadius: context.shape.radius(compact ? ShapeRole.key : ShapeRole.chip),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _segment(context, t, AgentSurface.chat, 'Chat'),
              _segment(context, t, AgentSurface.terminal, compact ? 'Term' : 'Terminal'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _segment(BuildContext context, AppTokens t, AgentSurface surface, String label) {
    final on = shown == surface;

    return Semantics(
      key: ValueKey('view-${surface.name}'),
      button: true,
      selected: on,
      label: surface == AgentSurface.chat ? 'Chat' : 'Terminal',
      excludeSemantics: true,
      onTap: on ? null : () => onShow(surface),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOutQuart,
        width: _width,
        height: _height,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? t.keyHi : t.keyHi.withValues(alpha: 0),
          borderRadius: context.shape.radius(compact ? ShapeRole.tag : ShapeRole.key),
          boxShadow: [
            BoxShadow(
              color: t.shadow.withValues(alpha: on ? 0.35 : 0),
              offset: const Offset(0, 1),
              blurRadius: 3,
            ),
          ],
        ),
        child: compact
            ? Text(
                label,
                style: t.ui.copyWith(fontSize: 11, fontWeight: FontWeight.w500, color: on ? t.text : t.muted),
              )
            : CustomPaint(
                size: const Size.square(16),
                painter: _ViewIconPainter(surface, on ? t.text : t.muted),
              ),
      ),
    );
  }
}

/// Painted rather than typed (`glyphs.dart`): a speech bubble for Chat, `>_` for Terminal.
class _ViewIconPainter extends CustomPainter {
  const _ViewIconPainter(this.surface, this.color);

  final AgentSurface surface;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final pen = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    if (surface == AgentSurface.chat) {
      final bubble = Path()
        ..addRRect(RRect.fromRectAndRadius(
            Rect.fromLTWH(1, 1.5, size.width - 2, size.height - 6), const Radius.circular(3)))
        ..moveTo(4.5, size.height - 4.5)
        ..lineTo(4.5, size.height - 1)
        ..lineTo(8, size.height - 4.5);
      canvas.drawPath(bubble, pen);
    } else {
      canvas.drawPath(
        Path()
          ..moveTo(2, 4.5)
          ..lineTo(7, 8.5)
          ..lineTo(2, 12.5),
        pen,
      );
      canvas.drawLine(Offset(9, 13), Offset(size.width - 1, 13), pen);
    }
  }

  @override
  bool shouldRepaint(_ViewIconPainter old) => old.surface != surface || old.color != color;
}
