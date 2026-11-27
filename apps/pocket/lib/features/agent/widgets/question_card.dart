import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/conversation.dart';

/// What the agent is asking **you**, in its own words.
///
/// **Not a permission card, and the difference is the whole reason this exists.** A permission
/// asks leave to act and takes a yes or a no; this asks the operator to *choose*, and every
/// option carries a sentence of its own. Drawn as a permission, a five-option design question
/// reached a phone as `AskUserQuestion` above **Allow once** and **Deny** — the question itself
/// nowhere on screen (reported 2026-09-09). Drawn from a terminal scrape instead, it arrived as
/// box-drawing characters and a footer about arrow keys.
///
/// The shape follows `bb`'s question card (`UserQuestionInteractionContent.tsx`): the question
/// in full, then each option as its label with its description under it, and the digit beside it.
///
/// **Drawn only while it is open.** A settled question leaves one step line instead
/// (`chat_transcript.dart`): its options are no longer anything to choose between, and a card
/// full of roads not taken sits above the agent's reply taking half the screen. `bb` draws its
/// form for a *pending* interaction only, for the same reason.
///
/// Tappable only where both halves are there: an [onAnswer] to listen, and a digit the host
/// printed beside the option. A cell with a terminal has neither — Lotus cannot yet turn a tap
/// into the right keystroke there — and the card then reads, which is what it did before any
/// of this was answerable. A control that does nothing is worse than none.
class QuestionCard extends StatelessWidget {
  const QuestionCard({
    required this.questions,
    this.onAnswer,
    this.digits = const {},
    this.extras = const [],
    super.key,
  });

  final List<UserQuestion> questions;

  /// Called with the option's own printed digit — never with its position (ADR-8).
  final void Function(String key)? onAnswer;

  /// The digit the **terminal** printed beside an option, by label, for a cell whose options
  /// carry none of their own (`question_digits.dart`). Empty where the screen could not be
  /// read, and every option is then a line to read rather than a control.
  final Map<String, String> digits;

  /// The choices the **terminal** added under the agent's own — `Type something.`,
  /// `Chat about this`. Read off the screen, never invented: they are how a question is
  /// answered outside the list, and a phone without them holds fewer answers than the person
  /// at the keyboard. `bb` offers the same escape as "Other" with a text box.
  final List<UserQuestionOption> extras;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    if (questions.isEmpty) return const SizedBox.shrink();

    return Container(
      margin: const EdgeInsets.only(top: 8, bottom: 4),
      decoration: BoxDecoration(
        color: t.waiting.withValues(alpha: 0.05),
        borderRadius: BorderRadius.circular(15),
        // A ring, not a left stripe — the same rule the permission card follows, so the two
        // read as one family of "this one is for you".
        border: Border.all(color: t.waiting.withValues(alpha: 0.32)),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _banner(t),
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 13, 14, 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                for (var i = 0; i < questions.length; i++) ...[
                  if (i > 0) const SizedBox(height: 18),
                  _question(t, questions[i]),
                ],
                for (final extra in extras) ...[
                  const SizedBox(height: 8),
                  _option(t, 0, extra),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _banner(AppTokens t) => Container(
        color: t.waiting,
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        child: Text(
          questions.length > 1 ? 'QUESTIONS' : 'QUESTION',
          style: t.mono.copyWith(
            fontSize: 11,
            letterSpacing: 0.16 * 11,
            fontWeight: FontWeight.w600,
            color: t.onWaiting,
          ),
        ),
      );

  Widget _question(AppTokens t, UserQuestion q) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The agent's own short word for this question, when it wrote one. Only earns its
          // line where there is more than one — otherwise it says what the question already does.
          if (questions.length > 1 && (q.header?.isNotEmpty ?? false))
            Padding(
              padding: const EdgeInsets.only(bottom: 5),
              child: Text(
                q.header!.toUpperCase(),
                style: t.mono.copyWith(fontSize: 10, letterSpacing: 0.14 * 10, color: t.faint),
              ),
            ),
          Text(
            q.question,
            style: t.serif.copyWith(fontSize: 15, height: 1.4, color: t.text),
          ),
          if (q.multiSelect)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                'More than one may apply.',
                style: t.ui.copyWith(fontSize: 12, color: t.faint),
              ),
            ),
          const SizedBox(height: 11),
          for (var i = 0; i < q.options.length; i++) ...[
            if (i > 0) const SizedBox(height: 8),
            _option(t, i + 1, q.options[i]),
          ],
        ],
      );

  /// One option: its digit, its label, and its own sentence.
  ///
  /// Equal weight on every option, exactly as the permission card requires — the agent may mark
  /// one "(Recommended)" in its own words, and that is the only recommendation the app repeats.
  Widget _option(AppTokens t, int digit, UserQuestionOption option) {
    final answer = option.key ?? digits[option.label];
    final tap = answer == null || onAnswer == null ? null : () => onAnswer!(answer);
    final radius = BorderRadius.circular(11);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: tap,
        borderRadius: radius,
        child: _body(t, answer ?? '$digit', option, radius),
      ),
    );
  }

  Widget _body(AppTokens t, String digit, UserQuestionOption option, BorderRadius radius) =>
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          borderRadius: radius,
          border: Border.all(color: t.lineStrong),
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(digit, style: t.mono.copyWith(fontSize: 11, color: t.muted)),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    option.label,
                    style: t.serif.copyWith(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      height: 1.3,
                      color: t.text,
                    ),
                  ),
                  if (option.description != null && option.description!.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Text(
                        option.description!,
                        style: t.ui.copyWith(fontSize: 12.5, height: 1.35, color: t.muted),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      );
}
