import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../app/theme/surface_tokens.dart';
import '../../../models/permission.dart';
import '../../shared/tactile.dart';

/// The answers, carried across the flip.
///
/// **This exists to pay flip's one real cost.** Turning the card over is how the
/// operator reads a permission prompt as the terminal actually printed it — with its
/// diff, unparaphrased — and without this, arriving there would mean leaving the
/// buttons behind on the other face. So the question's *actionable* half follows.
///
/// Every ADR-8 rule is inherited rather than restated: these are [PermissionPrompt]'s
/// own options, so the label is verbatim, the digit is the one that was printed, and
/// the widget is simply not built when the options could not be read. Equal weight
/// across all three is kept for the reason ADR-8 gives — a filled Allow beside an
/// outlined Deny makes yes the path of least resistance, and this button can delete a
/// file.
///
/// **Where it lives** (v4 tiket 06): inside Terminal, right above the dock, under a line
/// saying who is waiting (mockup B1). It used to ride in the page's foot strip, which put
/// it below the dock and away from the prompt it answers. Hidden while keys are live: the
/// digit is typed then, and the keyboard needs the rows.
///
/// **Not the mockup's filled first chip.** B1 fills option 1 amber and outlines the rest.
/// Option 1 is usually `Yes`, so that is the filled-Allow shape the rule above forbids;
/// every chip gets the same 35% amber ring instead.
class AnswerChips extends StatelessWidget {
  const AnswerChips({required this.agent, required this.prompt, required this.onAnswer, super.key});

  /// Who is waiting, by the name the page already uses for them.
  final String agent;

  final PermissionPrompt prompt;

  /// Sends the option's printed digit. Gated upstream — this widget decides nothing.
  final void Function(PromptOption option) onAnswer;

  static const double height = 44;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      color: t.termBg,
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 0),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(shape: BoxShape.circle, color: t.waiting),
              ),
              const SizedBox(width: 7),
              Flexible(
                child: Text(
                  '$agent is waiting for your choice',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: t.ui.copyWith(fontSize: 12, fontWeight: FontWeight.w500, color: t.waiting),
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              for (var i = 0; i < prompt.options.length; i++) ...[
                if (i > 0) const SizedBox(width: 8),
                Expanded(child: _chip(t, prompt.options[i])),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _chip(AppTokens t, PromptOption option) => Semantics(
        button: true,
        // The digit first, so it is what a screen reader says before the words — the same
        // order the chip draws them in.
        label: '${option.key} ${option.label}',
        excludeSemantics: true,
        child: Material(
          color: t.waiting.withValues(alpha: 0.05),
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            onTap: () {
              // Same weight as the card's own buttons: these are the same answer,
              // reachable while the terminal is up, and must not feel lighter for it.
              Tactile.answered();
              onAnswer(option);
            },
            borderRadius: BorderRadius.circular(12),
            child: Container(
              height: height,
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: t.waiting.withValues(alpha: 0.35)),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  // Shown as well as sent, so the operator can check the chip against the
                  // prompt printed right above it.
                  Text(option.key, style: t.mono.copyWith(fontSize: 12, color: t.waiting)),
                  const SizedBox(width: 6),
                  Flexible(
                    child: Text(
                      option.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: t.ui.copyWith(fontSize: 13, fontWeight: FontWeight.w500, color: t.text),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
}
