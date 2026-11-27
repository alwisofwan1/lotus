import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import 'glyphs.dart';

/// The send button, and the treatment is the token system's own: `text` on `bg`, the
/// inverted pair reserved for the things this app lets you press. Not an accent
/// colour — there are two colours and neither of them means "primary action".
///
/// **A 36px circle inside a 44×44 target** (v4 tiket 09, `V4 Composer`). The shape is
/// the mockup's; the target is this app's `kMinHitTarget`, and the two are allowed to
/// differ. A drawing has no thumbs, so it draws the mark and says nothing about the area
/// around it — reading 36 as the *touchable* size would walk back the fix that made this
/// control reachable (it was a bare 36px circle once, below every platform's minimum).
///
/// It was a 30px square with a 9px corner while the composer was a 14px-cornered outline:
/// two concentric roundings. The capsule's 22px corner wants a circle beside it for the
/// same reason.
///
/// Moved out of `composer.dart` on 2026-08-12, when that file hit the repo's 300-line
/// ceiling. It reads nothing of the field's state, only whether it may be pressed.
class SendButton extends StatelessWidget {
  const SendButton({required this.live, required this.onSend, super.key});

  /// Whether pressing it would do anything. Decided by the composer, because it is the
  /// thing that knows whether there are words and whether an empty send is allowed.
  final bool live;

  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      enabled: live,
      label: 'Send',
      child: InkResponse(
        onTap: live ? onSend : null,
        radius: 24,
        child: SizedBox(
          width: kMinHitTarget,
          height: kMinHitTarget,
          child: Center(
            child: AnimatedContainer(
              // Long enough to be seen filling, short enough that it has finished before
              // the thumb arrives — this fires on the first character typed.
              duration: const Duration(milliseconds: 140),
              curve: Curves.easeOut,
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                // `raise2`, not `raise`: the capsule is `raise` now, and a dead button in
                // the box's own fill would not be there at all.
                color: live ? t.text : t.raise2,
                shape: BoxShape.circle,
              ),
              child: Center(
                // **Up, not `↵`.** The mockup drew a return-key arrow, and that was
                // right when the return key sent. It no longer does — ⏎ writes a line
                // now (`ComposerKeys`), so a return glyph on the one control that
                // dispatches would teach the operator the opposite of the truth.
                child: ArrowGlyph(color: live ? t.bg : t.faint),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
