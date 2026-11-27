import 'package:flutter/widgets.dart';

/// The camera seam returns a widget to support previews and isolated tests (ADR-13 no. 4).
abstract class QrScanner {
  /// The caller deduplicates scans so a different code is not silently dropped.
  Widget view(void Function(String payload) onPayload);
}
