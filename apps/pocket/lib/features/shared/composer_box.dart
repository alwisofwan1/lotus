import 'package:flutter/material.dart';

import '../../app/theme/app_tokens.dart';

/// The capsule itself (`V4 Composer`, v4 tiket 09): a filled box with a 22px corner, what
/// rides above the field, and one row — `leading`, the field, the send slot.
///
/// Drawing only. Which of those exist, and what they do, is the [Composer]'s business;
/// this file holds the numbers so that one stays under the repo's line ceiling.
class ComposerBox extends StatelessWidget {
  const ComposerBox({
    required this.top,
    required this.field,
    required this.trailing,
    this.leading,
    this.busy,
    super.key,
  });

  /// The quote and the held paste, top to bottom. Empty most of the time.
  final List<Widget> top;

  /// Takes the whole row while dictation runs — a waveform beside a send button would
  /// offer two ways to finish one thing.
  final Widget? busy;

  final Widget? leading;
  final Widget field;

  /// The microphone or send — one slot, never two. See `Composer._trailing`.
  final Widget trailing;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final leading = this.leading;
    final busy = this.busy;

    return Container(
      decoration: BoxDecoration(
        color: t.raise,
        border: Border.all(color: t.line),
        borderRadius: BorderRadius.circular(22),
      ),
      // The mockup's 6, less the 4 a 44px target carries around a 36px circle: the gap
      // the eye sees is the drawing's, the area the thumb gets is this app's.
      padding: const EdgeInsets.all(2),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (final item in top)
            Padding(padding: const EdgeInsets.fromLTRB(12, 10, 10, 2), child: item),
          if (busy != null)
            Padding(padding: const EdgeInsets.only(left: 12), child: busy)
          else
            Row(
              // R04: the slot rides the field's base, not its middle.
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                ?leading,
                Expanded(
                  child: Padding(
                    // Eleven above and below centre one line on the 44px slot beside it.
                    padding: EdgeInsets.fromLTRB(leading == null ? 14 : 2, 11, 2, 11),
                    child: field,
                  ),
                ),
                trailing,
              ],
            ),
        ],
      ),
    );
  }
}
