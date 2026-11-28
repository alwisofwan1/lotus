import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/composition_root.dart';
import 'package:lotus_pocket/app/diagnostics_route.dart';
import 'package:lotus_pocket/app/pocket_app.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme_controller.dart';
import 'package:lotus_pocket/data/intro_seen.dart';
import 'package:lotus_pocket/data/theme_choice.dart';
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
    final controller = ThemeController(themeId: 'classic', mode: ThemeMode.dark);
    await tester.pumpWidget(PocketApp(root: root, themeController: controller));
    await tester.pump();

    MaterialApp app() => tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app().themeMode, ThemeMode.dark);
    expect(app().theme!.extension<AppTokens>(), AppTokens.dark);
    expect(app().darkTheme!.extension<AppTokens>(), AppTokens.dark);

    controller.mode = ThemeMode.system;
    await tester.pump();
    expect(app().themeMode, ThemeMode.system);

    // A new controller replaces the old one, and the old one no longer drives the app.
    final next = ThemeController(mode: ThemeMode.light);
    await tester.pumpWidget(PocketApp(root: root, themeController: next));
    await tester.pump();
    expect(app().themeMode, ThemeMode.light);
    controller.mode = ThemeMode.dark;
    await tester.pump();
    expect(app().themeMode, ThemeMode.light);
  });

  Future<CompositionRoot> boot(InMemorySecureStore store) => CompositionRoot.boot(
        secureStore: store,
        biometrics: FakeBiometrics(),
        transport: FakeTransport(),
        build: const AppBuild(version: '1.0.0', buildNumber: 1),
      );

  testWidgets('a fresh install opens on Graphite, following the system', (tester) async {
    final root = await boot(InMemorySecureStore()..entries[IntroSeen.key] = '1');
    await tester.pumpWidget(PocketApp(root: root));
    await tester.pump();

    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.themeMode, ThemeMode.system);
    expect(app.theme!.extension<AppTokens>(), themeById('graphite').light.tokens);
    expect(app.darkTheme!.extension<AppTokens>(), themeById('graphite').dark.tokens);
  });

  testWidgets('a saved choice is what the next launch opens on', (tester) async {
    final store = InMemorySecureStore()
      ..entries[IntroSeen.key] = '1'
      ..entries[ThemeChoice.themeKey] = 'classic'
      ..entries[ThemeChoice.appearanceKey] = 'dark';
    await tester.pumpWidget(PocketApp(root: await boot(store)));
    await tester.pump();

    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.themeMode, ThemeMode.dark);
    expect(app.darkTheme!.extension<AppTokens>(), AppTokens.dark);
  });

  test('the Settings picker drives the controller, which saves the pick', () async {
    final store = InMemorySecureStore();
    final choice = ThemeChoice(store);
    await choice.load();
    final controller = ThemeController.restore(choice);
    final picker = appearanceOf(controller);

    expect(picker.themes.map((d) => d.id), ['graphite', 'classic']);
    expect(picker.themeId, 'graphite');
    picker.onTheme('classic');
    picker.onMode(ThemeMode.dark);
    await pumpEventQueue();

    expect(controller.theme.id, 'classic');
    expect(controller.mode, ThemeMode.dark);
    expect(store.entries[ThemeChoice.themeKey], 'classic');
    expect(store.entries[ThemeChoice.appearanceKey], 'dark');
  });
}
