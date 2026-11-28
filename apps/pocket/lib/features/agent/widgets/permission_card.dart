import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/permission.dart';
import '../../shared/tactile.dart';

/// What the cell is asking, and the answers it is offering.
///
/// **The one earned container in the app.** Everything else on this page is a line on a
/// background; a decision is not, because it must not read as part of the transcript it
/// interrupts. One card is not a card grid.
///
/// Two rules here are safety rules, not styling, and both come from ADR-8:
///
/// * **Options are rendered verbatim and answered by their printed digit.** [PromptOption.key]
///   is what was printed next to the label, never derived from position — a prompt whose
///   first option scrolled away starts at `2`, and "the first button" sending `1` would
///   answer a different question than the one shown. Labels are not paraphrased either:
///   the mockup for this screen once invented an option label the real prompt does not use.
/// * **Equal visual weight on every answer.** A filled Allow beside an outlined Deny makes
///   yes the path of least resistance, and this button can delete a file.
class PermissionCard extends StatelessWidget {
  const PermissionCard({
    required this.snapshot,
    required this.onAnswer,
    required this.onOpenTerminal,
    super.key,
  });

  final PermissionSnapshot snapshot;

  /// Sends the option's printed digit. Gated upstream — this widget decides nothing.
  final void Function(PromptOption option) onAnswer;

  /// Where the whole prompt can be read as it was written, with its diff.
  final VoidCallback onOpenTerminal;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final prompt = snapshot.prompt;

