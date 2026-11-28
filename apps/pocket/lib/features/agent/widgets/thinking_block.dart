import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';
import '../chat_transcript.dart';

/// What the agent was working out, behind a single rule.
///
/// The material arrives from the runners as `reasoning` parts and the app dropped it
/// until 2026-09-08. It is drawn in **serif italic** because it is the agent's own
/// voice but is not addressed to the operator — the same way the app already tells
/// *said* from *did* by typeface rather than by decoration.
///
/// **Open while it is the newest thing; one line once the answer has arrived.** That
/// ranking is the whole reason this is a block rather than a run of lines: reasoning
/// is how it got somewhere, and after it arrives, leaving three paragraphs of
/// working-out above the answer buries the answer. Nothing is hidden — the last line
/// stays, and a tap brings the rest back.
class ThinkingBlock extends StatelessWidget {
  const ThinkingBlock({
    required this.items,
    required this.open,
    this.onToggle,
    super.key,
  });

  final List<ChatItem> items;

  /// Whether every paragraph is shown. False keeps the last line only.
  final bool open;

  /// Null while the block is the newest thing — there is nothing to collapse yet.
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final shown = open ? items : items.sublist(items.length - 1);
    final body = Container(
      margin: const EdgeInsets.symmetric(vertical: 3),
      padding: const EdgeInsets.only(left: 11),
      decoration: BoxDecoration(
        border: Border(left: BorderSide(color: t.lineStrong)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                'THINKING',
                style: t.mono.copyWith(fontSize: 9.5, letterSpacing: 1.33, color: t.faint),
              ),
              if (!open && items.length > 1) ...[
                const SizedBox(width: 8),
                Text(
                  '${items.length} paragraphs',
                  style: t.mono.copyWith(fontSize: 9.5, color: t.faint),
                ),
              ],
            ],
          ),
          const SizedBox(height: 5),
          for (final item in shown)
            Padding(
              padding: EdgeInsets.only(bottom: item == shown.last ? 0 : 6),
              child: Text(
                item.text,
                maxLines: open ? null : 2,
                overflow: open ? null : TextOverflow.ellipsis,
                style: t.serif.copyWith(
                  fontSize: 12.5,
                  height: 1.5,
                  fontStyle: FontStyle.italic,
                  color: t.muted,
                ),
              ),
            ),
        ],
      ),
    );

    if (onToggle == null) return body;
    return Semantics(
      button: true,
      expanded: open,
      label: open ? 'Working out, shown in full. Tap to collapse' : 'Working out. Tap to read it',
      child: ExcludeSemantics(
        child: InkWell(
          onTap: () {
            Tactile.chose();
            onToggle!();
          },
          borderRadius: context.shape.radius(ShapeRole.tag),
          child: body,
        ),
      ),
    );
  }
}
