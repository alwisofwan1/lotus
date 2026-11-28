import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// The camera, full screen, until it reads something.
///
/// A route rather than a sheet: the operator is holding the phone up at a monitor, and
/// every pixel not showing the camera is a pixel making them aim. It pops with the raw
/// payload and reads nothing itself — deciding whether a string is a Lotus invitation
/// belongs to `readInvite`, and deciding what to do about it belongs to the screen that
/// owns the pairing form.
///
/// **The scanner arrives as a bare builder, not as a `QrScanner`.** `features/` may not
/// import `core/` (ADR-13 no. 1, enforced by `test/architecture/layering_test.dart`),
/// which is what keeps a widget from reaching a plugin directly. A function type
/// crosses that line without carrying the type with it: `app/` holds the camera, this
/// holds a way to draw one.
class ScanScreen extends StatelessWidget {
  const ScanScreen({required this.scanner, super.key});

  /// Builds a live camera view that calls back with every payload it reads.
  final Widget Function(void Function(String payload) onPayload) scanner;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Scaffold(
      backgroundColor: t.camera,
      appBar: AppBar(
        backgroundColor: t.camera,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        title: Text(
          'Scan the QR',
          style: t.ui.copyWith(fontSize: 16, fontWeight: FontWeight.w500, color: t.onCamera),
        ),
        iconTheme: IconThemeData(color: t.onCamera2),
        // The camera stays dark in a light theme; the bar icons follow the ground, not the theme.
        systemOverlayStyle: overlayFor(t.camera),
      ),
      body: Stack(
        fit: StackFit.expand,
        children: [
          // Popping from inside the callback is what stops the camera: the route goes,
          // the view unmounts, and the plugin tears down its own controller. Nothing
          // here has to remember to turn a camera off.
          scanner((payload) => Navigator.of(context).pop(payload)),
          Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(28, 0, 28, 44),
              child: Text(
                // Names the exact path on the other screen, the way onboarding already
                // does: the operator is looking at two devices and can only search on
                // one of them.
                'Lotus shows it under Settings → Mobile access → Pair a phone.',
                textAlign: TextAlign.center,
                style: t.ui.copyWith(fontSize: 12.5, height: 1.5, color: t.onCamera3),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
