import 'package:flutter/widgets.dart';

/// The camera, narrowed to the one thing pairing asks of it.
///
/// A seam like [Biometrics] and [SecureStore], for the same reason (ADR-13 no. 4) —
/// but unlike those it hands back a **widget**, because a camera preview is not an
/// operation with a result, it is a surface that lives on screen while it works.
///
/// What that buys is the same thing every other seam here buys: `features/` never
/// names the plugin, `app/` supplies the only implementation that does, and a widget
/// test drives the whole pairing flow by handing over payloads directly. Without it,
/// the onboarding screen would be untestable except on a device with a camera pointed
/// at a real monitor.
abstract class QrScanner {
  /// A live view that reports each payload it reads.
  ///
  /// May be called more than once for the same physical code — a scanner sees the
  /// same QR many times a second — so the caller owns the decision to act once. That
  /// is deliberate rather than pushed down here: "act once" belongs with the action,
  /// and a de-duplicating scanner would silently drop a second, *different* code the
  /// operator meant to scan.
  ///
  /// The callback is positional rather than named so `scanner.view` is a tear-off that
  /// already *is* the builder `features/` declares. A named parameter would force a
  /// wrapping closure in `app/` whose only job is to rename an argument.
  Widget view(void Function(String payload) onPayload);
}
