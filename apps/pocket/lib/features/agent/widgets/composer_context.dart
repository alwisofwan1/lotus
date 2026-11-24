import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../models/cell.dart';

/// The line under Chat's capsule: what the words go to (v4 tiket 09, `V4 Composer`).
///
/// **Only what the host reports.** The mockup draws `✦ opus · plan`, `⑂ branch` and the
/// project. Model and branch come from the agent CLI's own transcript (`FleetMember.model`
/// and `.branch`, task #106) and are left out when the host does not say. A model label made
/// up from the runner's default would be wrong the first time someone picked another one.
///
/// The posture is not the mockup's permission *mode*. It is the coarser thing the host
/// knows for every cell, desktop-launched ones too (ADR-8): whether this agent stops to
/// ask. Absent when the host cannot say, never guessed as safe.
class ComposerContext extends StatelessWidget {
  const ComposerContext({required this.cell, super.key});

  final Cell cell;

  /// The gate posture as the rest of the app words it (`runner_description.dart`,
  /// `agent_activity.dart`), or null when the host did not say.
  static String? posture(String? gating) => switch (gating) {
        'asks' => 'asks first',
        'skipped' => 'skips asking',
        Cell.gatingRunnerCannot => 'never asks',
        _ => null,
      };

  /// The model id as the line has room for it: Claude's family prefix and a date stamp
  /// dropped (`claude-opus-5-5` → `opus-5-5`, `claude-haiku-4-5-20251001` → `haiku-4-5`).
  /// Only removes; every word left is one the CLI wrote.
  static String? modelLabel(String? model) {
    final m = model?.trim();
    if (m == null || m.isEmpty) return null;
    final short = m.replaceFirst(RegExp(r'^claude-'), '').replaceFirst(RegExp(r'-\d{8}$'), '');
    return short.isEmpty ? m : short;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final style = t.ui.copyWith(fontSize: 11.5, height: 1.2, color: t.muted);
    final model = modelLabel(cell.model);
    final head = [?model, ?posture(cell.gating)].join(' · ');
    final branch = cell.branch?.trim();

    Widget marked(String label, Widget glyph, String text) => Flexible(
          child: Semantics(
            label: label,
            excludeSemantics: true,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                glyph,
                const SizedBox(width: 5),
                Flexible(
                  child: Text(text, style: style, maxLines: 1, overflow: TextOverflow.ellipsis),
                ),
              ],
            ),
          ),
        );

    return Row(
      children: [
        if (head.isNotEmpty) ...[
          Flexible(
            child: Text(head, style: style, maxLines: 1, overflow: TextOverflow.ellipsis),
          ),
          const SizedBox(width: 14),
        ],
        if (branch != null && branch.isNotEmpty) ...[
          marked('Branch $branch', BranchGlyph(color: t.dim), branch),
          const SizedBox(width: 14),
        ],
        marked('Project ${cell.projectName}', FolderGlyph(color: t.dim), cell.projectName),
      ],
    );
  }
}

/// A branch fork: a trunk and one line leaving it. Painted, like [FolderGlyph], because
/// `⑂` is missing from most phone fonts.
class BranchGlyph extends StatelessWidget {
  const BranchGlyph({required this.color, this.size = 12, super.key});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(painter: _BranchPainter(color)),
      );
}

class _BranchPainter extends CustomPainter {
  const _BranchPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..strokeCap = StrokeCap.round;
    canvas
      ..drawLine(Offset(w * 0.3, h * 0.12), Offset(w * 0.3, h * 0.88), paint)
      ..drawPath(
        Path()
          ..moveTo(w * 0.3, h * 0.7)
          ..quadraticBezierTo(w * 0.72, h * 0.62, w * 0.72, h * 0.3),
        paint,
      )
      ..drawCircle(Offset(w * 0.72, h * 0.22), w * 0.1, paint);
  }

  @override
  bool shouldRepaint(_BranchPainter old) => old.color != color;
}

/// A folder tab and body — the project mark. Painted for the reason every glyph here is:
/// a `▢` or `📁` falls to the emoji font and throws away the colour it is given.
class FolderGlyph extends StatelessWidget {
  const FolderGlyph({required this.color, this.size = 12, super.key});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
        width: size,
        height: size,
        child: CustomPaint(painter: _FolderPainter(color)),
      );
}

class _FolderPainter extends CustomPainter {
  const _FolderPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.2
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(
      Path()
        ..moveTo(w * 0.08, h * 0.84)
        ..lineTo(w * 0.08, h * 0.18)
        ..lineTo(w * 0.40, h * 0.18)
        ..lineTo(w * 0.52, h * 0.32)
        ..lineTo(w * 0.92, h * 0.32)
        ..lineTo(w * 0.92, h * 0.84)
        ..close(),
      paint,
    );
  }

  @override
  bool shouldRepaint(_FolderPainter old) => old.color != color;
}
