import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import 'draft_editor.dart';

/// The line **under** the capsule: what the words go to on the left, how much has been
/// written on the right.
///
/// It sat inside the box until v4 tiket 09 (mockup `V4 Composer`). The capsule took the
/// send button back beside the field — at the field's base, R04 — so what was left here is
/// everything that describes the draft rather than dispatches it: the context the page
/// hands in, the line count, and the way out to the full screen (R03).
///
/// Draws nothing when it has nothing to say. Home hands in no context, and a one-line
/// draft is not news, so most of the time the capsule stands alone.
class ComposerFooter extends StatelessWidget {
  const ComposerFooter({
    required this.about,
    required this.lines,
    required this.onExpand,
    super.key,
  });

  /// What the page knows about where the words go — `ComposerContext` on the Agent page.
  /// Null on Home, which says where it is aimed in the chip above.
  final Widget? about;

  /// How many lines the draft runs to, or null when there is nothing worth counting.
  ///
  /// The count is not a decoration: past [kComposerMaxLines] the field scrolls, and this
  /// is the only thing on screen that says how much is above the fold.
  final int? lines;

  /// Opens the full-height editor, or null while the draft still fits.
  final VoidCallback? onExpand;

  @override
  Widget build(BuildContext context) {
    final about = this.about;
    if (about == null && lines == null && onExpand == null) return const SizedBox.shrink();
    final t = context.tokens;

    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 30),
      child: Row(
        children: [
          if (about != null) Expanded(child: about) else const Spacer(),
          if (lines case final lines?) ...[
            const SizedBox(width: 12),
            Text(
              '$lines baris',
              // `muted`, not the mockup's `faint`: that token is ornament-only in this app
              // and measured at 1.8:1 against the floor, which is not a contrast a number
              // can be read at while walking. The rule is on [AppTokens.dim].
              style: t.mono.copyWith(fontSize: 10.5, height: 1, letterSpacing: 1, color: t.muted),
            ),
          ],
          if (onExpand case final expand?) ExpandDraftButton(onPressed: expand),
        ],
      ),
    );
  }
}
