import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/composition_root.dart';
import 'package:lotus_pocket/app/pocket_app.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/app/theme/theme_controller.dart';
import 'package:lotus_pocket/data/intro_seen.dart';
import 'package:lotus_pocket/models/app_build.dart';

import '../support/fake_security.dart';
import '../support/fake_transport.dart';

void main() {
  testWidgets('the app takes theme, darkTheme and mode from its ThemeController', (tester) async {
    final store = InMemorySecureStore()..entries[IntroSeen.key] = '1';
    final root = await CompositionRoot.boot(
      secureStore: store,
      biometrics: FakeBiometrics(),
      transport: FakeTransport(),
      build: const AppBuild(version: '1.0.0', buildNumber: 1),
    );
    final controller = ThemeController();
    await tester.pumpWidget(PocketApp(root: root, themeController: controller));
    await tester.pump();

    MaterialApp app() => tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app().themeMode, ThemeMode.dark);
    expect(app().theme!.extension<AppTokens>(), AppTokens.dark);
    expect(app().darkTheme!.extension<AppTokens>(), AppTokens.dark);

    controller.mode = ThemeMode.system;
    await tester.pump();
    expect(app().themeMode, ThemeMode.system);
  });
}
