import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

const Duration _enter = Duration(milliseconds: 260);
const Duration _leave = Duration(milliseconds: 150);

/// One digit of [PairingCodeCells]: a filled cell whose digit rises in and drops out,
/// whose border says active or refused, and which holds the caret while it is next.
///
/// [delay] staggers a paste or scan left to right. Under [still] every duration is zero.
class PairingCodeCell extends StatelessWidget {
  const PairingCodeCell({
    required this.digit,
    required this.active,
    required this.dead,
    required this.still,
    required this.caret,
    required this.delay,
    super.key,
  });

  final String? digit;
  final bool active;
  final bool dead;
  final bool still;
  final Animation<double> caret;
  final Duration delay;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final total = _enter + delay;
    final border = dead ? t.error : (active ? t.lineStrong : t.line);

    return AnimatedScale(
      scale: active && !still ? 1.02 : 1,
      duration: still ? Duration.zero : const Duration(milliseconds: 200),
      curve: Curves.easeOutBack,
      child: AnimatedContainer(
        duration: still ? Duration.zero : const Duration(milliseconds: 200),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: t.raise,
          borderRadius: context.shape.radius(ShapeRole.block),
          border: Border.all(color: border),
        ),
        child: AnimatedSwitcher(
          duration: still ? Duration.zero : total,
          reverseDuration: still ? Duration.zero : _leave,
          switchInCurve: Interval(delay.inMicroseconds / total.inMicroseconds, 1, curve: Curves.easeOutCubic),
          switchOutCurve: Curves.easeOut,
          transitionBuilder: (child, animation) => FadeTransition(
            opacity: animation.drive(CurveTween(curve: const Interval(0, 0.6))),
            child: SlideTransition(
              position: animation.drive(Tween(begin: const Offset(0, 0.45), end: Offset.zero)),
              child: ScaleTransition(
                // The spring's overshoot lives here only: a curve that leaves [0, 1] must
                // not feed another curve, and the fade above has one.
                scale: animation.drive(Tween<double>(begin: 0.9, end: 1).chain(CurveTween(curve: Curves.easeOutBack))),
                child: child,
              ),
            ),
          ),
          child: digit != null
              ? Text(
                  digit!,
                  key: ValueKey(digit),
                  style: t.mono.copyWith(fontSize: 19, fontWeight: FontWeight.w500, color: t.text),
                )
              : active
                  ? _Caret(key: const ValueKey('caret'), blink: caret, still: still, color: t.dim)
                  : const SizedBox.shrink(key: ValueKey('empty')),
        ),
      ),
    );
  }
}

class _Caret extends StatelessWidget {
  const _Caret({required this.blink, required this.still, required this.color, super.key});

  final Animation<double> blink;
  final bool still;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final bar = Container(width: 1.5, height: 18, color: color);
    if (still) return bar;
    return AnimatedBuilder(
      animation: blink,
      builder: (context, child) => Opacity(opacity: blink.value < 0.5 ? 1 : 0, child: child),
      child: bar,
    );
  }
}
