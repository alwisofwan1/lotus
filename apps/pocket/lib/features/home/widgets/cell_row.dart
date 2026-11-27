import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';
import '../../shared/runner_mark.dart';
import '../cell_presentation.dart';

/// One agent on Home — `design/pocket-agent-list` (2026-08-27).
///
/// Three columns and one idiom shared with the runner sheet and the project index: a
/// mark, words, a trailing fact. What changed from the first row: the mark is 28px in
/// its runner's brand colour (`brandColorFor`), the name is the same serif persona the
/// Agent header uses, the state is a lowercase word beside a dot instead of an
/// uppercase label, and the hairlines went — rows are told apart by their height.
///
/// Amber is still rationed to one meaning. The waiting row paints its name, its dot and
/// its word amber; every other row's mark keeps the brand and its words keep the ink.
class CellRow extends StatelessWidget {
  const CellRow({required this.cell, required this.onOpen, this.unread = false, super.key});

  /// Width every row reserves for the mark, so names share a left edge whether the
  /// runner has a brand mark, a fallback glyph, or is the `+` that makes a new one.
  static const double markColumn = 40;
  static const double markSize = 28;

  final Cell cell;
  final VoidCallback onOpen;

  /// Finished since the operator last opened it (`SeenMarks`). The row sits on a
  /// `raise` surface until it is opened — the one step off the floor every pressable
  /// thing here uses, so it reads as *there is something here to pick up*, not as an
  /// alarm. Amber stays with `needs you`; this is quieter on purpose.
  final bool unread;

  @override
  Widget build(BuildContext context) => _body(context.tokens);

  Widget _body(AppTokens t) {
    final p = CellPresentation.of(cell);
    final waiting = p.emphasised;
    final stateColor = waiting ? t.waiting : t.muted;

    return Material(
      color: unread ? t.raise : Colors.transparent,
      child: InkWell(
      onTap: onOpen,
      splashColor: t.raise,
      highlightColor: t.raise,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 76),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          child: Row(
            children: [
              SizedBox(
                width: markColumn,
                height: markColumn,
                child: Center(
                  child: RunnerMarkGlyph(
                    agentType: cell.agentType,
                    color: brandColorFor(cell.agentType) ?? t.dim,
                    size: markSize,
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(child: _words(t, p, waiting)),
              const SizedBox(width: 12),
              _state(t, p.state, stateColor, waiting),
            ],
          ),
        ),
      ),
      ),
    );
  }

  Widget _words(AppTokens t, CellPresentation p, bool waiting) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Flexible(
                child: Text(
                  p.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.serif.copyWith(
                    fontSize: 19,
                    fontWeight: FontWeight.w600,
                    letterSpacing: -0.3,
                    color: waiting ? t.waiting : t.text,
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Text(p.runner, style: t.mono.copyWith(fontSize: 11, color: t.faint)),
            ],
          ),
          if (p.detail.isNotEmpty) ...[
            const SizedBox(height: 5),
            Text(
              p.detail,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: (p.detailIsMono ? t.mono : t.ui).copyWith(
                fontSize: p.detailIsMono ? 11.5 : 12.5,
                height: 1.4,
                color: waiting ? t.text : t.muted,
              ),
            ),
          ],
        ],
      );

  /// The dot's colour is the one place a row's state is painted (2026-08-27): amber is
  /// *you*, [AppTokens.live] green is *it, working*, error red is *it, broken*; idle is
  /// the ink and quiet is a rule-grey — present but saying nothing. The word beside it
  /// stays `muted` except for `needs you`, so the list reads as dots first, words second.
  static Color dotColor(AppTokens t, String word, bool waiting) {
    if (waiting) return t.waiting;
    return switch (word) {
      'quiet' => t.lineStrong,
      'idle' => t.muted,
      'error' => t.error,
      _ => t.live, // running, compacting, anything the host calls a turn in progress
    };
  }

  /// A dot and a word. The dot is what reads at a glance across the list; the word is
  /// what it means, and it never shouts — lowercase, `muted`, amber only when it is you.
  Widget _state(AppTokens t, String word, Color color, bool waiting) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: dotColor(t, word, waiting), borderRadius: BorderRadius.circular(3)),
          ),
          const SizedBox(width: 7),
          Text(
            word,
            style: t.mono.copyWith(fontSize: 11, letterSpacing: 0.06 * 11, color: color),
          ),
        ],
      );
}
