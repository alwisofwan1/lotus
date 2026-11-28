import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// The way in to pairing a second machine.
///
/// **Outlined, not filled**, and that is the same rule `ScanPrompt` follows one screen
/// over: this app allows exactly two filled shapes and both are commits — `Pair` and
/// the composer's send. This one opens a screen; it decides nothing. Borrowing the
/// scan button's exact treatment is deliberate beyond consistency — it is the shape
/// the operator last saw on the pairing screen, so the two surfaces read as one flow
/// rather than two features that happen to be about machines.
///
/// It sits below the host list rather than in the app bar. The list is what it adds
/// to, and an action detached from its subject is one the eye has to go looking for.
class PairAnother extends StatelessWidget {
  const PairAnother({required this.onTap, super.key});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.only(top: 22, bottom: 4),
      child: Semantics(
        button: true,
        child: Material(
          color: Colors.transparent,
          borderRadius: context.shape.radius(ShapeRole.button),
          child: InkWell(
            onTap: onTap,
            borderRadius: context.shape.radius(ShapeRole.button),
            child: Container(
              height: 48,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                border: Border.all(color: t.lineStrong),
                borderRadius: context.shape.radius(ShapeRole.button),
              ),
              child: Text(
                'Pair another machine',
                style: t.ui.copyWith(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                  color: t.text,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