    return Container(
      margin: const EdgeInsets.only(top: 4),
      decoration: BoxDecoration(
        color: t.waiting.withValues(alpha: 0.05),
        borderRadius: context.shape.radius(ShapeRole.card),
        // A ring, not a left stripe: the side-stripe shape is banned in this design.
        border: Border.all(color: t.waiting.withValues(alpha: 0.32)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _banner(t, prompt?.isQuestion ?? false),
          Padding(
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: prompt == null ? _unreadable(context, t) : _readable(context, t, prompt),
            ),
          ),
        ],
      ),
    );
  }

  /// **The word is not decoration.** It tells the operator what kind of act they are about
  /// to commit, and answering a question is not granting leave to do anything. A five-option
  /// design question once arrived under `PERMISSION`, which is the reading this exists to
  /// stop. Absent still means a permission, so a host too old to say keeps the safe word.
  Widget _banner(AppTokens t, bool isQuestion) => Container(
        color: t.waiting,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        child: Text(
          isQuestion ? 'QUESTION' : 'PERMISSION',
          style: t.mono.copyWith(
            fontSize: 11,
            letterSpacing: 0.16 * 11,
            fontWeight: FontWeight.w600,
            color: t.onWaiting,
          ),
        ),
      );

  List<Widget> _readable(BuildContext context, AppTokens t, PermissionPrompt prompt) => [
        Text(
          prompt.question,
          style: t.serif.copyWith(fontSize: 15, height: 1.4, color: t.text),
        ),
        const SizedBox(height: 14),
        // Answers as a column rather than a row: real prompts carry three options, and
        // one of them is a sentence ("Yes, allow all edits during this session"). A row
        // would truncate the label that carries the consequence.
        for (final option in prompt.options) ...[
          _answer(context, t, option),
          const SizedBox(height: 9),
        ],
        // A2: what a tap does, said once. The digits are the printed ones, so a prompt
        // that starts at `2` says so rather than claiming a `1` nobody was offered. Not for
        // an empty list: a sentence naming no keys, under no buttons, says nothing.
        if (prompt.options.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(left: 2, top: 1, bottom: 2),
            child: Text(
              'Answers are sent as key ${prompt.options.map((o) => o.key).join('/')} to the session',
              style: t.ui.copyWith(fontSize: 11.5, color: t.muted),
            ),
          ),
        _readInFull(t),
      ];

  /// Waiting, but the options could not be read.
  ///
  /// Never an empty state, and never a guessed pair of buttons — `contract/README.md` is
  /// explicit that this is an honest answer with its own meaning, not a failure.
  ///
  /// **What it stopped being, on 2026-09-08, is a dead end.** Where the host sends the tail,
  /// the question the terminal printed is shown verbatim, so the operator can read what is
  /// being asked without leaving Chat. Still no buttons: the digits come from a successful
  /// parse alone, and reading is the half of this that is safe.
  List<Widget> _unreadable(BuildContext context, AppTokens t) {
    final tail = snapshot.tail;
    if (tail == null || tail.trim().isEmpty) {
      return [
        Text(
          'This agent is waiting, but its options could not be read.',
          style: t.serif.copyWith(fontSize: 15, height: 1.4, color: t.text),
        ),
        const SizedBox(height: 14),
        _readInFull(t),
      ];
    }
    return [
      Text(
        'Lotus could not name the options. This is what the terminal drew:',
        style: t.serif.copyWith(fontSize: 15, height: 1.4, color: t.text),
      ),
      const SizedBox(height: 12),
      // Verbatim, in mono, scrolling sideways rather than wrapping: this is a **screen**, and
      // its columns are what make a boxed prompt readable at all. Wrapping it would fuse the
      // question with the options, which is the same damage the parser refuses to risk.
      Container(
        constraints: const BoxConstraints(maxHeight: 260),
        decoration: BoxDecoration(
          color: t.text.withValues(alpha: 0.05),
          borderRadius: context.shape.radius(ShapeRole.thumb),
        ),
        padding: const EdgeInsets.all(10),
        child: SingleChildScrollView(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Text(
              tail.trimRight(),
              style: t.mono.copyWith(fontSize: 12, height: 1.35, color: t.dim),
            ),
          ),
        ),
      ),
      const SizedBox(height: 12),
      _readInFull(t),
    ];
  }

  Widget _answer(BuildContext context, AppTokens t, PromptOption option) => Material(
        color: t.text.withValues(alpha: 0.08),
        borderRadius: context.shape.radius(ShapeRole.option),
        child: InkWell(
          onTap: () {
            // Before the dispatch, not after it: the answer is irreversible the
            // moment it is sent, so the feedback belongs to the tap rather than to
            // whatever the host says back seconds later over a tailnet.
            Tactile.answered();
            onAnswer(option);
          },
          borderRadius: context.shape.radius(ShapeRole.option),
          child: Container(
            // A2: 48px at least, and taller when a label needs a second line — the label
            // that wraps is the one that carries the consequence.
            constraints: const BoxConstraints(minHeight: 48),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: context.shape.radius(ShapeRole.option),
              border: Border.all(color: t.lineStrong),
            ),
            child: Row(
              children: [
                // The printed digit, shown as well as sent: the operator can check that
                // the button matches what the terminal offered. Boxed (A2), so it reads
                // as the key it is sent as.
                Container(
                  key: ValueKey('digit-${option.key}'),
                  width: 24,
                  height: 24,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    borderRadius: context.shape.radius(ShapeRole.tag),
                    border: Border.all(color: t.lineStrong),
                  ),
                  child: Text(
                    option.key,
                    style: t.mono.copyWith(fontSize: 12, color: t.dim),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    option.label,
                    style: t.serif.copyWith(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      // Identical weight for every option. The only difference the design
                      // allows is that where the prompt's own cursor rests reads slightly
                      // brighter — a report of state, not a recommendation.
                      color: option.selected ? t.text : t.dim,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      );

  /// **The escape hatch, and it was ~17px tall.**
  ///
  /// `minimumSize: Size.zero` with 4px of padding collapsed this to the height of its
  /// own 9px caps label — on the one control that lets an operator read a destructive
  /// prompt as the terminal actually printed it, diff included, before approving it.
  /// The card above it deliberately gives every answer equal weight so that Allow is
  /// not the path of least resistance; a Deny that is easy to hit next to a *check
  /// first* that is easy to miss undoes that from the other side.
  ///
  /// Left-aligned rather than centred: it belongs to the column of answers above it,
  /// and the full-width tap area is the point.
  Widget _readInFull(AppTokens t) => TextButton(
        onPressed: onOpenTerminal,
        style: TextButton.styleFrom(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          minimumSize: const Size(double.infinity, kMinHitTarget),
          alignment: Alignment.centerLeft,
          foregroundColor: t.dim,
        ),
        child: Text(
          'READ IT IN FULL',
          style: t.mono.copyWith(fontSize: 11, letterSpacing: 0.13 * 11, color: t.dim),
        ),
      );
}
