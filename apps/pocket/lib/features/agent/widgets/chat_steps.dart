import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../chat_transcript.dart';
import '../plan_notice.dart';
import 'line_details.dart';

/// Something the runner said that did not go wrong.
///
/// **Shaped like [ProblemLine], coloured like a step**, and both halves are the point. It
/// happened in the same sequence and is read in the same pass, so the shape is shared; it is
/// not a failure, so the ink is not [AppTokens.error]. `MVP.md` allows this screen two
/// colours and red means a cell errored — spending it on a warning makes the operator hunt
/// for a fault that is not there.
///
/// The glyph is `!` rather than `✕`: the same width in the same column, so a run of steps
/// still reads down one edge, but plainly not a cross.
///
/// Exists because the wire already carried the distinction and Chat threw it away. A plan
/// window arrives from the host as `{type: "error", recoverable: true}`, and
/// `five_hour plan limit: allowed_warning` was drawing in error red over an answer the agent
/// had just given — seen on a real VPS cell, 2026-09-10.
class NoticeLine extends StatelessWidget {
  const NoticeLine({required this.item, super.key});

  final ChatItem item;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return GestureDetector(
      onLongPress: () => showLineDetails(context, text: item.text, at: item.timestamp),
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            SizedBox(
              width: 11,
              child: Text('!', style: t.mono.copyWith(fontSize: 10, color: t.muted)),
            ),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                planNoticeWords(item.text) ?? item.text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: t.mono.copyWith(fontSize: 12, height: 1.45, color: t.muted),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// What went wrong, in the one colour this app already spends on that.
///
/// Shaped like a step on purpose — same column, same mono, same left glyph — because it
/// happened in the same sequence and the operator reads it in the same pass. Only the
/// ink differs, which is exactly the amount of difference the meaning needs.
///
/// Folded into [StepLine] until 2026-09-08, so an interruption looked like a file being
/// read.
class ProblemLine extends StatelessWidget {
  const ProblemLine({required this.item, super.key});

  final ChatItem item;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return GestureDetector(
      onLongPress: () => showLineDetails(context, text: item.text, at: item.timestamp),
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            SizedBox(
              width: 11,
              child: Text('✕', style: t.mono.copyWith(fontSize: 10, color: t.error)),
            ),
            const SizedBox(width: 7),
            Expanded(
              child: Text(
                item.text,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: t.mono.copyWith(fontSize: 12, height: 1.45, color: t.error),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
