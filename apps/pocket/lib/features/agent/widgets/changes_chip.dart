import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../shared/tactile.dart';

/// `CHANGED 3` — the second door to what a turn left on disk.
///
/// The first is the line at the foot of the transcript (`TurnTail`), which is where the
/// account belongs while the operator is reading. This exists because that line scrolls
/// away: after a long turn the answer is on screen and its footnote is a thousand
/// pixels below.
///
/// It sits on the header's **mono line**, beside the facts, which is where that file
/// says a control belongs — the persona line is the page's subject and gets no
/// furniture. Drawn only when git actually has files, so it can never open an empty
/// sheet.
class ChangesChip extends StatelessWidget {
  const ChangesChip({required this.files, this.onTap, super.key});

  final int files;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      button: true,
      label: '$files file${files == 1 ? '' : 's'} changed on disk. Tap for the list',
      child: ExcludeSemantics(
        child: InkWell(
          onTap: onTap == null
              ? null
              : () {
                  Tactile.chose();
                  onTap!();
                },
          borderRadius: BorderRadius.circular(999),
          child: Container(
            constraints: const BoxConstraints(minHeight: 28),
            margin: const EdgeInsets.only(left: 8),
            padding: const EdgeInsets.symmetric(horizontal: 9),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: t.lineStrong),
            ),
            alignment: Alignment.center,
            child: Text.rich(
              TextSpan(
                children: [
                  const TextSpan(text: 'CHANGED '),
                  // The number is the fact; the word is the label. Tracking off it, so
                  // the digit does not read as part of the uppercase run.
                  TextSpan(text: '$files', style: TextStyle(color: t.text, letterSpacing: 0)),
                ],
              ),
              style: t.mono.copyWith(fontSize: 9.5, letterSpacing: 1.24, color: t.dim),
            ),
          ),
        ),
      ),
    );
  }
}
