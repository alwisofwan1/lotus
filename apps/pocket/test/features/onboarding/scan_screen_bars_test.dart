import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/features/onboarding/widgets/scan_screen.dart';

/// The camera ground is black in every theme, so its bar icons are light in every theme.
void main() {
  for (final def in themeRegistry) {
    for (final v in def.variants) {
      testWidgets('scan screen bar icons read on the camera: ${def.id}/${v.brightness.name}', (tester) async {
        await tester.pumpWidget(MaterialApp(
          theme: buildAppTheme(v),
          home: ScanScreen(scanner: (_) => const SizedBox()),
        ));
        final style = tester.widget<AppBar>(find.byType(AppBar)).systemOverlayStyle;
        expect(style?.statusBarIconBrightness, Brightness.light);
      });
    }
  }
}
