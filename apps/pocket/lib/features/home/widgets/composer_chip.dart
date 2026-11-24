import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../models/cell.dart';
import '../../shared/glyphs.dart';

/// The destination, stated before anything is typed.
///
/// **Given a shape, because it had none.** It was three characters floating on the app
/// floor — a ~25px strip with nothing to say it could be pressed, sitting between the
/// list and the composer and belonging visually to neither. Now it is a surface:
/// `raise`, fully rounded, the same one step off the floor as the pill beneath it, so
/// the destination and the field it feeds read as one object.
///
/// Not a new shape smuggled past the design's own rule. `StepCapsule` is already a
/// rounded `raise` surface wrapping a control, and what `MVP.md` bans is decoration —
/// a filled shape has to be something you press. This is the one control on Home that
/// changes where the words go.
class ComposerChip extends StatelessWidget {
  const ComposerChip({
    required this.target,
    required this.starting,
    required this.onTap,
    super.key,
  });

  /// Null on a project with no agents, where the only thing the chip can say is that
  /// the words will make one.
  final Cell? target;

  /// Whether the composer is starting an agent rather than talking to one.
  final bool starting;

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final name = starting ? 'New agent' : (target?.title ?? 'New agent');
    // Inverted while starting: the mode has to be unmistakable from the corner of the
    // eye, and this is the control that changed what the field does. `text` on `bg`,
    // never the amber — that word is spoken for (`MVP.md`).
    final inverted = starting || target == null;

    return Material(
      color: inverted ? t.text : t.raise,
      borderRadius: BorderRadius.circular(999),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(999),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: kMinHitTarget),
          child: Padding(
            padding: const EdgeInsets.only(left: 14, right: 11),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Kept, and not decoration: the placeholder below vanishes the moment
                // anything is typed, so this mark is what still says *where this goes*
                // mid-sentence (R-10).
                Text(
                  inverted ? '+' : '→',
                  style: t.ui.copyWith(
                    fontSize: 11.5,
                    color: inverted ? t.bg.withValues(alpha: 0.55) : t.muted,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  name,
                  style: t.ui.copyWith(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    letterSpacing: -0.1,
                    color: inverted
                        ? t.bg
                        : (target!.needsInput ? t.waiting : t.text),
                  ),
                ),
                const SizedBox(width: 8),
                Chevron(
                  color: inverted ? t.bg.withValues(alpha: 0.55) : t.muted,
                  size: 12,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
