import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/app/theme/theme_controller.dart';

void main() {
  test('starts on classic, dark, so nothing looks different yet', () {
    final c = ThemeController();
    expect(c.theme.id, 'classic');
    expect(c.mode, ThemeMode.dark);
    expect(ThemeController(mode: ThemeMode.system).mode, ThemeMode.system);
  });

  test('changing mode notifies; setting the same mode does not', () {
    final c = ThemeController();
    var calls = 0;
    c.addListener(() => calls++);
    c.mode = ThemeMode.system;
    c.mode = ThemeMode.system;
    expect(c.mode, ThemeMode.system);
    expect(calls, 1);
  });

  test('only a registered theme can be chosen', () {
    final c = ThemeController();
    expect(() => c.select('no-such-theme'), throwsArgumentError);
    c.select(themeRegistry.first.id);
    expect(c.theme, themeRegistry.first);
  });

  testWidgets('MaterialApp gets light, dark and mode from the controller', (tester) async {
    final c = ThemeController();
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
