import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/app/theme/theme_controller.dart';
import 'package:lotus_pocket/data/theme_choice.dart';

import '../../support/fake_security.dart';

void main() {
  test('starts on graphite, following the system', () {
    final c = ThemeController();
    expect(c.theme.id, 'graphite');
    expect(c.mode, ThemeMode.system);
    expect(ThemeController(mode: ThemeMode.dark).mode, ThemeMode.dark);
  });

  group('persistence', () {
    late InMemorySecureStore store;
    setUp(() => store = InMemorySecureStore());

    Future<ThemeChoice> loaded() async {
      final choice = ThemeChoice(store);
      await choice.load();
      return choice;
    }

    test('a fresh install restores the default', () async {
      final c = ThemeController.restore(await loaded());
      expect(c.theme.id, defaultThemeId);
      expect(c.mode, ThemeMode.system);
    });

    test('every change is saved and comes back after a restart', () async {
      final c = ThemeController.restore(await loaded());
      c.select('classic');
      c.mode = ThemeMode.light;
      await pumpEventQueue();

      final next = ThemeController.restore(await loaded());
      expect(next.theme.id, 'classic');
      expect(next.mode, ThemeMode.light);
    });

    test('a stored id no longer registered falls back to the default', () async {
      await store.write(ThemeChoice.themeKey, 'retired-theme');
      expect(ThemeController.restore(await loaded()).theme.id, defaultThemeId);
    });
  });

  test('changing mode notifies; setting the same mode does not', () {
    final c = ThemeController();
    var calls = 0;
    c.addListener(() => calls++);
    c.mode = ThemeMode.light;
    c.mode = ThemeMode.light;
    expect(c.mode, ThemeMode.light);
    expect(calls, 1);
  });

  test('only a registered theme can be chosen', () {
    final c = ThemeController();
    expect(() => c.select('no-such-theme'), throwsArgumentError);
    c.select(themeRegistry.first.id);
    expect(c.theme, themeRegistry.first);
  });

  testWidgets('MaterialApp gets light, dark and mode from the controller', (tester) async {
    final c = ThemeController(mode: ThemeMode.dark);
    await tester.pumpWidget(ThemedApp(
      controller: c,
      builder: (theme, darkTheme, mode) => MaterialApp(
        theme: theme,
        darkTheme: darkTheme,
        themeMode: mode,
        home: Builder(builder: (context) {
          expect(context.tokens, c.theme.dark.tokens);
          return const SizedBox();
        }),
      ),
    ));
    final app = tester.widget<MaterialApp>(find.byType(MaterialApp));
    expect(app.theme!.extension<AppTokens>(), c.theme.light.tokens);
    expect(app.theme!.brightness, c.theme.light.brightness);
    expect(app.darkTheme!.extension<AppTokens>(), c.theme.dark.tokens);
    expect(app.themeMode, ThemeMode.dark);

    c.mode = ThemeMode.light;
    await tester.pump();
    expect(tester.widget<MaterialApp>(find.byType(MaterialApp)).themeMode, ThemeMode.light);
  });
}
