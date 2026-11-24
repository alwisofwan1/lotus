import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import 'qr_scanner.dart';

/// The device camera, behind [QrScanner].
///
/// The only file in the app that names `mobile_scanner`, which is what the layering
/// test enforces (`transportPackages`).
class CameraQrScanner implements QrScanner {
  const CameraQrScanner();

  @override
  Widget view(void Function(String payload) onPayload) => _CameraView(onPayload: onPayload);
}

/// **No `MobileScannerController` is passed, and that is the load-bearing decision
/// in this file.**
///
/// Supplying one looks like the better-configured option — it is how the scan could be
/// restricted to QR formats and told to suppress duplicates. But reading the plugin's
/// own source (7.4.0, `mobile_scanner.dart:196`) the app-lifecycle observer is
/// registered **only when the widget owns its controller**:
///
/// ```dart
/// if (widget.controller == null) {
///   WidgetsBinding.instance.addObserver(this);
/// }
/// ```
///
/// So passing a controller silently opts out of stopping the camera when the app goes
/// to the background — a live camera in a backgrounded app, on the one screen that
/// exists before any credential does. Neither thing it would have bought is worth
/// that, because both are already handled here in code this repo can test:
///
/// * **Format** — a stray EAN-13 or a Wi-Fi QR is refused by `readInvite`, which
///   checks the scheme. Restricting the decoder would be an optimisation, not the
///   safety property.
/// * **Duplicates** — [_handled] below, which is needed regardless: a QR held in front
///   of a camera is detected many times a second.
class _CameraView extends StatefulWidget {
  const _CameraView({required this.onPayload});

  final void Function(String payload) onPayload;

  @override
  State<_CameraView> createState() => _CameraViewState();
}

class _CameraViewState extends State<_CameraView> {
  /// One payload per view, then silence.
  ///
  /// Not `setState`: nothing on screen depends on it. What it prevents is the same
  /// code being redeemed a dozen times — and a pairing code is single-use, so the
  /// second attempt would come back refused and overwrite a *successful* pairing's
  /// diagnosis with a failure.
  bool _handled = false;

  @override
  Widget build(BuildContext context) => MobileScanner(
        onDetect: _onDetect,
        errorBuilder: (context, error) => _Unavailable(error: error),
      );

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;

    for (final barcode in capture.barcodes) {
      final payload = barcode.rawValue;
      if (payload == null || payload.isEmpty) continue;
      _handled = true;
      widget.onPayload(payload);
      return;
    }
  }
}

/// What a camera that will not start says.
///
/// The plugin's default here is a black box with an error glyph, which is the same
/// picture as a camera pointed at a dark room. The permission case is named separately
/// because it is both the likeliest and the only one with an action the operator can
/// take without leaving the app — and every case ends by pointing back at the typed
/// fields, which still work.
class _Unavailable extends StatelessWidget {
  const _Unavailable({required this.error});

  final MobileScannerException error;

  @override
  Widget build(BuildContext context) {
    final denied = error.errorCode == MobileScannerErrorCode.permissionDenied;

    return ColoredBox(
      color: const Color(0xFF0B0B0B),
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Text(
            denied
                ? 'Lotus Pocket has no camera permission. Grant it in Android settings, '
                    'or close this and type the address and code instead.'
                : 'The camera did not start. Close this and type the address and code '
                    'instead.',
            textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xFFBDBDBD), fontSize: 13, height: 1.5),
          ),
        ),
      ),
    );
  }
}
