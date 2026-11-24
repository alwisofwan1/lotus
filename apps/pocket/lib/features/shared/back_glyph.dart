import 'package:flutter/material.dart';

import '../../app/theme/app_tokens.dart';
import 'glyphs.dart';

/// The way back, as one shape on every screen that has one.
///
/// A 36px `raise` disc with the chevron inside it, rather than a bare stroke floating
/// at the margin: the bare stroke read as a typographic accident next to a 27px serif
/// title, and three screens drew it three slightly different ways (2026-08-27). The
/// disc is the same one step off the floor every pressable surface here uses — the
/// composer pill, the target chip — so it says *press me* without a border or a shadow.
/// The 44px hit box is larger than the disc; the disc is what you see, not what you hit.
class BackGlyph extends StatelessWidget {
  const BackGlyph({required this.onTap, this.label = 'Back', super.key});

  final VoidCallback onTap;
  final String label;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      button: true,
      label: label,
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        splashColor: t.raise,
        highlightColor: t.raise,
        child: SizedBox(
          width: kMinHitTarget,
          height: kMinHitTarget,
          child: Center(
            child: Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(color: t.raise, shape: BoxShape.circle),
              child: Center(
                // Nudged one pixel left: a chevron's optical centre sits right of its box.
                child: Padding(
                  padding: const EdgeInsets.only(right: 1),
                  child: Chevron(color: t.text, direction: ChevronDirection.left, size: 12, stroke: 1.8),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
