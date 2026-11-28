import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// The pairing form's submit, which reads its own state: "Pairing…" while a request is
/// in flight, and no tap target then — a code is single-use, so a doubled request is
/// not cosmetic.
///
/// Inverted, the way the mockup's send button is: ink on the text colour, never a
/// new accent — amber has one meaning in this app and this is not it.
class PairButton extends StatelessWidget {
  const PairButton({required this.busy, required this.onTap, super.key});

  final bool busy;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      enabled: !busy,
      child: Material(
        color: busy ? t.raise : t.text,
        borderRadius: context.shape.radius(ShapeRole.button),
        child: InkWell(
          onTap: busy ? null : onTap,
          borderRadius: context.shape.radius(ShapeRole.button),
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(vertical: 15),
            child: Text(
              busy ? 'Pairing…' : 'Pair',
              style: t.ui.copyWith(
                fontSize: 14.5,
                fontWeight: FontWeight.w600,
                color: busy ? t.muted : t.bg,
              ),
            ),
          ),
        ),
      ),
    );
  }
}
