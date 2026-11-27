import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// The scan affordance, and the line that says typing still works.
///
/// One widget rather than two because they are one claim: *this is the fast path, and
/// the slow one is right below it and is not hidden.* Splitting them would let a future
/// edit collapse the fields into an "advanced" disclosure without the rule that argues
/// against it being anywhere nearby.
class ScanPrompt extends StatelessWidget {
  const ScanPrompt({required this.onScan, required this.busy, super.key});

  final VoidCallback onScan;

  /// A pairing request is already in the air. The camera is disabled rather than
  /// hidden: a control that vanishes mid-tap moves everything under the finger.
  final bool busy;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Column(
      children: [
        _button(t),
        const SizedBox(height: 20),
        _orTypeIt(t),
      ],
    );
  }

  /// Outlined, not filled, even though it is the path most operators will take.
  ///
  /// This app allows exactly two filled shapes and both are already spoken for. More to
  /// the point, `Pair` below is the button that *commits* — making the scan look
  /// heavier than the thing it feeds would misdescribe which one is the decision.
  Widget _button(AppTokens t) => Semantics(
        button: true,
        enabled: !busy,
        child: Material(
          color: Colors.transparent,
          borderRadius: BorderRadius.circular(16),
          child: InkWell(
            onTap: busy ? null : onScan,
            borderRadius: BorderRadius.circular(16),
            child: Container(
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(vertical: 15),
              decoration: BoxDecoration(
                border: Border.all(color: t.lineStrong),
                borderRadius: BorderRadius.circular(16),
              ),
              child: Text(
                'Scan the QR',
                style: t.ui.copyWith(
                  fontSize: 14.5,
                  fontWeight: FontWeight.w600,
                  color: busy ? t.muted : t.text,
                ),
              ),
            ),
          ),
        ),
      );

  /// A rule with three words on it. The typed fields are a real path, not a
  /// disclosure — a collapsed "advanced" section would hide the only way in for a
  /// Standalone Host and for a phone whose camera was refused.
  Widget _orTypeIt(AppTokens t) => Row(
        children: [
          Expanded(child: Divider(color: t.line, height: 1)),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Text('or type it', style: t.ui.copyWith(fontSize: 11.5, color: t.dim)),
          ),
          Expanded(child: Divider(color: t.line, height: 1)),
        ],
      );
}
