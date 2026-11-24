import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../chat_layout.dart';
import '../chat_transcript.dart';
import 'line_details.dart';
import 'thinking_block.dart';

/// What it did. The verb is lowercased: this is a machine's log line, and `Read`
/// capitalised reads as a heading rather than an action.
class StepLine extends StatelessWidget {
  const StepLine({required this.item, super.key});

  final ChatItem item;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return GestureDetector(
      onLongPress: () => showLineDetails(
        context,
        text: '${item.label ?? ''} ${item.text}'.trim(),
        at: item.timestamp,
      ),
      behavior: HitTestBehavior.opaque,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.baseline,
          textBaseline: TextBaseline.alphabetic,
          children: [
            // A fixed column, so a run of steps reads by running the eye down one edge
            // rather than hunting for each mark where the previous line happened to end.
            SizedBox(
              width: 11,
              child: Text(
                _glyph,
                style: t.mono.copyWith(fontSize: 10, color: _glyphInk(t)),
              ),
            ),
            const SizedBox(width: 7),
            // The verb a shade brighter than what it acted on: the verb is what the
            // operator scans for, the target is what they read when one catches.
            Text(
              (item.label ?? '').toLowerCase(),
              style: t.mono.copyWith(fontSize: 12, color: _failed ? t.error : t.dim),
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                item.text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: t.mono.copyWith(fontSize: 12, color: t.muted),
              ),
            ),
            if (item.diff != null) ...[
              const Spacer(),
              const SizedBox(width: 8),
              _diff(t, item.diff!),
            ],
          ],
        ),
      ),
    );
  }

  bool get _failed => item.status == 'failed';

  /// One character for how the step ended.
  ///
  /// Not a colour for the good case, on purpose: a green tick per line would put a
  /// second meaning-bearing colour on a screen whose only one is amber. The failure is
  /// the exception worth the ink, and [AppTokens.error] already exists for it.
  String get _glyph => switch (item.status) {
        'completed' => '✓',
        'failed' => '✕',
        'cancelled' => '–',
        // Running, or a result the ring evicted. A dot says "a step happened" without
        // claiming it finished.
        _ => '·',
      };

  Color _glyphInk(AppTokens t) => switch (item.status) {
        'failed' => t.error,
        'completed' => t.dim,
        _ => t.faint,
      };

  /// `+0 −34`, with the additions a shade brighter than the removals.
  ///
  /// Split on the space this class produced itself — not parsing foreign input, and the
  /// two-tone makes the size of an edit legible at a glance without a second colour
  /// entering the page.
  Widget _diff(AppTokens t, String diff) {
    final parts = diff.split(' ');
    return Text.rich(
      TextSpan(
        children: [
          TextSpan(text: parts.first, style: TextStyle(color: t.muted)),
          if (parts.length > 1) TextSpan(text: ' ${parts[1]}'),
        ],
      ),
      style: t.mono.copyWith(fontSize: 12, color: t.muted),
    );
  }
}

/// A run of look-around steps, folded into one line.
///
/// Restores the shape of a conversation: before this, six greps and reads occupied the
/// same height as the prose that answered the question, so the answer read as a
/// footnote to the machinery. Nothing is hidden — the count is the first thing on the
/// line, and one tap puts every step back.
class StepCapsule extends StatelessWidget {
  const StepCapsule({required this.row, required this.expanded, required this.onToggle, super.key});

  final StepRunRow row;
  final bool expanded;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Semantics(
          button: true,
          expanded: expanded,
          label: '${row.stepCount} steps: ${row.summary}',
          child: GestureDetector(
            onTap: onToggle,
            behavior: HitTestBehavior.opaque,
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 5),
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
              decoration: BoxDecoration(
                color: t.raise,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  Text(
                    expanded ? '▾' : '▸',
                    style: t.mono.copyWith(fontSize: 12, color: t.muted),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    row.countLabel,
                    style: t.mono.copyWith(fontSize: 12, color: t.dim),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      row.summary,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: t.mono.copyWith(fontSize: 12, color: t.muted),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        if (expanded)
          Padding(
            padding: const EdgeInsets.only(left: 14, bottom: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (final line in row.steps)
                  // Each line in its own voice. Reasoning folds into this run beside a
                  // tool step (issue 03), and drawing it through [StepLine] put the
                  // agent's working-out in mono behind a tool glyph — the voice for what
                  // it *did*. `MVP.md` spends a whole typeface on that difference.
                  line.kind == ChatLine.thinking
                      ? ThinkingBlock(items: [line], open: true)
                      : StepLine(item: line),
              ],
            ),
          ),
      ],
    );
  }
}

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
                item.text,
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
