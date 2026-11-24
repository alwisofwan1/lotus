import 'package:flutter/material.dart';
import '../../models/runner_family.dart';

import 'runner_marks.g.dart';
import 'svg_path.dart';

/// Which runner is driving this agent, as a silhouette.
///
/// **This reopens a locked decision, and narrowly.** `MVP.md` §"Anatomi baris" rules:
/// *"**Runner** (`claude` / `codex`) sebagai teks kecil, bukan logo — logo tidak terbaca
/// di 12px."* That ruling is kept for what it actually bans — a detailed, brand-coloured
/// logo — and this is a different object: one flat silhouette taking the same colour as
/// the text beside it. Two things changed since it was written:
///
/// * **The column was already there and already empty.** The mark slot reserves its
///   width on every row so names share a left edge, and draws `◆` only for `waiting` —
///   information for one state out of four. This gives the other three something true to
///   say without costing a pixel of width.
/// * **The word stays.** `claude` and `codex` are still printed beside it, so the mark is
///   never the only thing carrying identity. That is what makes an unrecognised runner a
///   non-event rather than a blank.
///
/// **Colour is not reopened.** The mark takes whatever colour the row gives it, which is
/// `muted` normally and `waiting` amber when the agent has stopped for the operator — so
/// the slot answers *which runner* and *does it want you* at once, and amber still means
/// exactly one thing.
/// The colour a runner's own brand paints its mark in, when a surface asks for it.
///
/// **Home's agent list and the summon sheet ask; the starting screen and the composer
/// chip do not.** One runner, one colour, on the two screens an operator sees back to
/// back — the list it appears in and the sheet that puts it there. Decided with the
/// 2026-08-27 list revamp; the palette is the vendors' own primaries, chosen to read on
/// the `#121214` floor (Cursor and Grok are near-white because their marks are).
///
/// Null for a runner with no brand here — a custom runner, or one Lotus does not know —
/// and the caller falls back to the text colour it would have used anyway.
Color? brandColorFor(String agentType) => switch (RunnerFamily.of(agentType)) {
      RunnerFamily.claude => const Color(0xFFDA7756),
      RunnerFamily.codex => const Color(0xFF10A37F),
      RunnerFamily.cursor => const Color(0xFFF7F7F4),
      RunnerFamily.gemini => const Color(0xFF4285F4),
      RunnerFamily.grok => const Color(0xFFFFFFFF),
      RunnerFamily.kimi => const Color(0xFFAC33F2),
      RunnerFamily.opencode => const Color(0xFF8B7AB8),
      RunnerFamily.other => null,
    };

class RunnerMarkGlyph extends StatelessWidget {
  const RunnerMarkGlyph({
    required this.agentType,
    required this.color,
    this.size = 13,
    super.key,
  });

  /// `Cell.agentType` as the host sent it. Matched case-insensitively; anything with no
  /// mark falls back rather than drawing nothing.
  final String agentType;

  final Color color;
  final double size;

  /// Parsed once per runner. The paths are compile-time constants, so this is a cache of
  /// work rather than of state, and it cannot go stale.
  static final Map<String, _Drawn> _cache = {};

  static _Drawn? _drawnFor(String agentType) {
    final key = agentType.trim().toLowerCase();
    final mark = kRunnerMarks[key];
    if (mark == null) return null;
    return _cache[key] ??= _Drawn.of(mark);
  }

  @override
  Widget build(BuildContext context) {
    final drawn = _drawnFor(agentType);

    // The runner word is printed beside this on every surface that draws it, so reading
    // the mark aloud as well would say the same thing twice.
    return ExcludeSemantics(
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: drawn == null
              ? _FallbackPainter(color: color)
              : _MarkPainter(drawn: drawn, color: color),
        ),
      ),
    );
  }
}

/// A parsed mark, with the bounds of the ink it actually puts down.
///
/// **Measured rather than assumed, because the assets disagree.** Scaling by the viewBox
/// treats 128×128 as the mark, but the ink inside it is padded differently per file —
/// measured across the shipped set: `grok` fills 0.99 of its box, `kimi` 0.66. Rendered
/// at one [RunnerMarkGlyph.size] those two would differ by a third, and a row of runner
/// marks where one is visibly smaller than its neighbour is the kind of detail that
/// reads as carelessness without anyone being able to name why.
///
/// `claude` and `codex` happen to match almost exactly (0.813 and 0.812, both centred),
/// so today this normalisation changes nothing visible. It is here for the runner that
/// arrives next, which is the only one that can be wrong.
class _Drawn {
  _Drawn(this.paths, this.ink);

  factory _Drawn.of(RunnerMark mark) {
    final paths = mark.paths.map(parseSvgPath).toList(growable: false);
    var ink = paths.first.getBounds();
    for (final path in paths.skip(1)) {
      ink = ink.expandToInclude(path.getBounds());
    }
    return _Drawn(paths, ink);
  }

  final List<Path> paths;

  /// The union of every sub-path's bounds, in viewBox coordinates.
  final Rect ink;
}

class _MarkPainter extends CustomPainter {
  const _MarkPainter({required this.drawn, required this.color});

  final _Drawn drawn;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final ink = drawn.ink;
    // Longest side of the ink fills the slot, so `size` means the mark's visible size
    // rather than the size of whatever padding its exporter left around it.
    final longest = ink.width > ink.height ? ink.width : ink.height;
    if (longest <= 0) return;

    canvas.save();
    canvas.translate(size.width / 2, size.height / 2);
    canvas.scale(size.width / longest);
    canvas.translate(-ink.center.dx, -ink.center.dy);

    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.fill
      ..isAntiAlias = true;
    for (final path in drawn.paths) {
      canvas.drawPath(path, paint);
    }
    canvas.restore();
  }

  @override
  bool shouldRepaint(_MarkPainter old) => old.color != color || old.drawn != drawn;
}

/// A runner this build has no mark for.
///
/// **Not nothing, and not a guess.** The host may send any `agentType` — the shipped set
/// covers six and the fleet is free to grow — so the interesting case is not `claude`, it
/// is the runner that arrives after this was written. A blank slot would read as a
/// rendering fault on a row that is otherwise fine.
///
/// `◆` is what this column drew before any of this existed, so an unknown runner falls
/// back to the app's own mark rather than to a vendor's. The runner's name is printed
/// beside it either way, which is what actually identifies it.
class _FallbackPainter extends CustomPainter {
  const _FallbackPainter({required this.color});

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final c = Offset(size.width / 2, size.height / 2);
    final r = size.width * 0.30;
    final diamond = Path()
      ..moveTo(c.dx, c.dy - r)
      ..lineTo(c.dx + r, c.dy)
      ..lineTo(c.dx, c.dy + r)
      ..lineTo(c.dx - r, c.dy)
      ..close();
    canvas.drawPath(diamond, Paint()..color = color..isAntiAlias = true);
  }

  @override
  bool shouldRepaint(_FallbackPainter old) => old.color != color;
}
