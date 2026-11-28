import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/features/settings/widgets/appearance_block.dart';

void main() {
  late List<String> themes;
  late List<ThemeMode> modes;

  setUp(() {
    themes = [];
    modes = [];
  });

  Future<void> show(WidgetTester tester, {String themeId = 'graphite', ThemeMode mode = ThemeMode.system}) =>
      tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: AppearanceBlock(
            settings: AppearanceSettings(
              themes: const [(id: 'graphite', label: 'Graphite'), (id: 'classic', label: 'Classic')],
              themeId: themeId,
              mode: mode,
              onTheme: themes.add,
              onMode: modes.add,
            ),
          ),
        ),
      ));

  void isSelected(WidgetTester tester, String label, bool selected) => expect(
        tester.getSemantics(find.bySemanticsLabel(RegExp('^$label\$'))),
        isSemantics(isSelected: selected, isButton: true),
        reason: label,
      );

  testWidgets('offers every theme and the three appearances, the current ones selected', (tester) async {
    final handle = tester.ensureSemantics();
    await show(tester, themeId: 'classic', mode: ThemeMode.dark);

    for (final label in ['Graphite', 'Classic', 'System', 'Light', 'Dark']) {
      expect(find.text(label), findsOneWidget);
    }
    isSelected(tester, 'Classic', true);
    isSelected(tester, 'Graphite', false);
    isSelected(tester, 'Dark', true);
    isSelected(tester, 'System', false);
    handle.dispose();
  });

  testWidgets('a tap picks a theme or an appearance', (tester) async {
    await show(tester);
    await tester.tap(find.text('Classic'));
    await tester.tap(find.text('Light'));
    expect(themes, ['classic']);
    expect(modes, [ThemeMode.light]);
  });

  testWidgets('tapping the current choice does nothing', (tester) async {
    await show(tester);
    await tester.tap(find.text('Graphite'));
    await tester.tap(find.text('System'));
    expect(themes, isEmpty);
    expect(modes, isEmpty);
  });

  testWidgets('every option is at least a thumb tall', (tester) async {
    await show(tester);
    for (final label in ['Graphite', 'System']) {
      final box = find.ancestor(of: find.text(label), matching: find.byType(InkWell)).first;
      expect(tester.getSize(box).height, greaterThanOrEqualTo(kMinHitTarget));
    }
  });
}
