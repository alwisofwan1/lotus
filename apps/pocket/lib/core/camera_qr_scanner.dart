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

/// Let the widget own its controller so it stops the camera when backgrounded.
class _CameraView extends StatefulWidget {
  const _CameraView({required this.onPayload});

  final void Function(String payload) onPayload;

  @override
  State<_CameraView> createState() => _CameraViewState();
}

class _CameraViewState extends State<_CameraView> {
  /// Handle only one scan so a repeated single-use code cannot overwrite a successful pairing.
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

/// Distinguish camera permission failures and point to typed pairing as a fallback.
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
