import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:xterm/xterm.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// Four arrows in one round pad, spanning both rows of the key bar (v4 tiket 05, B2).
///
/// **Tap** is one arrow, toward the side that was hit. **Drag** from the middle repeats
/// the arrow the thumb points at, faster the further it goes — 5 a second near the middle,
/// [maxRate] at the rim — with a tick of haptics per step, so walking a long history or a
/// long line is one held gesture rather than thirty taps. **Letting go** stops it at once.
///
/// It replaces four caps that cost a scroll to reach on the old single row.
class ArrowPad extends StatefulWidget {
  const ArrowPad({required this.onArrow, this.size = 86, super.key});

  /// One arrow key, for the emulator to encode — it knows the pane's cursor-key mode.
  final ValueChanged<TerminalKey> onArrow;

  final double size;

  /// The fastest repeat: 20 a second, the ceiling the ticket sets.
  static const double maxRate = 20;
  static const double _minRate = 5;

  /// How far from the middle a thumb must move before it means a direction.
  static const double _deadZone = 12;

  @override
  State<ArrowPad> createState() => _ArrowPadState();
}

class _ArrowPadState extends State<ArrowPad> {
  Timer? _repeat;
  Offset? _from;
  TerminalKey? _held;

  double get _radius => widget.size / 2;
  Offset get _centre => Offset(_radius, _radius);

  /// The arrow a point means, by whichever axis it leans along further.
  static TerminalKey? _toward(Offset d) {
    if (d.distance < ArrowPad._deadZone / 2) return null;
    if (d.dx.abs() >= d.dy.abs()) {
      return d.dx > 0 ? TerminalKey.arrowRight : TerminalKey.arrowLeft;
    }
    return d.dy > 0 ? TerminalKey.arrowDown : TerminalKey.arrowUp;
  }

  Duration get _interval {
    final reach = (_from?.distance ?? 0) - ArrowPad._deadZone;
    final t = (reach / (_radius - ArrowPad._deadZone)).clamp(0.0, 1.0);
    final rate = ArrowPad._minRate + (ArrowPad.maxRate - ArrowPad._minRate) * t;
    return Duration(microseconds: (1e6 / rate).round());
  }

  void _send(TerminalKey key) {
    Tactile.chose();
    widget.onArrow(key);
  }

  void _drag(Offset local) {
    _from = local - _centre;
    final key = _from!.distance < ArrowPad._deadZone ? null : _toward(_from!);
    setState(() => _held = key);
    if (key != null && _repeat == null) _step();
  }

  /// One arrow, then the next one timed from **where the thumb is now** — so pushing
  /// further speeds it up on the very next step.
  void _step() {
    final key = _held;
    if (key == null) {
      _repeat = null;
      return;
    }
    _send(key);
    _repeat = Timer(_interval, _step);
  }

  void _stop() {
    _repeat?.cancel();
    _repeat = null;
    _from = null;
    if (_held != null) setState(() => _held = null);
  }

  @override
  void dispose() {
    _repeat?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      label: 'Arrow keys',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapUp: (tap) {
          final key = _toward(tap.localPosition - _centre);
          if (key != null) _send(key);
        },
        onPanStart: (d) => _drag(d.localPosition),
        onPanUpdate: (d) => _drag(d.localPosition),
        onPanEnd: (_) => _stop(),
        onPanCancel: _stop,
        child: Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: _held == null ? t.key : t.keyHi,
          ),
          child: Stack(
            children: [
              for (final (key, align, turns) in const [
                (TerminalKey.arrowUp, Alignment.topCenter, 0.0),
                (TerminalKey.arrowRight, Alignment.centerRight, 0.25),
                (TerminalKey.arrowDown, Alignment.bottomCenter, 0.5),
                (TerminalKey.arrowLeft, Alignment.centerLeft, 0.75),
              ])
                Align(
                  alignment: align,
                  child: Padding(
                    padding: const EdgeInsets.all(9),
                    child: Transform.rotate(
                      angle: turns * 2 * math.pi,
                      child: CustomPaint(
                        size: const Size(12, 8),
                        painter: _Chevron(_held == key ? t.text : t.dim),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// An upward chevron; the pad turns it for the other three.
class _Chevron extends CustomPainter {
  const _Chevron(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(
      Path()
        ..moveTo(0, size.height)
        ..lineTo(size.width / 2, 0)
        ..lineTo(size.width, size.height),
      paint,
    );
  }

  @override
  bool shouldRepaint(_Chevron old) => old.color != color;
}
