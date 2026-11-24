import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';

/// The one thing on the screen that moves while the agent works.
///
/// A shell of points on a sphere, turning slowly. It answers a question the old
/// indicator could not — *is it alive, or is it stuck?* — and it answers it without
/// spending a colour: the points are [AppTokens.text] at varying alpha, so **amber
/// stays the only colour in this app that carries a meaning**.
///
/// Locked in `plans/lotus-pocket/design/chat-revamp.html`, which is the mockup this
/// widget follows. The parameters below are that file's, and the reason each one is
/// what it is:
///
/// - **[count] points on a golden-angle spiral**, which spreads them evenly over the
///   surface. An even spread is what makes the silhouette dense on its own — a sphere
///   read as a sphere rather than as a cloud, with nothing faked to get there.
/// - **Ink weighted to the rim, size to depth.** What the eye sees is the *shell*, and
///   under an orthographic projection a shell piles up at its own silhouette. Weighting
///   brightness by depth instead (the obvious first try) draws a solid ball.
/// - **[period] for one turn**, slow enough that it never pulls the eye off the sentence
///   beside it. This sits next to prose the operator is reading.
///
/// Stops when it is not on screen: the ticker belongs to the widget, so a turn that
/// ends takes the animation with it (`WorkingRow` unmounts this). And it honours
/// `MediaQuery.disableAnimations` — the sphere is still drawn, it simply stops turning,
/// because the shape itself carries "working" and only the motion is decoration.
class ThinkingOrb extends StatefulWidget {
  const ThinkingOrb({this.size = 26, this.count = 84, super.key});

  /// Side of the square this draws into, in logical pixels. 26 in the working row.
  final double size;

  /// How many points. Fewer reads as a scatter; many more reads as a ball.
  final int count;

  /// One full turn. From the mockup; a slow rotation beside prose, not a spinner.
  static const Duration period = Duration(milliseconds: 8400);

  /// Radians. Off-axis on purpose, so neither pole sits dead centre.
  static const double tilt = 0.42;

  @override
  State<ThinkingOrb> createState() => _ThinkingOrbState();
}

class _ThinkingOrbState extends State<ThinkingOrb> with SingleTickerProviderStateMixin {
  late final AnimationController _spin = AnimationController(
    vsync: this,
    duration: ThinkingOrb.period,
  );
  late List<OrbPoint> _points = orbPoints(widget.count);

  @override
  void didUpdateWidget(ThinkingOrb old) {
    super.didUpdateWidget(old);
    if (old.count != widget.count) _points = orbPoints(widget.count);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // Read here rather than in `initState`: the accessibility setting can change while
    // the app is open, and a ticker started once would keep running after it does.
    final still = MediaQuery.disableAnimationsOf(context);
    if (still) {
      _spin.stop();
    } else if (!_spin.isAnimating) {
      _spin.repeat();
    }
  }

  @override
  void dispose() {
    _spin.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return ExcludeSemantics(
      child: SizedBox.square(
        dimension: widget.size,
        child: AnimatedBuilder(
          animation: _spin,
          builder: (context, _) => CustomPaint(
            painter: OrbPainter(
              points: _points,
              // A resting angle rather than zero when motion is off: at zero the spiral
              // reads as a stack of rings, which is the one arrangement that does not
              // look like a sphere.
              turn: _spin.isAnimating ? _spin.value : 0.1,
              ink: t.text,
            ),
          ),
        ),
      ),
    );
  }
}

/// One point on the unit sphere.
@immutable
class OrbPoint {
  const OrbPoint(this.x, this.y, this.z);

  final double x;
  final double y;
  final double z;
}

/// [count] points spread evenly over the unit sphere, by golden-angle spiral.
///
/// Pure, so the arrangement is checked by arithmetic rather than by eye: every point
/// lands on the surface, and no two share a longitude.
List<OrbPoint> orbPoints(int count) {
  const golden = math.pi * (3 - 1.7320508075688772 * 1.2909944487358056); // π(3−√5)
  return List<OrbPoint>.generate(count, (i) {
    final y = 1 - (2 * (i + 0.5)) / count;
    final r = math.sqrt(math.max(0, 1 - y * y));
    final theta = i * golden;
    return OrbPoint(math.cos(theta) * r, y, math.sin(theta) * r);
  }, growable: false);
}

/// Draws the shell for one rotation angle.
class OrbPainter extends CustomPainter {
  const OrbPainter({required this.points, required this.turn, required this.ink});

  final List<OrbPoint> points;

  /// 0 … 1 of a full rotation.
  final double turn;

  final Color ink;

  /// Leaves the outermost points inside the box instead of clipping them.
  static const double _fit = 0.86;

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.shortestSide / 2;
    final scale = c * _fit;
    // A point's own size is proportional to the orb's, so one widget serves the 26px
    // working row and a larger one in a design document without retuning.
    final unit = c / 13;
    final a = turn * 2 * math.pi;
    final ca = math.cos(a), sa = math.sin(a);
    final ct = math.cos(ThinkingOrb.tilt), st = math.sin(ThinkingOrb.tilt);
    final dot = Paint();

    for (final p in points) {
      // Spin about the vertical axis, then tip the whole sphere towards the viewer.
      final x = p.x * ca + p.z * sa;
      final z0 = p.z * ca - p.x * sa;
      final y = p.y * ct - z0 * st;
      final z = p.y * st + z0 * ct;

      final depth = (z + 1) / 2; // 0 far … 1 near
      final rim = math.sqrt(x * x + y * y); // 0 centre … 1 silhouette
      dot.color = ink.withValues(alpha: 0.11 + rim * 0.44 + depth * 0.16);
      canvas.drawCircle(
        Offset(c + x * scale, c + y * scale),
        math.max(0.4, (0.42 + depth * 0.62) * unit),
        dot,
      );
    }
  }

  @override
  bool shouldRepaint(OrbPainter old) =>
      old.turn != turn || old.ink != ink || old.points != points;
}
